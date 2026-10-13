package lease

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func manifestBlock(t *testing.T, keyID string, key ed25519.PrivateKey, version uint64, candidates ...string) *relayv1.LeaseSignedBlock {
	t.Helper()
	value := &relayv1.LeaseManifest{SchemaVersion: 1, PolicyId: policyID, ManifestVersion: version, Slots: 1}
	for _, id := range candidates {
		value.Candidates = append(value.Candidates, &relayv1.LeaseCandidate{Id: id, PublicKey: []byte{1}})
	}
	payload, _ := proto.Marshal(value)
	return availabilitylease.SignPolicyBlock(keyID, key, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

func TestMemberViewFollowsRotationChainInAnyOrder(t *testing.T) {
	pub1, priv1, _ := ed25519.GenerateKey(rand.Reader)
	pub2, priv2, _ := ed25519.GenerateKey(rand.Reader)
	pub3, priv3, _ := ed25519.GenerateKey(rand.Reader)
	link12 := availabilitylease.SignPolicyKeyRotation("k1", priv1, "k2", pub2)
	link23 := availabilitylease.SignPolicyKeyRotation("k2", priv2, "k3", pub3)
	view := newMemberView()
	view.trust("k1", pub1)
	if view.adoptBlock(manifestBlock(t, "k3", priv3, 1, "d1")) {
		t.Fatal("block signed by an untrusted key was adopted")
	}
	view.adoptLinks([]*relayv1.LeasePolicyKeyRotation{link23, link12})
	if !view.adoptBlock(manifestBlock(t, "k3", priv3, 1, "d1")) || !view.authorized("d1") {
		t.Fatal("block signed by a key reachable through the chain was not adopted")
	}
	tampered := availabilitylease.SignPolicyKeyRotation("k1", priv1, "k4", pub3)
	tampered.PublicKey = append([]byte(nil), pub2...)
	view.adoptLinks([]*relayv1.LeasePolicyKeyRotation{tampered})
	if _, trusted := view.keys["k4"]; trusted {
		t.Fatal("tampered rotation link was trusted")
	}
	if view.adoptBlock(manifestBlock(t, "k1", priv1, 1, "d2")) {
		t.Fatal("a manifest version that is not newer replaced the view")
	}
	if !view.adoptBlock(manifestBlock(t, "k1", priv1, 2, "d2")) || view.authorized("d1") || !view.authorized("d2") {
		t.Fatal("newer manifest did not replace the candidates")
	}
}
