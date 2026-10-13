package lease

import (
	"io"
	"sort"
	"sync"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/peer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	// maxFramePayload bounds one coordination frame; batches carry a few
	// items and at most a voter config, some manifests and the key chain.
	maxFramePayload = 1 << 20
	// streamBuffer frames wait per member stream; beyond that frames drop,
	// which the protocol tolerates like any message loss.
	streamBuffer = 256
	// authorizeWithin is how long a stream whose client is not yet a known
	// member may stay open waiting for a frame whose blocks name it.
	authorizeWithin = 30 * time.Second
	watchInterval   = 250 * time.Millisecond
	watchRefresh    = time.Second
)

type memberStream struct {
	id         string
	out        chan *relayv1.CoordinationFrame
	revoked    chan struct{}
	revokeOnce sync.Once
}

func (s *memberStream) revoke() { s.revokeOnce.Do(func() { close(s.revoked) }) }

// Coordinate carries availability lease frames between this relay and one
// member. The client certificate CN is the member id; it must be a member of
// the signed voter config or a candidate of a signed manifest (D3). Frames
// addressed to the relay reach its acceptor; others are routed by
// destination_id to that member's newest stream. Blocks carried by any frame
// are adopted first, so a new candidate's first frame can authorize it.
func (c *Coordinator) Coordinate(stream relayv1.TunnelBroker_CoordinateServer) error {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	member := &memberStream{id: client.SubjectID, out: make(chan *relayv1.CoordinationFrame, streamBuffer), revoked: make(chan struct{})}
	registered := false
	defer func() {
		if registered {
			c.unregister(member)
		}
	}()
	var deadline <-chan time.Time
	if c.view.authorized(member.id) {
		c.register(member)
		registered = true
	} else {
		timer := time.NewTimer(authorizeWithin)
		defer timer.Stop()
		deadline = timer.C
	}
	received := make(chan *relayv1.CoordinationFrame)
	receiveErr := make(chan error, 1)
	go func() {
		for {
			frame, recvErr := stream.Recv()
			if recvErr != nil {
				receiveErr <- recvErr
				return
			}
			select {
			case received <- frame:
			case <-stream.Context().Done():
				return
			}
		}
	}()
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case recvErr := <-receiveErr:
			if recvErr == io.EOF {
				return nil
			}
			return recvErr
		case <-deadline:
			return status.Error(codes.PermissionDenied, "client is not an availability lease member")
		case <-member.revoked:
			return status.Error(codes.PermissionDenied, "client is no longer an availability lease member")
		case frame := <-member.out:
			if err := stream.Send(frame); err != nil {
				return err
			}
		case frame := <-received:
			if frame.GetSenderId() != member.id {
				return status.Error(codes.PermissionDenied, "coordination frame sender does not match the client certificate")
			}
			if len(frame.GetPayload()) > maxFramePayload || frame.GetDestinationId() == "" {
				return status.Error(codes.InvalidArgument, "coordination frame is invalid")
			}
			c.ingestFrame(frame)
			if !c.view.authorized(member.id) {
				return status.Error(codes.PermissionDenied, "client is not an availability lease member")
			}
			if !registered {
				c.register(member)
				registered, deadline = true, nil
			}
			c.deliver(frame)
		}
	}
}

// ingestFrame adopts the blocks and rotation links a frame carries. Frames
// that do not decode are still routed: the recipient verifies them.
func (c *Coordinator) ingestFrame(frame *relayv1.CoordinationFrame) {
	batch := &relayv1.LeaseBatch{}
	if proto.Unmarshal(frame.GetPayload(), batch) != nil || (len(batch.GetBlocks()) == 0 && len(batch.GetKeyRotations()) == 0) {
		return
	}
	if c.ingest(batch.GetKeyRotations(), batch.GetBlocks(), true) {
		c.revalidateStreams()
		c.kick()
	}
}

func (c *Coordinator) deliver(frame *relayv1.CoordinationFrame) {
	if frame.GetDestinationId() != c.id {
		c.Send(frame)
		return
	}
	if err := c.node.ReceiveFrame(frame); err != nil {
		c.logger.Debug("availability lease frame dropped", "sender", frame.GetSenderId(), "error", err)
	}
	c.kick()
}

// Send routes a frame to its destination's newest stream, only when a policy
// names both its sender and its destination (D3). It never blocks: the lease
// node calls it as its Transport, and a full stream drops frames.
func (c *Coordinator) Send(frame *relayv1.CoordinationFrame) {
	if !c.view.shares(frame.GetSenderId(), frame.GetDestinationId()) {
		return
	}
	c.mu.Lock()
	var target *memberStream
	if streams := c.streams[frame.GetDestinationId()]; len(streams) > 0 {
		target = streams[len(streams)-1]
	}
	c.mu.Unlock()
	if target == nil {
		return
	}
	select {
	case target.out <- frame:
	default:
	}
}

func (c *Coordinator) register(member *memberStream) {
	c.mu.Lock()
	c.streams[member.id] = append(c.streams[member.id], member)
	c.mu.Unlock()
	// The member's first frame from this relay carries the relay's clock: a
	// holder that reconnects after a freeze learns of it at once (D4).
	c.node.Beacon(member.id)
}

func (c *Coordinator) unregister(member *memberStream) {
	c.mu.Lock()
	defer c.mu.Unlock()
	streams := c.streams[member.id]
	for i, stream := range streams {
		if stream == member {
			streams = append(streams[:i:i], streams[i+1:]...)
			break
		}
	}
	if len(streams) == 0 {
		delete(c.streams, member.id)
		return
	}
	c.streams[member.id] = streams
}

// revalidateStreams ends the streams of clients the newest blocks no longer
// name.
func (c *Coordinator) revalidateStreams() {
	c.mu.Lock()
	var revoked []*memberStream
	for id, streams := range c.streams {
		if !c.view.authorized(id) {
			revoked = append(revoked, streams...)
		}
	}
	c.mu.Unlock()
	for _, stream := range revoked {
		stream.revoke()
	}
}

// WatchLeaseGates streams this relay's gate views to any client with a
// verified certificate (T5: nginx daemons open a Secure Link member socket
// only while a fresh view says its holder's gate is open). nginx daemons are
// observers and never manifest members (A18), and a gate view is read-only
// and holds no secret, so membership is required only on Coordinate. Views go
// out on every change and at least once a second; remaining_ms is the relay's
// local time left.
func (c *Coordinator) WatchLeaseGates(request *relayv1.LeaseGateWatchRequest, stream relayv1.TunnelBroker_WatchLeaseGatesServer) error {
	if _, err := peer.Require(stream.Context()); err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	policyIDs := append([]string(nil), request.GetPolicyIds()...)
	sort.Strings(policyIDs)
	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()
	var last []*relayv1.LeaseGateView
	var sentAt time.Time
	for {
		views := c.gateViews(policyIDs)
		if time.Since(sentAt) >= watchRefresh || !sameGates(last, views) {
			snapshot := &relayv1.LeaseGateSnapshot{RelayMemberId: c.id, RelayIncarnation: c.node.Incarnation(), Gates: views}
			if err := stream.Send(snapshot); err != nil {
				return err
			}
			last, sentAt = views, time.Now()
		}
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case <-ticker.C:
		}
	}
}

// sameGates compares gate views ignoring the remaining time.
func sameGates(a, b []*relayv1.LeaseGateView) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		left, right := proto.Clone(a[i]).(*relayv1.LeaseGateView), proto.Clone(b[i]).(*relayv1.LeaseGateView)
		left.RemainingMs, right.RemainingMs = 0, 0
		if !proto.Equal(left, right) {
			return false
		}
	}
	return true
}

func sortStrings(values []string) { sort.Strings(values) }
