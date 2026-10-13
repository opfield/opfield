package policy

import (
	"crypto/ed25519"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	bolt "go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"
)

// signedSnapshotLease is signedSnapshot with a chosen lease length.
func signedSnapshotLease(t *testing.T, private ed25519.PrivateKey, public, grantPublic ed25519.PublicKey, revision uint64, now time.Time, lease time.Duration) *relayv1.ApplySnapshotRequest {
	t.Helper()
	request := signedSnapshot(t, private, "policy-1", public, grantPublic, revision, now)
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(request.SignedEnvelope.Payload, payload); err != nil {
		t.Fatal(err)
	}
	payload.ExpiresAtUnix = now.Add(lease).Unix()
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request.SignedEnvelope.Payload, request.SignedEnvelope.Signature = encoded, ed25519.Sign(private, encoded)
	return request
}

func persistedKeys(t *testing.T, store *Store) (legacy, full []byte) {
	t.Helper()
	if err := store.db.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(bucketState)
		legacy = append([]byte(nil), bucket.Get(keySnapshot)...)
		full = append([]byte(nil), bucket.Get(keySnapshotFull)...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return legacy, full
}

// oldRelayAccepts is the check relays before policy_long_lease_v1 apply to the
// snapshot they load at start, fatally ("policy envelope lease is invalid").
func oldRelayAccepts(t *testing.T, encoded []byte) bool {
	t.Helper()
	if len(encoded) == 0 {
		return true // no snapshot: they start without a policy
	}
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(encoded, request); err != nil {
		t.Fatal(err)
	}
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(request.GetSignedEnvelope().GetPayload(), payload); err != nil {
		t.Fatal(err)
	}
	lease := time.Unix(payload.ExpiresAtUnix, 0).Sub(time.Unix(payload.IssuedAtUnix, 0))
	return lease > 0 && lease <= 15*time.Minute
}

func bootstrapped(t *testing.T, dir string, now *time.Time) (*Store, ed25519.PrivateKey, ed25519.PublicKey, ed25519.PublicKey) {
	t.Helper()
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	store := remoteStore(t, dir, now)
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	return store, policyPrivate, policyPublic, grantPublic
}

// B-10: a relay rolled back to a build before policy_long_lease_v1 must
// start on the relay.db this build wrote.
func TestLongLeaseSnapshotStaysOutOfTheKeyOlderRelaysLoad(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store, private, public, grant := bootstrapped(t, dir, &now)
	if _, _, err := store.Apply(signedSnapshotLease(t, private, public, grant, 1, now, 15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if legacy, full := persistedKeys(t, store); len(legacy) == 0 || string(legacy) != string(full) {
		t.Fatal("a 15-minute snapshot must stay where older relays load it")
	}
	if _, _, err := store.Apply(signedSnapshotLease(t, private, public, grant, 2, now, 72*time.Hour)); err != nil {
		t.Fatal(err)
	}
	legacy, full := persistedKeys(t, store)
	if !oldRelayAccepts(t, legacy) {
		t.Fatal("an older relay would refuse to start on the persisted snapshot")
	}
	if len(full) == 0 {
		t.Fatal("the long-lease snapshot was not persisted")
	}
	store.Close()
	reopened := remoteStore(t, dir, &now)
	defer reopened.Close()
	if reopened.Current().Revision != 2 {
		t.Fatalf("restored revision %d, want 2", reopened.Current().Revision)
	}
}

// After a rollback the older relay applies later revisions to the legacy key;
// once the relay runs this build again that snapshot is the newest.
func TestSnapshotAnOlderRelayAppliedAfterARollbackWins(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store, private, public, grant := bootstrapped(t, dir, &now)
	if _, _, err := store.Apply(signedSnapshotLease(t, private, public, grant, 4, now, 72*time.Hour)); err != nil {
		t.Fatal(err)
	}
	later, err := proto.MarshalOptions{Deterministic: true}.Marshal(signedSnapshotLease(t, private, public, grant, 7, now, 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketState).Put(keySnapshot, later) }); err != nil {
		t.Fatal(err)
	}
	store.Close()
	reopened := remoteStore(t, dir, &now)
	defer reopened.Close()
	if reopened.Current().Revision != 7 {
		t.Fatalf("restored revision %d, want the rolled-back relay's 7", reopened.Current().Revision)
	}
	if _, _, err := reopened.Apply(signedSnapshotLease(t, private, public, grant, 8, now, 72*time.Hour)); err != nil {
		t.Fatalf("the next snapshot after the upgrade: %v", err)
	}
}

// A relay.db written before this build (legacy key only) still loads.
func TestSnapshotFromBeforeTheFullKeyStillLoads(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store, private, public, grant := bootstrapped(t, dir, &now)
	encoded, err := proto.MarshalOptions{Deterministic: true}.Marshal(signedSnapshotLease(t, private, public, grant, 3, now, 15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(bucketState).Put(keySnapshot, encoded) }); err != nil {
		t.Fatal(err)
	}
	store.Close()
	reopened := remoteStore(t, dir, &now)
	defer reopened.Close()
	if reopened.Current().Revision != 3 {
		t.Fatalf("restored revision %d, want 3", reopened.Current().Revision)
	}
}
