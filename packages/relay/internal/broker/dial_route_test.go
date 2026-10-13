package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/relaylocal"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// witnessFixture is relay-1 of the system pool carrying the routes of a
// witness it hosts: members reach the witness through relay-local endpoints,
// the witness reaches member-a through a route whose source is relay-1.
type witnessFixture struct {
	broker      *Broker
	gate        *fakeLeaseGate
	grantKey    ed25519.PrivateKey
	ctx         context.Context
	fingerprint string
	mu          sync.Mutex
	dialed      []string
}

const witnessLeasePolicy = "set-policy"

func newWitnessFixture(t *testing.T) *witnessFixture {
	t.Helper()
	grantPublic, grantPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	policyPublic, policyPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ctx := authenticatedContext("node-a", []byte("node-a-certificate"))
	identity, _ := grpcpeer.FromContext(ctx)
	certificate := identity.AuthInfo.(credentials.TLSInfo).State.PeerCertificates[0]
	fingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
	store, err := policy.OpenWithOptions(t.TempDir(), policy.Options{Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, policy.PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	scoped := func(endpoint *relayv1.EndpointPolicy) *relayv1.EndpointPolicy {
		endpoint.Generation, endpoint.PoolId, endpoint.RelayInstanceId, endpoint.AssignmentGeneration = 1, "system", "relay-1", 1
		if endpoint.CertificateSha256 == "" {
			endpoint.CertificateSha256 = "relay-local"
		}
		return endpoint
	}
	route := func(id, sourceKind, sourceID, target string) *relayv1.RoutePolicy {
		return &relayv1.RoutePolicy{RouteId: id, Generation: 1, SourceKind: sourceKind, SourceId: sourceID, SourceCertificateSha256: fingerprint, TargetEndpointId: target, AssignmentGeneration: 1, TrafficClass: "database"}
	}
	now := time.Now()
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: "gateway-1", PoolId: "system", RelayInstanceId: "relay-1",
		Revision: 1, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(time.Hour).Unix(),
		GrantPublicKeys: []*relayv1.PublicKey{{KeyId: "grant-key", PublicKey: grantPublic}},
		Endpoints: []*relayv1.EndpointPolicy{
			scoped(&relayv1.EndpointPolicy{EndpointId: "witness-client", SubjectKind: relaylocal.SubjectKind, SubjectId: "relay-1", RelayLocalPort: 39401}),
			scoped(&relayv1.EndpointPolicy{EndpointId: "witness-elsewhere", SubjectKind: relaylocal.SubjectKind, SubjectId: "relay-2", RelayLocalPort: 39402}),
			scoped(&relayv1.EndpointPolicy{EndpointId: "witness-ssh", SubjectKind: relaylocal.SubjectKind, SubjectId: "relay-1", RelayLocalPort: 22}),
			scoped(&relayv1.EndpointPolicy{EndpointId: "member-a", SubjectKind: "daemon", SubjectId: "node-a", CertificateSha256: fingerprint, LeasePolicyId: witnessLeasePolicy}),
		},
		Routes: []*relayv1.RoutePolicy{
			route("keeper-client", "daemon", "node-a", "witness-client"),
			route("keeper-elsewhere", "daemon", "node-a", "witness-elsewhere"),
			route("keeper-ssh", "daemon", "node-a", "witness-ssh"),
			route("witness-to-a", relaylocal.SubjectKind, "relay-1", "member-a"),
			route("foreign-origin", relaylocal.SubjectKind, "relay-2", "member-a"),
			route("daemon-route", "daemon", "node-a", "member-a"),
		},
		Capabilities: []string{policy.PoolCapability},
		PolicySigningKeys: []*relayv1.PolicySigningKey{{
			KeyId: "policy-1", PublicKey: policyPublic, PublicKeyFingerprint: policy.PublicKeyFingerprint(policyPublic), Status: "active",
		}},
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(&relayv1.ApplySnapshotRequest{SignedEnvelope: &relayv1.SignedPolicyEnvelope{
		SigningKeyId: "policy-1", Payload: encoded, Signature: ed25519.Sign(policyPrivate, encoded),
	}}); err != nil {
		t.Fatal(err)
	}
	f := &witnessFixture{broker: New(store), gate: &fakeLeaseGate{decisions: map[string]LeaseAdmission{}}, grantKey: grantPrivate, ctx: ctx, fingerprint: fingerprint}
	f.broker.SetLeaseGate(f.gate)
	f.broker.SetLocalServiceDialer(func(_ context.Context, target string) (net.Conn, error) {
		f.mu.Lock()
		f.dialed = append(f.dialed, target)
		f.mu.Unlock()
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	})
	return f
}

func (f *witnessFixture) dials() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...)
}

func (f *witnessFixture) sign(t *testing.T, claims grant.Claims) *relayv1.SignedGrant {
	t.Helper()
	now := time.Now().Unix()
	claims.SchemaVersion, claims.Audience, claims.GatewayInstanceID = 2, grant.Audience, "gateway-1"
	claims.PoolID, claims.RelayInstanceID, claims.AssignmentGeneration = "system", "relay-1", 1
	claims.IssuedAt, claims.NotBefore, claims.ExpiresAt = now-10, now-10, now+3600
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.SignedGrant{KeyId: "grant-key", Payload: payload, Signature: ed25519.Sign(f.grantKey, payload)}
}

func (f *witnessFixture) open(t *testing.T, routeID string) error {
	t.Helper()
	signed := f.sign(t, grant.Claims{GrantID: "open-" + routeID, Kind: "connect", SubjectKind: "daemon", SubjectID: "node-a",
		CertificateSHA256: f.fingerprint, RouteID: routeID, RouteGeneration: 1})
	return f.broker.OpenTunnel(&openStream{ctx: f.ctx, first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: signed}}}})
}

func (f *witnessFixture) dial(ctx context.Context, routeID string, generation uint64) chan error {
	result := make(chan error, 1)
	stream := &openStream{ctx: ctx, first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Dial{Dial: &relayv1.DialRoute{RouteId: routeID, AssignmentGeneration: generation}}}}
	go func() { result <- f.broker.DialRoute(stream) }()
	return result
}

// A relay-local endpoint is served by the relay it names, on its own
// loopback port of the witness range, and nowhere else.
func TestRelayLocalEndpointDialsOnlyItsOwnPort(t *testing.T) {
	f := newWitnessFixture(t)
	if err := f.open(t, "keeper-client"); err != nil {
		// The fake dialer hands back a closed pipe: the tunnel ends once it
		// bridged. Any refusal names a reason instead.
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unavailable {
			t.Fatalf("relay-local tunnel refused: %v", err)
		}
	}
	if dials := f.dials(); len(dials) != 1 || dials[0] != "127.0.0.1:39401" {
		t.Fatalf("dials = %v, want only 127.0.0.1:39401", dials)
	}
	for _, route := range []string{"keeper-elsewhere", "keeper-ssh"} {
		if err := f.open(t, route); status.Code(err) != codes.PermissionDenied {
			t.Fatalf("%s: %v, want permission denied", route, err)
		}
	}
	if dials := f.dials(); len(dials) != 1 {
		t.Fatalf("a refused relay-local endpoint was dialled: %v", dials)
	}
	// Only this relay serves it, so a drain keeps it.
	f.broker.SetDraining(true)
	_ = f.open(t, "keeper-client")
	if dials := f.dials(); len(dials) != 2 {
		t.Fatalf("a draining relay refused its relay-local endpoint: %v", dials)
	}
}

func TestDialRouteOpensOnlyRoutesFromThisRelay(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()
	waitOpenError(t, f.dial(ctx, "no-such-route", 0), codes.NotFound, "not in this relay's policy")
	waitOpenError(t, f.dial(ctx, "daemon-route", 0), codes.PermissionDenied, "does not start at this relay")
	waitOpenError(t, f.dial(ctx, "foreign-origin", 0), codes.PermissionDenied, "does not start at this relay")
	// The target is gated by its endpoint's lease like any tunnel.
	f.gate.set(witnessLeasePolicy, "node-a", LeaseAdmission{LeaseMode: true, Reason: "not the holder"})
	waitOpenError(t, f.dial(ctx, "witness-to-a", 0), codes.FailedPrecondition, "availability lease gate closed")
	f.gate.set(witnessLeasePolicy, "node-a", LeaseAdmission{LeaseMode: true, Open: true, Remaining: time.Minute})
	waitOpenError(t, f.dial(ctx, "witness-to-a", 1), codes.Unavailable, "not registered")

	// Registered and serving: the tunnel reaches the member.
	registerCtx, cancelRegister := context.WithCancel(f.ctx)
	defer cancelRegister()
	endpointGrant := f.sign(t, grant.Claims{GrantID: "endpoint-member-a", Kind: "endpoint", SubjectKind: "daemon", SubjectID: "node-a",
		CertificateSHA256: f.fingerprint, EndpointID: "member-a", EndpointGeneration: 1})
	registration := &registerStream{ctx: registerCtx, sent: make(chan *relayv1.EndpointControl, 8), more: make(chan *relayv1.EndpointControl, 4),
		first: &relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Register{Register: &relayv1.RegisterEndpoint{
			Grant: endpointGrant, State: relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING,
		}}}}
	registered := make(chan error, 1)
	go func() { registered <- f.broker.RegisterEndpoint(registration) }()
	waitRegistered(t, registration, registered)
	f.broker.SetDraining(true)
	dialCtx, cancelDial := context.WithCancel(ctx)
	dialed := f.dial(dialCtx, "witness-to-a", 0)
	select {
	case message := <-registration.sent:
		incoming := message.GetIncoming()
		if incoming == nil || incoming.GetRoute().GetRouteId() != "witness-to-a" || incoming.GetRoute().GetSourceKind() != relaylocal.SubjectKind {
			t.Fatalf("member got %v, want the witness tunnel", message)
		}
	case err := <-dialed:
		t.Fatalf("dial ended before reaching the member: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the witness tunnel never reached the member")
	}
	cancelDial()
	<-dialed
}
