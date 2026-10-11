package availabilitylease

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// maxTrustedPolicyKeys bounds the persisted chain. Rotation is every 30 days,
// so this keeps several months of history for forwarded blocks.
const maxTrustedPolicyKeys = 8

// PolicyKeyFingerprint matches the relay policy store: "sha256:<hex>".
func PolicyKeyFingerprint(publicKey ed25519.PublicKey) string {
	digest := sha256.Sum256(publicKey)
	return "sha256:" + hex.EncodeToString(digest[:])
}

type trustedKey struct {
	ID        string            `json:"id"`
	PublicKey ed25519.PublicKey `json:"publicKey"`
}

// keyChain holds the Gateway policy signing keys this node trusts (A14):
// keys delivered over an authenticated channel plus keys reachable from them
// through signed rotation links.
type keyChain struct {
	keys  []trustedKey
	links map[string]*pb.LeasePolicyKeyRotation
}

func newKeyChain() *keyChain { return &keyChain{links: map[string]*pb.LeasePolicyKeyRotation{}} }

func (c *keyChain) lookup(id string) (ed25519.PublicKey, bool) {
	for _, key := range c.keys {
		if key.ID == id {
			return key.PublicKey, true
		}
	}
	return nil, false
}

// index is the position of a key in the chain, -1 when untrusted.
func (c *keyChain) index(id string) int {
	for i, key := range c.keys {
		if key.ID == id {
			return i
		}
	}
	return -1
}

// trust adds a key received over an authenticated channel (daemon
// CommandStream, relay signed policy envelope).
func (c *keyChain) trust(id string, publicKey []byte) (bool, error) {
	if id == "" || len(publicKey) != ed25519.PublicKeySize {
		return false, errors.New("policy signing key is invalid")
	}
	if existing, ok := c.lookup(id); ok {
		if !bytes.Equal(existing, publicKey) {
			return false, fmt.Errorf("policy signing key %q changed its material", id)
		}
		return false, nil
	}
	c.keys = append(c.keys, trustedKey{ID: id, PublicKey: append(ed25519.PublicKey(nil), publicKey...)})
	if len(c.keys) > maxTrustedPolicyKeys {
		dropped := c.keys[0]
		c.keys = c.keys[1:]
		delete(c.links, dropped.ID)
	}
	return true, nil
}

// adopt verifies a rotation link against a trusted previous key.
func (c *keyChain) adopt(link *pb.LeasePolicyKeyRotation) (bool, error) {
	if link == nil || link.GetKeyId() == "" || len(link.GetPublicKey()) != ed25519.PublicKeySize {
		return false, errors.New("policy key rotation is invalid")
	}
	if PolicyKeyFingerprint(link.GetPublicKey()) != link.GetPublicKeyFingerprint() {
		return false, errors.New("policy key rotation fingerprint mismatch")
	}
	if existing, ok := c.lookup(link.GetKeyId()); ok {
		if !bytes.Equal(existing, link.GetPublicKey()) {
			return false, fmt.Errorf("policy signing key %q changed its material", link.GetKeyId())
		}
		if _, known := c.links[link.GetKeyId()]; !known {
			c.links[link.GetKeyId()] = proto.Clone(link).(*pb.LeasePolicyKeyRotation)
			return true, nil
		}
		return false, nil
	}
	previous, ok := c.lookup(link.GetPreviousKeyId())
	if !ok {
		return false, fmt.Errorf("policy key rotation from untrusted key %q", link.GetPreviousKeyId())
	}
	if !ed25519.Verify(previous, rotationMessage(link.GetKeyId(), link.GetPublicKey()), link.GetSignature()) {
		return false, errors.New("policy key rotation signature is invalid")
	}
	if _, err := c.trust(link.GetKeyId(), link.GetPublicKey()); err != nil {
		return false, err
	}
	c.links[link.GetKeyId()] = proto.Clone(link).(*pb.LeasePolicyKeyRotation)
	return true, nil
}

// adoptAll applies links in any order, repeating while progress is made.
func (c *keyChain) adoptAll(links []*pb.LeasePolicyKeyRotation) bool {
	changed := false
	pending := links
	for len(pending) > 0 {
		var next []*pb.LeasePolicyKeyRotation
		for _, link := range pending {
			ok, err := c.adopt(link)
			if err != nil {
				next = append(next, link)
				continue
			}
			changed = changed || ok
		}
		if len(next) == len(pending) {
			break
		}
		pending = next
	}
	return changed
}

func (c *keyChain) verifyBlock(block *pb.LeaseSignedBlock, domain string) error {
	publicKey, ok := c.lookup(block.GetSigningKeyId())
	if !ok {
		return fmt.Errorf("lease block signed by untrusted key %q", block.GetSigningKeyId())
	}
	if len(block.GetSignature()) != ed25519.SignatureSize || !ed25519.Verify(publicKey, blockMessage(domain, block.GetPayload()), block.GetSignature()) {
		return errors.New("lease block signature is invalid")
	}
	return nil
}

// chainLinks returns every stored link in chain order, for forwarding.
func (c *keyChain) chainLinks() []*pb.LeasePolicyKeyRotation {
	var out []*pb.LeasePolicyKeyRotation
	for _, key := range c.keys {
		if link := c.links[key.ID]; link != nil {
			out = append(out, link)
		}
	}
	return out
}

func (c *keyChain) encode() []byte {
	data, _ := json.Marshal(c.keys)
	return data
}

func (c *keyChain) decode(data []byte) error { return json.Unmarshal(data, &c.keys) }

// SignPolicyBlock signs a lease block with a policy key. The Gateway signs in
// TypeScript; this helper exists for tests and tooling.
func SignPolicyBlock(keyID string, privateKey ed25519.PrivateKey, kind pb.LeaseBlockKind, payload []byte) *pb.LeaseSignedBlock {
	return &pb.LeaseSignedBlock{
		SigningKeyId: keyID, Kind: kind, Payload: payload,
		Signature: ed25519.Sign(privateKey, blockMessage(blockDomain(kind), payload)),
	}
}

// SignPolicyKeyRotation builds the A14 rotation link previous -> next.
func SignPolicyKeyRotation(previousKeyID string, previous ed25519.PrivateKey, keyID string, next ed25519.PublicKey) *pb.LeasePolicyKeyRotation {
	return &pb.LeasePolicyKeyRotation{
		PreviousKeyId: previousKeyID, KeyId: keyID, PublicKey: append([]byte(nil), next...),
		PublicKeyFingerprint: PolicyKeyFingerprint(next),
		Signature:            ed25519.Sign(previous, rotationMessage(keyID, next)),
	}
}

func blockDomain(pb.LeaseBlockKind) string { return domainManifest }

// VerifyGatewaySigned verifies a statement Gateway signed with a policy key
// this node trusts, outside the lease blocks (for example a manual pair's
// primary assignment): signature over domain || 0x00 || payload. The domain
// must differ from every lease domain.
func (n *Node) VerifyGatewaySigned(domain, keyID string, payload, signature []byte) error {
	if domain == "" || strings.HasPrefix(domain, "gateway-availability-lease/") {
		return errors.New("statement domain is reserved")
	}
	n.mu.Lock()
	publicKey, ok := n.chain.lookup(keyID)
	n.mu.Unlock()
	if !ok {
		return fmt.Errorf("statement signed by untrusted key %q", keyID)
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, blockMessage(domain, payload), signature) {
		return errors.New("statement signature is invalid")
	}
	return nil
}
