package availabilitylease

import (
	"bytes"
	"errors"
	"fmt"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// configHistory is how many voter configs are kept to verify commits that
// were formed under an earlier epoch.
const configHistory = 4

// TrustPolicyKey trusts a Gateway policy signing key received over an
// authenticated channel: the daemon CommandStream or the relay's verified
// policy envelope (A4).
func (n *Node) TrustPolicyKey(id string, publicKey []byte) error {
	var err error
	n.run(func(time.Duration) {
		var changed bool
		changed, err = n.chain.trust(id, publicKey)
		if changed {
			n.dirtyOther[recordKeyChain] = n.chain.encode()
		}
	})
	return err
}

// AdoptKeyRotation adds a key introduced by a trusted key (A14).
func (n *Node) AdoptKeyRotation(link *pb.LeasePolicyKeyRotation) error {
	var err error
	n.run(func(time.Duration) {
		var changed bool
		changed, err = n.chain.adopt(link)
		if changed {
			n.persistChain()
		}
	})
	return err
}

// AdoptManifest adopts a newer signed policy manifest, which carries the
// policy's voter set (A18). It returns true once the manifest is durably
// adopted; callers ack only after this returns (A4 persisted ack).
func (n *Node) AdoptManifest(block *pb.LeaseSignedBlock) (bool, error) {
	return n.adoptPublic(block, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST)
}

// AdoptForwardedManifest adopts a signed manifest that arrived inside a frame
// from a peer, not from the Gateway: like the blocks of a frame addressed to
// this node, it is adopted only when it names this node or updates a policy
// this node already holds.
func (n *Node) AdoptForwardedManifest(block *pb.LeaseSignedBlock) (bool, error) {
	if block.GetKind() != pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
		return false, errors.New("lease block kind mismatch")
	}
	var changed bool
	var err error
	n.run(func(now time.Duration) { changed, err = n.adoptBlock(block, true, now) })
	return changed, err
}

func (n *Node) adoptPublic(block *pb.LeaseSignedBlock, kind pb.LeaseBlockKind) (bool, error) {
	if block.GetKind() != kind {
		return false, errors.New("lease block kind mismatch")
	}
	var changed bool
	var err error
	n.run(func(now time.Duration) { changed, err = n.adoptBlock(block, false, now) })
	return changed, err
}

// SetCandidateReady marks whether this node may acquire keys of a policy:
// its standby is prepared and its watchdog heartbeat is fresh (A12.4).
func (n *Node) SetCandidateReady(policyID string, ready bool) {
	n.run(func(time.Duration) { n.ready[policyID] = ready })
}

// SetStateHandler registers the application handler of a stateful policy;
// nil unregisters it. A candidate of a stateful policy without a handler
// never acquires; it still votes and accepts as a member.
func (n *Node) SetStateHandler(policyID string, handler *StateHandler) {
	n.run(func(time.Duration) {
		if handler == nil {
			delete(n.handlers, policyID)
			return
		}
		copied := *handler
		n.handlers[policyID] = &copied
	})
}

// LeaseMode reports whether this node holds a lease manifest for the policy
// that is not lease-closed. While true the daemon refuses backend start and
// serve commands for the policy unless it holds the lease (A5 gate).
func (n *Node) LeaseMode(policyID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	manifest := n.manifests[policyID]
	return manifest != nil && !manifest.Closed
}

// ManifestVersion returns the adopted manifest version for a policy.
func (n *Node) ManifestVersion(policyID string) uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	if manifest := n.manifests[policyID]; manifest != nil {
		return manifest.Version
	}
	return 0
}

// Epoch returns the adopted voter epoch of a policy (A18).
func (n *Node) Epoch(policyID string) uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	if manifest := n.manifests[policyID]; manifest != nil {
		return manifest.Epoch
	}
	return 0
}

// TrustsPolicyKey reports whether a policy key is trusted (Gateway acks, A14).
func (n *Node) TrustsPolicyKey(id string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	_, ok := n.chain.lookup(id)
	return ok
}

func (n *Node) persistChain() {
	n.dirtyOther[recordKeyChain] = n.chain.encode()
	for id, link := range n.chain.links {
		data, _ := proto.Marshal(link)
		n.dirtyOther[prefixLink+id] = data
	}
}

// adoptForwarded applies rotation links and blocks carried by a batch.
func (n *Node) adoptForwarded(batch *pb.LeaseBatch, now time.Duration) {
	if len(batch.GetKeyRotations()) > 0 && n.chain.adoptAll(batch.GetKeyRotations()) {
		n.persistChain()
	}
	for _, block := range batch.GetBlocks() {
		if _, err := n.adoptBlock(block, true, now); err != nil {
			n.logf("forwarded lease block rejected: %v", err)
		}
	}
}

// adoptBlock adopts a verified newer manifest. A forwarded one (carried by a
// peer's frame, A4) must name this node or update a policy this node already
// holds: peers forward the blocks they share with the destination, and the
// manifest of an unrelated policy would only add identities that
// authenticate here (D3).
func (n *Node) adoptBlock(block *pb.LeaseSignedBlock, forwarded bool, now time.Duration) (bool, error) {
	data, _ := proto.Marshal(block)
	switch block.GetKind() {
	case pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST:
		manifest, err := parseManifest(block)
		if err != nil {
			return false, err
		}
		if forwarded && n.manifests[manifest.PolicyID] == nil && !manifest.names(n.id) {
			return false, fmt.Errorf("forwarded lease manifest of policy %q does not name this node", manifest.PolicyID)
		}
		if current := n.manifests[manifest.PolicyID]; current != nil && manifest.Version <= current.Version {
			if manifest.Version == current.Version && n.resigned(current.block, block, domainManifest) {
				current.block = block
				n.dirtyOther[prefixManifest+manifest.PolicyID] = data
				n.keyCache = nil
				return true, nil
			}
			return false, nil
		}
		previous := n.manifests[manifest.PolicyID]
		if previous != nil && manifest.Epoch < previous.Epoch && !manifest.Closed {
			return false, fmt.Errorf("lease manifest voter epoch %d goes back from %d", manifest.Epoch, previous.Epoch)
		}
		if previous != nil && previous.Stateful != manifest.Stateful && !previous.Closed && !manifest.Closed {
			// A policy's holder state cannot appear or vanish: the Gateway
			// uses a new policy id instead (M10).
			return false, fmt.Errorf("lease manifest of %s changes whether it is stateful", manifest.PolicyID)
		}
		if err := n.chain.verifyBlock(block, domainManifest); err != nil {
			return false, err
		}
		if previous != nil && previous.BootstrapID == manifest.BootstrapID {
			manifest.bootstrapSince = previous.bootstrapSince
		}
		n.forgetOnJoin(previous, manifest)
		n.manifests[manifest.PolicyID] = manifest
		n.dirtyOther[prefixManifest+manifest.PolicyID] = data
		n.keyCache = nil
		if n.rememberVoters(manifest.Voters) {
			n.dirtyOther[votersRecordName(manifest.PolicyID, manifest.Epoch)] = data
		}
		n.onManifestChanged(previous, manifest, now)
		return true, nil
	}
	return false, errors.New("unknown lease block kind")
}

// resigned reports whether next carries the same payload as current signed by
// a later key of the chain. The Gateway re-signs the current blocks after a
// rotation so peers that only trust newer keys can verify forwarded blocks.
func (n *Node) resigned(current, next *pb.LeaseSignedBlock, domain string) bool {
	if current.GetSigningKeyId() == next.GetSigningKeyId() || !bytes.Equal(current.GetPayload(), next.GetPayload()) {
		return false
	}
	if n.chain.index(next.GetSigningKeyId()) <= n.chain.index(current.GetSigningKeyId()) {
		return false
	}
	return n.chain.verifyBlock(next, domain) == nil
}
