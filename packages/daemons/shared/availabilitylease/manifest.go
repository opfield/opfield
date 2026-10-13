package availabilitylease

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Manifest is a verified per-policy lease manifest (D4) with the policy's own
// voter set (A18).
type Manifest struct {
	block    *pb.LeaseSignedBlock
	PolicyID string
	Version  uint64
	// Epoch is the policy's voter epoch; Voters is the voter config of it.
	Epoch     uint64
	Voters    *VoterConfig
	Available bool
	// Stateful: every key carries a certified holder state (v3). Strict only.
	Stateful   bool
	Slots      uint32
	Closed     bool
	Candidates []string
	rank       map[string]int
	keys       map[string][]byte
	// BootstrapID and Bootstrap name the reserved initial holder per slot (A5).
	BootstrapID uint64
	Bootstrap   map[uint32]string
	// bootstrapSince is the first adopted version that carries BootstrapID:
	// only commits formed under it or later satisfy the reservation. A
	// manifest restored from the store starts at its own version (safe: the
	// reservation then waits for a commit under it).
	bootstrapSince uint64
	// Retained names, per slot of a closed manifest, the holder that keeps
	// its copy running once a majority of every quorum set confirmed the
	// close to it (graceful close, retain.go).
	Retained map[uint32]RetainedHolder
}

// RetainedHolder is a closed manifest's retained holder of one slot.
type RetainedHolder struct {
	Holder string
	// Ballot is the holder's committed ballot Gateway saw when it closed.
	Ballot Ballot
}

func parseManifest(block *pb.LeaseSignedBlock) (*Manifest, error) {
	if block.GetKind() != pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
		return nil, errors.New("lease block is not a manifest")
	}
	value := &pb.LeaseManifest{}
	if err := proto.Unmarshal(block.GetPayload(), value); err != nil {
		return nil, fmt.Errorf("decode lease manifest: %w", err)
	}
	if value.GetSchemaVersion() != 1 || value.GetPolicyId() == "" || value.GetManifestVersion() == 0 {
		return nil, errors.New("lease manifest scope is invalid")
	}
	if term := value.GetLeaseTermMs(); term != 0 && int64(term) != LeaseTerm.Milliseconds() {
		return nil, fmt.Errorf("lease manifest term %dms differs from the fixed %s", term, LeaseTerm)
	}
	mode := value.GetMode()
	if mode != pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER && mode != pb.LeasePolicyMode_LEASE_POLICY_MODE_REPLICATED {
		return nil, errors.New("lease manifest mode is invalid")
	}
	partition := value.GetPartitionMode()
	if partition != pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT && partition != pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE {
		return nil, errors.New("lease manifest partition mode is invalid")
	}
	if value.GetStateful() && partition == pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE {
		// AS8: a minority certificate would certify a state no later majority
		// has to see; stateful policies are strict only.
		return nil, errors.New("stateful lease manifest must use the strict partition mode")
	}
	slots := value.GetSlots()
	if slots == 0 || (mode == pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER && slots != 1) || slots > 32 {
		return nil, errors.New("lease manifest slot count is invalid")
	}
	manifest := &Manifest{
		block: block, PolicyID: value.GetPolicyId(), Version: value.GetManifestVersion(), Epoch: value.GetVoterEpoch(),
		Available: partition == pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE,
		Stateful:  value.GetStateful(), Slots: slots, Closed: value.GetClosed(),
		rank: map[string]int{}, keys: map[string][]byte{},
		BootstrapID: value.GetBootstrapId(), Bootstrap: map[uint32]string{}, Retained: map[uint32]RetainedHolder{},
		bootstrapSince: value.GetManifestVersion(),
	}
	for _, candidate := range value.GetCandidates() {
		if candidate.GetId() == "" || len(candidate.GetPublicKey()) == 0 {
			return nil, errors.New("lease manifest candidate is invalid")
		}
		if _, exists := manifest.rank[candidate.GetId()]; exists {
			return nil, fmt.Errorf("duplicate lease candidate %q", candidate.GetId())
		}
		manifest.rank[candidate.GetId()] = len(manifest.Candidates)
		manifest.Candidates = append(manifest.Candidates, candidate.GetId())
		manifest.keys[candidate.GetId()] = append([]byte(nil), candidate.GetPublicKey()...)
	}
	if len(manifest.Candidates) == 0 && !manifest.Closed {
		return nil, errors.New("lease manifest has no candidates")
	}
	for _, entry := range value.GetBootstrap() {
		if manifest.BootstrapID == 0 || entry.GetSlot() >= slots {
			return nil, errors.New("lease manifest bootstrap is invalid")
		}
		if _, ok := manifest.rank[entry.GetHolderId()]; !ok {
			return nil, errors.New("lease manifest bootstrap holder is not a candidate")
		}
		manifest.Bootstrap[entry.GetSlot()] = entry.GetHolderId()
	}
	if manifest.Closed {
		for _, entry := range value.GetRetained() {
			holder := entry.GetHolderId()
			if entry.GetSlot() >= slots || holder == "" {
				return nil, errors.New("lease manifest retained holder is invalid")
			}
			if _, ok := manifest.rank[holder]; !ok {
				return nil, errors.New("lease manifest retained holder is not a candidate")
			}
			if _, dup := manifest.Retained[entry.GetSlot()]; dup {
				return nil, fmt.Errorf("lease manifest names two retained holders for slot %d", entry.GetSlot())
			}
			ballot := ballotFromProto(entry.GetBallot())
			if !ballot.IsZero() && ballot.Proposer != holder {
				return nil, errors.New("lease manifest retained ballot is not the holder's")
			}
			manifest.Retained[entry.GetSlot()] = RetainedHolder{Holder: holder, Ballot: ballot}
		}
	}
	voters, err := newVoterConfig(manifest.PolicyID, value.GetVoterEpoch(), value.GetMembers(), value.GetQuorumSets(), manifest.Closed)
	if err != nil {
		return nil, err
	}
	for id, member := range voters.members {
		if key, ok := manifest.keys[id]; ok && !bytes.Equal(key, member.GetPublicKey()) {
			return nil, fmt.Errorf("lease member %q has another key than its candidate entry", id)
		}
	}
	manifest.Voters = voters
	return manifest, nil
}

func (m *Manifest) isCandidate(id string) bool {
	_, ok := m.rank[id]
	return ok
}

// names reports whether id is a candidate or a coordination member of the
// policy.
func (m *Manifest) names(id string) bool {
	return m.isCandidate(id) || (m.Voters != nil && m.Voters.isMember(id))
}

// retains reports whether this closed manifest names id the retained holder
// of slot and can confirm it: it has at least one quorum set to count a
// majority in.
func (m *Manifest) retains(slot uint32, id string) bool {
	if m == nil || !m.Closed || m.Voters == nil || len(m.Voters.sets) == 0 {
		return false
	}
	retained, ok := m.Retained[slot]
	return ok && retained.Holder == id
}

// maxVoters caps a policy's voter set (A18).
const maxVoters = 7

// VoterConfig is the verified voter set of one policy at one epoch (A18).
// Two quorum sets mean a joint-consensus change (D2, A4): every quorum needs a
// majority of each. Members outside every quorum set (relays that are not
// the witness) only record shadow accepts for the relay gate (A11).
type VoterConfig struct {
	PolicyID string
	Epoch    uint64
	members  map[string]*pb.LeaseMember
	sets     [][]string
	voters   map[string]bool
	// memberIDs and relayIDs are sorted so message fan-out is deterministic.
	memberIDs []string
	relayIDs  []string
	voterIDs  []string
}

func newVoterConfig(policyID string, epoch uint64, members []*pb.LeaseMember, sets []*pb.LeaseQuorumSet, closed bool) (*VoterConfig, error) {
	config := &VoterConfig{PolicyID: policyID, Epoch: epoch, members: map[string]*pb.LeaseMember{}, voters: map[string]bool{}}
	if closed && len(sets) == 0 {
		return config, nil
	}
	if epoch == 0 {
		return nil, errors.New("lease manifest voter epoch is missing")
	}
	for _, member := range members {
		if member.GetId() == "" || len(member.GetPublicKey()) == 0 {
			return nil, errors.New("lease member is invalid")
		}
		if _, exists := config.members[member.GetId()]; exists {
			return nil, fmt.Errorf("duplicate lease member %q", member.GetId())
		}
		config.members[member.GetId()] = member
		config.memberIDs = append(config.memberIDs, member.GetId())
		if member.GetRole() == pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY {
			config.relayIDs = append(config.relayIDs, member.GetId())
		}
	}
	if n := len(sets); n != 1 && n != 2 {
		return nil, errors.New("lease voters need one quorum set, or two while joint")
	}
	for _, set := range sets {
		seen := map[string]bool{}
		for _, id := range set.GetVoterIds() {
			if config.members[id] == nil || seen[id] {
				return nil, fmt.Errorf("lease quorum set voter %q is invalid", id)
			}
			seen[id] = true
			config.voters[id] = true
		}
		if len(seen) == 0 || len(seen) > maxVoters {
			return nil, fmt.Errorf("lease quorum set has %d voters, want 1..%d", len(seen), maxVoters)
		}
		config.sets = append(config.sets, append([]string(nil), set.GetVoterIds()...))
	}
	sort.Strings(config.memberIDs)
	sort.Strings(config.relayIDs)
	config.voterIDs = sortedKeys(config.voters)
	return config, nil
}

// quorum reports whether ids hold a majority of every quorum set.
func (c *VoterConfig) quorum(ids map[string]bool) bool {
	for _, set := range c.sets {
		count := 0
		for _, id := range set {
			if ids[id] {
				count++
			}
		}
		if count*2 <= len(set) {
			return false
		}
	}
	return true
}

// quorumImpossible reports whether refused ids make a quorum unreachable.
func (c *VoterConfig) quorumImpossible(refused map[string]bool) bool {
	for _, set := range c.sets {
		count := 0
		for _, id := range set {
			if refused[id] {
				count++
			}
		}
		if count*2 >= len(set) {
			return true
		}
	}
	return false
}

func (c *VoterConfig) isVoter(id string) bool { return c.voters[id] }

// isMember reports whether id is one of the policy's coordination members
// (voters and serving relays, A18).
func (c *VoterConfig) isMember(id string) bool { return c.members[id] != nil }

func (c *VoterConfig) isRelay(id string) bool {
	member := c.members[id]
	return member != nil && member.GetRole() == pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
}

func (c *VoterConfig) publicKey(id string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	member := c.members[id]
	if member == nil {
		return nil, false
	}
	return member.GetPublicKey(), true
}
