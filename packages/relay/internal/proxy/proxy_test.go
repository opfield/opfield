package proxy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"io"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/opfield/opfield/relay/internal/codec"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type transportStream struct {
	method  string
	header  metadata.MD
	trailer metadata.MD
}

func (s *transportStream) Method() string { return s.method }
func (s *transportStream) SetHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *transportStream) SendHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *transportStream) SetTrailer(md metadata.MD) error {
	s.trailer = metadata.Join(s.trailer, md)
	return nil
}

type downstreamStream struct {
	ctx      context.Context
	input    []codec.Frame
	position int
	output   []codec.Frame
	header   metadata.MD
	trailer  metadata.MD
}

func (s *downstreamStream) SetHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *downstreamStream) SendHeader(md metadata.MD) error {
	s.header = metadata.Join(s.header, md)
	return nil
}
func (s *downstreamStream) SetTrailer(md metadata.MD) { s.trailer = metadata.Join(s.trailer, md) }
func (s *downstreamStream) Context() context.Context  { return s.ctx }
func (s *downstreamStream) SendMsg(value any) error {
	frame := value.(*codec.Frame)
	s.output = append(s.output, append(codec.Frame(nil), (*frame)...))
	return nil
}
func (s *downstreamStream) RecvMsg(value any) error {
	if s.position >= len(s.input) {
		return io.EOF
	}
	frame := value.(*codec.Frame)
	*frame = append((*frame)[:0], s.input[s.position]...)
	s.position++
	return nil
}

// echoUpstream answers every call with its first frame and records the metadata Opfield received.
func echoUpstream(t *testing.T) (*grpc.ClientConn, func() metadata.MD, func()) {
	t.Helper()
	var mu sync.Mutex
	var seen metadata.MD
	conn, stop := startUpstream(t, func(_ any, stream grpc.ServerStream) error {
		incoming, _ := metadata.FromIncomingContext(stream.Context())
		mu.Lock()
		seen = incoming.Copy()
		mu.Unlock()
		var frames []codec.Frame
		for {
			var frame codec.Frame
			err := stream.RecvMsg(&frame)
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			frames = append(frames, append(codec.Frame(nil), frame...))
		}
		return stream.SendMsg(&frames[0])
	})
	return conn, func() metadata.MD {
		mu.Lock()
		defer mu.Unlock()
		return seen
	}, stop
}

// Opfield learns which daemon is calling only from the relay-injected headers, so
// they must come from the verified certificate and never from the caller. The
// caller's headers with the legacy prefix are dropped too: an Opfield that still
// reads them for an older relay must never get them from a client.
func TestProxyForwardsOnlyTheVerifiedDaemonIdentity(t *testing.T) {
	for _, method := range []string{"/opfield.v1.Contract/Unary", "/" + legacycompat.GRPCPackage + ".Contract/Unary"} {
		conn, seen, stop := echoUpstream(t)
		handler := New(conn, func() (*grpc.ClientConn, error) { return conn, nil })

		stream := authenticatedDownstream(method, []codec.Frame{{1}}, context.Background())
		if err := handler.Handle(nil, stream); err != nil {
			t.Fatal(err)
		}
		if !equalFrames(stream.output, []codec.Frame{{1}}) {
			t.Fatalf("%s: output = %v", method, stream.output)
		}
		forwarded := seen()
		nodeIDs := forwarded.Get("x-opfield-relay-node-id")
		if len(nodeIDs) != 1 || nodeIDs[0] != "node-1" || forwarded.Get("x-client-metadata")[0] != "kept" ||
			forwarded.Get("x-opfield-relay-cert-serial")[0] != "2a" || len(forwarded.Get("x-opfield-relay-cert-sha256")) != 1 {
			t.Fatalf("%s: verified identity was not injected: %v", method, forwarded)
		}
		for _, spoofed := range []string{"x-opfield-relay-spoofed", legacycompat.RelayMetadataPrefix + "spoofed", legacycompat.RelayMetadataPrefix + "node-id", legacycompat.RelayMetadataPrefix + "cert-serial", legacycompat.RelayMetadataPrefix + "cert-sha256"} {
			if forwarded.Get(spoofed) != nil {
				t.Fatalf("%s: client header %s reached Opfield: %v", method, spoofed, forwarded)
			}
		}
		stop()
	}
}

func TestProxyRejectsDaemonsWithoutAVerifiedCertificate(t *testing.T) {
	conn, seen, stop := echoUpstream(t)
	defer stop()
	handler := New(conn, func() (*grpc.ClientConn, error) { return conn, nil })

	unverified := downstreamFor("/"+legacycompat.GRPCPackage+".NodeControl/CommandStream", []codec.Frame{{1}}, context.Background(), false)
	if code := status.Code(handler.Handle(nil, unverified)); code != codes.Unauthenticated {
		t.Fatalf("unverified daemon status = %v, want Unauthenticated", code)
	}
	if seen() != nil {
		t.Fatal("an unverified daemon reached Opfield")
	}
	foreign := authenticatedDownstream("/grpc.reflection.v1.ServerReflection/ServerReflectionInfo", []codec.Frame{{1}}, context.Background())
	if code := status.Code(handler.Handle(nil, foreign)); code != codes.Unimplemented {
		t.Fatalf("method outside the Opfield API status = %v, want Unimplemented", code)
	}

	unverifiedOpfield := downstreamFor("/opfield.v1.NodeControl/CommandStream", []codec.Frame{{1}}, context.Background(), false)
	if code := status.Code(handler.Handle(nil, unverifiedOpfield)); code != codes.Unauthenticated {
		t.Fatalf("unverified daemon on the opfield.v1 package status = %v, want Unauthenticated", code)
	}

	// Enrollment is how a daemon gets its first certificate: it passes, under
	// either package name, but without any identity headers, including ones the
	// caller made up.
	for _, method := range []string{"/opfield.v1.NodeEnrollment/Enroll", "/" + legacycompat.GRPCPackage + ".NodeEnrollment/Enroll"} {
		enrollment := downstreamFor(method, []codec.Frame{{1}}, context.Background(), false)
		if err := handler.Handle(nil, enrollment); err != nil {
			t.Fatal(err)
		}
		forwarded := seen()
		for key := range forwarded {
			if strings.HasPrefix(key, "x-opfield-relay-") || strings.HasPrefix(key, legacycompat.RelayMetadataPrefix) {
				t.Fatalf("%s carried relay identity header %s: %v", method, key, forwarded)
			}
		}
	}
}

// A renewed relay client certificate is picked up by reloading the upstream; streams
// daemons hold open must keep running on the previous connection meanwhile.
func TestReloadUpstreamKeepsRunningStreamsOnPreviousConnection(t *testing.T) {
	started := make(chan struct{}, 1)
	proceed := make(chan struct{})
	var previousCalls, nextCalls int
	var callsMu sync.Mutex
	previous, stopPrevious := startUpstream(t, func(_ any, stream grpc.ServerStream) error {
		callsMu.Lock()
		previousCalls++
		callsMu.Unlock()
		var frame codec.Frame
		for stream.RecvMsg(&frame) == nil {
		}
		started <- struct{}{}
		<-proceed
		reply := codec.Frame{7}
		return stream.SendMsg(&reply)
	})
	defer stopPrevious()
	next, stopNext := startUpstream(t, func(_ any, stream grpc.ServerStream) error {
		callsMu.Lock()
		nextCalls++
		callsMu.Unlock()
		var frame codec.Frame
		for stream.RecvMsg(&frame) == nil {
		}
		reply := codec.Frame{8}
		return stream.SendMsg(&reply)
	})
	defer stopNext()
	handler := New(previous, func() (*grpc.ClientConn, error) { return next, nil })

	running := authenticatedDownstream("/"+legacycompat.GRPCPackage+".NodeControl/CommandStream", []codec.Frame{{1}}, context.Background())
	result := make(chan error, 1)
	go func() { result <- handler.Handle(nil, running) }()
	<-started
	if err := handler.ReloadUpstream(); err != nil {
		t.Fatal(err)
	}
	if state := previous.GetState(); state == connectivity.Shutdown {
		t.Fatal("reload closed the connection a running stream still uses")
	}

	fresh := authenticatedDownstream("/"+legacycompat.GRPCPackage+".NodeControl/CommandStream", []codec.Frame{{2}}, context.Background())
	if err := handler.Handle(nil, fresh); err != nil {
		t.Fatal(err)
	}
	if !equalFrames(fresh.output, []codec.Frame{{8}}) {
		t.Fatalf("new stream output = %v, want it served over the reloaded connection", fresh.output)
	}

	close(proceed)
	if err := <-result; err != nil {
		t.Fatalf("running stream was interrupted by the reload: %v", err)
	}
	if !equalFrames(running.output, []codec.Frame{{7}}) {
		t.Fatalf("running stream output = %v", running.output)
	}
	callsMu.Lock()
	if previousCalls != 1 || nextCalls != 1 {
		t.Fatalf("calls previous=%d next=%d, want 1 each", previousCalls, nextCalls)
	}
	callsMu.Unlock()
	if state := previous.GetState(); state != connectivity.Shutdown {
		t.Fatalf("previous connection state after its last stream = %v, want closed", state)
	}
	if state := next.GetState(); state == connectivity.Shutdown {
		t.Fatal("reloaded connection was closed")
	}
}

func TestReloadUpstreamClosesIdlePreviousConnectionImmediately(t *testing.T) {
	previous, stopPrevious := startUpstream(t, func(_ any, stream grpc.ServerStream) error { return nil })
	defer stopPrevious()
	next, stopNext := startUpstream(t, func(_ any, stream grpc.ServerStream) error { return nil })
	defer stopNext()
	handler := New(previous, func() (*grpc.ClientConn, error) { return next, nil })
	if err := handler.ReloadUpstream(); err != nil {
		t.Fatal(err)
	}
	if state := previous.GetState(); state != connectivity.Shutdown {
		t.Fatalf("idle previous connection state = %v, want closed", state)
	}
	if err := handler.Close(); err != nil {
		t.Fatal(err)
	}
	if state := next.GetState(); state != connectivity.Shutdown {
		t.Fatalf("current connection state after Close = %v, want closed", state)
	}
}

func authenticatedDownstream(method string, input []codec.Frame, base context.Context) *downstreamStream {
	return downstreamFor(method, input, base, true)
}

func downstreamFor(method string, input []codec.Frame, base context.Context, verified bool) *downstreamStream {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: "node-1"}, SerialNumber: big.NewInt(42), Raw: []byte("node-certificate")}
	ctx := metadata.NewIncomingContext(base, metadata.Pairs("x-client-metadata", "kept", legacycompat.RelayMetadataPrefix+"spoofed", "removed", legacycompat.RelayMetadataPrefix+"node-id", "spoofed-node",
		legacycompat.RelayMetadataPrefix+"cert-serial", "spoofed", legacycompat.RelayMetadataPrefix+"cert-sha256", "spoofed",
		"x-opfield-relay-spoofed", "removed", "X-Opfield-Relay-Node-Id", "spoofed-node", "x-opfield-relay-cert-serial", "spoofed"))
	state := tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}}
	if verified {
		state.VerifiedChains = [][]*x509.Certificate{{certificate}}
	}
	ctx = grpcpeer.NewContext(ctx, &grpcpeer.Peer{AuthInfo: credentials.TLSInfo{State: state}})
	transport := &transportStream{method: method}
	ctx = grpc.NewContextWithServerTransportStream(ctx, transport)
	return &downstreamStream{ctx: ctx, input: input}
}

func startUpstream(t *testing.T, handler grpc.StreamHandler) (*grpc.ClientConn, func()) {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer(grpc.ForceServerCodec(codec.Codec{}), grpc.UnknownServiceHandler(handler))
	go func() { _ = server.Serve(listener) }()
	conn, err := grpc.NewClient("passthrough:///upstream", grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.ForceCodec(codec.Codec{})))
	if err != nil {
		t.Fatal(err)
	}
	return conn, func() { _ = conn.Close(); server.Stop(); _ = listener.Close() }
}

func equalFrames(left, right []codec.Frame) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if string(left[index]) != string(right[index]) {
			return false
		}
	}
	return true
}
