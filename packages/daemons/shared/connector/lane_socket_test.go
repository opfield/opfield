package connector

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"runtime"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/slowstart"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

func laneTestTLS(t *testing.T) (server, client *tls.Config) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "relay"}, DNSNames: []string{"relay"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13},
		&tls.Config{RootCAs: pool, ServerName: "relay", MinVersion: tls.VersionTLS13}
}

func waitLaneReady(t *testing.T, conn *grpc.ClientConn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		state := conn.GetState()
		if state == connectivity.Ready {
			return
		}
		if state == connectivity.Idle {
			conn.Connect()
		}
		if !conn.WaitForStateChange(ctx, state) {
			t.Fatalf("lane not ready: %v", conn.GetState())
		}
	}
}

// A lane dialled by the connector keeps the socket beneath it; a new socket
// replaces it when gRPC reconnects the lane.
func TestLaneSocketFollowsTheLanesConnection(t *testing.T) {
	serverTLS, clientTLS := laneTestTLS(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
	healthpb.RegisterHealthServer(server, health.NewServer())
	go func() { _ = server.Serve(listener) }()
	defer server.Stop()

	conn, err := newLane(listener.Addr().String(), clientTLS)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	socket := LaneSocketOf(conn)
	if socket == nil {
		t.Fatal("no socket holder for the lane")
	}
	check := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{}); err != nil {
			t.Fatal(err)
		}
	}
	waitLaneReady(t, conn)
	check()
	first := socket.Dialed()
	if first.IsZero() {
		t.Fatal("no socket after the lane connected")
	}
	state, ok := socket.State()
	if runtime.GOOS == "linux" && (!ok || state.SlowStartThreshold != slowstart.InfiniteThreshold || state.Collapsed()) {
		t.Fatalf("a new lane socket: %+v known %v", state, ok)
	}
	// The connection drops (a relay restart): gRPC dials a new socket for the lane.
	socket.mu.Lock()
	_ = socket.conn.Conn.Close()
	socket.mu.Unlock()
	deadline := time.Now().Add(10 * time.Second)
	for !socket.Dialed().After(first) {
		if time.Now().After(deadline) {
			t.Fatal("the lane did not connect a new socket")
		}
		if conn.GetState() == connectivity.Idle {
			conn.Connect()
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitLaneReady(t, conn)
	check()
	ForgetLane(conn)
	if LaneSocketOf(conn) != nil {
		t.Fatal("the holder stayed after ForgetLane")
	}
}
