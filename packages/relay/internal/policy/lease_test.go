package policy

import (
	"crypto/ed25519"
	"testing"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func TestSignedPolicyCarriesLeaseBlocksAcrossRestart(t *testing.T) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(nil)
	grantPublic, _, _ := ed25519.GenerateKey(nil)
	now := time.Unix(1_800_000_000, 0)
	dir := t.TempDir()
	store := remoteStore(t, dir, &now)
	if _, err := store.BootstrapPolicyTrust("policy-1", policyPublic, PublicKeyFingerprint(policyPublic)); err != nil {
		t.Fatal(err)
	}
	request := signedSnapshot(t, policyPrivate, "policy-1", policyPublic, grantPublic, 1, now)
	payload := &relayv1.PolicyEnvelopePayload{}
	if err := proto.Unmarshal(request.SignedEnvelope.Payload, payload); err != nil {
		t.Fatal(err)
	}
	payload.LeaseBlocks = []*relayv1.LeaseSignedBlock{{SigningKeyId: "policy-1", Kind: relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, Payload: []byte("manifest"), Signature: []byte("signature")}}
	payload.LeaseKeyRotations = []*relayv1.LeasePolicyKeyRotation{{PreviousKeyId: "policy-0", KeyId: "policy-1"}}
	encoded, _ := proto.MarshalOptions{Deterministic: true}.Marshal(payload)
	request.SignedEnvelope.Payload, request.SignedEnvelope.Signature = encoded, ed25519.Sign(policyPrivate, encoded)
	applied, _, err := store.Apply(request)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.LeaseBlocks) != 1 || len(applied.LeaseKeyRotations) != 1 {
		t.Fatalf("lease fields were not applied: %d blocks, %d links", len(applied.LeaseBlocks), len(applied.LeaseKeyRotations))
	}
	if keys := store.TrustedPolicyKeys(); len(keys) != 1 || keys[0].KeyID != "policy-1" {
		t.Fatalf("trusted policy keys = %v", keys)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := remoteStore(t, dir, &now)
	defer reopened.Close()
	if blocks := reopened.Current().LeaseBlocks; len(blocks) != 1 || string(blocks[0].Payload) != "manifest" {
		t.Fatalf("lease blocks after restart = %v", blocks)
	}
}

func TestLeaseStateIsDurableAndReportsAFreshBucket(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	state, fresh, err := store.LeaseState()
	if err != nil || !fresh {
		t.Fatalf("first open: fresh=%t err=%v", fresh, err)
	}
	if err := state.Apply(map[string][]byte{"incarnation": {1}, "key/p/0": []byte("promise")}, nil); err != nil {
		t.Fatal(err)
	}
	if err := state.Apply(map[string][]byte{"key/p/1": []byte("other")}, []string{"key/p/0"}); err != nil {
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
	state, fresh, err = reopened.LeaseState()
	if err != nil || fresh {
		t.Fatalf("reopen: fresh=%t err=%v", fresh, err)
	}
	records, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || string(records["key/p/1"]) != "other" || records["key/p/0"] != nil {
		t.Fatalf("records after reopen = %v", records)
	}
}
