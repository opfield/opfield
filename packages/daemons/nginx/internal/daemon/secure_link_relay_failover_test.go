package daemon

import (
	"context"
	"io"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/connector"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials/insecure"
)

// The ingress lost its connection to its nearest relay while the others stayed
// reachable (stand rc.39: the local relay's port blocked on the ingress node,
// 14 s without an answer). New connections go to another relay at once
// instead of waiting out their setup on the lost one.
func TestSecureLinkSkipsRelayWhoseLaneLostItsConnection(t *testing.T) {
	near, nearAddress := startEchoRelay(t)
	far, farAddress := startEchoRelay(t)
	path := newRelayPath(t, nearAddress)
	plugin := &NginxPlugin{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		relayGrants: &relayGrantStore{changed: make(chan struct{}, 1), current: &pb.SyncRelayGrantsCommand{
			Grants: []*pb.RelayGrantAssignment{{
				Role: "connect", OwnerKind: proxySecureLinkOwnerKind, OwnerId: testSecureLinkID, SchemaVersion: 2,
				Candidates: []*pb.RelayDataCandidate{
					poolCandidate("relay-near", relaybridge.RolePrimary), poolCandidate("relay-far", relaybridge.RoleStandby),
				},
			}},
		}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	nearLane := dialTestLane(t, path.address())
	farLane := dialTestLane(t, farAddress)
	go plugin.RunRelayTargetTunnels(ctx, nearLane, "", "relay-near")
	go plugin.RunRelayTargetTunnels(ctx, farLane, "", "relay-far")
	waitForRelayLanes(t, plugin, 2)

	echoThroughLink(t, plugin, testSecureLinkID)
	if near.opened.Load() != 1 || far.opened.Load() != 0 {
		t.Fatalf("all relays up: tunnels near %d, far %d; want the nearest relay", near.opened.Load(), far.opened.Load())
	}

	path.block()
	waitForLaneDown(t, nearLane)
	for range 3 {
		if took := echoThroughLink(t, plugin, testSecureLinkID); took > 500*time.Millisecond {
			t.Fatalf("a connection took %s with the nearest relay unreachable", took)
		}
	}
	if near.opened.Load() != 1 || far.opened.Load() != 3 {
		t.Fatalf("nearest relay unreachable: tunnels near %d, far %d; want the other relay", near.opened.Load(), far.opened.Load())
	}
}

// echoRelay admits every tunnel and echoes its bytes.
type echoRelay struct {
	relayv1.UnimplementedTunnelBrokerServer
	opened atomic.Int64
}

func (r *echoRelay) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	r.opened.Add(1)
	ready := &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 16 * 1024}}}
	if err := stream.Send(ready); err != nil {
		return err
	}
	for {
		frame, err := stream.Recv()
		if err != nil || frame.GetData() == nil {
			return nil
		}
		if err := stream.Send(frame); err != nil {
			return err
		}
	}
}

func startEchoRelay(t *testing.T) (*echoRelay, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := &echoRelay{}
	server := grpc.NewServer()
	relayv1.RegisterTunnelBrokerServer(server, relay)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return relay, listener.Addr().String()
}

// relayPath carries a lane's connections to a relay. block acts like a
// firewall rule on the relay's port: the connections it carried close and new
// ones are accepted but never answered, so their handshake hangs.
type relayPath struct {
	listener net.Listener
	backend  string
	mu       sync.Mutex
	blocked  bool
	carried  []net.Conn
}

func newRelayPath(t *testing.T, backend string) *relayPath {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	path := &relayPath{listener: listener, backend: backend}
	t.Cleanup(func() {
		_ = listener.Close()
		path.block()
	})
	go path.serve()
	return path
}

func (p *relayPath) address() string {
	return p.listener.Addr().String()
}

func (p *relayPath) serve() {
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		if !p.carry(client) {
			continue
		}
		relay, err := net.Dial("tcp", p.backend)
		if err != nil || !p.carry(relay) {
			_ = client.Close()
			continue
		}
		go func() {
			_, _ = io.Copy(relay, client)
			_ = relay.Close()
		}()
		go func() {
			_, _ = io.Copy(client, relay)
			_ = client.Close()
		}()
	}
}

// carry tracks a connection and reports whether the path forwards it.
func (p *relayPath) carry(connection net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.carried = append(p.carried, connection)
	return !p.blocked
}

func (p *relayPath) block() {
	p.mu.Lock()
	p.blocked = true
	carried := p.carried
	p.carried = nil
	p.mu.Unlock()
	for _, connection := range carried {
		_ = connection.Close()
	}
}

func poolCandidate(relayID, role string) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{
		RelayInstanceId: relayID, AssignmentGeneration: 1, AssignmentState: "active",
		Capabilities: []string{relaybridge.PoolCapability},
		Grant:        &pb.RelaySignedGrant{KeyId: "key-1", Payload: []byte("{}"), Signature: []byte("signature")},
		Topology:     &pb.RelayCandidateTopology{Role: role},
	}
}

// dialTestLane connects a lane the way the daemon does, without TLS.
func dialTestLane(t *testing.T, address string) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithConnectParams(connector.ReconnectParams), grpc.WithIdleTimeout(0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn.Connect()
	for state := conn.GetState(); state != connectivity.Ready; state = conn.GetState() {
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatalf("lane to %s did not connect", address)
		}
	}
	return conn
}

func waitForLaneDown(t *testing.T, conn *grpc.ClientConn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if conn.GetState() == connectivity.Ready && !conn.WaitForStateChange(ctx, connectivity.Ready) {
		t.Fatal("lane stayed connected")
	}
}

func waitForRelayLanes(t *testing.T, plugin *NginxPlugin, count int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		plugin.relayTunnelMu.Lock()
		registered := len(plugin.relayTunnels)
		plugin.relayTunnelMu.Unlock()
		if registered == count {
			return
		}
	}
	t.Fatalf("relay lanes did not register")
}

// echoThroughLink opens one Secure Link connection and reports how long its
// first round trip took.
func echoThroughLink(t *testing.T, plugin *NginxPlugin, linkID string) time.Duration {
	t.Helper()
	client, daemonSide := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.openProxySecureLink(linkID, daemonSide)
	}()
	defer func() {
		_ = client.Close()
		<-done
	}()
	started := time.Now()
	_ = client.SetDeadline(started.Add(10 * time.Second))
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatalf("connection was not carried: %v", err)
	}
	reply := make([]byte, 4)
	if _, err := io.ReadFull(client, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("no echo through the relay: %q %v", reply, err)
	}
	return time.Since(started)
}
