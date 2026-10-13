package lifecycle

import (
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
)

// A lane whose connection dropped reconnects without waiting for a tunnel:
// source daemons open tunnels only on connected lanes, so a relay that came
// back would otherwise stay out of use.
func TestRelayLaneReconnectsAfterItsConnectionDropped(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	path := newDroppingPath(t, listener.Addr().String())
	conn, err := grpc.NewClient(path.listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithConnectParams(connector.ReconnectParams), grpc.WithIdleTimeout(0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	conn.Connect()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for state := conn.GetState(); state != connectivity.Ready; state = conn.GetState() {
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatal("lane did not connect")
		}
	}
	go keepRelayLaneConnected(ctx, conn, nil, nil, nil)

	path.drop()
	for conn.GetState() != connectivity.Ready || path.connections() < 2 {
		if ctx.Err() != nil {
			t.Fatalf("lane did not reconnect after its connection dropped: %s, %d connections", conn.GetState(), path.connections())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// droppingPath forwards connections to a server and can drop the ones it
// carries, as a relay restart or a reset connection does.
type droppingPath struct {
	listener net.Listener
	mu       sync.Mutex
	carried  []net.Conn
	accepted int
}

func newDroppingPath(t *testing.T, backend string) *droppingPath {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	path := &droppingPath{listener: listener}
	t.Cleanup(func() {
		_ = listener.Close()
		path.drop()
	})
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			server, err := net.Dial("tcp", backend)
			if err != nil {
				_ = client.Close()
				continue
			}
			path.mu.Lock()
			path.accepted++
			path.carried = append(path.carried, client, server)
			path.mu.Unlock()
			go func() {
				_, _ = io.Copy(server, client)
				_ = server.Close()
			}()
			go func() {
				_, _ = io.Copy(client, server)
				_ = client.Close()
			}()
		}
	}()
	return path
}

func (p *droppingPath) drop() {
	p.mu.Lock()
	carried := p.carried
	p.carried = nil
	p.mu.Unlock()
	for _, connection := range carried {
		_ = connection.Close()
	}
}

func (p *droppingPath) connections() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.accepted
}
