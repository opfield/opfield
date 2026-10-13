package policy

import (
	"crypto/ed25519"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func TestApplyIsDurableMonotonicAndIdempotent(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	request := validSnapshot(publicKey)
	applied, unchanged, err := store.Apply(request)
	if err != nil || unchanged || applied.Revision != 1 {
		t.Fatalf("unexpected first apply: applied=%v unchanged=%v err=%v", applied, unchanged, err)
	}
	if _, unchanged, err := store.Apply(request); err != nil || !unchanged {
		t.Fatalf("identical apply was not idempotent: unchanged=%v err=%v", unchanged, err)
	}
	conflict := validSnapshot(publicKey)
	conflict.GatewayInstanceId = "different"
	if _, _, err := store.Apply(conflict); err == nil {
		t.Fatal("conflicting content at one revision was accepted")
	}
	next := validSnapshot(publicKey)
	next.Revision = 2
	if _, _, err := store.Apply(next); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("older snapshot was accepted")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.Current().Revision != 2 || reopened.Current().GatewayInstanceID != "gateway-1" {
		t.Fatalf("persisted snapshot was not restored: %#v", reopened.Current())
	}
}

func TestLegacyConfiguredIdentitySurvivesApplyAndReopen(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	dir := t.TempDir()
	options := Options{
		Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED, PoolID: "system", InstanceID: "relay-1",
	}
	store, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	applied, _, err := store.Apply(validSnapshot(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	if applied.PoolID != options.PoolID || applied.RelayInstanceID != options.InstanceID {
		t.Fatalf("legacy apply lost configured identity: pool=%q instance=%q", applied.PoolID, applied.RelayInstanceID)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	current := reopened.Current()
	if current.PoolID != options.PoolID || current.RelayInstanceID != options.InstanceID {
		t.Fatalf("legacy reopen lost configured identity: pool=%q instance=%q", current.PoolID, current.RelayInstanceID)
	}
}

func TestLegacySnapshotWithoutConfiguredIdentityRemainsIdentityless(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, _, err := store.Apply(validSnapshot(publicKey)); err != nil {
		t.Fatal(err)
	}
	current := store.Current()
	if current.PoolID != "" || current.RelayInstanceID != "" {
		t.Fatalf("legacy snapshot acquired an unconfigured identity: pool=%q instance=%q", current.PoolID, current.RelayInstanceID)
	}
}

func TestFullSnapshotRevocationSurvivesRestart(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(validSnapshot(publicKey)); err != nil {
		t.Fatal(err)
	}
	revoked := validSnapshot(publicKey)
	revoked.Revision = 2
	revoked.Endpoints = nil
	revoked.Routes = nil
	if _, _, err := store.Apply(revoked); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	current := reopened.Current()
	if current.Revision != 2 || len(current.Endpoints) != 0 || len(current.Routes) != 0 {
		t.Fatalf("revocation was not restored: %#v", current)
	}
}

func TestApplyRejectsRouteToUnknownEndpoint(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	request := validSnapshot(publicKey)
	request.Routes[0].TargetEndpointId = "missing"
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("route targeting an unknown endpoint was accepted")
	}
}

func TestBootstrapPolicyTrustRejectsMismatchAndSubstitution(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(nil)
	otherKey, _, _ := ed25519.GenerateKey(nil)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("mismatched public key and fingerprint were accepted")
	}
	if unchanged, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(publicKey)); err != nil || unchanged {
		t.Fatalf("initial trust bootstrap failed: unchanged=%v err=%v", unchanged, err)
	}
	if unchanged, err := store.BootstrapPolicyTrust("policy-1", publicKey, PublicKeyFingerprint(publicKey)); err != nil || !unchanged {
		t.Fatalf("idempotent trust bootstrap failed: unchanged=%v err=%v", unchanged, err)
	}
	if _, err := store.BootstrapPolicyTrust("policy-1", otherKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("substituted first key was accepted")
	}
	if _, err := store.BootstrapPolicyTrust("policy-2", otherKey, PublicKeyFingerprint(otherKey)); err == nil {
		t.Fatal("unsigned second key was accepted")
	}
}

func TestRemoteRelayRejectsLegacySnapshot(t *testing.T) {
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, _, err := store.Apply(validSnapshot(grantPublic)); err == nil {
		t.Fatal("remote relay accepted an unsigned legacy snapshot")
	}
}

func TestSignedPolicyRejectsMismatchedRelayIdentity(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	mismatched := signedSnapshotWithPolicyKeysForTarget(t, policyPrivate, "policy-1", grantPublic, 1, now, []*relayv1.PolicySigningKey{
		policyKey("policy-1", policyPublic),
	}, "other-system", "relay-1")
	if _, _, err := store.Apply(mismatched); err == nil {
		t.Fatal("signed policy targeting another relay identity was accepted")
	}
	current := store.Current()
	if current.PoolID != "system" || current.RelayInstanceID != "relay-1" {
		t.Fatalf("mismatched signed policy changed configured identity: pool=%q instance=%q", current.PoolID, current.RelayInstanceID)
	}
}

func TestSignedPolicyLeaseReplayAndRestart(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	options := Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return now },
	}
	store, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	request := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)
	if _, _, err := store.Apply(request); err != nil {
		t.Fatal(err)
	}
	if _, unchanged, err := store.Apply(request); err != nil || !unchanged {
		t.Fatalf("identical signed policy was not idempotent: unchanged=%v err=%v", unchanged, err)
	}
	next := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 2, now)
	if _, _, err := store.Apply(next); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(request); err == nil {
		t.Fatal("valid older signed policy replay was accepted")
	}
	if err := store.AdmissionError(now.Add(MaxPolicyLease - time.Second)); err != nil {
		t.Fatalf("policy expired early: %v", err)
	}
	// A relay clock running slightly ahead of Gateway keeps the lease.
	if err := store.AdmissionError(now.Add(MaxPolicyLease + LeaseExpiryClockSkew - time.Second)); err != nil {
		t.Fatalf("policy expired within the clock skew allowance: %v", err)
	}
	now = now.Add(MaxPolicyLease + LeaseExpiryClockSkew)
	if err := store.AdmissionError(now); err == nil {
		t.Fatal("expired policy still admitted new tunnels")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatalf("expired policy must remain loadable for existing-stream continuity: %v", err)
	}
	defer reopened.Close()
	if reopened.Ready(now) {
		t.Fatal("expired persisted policy reported ready after restart")
	}
	tampered := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 3, now.Add(-time.Minute))
	tampered.SignedEnvelope.Payload[0] ^= 0x01
	if _, _, err := reopened.Apply(tampered); err == nil {
		t.Fatal("tampered policy envelope was accepted")
	}
}

func TestSignedPolicyKeyRotationRemovesOldSigner(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	first := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 1, now, []*relayv1.PolicySigningKey{
		policyKey("old", oldPublic), policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(first); err != nil {
		t.Fatalf("old-signs-new rotation failed: %v", err)
	}
	second := signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 2, now.Add(time.Minute), []*relayv1.PolicySigningKey{
		policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(second); err != nil {
		t.Fatalf("new signer activation failed: %v", err)
	}
	oldSignedAgain := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 3, now.Add(2*time.Minute), []*relayv1.PolicySigningKey{
		policyKey("old", oldPublic), policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(oldSignedAgain); err == nil {
		t.Fatal("retired policy signer was accepted")
	}
}

func TestSignedPolicyKeepsActiveAndStagingAssignmentGenerations(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1", Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	request := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(request.SignedEnvelope.Payload, payload); err != nil {
		t.Fatal(err)
	}
	stagingEndpoint := proto.Clone(payload.Endpoints[0]).(*relayv1.EndpointPolicy)
	stagingEndpoint.AssignmentGeneration = 2
	payload.Endpoints = append(payload.Endpoints, stagingEndpoint)
	stagingRoute := proto.Clone(payload.Routes[0]).(*relayv1.RoutePolicy)
	stagingRoute.AssignmentGeneration = 2
	payload.Routes = append(payload.Routes, stagingRoute)
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request.SignedEnvelope.Payload = encoded
	request.SignedEnvelope.Signature = ed25519.Sign(policyPrivate, encoded)
	snapshot, _, err := store.Apply(request)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Endpoint("endpoint-1", 1) == nil || snapshot.Endpoint("endpoint-1", 2) == nil {
		t.Fatal("active and staging endpoint assignments were not retained")
	}
	if snapshot.Route("route-1", 1) == nil || snapshot.Route("route-1", 2) == nil {
		t.Fatal("active and staging route assignments were not retained")
	}
}

func validSnapshot(publicKey ed25519.PublicKey) *relayv1.ApplySnapshotRequest {
	return &relayv1.ApplySnapshotRequest{
		Revision: 1, GatewayInstanceId: "gateway-1",
		PublicKeys: []*relayv1.PublicKey{{KeyId: "key-1", PublicKey: publicKey}},
		Endpoints:  []*relayv1.EndpointPolicy{{EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target", CertificateSha256: "sha256:target"}},
		Routes:     []*relayv1.RoutePolicy{{RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source", SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1"}},
	}
}

func signedSnapshot(t *testing.T, policyPrivate ed25519.PrivateKey, policyKeyID string, policyPublic, grantPublic ed25519.PublicKey, revision uint64, now time.Time) *relayv1.ApplySnapshotRequest {
	t.Helper()
	return signedSnapshotWithPolicyKeys(t, policyPrivate, policyKeyID, grantPublic, revision, now, []*relayv1.PolicySigningKey{
		policyKey(policyKeyID, policyPublic),
	})
}

func signedSnapshotWithPolicyKeys(t *testing.T, privateKey ed25519.PrivateKey, keyID string, grantPublic ed25519.PublicKey, revision uint64, now time.Time, policyKeys []*relayv1.PolicySigningKey) *relayv1.ApplySnapshotRequest {
	t.Helper()
	return signedSnapshotWithPolicyKeysForTarget(t, privateKey, keyID, grantPublic, revision, now, policyKeys, "system", "relay-1")
}

func signedSnapshotWithPolicyKeysForTarget(t *testing.T, privateKey ed25519.PrivateKey, keyID string, grantPublic ed25519.PublicKey, revision uint64, now time.Time, policyKeys []*relayv1.PolicySigningKey, poolID, relayInstanceID string) *relayv1.ApplySnapshotRequest {
	t.Helper()
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: "gateway-1", PoolId: poolID, RelayInstanceId: relayInstanceID,
		Revision: revision, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(MaxPolicyLease).Unix(),
		GrantPublicKeys: []*relayv1.PublicKey{{KeyId: "grant-1", PublicKey: grantPublic}},
		Endpoints: []*relayv1.EndpointPolicy{{
			EndpointId: "endpoint-1", Generation: 1, SubjectKind: "daemon", SubjectId: "node-target",
			CertificateSha256: "sha256:target", PoolId: poolID, RelayInstanceId: relayInstanceID, AssignmentGeneration: 1,
		}},
		Routes: []*relayv1.RoutePolicy{{
			RouteId: "route-1", Generation: 1, SourceKind: "daemon", SourceId: "node-source",
			SourceCertificateSha256: "sha256:source", TargetEndpointId: "endpoint-1", AssignmentGeneration: 1,
		}},
		Capabilities: []string{PoolCapability}, PolicySigningKeys: policyKeys,
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.ApplySnapshotRequest{SignedEnvelope: &relayv1.SignedPolicyEnvelope{
		SigningKeyId: keyID, Payload: encoded, Signature: ed25519.Sign(privateKey, encoded),
	}}
}

func policyKey(keyID string, publicKey ed25519.PublicKey) *relayv1.PolicySigningKey {
	return &relayv1.PolicySigningKey{
		KeyId: keyID, PublicKey: publicKey, PublicKeyFingerprint: PublicKeyFingerprint(publicKey), Status: "active",
	}
}

func policyKeyWindow(keyID string, publicKey ed25519.PublicKey, status string, validFrom, verifyUntil time.Time) *relayv1.PolicySigningKey {
	key := policyKey(keyID, publicKey)
	key.Status = status
	if !validFrom.IsZero() {
		key.ValidFromUnix = validFrom.Unix()
	}
	if !verifyUntil.IsZero() {
		key.VerifyUntilUnix = verifyUntil.Unix()
	}
	return key
}

func remoteStore(t *testing.T, dir string, now *time.Time) *Store {
	t.Helper()
	store, err := OpenWithOptions(dir, Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return *now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func TestPromotedKeyValidFromAllowsIssuedAtClockSkew(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	opfieldNow := time.Unix(1_800_000_000, 0)
	relayNow := opfieldNow.Add(-2 * time.Minute) // relay clock runs behind Gateway
	dir := t.TempDir()
	store := remoteStore(t, dir, &relayNow)
	if _, err := store.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	pending := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 1, relayNow, []*relayv1.PolicySigningKey{
		policyKey("old", oldPublic), policyKey("new", newPublic),
	})
	if _, _, err := store.Apply(pending); err != nil {
		t.Fatal(err)
	}
	// Gateway promotes "new" at opfieldNow; the relay is still two minutes earlier.
	promoted := []*relayv1.PolicySigningKey{
		policyKeyWindow("old", oldPublic, "verification_only", time.Time{}, opfieldNow.Add(30*time.Minute)),
		policyKeyWindow("new", newPublic, "active", opfieldNow, time.Time{}),
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 2, opfieldNow, promoted)); err != nil {
		t.Fatalf("first snapshot from the promoted key was refused: %v", err)
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 3, opfieldNow, promoted)); err != nil {
		t.Fatalf("promoted key was refused for a relay two minutes behind: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := remoteStore(t, dir, &relayNow)
	if reopened.Current().Revision != 3 {
		t.Fatalf("persisted snapshot was not restored: revision=%d", reopened.Current().Revision)
	}

	// Skew beyond the leeway is still refused.
	farBehind := opfieldNow.Add(-IssuedAtClockSkew - time.Minute)
	relayNow = farBehind
	if _, _, err := reopened.Apply(signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 4, farBehind, promoted)); err == nil {
		t.Fatal("key was accepted long before its validity window")
	}
	reopened.Close()
}

func TestLeaseExpiryAllowsRelayClockAheadOfOpfield(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	opfieldNow := time.Unix(1_800_000_000, 0)
	// Gateway issued the lease a full lease ago by the relay's clock, which runs ahead.
	relayNow := opfieldNow.Add(MaxPolicyLease + time.Minute)
	store := remoteStore(t, t.TempDir(), &relayNow)
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, opfieldNow)); err != nil {
		t.Fatalf("lease inside the clock skew allowance was refused: %v", err)
	}
	if !store.Ready(relayNow) {
		t.Fatal("lease inside the clock skew allowance did not admit tunnels")
	}
	relayNow = opfieldNow.Add(MaxPolicyLease + LeaseExpiryClockSkew)
	if store.Ready(relayNow) {
		t.Fatal("lease past the clock skew allowance still admitted tunnels")
	}
	if _, _, err := store.Apply(signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 2, opfieldNow)); err == nil {
		t.Fatal("envelope past the clock skew allowance was accepted")
	}
}

func TestPersistedSnapshotLoadsAfterSignerWindowCloses(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, _, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store := remoteStore(t, dir, &now)
	if _, err := store.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	// A retained old key introduces the active key; its own window is short.
	request := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 1, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("old", oldPublic, "verification_only", time.Time{}, now.Add(30*time.Minute)),
		policyKeyWindow("new", newPublic, "active", now, time.Time{}),
	})
	if _, _, err := store.Apply(request); err != nil {
		t.Fatal(err)
	}
	store.Close()
	now = now.Add(MaxPolicyLease + LeaseExpiryClockSkew + time.Minute)
	reopened := remoteStore(t, dir, &now)
	defer reopened.Close()
	if reopened.Current().Revision != 1 {
		t.Fatalf("persisted snapshot was not restored: revision=%d", reopened.Current().Revision)
	}
	if reopened.Ready(now) {
		t.Fatal("expired persisted snapshot reported ready")
	}
	if _, _, err := reopened.Apply(signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 2, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("old", oldPublic, "verification_only", time.Time{}, now.Add(30*time.Minute)),
		policyKeyWindow("new", newPublic, "active", now, time.Time{}),
	})); err == nil {
		t.Fatal("a signer past its window was accepted for a new snapshot")
	}
}

// A relay that missed the whole pending window still pins only the old key.
// Gateway keeps that key's private half and signs this relay's snapshot with
// it; the payload carries the active key, so the relay learns it through
// signed rotation and accepts the active signer from then on.
func TestLaggingRelayLearnsActiveKeyFromRetainedOldSigner(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store := remoteStore(t, t.TempDir(), &now)
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(signedSnapshot(t, oldPrivate, "old", oldPublic, grantPublic, 1, now)); err != nil {
		t.Fatal(err)
	}
	// The relay was offline for the rotation, which completed a day ago.
	promotedAt := now.Add(-24 * time.Hour)
	now = now.Add(time.Hour)
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 2, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("new", newPublic, "active", promotedAt, time.Time{}),
	})); err == nil {
		t.Fatal("a key the relay never pinned was accepted")
	}
	catchUp := signedSnapshotWithPolicyKeys(t, oldPrivate, "old", grantPublic, 3, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("old", oldPublic, "verification_only", time.Time{}, now.Add(30*time.Minute)),
		policyKeyWindow("new", newPublic, "active", promotedAt, time.Time{}),
	})
	if _, _, err := store.Apply(catchUp); err != nil {
		t.Fatalf("retained old signer could not introduce the active key: %v", err)
	}
	if ids := store.PolicyKeyIDs(); len(ids) != 2 || ids[0] != "new" || ids[1] != "old" {
		t.Fatalf("relay does not report the active key after catching up: %v", ids)
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, newPrivate, "new", grantPublic, 4, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("new", newPublic, "active", promotedAt, time.Time{}),
	})); err != nil {
		t.Fatalf("active signer was refused after signed rotation: %v", err)
	}
}

// Supervisors re-bootstrap their enrollment key on every health loop. Gateway
// keeps that key in each relay's trust as an expired verification-only entry:
// re-pinning an existing key checks only its material, never its window, and
// the expired entry cannot sign anything.
func TestExpiredEnrollmentKeyStillBootstrapsButCannotSign(t *testing.T) {
	enrollPublic, enrollPrivate, _ := ed25519.GenerateKey(nil)
	activePublic, activePrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	store := remoteStore(t, t.TempDir(), &now)
	defer store.Close()
	if _, err := store.BootstrapPolicyTrust("enroll", enrollPublic, PublicKeyFingerprint(enrollPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, enrollPrivate, "enroll", grantPublic, 1, now, []*relayv1.PolicySigningKey{
		policyKey("enroll", enrollPublic), policyKey("active", activePublic),
	})); err != nil {
		t.Fatal(err)
	}
	retiredAt := now.Add(-time.Hour)
	withEnrollment := []*relayv1.PolicySigningKey{
		policyKeyWindow("enroll", enrollPublic, "verification_only", time.Time{}, retiredAt),
		policyKeyWindow("active", activePublic, "active", now.Add(-2*time.Hour), time.Time{}),
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, activePrivate, "active", grantPublic, 2, now, withEnrollment)); err != nil {
		t.Fatal(err)
	}
	if unchanged, err := store.BootstrapPolicyTrust("enroll", enrollPublic, PublicKeyFingerprint(enrollPublic)); err != nil || !unchanged {
		t.Fatalf("expired enrollment key could not be re-bootstrapped: unchanged=%v err=%v", unchanged, err)
	}
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, enrollPrivate, "enroll", grantPublic, 3, now, withEnrollment)); err == nil {
		t.Fatal("expired enrollment key signed a snapshot")
	}

	// Without the entry, the same supervisor call is refused: this is the loop
	// that dropped relays out of the pool about 30 days after their first rotation.
	if _, _, err := store.Apply(signedSnapshotWithPolicyKeys(t, activePrivate, "active", grantPublic, 4, now, []*relayv1.PolicySigningKey{
		policyKeyWindow("active", activePublic, "active", now.Add(-2*time.Hour), time.Time{}),
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BootstrapPolicyTrust("enroll", enrollPublic, PublicKeyFingerprint(enrollPublic)); err == nil {
		t.Fatal("expected a retired enrollment key outside trust to be refused")
	}
}

func TestResetLocalPolicyTrustIsLocalOnly(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)

	remote := remoteStore(t, t.TempDir(), &now)
	if _, err := remote.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.ResetLocalPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic)); err == nil {
		t.Fatal("remote relay accepted an unsigned trust reset")
	}
	if ids := remote.PolicyKeyIDs(); len(ids) != 1 || ids[0] != "old" {
		t.Fatalf("refused reset changed remote trust: %v", ids)
	}
	remote.Close()

	dir := t.TempDir()
	options := Options{
		Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return now },
	}
	local, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := local.Apply(signedSnapshot(t, oldPrivate, "old", oldPublic, grantPublic, 5, now)); err != nil {
		t.Fatal(err)
	}
	// relay.db restored from a backup: Gateway's active key is one it never saw.
	if _, err := local.BootstrapPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic)); err == nil {
		t.Fatal("expected unsigned bootstrap of a second key to be refused")
	}
	if _, err := local.ResetLocalPolicyTrust("new", newPublic, PublicKeyFingerprint(oldPublic)); err == nil {
		t.Fatal("reset accepted a mismatched fingerprint")
	}
	replaced, err := local.ResetLocalPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic))
	if err != nil {
		t.Fatal(err)
	}
	if len(replaced) != 1 || replaced[0] != "old" {
		t.Fatalf("unexpected replaced keys: %v", replaced)
	}
	if local.Current().Revision != 5 {
		t.Fatal("reset dropped the snapshot that is still serving")
	}
	if unchanged, err := local.BootstrapPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic)); err != nil || !unchanged {
		t.Fatalf("re-bootstrap after reset failed: unchanged=%v err=%v", unchanged, err)
	}
	// A restart before Gateway's next snapshot must not fail on the old signer.
	local.Close()
	local, err = OpenWithOptions(dir, options)
	if err != nil {
		t.Fatalf("relay could not start after a trust reset: %v", err)
	}
	defer local.Close()
	if local.Current().Revision != 0 {
		t.Fatalf("snapshot signed by a replaced key survived the reset: revision=%d", local.Current().Revision)
	}
	if _, _, err := local.Apply(signedSnapshot(t, newPrivate, "new", newPublic, grantPublic, 6, now)); err != nil {
		t.Fatalf("snapshot from the re-pinned key was refused: %v", err)
	}
	if _, _, err := local.Apply(signedSnapshot(t, oldPrivate, "old", oldPublic, grantPublic, 7, now)); err == nil {
		t.Fatal("replaced key still signs policy")
	}
}

// A Gateway restored from backup, or reinstalled over an existing relay volume,
// re-pins its key and then signs snapshots for another instance or from an
// older revision sequence. The first snapshot after a reset may rebind the
// relay; later ones are held to the usual rules again.
func TestResetLocalPolicyTrustRebindsNextSnapshot(t *testing.T) {
	oldPublic, oldPrivate, _ := ed25519.GenerateKey(nil)
	newPublic, newPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	local, err := OpenWithOptions(t.TempDir(), Options{
		Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	if _, err := local.BootstrapPolicyTrust("old", oldPublic, PublicKeyFingerprint(oldPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := local.Apply(signedSnapshotForOpfield(t, oldPrivate, "old", oldPublic, grantPublic, 50, now, "gateway-1")); err != nil {
		t.Fatal(err)
	}
	replaced, err := local.ResetLocalPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic))
	if err != nil || len(replaced) != 1 || replaced[0] != "old" {
		t.Fatalf("reset failed: replaced=%v err=%v", replaced, err)
	}
	// A retried reset with the same key is harmless and replaces nothing.
	if replaced, err := local.ResetLocalPolicyTrust("new", newPublic, PublicKeyFingerprint(newPublic)); err != nil || len(replaced) != 0 {
		t.Fatalf("repeated reset: replaced=%v err=%v", replaced, err)
	}
	if _, err := local.ResetLocalPolicyTrust("new", oldPublic, PublicKeyFingerprint(oldPublic)); err == nil {
		t.Fatal("reset replaced the material of a pinned key id")
	}
	if _, _, err := local.Apply(signedSnapshotForOpfield(t, newPrivate, "new", newPublic, grantPublic, 3, now, "gateway-2")); err != nil {
		t.Fatalf("first snapshot after a reset could not rebind the relay: %v", err)
	}
	if current := local.Current(); current.Revision != 3 || current.GatewayInstanceID != "gateway-2" {
		t.Fatalf("relay did not rebind: revision=%d gateway=%s", current.Revision, current.GatewayInstanceID)
	}
	if _, _, err := local.Apply(signedSnapshotForOpfield(t, newPrivate, "new", newPublic, grantPublic, 2, now, "gateway-2")); err == nil {
		t.Fatal("an older revision was accepted after the rebind")
	}
	if _, _, err := local.Apply(signedSnapshotForOpfield(t, newPrivate, "new", newPublic, grantPublic, 4, now, "gateway-1")); err == nil {
		t.Fatal("another Gateway instance was accepted after the rebind")
	}
}

// F12: the rebind a reset grants survives a relay restart before Gateway's
// next snapshot, here with a persisted snapshot the re-pinned key signed (it
// is kept), and ends with the snapshot that uses it.
func TestResetLocalPolicyTrustRebindSurvivesRestart(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	options := Options{
		Mode: relayv1.RelayMode_RELAY_MODE_LOCAL_COMBINED, PoolID: "system", InstanceID: "relay-1",
		Now: func() time.Time { return now },
	}
	local, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.BootstrapPolicyTrust("key", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := local.Apply(signedSnapshotForOpfield(t, policyPrivate, "key", policyPublic, grantPublic, 50, now, "gateway-1")); err != nil {
		t.Fatal(err)
	}
	if _, err := local.ResetLocalPolicyTrust("key", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	local.Close()

	reopened, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Current().Revision != 50 {
		t.Fatalf("persisted snapshot signed by the re-pinned key was dropped: revision=%d", reopened.Current().Revision)
	}
	if _, _, err := reopened.Apply(signedSnapshotForOpfield(t, policyPrivate, "key", policyPublic, grantPublic, 3, now, "gateway-2")); err != nil {
		t.Fatalf("the rebind did not survive the restart: %v", err)
	}
	reopened.Close()

	again, err := OpenWithOptions(dir, options)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if _, _, err := again.Apply(signedSnapshotForOpfield(t, policyPrivate, "key", policyPublic, grantPublic, 2, now, "gateway-2")); err == nil {
		t.Fatal("the rebind outlived the snapshot that used it")
	}
}

func signedSnapshotForOpfield(t *testing.T, privateKey ed25519.PrivateKey, keyID string, policyPublic, grantPublic ed25519.PublicKey, revision uint64, now time.Time, gatewayInstanceID string) *relayv1.ApplySnapshotRequest {
	t.Helper()
	payload := &relayv1.PolicyEnvelopePayload{
		SchemaVersion: 2, GatewayInstanceId: gatewayInstanceID, PoolId: "system", RelayInstanceId: "relay-1",
		Revision: revision, IssuedAtUnix: now.Unix(), ExpiresAtUnix: now.Add(MaxPolicyLease).Unix(),
		GrantPublicKeys:   []*relayv1.PublicKey{{KeyId: "grant-1", PublicKey: grantPublic}},
		Capabilities:      []string{PoolCapability},
		PolicySigningKeys: []*relayv1.PolicySigningKey{policyKey(keyID, policyPublic)},
	}
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &relayv1.ApplySnapshotRequest{SignedEnvelope: &relayv1.SignedPolicyEnvelope{
		SigningKeyId: keyID, Payload: encoded, Signature: ed25519.Sign(privateKey, encoded),
	}}
}

// A relay must start even when its persisted snapshot no longer validates:
// written for another relay instance before a re-enrollment, or with the
// host clock now behind the snapshot's issue time.
func TestPersistedSnapshotThatNoLongerValidatesDoesNotBlockStart(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store := remoteStore(t, dir, &now)
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Apply(signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)); err != nil {
		t.Fatal(err)
	}
	store.Close()

	// The host clock is now ten minutes behind the snapshot it persisted.
	behind := now.Add(-10 * time.Minute)
	reopened := remoteStore(t, dir, &behind)
	if reopened.Current().Revision != 1 {
		t.Fatalf("persisted snapshot was not restored with a clock behind: revision=%d", reopened.Current().Revision)
	}
	reopened.Close()

	other, err := OpenWithOptions(dir, Options{
		Mode: relayv1.RelayMode_RELAY_MODE_REMOTE_DATA_ONLY, PoolID: "system", InstanceID: "relay-2",
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("relay could not start with a snapshot for another instance: %v", err)
	}
	defer other.Close()
	if other.Current().Revision != 0 || other.Ready(now) {
		t.Fatal("a snapshot for another relay instance was served")
	}
	if ids := other.PolicyKeyIDs(); len(ids) != 1 || ids[0] != "policy-1" {
		t.Fatalf("pinned trust was not kept: %v", ids)
	}
}
