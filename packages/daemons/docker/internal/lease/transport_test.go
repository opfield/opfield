package lease

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

type pipeStream struct {
	mu     sync.Mutex
	sent   []*relayv1.CoordinationFrame
	inbox  chan *relayv1.CoordinationFrame
	closed chan struct{}
}

func newPipeStream() *pipeStream {
	return &pipeStream{inbox: make(chan *relayv1.CoordinationFrame, 8), closed: make(chan struct{})}
}

func (p *pipeStream) Send(frame *relayv1.CoordinationFrame) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = append(p.sent, frame)
	return nil
}

func (p *pipeStream) Recv() (*relayv1.CoordinationFrame, error) {
	select {
	case frame := <-p.inbox:
		return frame, nil
	case <-p.closed:
		return nil, io.EOF
	}
}

func (p *pipeStream) CloseSend() error { return nil }

func (p *pipeStream) destinations() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, frame := range p.sent {
		out = append(out, frame.GetDestinationId())
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRelayTransportRoutesDirectlyOrThroughTwoRelays(t *testing.T) {
	transport := NewRelayTransport(slog.New(slog.NewTextHandler(io.Discard, nil)))
	var received []string
	var mu sync.Mutex
	transport.setReceiver(func(frame *relayv1.CoordinationFrame) error {
		mu.Lock()
		received = append(received, frame.GetSenderId())
		mu.Unlock()
		return nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	streams := map[string]*pipeStream{"relay-a": newPipeStream(), "relay-b": newPipeStream(), "relay-c": newPipeStream(), LegacyLocalTarget: newPipeStream()}
	for target, stream := range streams {
		go transport.Run(ctx, target, func(context.Context) (FrameStream, error) { return stream, nil })
	}
	waitFor(t, func() bool { return len(transport.Targets()) == 4 })

	transport.Send(&relayv1.CoordinationFrame{DestinationId: "relay-b", SenderId: "d1"})
	transport.Send(&relayv1.CoordinationFrame{DestinationId: "d2", SenderId: "d1"})
	waitFor(t, func() bool {
		return len(streams["relay-b"].destinations()) == 1 && len(streams[LegacyLocalTarget].destinations()) == 1 &&
			len(streams["relay-a"].destinations()) == 1
	})
	time.Sleep(20 * time.Millisecond)
	if got := streams["relay-b"].destinations(); len(got) != 1 || got[0] != "relay-b" {
		t.Fatalf("frame for relay-b must go to relay-b only, relay-b saw %v", got)
	}
	if got := streams["relay-c"].destinations(); len(got) != 0 {
		t.Fatalf("a frame travels through at most two relays, relay-c saw %v", got)
	}
	if got := streams["relay-a"].destinations(); got[0] != "d2" {
		t.Fatalf("relay-a carried %v", got)
	}

	streams["relay-c"].inbox <- &relayv1.CoordinationFrame{DestinationId: "d1", SenderId: "d2"}
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(received) == 1 && received[0] == "d2"
	})
	close(streams["relay-a"].closed)
	waitFor(t, func() bool { return len(transport.Targets()) == 3 })
}
