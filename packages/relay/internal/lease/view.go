package lease

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"sort"
	"sync"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Signature domains of availabilitylease/doc.go: the wire contract the
// Opfield signs lease blocks and rotation links with.
const (
	domainManifest    = legacycompat.AvailabilityLeaseDomain + "/manifest/v1"
	domainKeyRotation = legacycompat.AvailabilityLeaseDomain + "/key-rotation/v1"

	maxPendingLinks = 16
)

// memberView is the relay's own verified view of who may use Coordinate: the
// members (voters and non-voting members) and candidates of every signed
// policy manifest (A18: voters live in each policy's manifest). It verifies blocks independently of the lease node, which
// stays the only authority for protocol state; the view only authorizes
// routing, so a disagreement costs liveness, never safety.
type memberView struct {
	mu        sync.RWMutex
	keys      map[string]ed25519.PublicKey
	links     map[string]*relayv1.LeasePolicyKeyRotation
	manifests map[string]viewManifest
}

type viewManifest struct {
	version    uint64
	voterEpoch uint64
	slots      uint32
	closed     bool
	candidates map[string]bool
	// members maps each member id to its listed PKIX DER identity key.
	members map[string][]byte
	voters  map[string]bool
}

func newMemberView() *memberView {
	return &memberView{keys: map[string]ed25519.PublicKey{}, links: map[string]*relayv1.LeasePolicyKeyRotation{}, manifests: map[string]viewManifest{}}
}

// trust adds a policy key delivered by the verified policy envelope.
func (v *memberView) trust(id string, publicKey ed25519.PublicKey) {
	if id == "" || len(publicKey) != ed25519.PublicKeySize {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.keys[id] = append(ed25519.PublicKey(nil), publicKey...)
	v.adoptLinksLocked()
}

// adoptLinks verifies rotation links against trusted keys, in any order.
// Links that cannot be verified yet wait, bounded, keyed by signature so a
// bogus link cannot shadow a genuine one with the same key id.
func (v *memberView) adoptLinks(links []*relayv1.LeasePolicyKeyRotation) {
	if len(links) == 0 {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, link := range links {
		if _, trusted := v.keys[link.GetKeyId()]; trusted || link.GetKeyId() == "" {
			continue
		}
		if len(v.links) >= maxPendingLinks {
			for signature := range v.links {
				delete(v.links, signature)
				break
			}
		}
		v.links[string(link.GetSignature())] = link
	}
	v.adoptLinksLocked()
}

func (v *memberView) adoptLinksLocked() {
	for progress := true; progress; {
		progress = false
		for signature, link := range v.links {
			id := link.GetKeyId()
			if _, trusted := v.keys[id]; trusted {
				delete(v.links, signature)
				continue
			}
			previous, ok := v.keys[link.GetPreviousKeyId()]
			if !ok {
				continue
			}
			delete(v.links, signature)
			if len(link.GetPublicKey()) != ed25519.PublicKeySize || keyFingerprint(link.GetPublicKey()) != link.GetPublicKeyFingerprint() ||
				!ed25519.Verify(previous, rotationMessage(id, link.GetPublicKey()), link.GetSignature()) {
				continue
			}
			v.keys[id] = append(ed25519.PublicKey(nil), link.GetPublicKey()...)
			progress = true
		}
	}
}

// adoptBlock records a verified manifest newer than the one in the view. It
// reports whether the view changed. Other block kinds are ignored.
func (v *memberView) adoptBlock(block *relayv1.LeaseSignedBlock) bool {
	if block.GetKind() != relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	publicKey, ok := v.keys[block.GetSigningKeyId()]
	if !ok || len(block.GetSignature()) != ed25519.SignatureSize || !ed25519.Verify(publicKey, blockMessage(domainManifest, block.GetPayload()), block.GetSignature()) {
		return false
	}
	return v.adoptManifestLocked(block.GetPayload())
}

func (v *memberView) adoptManifestLocked(payload []byte) bool {
	value := &relayv1.LeaseManifest{}
	if proto.Unmarshal(payload, value) != nil || value.GetPolicyId() == "" || value.GetManifestVersion() == 0 {
		return false
	}
	if current, ok := v.manifests[value.GetPolicyId()]; ok && value.GetManifestVersion() <= current.version {
		return false
	}
	manifest := viewManifest{
		version: value.GetManifestVersion(), voterEpoch: value.GetVoterEpoch(), slots: value.GetSlots(), closed: value.GetClosed(),
		candidates: map[string]bool{}, members: map[string][]byte{}, voters: map[string]bool{},
	}
	for _, candidate := range value.GetCandidates() {
		manifest.candidates[candidate.GetId()] = true
	}
	for _, member := range value.GetMembers() {
		manifest.members[member.GetId()] = append([]byte(nil), member.GetPublicKey()...)
	}
	for _, set := range value.GetQuorumSets() {
		for _, id := range set.GetVoterIds() {
			manifest.voters[id] = true
		}
	}
	v.manifests[value.GetPolicyId()] = manifest
	return true
}

// authorized reports whether id is a member (voter or not) or a candidate of
// any policy manifest the relay holds.
func (v *memberView) authorized(id string) bool {
	if id == "" {
		return false
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	for _, manifest := range v.manifests {
		if manifest.names(id) {
			return true
		}
	}
	return false
}

// shares reports whether one policy manifest the relay holds names both a
// and b, each as a member or a candidate. Coordinate routes a frame only
// between such peers (D3): a node or relay of one policy must not reach the
// members of another, whose leases it could otherwise disturb.
func (v *memberView) shares(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	for _, manifest := range v.manifests {
		if manifest.names(a) && manifest.names(b) {
			return true
		}
	}
	return false
}

func (m viewManifest) names(id string) bool {
	_, member := m.members[id]
	return member || m.candidates[id]
}

func (v *memberView) manifest(policyID string) (viewManifest, bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	manifest, ok := v.manifests[policyID]
	return manifest, ok
}

func (v *memberView) policyIDs() []string {
	v.mu.RLock()
	defer v.mu.RUnlock()
	ids := make([]string, 0, len(v.manifests))
	for id := range v.manifests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (v *memberView) keyIDs() []string {
	v.mu.RLock()
	defer v.mu.RUnlock()
	ids := make([]string, 0, len(v.keys))
	for id := range v.keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func blockMessage(domain string, payload []byte) []byte {
	message := append([]byte(domain), 0)
	return append(message, payload...)
}

func rotationMessage(keyID string, publicKey []byte) []byte {
	message := append([]byte(domainKeyRotation), 0)
	message = binary.BigEndian.AppendUint32(message, uint32(len(keyID)))
	message = append(message, keyID...)
	return append(message, publicKey...)
}

func keyFingerprint(publicKey []byte) string {
	digest := sha256.Sum256(publicKey)
	return "sha256:" + hex.EncodeToString(digest[:])
}
