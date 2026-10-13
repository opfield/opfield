package availabilitylease

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func isPolicy(block *pb.LeaseSignedBlock, policyID string) bool {
	value := &pb.LeaseManifest{}
	return proto.Unmarshal(block.GetPayload(), value) == nil && value.GetPolicyId() == policyID
}

func renewedIdentity(t *testing.T) (ECDSASigner, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return ECDSASigner{Key: key}, der
}

// H3: a certificate renewal of the holder and of the witness in the middle
// of a lease, with two policies whose manifests learn the new keys at
// different times. Real ECDSA frames and accepts; no fence, no invariant
// breach, and the previous key is retired once every manifest lists the new
// one.
func TestIdentityKeyRenewalMidLeaseAcrossPolicies(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		wire:       true,
		relays:     []nodeSpec{{id: "w", voter: true}, {id: "r2"}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}, {id: "d3"}},
		candidates: []string{"d1", "d2"},
	})
	keyP2 := w.addPolicy("p2", []string{"d1", "d3"}, []string{"d1", "d3", "w"})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.waitHolderIs(t, keyP2, "d1", 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	since := w.now

	renewed := map[string][]byte{}
	for _, id := range []string{"d1", "w"} {
		signer, der := renewedIdentity(t)
		if err := w.nodes[id].node.RotateIdentityKey(signer, der); err != nil {
			t.Fatal(err)
		}
		renewed[id] = der
	}
	check := func(stage string) {
		t.Helper()
		w.requireClean(t)
		for _, key := range []Key{keyP1, keyP2} {
			if w.holder(key) != "d1" || w.fencesSince("d1", key, since) != 0 {
				t.Fatalf("%s: renewal disturbed the holder of %s", stage, key)
			}
		}
	}
	w.runUntil(w.now + 30*time.Second)
	check("no manifest knows the new keys")
	if !w.nodes["d1"].node.IdentityOverlap() {
		t.Fatal("d1 stopped dual-signing before any manifest listed its new key")
	}

	// r2 never learns p1's update (a stale manifest it keeps forever); it must
	// still accept d1 through the key p2 lists once d1 stops dual-signing.
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		for _, block := range batch.GetBlocks() {
			if to == "r2" && isPolicy(block, "p1") {
				return true
			}
		}
		return false
	}
	p1 := w.gw.policies["p1"]
	p1.keys = renewed
	block := w.gw.buildManifest(p1)
	for _, id := range w.ids {
		if id != "r2" {
			w.gw.adopt(w.nodes[id], block)
		}
	}
	w.runUntil(w.now + 30*time.Second)
	check("only p1 lists the new keys")
	if !w.nodes["d1"].node.IdentityOverlap() || !w.nodes["w"].node.IdentityOverlap() {
		t.Fatal("previous key retired while p2 still lists it")
	}

	p2 := w.gw.policies["p2"]
	p2.keys = renewed
	w.gw.deliver(w.gw.buildManifest(p2), 1)
	w.runUntil(w.now + 10*time.Second)
	if w.nodes["d1"].node.IdentityOverlap() || w.nodes["w"].node.IdentityOverlap() {
		t.Fatal("previous key not retired once every manifest lists the new key")
	}
	w.runUntil(w.now + 30*time.Second)
	check("both policies list the new keys")
	if w.nodes["r2"].node.ManifestVersion("p1") != 1 {
		t.Fatal("r2 was meant to keep the stale p1 manifest")
	}
	if gate := w.nodes["r2"].node.Gate(keyP2); !gate.Open || gate.Holder != "d1" {
		t.Fatalf("r2 stopped admitting d1 for p2 after the renewal: %+v", gate)
	}

	// Failover still works through the renewed witness.
	w.nodes["d1"].crashHost()
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.waitHolderIs(t, keyP2, "d3", 60*time.Second)
	w.requireClean(t)
}

// The overlap ends after IdentityKeyOverlap even if a manifest never learns
// the new key.
func TestIdentityKeyOverlapExpires(t *testing.T) {
	node, policy, clock := observerNode(t, "d1")
	if _, err := node.AdoptManifest(manifestBlock(t, policy, nil)); err != nil {
		t.Fatal(err)
	}
	signer, der := renewedIdentity(t)
	if err := node.RotateIdentityKey(signer, der); err != nil {
		t.Fatal(err)
	}
	if !node.IdentityOverlap() {
		t.Fatal("no overlap after a rotation")
	}
	clock.now += IdentityKeyOverlap
	node.Tick()
	if node.IdentityOverlap() {
		t.Fatal("overlap outlived IdentityKeyOverlap")
	}
}
