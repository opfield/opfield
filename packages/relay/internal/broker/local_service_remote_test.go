package broker

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/config"
	"github.com/opfield/opfield/relay/internal/grant"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// A remote relay never dials a built-in local service: its fixed name
// (registry:5000) would resolve on the relay host's network, so a signed
// policy naming one must not turn a remote relay into a dialer there.
func TestRemoteRelayRefusesBuiltinLocalServiceTunnels(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, grantPrivate, _ := ed25519.GenerateKey(nil)
	store, err := policy.OpenWithOptions(t.TempDir(), policy.Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, policy.PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	source := []byte("source")
	sourceFingerprint := fmt.Sprintf("sha256:%x", sha256.Sum256(source))
	now := time.Now()
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: "gateway-1", PoolId: "system", RelayInstanceId: "relay-1",
		Revision: 1, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(time.Hour).Unix(),
		GrantPublicKeys: []*relayv1.PublicKey{{KeyId: "grant-1", PublicKey: grantPublic}},
		Endpoints: []*relayv1.EndpointPolicy{{
			EndpointId: "endpoint-registry", Generation: 1, SubjectKind: localServiceSubjectKind, SubjectId: config.RegistryServiceID,
			CertificateSha256: "local:gateway-internal-registry", PoolId: "system", RelayInstanceId: "relay-1", AssignmentGeneration: 1,
		}},
		Routes: []*relayv1.RoutePolicy{{
			RouteId: "route-registry", Generation: 1, SourceKind: "daemon", SourceId: "node-source",
			SourceCertificateSha256: sourceFingerprint, TargetEndpointId: "endpoint-registry", AssignmentGeneration: 1, TrafficClass: "registry",
		}},
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
	b := New(store)
	var dials atomic.Int32
	b.SetLocalServiceDialer(func(context.Context, string) (net.Conn, error) {
		dials.Add(1)
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	})
	claims := grant.Claims{
		SchemaVersion: 2, Audience: grant.Audience, GrantID: "grant-registry", GatewayInstanceID: "gateway-1", Kind: "connect",
		SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: sourceFingerprint, RouteID: "route-registry", RouteGeneration: 1,
		PoolID: "system", RelayInstanceID: "relay-1", AssignmentGeneration: 1,
		IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	grantPayload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signed := &relayv1.SignedGrant{KeyId: "grant-1", Payload: grantPayload, Signature: ed25519.Sign(grantPrivate, grantPayload)}
	err = b.OpenTunnel(&openStream{
		ctx:   authenticatedContext("node-source", source),
		first: &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: signed}}},
	})
	if status.Code(err) != codes.PermissionDenied || !strings.Contains(err.Error(), "served only by the local relay") {
		t.Fatalf("remote relay admitted a built-in local service tunnel: %v", err)
	}
	if dials.Load() != 0 {
		t.Fatalf("remote relay dialed a built-in local service %d times", dials.Load())
	}
}
