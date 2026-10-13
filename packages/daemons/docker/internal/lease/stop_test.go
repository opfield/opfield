package lease

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// A lane's receiver may still wait in Recv after Run returned, but it must not deliver a frame to the node any more:
// the node's store writes to the state directory (the TempDir cleanup race of the lease end-to-end test).
func TestRelayTransportDeliversNothingAfterRunReturned(t *testing.T) {
	transport := NewRelayTransport(slog.New(slog.NewTextHandler(io.Discard, nil)))
	inDelivery, release := make(chan struct{}), make(chan struct{})
	var delivered atomic.Int32
	transport.setReceiver(func(*relayv1.CoordinationFrame) error {
		if delivered.Add(1) == 1 {
			close(inDelivery)
			<-release
		}
		return nil
	})
	stream := newPipeStream() // its Recv ignores the context, like a stream that is slow to end
	ctx, cancel := context.WithCancel(context.Background())
	returned := make(chan struct{})
	go func() {
		transport.Run(ctx, "relay-a", func(context.Context) (FrameStream, error) { return stream, nil })
		close(returned)
	}()
	stream.inbox <- &relayv1.CoordinationFrame{SenderId: "node-2"}
	<-inDelivery

	cancel()
	select {
	case <-returned:
		t.Fatal("Run returned while a frame was being delivered")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after the delivery ended")
	}

	stream.inbox <- &relayv1.CoordinationFrame{SenderId: "node-2"}
	time.Sleep(50 * time.Millisecond)
	if got := delivered.Load(); got != 1 {
		t.Fatalf("delivered %d frames, none may follow the end of Run", got)
	}
	close(stream.closed)
}

func stopTestRuntime(t *testing.T) *Runtime {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := New(Options{
		NodeID: "node-1", Signer: availabilitylease.ECDSASigner{Key: key}, Store: availabilitylease.NewMemoryStore(),
		Engine: &fakeEngine{}, Fence: &fakeFence{}, Endpoints: &fakeEndpoints{}, Placements: fakePlacements{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return runtime
}

// Stop waits for the background operations in flight (Docker calls, endpoint changes) and starts no further one.
func TestRuntimeStopWaitsForOperationsInFlight(t *testing.T) {
	runtime := stopTestRuntime(t)
	started, release := make(chan struct{}), make(chan struct{})
	runtime.mu.Lock()
	runtime.opts.Async(func() {
		close(started)
		<-release
	})
	runtime.mu.Unlock()
	<-started

	stopped := make(chan struct{})
	go func() {
		runtime.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("Stop returned while an operation ran")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop did not return after the operation ended")
	}

	var ran atomic.Bool
	runtime.mu.Lock()
	runtime.opts.Async(func() { ran.Store(true) })
	runtime.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	if ran.Load() {
		t.Fatal("an operation started after Stop")
	}
}
