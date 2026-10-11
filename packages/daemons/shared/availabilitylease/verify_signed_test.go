package availabilitylease

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"
)

func TestVerifyGatewaySignedAcceptsOnlyTrustedKeysAndOwnDomains(t *testing.T) {
	node, err := NewNode(Config{ID: "n", Clock: &manualClock{now: time.Hour}, Store: NewMemoryStore(), Signer: fakeSigner{id: "n"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	if err := node.TrustPolicyKey("k1", public); err != nil {
		t.Fatal(err)
	}
	const domain = "gateway-availability-member/primary-assignment/v1"
	payload := []byte("payload")
	signature := ed25519.Sign(private, blockMessage(domain, payload))
	if err := node.VerifyGatewaySigned(domain, "k1", payload, signature); err != nil {
		t.Fatalf("a statement signed by a trusted key must verify: %v", err)
	}
	if err := node.VerifyGatewaySigned(domain, "k2", payload, signature); err == nil {
		t.Fatal("an untrusted key must be refused")
	}
	if err := node.VerifyGatewaySigned(domain, "k1", []byte("other"), signature); err == nil {
		t.Fatal("a changed payload must be refused")
	}
	if err := node.VerifyGatewaySigned("other/domain", "k1", payload, signature); err == nil {
		t.Fatal("a signature under another domain must be refused")
	}
	manifest := ed25519.Sign(private, blockMessage(domainManifest, payload))
	if err := node.VerifyGatewaySigned(domainManifest, "k1", payload, manifest); err == nil {
		t.Fatal("lease domains are reserved")
	}
}
