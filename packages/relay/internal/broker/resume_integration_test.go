package broker

// Integration harness for resumable relay streams (RSv1): real brokers on
// loopback gRPC with mTLS, real policy snapshots and grants, and endpoints
// built on daemon-shared/relayresume. It proves that the unchanged relay
// carries resumable streams and that they move between relays on drain,
// GOAWAY, hard stops and forced disconnects, while revocation, idle timeouts
// and proxy half-close reaping keep today's terminal semantics.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"runtime/pprof"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relayresume"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/daemon-shared/tlsbatch"
	"github.com/opfield/opfield/relay/internal/codec"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/identity"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
)

const (
	rhOpfieldID   = "opfield-harness"
	rhGrantKeyID  = "harness-key"
	rhSourceNode  = "node-source"
	rhTargetNode  = "node-target"
	rhRelayServer = "relay.harness"
)

// rhPKI is a throwaway CA with server and client leaves.
type rhPKI struct {
	cert *x509.Certificate
	key  ed25519.PrivateKey
	pool *x509.CertPool
	next atomic.Int64
}

func newRHPKI(t testing.TB) *rhPKI {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "harness-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	p := &rhPKI{cert: cert, key: private, pool: pool}
	p.next.Store(1)
	return p
}

// leaf issues a certificate; it returns the TLS pair and its relay fingerprint.
func (p *rhPKI) leaf(t testing.TB, commonName string, server bool) (tls.Certificate, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(p.next.Add(1)),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	if server {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		template.DNSNames = []string{rhRelayServer}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, p.cert, public, p.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private}, identity.Fingerprint(der)
}

// rhRelay is one relay: a broker over its own policy store, served on a
// loopback port that survives a restart.
type rhRelay struct {
	h        *rhHarness
	id       string
	store    *policy.Store
	mu       sync.Mutex
	broker   *Broker
	server   *grpc.Server
	addr     string
	stopped  bool
	restarts int
}

type rhRoute struct {
	id                 string
	generation         uint64
	class              string
	disableIdleTimeout bool
}

// rhHarness owns the PKI, the grant key, the relays and the policy every
// relay runs.
type rhHarness struct {
	t                 testing.TB
	pki               *rhPKI
	grantPublic       ed25519.PublicKey
	grantPrivate      ed25519.PrivateKey
	sourceCert        tls.Certificate
	sourceFingerprint string
	targetCert        tls.Certificate
	targetFingerprint string
	serverCert        tls.Certificate

	mu       sync.Mutex
	revision uint64
	relays   []*rhRelay
	endpoint uint64 // endpoint generation; 0: revoked
	routes   map[string]*rhRoute
	grants   atomic.Int64
}

func newRHHarness(t testing.TB) *rhHarness {
	t.Helper()
	pki := newRHPKI(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &rhHarness{t: t, pki: pki, grantPublic: public, grantPrivate: private, endpoint: 1, routes: map[string]*rhRoute{}}
	h.sourceCert, h.sourceFingerprint = pki.leaf(t, rhSourceNode, false)
	h.targetCert, h.targetFingerprint = pki.leaf(t, rhTargetNode, false)
	h.serverCert, _ = pki.leaf(t, rhRelayServer, true)
	return h
}

func (h *rhHarness) addRoute(route rhRoute) {
	h.mu.Lock()
	if route.generation == 0 {
		route.generation = 1
	}
	h.routes[route.id] = &route
	h.mu.Unlock()
}

func (h *rhHarness) snapshotLocked() *relayv1.ApplySnapshotRequest {
	h.revision++
	request := &relayv1.ApplySnapshotRequest{
		Revision:          h.revision,
		OpfieldInstanceId: rhOpfieldID,
		PublicKeys:        []*relayv1.PublicKey{{KeyId: rhGrantKeyID, PublicKey: h.grantPublic}},
	}
	if h.endpoint == 0 {
		return request
	}
	request.Endpoints = []*relayv1.EndpointPolicy{{
		EndpointId: "endpoint-target", Generation: h.endpoint, SubjectKind: "daemon", SubjectId: rhTargetNode,
		CertificateSha256: h.targetFingerprint,
	}}
	for _, route := range h.routes {
		request.Routes = append(request.Routes, &relayv1.RoutePolicy{
			RouteId: route.id, Generation: route.generation, SourceKind: "daemon", SourceId: rhSourceNode,
			SourceCertificateSha256: h.sourceFingerprint, TargetEndpointId: "endpoint-target",
			TrafficClass: route.class, DisableIdleTimeout: route.disableIdleTimeout,
		})
	}
	return request
}

// applyPolicy pushes the current policy to every relay (Reconcile closes the
// tunnels a change revoked, as the admin service does).
func (h *rhHarness) applyPolicy(relays ...*rhRelay) {
	h.t.Helper()
	h.mu.Lock()
	request := h.snapshotLocked()
	if len(relays) == 0 {
		relays = append(relays, h.relays...)
	}
	h.mu.Unlock()
	for _, relay := range relays {
		relay.mu.Lock()
		broker := relay.broker
		relay.mu.Unlock()
		if _, _, err := broker.ApplySnapshot(request); err != nil {
			h.t.Fatalf("apply policy on %s: %v", relay.id, err)
		}
	}
}

// startRelay starts a relay on a fresh loopback port with the current policy.
func (h *rhHarness) startRelay(id string) *rhRelay {
	h.t.Helper()
	store, err := policy.Open(h.t.TempDir())
	if err != nil {
		h.t.Fatal(err)
	}
	relay := &rhRelay{h: h, id: id, store: store}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		h.t.Fatal(err)
	}
	relay.addr = listener.Addr().String()
	relay.serve(listener)
	h.mu.Lock()
	h.relays = append(h.relays, relay)
	h.mu.Unlock()
	h.applyPolicy(relay)
	h.t.Cleanup(func() {
		relay.stopHard()
		_ = store.Close()
	})
	return relay
}

func (r *rhRelay) serve(listener net.Listener) {
	server := grpc.NewServer(
		grpc.Creds(tlsbatch.Credentials(credentials.NewTLS(&tls.Config{
			Certificates: []tls.Certificate{r.h.serverCert},
			ClientCAs:    r.h.pki.pool,
			ClientAuth:   tls.RequireAndVerifyClientCert,
			MinVersion:   tls.VersionTLS13,
		}))),
		grpc.ForceServerCodecV2(codec.ServerCodec{}),
		// The relay's fixed HTTP/2 windows (server.laneStreamWindow, laneConnWindow).
		grpc.InitialWindowSize(8<<20), grpc.InitialConnWindowSize(32<<20),
		grpc.MaxRecvMsgSize(4*1024*1024), grpc.MaxSendMsgSize(4*1024*1024),
	)
	broker := New(r.store)
	relayv1.RegisterTunnelBrokerServer(server, broker)
	r.mu.Lock()
	r.broker, r.server, r.stopped = broker, server, false
	r.mu.Unlock()
	go func() { _ = server.Serve(listener) }()
}

// stopGraceful is the relay's shutdown: GOAWAY, open streams live on until
// they end or the grace passes, then a hard stop.
func (r *rhRelay) stopGraceful(grace time.Duration) {
	r.mu.Lock()
	server := r.server
	r.stopped = true
	r.mu.Unlock()
	done := make(chan struct{})
	go func() {
		server.GracefulStop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
		server.Stop()
		<-done
	}
}

// stopHard is a killed relay: every connection drops at once.
func (r *rhRelay) stopHard() {
	r.mu.Lock()
	server := r.server
	r.stopped = true
	r.mu.Unlock()
	if server != nil {
		server.Stop()
	}
}

// restart brings the relay back on the same address with a fresh broker
// (in-memory state lost, policy kept), like a restarted relay process.
func (r *rhRelay) restart() {
	r.h.t.Helper()
	var listener net.Listener
	var err error
	for attempt := 0; attempt < 50; attempt++ {
		if listener, err = net.Listen("tcp", r.addr); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		r.h.t.Fatalf("relay %s could not listen again: %v", r.id, err)
	}
	r.mu.Lock()
	r.restarts++
	r.mu.Unlock()
	r.serve(listener)
	r.h.applyPolicy(r)
}

func (r *rhRelay) currentBroker() *Broker {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.broker
}

// activeTunnels is the relay's live tunnel count.
func (r *rhRelay) activeTunnels() int {
	broker := r.currentBroker()
	broker.mu.Lock()
	defer broker.mu.Unlock()
	return len(broker.active)
}

func (h *rhHarness) dial(relay *rhRelay, cert tls.Certificate) *grpc.ClientConn {
	h.t.Helper()
	conn, err := grpc.NewClient(relay.addr,
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			Certificates: []tls.Certificate{cert},
			RootCAs:      h.pki.pool,
			ServerName:   rhRelayServer,
			MinVersion:   tls.VersionTLS13,
		})),
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff:           backoff.Config{BaseDelay: 50 * time.Millisecond, Multiplier: 1.6, MaxDelay: 300 * time.Millisecond},
			MinConnectTimeout: time.Second,
		}),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(4*1024*1024), grpc.MaxCallSendMsgSize(4*1024*1024)),
	)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func (h *rhHarness) sign(claims grant.Claims) *relayv1.SignedGrant {
	h.t.Helper()
	now := time.Now()
	claims.SchemaVersion = 1
	claims.Audience = grant.Audience
	claims.GrantID = fmt.Sprintf("grant-%d", h.grants.Add(1))
	claims.OpfieldInstanceID = rhOpfieldID
	claims.IssuedAt = now.Add(-time.Minute).Unix()
	claims.NotBefore = claims.IssuedAt
	claims.ExpiresAt = now.Add(time.Hour).Unix()
	payload, err := json.Marshal(claims)
	if err != nil {
		h.t.Fatal(err)
	}
	return &relayv1.SignedGrant{KeyId: rhGrantKeyID, Payload: payload, Signature: ed25519.Sign(h.grantPrivate, payload)}
}

func (h *rhHarness) connectGrant(routeID string) *relayv1.SignedGrant {
	h.mu.Lock()
	generation := uint64(1)
	if route := h.routes[routeID]; route != nil {
		generation = route.generation
	}
	h.mu.Unlock()
	return h.sign(grant.Claims{Kind: "connect", SubjectKind: "daemon", SubjectID: rhSourceNode, CertificateSHA256: h.sourceFingerprint, RouteID: routeID, RouteGeneration: generation})
}

func (h *rhHarness) endpointGrant() *relayv1.SignedGrant {
	h.mu.Lock()
	generation := h.endpoint
	h.mu.Unlock()
	return h.sign(grant.Claims{Kind: "endpoint", SubjectKind: "daemon", SubjectID: rhTargetNode, CertificateSHA256: h.targetFingerprint, EndpointID: "endpoint-target", EndpointGeneration: generation})
}

// openTunnel opens a source tunnel and reads its Ready frame.
func (h *rhHarness) openTunnel(ctx context.Context, conn *grpc.ClientConn, routeID string) (relayv1.TunnelBroker_OpenTunnelClient, int, error) {
	stream, err := relayv1.NewTunnelBrokerClient(conn).OpenTunnel(ctx)
	if err != nil {
		return nil, 0, err
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: h.connectGrant(routeID)}}}); err != nil {
		return nil, 0, err
	}
	first, err := stream.Recv()
	if err != nil {
		return nil, 0, err
	}
	if first.GetReady() == nil {
		return nil, 0, fmt.Errorf("relay answered %v instead of Ready", first.GetPayload())
	}
	return stream, int(first.GetReady().GetMaxFrameBytes()), nil
}

// rhAccepted is one tunnel a target accepted on a relay.
type rhAccepted struct {
	relayID  string
	incoming *relayv1.IncomingTunnel
	stream   relayv1.TunnelBroker_AcceptTunnelClient
	cancel   context.CancelFunc
	maxFrame int
}

// rhTarget is the target daemon's relay side: one registration per relay,
// re-registered after the relay restarts, handing every accepted tunnel to
// the handler.
type rhTarget struct {
	h      *rhHarness
	handle func(*rhAccepted)
	// conn, when set, is the connection every registration uses (a link
	// with a delay in front of the relay).
	conn    *grpc.ClientConn
	mu      sync.Mutex
	ready   map[string]int // registrations per relay id
	cancels []context.CancelFunc
}

func (h *rhHarness) startTarget(handle func(*rhAccepted), relays ...*rhRelay) *rhTarget {
	target := &rhTarget{h: h, handle: handle, ready: map[string]int{}}
	for _, relay := range relays {
		target.register(relay)
	}
	h.t.Cleanup(target.stop)
	return target
}

func (t *rhTarget) stop() {
	t.mu.Lock()
	cancels := t.cancels
	t.cancels = nil
	t.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// register keeps a registration on relay until stop, like the daemon's
// relay pool lane.
func (t *rhTarget) register(relay *rhRelay) {
	ctx, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	t.cancels = append(t.cancels, cancel)
	t.mu.Unlock()
	conn := t.conn
	if conn == nil {
		conn = t.h.dial(relay, t.h.targetCert)
	}
	go func() {
		for ctx.Err() == nil {
			t.registerOnce(ctx, conn, relay.id)
			select {
			case <-ctx.Done():
			case <-time.After(50 * time.Millisecond):
			}
		}
	}()
}

func (t *rhTarget) registerOnce(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	regCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := relayv1.NewTunnelBrokerClient(conn).RegisterEndpoint(regCtx, grpc.WaitForReady(true))
	if err != nil {
		return
	}
	if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{Grant: t.h.endpointGrant()}}}); err != nil {
		return
	}
	registered := false
	defer func() {
		if registered {
			t.mu.Lock()
			t.ready[relayID]--
			t.mu.Unlock()
		}
	}()
	for {
		message, err := stream.Recv()
		if err != nil {
			return
		}
		if message.GetRegistered() != nil {
			registered = true
			t.mu.Lock()
			t.ready[relayID]++
			t.mu.Unlock()
			continue
		}
		incoming := message.GetIncoming()
		if incoming == nil {
			continue
		}
		// A path is bound to its registration, as in the daemons.
		go t.accept(regCtx, conn, relayID, incoming)
	}
}

func (t *rhTarget) accept(ctx context.Context, conn *grpc.ClientConn, relayID string, incoming *relayv1.IncomingTunnel) {
	acceptCtx, cancel := context.WithCancel(ctx)
	stream, err := relayv1.NewTunnelBrokerClient(conn).AcceptTunnel(acceptCtx)
	if err != nil {
		cancel()
		return
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: incoming.GetAcceptToken()}}}); err != nil {
		cancel()
		return
	}
	first, err := stream.Recv()
	if err != nil || first.GetReady() == nil {
		cancel()
		return
	}
	t.handle(&rhAccepted{relayID: relayID, incoming: incoming, stream: stream, cancel: cancel, maxFrame: int(first.GetReady().GetMaxFrameBytes())})
}

// waitRegistered waits until the target is registered on every relay.
func (t *rhTarget) waitRegistered(relays ...*rhRelay) {
	t.h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		t.mu.Lock()
		ok := true
		for _, relay := range relays {
			if t.ready[relay.id] < 1 {
				ok = false
			}
		}
		t.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.h.t.Fatal("target did not register on every relay")
}

func rhRandom(t testing.TB, size int) []byte {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	return data
}

func rhDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:8])
}

func rhWait(t testing.TB, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	if !rhWaitFor(t, what, timeout, condition) {
		t.FailNow()
	}
}

// rhWaitFor reports a timeout with Errorf: safe from the exchange's writer
// goroutine, where FailNow is not.
func rhWaitFor(t testing.TB, what string, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("timed out waiting for %s", what)
	return false
}

// rawEcho is a legacy target: it echoes Data and answers HalfClose, as the
// daemons' raw bridges do.
func rawEcho(accepted *rhAccepted) {
	defer accepted.cancel()
	for {
		frame, err := accepted.stream.Recv()
		if err != nil {
			return
		}
		switch {
		case frame.GetData() != nil:
			if err := accepted.stream.Send(frame); err != nil {
				return
			}
		case frame.GetHalfClose() != nil:
			_ = accepted.stream.Send(frame)
		default:
			return
		}
	}
}

// The harness itself: a raw stream through a real broker is byte-exact, and
// the relay counts it until it ends. Resumable streams below run the same way.
func TestResumeHarnessCarriesRawStreams(t *testing.T) {
	h := newRHHarness(t)
	h.addRoute(rhRoute{id: "route-raw"})
	relay := h.startRelay("relay-a")
	target := h.startTarget(rawEcho, relay)
	target.waitRegistered(relay)
	conn := h.dial(relay, h.sourceCert)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stream, maxFrame, err := h.openTunnel(ctx, conn, "route-raw")
	if err != nil {
		t.Fatal(err)
	}
	payload := rhRandom(t, 3*1024*1024+17)
	go func() {
		for offset := 0; offset < len(payload); offset += maxFrame {
			end := min(len(payload), offset+maxFrame)
			if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: payload[offset:end]}}}); err != nil {
				return
			}
		}
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
	}()
	var echoed []byte
	for {
		frame, err := stream.Recv()
		if err != nil {
			t.Fatal(err)
		}
		if frame.GetHalfClose() != nil {
			break
		}
		echoed = append(echoed, frame.GetData().GetData()...)
	}
	if rhDigest(echoed) != rhDigest(payload) || len(echoed) != len(payload) {
		t.Fatalf("echo differs: %d bytes, want %d", len(echoed), len(payload))
	}
	_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
	rhWait(t, "the relay to release the tunnel", 5*time.Second, func() bool { return relay.activeTunnels() == 0 })
}

// ---------------------------------------------------------------------------
// Resumable endpoints
// ---------------------------------------------------------------------------

var rhResumeSecret = bytes.Repeat([]byte{0x42}, 32)

func rhRouteKey(t testing.TB, routeID string) (string, []byte) {
	t.Helper()
	key, err := relayresume.DeriveRouteKey(rhResumeSecret, routeID, 1)
	if err != nil {
		t.Fatal(err)
	}
	return relayresume.RouteKeyID(1), key
}

// frameStream is the bridges' view of a tunnel (relaybridge.FrameStream).
type frameStream interface {
	Send(*relayv1.TunnelFrame) error
	Recv() (*relayv1.TunnelFrame, error)
}

// serveEcho echoes every byte and answers the FIN, as an echo backend behind
// the daemons' bridges would.
func serveEcho(stream frameStream) {
	for {
		frame, err := stream.Recv()
		if err != nil {
			return
		}
		switch {
		case frame.GetData() != nil:
			data := append([]byte(nil), frame.GetData().GetData()...)
			if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}); err != nil {
				return
			}
		case frame.GetHalfClose() != nil:
			if err := stream.Send(frame); err != nil {
				return
			}
		default:
			return
		}
	}
}

// rhResumeTarget serves accepted tunnels with a relayresume target table in
// front of an echo backend.
type rhResumeTarget struct {
	t        testing.TB
	table    *relayresume.TargetTable
	revoked  atomic.Bool
	accepted sync.Map // AcceptKind -> *atomic.Int64
	backends atomic.Int64
	// serve runs the backend of a new stream (default: echo).
	serve func(frameStream)
	// beforeEstablish runs before HELLO_ACK goes out (the backend dial).
	beforeEstablish func()
}

func newRHResumeTarget(t testing.TB) *rhResumeTarget {
	return &rhResumeTarget{t: t, table: relayresume.NewTargetTable(nil), serve: serveEcho}
}

func (r *rhResumeTarget) count(kind relayresume.AcceptKind) int64 {
	value, _ := r.accepted.LoadOrStore(kind, &atomic.Int64{})
	return value.(*atomic.Int64).Load()
}

func (r *rhResumeTarget) handle(accepted *rhAccepted) {
	route := accepted.incoming.GetRoute()
	op := relayresume.OpenedPath{
		Stream: accepted.stream, Cancel: accepted.cancel, CloseSend: accepted.stream.CloseSend,
		RelayID: accepted.relayID, MaxFrame: accepted.maxFrame,
	}
	request := relayresume.AcceptRequest{
		RouteID: route.GetRouteId(), SourceKind: route.GetSourceKind(), SourceID: route.GetSourceId(), RelayID: accepted.relayID,
		Keys: func(keyID string) []byte {
			id, key := rhRouteKey(r.t, route.GetRouteId())
			if keyID != id {
				return nil
			}
			return key
		},
		Authorize: func() error {
			if r.revoked.Load() {
				return errors.New("route revoked")
			}
			return nil
		},
	}
	decision := r.table.Accept(op, request)
	counter, _ := r.accepted.LoadOrStore(decision.Kind, &atomic.Int64{})
	counter.(*atomic.Int64).Add(1)
	switch decision.Kind {
	case relayresume.AcceptLegacy:
		r.backends.Add(1)
		serveEcho(decision.Stream)
		accepted.cancel()
	case relayresume.AcceptHello:
		r.backends.Add(1)
		if r.beforeEstablish != nil {
			r.beforeEstablish()
		}
		session, err := decision.Establish()
		if err != nil {
			accepted.cancel()
			return
		}
		r.serve(session)
	default:
		// Resumed onto this tunnel or refused: the session owns the stream.
		<-decision.PathDone
	}
}

// rhSource is the source daemon's side: a relayresume manager and a dialer
// over the harness relays in candidate order.
type rhSource struct {
	h        *rhHarness
	routeID  string
	manager  *relayresume.Manager
	relays   []*rhRelay
	conns    map[string]*grpc.ClientConn
	mu       sync.Mutex
	draining map[string]bool
	dials    atomic.Int64
	keyOK    atomic.Bool
}

func (h *rhHarness) newSource(routeID string, relays ...*rhRelay) *rhSource {
	source := &rhSource{h: h, routeID: routeID, manager: relayresume.NewManager(nil), relays: relays,
		conns: map[string]*grpc.ClientConn{}, draining: map[string]bool{}}
	source.keyOK.Store(true)
	for _, relay := range relays {
		source.conns[relay.id] = h.dial(relay, h.sourceCert)
	}
	return source
}

// setDraining marks the relay's candidate draining in the source's bundle.
func (s *rhSource) setDraining(relayID string, draining bool) {
	s.mu.Lock()
	s.draining[relayID] = draining
	s.mu.Unlock()
}

// dial opens a tunnel on the first active candidate other than avoid (the
// same relay is fine when it is the only one), each within OpenTimeout.
func (s *rhSource) dial(ctx context.Context, request relayresume.DialRequest) (relayresume.OpenedPath, error) {
	avoid := request.Avoid
	s.dials.Add(1)
	s.mu.Lock()
	var candidates []*rhRelay
	for _, relay := range s.relays {
		if !s.draining[relay.id] {
			candidates = append(candidates, relay)
		}
	}
	s.mu.Unlock()
	var lastErr error = errors.New("no active relay candidate")
	for _, relay := range candidates {
		if relay.id == avoid && len(candidates) > 1 {
			continue
		}
		op, err := s.open(ctx, relay)
		if err == nil {
			return op, nil
		}
		lastErr = err
	}
	return relayresume.OpenedPath{}, lastErr
}

func (s *rhSource) open(ctx context.Context, relay *rhRelay) (relayresume.OpenedPath, error) {
	// The stream outlives the dial: only its setup is bounded.
	streamCtx, cancel := context.WithCancel(context.Background())
	type opened struct {
		stream   relayv1.TunnelBroker_OpenTunnelClient
		maxFrame int
		err      error
	}
	result := make(chan opened, 1)
	go func() {
		stream, maxFrame, err := s.h.openTunnel(streamCtx, s.conns[relay.id], s.routeID)
		result <- opened{stream, maxFrame, err}
	}()
	timer := time.NewTimer(relayresume.OpenTimeout)
	defer timer.Stop()
	select {
	case got := <-result:
		if got.err != nil {
			cancel()
			return relayresume.OpenedPath{}, got.err
		}
		return relayresume.OpenedPath{Stream: got.stream, Cancel: cancel, CloseSend: got.stream.CloseSend, RelayID: relay.id, MaxFrame: got.maxFrame}, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	cancel()
	return relayresume.OpenedPath{}, errors.New("relay tunnel open timed out")
}

func (s *rhSource) config(halfClose time.Duration) relayresume.SourceConfig {
	return relayresume.SourceConfig{
		RouteID: s.routeID,
		Key: func() (string, []byte, bool) {
			id, key := rhRouteKey(s.h.t, s.routeID)
			return id, key, s.keyOK.Load()
		},
		HalfCloseTimeout: halfClose,
		Dial:             s.dial,
	}
}

// start opens a resumable stream on the first candidate.
func (s *rhSource) start(halfClose time.Duration) *relayresume.Session {
	s.h.t.Helper()
	first, err := s.dial(context.Background(), relayresume.DialRequest{})
	if err != nil {
		s.h.t.Fatal(err)
	}
	session, err := s.manager.NewSource(s.config(halfClose), first)
	if err != nil {
		s.h.t.Fatal(err)
	}
	return session
}

// exchange writes payload through the stream (then FIN) and reads the echo
// until the peer's FIN; at, when set, runs once after `at` bytes went out.
func exchange(t testing.TB, stream frameStream, payload []byte, chunk int, at int, during func()) ([]byte, error) {
	t.Helper()
	writeErr := make(chan error, 1)
	go func() {
		for offset := 0; offset < len(payload); offset += chunk {
			if during != nil && offset >= at {
				during()
				during = nil
			}
			end := min(len(payload), offset+chunk)
			data := append([]byte(nil), payload[offset:end]...)
			if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}); err != nil {
				writeErr <- err
				return
			}
		}
		if during != nil {
			during()
		}
		writeErr <- stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
	}()
	var echoed []byte
	for {
		frame, err := stream.Recv()
		if err != nil {
			return echoed, err
		}
		if frame.GetHalfClose() != nil {
			break
		}
		if frame.GetClose() != nil {
			return echoed, errors.New("stream closed before the peer's FIN")
		}
		echoed = append(echoed, frame.GetData().GetData()...)
	}
	if err := <-writeErr; err != nil {
		return echoed, err
	}
	return echoed, nil
}

// finish runs the CLOSE exchange and checks the stream ended cleanly.
func finish(t testing.TB, session *relayresume.Session) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		_ = session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("the CLOSE exchange did not finish")
	}
	if err := session.Err(); err != nil {
		t.Fatalf("stream ended with %v", err)
	}
}

func checkEcho(t testing.TB, echoed, payload []byte, err error) {
	t.Helper()
	var reset *relayresume.ResetError
	if errors.As(err, &reset) {
		err = fmt.Errorf("%w (cause: %v)", err, reset.Err)
	}
	if err != nil {
		t.Fatalf("exchange failed after %d of %d bytes: %v", len(echoed), len(payload), err)
	}
	if len(echoed) != len(payload) || rhDigest(echoed) != rhDigest(payload) {
		t.Fatalf("echo differs: %d bytes (%s), want %d (%s)", len(echoed), rhDigest(echoed), len(payload), rhDigest(payload))
	}
}

type rhSetup struct {
	h      *rhHarness
	relays []*rhRelay
	target *rhResumeTarget
	reg    *rhTarget
	source *rhSource
}

func newRHSetup(t *testing.T, relays int, route rhRoute) *rhSetup {
	h := newRHHarness(t)
	h.addRoute(route)
	setup := &rhSetup{h: h, target: newRHResumeTarget(t)}
	for index := 0; index < relays; index++ {
		setup.relays = append(setup.relays, h.startRelay(fmt.Sprintf("relay-%c", 'a'+index)))
	}
	setup.reg = h.startTarget(setup.target.handle, setup.relays...)
	setup.reg.waitRegistered(setup.relays...)
	setup.source = h.newSource(route.id, setup.relays...)
	return setup
}

const rhPayload = 6 * 1024 * 1024

func TestResumeStreamsEchoByteExact(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-echo"})
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, 0, nil)
	checkEcho(t, echoed, payload, err)
	finish(t, session)
	if setup.target.count(relayresume.AcceptHello) != 1 || setup.target.backends.Load() != 1 {
		t.Fatalf("target served %d new streams with %d backends, want 1", setup.target.count(relayresume.AcceptHello), setup.target.backends.Load())
	}
	for _, relay := range setup.relays {
		rhWait(t, "relay "+relay.id+" to release its tunnels", 5*time.Second, func() bool { return relay.activeTunnels() == 0 })
	}
}

// A planned drain: the relay's candidate turns draining in the bundle and
// the relay refuses new tunnels; the stream moves while it runs, the drained
// relay ends up with no tunnels, and the backend never sees a second dial.
func TestResumePlannedDrainMovesStreams(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-drain"})
	a, b := setup.relays[0], setup.relays[1]
	session := setup.source.start(0)
	if session.RelayID() != a.id {
		t.Fatalf("stream started on %s", session.RelayID())
	}
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		a.currentBroker().SetDraining(true)
		setup.source.setDraining(a.id, true)
		setup.source.manager.DrainRelay(a.id, time.Time{})
		rhWaitFor(t, "the stream to move to relay-b", 10*time.Second, func() bool { return session.RelayID() == b.id })
		if !rhWaitFor(t, "the drained relay to reach 0 tunnels", 10*time.Second, func() bool { return a.activeTunnels() == 0 }) && os.Getenv("RH_DEBUG") != "" {
			_ = pprof.Lookup("goroutine").WriteTo(os.Stderr, 1)
		}
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
	if setup.target.backends.Load() != 1 || setup.target.count(relayresume.AcceptResumed) != 1 {
		t.Fatalf("backends=%d resumed=%d, want 1 and 1", setup.target.backends.Load(), setup.target.count(relayresume.AcceptResumed))
	}
}

// The end of a drain grace: SetDraining plus ForceDisconnect cuts every
// tunnel with the same status as a revocation; the session resumes elsewhere
// and the target's authorization recheck decides.
func TestResumeForceDisconnectResumesElsewhere(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-force"})
	a, b := setup.relays[0], setup.relays[1]
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		a.currentBroker().SetDraining(true)
		if closed := a.currentBroker().ForceDisconnect(); closed == 0 {
			t.Error("force disconnect closed no tunnel")
		}
		rhWaitFor(t, "the stream to resume on relay-b", 10*time.Second, func() bool { return session.RelayID() == b.id })
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
	if a.activeTunnels() != 0 {
		t.Fatalf("drained relay holds %d tunnels", a.activeTunnels())
	}
}

// A relay restart: GOAWAY leaves the lane not ready (the lane hook calls
// RelayLost) while open streams live on for the grace; the stream moves
// before the relay stops.
func TestResumeGracefulStopMovesBeforeTheStop(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-goaway"})
	a, b := setup.relays[0], setup.relays[1]
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	stopped := make(chan struct{})
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		go func() {
			a.stopGraceful(2 * time.Second)
			close(stopped)
		}()
		setup.source.manager.RelayLost(a.id)
		rhWaitFor(t, "the stream to move off the stopping relay", 1500*time.Millisecond, func() bool { return session.RelayID() == b.id })
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("the stopping relay did not stop")
	}
}

// A killed relay: the path fails mid-stream and the source resumes on the
// next relay (unplanned).
func TestResumeHardStopResumesOnAnotherRelay(t *testing.T) {
	setup := newRHSetup(t, 3, rhRoute{id: "route-kill"})
	a := setup.relays[0]
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		a.stopHard()
		rhWaitFor(t, "the stream to resume", 10*time.Second, func() bool {
			relay := session.RelayID()
			return relay != "" && relay != a.id
		})
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
}

// A single-relay install whose relay restarts: the stream suspends and
// resumes on the same relay once it is back.
func TestResumeSingleRelayRestartResumesOnTheSameRelay(t *testing.T) {
	setup := newRHSetup(t, 1, rhRoute{id: "route-single"})
	a := setup.relays[0]
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		a.stopHard()
		rhWaitFor(t, "the stream to suspend", 5*time.Second, func() bool { return session.RelayID() == "" })
		time.Sleep(300 * time.Millisecond)
		a.restart()
		rhWaitFor(t, "the stream to resume on the restarted relay", 15*time.Second, func() bool { return session.RelayID() == a.id })
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
	if setup.target.backends.Load() != 1 {
		t.Fatalf("backends = %d, want 1", setup.target.backends.Load())
	}
}

// Revocation during a suspended stream: relay B still admits the route (its
// policy lags), but the target's recheck refuses the RESUME and the stream is
// cut, as today.
func TestResumeRefusedAfterRevocation(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-revoke"})
	a := setup.relays[0]
	session := setup.source.start(0)
	payload := rhRandom(t, 64*1024)
	if err := session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), payload...)}}}); err != nil {
		t.Fatal(err)
	}
	var echoed []byte
	for len(echoed) < len(payload) {
		frame, err := session.Recv()
		if err != nil {
			t.Fatal(err)
		}
		echoed = append(echoed, frame.GetData().GetData()...)
	}
	setup.target.revoked.Store(true)
	a.stopHard()
	select {
	case <-session.Done():
	case <-time.After(15 * time.Second):
		t.Fatal("a revoked stream was not cut")
	}
	var reset *relayresume.ResetError
	// The first refusal is "unauthorized"; a retry that reaches the target after it reset the session meets the
	// tombstone ("reset"). Either way the stream is cut.
	if err := session.Err(); !errors.As(err, &reset) ||
		(reset.Reject != relayresume.RejectUnauthorized && reset.Reject != relayresume.RejectReset) {
		t.Fatalf("revoked stream ended with %v, want RESUME_REJ unauthorized or reset", err)
	}
	if setup.target.count(relayresume.AcceptRefused) == 0 {
		t.Fatal("the target never refused the resume")
	}
}

// A route generation bump closes the route's tunnels on every relay (policy
// reconcile); the stream resumes with a grant of the new generation.
func TestResumeSurvivesRouteGenerationBump(t *testing.T) {
	setup := newRHSetup(t, 2, rhRoute{id: "route-generation"})
	session := setup.source.start(0)
	payload := rhRandom(t, rhPayload)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/3, func() {
		before := setup.source.dials.Load()
		setup.h.mu.Lock()
		setup.h.routes["route-generation"].generation++
		setup.h.mu.Unlock()
		setup.h.applyPolicy()
		rhWaitFor(t, "the stream to resume after the bump", 10*time.Second, func() bool {
			return setup.source.dials.Load() > before && session.RelayID() != ""
		})
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
}

// A resumable source in front of a target that is not resume-aware gets its
// HELLO echoed back raw: it resets that stream and latches the route legacy.
func TestResumeLegacyTargetLatchesTheRoute(t *testing.T) {
	h := newRHHarness(t)
	h.addRoute(rhRoute{id: "route-legacy"})
	relay := h.startRelay("relay-a")
	target := h.startTarget(rawEcho, relay)
	target.waitRegistered(relay)
	source := h.newSource("route-legacy", relay)
	session := source.start(0)
	select {
	case <-session.Done():
	case <-time.After(15 * time.Second):
		t.Fatal("the stream to a legacy target did not end")
	}
	if !errors.Is(session.Err(), relayresume.ErrLegacyPeer) {
		t.Fatalf("stream to a legacy target ended with %v", session.Err())
	}
	rhWait(t, "the legacy latch", 5*time.Second, func() bool { return source.manager.Legacy("route-legacy") })
}

// A raw source in front of a resume-aware target: the first-record rule
// serves it exactly as today, client-first and server-first.
func TestResumeTargetServesRawSources(t *testing.T) {
	setup := newRHSetup(t, 1, rhRoute{id: "route-raw-source"})
	relay := setup.relays[0]
	conn := setup.h.dial(relay, setup.h.sourceCert)
	stream, maxFrame, err := setup.h.openTunnel(context.Background(), conn, "route-raw-source")
	if err != nil {
		t.Fatal(err)
	}
	payload := rhRandom(t, 2*1024*1024)
	echoed, err := exchange(t, stream, payload, maxFrame, 0, nil)
	checkEcho(t, echoed, payload, err)
	_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
	if setup.target.count(relayresume.AcceptLegacy) != 1 {
		t.Fatalf("raw source served as %d legacy streams", setup.target.count(relayresume.AcceptLegacy))
	}

	// Server-first: nothing arrives within the first-record wait, the target
	// goes legacy and its backend speaks first.
	setup.target.serve = serveEcho
	banner := []byte("220 harness ready\r\n")
	setup.target.table = relayresume.NewTargetTable(nil)
	bannerTarget := &rhResumeTarget{t: t, table: setup.target.table, serve: serveEcho}
	setup.reg.handle = func(accepted *rhAccepted) {
		decision := bannerTarget.table.Accept(relayresume.OpenedPath{Stream: accepted.stream, Cancel: accepted.cancel, RelayID: accepted.relayID, MaxFrame: accepted.maxFrame},
			relayresume.AcceptRequest{RouteID: "route-raw-source", SourceKind: "daemon", SourceID: rhSourceNode, RelayID: accepted.relayID,
				Keys: func(string) []byte { return nil }})
		if decision.Kind != relayresume.AcceptLegacy {
			accepted.cancel()
			return
		}
		_ = decision.Stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: banner}}})
		serveEcho(decision.Stream)
		accepted.cancel()
	}
	started := time.Now()
	stream2, _, err := setup.h.openTunnel(context.Background(), conn, "route-raw-source")
	if err != nil {
		t.Fatal(err)
	}
	first, err := stream2.Recv()
	if err != nil || !bytes.Equal(first.GetData().GetData(), banner) {
		t.Fatalf("server-first banner = %v, %v", first, err)
	}
	if wait := time.Since(started); wait > relayresume.FirstRecordTimeout+2*time.Second {
		t.Fatalf("server-first banner took %v", wait)
	}
	_ = stream2.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
}

// Proxy-class routes: the relay no longer sees a half-close, so the session
// reaps a stream whose target finished and that then stays silent.
func TestResumeReapsHalfClosedProxyStreams(t *testing.T) {
	setup := newRHSetup(t, 1, rhRoute{id: "route-proxy", class: "proxy", disableIdleTimeout: true})
	setup.target.serve = func(stream frameStream) {
		// Answer and finish at once, like a server closing after its response.
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("HTTP/1.1 200 OK\r\n\r\n")}}})
		_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
		for {
			if _, err := stream.Recv(); err != nil {
				return
			}
		}
	}
	relay := setup.relays[0]
	session := setup.source.start(300 * time.Millisecond)
	if err := session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("GET / HTTP/1.1\r\n\r\n")}}}); err != nil {
		t.Fatal(err)
	}
	// nginx reads the response and the FIN, then keeps its side open and silent.
	for {
		frame, err := session.Recv()
		if err != nil {
			t.Fatal(err)
		}
		if frame.GetHalfClose() != nil {
			break
		}
	}
	started := time.Now()
	select {
	case <-session.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("a silent half-closed proxy stream was not reaped")
	}
	if !errors.Is(session.Err(), relayresume.ErrHalfCloseIdle) {
		t.Fatalf("half-closed stream ended with %v", session.Err())
	}
	if elapsed := time.Since(started); elapsed < 250*time.Millisecond {
		t.Fatalf("half-closed stream reaped after %v, before its timeout", elapsed)
	}
	rhWait(t, "the relay to release the reaped tunnel", 5*time.Second, func() bool { return relay.activeTunnels() == 0 })
}

// memEnd is one end of an in-memory tunnel stream: what it sends, its peer
// receives. Closing an end with an error is the RPC ending with that status.
type memEnd struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []*relayv1.TunnelFrame
	err    error
	peer   *memEnd
	closed bool
	// stalled: Send blocks until the end fails, like a gRPC Send whose
	// peer stopped reading (flow control).
	stalled bool
}

func memPair() (*memEnd, *memEnd) {
	left, right := &memEnd{}, &memEnd{}
	left.cond, right.cond = sync.NewCond(&left.mu), sync.NewCond(&right.mu)
	left.peer, right.peer = right, left
	return left, right
}

func (e *memEnd) Send(frame *relayv1.TunnelFrame) error {
	e.mu.Lock()
	for e.stalled && e.err == nil {
		e.cond.Wait()
	}
	err := e.err
	e.mu.Unlock()
	if err != nil {
		return err
	}
	// gRPC marshals a copy, and sessions reuse their frame buffers once Send
	// returns: do the same.
	if data := frame.GetData(); data != nil {
		frame = &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), data.GetData()...)}}}
	}
	peer := e.peer
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.err != nil {
		return nil
	}
	peer.queue = append(peer.queue, frame)
	peer.cond.Broadcast()
	return nil
}

func (e *memEnd) Recv() (*relayv1.TunnelFrame, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for len(e.queue) == 0 && e.err == nil {
		e.cond.Wait()
	}
	if len(e.queue) > 0 {
		frame := e.queue[0]
		e.queue = e.queue[1:]
		return frame, nil
	}
	return nil, e.err
}

func (e *memEnd) stall() {
	e.mu.Lock()
	e.stalled = true
	e.mu.Unlock()
}

func (e *memEnd) fail(err error) {
	e.mu.Lock()
	if e.err == nil {
		e.err = err
		e.queue = nil
	}
	e.cond.Broadcast()
	e.mu.Unlock()
}

// The relay's idle timeout keeps its meaning: an idle resumable stream sends
// nothing (no keepalive acks), the relay ends it with "tunnel idle timeout
// reached", and the stream ends instead of resuming. Run on the relay's own
// bridge with a short idle timeout.
func TestResumeRelayIdleTimeoutStaysTerminal(t *testing.T) {
	sourceClient, sourceServer := memPair()
	targetClient, targetServer := memPair()
	bridgeDone := make(chan error, 1)
	go func() {
		err := bridgeWithTimeouts(sourceServer, targetServer, 64*1024, make(chan struct{}), 300*time.Millisecond, 0, nil)
		// Both RPCs end with the bridge's status, as OpenTunnel and AcceptTunnel return it.
		sourceClient.fail(err)
		targetClient.fail(err)
		bridgeDone <- err
	}()
	table := relayresume.NewTargetTable(nil)
	keyID, key := rhRouteKey(t, "route-idle")
	go func() {
		decision := table.Accept(relayresume.OpenedPath{Stream: targetClient, Cancel: func() { targetClient.fail(context.Canceled) }, RelayID: "relay-mem", MaxFrame: 64 * 1024},
			relayresume.AcceptRequest{RouteID: "route-idle", SourceKind: "daemon", SourceID: rhSourceNode, RelayID: "relay-mem",
				Keys: func(id string) []byte {
					if id == keyID {
						return key
					}
					return nil
				}})
		if decision.Kind != relayresume.AcceptHello {
			t.Errorf("target decision = %v", decision.Kind)
			return
		}
		session, err := decision.Establish()
		if err != nil {
			t.Error(err)
			return
		}
		serveEcho(session)
	}()
	var dials atomic.Int64
	manager := relayresume.NewManager(nil)
	session, err := manager.NewSource(relayresume.SourceConfig{
		RouteID: "route-idle",
		Key:     func() (string, []byte, bool) { return keyID, key, true },
		Dial: func(context.Context, relayresume.DialRequest) (relayresume.OpenedPath, error) {
			dials.Add(1)
			return relayresume.OpenedPath{}, errors.New("no other relay")
		},
	}, relayresume.OpenedPath{Stream: sourceClient, Cancel: func() { sourceClient.fail(context.Canceled) }, RelayID: "relay-mem", MaxFrame: 64 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	payload := rhRandom(t, 200*1024)
	if err := session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: append([]byte(nil), payload...)}}}); err != nil {
		t.Fatal(err)
	}
	var echoed []byte
	for len(echoed) < len(payload) {
		frame, err := session.Recv()
		if err != nil {
			t.Fatal(err)
		}
		echoed = append(echoed, frame.GetData().GetData()...)
	}
	if !bytes.Equal(echoed, payload) {
		t.Fatal("echo differs")
	}
	select {
	case err := <-bridgeDone:
		if err == nil || !bytes.Contains([]byte(err.Error()), []byte("idle timeout")) {
			t.Fatalf("bridge ended with %v, want the idle timeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("an idle resumable stream kept the relay bridge busy (keepalive traffic?)")
	}
	select {
	case <-session.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the idle-timed-out stream did not end")
	}
	if session.Err() == nil {
		t.Fatal("the idle-timed-out stream ended cleanly")
	}
	if dials.Load() != 0 {
		t.Fatalf("the idle-timed-out stream tried to resume (%d dials)", dials.Load())
	}
}

// ---------------------------------------------------------------------------
// Throughput: raw vs resumable through a real broker
// ---------------------------------------------------------------------------

// serveSink counts what arrives and answers the FIN.
func serveSink(stream frameStream) {
	for {
		frame, err := stream.Recv()
		if err != nil {
			return
		}
		if frame.GetHalfClose() != nil {
			_ = stream.Send(frame)
		} else if frame.GetData() == nil {
			return
		}
	}
}

func rawSinkTarget(accepted *rhAccepted) {
	defer accepted.cancel()
	serveSink(accepted.stream)
}

// pushThrough sends total bytes in chunk-sized frames (a fresh buffer per
// frame, as the daemons' bridges read), then FIN, and waits for the peer's
// FIN. Like the bridges, it receives while it sends.
func pushThrough(stream frameStream, chunk []byte, total int) error {
	received := make(chan error, 1)
	go func() {
		for {
			frame, err := stream.Recv()
			if err != nil {
				received <- err
				return
			}
			if frame.GetHalfClose() != nil {
				received <- nil
				return
			}
		}
	}()
	for sent := 0; sent < total; sent += len(chunk) {
		data := make([]byte, min(len(chunk), total-sent))
		copy(data, chunk)
		if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}); err != nil {
			return fmt.Errorf("send: %w (stream ended: %v)", err, <-received)
		}
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}); err != nil {
		return fmt.Errorf("send: %w (stream ended: %v)", err, <-received)
	}
	return <-received
}

type rhThroughput struct {
	target *rhResumeTarget
	h      *rhHarness
	relay  *rhRelay
	conn   *grpc.ClientConn
	source *rhSource
	chunk  []byte
}

func newRHThroughput(t testing.TB) *rhThroughput {
	h := newRHHarness(t)
	h.addRoute(rhRoute{id: "route-raw"})
	h.addRoute(rhRoute{id: "route-resume"})
	relay := h.startRelay("relay-a")
	target := newRHResumeTarget(t)
	target.serve = serveSink
	reg := h.startTarget(func(accepted *rhAccepted) {
		if accepted.incoming.GetRoute().GetRouteId() == "route-raw" {
			rawSinkTarget(accepted)
			return
		}
		target.handle(accepted)
	}, relay)
	reg.waitRegistered(relay)
	chunk := make([]byte, 32*1024)
	_, _ = rand.Read(chunk)
	return &rhThroughput{target: target, h: h, relay: relay, conn: h.dial(relay, h.sourceCert), source: h.newSource("route-resume", relay), chunk: chunk}
}

func (r *rhThroughput) raw(total int) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, _, err := r.h.openTunnel(ctx, r.conn, "route-raw")
	if err != nil {
		return err
	}
	if err := pushThrough(stream, r.chunk, total); err != nil {
		return err
	}
	// The relay already ended the tunnel after both FINs; Close only matters to a lingering one.
	_ = stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
	return nil
}

func (r *rhThroughput) resumable(total int) error {
	first, err := r.source.dial(context.Background(), relayresume.DialRequest{})
	if err != nil {
		return err
	}
	session, err := r.source.manager.NewSource(r.source.config(0), first)
	if err != nil {
		return err
	}
	// As the docker and nginx bridges read for a session: a frame (read plus record header) stays within 32 KiB.
	if err := pushThrough(session, r.chunk[:relayresume.ReadChunk(len(r.chunk))], total); err != nil {
		return err
	}
	_ = session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Close{Close: &relayv1.TunnelClose{}}})
	return session.Err()
}

const rhBenchBytes = 64 * 1024 * 1024

func BenchmarkRelayStreamThroughput(b *testing.B) {
	for _, mode := range []string{"raw", "resumable"} {
		b.Run(mode, func(b *testing.B) {
			setup := newRHThroughput(b)
			run := setup.raw
			if mode == "resumable" {
				run = setup.resumable
			}
			b.SetBytes(rhBenchBytes)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if err := run(rhBenchBytes); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// The normal-path gate (design 4.1/T9): one stream through a real broker on
// loopback, resumable within 2 % of raw. Alternating rounds, medians. Opt-in
// (RELAY_RESUME_BENCH_GATE=1): timing on a shared CI box is too noisy for
// the light suite.
func TestResumeThroughputGate(t *testing.T) {
	if os.Getenv("RELAY_RESUME_BENCH_GATE") == "" {
		t.Skip("set RELAY_RESUME_BENCH_GATE=1 to run the throughput gate")
	}
	setup := newRHThroughput(t)
	cpuNow := func() time.Duration {
		var usage syscall.Rusage
		_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
		return time.Duration(usage.Utime.Nano() + usage.Stime.Nano())
	}
	// measure returns MiB/s and the CPU time (source, relay and target together) per MiB.
	measure := func(name string, run func(int) error) (float64, float64) {
		started, cpu := time.Now(), cpuNow()
		if err := run(rhBenchBytes); err != nil {
			t.Fatalf("%s: %v (target: legacy %d hello %d resumed %d refused %d backends %d)", name, err,
				setup.target.count(relayresume.AcceptLegacy), setup.target.count(relayresume.AcceptHello),
				setup.target.count(relayresume.AcceptResumed), setup.target.count(relayresume.AcceptRefused), setup.target.backends.Load())
		}
		mib := float64(rhBenchBytes) / (1 << 20)
		return mib / time.Since(started).Seconds(), float64(cpuNow()-cpu) / float64(time.Microsecond) / mib
	}
	// Warm up both paths (connections, buffers).
	measure("resumable", setup.resumable)
	measure("raw", setup.raw)
	// Paired rounds in alternating order: each ratio compares two runs a few
	// hundred ms apart, so drift in the box's load cancels out.
	rounds := 21
	ratios := make([]float64, 0, rounds)
	cpuRatios := make([]float64, 0, rounds)
	var raw, resumable []float64
	for round := 0; round < rounds; round++ {
		var r, s, rc, sc float64
		if round%2 == 0 {
			r, rc = measure("raw", setup.raw)
			s, sc = measure("resumable", setup.resumable)
		} else {
			s, sc = measure("resumable", setup.resumable)
			r, rc = measure("raw", setup.raw)
		}
		raw, resumable = append(raw, r), append(resumable, s)
		ratios = append(ratios, s/r)
		cpuRatios = append(cpuRatios, sc/rc)
	}
	slices.Sort(ratios)
	slices.Sort(cpuRatios)
	slices.Sort(raw)
	slices.Sort(resumable)
	delta := (ratios[len(ratios)/2] - 1) * 100
	t.Logf("median raw %.1f MiB/s, median resumable %.1f MiB/s, median paired ratio %+.2f %% (ratios %.3f .. %.3f); CPU per byte %+.2f %%",
		raw[len(raw)/2], resumable[len(resumable)/2], delta, ratios[0], ratios[len(ratios)-1], (cpuRatios[len(cpuRatios)/2]-1)*100)
	if delta < -2 {
		t.Fatalf("resumable streams are %.2f %% slower than raw ones (gate: 2 %%)", -delta)
	}
}

// A local side that is slow to read (the bridge blocked writing to it) must
// not stall the other direction: raw relay streams keep the directions
// independent, and acks for what this side sends still have to be read.
func TestResumeWriterProgressesWhileNothingReads(t *testing.T) {
	setup := newRHSetup(t, 1, rhRoute{id: "route-writer"})
	setup.target.serve = func(stream frameStream) {
		// Answer at once with more than a window's worth while taking the upload.
		answer := rhRandom(t, 2*1024*1024)
		go func() {
			for offset := 0; offset < len(answer); offset += 32 * 1024 {
				data := append([]byte(nil), answer[offset:offset+32*1024]...)
				if stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}) != nil {
					return
				}
			}
		}()
		serveSink(stream)
	}
	session := setup.source.start(0)
	sent := make(chan error, 1)
	go func() {
		for offset := 0; offset < 8*1024*1024; offset += 32 * 1024 {
			data := make([]byte, 32*1024)
			if err := session.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}); err != nil {
				sent <- err
				return
			}
		}
		sent <- nil
	}()
	select {
	case err := <-sent:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the upload stalled while the local side was not reading")
	}
	// Now read the answer and finish.
	got := 0
	for got < 2*1024*1024 {
		frame, err := session.Recv()
		if err != nil {
			t.Fatal(err)
		}
		got += len(frame.GetData().GetData())
	}
	session.Cancel()
}

// A drain notice or a lane GOAWAY that arrives while a stream is still in its
// handshake (HELLO sent, HELLO_ACK not back: a slow backend dial) is kept and
// acted on once the stream is open, instead of being dropped.
func TestResumeTriggerDuringHandshakeIsKept(t *testing.T) {
	for _, trigger := range []string{"drain", "goaway"} {
		t.Run(trigger, func(t *testing.T) {
			setup := newRHSetup(t, 2, rhRoute{id: "route-early-" + trigger})
			a, b := setup.relays[0], setup.relays[1]
			setup.target.beforeEstablish = func() { time.Sleep(300 * time.Millisecond) }
			session := setup.source.start(0)
			if session.State() != relayresume.StateHandshake {
				t.Fatalf("stream state %v, want the handshake", session.State())
			}
			if trigger == "drain" {
				a.currentBroker().SetDraining(true)
				setup.source.setDraining(a.id, true)
				setup.source.manager.DrainRelay(a.id, time.Time{})
			} else {
				setup.source.manager.RelayLost(a.id)
			}
			payload := rhRandom(t, 1024*1024)
			echoed, err := exchange(t, session, payload, 32*1024, len(payload)/2, func() {
				rhWaitFor(t, "the stream to leave relay-a", 10*time.Second, func() bool { return session.RelayID() == b.id })
			})
			checkEcho(t, echoed, payload, err)
			finish(t, session)
		})
	}
}

// memRelayPath is one path through the relay's own bridge over in-memory
// streams: the source's and the target's client ends.
type memRelayPath struct {
	relayID        string
	source, target *memEnd
}

func newMemRelayPath(relayID string) *memRelayPath {
	sourceClient, sourceServer := memPair()
	targetClient, targetServer := memPair()
	go func() {
		err := bridgeWithTimeouts(sourceServer, targetServer, 64*1024, make(chan struct{}), 0, 0, nil)
		if err == nil {
			err = io.EOF
		}
		sourceClient.fail(err)
		targetClient.fail(err)
	}()
	return &memRelayPath{relayID: relayID, source: sourceClient, target: targetClient}
}

// The target is still sending on a path the relay no longer reads (a
// tunnel the relay dropped, its gRPC Send stuck in flow control) when the
// source resumes on another relay: the RESUME must still be answered and the
// stuck path given up, not wait behind that Send forever.
func TestResumeAnsweredWhileTheOldPathSendIsStuck(t *testing.T) {
	keyID, key := rhRouteKey(t, "route-stuck")
	table := relayresume.NewTargetTable(nil)
	accept := func(path *memRelayPath) {
		go func() {
			decision := table.Accept(relayresume.OpenedPath{Stream: path.target, Cancel: func() { path.target.fail(context.Canceled) }, RelayID: path.relayID, MaxFrame: 64 * 1024},
				relayresume.AcceptRequest{RouteID: "route-stuck", SourceKind: "daemon", SourceID: rhSourceNode, RelayID: path.relayID,
					Keys: func(id string) []byte {
						if id == keyID {
							return key
						}
						return nil
					}})
			switch decision.Kind {
			case relayresume.AcceptHello:
				session, err := decision.Establish()
				if err == nil {
					serveEcho(session)
				}
			case relayresume.AcceptResumed, relayresume.AcceptRefused:
				<-decision.PathDone
			}
		}()
	}
	first := newMemRelayPath("relay-a")
	accept(first)
	manager := relayresume.NewManager(nil)
	session, err := manager.NewSource(relayresume.SourceConfig{
		RouteID: "route-stuck",
		Key:     func() (string, []byte, bool) { return keyID, key, true },
		Dial: func(context.Context, relayresume.DialRequest) (relayresume.OpenedPath, error) {
			path := newMemRelayPath("relay-b")
			accept(path)
			return relayresume.OpenedPath{Stream: path.source, Cancel: func() { path.source.fail(context.Canceled) }, RelayID: path.relayID, MaxFrame: 64 * 1024}, nil
		},
	}, relayresume.OpenedPath{Stream: first.source, Cancel: func() { first.source.fail(context.Canceled) }, RelayID: first.relayID, MaxFrame: 64 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	// Cut path A only once the stream is open: before HELLO_ACK a path failure is a cut by design.
	rhWait(t, "the handshake", 10*time.Second, func() bool { return session.State() == relayresume.StateOpen })
	payload := rhRandom(t, 4*1024*1024)
	echoed, err := exchange(t, session, payload, 32*1024, len(payload)/4, func() {
		// The relay stops reading what the target sends on path A, then the
		// source loses path A and resumes elsewhere.
		first.target.stall()
		time.Sleep(50 * time.Millisecond)
		first.source.fail(status.Error(codes.Unavailable, "relay connection lost"))
		rhWaitFor(t, "the stream to resume on relay-b", 10*time.Second, func() bool { return session.RelayID() == "relay-b" })
	})
	checkEcho(t, echoed, payload, err)
	finish(t, session)
}
