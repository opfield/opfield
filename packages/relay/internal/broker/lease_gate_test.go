package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// fakeLeaseGate admits (policy, subject) pairs from a table.
type fakeLeaseGate struct {
	mu        sync.Mutex
	decisions map[string]LeaseAdmission
}

func (g *fakeLeaseGate) set(policyID, subjectID string, admission LeaseAdmission) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.decisions[policyID+"/"+subjectID] = admission
}

func (g *fakeLeaseGate) Admit(policyID, subjectID string) LeaseAdmission {
	g.mu.Lock()
	defer g.mu.Unlock()
	if admission, ok := g.decisions[policyID+"/"+subjectID]; ok {
		return admission
	}
	return LeaseAdmission{LeaseMode: true, Reason: "not the holder"}
}

func (g *fakeLeaseGate) ApplyPolicy(*policy.Snapshot) {}
func (g *fakeLeaseGate) Coordinate(relayv1.TunnelBroker_CoordinateServer) error {
	return nil
}
func (g *fakeLeaseGate) WatchLeaseGates(*relayv1.LeaseGateWatchRequest, relayv1.TunnelBroker_WatchLeaseGatesServer) error {
	return nil
}

type registerStream struct {
	relayv1.TunnelBroker_RegisterEndpointServer
	ctx   context.Context
	first *relayv1.EndpointControl
	sent  chan *relayv1.EndpointControl
	// more feeds endpoint control frames after the first (renewals).
	more chan *relayv1.EndpointControl
}

func (s *registerStream) Context() context.Context { return s.ctx }
func (s *registerStream) Recv() (*relayv1.EndpointControl, error) {
	if first := s.first; first != nil {
		s.first = nil
		return first, nil
	}
	select {
	case next := <-s.more:
		return next, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}
func (s *registerStream) Send(message *relayv1.EndpointControl) error {
	s.sent <- message
	return nil
}
func (s *registerStream) SetHeader(metadata.MD) error  { return nil }
func (s *registerStream) SendHeader(metadata.MD) error { return nil }
func (s *registerStream) SetTrailer(metadata.MD)       {}

type leaseFixture struct {
	broker      *Broker
	gate        *fakeLeaseGate
	grantKey    ed25519.PrivateKey
	ctx         context.Context
	fingerprint string
}

// newLeaseFixture serves node-a with a lease-bound endpoint (lease-ep), a
// plain endpoint (plain-ep), a managed-DB style route whose source is the
// lease-bound placement (db-route), an nginx route to the lease endpoint
// (proxy-route) and a plain nginx route (plain-route).
func newLeaseFixture(t *testing.T) *leaseFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ctx := authenticatedContext("node-a", []byte("node-a-certificate"))
	identity, _ := grpcpeer.FromContext(ctx)
	certificate := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	fingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	endpoint := func(id, leasePolicy string) *relayv1.EndpointPolicy {
		return &relayv1.EndpointPolicy{EndpointId: id, Generation: 1, SubjectKind: "node", SubjectId: "node-a", CertificateSha256: fingerprint, LeasePolicyId: leasePolicy}
	}
	route := func(id, sourceKind, sourceID, target, leasePolicy string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: sourceKind, SourceId: sourceID, SourceCertificateSha256: fingerprint, TargetEndpointId: target, LeasePolicyId: leasePolicy}
	}
	if _, _, err := store.Apply(&relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "opfield-1", PublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: public}},
		Endpoints: []*relayv1.EndpointPolicy{endpoint("lease-ep", "policy-1"), endpoint("plain-ep", "")},
		Routes: []*relayv1.RoutePolicy{
			route("db-route", "node", "node-a", "plain-ep", "policy-1"),
			route("proxy-route", "nginx", "nginx-1", "lease-ep", ""),
			route("plain-route", "nginx", "nginx-1", "plain-ep", ""),
		},
	}); err != nil {
		t.Fatal(err)
	}
	b := New(store)
	gate := &fakeLeaseGate{decisions: map[string]LeaseAdmission{}}
	b.SetLeaseGate(gate)
	return &leaseFixture{broker: b, gate: gate, grantKey: private, ctx: ctx, fingerprint: fingerprint}
}

func (f *leaseFixture) register(t *testing.T, endpointID string) (*registerStream, chan error, context.CancelFunc) {
	t.Helper()
	return f.registerWithState(t, endpointID, relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED)
}

func (f *leaseFixture) endpointGrant(t *testing.T, endpointID string) *relayv1.SignedGrant {
	t.Helper()
	return f.endpointGrantAt(t, endpointID, 1)
}

func (f *leaseFixture) endpointGrantAt(t *testing.T, endpointID string, generation uint64) *relayv1.SignedGrant {
	t.Helper()
	now := time.Now().Unix()
	payload, err := json.Marshal(grant.Claims{
		SchemaVersion: 1, Audience: grant.Audience, GrantID: "grant-" + endpointID, GatewayInstanceID: "opfield-1", Kind: "endpoint",
		SubjectKind: "node", SubjectID: "node-a", CertificateSHA256: f.fingerprint, EndpointID: endpointID, EndpointGeneration: generation,
		IssuedAt: now - 10, NotBefore: now - 10, ExpiresAt: now + 3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.SignedGrant{KeyId: "grant-key", Payload: payload, Signature: ed25519.Sign(f.grantKey, payload)}
}

func (f *leaseFixture) registerWithState(t *testing.T, endpointID string, state relayv1.EndpointServingState) (*registerStream, chan error, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(f.ctx)
	stream := &registerStream{ctx: ctx, sent: make(chan *relayv1.EndpointControl, 8), more: make(chan *relayv1.EndpointControl, 4), first: &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{
		Grant: f.endpointGrant(t, endpointID), State: state,
	}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.RegisterEndpoint(stream) }()
	t.Cleanup(cancel)
	return stream, result, cancel
}

func waitRegistered(t *testing.T, stream *registerStream, result chan error) {
	t.Helper()
	select {
	case message := <-stream.sent:
		if message.GetRegistered() == nil {
			t.Fatalf("unexpected endpoint control %v", message)
		}
	case err := <-result:
		t.Fatalf("registration refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("registration timed out")
	}
}

func waitEnded(t *testing.T, result chan error, code codes.Code, contains string) {
	t.Helper()
	select {
	case err := <-result:
		if status.Code(err) != code || !strings.Contains(err.Error(), contains) {
			t.Fatalf("registration ended with %v, want %v containing %q", err, code, contains)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("registration did not end with %v", code)
	}
}

func TestLeaseBoundRegistrationFollowsTheGate(t *testing.T) {
	f := newLeaseFixture(t)
	_, refused, _ := f.register(t, "lease-ep")
	waitEnded(t, refused, codes.FailedPrecondition, "availability lease gate closed")

	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.register(t, "lease-ep")
	waitRegistered(t, stream, result)
	if next := f.broker.EnforceLeaseGates(); next != 20*time.Second {
		t.Fatalf("next gate deadline = %s", next)
	}
	if registered, _ := f.broker.Counts(); registered != 1 {
		t.Fatalf("registered endpoints = %d", registered)
	}

	// The gate closes (window elapsed or superseded): the registration is
	// dropped at the next enforcement.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Reason: "superseded"})
	f.broker.EnforceLeaseGates()
	waitEnded(t, result, codes.Aborted, "availability lease gate closed: superseded")
	if registered, _ := f.broker.Counts(); registered != 0 {
		t.Fatalf("registered endpoints after the gate closed = %d", registered)
	}

	// A lease-closed policy is back on legacy admission.
	f.gate.set("policy-1", "node-a", LeaseAdmission{})
	legacy, legacyResult, _ := f.register(t, "lease-ep")
	waitRegistered(t, legacy, legacyResult)
}

func TestPlainRegistrationIgnoresTheLeaseGate(t *testing.T) {
	f := newLeaseFixture(t)
	stream, result, _ := f.register(t, "plain-ep")
	waitRegistered(t, stream, result)
	if next := f.broker.EnforceLeaseGates(); next != 0 {
		t.Fatalf("plain registration depends on a gate: %s", next)
	}
	select {
	case err := <-result:
		t.Fatalf("plain registration ended: %v", err)
	default:
	}
}

func TestLeaseGateClosesSourceAndTargetBoundTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	b := f.broker
	snapshot := b.store.Current()
	tunnel := func(routeID, endpointID string) *activeTunnel {
		return &activeTunnel{routeID: routeID, routeGeneration: 1, endpointID: endpointID, endpointGeneration: 1, stop: make(chan struct{})}
	}
	database, proxy, plain := tunnel("db-route", "plain-ep"), tunnel("proxy-route", "lease-ep"), tunnel("plain-route", "plain-ep")
	b.active["database"], b.active["proxy"], b.active["plain"] = database, proxy, plain

	b.mu.Lock()
	for _, routeID := range []string{"db-route", "proxy-route"} {
		route := snapshot.Route(routeID, 0)
		if err := b.tunnelLeaseErrorLocked(route, snapshot.Endpoint(route.TargetEndpointId, 0)); status.Code(err) != codes.FailedPrecondition {
			t.Fatalf("%s opened while the gate is closed: %v", routeID, err)
		}
	}
	plainRoute := snapshot.Route("plain-route", 0)
	if err := b.tunnelLeaseErrorLocked(plainRoute, snapshot.Endpoint(plainRoute.TargetEndpointId, 0)); err != nil {
		t.Fatalf("plain route refused: %v", err)
	}
	b.mu.Unlock()

	b.EnforceLeaseGates()
	for name, session := range map[string]*activeTunnel{"database": database, "proxy": proxy} {
		select {
		case <-session.stop:
		default:
			t.Fatalf("%s tunnel stayed open with a closed gate", name)
		}
	}
	select {
	case <-plain.stop:
		t.Fatal("plain tunnel was closed by the lease gate")
	default:
	}
}

func (f *leaseFixture) renew(t *testing.T, stream *registerStream, endpointID string, state relayv1.EndpointServingState) {
	t.Helper()
	stream.more <- &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{Grant: f.endpointGrant(t, endpointID), State: state}}}
}

// openProxyTunnel opens a tunnel from nginx-1 on proxy-route (to lease-ep) and
// returns its result; ctx ends a tunnel still waiting for the endpoint.
func (f *leaseFixture) openProxyTunnel(t *testing.T, ctx context.Context) chan error {
	t.Helper()
	now := time.Now().Unix()
	payload, err := json.Marshal(grant.Claims{
		SchemaVersion: 1, Audience: grant.Audience, GrantID: "grant-proxy-route", GatewayInstanceID: "opfield-1", Kind: "connect",
		SubjectKind: "nginx", SubjectID: "nginx-1", CertificateSHA256: f.fingerprint, RouteID: "proxy-route", RouteGeneration: 1,
		IssuedAt: now - 10, NotBefore: now - 10, ExpiresAt: now + 3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, _ := grpcpeer.FromContext(authenticatedContext("nginx-1", []byte("node-a-certificate")))
	stream := &openStream{ctx: grpcpeer.NewContext(ctx, identity), first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{
		Grant: &relayv1.SignedGrant{KeyId: "grant-key", Payload: payload, Signature: ed25519.Sign(f.grantKey, payload)},
	}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.OpenTunnel(stream) }()
	return result
}

func waitOpenError(t *testing.T, result chan error, code codes.Code, contains string) {
	t.Helper()
	select {
	case err := <-result:
		if status.Code(err) != code || !strings.Contains(err.Error(), contains) {
			t.Fatalf("tunnel open ended with %v, want %v containing %q", err, code, contains)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("tunnel open did not end with %v", code)
	}
}

// D7: a dormant member registers whatever the lease gate says, so the
// successor is already reachable through every relay at a takeover; the gate
// and the serving state still decide every tunnel.
func TestDormantRegistrationOutlivesTheGateAndTakesNoTraffic(t *testing.T) {
	f := newLeaseFixture(t)
	stream, result, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT)
	waitRegistered(t, stream, result)
	if registered, _ := f.broker.Counts(); registered != 1 {
		t.Fatalf("dormant registration was not kept: %d", registered)
	}
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		t.Fatalf("dormant holder endpoint = %v", got)
	}
	// Closed gate: the registration stays, the tunnel is refused by the gate.
	f.broker.EnforceLeaseGates()
	select {
	case err := <-result:
		t.Fatalf("dormant registration dropped by a closed gate: %v", err)
	default:
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.FailedPrecondition, "availability lease gate closed")

	// The member takes the slot, but its workload is not ready yet.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is dormant")

	// Ready: the endpoint serves and receives the next tunnel.
	f.renew(t, stream, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("serving holder endpoint = %v", got)
	}
	openCtx, cancelOpen := context.WithCancel(f.ctx)
	defer cancelOpen()
	opened := f.openProxyTunnel(t, openCtx)
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("serving endpoint got %v instead of an incoming tunnel", message)
		}
	case err := <-opened:
		t.Fatalf("tunnel to a serving holder refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("serving endpoint received no incoming tunnel")
	}
	cancelOpen()
	<-opened

	// The gate closes (released or superseded): the serving registration stays
	// for the next takeover, every tunnel through the gate is refused again.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Reason: "superseded"})
	f.broker.EnforceLeaseGates()
	select {
	case err := <-result:
		t.Fatalf("serving registration dropped by a closed gate: %v", err)
	default:
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.FailedPrecondition, "availability lease gate closed: superseded")
}

func TestServingRenewalToDormantClosesTheEndpointTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	session := &activeTunnel{routeID: "proxy-route", routeGeneration: 1, endpointID: "lease-ep", endpointGeneration: 1, stop: make(chan struct{})}
	f.broker.mu.Lock()
	f.broker.active["proxy"] = session
	f.broker.mu.Unlock()
	f.renew(t, stream, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT)
	waitRegistered(t, stream, result)
	select {
	case <-session.stop:
	case <-time.After(5 * time.Second):
		t.Fatal("a tunnel to an endpoint that went dormant stayed open")
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is dormant")
}

func TestHolderEndpointReadinessFollowsRegistrations(t *testing.T) {
	f := newLeaseFixture(t)
	// lease-ep is assigned here but nothing registered it yet.
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		t.Fatalf("holder endpoint without registrations = %v", got)
	}
	// This relay carries no endpoint of the policy for that holder.
	if got := f.broker.HolderEndpoint("policy-2", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN {
		t.Fatalf("holder endpoint of a policy not assigned here = %v", got)
	}
	// An endpoint built before serving states registers only while it serves.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.register(t, "lease-ep")
	waitRegistered(t, stream, result)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("legacy registered holder endpoint = %v", got)
	}
	if got := f.broker.HolderEndpoint("policy-1", "node-b"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN {
		t.Fatalf("another holder's endpoint = %v", got)
	}
	if got := f.broker.HolderEndpoint("", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN {
		t.Fatalf("holder endpoint without a policy = %v", got)
	}
}

// reapply replaces the fixture's policy snapshot, binding plain-ep to leasePolicy
// ("" keeps it outside lease mode), as Opfield does when a policy enters or
// leaves lease mode.
func (f *leaseFixture) reapply(t *testing.T, revision uint64, leasePolicy string) {
	t.Helper()
	endpoint := func(id, policy string) *relayv1.EndpointPolicy {
		return &relayv1.EndpointPolicy{EndpointId: id, Generation: 1, SubjectKind: "node", SubjectId: "node-a", CertificateSha256: f.fingerprint, LeasePolicyId: policy}
	}
	route := func(id, sourceKind, sourceID, target, policy string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: sourceKind, SourceId: sourceID, SourceCertificateSha256: f.fingerprint, TargetEndpointId: target, LeasePolicyId: policy}
	}
	if _, _, err := f.broker.store.Apply(&relayv1.ApplySnapshotRequest{
		Revision: revision, GatewayInstanceId: "opfield-1",
		PublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: f.grantKey.Public().(ed25519.PublicKey)}},
		Endpoints:  []*relayv1.EndpointPolicy{endpoint("lease-ep", "policy-1"), endpoint("plain-ep", leasePolicy)},
		Routes: []*relayv1.RoutePolicy{
			route("db-route", "node", "node-a", "plain-ep", "policy-1"),
			route("proxy-route", "nginx", "nginx-1", "lease-ep", ""),
			route("plain-route", "nginx", "nginx-1", "plain-ep", ""),
		},
	}); err != nil {
		t.Fatal(err)
	}
}

// B-12b: a member whose policy enters lease mode (bootstrapping -> lease) and
// later leaves it (closing -> legacy) flips its registration in place while
// the same copy serves: the registration and the tunnels through it survive
// every step, and the lease gate still decides new tunnels.
func TestModeFlipsKeepTheServingRegistrationAndItsTunnels(t *testing.T) {
	f := newLeaseFixture(t)
	// Bootstrapping: the link is plain to the daemon, the endpoint not lease-bound.
	stream, result, _ := f.register(t, "plain-ep")
	waitRegistered(t, stream, result)
	live := &activeTunnel{routeID: "plain-route", routeGeneration: 1, endpointID: "plain-ep", endpointGeneration: 1, stop: make(chan struct{})}
	f.broker.mu.Lock()
	f.broker.active["live"] = live
	f.broker.mu.Unlock()
	assertLive := func(step string) {
		t.Helper()
		select {
		case <-live.stop:
			t.Fatalf("%s: the live tunnel was closed", step)
		case err := <-result:
			t.Fatalf("%s: the registration ended: %v", step, err)
		default:
		}
	}

	// Lease mode: the endpoint becomes lease-bound; the copy holds the slot.
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	f.reapply(t, 2, "policy-1")
	f.broker.EnforceLeaseGates()
	assertLive("endpoint became lease-bound")
	// The daemon now knows the link as a member and renews it SERVING in place.
	f.renew(t, stream, "plain-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	f.broker.EnforceLeaseGates()
	assertLive("renewed SERVING")
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("holder endpoint after the flip = %v", got)
	}

	// Closing: Opfield takes the policy out of lease mode (legacy admission on
	// the relay) before any lease is released; the daemon renews the link as a
	// plain one; then the lease goes. Registration and tunnel stay throughout.
	f.reapply(t, 3, "")
	f.renew(t, stream, "plain-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED)
	waitRegistered(t, stream, result)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Reason: "released"})
	f.broker.EnforceLeaseGates()
	assertLive("left lease mode")
	f.broker.mu.Lock()
	legacy := f.broker.endpointLeaseErrorLocked(f.broker.store.Current().Endpoint("plain-ep", 0))
	f.broker.mu.Unlock()
	if legacy != nil {
		t.Fatalf("legacy admission refused: %v", legacy)
	}
	if registered, _ := f.broker.Counts(); registered != 1 {
		t.Fatalf("registered endpoints after the flips = %d", registered)
	}
}

// A plain renewal of a serving registration while the relay still sees the
// endpoint lease-bound with its gate closed (the relay's snapshot lags the
// daemon's): the registration keeps serving in place instead of being dropped;
// the gate alone refuses new tunnels until the relay sees legacy admission.
func TestPlainRenewalOfAServingRegistrationIsNotDroppedByTheGate(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Reason: "released"})
	f.renew(t, stream, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED)
	waitRegistered(t, stream, result)
	f.broker.EnforceLeaseGates()
	select {
	case err := <-result:
		t.Fatalf("serving registration dropped by a plain renewal: %v", err)
	default:
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.FailedPrecondition, "availability lease gate closed")
}

// N-12: when the relay drops the connection of a daemon whose host became unreachable (peer liveness), the member's
// registration goes with it: its tunnels close, the holder's endpoint reads NOT_READY (nginx closes the member socket)
// and a new tunnel is refused at once instead of waiting for an accept that never comes.
func TestLostEndpointConnectionTakesTheMemberOutAtOnce(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, disconnect := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("serving holder endpoint = %v", got)
	}
	session := &activeTunnel{routeID: "proxy-route", routeGeneration: 1, endpointID: "lease-ep", endpointGeneration: 1, stop: make(chan struct{})}
	f.broker.mu.Lock()
	f.broker.active["proxy"] = session
	f.broker.mu.Unlock()

	disconnect() // the transport closed under the registration stream
	select {
	case <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("registration outlived its connection")
	}
	select {
	case <-session.stop:
	case <-time.After(5 * time.Second):
		t.Fatal("a tunnel to the lost endpoint stayed open")
	}
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		t.Fatalf("holder endpoint after its connection was lost = %v", got)
	}
	started := time.Now()
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is not registered")
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("refusing a tunnel to the lost endpoint took %s", elapsed)
	}
}

func (f *leaseFixture) announceRestart(t *testing.T, stream *registerStream, result chan error) {
	t.Helper()
	f.renew(t, stream, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING)
	waitRegistered(t, stream, result)
}

// B-13: a graceful restart of the holder's daemon (service restart, update) looks like a short hold, not a dead
// member. Announced, the registration stays through the restart: tunnels are answered "restarting" (the opener
// retries), the holder's endpoint reads RESTARTING (nginx keeps the member socket), and the daemon's next process
// takes over the registration.
func TestRestartingEndpointIsHeldUntilItsNextProcessRegisters(t *testing.T) {
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, disconnect := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)

	// A tunnel was handed to the old process, which starts shutting down.
	openCtx, cancelOpen := context.WithCancel(f.ctx)
	defer cancelOpen()
	pending := f.openProxyTunnel(t, openCtx)
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("got %v instead of an incoming tunnel", message)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no incoming tunnel")
	}
	f.announceRestart(t, stream, result)
	waitOpenError(t, pending, codes.Unavailable, "target endpoint is restarting")
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_RESTARTING {
		t.Fatalf("holder endpoint while its daemon restarts = %v", got)
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is restarting")

	// The old process exits: the registration stays for its successor.
	disconnect()
	select {
	case <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("the old registration stream did not end")
	}
	if registered, _ := f.broker.Counts(); registered != 1 {
		t.Fatalf("registrations after the old process left = %d", registered)
	}
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_RESTARTING {
		t.Fatalf("holder endpoint between the processes = %v", got)
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is restarting")

	// The next process registers: traffic flows to it.
	next, nextResult, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, next, nextResult)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("holder endpoint once the next process registered = %v", got)
	}
	opened := f.openProxyTunnel(t, openCtx)
	select {
	case message := <-next.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("got %v instead of an incoming tunnel", message)
		}
	case err := <-opened:
		t.Fatalf("tunnel to the restarted endpoint refused: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the restarted endpoint received no tunnel")
	}
}

// A daemon that announced a restart but never comes back is forgotten after the grace, like one that disconnected.
func TestRestartingEndpointThatDoesNotComeBackIsForgotten(t *testing.T) {
	previous := EndpointRestartGrace
	EndpointRestartGrace = 200 * time.Millisecond
	t.Cleanup(func() { EndpointRestartGrace = previous })
	f := newLeaseFixture(t)
	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	stream, result, disconnect := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, stream, result)
	f.announceRestart(t, stream, result)
	disconnect()
	<-result
	deadline := time.Now().Add(5 * time.Second)
	for f.broker.HolderEndpoint("policy-1", "node-a") != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		if time.Now().After(deadline) {
			t.Fatalf("holder endpoint after the grace = %v", f.broker.HolderEndpoint("policy-1", "node-a"))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if registered, _ := f.broker.Counts(); registered != 0 {
		t.Fatalf("registrations after the grace = %d", registered)
	}
	waitOpenError(t, f.openProxyTunnel(t, f.ctx), codes.Unavailable, "target endpoint is not registered")
}

// A dormant member takes no traffic whether or not its daemon restarts; a registration that renews as serving
// after announcing a restart serves on.
func TestRestartAnnouncementOnlyHoldsServingEndpoints(t *testing.T) {
	f := newLeaseFixture(t)
	stream, result, disconnect := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT)
	waitRegistered(t, stream, result)
	f.announceRestart(t, stream, result)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		t.Fatalf("dormant holder endpoint after a restart announcement = %v", got)
	}
	disconnect()
	<-result
	if registered, _ := f.broker.Counts(); registered != 0 {
		t.Fatalf("a dormant registration outlived its stream: %d", registered)
	}

	f.gate.set("policy-1", "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
	serving, servingResult, _ := f.registerWithState(t, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, serving, servingResult)
	f.announceRestart(t, serving, servingResult)
	f.renew(t, serving, "lease-ep", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	waitRegistered(t, serving, servingResult)
	if got := f.broker.HolderEndpoint("policy-1", "node-a"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("holder endpoint after the restart was called off = %v", got)
	}
}
