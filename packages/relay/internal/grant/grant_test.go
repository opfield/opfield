package grant

import (
	"crypto/ed25519"
	"encoding/json"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/peer"
	"github.com/opfield/opfield/relay/internal/policy"
	"google.golang.org/protobuf/proto"
)

func TestVerifyConnectGrant(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, err = store.Apply(snapshot(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	claims := Claims{SchemaVersion: 1, Audience: Audience, GrantID: "grant-1", GatewayInstanceID: "opfield-1", Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: "sha256:source", RouteID: "route-1", RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
	envelope := sign(t, privateKey, claims)
	verified, err := (Verifier{Store: store, Now: func() time.Time { return now }}).Verify(envelope, "connect", peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"})
	if err != nil || verified.RouteID != "route-1" {
		t.Fatalf("valid grant rejected: claims=%#v err=%v", verified, err)
	}
	envelope.Signature[0] ^= 0xff
	if _, err := (Verifier{Store: store, Now: func() time.Time { return now }}).Verify(envelope, "connect", peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"}); err == nil {
		t.Fatal("invalid signature accepted")
	}
}

func TestVerifyRejectsOversizedLifetimeAndWrongCertificate(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(nil)
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, _ = store.Apply(snapshot(publicKey))
	now := time.Unix(1_800_000_000, 0)
	claims := Claims{SchemaVersion: 1, Audience: Audience, GrantID: "grant-1", GatewayInstanceID: "opfield-1", Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: "sha256:source", RouteID: "route-1", RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(MaxTTL + time.Second).Unix()}
	verifier := Verifier{Store: store, Now: func() time.Time { return now }}
	if _, err := verifier.Verify(sign(t, privateKey, claims), "connect", peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"}); err == nil {
		t.Fatal("grant exceeding maximum TTL was accepted")
	}
	claims.ExpiresAt = now.Add(time.Hour).Unix()
	if _, err := verifier.Verify(sign(t, privateKey, claims), "connect", peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:other"}); err == nil {
		t.Fatal("grant bound to another certificate was accepted")
	}
}

func TestVerifyRejectsInvalidScopeAndTime(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(nil)
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, _, _ = store.Apply(snapshot(publicKey))
	now := time.Unix(1_800_000_000, 0)
	base := Claims{SchemaVersion: 1, Audience: Audience, GrantID: "grant-1", GatewayInstanceID: "opfield-1", Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: "sha256:source", RouteID: "route-1", RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
	identity := peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"}
	verifier := Verifier{Store: store, Now: func() time.Time { return now }}
	tests := map[string]func(*Claims){
		"wrong audience":   func(claims *Claims) { claims.Audience = "another-relay" },
		"wrong instance":   func(claims *Claims) { claims.GatewayInstanceID = "opfield-2" },
		"wrong generation": func(claims *Claims) { claims.RouteGeneration = 2 },
		"future issued at": func(claims *Claims) {
			claims.IssuedAt = now.Add(ClockSkew + time.Second).Unix()
			claims.NotBefore = claims.IssuedAt
		},
		"future not before":          func(claims *Claims) { claims.NotBefore = now.Add(ClockSkew + time.Second).Unix() },
		"not before before issuance": func(claims *Claims) { claims.NotBefore = now.Add(-time.Second).Unix() },
		"expired beyond skew": func(claims *Claims) {
			claims.ExpiresAt = now.Add(-ClockSkew - time.Second).Unix()
			claims.IssuedAt = now.Add(-time.Hour).Unix()
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			claims := base
			mutate(&claims)
			if _, err := verifier.Verify(sign(t, privateKey, claims), "connect", identity); err == nil {
				t.Fatal("invalid grant was accepted")
			}
		})
	}
	unknownKey := sign(t, privateKey, base)
	unknownKey.KeyId = "missing"
	if _, err := verifier.Verify(unknownKey, "connect", identity); err == nil {
		t.Fatal("unknown key ID was accepted")
	}
}

func TestValidatePolicyRejectsClaimsAfterConcurrentSnapshotChange(t *testing.T) {
	claims := Claims{
		Kind:               "connect",
		SubjectKind:        "daemon",
		SubjectID:          "node-source",
		CertificateSHA256:  "sha256:source",
		RouteID:            "route-1",
		RouteGeneration:    1,
		EndpointID:         "endpoint-1",
		EndpointGeneration: 1,
	}
	retargeted := &policy.Snapshot{
		Routes: map[string]*relayv1.RoutePolicy{
			"route-1": {RouteId: "route-1", Generation: 2, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-2"},
		},
		Endpoints: map[string]*relayv1.EndpointPolicy{},
	}
	if err := ValidatePolicy(claims, "connect", retargeted); err == nil {
		t.Fatal("stale connect claims were accepted after route retarget")
	}
	if err := ValidatePolicy(claims, "connect", &policy.Snapshot{Routes: map[string]*relayv1.RoutePolicy{}, Endpoints: map[string]*relayv1.EndpointPolicy{}}); err == nil {
		t.Fatal("stale connect claims were accepted after route deletion")
	}
}

func TestRemoteRelayRequiresInstanceBoundV2Grant(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, grantPrivate, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := policy.OpenWithOptions(t.TempDir(), policy.Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, policy.PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: "opfield-1", PoolId: "system", RelayInstanceId: "relay-1",
		Revision: 1, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(policy.MaxPolicyLease).Unix(),
		GrantPublicKeys:   []*relayv1.PublicKey{{KeyId: "key-1", PublicKey: grantPublic}},
		Endpoints:         []*relayv1.EndpointPolicy{{EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target", CertificateSha256: "sha256:target", PoolId: "system", RelayInstanceId: "relay-1", AssignmentGeneration: 7}},
		Routes:            []*relayv1.RoutePolicy{{RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1", AssignmentGeneration: 7}},
		Capabilities:      []string{policy.PoolCapability},
		PolicySigningKeys: []*relayv1.PolicySigningKey{{KeyId: "policy-1", PublicKey: policyPublic, PublicKeyFingerprint: policy.PublicKeyFingerprint(policyPublic), Status: "active"}},
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
	claims := Claims{
		SchemaVersion: 2, Audience: Audience, GrantID: "grant-1", GatewayInstanceID: "opfield-1",
		PoolID: "system", RelayInstanceID: "relay-1", AssignmentGeneration: 7,
		Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: "sha256:source",
		RouteID: "route-1", RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	identity := peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"}
	verifier := Verifier{Store: store, Now: func() time.Time { return now }}
	if _, err := verifier.Verify(sign(t, grantPrivate, claims), "connect", identity); err != nil {
		t.Fatalf("valid v2 grant rejected: %v", err)
	}
	legacy := claims
	legacy.SchemaVersion, legacy.PoolID, legacy.RelayInstanceID, legacy.AssignmentGeneration = 1, "", "", 0
	if _, err := verifier.Verify(sign(t, grantPrivate, legacy), "connect", identity); err == nil {
		t.Fatal("remote relay accepted legacy v1 grant")
	}
	wrongInstance := claims
	wrongInstance.RelayInstanceID = "relay-2"
	if _, err := verifier.Verify(sign(t, grantPrivate, wrongInstance), "connect", identity); err == nil {
		t.Fatal("remote relay accepted grant for another instance")
	}
}

func sign(t *testing.T, key ed25519.PrivateKey, claims Claims) *relayv1.SignedGrant {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.SignedGrant{KeyId: "key-1", Payload: payload, Signature: ed25519.Sign(key, payload)}
}

func snapshot(key ed25519.PublicKey) *relayv1.ApplySnapshotRequest {
	return &relayv1.ApplySnapshotRequest{Revision: 1, GatewayInstanceId: "opfield-1", PublicKeys: []*relayv1.PublicKey{{KeyId: "key-1", PublicKey: key}}, Endpoints: []*relayv1.EndpointPolicy{{EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target", CertificateSha256: "sha256:target"}}, Routes: []*relayv1.RoutePolicy{{RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1"}}}
}

// Opfield 2.12.0 issues grants for the legacy audience, and a newer Opfield
// keeps doing so while any relay of the pool predates the new one: this relay
// accepts both, and nothing else.
func TestVerifyAcceptsTheOpfieldAndTheLegacyAudience(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := policy.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, _, err := store.Apply(snapshot(publicKey)); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	verifier := Verifier{Store: store, Now: func() time.Time { return now }}
	identity := peer.Identity{SubjectID: "node-source", CertificateFingerprint: "sha256:source"}
	for audience, accepted := range map[string]bool{"opfield-relay": true, "wiolett-relay": true, "gateway-relay": false, "": false} {
		claims := Claims{SchemaVersion: 1, Audience: audience, GrantID: "grant-1", GatewayInstanceID: "opfield-1", Kind: "connect", SubjectKind: "daemon", SubjectID: "node-source", CertificateSHA256: "sha256:source", RouteID: "route-1", RouteGeneration: 1, IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
		_, err := verifier.Verify(sign(t, privateKey, claims), "connect", identity)
		if accepted && err != nil {
			t.Fatalf("audience %q rejected: %v", audience, err)
		}
		if !accepted && err == nil {
			t.Fatalf("audience %q accepted", audience)
		}
	}
}
