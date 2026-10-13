package lease

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sort"
	"sync"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

// maxRelaysPerFrame is how many relay streams carry a frame to a daemon (D3).
const maxRelaysPerFrame = 2

// LegacyLocalTarget is relaybridge.LegacyTargetID: the local relay reached
// through the Gateway lanes without a pool relay instance id.
const LegacyLocalTarget = "local"

const streamQueueDepth = 512

// FrameStream is one Coordinate stream to one relay.
type FrameStream interface {
	Send(*relayv1.CoordinationFrame) error
	Recv() (*relayv1.CoordinationFrame, error)
	CloseSend() error
}

// OpenCoordinateStream opens T2's TunnelBroker.Coordinate stream on an
// existing relay connection (the daemon's mTLS identity is the sender).
func OpenCoordinateStream(ctx context.Context, conn grpc.ClientConnInterface) (FrameStream, error) {
	return relayv1.NewTunnelBrokerClient(conn).Coordinate(ctx)
}

// RelayTransport sends lease frames over every relay transport the daemon
// holds (one Coordinate stream per relay target) and feeds received frames
// to the node. Send never blocks and never calls back into the node.
type RelayTransport struct {
	mu      sync.Mutex
	streams map[string]*relayStream
	receive func(*relayv1.CoordinationFrame) error
	logger  *slog.Logger
}

type relayStream struct {
	target string
	queue  chan *relayv1.CoordinationFrame
}

var _ availabilitylease.Transport = (*RelayTransport)(nil)

func NewRelayTransport(logger *slog.Logger) *RelayTransport {
	if logger == nil {
		logger = slog.Default()
	}
	return &RelayTransport{streams: map[string]*relayStream{}, logger: logger}
}

func (t *RelayTransport) setReceiver(receive func(*relayv1.CoordinationFrame) error) {
	t.mu.Lock()
	t.receive = receive
	t.mu.Unlock()
}

// Send routes a frame. A frame for a relay whose stream this daemon holds
// goes to that relay only (the relay is the destination). Any other frame
// goes through up to two relay streams; relays route by destination_id and
// drop frames they cannot deliver, and receivers deduplicate by message id.
func (t *RelayTransport) Send(frame *relayv1.CoordinationFrame) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if direct := t.streams[frame.GetDestinationId()]; direct != nil {
		enqueue(direct, frame)
		return
	}
	targets := make([]string, 0, len(t.streams))
	for target := range t.streams {
		targets = append(targets, target)
	}
	// The legacy local lane has no relay id here, so it goes first: it may
	// be the destination relay itself.
	sort.Slice(targets, func(i, j int) bool {
		if (targets[i] == LegacyLocalTarget) != (targets[j] == LegacyLocalTarget) {
			return targets[i] == LegacyLocalTarget
		}
		return targets[i] < targets[j]
	})
	for i, target := range targets {
		if i == maxRelaysPerFrame {
			break
		}
		enqueue(t.streams[target], frame)
	}
}

func enqueue(stream *relayStream, frame *relayv1.CoordinationFrame) {
	select {
	case stream.queue <- frame:
	default:
		// The protocol tolerates loss; a full queue means the relay is slow.
	}
}

// Targets lists the relay targets with an attached stream.
func (t *RelayTransport) Targets() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]string, 0, len(t.streams))
	for target := range t.streams {
		out = append(out, target)
	}
	sort.Strings(out)
	return out
}

// Lease-lane reconnects back off exponentially with jitter but stay short
// (D7): a failover or a resumed holder's fence must not wait for a long retry
// timer (the rc.20 stand saw a 32 s cap delay a resumed holder's first frame).
const (
	coordinateRetryMin = 250 * time.Millisecond
	coordinateRetryMax = 2 * time.Second
)

// Run keeps one Coordinate stream open to target until ctx ends, reopening
// it after failures. target is the relay instance id (the relay's voter id)
// or "local" for the legacy local relay lane.
func (t *RelayTransport) Run(ctx context.Context, target string, open func(context.Context) (FrameStream, error)) {
	backoff := coordinateRetryMin
	for ctx.Err() == nil {
		streamCtx, cancel := context.WithCancel(ctx)
		stream, err := open(streamCtx)
		if err == nil {
			backoff = coordinateRetryMin
			err = t.serve(streamCtx, target, stream)
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		t.logger.Debug("availability lease coordinate stream ended", "relay_target", target, "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(jittered(backoff)):
		}
		backoff = min(backoff*2, coordinateRetryMax)
	}
}

// jittered spreads retries by ±20% so daemons do not reconnect in step.
func jittered(wait time.Duration) time.Duration {
	return wait - wait/5 + time.Duration(rand.Int64N(int64(wait/5)*2+1))
}

func (t *RelayTransport) serve(ctx context.Context, target string, stream FrameStream) error {
	entry := &relayStream{target: target, queue: make(chan *relayv1.CoordinationFrame, streamQueueDepth)}
	t.mu.Lock()
	previous := t.streams[target]
	t.streams[target] = entry
	t.mu.Unlock()
	if previous != nil {
		t.logger.Debug("availability lease coordinate stream replaced", "relay_target", target)
	}
	defer func() {
		t.mu.Lock()
		if t.streams[target] == entry {
			delete(t.streams, target)
		}
		t.mu.Unlock()
		_ = stream.CloseSend()
	}()
	// The receiver below may still wait in Recv after serve returned (until the stream's context ends). It delivers
	// only while delivering is open, and closing it waits for a frame in delivery: once serve returned, no frame of
	// this stream reaches the node, whose store writes to the state directory.
	var delivering sync.Mutex
	closed := false
	defer func() {
		delivering.Lock()
		closed = true
		delivering.Unlock()
	}()
	receiveErr := make(chan error, 1)
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				receiveErr <- err
				return
			}
			t.mu.Lock()
			receive := t.receive
			t.mu.Unlock()
			if receive == nil {
				continue
			}
			delivering.Lock()
			if closed {
				delivering.Unlock()
				return
			}
			err = receive(frame)
			delivering.Unlock()
			if err != nil && !errors.Is(err, availabilitylease.ErrUnknownSender) {
				t.logger.Debug("availability lease frame rejected", "relay_target", target, "sender_id", frame.GetSenderId(), "error", err)
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-receiveErr:
			return err
		case frame := <-entry.queue:
			if err := stream.Send(frame); err != nil {
				return err
			}
		}
	}
}
