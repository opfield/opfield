package availabilitylease

// ManifestInfo is a read-only copy of an adopted manifest for the docker
// daemon: which policies are in lease mode after a restart (A2.3), whether
// this node is a candidate, and the bootstrap reservation (A5).
type ManifestInfo struct {
	PolicyID string
	Version  uint64
	// Epoch is the policy's voter epoch (A18).
	Epoch uint64
	// Voters are the policy's voters across its quorum sets (A18).
	Voters    []string
	Available bool
	// Stateful: the policy's keys carry certified holder state (v3).
	Stateful    bool
	Closed      bool
	Slots       uint32
	Candidates  []string
	BootstrapID uint64
	Bootstrap   map[uint32]string
	// Retained names the retained holder per slot of a closed manifest.
	Retained map[uint32]string
}

// RetainedSlot returns the slot this closed manifest names id the retained
// holder of.
func (m ManifestInfo) RetainedSlot(id string) (uint32, bool) {
	for slot, holder := range m.Retained {
		if holder == id {
			return slot, true
		}
	}
	return 0, false
}

// IsVoter reports whether id votes for this policy (A18).
func (m ManifestInfo) IsVoter(id string) bool {
	for _, voter := range m.Voters {
		if voter == id {
			return true
		}
	}
	return false
}

// IsCandidate reports whether id is listed as a candidate.
func (m ManifestInfo) IsCandidate(id string) bool {
	for _, candidate := range m.Candidates {
		if candidate == id {
			return true
		}
	}
	return false
}

// Manifests lists every adopted manifest, sorted by policy id. It only reads
// state and changes nothing in the protocol.
func (n *Node) Manifests() []ManifestInfo {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]ManifestInfo, 0, len(n.manifests))
	for _, policyID := range sortedKeys(n.manifests) {
		out = append(out, manifestInfo(n.manifests[policyID]))
	}
	return out
}

// ManifestInfo returns the adopted manifest of a policy.
func (n *Node) ManifestInfo(policyID string) (ManifestInfo, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	manifest := n.manifests[policyID]
	if manifest == nil {
		return ManifestInfo{}, false
	}
	return manifestInfo(manifest), true
}

// BootstrapPending reports whether this node is the named initial holder of
// key and the reservation was not yet satisfied by any commit (A5). While it
// is pending, the node's legacy copy keeps running without a lease.
func (n *Node) BootstrapPending(key Key) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	manifest := n.manifests[key.PolicyID]
	if manifest == nil || manifest.Closed || manifest.BootstrapID == 0 || manifest.Bootstrap[key.Slot] != n.id {
		return false
	}
	pk := n.proposers[key]
	if pk == nil {
		return true
	}
	if pk.bootstrapDone == manifest.BootstrapID {
		return false
	}
	return pk.commit == nil || !bootstrapSatisfiedBy(manifest, key, pk.commit)
}

// HeldCommit returns the epoch and manifest version of this node's latest
// committed round of key, for lease reports (A4 settlement).
func (n *Node) HeldCommit(key Key) (epoch, manifestVersion uint64, ok bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	pk := n.proposers[key]
	if pk == nil || pk.commit == nil || pk.commitBallot.Proposer != n.id {
		return 0, 0, false
	}
	return pk.commit.GetEpoch(), pk.commit.GetManifestVersion(), true
}

// TrustedPolicyKeyIDs lists the policy keys of the persisted chain, oldest
// first, for the A14 acks in lease reports.
func (n *Node) TrustedPolicyKeyIDs() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	ids := make([]string, 0, len(n.chain.keys))
	for _, key := range n.chain.keys {
		ids = append(ids, key.ID)
	}
	return ids
}

func manifestInfo(manifest *Manifest) ManifestInfo {
	info := ManifestInfo{
		PolicyID: manifest.PolicyID, Version: manifest.Version, Epoch: manifest.Epoch, Available: manifest.Available, Stateful: manifest.Stateful,
		Closed: manifest.Closed, Slots: manifest.Slots, Candidates: append([]string(nil), manifest.Candidates...),
		BootstrapID: manifest.BootstrapID, Bootstrap: map[uint32]string{}, Retained: map[uint32]string{},
	}
	for slot, holder := range manifest.Bootstrap {
		info.Bootstrap[slot] = holder
	}
	for slot, retained := range manifest.Retained {
		info.Retained[slot] = retained.Holder
	}
	if manifest.Voters != nil {
		info.Voters = append([]string(nil), manifest.Voters.voterIDs...)
	}
	return info
}
