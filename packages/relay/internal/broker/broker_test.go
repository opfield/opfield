package broker

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/admission"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

type frameReceiver struct {
	frames []*relayv1.TunnelFrame
}

func (r *frameReceiver) Recv() (*relayv1.TunnelFrame, error) {
	if len(r.frames) == 0 {
		return nil, io.EOF
	}
	frame := r.frames[0]
	r.frames = r.frames[1:]
	return frame, nil
}

type frameSender struct {
	frames []*relayv1.TunnelFrame
}

type errorFrameStream struct {
	err error
}

func (s *errorFrameStream) Recv() (*relayv1.TunnelFrame, error) { return nil, s.err }
func (s *errorFrameStream) Send(*relayv1.TunnelFrame) error     { return nil }

type halfCloseFrameStream struct {
	received bool
}

func (s *halfCloseFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	if s.received {
		return nil, io.EOF
	}
	s.received = true
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}, nil
}

func (s *halfCloseFrameStream) Send(*relayv1.TunnelFrame) error { return nil }

type blockingFrameStream struct {
	mu     sync.Mutex
	frames []*relayv1.TunnelFrame
	stop   chan struct{}
}

type channelFrameStream struct {
	received chan *relayv1.TunnelFrame
}

func (s *channelFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	frame, ok := <-s.received
	if !ok {
		return nil, io.EOF
	}
	return frame, nil
}

func (s *channelFrameStream) Send(*relayv1.TunnelFrame) error { return nil }

func (s *blockingFrameStream) Recv() (*relayv1.TunnelFrame, error) {
	<-s.stop
	return nil, io.EOF
}

func (s *blockingFrameStream) Send(frame *relayv1.TunnelFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.frames = append(s.frames, frame)
	return nil
}

func (s *frameSender) Send(frame *relayv1.TunnelFrame) error {
	s.frames = append(s.frames, frame)
	return nil
}

type acceptStream struct {
	relayv1.TunnelBroker_AcceptTunnelServer
	ctx   context.Context
	first *relayv1.TunnelFrame
}

type openStream struct {
	relayv1.TunnelBroker_OpenTunnelServer
	ctx   context.Context
	first *relayv1.TunnelFrame
}

func (s *openStream) Context() context.Context { return s.ctx }
func (s *openStream) Recv() (*relayv1.TunnelFrame, error) {
	if s.first == nil {
		return nil, io.EOF
	}
	frame := s.first
	s.first = nil
	return frame, nil
}
func (s *openStream) Send(*relayv1.TunnelFrame) error { return nil }
func (s *openStream) SetHeader(metadata.MD) error     { return nil }
func (s *openStream) SendHeader(metadata.MD) error    { return nil }
func (s *openStream) SetTrailer(metadata.MD)          {}
func (s *openStream) SendMsg(any) error               { return nil }
func (s *openStream) RecvMsg(any) error               { return nil }

func (s *acceptStream) Context() context.Context { return s.ctx }
func (s *acceptStream) Recv() (*relayv1.TunnelFrame, error) {
	frame := s.first
	s.first = nil
	return frame, nil
}
func (s *acceptStream) Send(*relayv1.TunnelFrame) error { return nil }
func (s *acceptStream) SetHeader(metadata.MD) error     { return nil }
func (s *acceptStream) SendHeader(metadata.MD) error    { return nil }
func (s *acceptStream) SetTrailer(metadata.MD)          {}
func (s *acceptStream) SendMsg(any) error               { return nil }
func (s *acceptStream) RecvMsg(any) error               { return nil }

func TestAcceptTokenIsSingleUse(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", SubjectId: "node-target", CertificateSha256: "sha256:target"}
	pending := &pendingTunnel{endpoint: endpoint, session: &activeTunnel{stop: make(chan struct{})}, accepted: make(chan acceptedConnection, 1)}
	b.pending["token-1"] = pending
	ctx := authenticatedContext("node-target", []byte("target"))
	// Match the synthetic certificate fingerprint used in the pending policy.
	identity, _ := grpcpeer.FromContext(ctx)
	fingerprint := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	endpoint.CertificateSha256 = fmt.Sprintf("sha256:%x", sha256.Sum256(fingerprint.Raw))
	first := &acceptStream{ctx: ctx, first: acceptFrame("token-1")}
	done := make(chan error, 1)
	go func() { done <- b.AcceptTunnel(first) }()
	connection := <-pending.accepted
	connection.result <- nil
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	second := &acceptStream{ctx: ctx, first: acceptFrame("token-1")}
	if code := status.Code(b.AcceptTunnel(second)); code != codes.NotFound {
		t.Fatalf("replayed token status = %v", code)
	}
}

func TestReconcileClosesRevokedActiveSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	session := &activeTunnel{routeID: "route-1", routeGeneration: 1, endpointID: "endpoint-1", endpointGeneration: 1, stop: make(chan struct{})}
	b.active["session-1"] = session
	b.Reconcile(&policy.Snapshot{}, &policy.Snapshot{Routes: map[string]*relayv1.RoutePolicy{}, Endpoints: map[string]*relayv1.EndpointPolicy{}})
	select {
	case <-session.stop:
	default:
		t.Fatal("revoked session was not closed")
	}
	if _, exists := b.active["session-1"]; !exists {
		t.Fatal("revoked session was removed before its bridge exited")
	}
}

func TestReconcileClosesLegacyGenerationZeroSessionsAfterAssignmentActivation(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	registration := &endpointRegistration{
		endpointID:           "endpoint-1",
		generation:           1,
		assignmentGeneration: 0,
		stop:                 make(chan struct{}),
	}
	tunnel := &activeTunnel{
		routeID:              "route-1",
		routeGeneration:      1,
		endpointID:           "endpoint-1",
		endpointGeneration:   1,
		assignmentGeneration: 0,
		stop:                 make(chan struct{}),
	}
	b.endpoints["endpoint-1"] = registration
	b.active["legacy"] = tunnel

	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", Generation: 1, AssignmentGeneration: 1}
	route := &relayv1.RoutePolicy{
		RouteId:              "route-1",
		Generation:           1,
		TargetEndpointId:     endpoint.EndpointId,
		AssignmentGeneration: 1,
	}
	b.Reconcile(nil, &policy.Snapshot{
		Endpoints:           map[string]*relayv1.EndpointPolicy{endpoint.EndpointId: endpoint},
		Routes:              map[string]*relayv1.RoutePolicy{route.RouteId: route},
		EndpointAssignments: map[string]*relayv1.EndpointPolicy{"endpoint-1:1": endpoint},
		RouteAssignments:    map[string]*relayv1.RoutePolicy{"route-1:1": route},
	})

	select {
	case <-registration.stop:
	default:
		t.Fatal("legacy endpoint registration remained active after assignment generation activation")
	}
	select {
	case <-tunnel.stop:
	default:
		t.Fatal("legacy tunnel remained active after assignment generation activation")
	}
	if _, exists := b.endpoints["endpoint-1"]; exists {
		t.Fatal("legacy endpoint registration remained indexed")
	}
}

func TestEndpointDisconnectClosesActiveSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	session := &activeTunnel{endpointID: "endpoint-1", stop: make(chan struct{})}
	b.active["session-1"] = session
	b.mu.Lock()
	b.closeEndpointSessionsLocked(codes.Unavailable, "target endpoint is dormant", "endpoint-1")
	b.mu.Unlock()
	select {
	case <-session.stop:
	default:
		t.Fatal("endpoint disconnect did not close its session")
	}
}

func TestDrainRejectsNewTunnelWithoutClosingActiveSession(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	active := &activeTunnel{stop: make(chan struct{})}
	b.active["existing"] = active
	b.SetDraining(true)
	if !b.RuntimeSnapshot().Draining {
		t.Fatal("drain state was not reported")
	}
	select {
	case <-active.stop:
		t.Fatal("drain closed an established session")
	default:
	}
	// New tunnels: see TestDrainRefusesWorkloadTunnelsAndKeepsLocalServices.
}

func TestForceDisconnectRequiresDrainAndClosesActiveSessions(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	active := &activeTunnel{stop: make(chan struct{})}
	b.active["existing"] = active
	if disconnected := b.ForceDisconnect(); disconnected != 0 {
		t.Fatalf("force disconnect outside drain = %d", disconnected)
	}
	select {
	case <-active.stop:
		t.Fatal("force disconnect outside drain closed a session")
	default:
	}
	b.SetDraining(true)
	if disconnected := b.ForceDisconnect(); disconnected != 1 {
		t.Fatalf("force disconnect count = %d", disconnected)
	}
	select {
	case <-active.stop:
	default:
		t.Fatal("force disconnect did not close an active session")
	}
}

func TestRuntimeSnapshotGroupsActiveTunnelsByAssignmentGeneration(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	b.active["one"] = &activeTunnel{endpointID: "endpoint-b", assignmentGeneration: 2, stop: make(chan struct{})}
	b.active["two"] = &activeTunnel{endpointID: "endpoint-a", assignmentGeneration: 3, stop: make(chan struct{})}
	b.active["three"] = &activeTunnel{endpointID: "endpoint-a", assignmentGeneration: 3, stop: make(chan struct{})}

	counts := b.RuntimeSnapshot().AssignmentTunnels
	if len(counts) != 2 {
		t.Fatalf("assignment tunnel groups = %d", len(counts))
	}
	if counts[0].EndpointID != "endpoint-a" || counts[0].AssignmentGeneration != 3 || counts[0].ActiveTunnels != 2 {
		t.Fatalf("first assignment tunnel group = %+v", counts[0])
	}
	if counts[1].EndpointID != "endpoint-b" || counts[1].AssignmentGeneration != 2 || counts[1].ActiveTunnels != 1 {
		t.Fatalf("second assignment tunnel group = %+v", counts[1])
	}
}

func TestPumpPreservesHalfClose(t *testing.T) {
	source := &frameReceiver{frames: []*relayv1.TunnelFrame{{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}}}
	destination := &frameSender{}
	terminal, err := pump(destination, source, DefaultMaxFrameBytes, make(chan struct{}, 1), nil)
	if err != nil || terminal {
		t.Fatalf("half-close result terminal=%v err=%v", terminal, err)
	}
	if len(destination.frames) != 1 || destination.frames[0].GetHalfClose() == nil {
		t.Fatal("half-close was not forwarded")
	}
}

func TestPumpRecordsOnlyForwardedDataBytes(t *testing.T) {
	source := &frameReceiver{frames: []*relayv1.TunnelFrame{{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("payload")}}}}}
	destination := &frameSender{}
	var transferred uint64
	terminal, err := pump(destination, source, DefaultMaxFrameBytes, make(chan struct{}, 1), func(bytes uint64) {
		transferred += bytes
	})
	if err != nil || terminal {
		t.Fatalf("data pump result terminal=%v err=%v", terminal, err)
	}
	if transferred != uint64(len("payload")) {
		t.Fatalf("recorded bytes = %d", transferred)
	}
}

func TestConnectionStreamReusesReadBufferAndCopiesEachFrame(t *testing.T) {
	local, remote := net.Pipe()
	defer local.Close()
	defer remote.Close()
	stream := &connectionTunnelStream{connection: local, maxFrame: DefaultMaxFrameBytes}
	payloads := []string{"first frame", "second"}
	go func() {
		for _, payload := range payloads {
			_, _ = remote.Write([]byte(payload))
		}
	}()
	var frames []*relayv1.TunnelFrame
	var buffers []*byte
	for range payloads {
		frame, err := stream.Recv()
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
		buffers = append(buffers, &stream.readBuffer[0])
	}
	if buffers[0] != buffers[1] {
		t.Fatal("every read allocated a new full-size frame buffer")
	}
	for index, payload := range payloads {
		data := frames[index].GetData().GetData()
		if string(data) != payload {
			t.Fatalf("frame %d = %q, want %q", index, data, payload)
		}
		if cap(data) != len(payload) {
			t.Fatalf("frame %d capacity = %d, want a copy sized to the read (%d)", index, cap(data), len(payload))
		}
	}
}

func TestRouteMetricsSummarizeLatencyAndCompletion(t *testing.T) {
	metrics := &routeMetrics{}
	metrics.active.Store(1)
	for _, latency := range []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond, 40 * time.Millisecond} {
		metrics.recordSetup(latency)
	}
	metrics.recordCompletion(250*time.Millisecond, status.Error(codes.Unavailable, "failed"))
	if metrics.setupP95Micros() != 40_000 {
		t.Fatalf("setup p95 = %d", metrics.setupP95Micros())
	}
	if metrics.active.Load() != 0 || metrics.completed.Load() != 1 || metrics.failed.Load() != 1 {
		t.Fatalf("unexpected completion counters active=%d completed=%d failed=%d", metrics.active.Load(), metrics.completed.Load(), metrics.failed.Load())
	}
}

func TestSessionCapacityUsesRouteAndEndpointPolicyLimits(t *testing.T) {
	b := &Broker{activeByRoute: map[string]uint64{"route-1": 2}, activeByTarget: map[string]uint64{"endpoint-1": 3}}
	route := &relayv1.RoutePolicy{RouteId: "route-1", MaxConcurrentSessions: 2}
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", MaxConcurrentSessions: 4}
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 4, 4)); code != codes.ResourceExhausted {
		t.Fatalf("route capacity status = %v", code)
	}

	route.MaxConcurrentSessions = 3
	endpoint.MaxConcurrentSessions = 3
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 4, 4)); code != codes.ResourceExhausted {
		t.Fatalf("endpoint capacity status = %v", code)
	}

	route.MaxConcurrentSessions = 0
	endpoint.MaxConcurrentSessions = 0
	if err := b.sessionCapacityErrorLocked(route, endpoint, 0, 0); err != nil {
		t.Fatalf("zero capacity limits should be unlimited: %v", err)
	}

	route.MaxConcurrentSessions = 5
	endpoint.MaxConcurrentSessions = 5
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 2, 5)); code != codes.ResourceExhausted {
		t.Fatalf("signed grant capacity status = %v", code)
	}

	route.MaxConcurrentSessions = 0
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 2, 5)); code != codes.ResourceExhausted {
		t.Fatalf("grant-only capacity status = %v", code)
	}
	route.MaxConcurrentSessions = 2
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 0, 5)); code != codes.ResourceExhausted {
		t.Fatalf("policy-only capacity status = %v", code)
	}

	route.MaxConcurrentSessions = 5
	endpoint.MaxConcurrentSessions = 0
	b.activeByRoute[route.RouteId] = 0
	if code := status.Code(b.sessionCapacityErrorLocked(route, endpoint, 5, 2)); code != codes.ResourceExhausted {
		t.Fatalf("endpoint grant-only capacity status = %v", code)
	}
}

func TestSessionCapacityCountersAreReleased(t *testing.T) {
	b := &Broker{proxyByRoute: map[string]uint64{}, registryByRoute: map[string]uint64{}, activeByRoute: map[string]uint64{}, activeByTarget: map[string]uint64{}}
	tunnel := &activeTunnel{routeID: "route-1", endpointID: "endpoint-1", trafficClass: admission.TrafficClassProxy}
	b.trackSessionLocked(tunnel, 1)
	b.trackSessionLocked(tunnel, -1)
	if len(b.activeByRoute) != 0 || len(b.activeByTarget) != 0 || len(b.proxyByRoute) != 0 || b.activeProxy != 0 {
		t.Fatalf("released session retained capacity: routes=%v endpoints=%v proxy=%v active=%d", b.activeByRoute, b.activeByTarget, b.proxyByRoute, b.activeProxy)
	}
}

func TestRegistrySessionCapacityCountersAreIndependent(t *testing.T) {
	b := &Broker{proxyByRoute: map[string]uint64{}, registryByRoute: map[string]uint64{}, activeByRoute: map[string]uint64{}, activeByTarget: map[string]uint64{}}
	tunnel := &activeTunnel{routeID: "registry-route", endpointID: "registry-endpoint", trafficClass: admission.TrafficClassRegistry}
	b.trackSessionLocked(tunnel, 1)
	if b.activeRegistry != 1 || b.registryByRoute["registry-route"] != 1 || b.activeProxy != 0 || b.activeDatabase != 0 {
		t.Fatalf("registry session was not tracked independently: %+v", b.usageLocked())
	}
	b.trackSessionLocked(tunnel, -1)
	if b.activeRegistry != 0 || len(b.registryByRoute) != 0 {
		t.Fatalf("registry capacity was not released: %+v", b.usageLocked())
	}
}

func TestBridgeClosesIdleTunnel(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	err := bridgeWithIdleTimeout(left, right, DefaultMaxFrameBytes, make(chan struct{}), 5*time.Millisecond, nil)
	close(left.stop)
	close(right.stop)
	if status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("idle bridge status = %v", status.Code(err))
	}
	left.mu.Lock()
	leftFrames := len(left.frames)
	left.mu.Unlock()
	right.mu.Lock()
	rightFrames := len(right.frames)
	right.mu.Unlock()
	if leftFrames != 0 || rightFrames != 0 {
		t.Fatalf("idle timeout used a concurrent stream writer left=%d right=%d", leftFrames, rightFrames)
	}
}

func TestBridgeWithoutIdleTimeoutWaitsForPolicyOrTCPClosure(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	revoked := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- bridgeWithIdleTimeout(left, right, DefaultMaxFrameBytes, revoked, 0, nil)
	}()
	select {
	case err := <-done:
		t.Fatalf("idle-disabled bridge exited without close or revocation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(revoked)
	if code := status.Code(<-done); code != codes.PermissionDenied {
		t.Fatalf("idle-disabled bridge revocation status = %v", code)
	}
	close(left.stop)
	close(right.stop)
}

func TestBridgeRevocationDoesNotAddConcurrentStreamWriters(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	revoked := make(chan struct{})
	close(revoked)
	err := bridgeWithIdleTimeout(left, right, DefaultMaxFrameBytes, revoked, time.Minute, nil)
	close(left.stop)
	close(right.stop)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("revoked bridge status = %v", status.Code(err))
	}
	left.mu.Lock()
	leftFrames := len(left.frames)
	left.mu.Unlock()
	right.mu.Lock()
	rightFrames := len(right.frames)
	right.mu.Unlock()
	if leftFrames != 0 || rightFrames != 0 {
		t.Fatalf("revocation used a concurrent stream writer left=%d right=%d", leftFrames, rightFrames)
	}
}

func TestBridgeTreatsCanceledStreamAsTerminal(t *testing.T) {
	canceled := &errorFrameStream{err: status.Error(codes.Canceled, "source disconnected")}
	blocked := &blockingFrameStream{stop: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- bridgeWithIdleTimeout(canceled, blocked, DefaultMaxFrameBytes, make(chan struct{}), 0, nil)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("canceled bridge returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled stream leaked the opposite bridge direction")
	}
	close(blocked.stop)
}

func TestBridgeReapsHalfClosedProxyTunnelAfterGracePeriod(t *testing.T) {
	halfClosed := &halfCloseFrameStream{}
	blocked := &blockingFrameStream{stop: make(chan struct{})}
	err := bridgeWithTimeouts(
		blocked,
		halfClosed,
		DefaultMaxFrameBytes,
		make(chan struct{}),
		0,
		5*time.Millisecond,
		nil,
	)
	close(blocked.stop)
	if status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("half-closed bridge status = %v", status.Code(err))
	}
}

func TestBridgeDoesNotReapWhileWaitingForResponseAfterSourceHalfClose(t *testing.T) {
	halfClosed := &halfCloseFrameStream{}
	blocked := &blockingFrameStream{stop: make(chan struct{})}
	revoked := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- bridgeWithTimeouts(halfClosed, blocked, DefaultMaxFrameBytes, revoked, 0, 5*time.Millisecond, nil)
	}()

	select {
	case err := <-done:
		t.Fatalf("source half-close incorrectly started orphan reaper: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(revoked)
	if code := status.Code(<-done); code != codes.PermissionDenied {
		t.Fatalf("bridge revocation status = %v", code)
	}
	close(blocked.stop)
}

func TestBridgeDoesNotStartHalfCloseGraceBeforeHalfClose(t *testing.T) {
	left := &blockingFrameStream{stop: make(chan struct{})}
	right := &blockingFrameStream{stop: make(chan struct{})}
	revoked := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- bridgeWithTimeouts(left, right, DefaultMaxFrameBytes, revoked, 0, 5*time.Millisecond, nil)
	}()

	select {
	case err := <-done:
		t.Fatalf("bridge exited before a half-close: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(revoked)
	if code := status.Code(<-done); code != codes.PermissionDenied {
		t.Fatalf("bridge revocation status = %v", code)
	}
	close(left.stop)
	close(right.stop)
}

func TestBridgeHalfCloseGraceResetsWhileRemainingDirectionIsActive(t *testing.T) {
	left := &channelFrameStream{received: make(chan *relayv1.TunnelFrame, 8)}
	right := &channelFrameStream{received: make(chan *relayv1.TunnelFrame, 1)}
	done := make(chan error, 1)
	go func() {
		done <- bridgeWithTimeouts(left, right, DefaultMaxFrameBytes, make(chan struct{}), 0, 100*time.Millisecond, nil)
	}()

	right.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}}
	for range 15 {
		time.Sleep(10 * time.Millisecond)
		left.received <- &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: []byte("request")}}}
		select {
		case err := <-done:
			t.Fatalf("active half-closed bridge exited early: %v", err)
		default:
		}
	}

	select {
	case err := <-done:
		if status.Code(err) != codes.DeadlineExceeded {
			t.Fatalf("inactive half-closed bridge status = %v", status.Code(err))
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("half-closed bridge was not reaped after remaining traffic stopped")
	}
	close(left.received)
	close(right.received)
}

func acceptFrame(token string) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Accept{Accept: &relayv1.AcceptTunnel{AcceptToken: token}}}
}

func authenticatedContext(commonName string, raw []byte) context.Context {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: commonName}, SerialNumber: big.NewInt(1), Raw: raw}
	return grpcpeer.NewContext(context.Background(), &grpcpeer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}, VerifiedChains: [][]*x509.Certificate{{certificate}}}}})
}

// The opener can give up (timeout, cancel, revocation) right after the target
// handed over its accept stream. The accept side must end then, not wait for
// a result nobody will send.
func TestAcceptTunnelEndsWhenOpenerLeavesBeforeBridging(t *testing.T) {
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	b := New(store)
	endpoint := &relayv1.EndpointPolicy{EndpointId: "endpoint-1", SubjectId: "node-target"}
	session := &activeTunnel{stop: make(chan struct{})}
	pending := &pendingTunnel{endpoint: endpoint, session: session, accepted: make(chan acceptedConnection, 1)}
	b.pending["token-1"] = pending
	ctx := authenticatedContext("node-target", []byte("target"))
	identity, _ := grpcpeer.FromContext(ctx)
	certificate := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	endpoint.CertificateSha256 = fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
	done := make(chan error, 1)
	go func() { done <- b.AcceptTunnel(&acceptStream{ctx: ctx, first: acceptFrame("token-1")}) }()
	<-pending.accepted
	session.close()
	select {
	case err := <-done:
		if code := status.Code(err); code != codes.Aborted {
			t.Fatalf("accept ended with %v, want Aborted", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("accept stream stayed open after the opener left")
	}
}

func TestIncomingTunnelNamesTheAdmittedRoute(t *testing.T) {
	deadline := time.Unix(1_700_000_000, 0)
	session := &activeTunnel{routeID: "route-1", routeGeneration: 3, sourceKind: "daemon", sourceID: "node-source", assignmentGeneration: 7}
	incoming := incomingTunnel("session-1", "token-1", deadline, session)
	if incoming.SessionId != "session-1" || incoming.AcceptToken != "token-1" || incoming.AcceptExpiresAtUnix != deadline.Unix() {
		t.Fatalf("incoming tunnel = %+v", incoming)
	}
	route := incoming.GetRoute()
	if route.GetRouteId() != "route-1" || route.GetRouteGeneration() != 3 || route.GetSourceKind() != "daemon" ||
		route.GetSourceId() != "node-source" || route.GetAssignmentGeneration() != 7 {
		t.Fatalf("incoming route = %+v", route)
	}
}
