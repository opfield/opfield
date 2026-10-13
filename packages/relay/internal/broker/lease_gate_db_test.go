package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	grpcpeer "google.golang.org/grpc/peer"
)

// A highly available managed database as Opfield publishes it: one
// endpoint per member (subject = the member's node, lease_policy_id = the
// database's lease policy), one binding route per member from the app node, and
// replication routes from every member node to every other member's endpoint.
// No route carries a lease policy: the database side is gated by its endpoint
// alone (never source-gated), the app side of these routes is not lease-bound.
type dbLeaseFixture struct {
	broker       *Broker
	gate         *fakeLeaseGate
	grantKey     ed25519.PrivateKey
	fingerprints map[string]string
	contexts     map[string]context.Context
}

const dbLeasePolicy = "db-lease-policy"

func newDBLeaseFixture(t *testing.T, gated bool) *dbLeaseFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := &dbLeaseFixture{grantKey: private, fingerprints: map[string]string{}, contexts: map[string]context.Context{}}
	for _, node := range []string{"node-a", "node-b", "app-1"} {
		ctx := authenticatedContext(node, []byte(node+"-certificate"))
		identity, _ := grpcpeer.FromContext(ctx)
		certificate := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
		f.contexts[node] = ctx
		f.fingerprints[node] = fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
	}
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	leasePolicy := ""
	if gated {
		leasePolicy = dbLeasePolicy
	}
	endpoint := func(id, node string) *relayv1.EndpointPolicy {
		return &relayv1.EndpointPolicy{EndpointId: id, Generation: 1, SubjectKind: "daemon", SubjectId: node, CertificateSha256: f.fingerprints[node], LeasePolicyId: leasePolicy}
	}
	route := func(id, source, target string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: "daemon", SourceId: source, SourceCertificateSha256: f.fingerprints[source], TargetEndpointId: target}
	}
	if _, _, err := store.Apply(&relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "gateway-1", PublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: public}},
		Endpoints: []*relayv1.EndpointPolicy{endpoint("member-a", "node-a"), endpoint("member-b", "node-b")},
		Routes: []*relayv1.RoutePolicy{
			route("binding-a", "app-1", "member-a"), route("binding-b", "app-1", "member-b"),
			route("replication-b-to-a", "node-b", "member-a"), route("replication-a-to-b", "node-a", "member-b"),
		},
	}); err != nil {
		t.Fatal(err)
	}
	f.broker = New(store)
	f.gate = &fakeLeaseGate{decisions: map[string]LeaseAdmission{}}
	f.broker.SetLeaseGate(f.gate)
	return f
}

func (f *dbLeaseFixture) sign(t *testing.T, claims grant.Claims) *relayv1.SignedGrant {
	t.Helper()
	now := time.Now().Unix()
	claims.SchemaVersion, claims.Audience, claims.GatewayInstanceID = 1, grant.Audience, "gateway-1"
	claims.IssuedAt, claims.NotBefore, claims.ExpiresAt = now-10, now-10, now+3600
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.SignedGrant{KeyId: "grant-key", Payload: payload, Signature: ed25519.Sign(f.grantKey, payload)}
}

func (f *dbLeaseFixture) register(t *testing.T, endpointID, node string, state relayv1.EndpointServingState) (*registerStream, chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(f.contexts[node])
	t.Cleanup(cancel)
	grantFor := f.sign(t, grant.Claims{GrantID: "grant-" + endpointID, Kind: "endpoint", SubjectKind: "daemon", SubjectID: node,
		CertificateSHA256: f.fingerprints[node], EndpointID: endpointID, EndpointGeneration: 1})
	stream := &registerStream{ctx: ctx, sent: make(chan *relayv1.EndpointControl, 8), more: make(chan *relayv1.EndpointControl, 4),
		first: &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{Grant: grantFor, State: state}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.RegisterEndpoint(stream) }()
	waitRegistered(t, stream, result)
	return stream, result
}

func (f *dbLeaseFixture) renew(t *testing.T, stream *registerStream, result chan error, endpointID, node string, state relayv1.EndpointServingState) {
	t.Helper()
	grantFor := f.sign(t, grant.Claims{GrantID: "renew-" + endpointID, Kind: "endpoint", SubjectKind: "daemon", SubjectID: node,
		CertificateSHA256: f.fingerprints[node], EndpointID: endpointID, EndpointGeneration: 1})
	stream.more <- &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Renew{Renew: &relayv1.RenewEndpoint{Grant: grantFor, State: state}}}
	waitRegistered(t, stream, result)
}

// open opens a tunnel on routeID as source and returns its result; ctx ends a
// tunnel that was admitted and is waiting for the endpoint to accept.
func (f *dbLeaseFixture) open(t *testing.T, ctx context.Context, routeID, source string) chan error {
	t.Helper()
	grantFor := f.sign(t, grant.Claims{GrantID: "open-" + routeID, Kind: "connect", SubjectKind: "daemon", SubjectID: source,
		CertificateSHA256: f.fingerprints[source], RouteID: routeID, RouteGeneration: 1})
	identity, _ := grpcpeer.FromContext(f.contexts[source])
	stream := &openStream{ctx: grpcpeer.NewContext(ctx, identity), first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: grantFor}}}}
	result := make(chan error, 1)
	go func() { result <- f.broker.OpenTunnel(stream) }()
	return result
}

// expectIncoming asserts the tunnel was admitted: the endpoint got it.
func expectIncoming(t *testing.T, stream *registerStream, opened chan error, what string) {
	t.Helper()
	select {
	case message := <-stream.sent:
		if message.GetIncoming() == nil {
			t.Fatalf("%s: endpoint got %v instead of an incoming tunnel", what, message)
		}
	case err := <-opened:
		t.Fatalf("%s refused: %v", what, err)
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: no incoming tunnel", what)
	}
}

func (f *dbLeaseFixture) holds(node string) {
	for _, member := range []string{"node-a", "node-b"} {
		if member == node {
			f.gate.set(dbLeasePolicy, member, LeaseAdmission{LeaseMode: true, Open: true, Remaining: 20 * time.Second})
			continue
		}
		f.gate.set(dbLeasePolicy, member, LeaseAdmission{LeaseMode: true, Reason: "superseded"})
	}
}

// Every member registers DORMANT on every relay before any lease commit: the
// registrations are kept (so a takeover finds its successor registered) and no
// tunnel reaches either member.
func TestDatabaseMembersRegisterDormantBeforeTheGateOpens(t *testing.T) {
	f := newDBLeaseFixture(t, true)
	dormant := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	_, resultA := f.register(t, "member-a", "node-a", dormant)
	_, resultB := f.register(t, "member-b", "node-b", dormant)
	f.broker.EnforceLeaseGates()
	for name, result := range map[string]chan error{"member-a": resultA, "member-b": resultB} {
		select {
		case err := <-result:
			t.Fatalf("%s dormant registration dropped by the closed gate: %v", name, err)
		default:
		}
	}
	if registered, _ := f.broker.Counts(); registered != 2 {
		t.Fatalf("registered endpoints = %d, want both members", registered)
	}
	waitOpenError(t, f.open(t, context.Background(), "binding-a", "app-1"), codes.FailedPrecondition, "availability lease gate closed")
	waitOpenError(t, f.open(t, context.Background(), "replication-a-to-b", "node-a"), codes.FailedPrecondition, "availability lease gate closed")
}

// Only the holder takes traffic; a failover moves it without a policy change,
// cuts the sessions of the superseded member even while it still claims to
// serve, and replication reaches the holder from a node that is no holder
// (endpoint-gated only).
func TestDatabaseTrafficReachesOnlyTheLeaseHolder(t *testing.T) {
	f := newDBLeaseFixture(t, true)
	serving := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	dormant := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	f.holds("node-a")
	streamA, resultA := f.register(t, "member-a", "node-a", serving)
	streamB, resultB := f.register(t, "member-b", "node-b", dormant)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bindingToA := f.open(t, ctx, "binding-a", "app-1")
	expectIncoming(t, streamA, bindingToA, "binding to the holder")
	waitOpenError(t, f.open(t, ctx, "binding-b", "app-1"), codes.FailedPrecondition, "availability lease gate closed")
	// The standby streams WAL from the holder: its own node holds nothing.
	replicationToA := f.open(t, ctx, "replication-b-to-a", "node-b")
	expectIncoming(t, streamA, replicationToA, "replication from the standby")

	// Track the admitted sessions to see them cut at the failover.
	f.broker.mu.Lock()
	sessions := []*activeTunnel{}
	for _, pending := range f.broker.pending {
		sessions = append(sessions, pending.session)
	}
	f.broker.mu.Unlock()
	if len(sessions) != 2 {
		t.Fatalf("pending sessions = %d, want the binding and the replication tunnel", len(sessions))
	}

	// Failover without Opfield: the gate moves to node-b. node-a is
	// partitioned and still registered SERVING; its sessions are closed and no
	// new tunnel reaches it.
	f.holds("node-b")
	f.broker.EnforceLeaseGates()
	for _, session := range sessions {
		select {
		case <-session.stop:
		case <-time.After(5 * time.Second):
			t.Fatal("a session of the superseded primary stayed open")
		}
	}
	select {
	case err := <-resultA:
		t.Fatalf("the superseded member's stateful registration was dropped: %v", err)
	default:
	}
	waitOpenError(t, f.open(t, ctx, "binding-a", "app-1"), codes.FailedPrecondition, "availability lease gate closed: superseded")

	// The successor promotes and serves: bindings and the old primary's
	// replication (after its rejoin) reach it.
	waitOpenError(t, f.open(t, ctx, "binding-b", "app-1"), codes.Unavailable, "target endpoint is dormant")
	f.renew(t, streamB, resultB, "member-b", "node-b", serving)
	expectIncoming(t, streamB, f.open(t, ctx, "binding-b", "app-1"), "binding to the new holder")
	expectIncoming(t, streamB, f.open(t, ctx, "replication-a-to-b", "node-a"), "replication from the old primary")
	if got := f.broker.HolderEndpoint(dbLeasePolicy, "node-b"); got != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("new holder endpoint = %v", got)
	}
}

// Before the lease gates (HA being enabled: Opfield publishes the member
// endpoints without lease_policy_id), only the serving registration takes
// traffic: the origin serves, seeding standbys stay dormant.
func TestDatabaseMembersWithoutAGateServeOnlyTheServingMember(t *testing.T) {
	f := newDBLeaseFixture(t, false)
	streamA, _ := f.register(t, "member-a", "node-a", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING)
	f.register(t, "member-b", "node-b", relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	expectIncoming(t, streamA, f.open(t, ctx, "replication-b-to-a", "node-b"), "seeding from the origin")
	waitOpenError(t, f.open(t, ctx, "binding-b", "app-1"), codes.Unavailable, "target endpoint is dormant")
}
