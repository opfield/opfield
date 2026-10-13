package availabilitylease

import (
	"crypto/ed25519"
	"fmt"
	"math/rand"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// simOpfield builds and signs per-policy manifests, each carrying the
// policy's own voter set (A18), with the policy key, delivers them over "CommandStream" (direct calls, possibly partial),
// rotates keys and drives planned handoffs. It may die at any time.
type simOpfield struct {
	w     *simWorld
	alive bool

	keys     []simPolicyKey
	signIdx  int
	links    []*pb.LeasePolicyKeyRotation
	policies map[string]*simPolicy
	deliverP float64
}

type simPolicyKey struct {
	id   string
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

type simPolicy struct {
	id         string
	version    uint64
	available  bool
	stateful   bool
	slots      uint32
	candidates []string
	closed     bool
	// retained names the retained holder per slot of a closed manifest;
	// adopted is Opfield's placement per slot adopted as running when a
	// close retained it (kept across later closes until another holder).
	retained map[uint32]RetainedHolder
	adopted  map[uint32]string
	// bootstrapAt is when the current bootstrap reservation was issued.
	bootstrapAt time.Duration
	bootstrapID uint64
	bootstrap   map[uint32]string
	block       *pb.LeaseSignedBlock
	// Per-policy voters (A18): epoch, quorum sets (two while joint) and
	// non-voting relay members for the gate's shadow accepts.
	epoch      uint64
	sets       [][]string
	joint      bool
	jointAcked time.Duration
	// keys overrides identity keys listed in this policy's manifest, for
	// identity-key rotations that reach policies at different times.
	keys map[string][]byte
}

func newSimOpfield(w *simWorld) *simOpfield {
	g := &simOpfield{w: w, alive: true, policies: map[string]*simPolicy{}, deliverP: 1}
	g.keys = append(g.keys, g.newKey(1))
	return g
}

func (g *simOpfield) newKey(n int) simPolicyKey {
	seed := make([]byte, ed25519.SeedSize)
	rand.New(rand.NewSource(g.w.seed*31 + int64(n))).Read(seed)
	priv := ed25519.NewKeyFromSeed(seed)
	return simPolicyKey{id: fmt.Sprintf("policy-key-%d", n), priv: priv, pub: priv.Public().(ed25519.PublicKey)}
}

// key is the signing key: a rotated key is used only after a majority of
// voters acked it (A14).
func (g *simOpfield) key() simPolicyKey { return g.keys[g.signIdx] }

func (g *simOpfield) policyKey(p *simPolicy, id string) []byte {
	if key, ok := p.keys[id]; ok {
		return key
	}
	return g.publicKey(id)
}

func (g *simOpfield) publicKey(id string) []byte {
	if n := g.w.nodes[id]; n != nil && g.w.wire {
		return n.wirePublicKey()
	}
	return []byte("pk:" + id)
}

func (g *simOpfield) buildManifest(p *simPolicy) *pb.LeaseSignedBlock {
	p.version++
	value := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: p.id, ManifestVersion: p.version, Slots: p.slots, VoterEpoch: p.epoch,
		Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		Closed: p.closed, BootstrapId: p.bootstrapID, LeaseTermMs: 30000, Stateful: p.stateful,
	}
	if p.slots > 1 {
		value.Mode = pb.LeasePolicyMode_LEASE_POLICY_MODE_REPLICATED
	}
	if p.available {
		value.PartitionMode = pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE
	}
	for _, id := range p.candidates {
		value.Candidates = append(value.Candidates, &pb.LeaseCandidate{Id: id, PublicKey: g.policyKey(p, id)})
	}
	for slot := uint32(0); slot < p.slots; slot++ {
		if holder := p.bootstrap[slot]; holder != "" {
			value.Bootstrap = append(value.Bootstrap, &pb.LeaseBootstrapSlot{Slot: slot, HolderId: holder})
		}
		if retained, ok := p.retained[slot]; ok && p.closed {
			value.Retained = append(value.Retained, &pb.LeaseRetainedSlot{Slot: slot, HolderId: retained.Holder, Ballot: retained.Ballot.proto()})
		}
	}
	members := map[string]bool{}
	for _, id := range g.w.relays {
		members[id] = true
	}
	for _, set := range p.sets {
		for _, id := range set {
			members[id] = true
		}
		value.QuorumSets = append(value.QuorumSets, &pb.LeaseQuorumSet{VoterIds: set})
	}
	for _, id := range sortedKeys(members) {
		role := pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON
		if g.w.nodes[id].relay {
			role = pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
		}
		value.Members = append(value.Members, &pb.LeaseMember{Id: id, PublicKey: g.policyKey(p, id), Role: role})
	}
	payload, _ := proto.Marshal(value)
	key := g.key()
	p.block = SignPolicyBlock(key.id, key.priv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
	return p.block
}

// deliver pushes a block to up nodes; each delivery succeeds with deliverP.
func (g *simOpfield) deliver(block *pb.LeaseSignedBlock, p float64) {
	if !g.alive {
		return
	}
	for _, id := range g.w.ids {
		n := g.w.nodes[id]
		if !n.processUp() || n.frozen || g.w.rng.Float64() >= p {
			continue
		}
		g.adopt(n, block)
		n.after()
	}
}

func (g *simOpfield) adopt(n *simNode, block *pb.LeaseSignedBlock) {
	g.sendChain(n)
	if _, err := n.node.AdoptManifest(block); err != nil {
		g.w.fail("gateway delivery to %s: %v", n.id, err)
	}
}

// onNodeStart models enrollment trust plus, while Opfield is up, the
// CommandStream / policy snapshot redelivery on reconnect.
func (g *simOpfield) onNodeStart(n *simNode) {
	first := g.keys[0]
	if err := n.node.TrustPolicyKey(first.id, first.pub); err != nil {
		g.w.fail("trust: %v", err)
	}
	for _, id := range sortedKeys(g.policies) {
		n.node.SetCandidateReady(id, n.ready)
	}
	if !g.alive || g.w.rng.Float64() >= g.deliverP {
		return
	}
	g.sendChain(n)
	for _, id := range sortedKeys(g.policies) {
		if block := g.policies[id].block; block != nil {
			g.adopt(n, block)
		}
	}
}

// sendChain delivers every rotation link in order over the authenticated
// channel.
func (g *simOpfield) sendChain(n *simNode) {
	// CommandStream is authenticated: Opfield hands over its signing key
	// directly (A4); links let the node forward the chain to lagging peers.
	if err := n.node.TrustPolicyKey(g.key().id, g.key().pub); err != nil {
		g.w.fail("trust %s: %v", n.id, err)
	}
	for _, link := range g.links {
		_ = n.node.AdoptKeyRotation(link)
	}
}

// resign re-signs the current manifests with the signing key after a
// rotation was acked, so peers that only trust the new key can verify blocks
// forwarded to them.
func (g *simOpfield) resign() {
	key := g.key()
	for _, id := range sortedKeys(g.policies) {
		if p := g.policies[id]; p.block != nil {
			p.block = SignPolicyBlock(key.id, key.priv, p.block.GetKind(), p.block.GetPayload())
			g.deliver(p.block, 1)
		}
	}
}

// rotateKey introduces a new policy key via a signed link. Opfield only
// signs with it after a majority of voters trust it (A14); acked reports that.
func (g *simOpfield) rotateKey(deliverP float64) {
	if !g.alive {
		return
	}
	previous := g.keys[len(g.keys)-1]
	next := g.newKey(len(g.keys) + 1)
	link := SignPolicyKeyRotation(previous.id, previous.priv, next.id, next.pub)
	g.links = append(g.links, link)
	g.keys = append(g.keys, next)
	for _, id := range g.w.ids {
		n := g.w.nodes[id]
		if n.processUp() && !n.frozen && g.w.rng.Float64() < deliverP {
			g.sendChain(n)
		}
	}
	g.w.tracef("gateway rotates policy key to %s", next.id)
	index := len(g.keys) - 1
	var poll func()
	poll = func() {
		if !g.alive || g.signIdx >= index {
			return
		}
		if g.keyAckedByMajority(next.id) {
			g.signIdx = index
			g.w.tracef("gateway signs with %s", next.id)
			g.resign()
			return
		}
		g.w.after(time.Second, poll)
	}
	g.w.after(time.Second, poll)
}

func (g *simOpfield) keyAckedByMajority(keyID string) bool {
	acked := map[string]bool{}
	for _, id := range g.w.ids {
		if n := g.w.nodes[id]; n.processUp() && n.node.TrustsPolicyKey(keyID) {
			acked[id] = true
		}
	}
	for _, policyID := range sortedKeys(g.policies) {
		for _, set := range g.policies[policyID].sets {
			count := 0
			for _, id := range set {
				if acked[id] {
					count++
				}
			}
			if count*2 <= len(set) {
				return false
			}
		}
	}
	return true
}

// adoptedBy reports whether a majority of set persisted the policy's epoch.
func (g *simOpfield) adoptedBy(policyID string, set []string, epoch uint64) bool {
	count := 0
	for _, id := range set {
		if n := g.w.nodes[id]; n.processUp() && n.node.Epoch(policyID) >= epoch {
			count++
		}
	}
	return count*2 > len(set)
}

// changeVoters changes one policy's voters (a candidate or witness change)
// through a joint epoch (old, new) and settles it once a majority of both
// persisted it and T x 1.1 at the slowest clock passed (A4, A16, A18).
func (g *simOpfield) changeVoters(policyID string, next []string, deliverP float64) {
	p := g.policies[policyID]
	if !g.alive || p.joint {
		return
	}
	old := p.sets[0]
	p.epoch++
	p.sets, p.joint, p.jointAcked = [][]string{old, next}, true, 0
	jointEpoch := p.epoch
	g.deliver(g.buildManifest(p), deliverP)
	g.w.tracef("gateway %s joint epoch %d old=%v new=%v", policyID, jointEpoch, old, next)
	var poll func()
	poll = func() {
		if !g.alive {
			return
		}
		if p.jointAcked == 0 {
			// Stateful policies settle only after a live holder renewed
			// under the joint epoch (AS1); without one they stay joint.
			if g.adoptedBy(policyID, old, jointEpoch) && g.adoptedBy(policyID, next, jointEpoch) &&
				(!p.stateful || g.renewedUnder(policyID, jointEpoch)) {
				p.jointAcked = g.w.now
			} else {
				g.deliver(p.block, 1)
			}
		}
		if p.jointAcked != 0 && g.w.now >= p.jointAcked+AcceptorHold*10/9+2*time.Second {
			p.epoch++
			p.sets, p.joint = [][]string{next}, false
			g.deliver(g.buildManifest(p), deliverP)
			g.w.tracef("gateway %s settles epoch %d voters=%v", policyID, p.epoch, next)
			g.redeliverUntilAdopted(policyID, p.epoch, next, deliverP)
			return
		}
		g.w.after(time.Second, poll)
	}
	g.w.after(time.Second, poll)
}

// redeliverUntilAdopted sends the settled manifest again every second until
// every running member of the new voter set adopted its epoch, as the
// Opfield's distribution does (a daemon that has not reported the applied
// revision gets it again after a short retry interval; relays get every
// policy snapshot). Without it a settle lost on the way to every live new
// voter could never be learned: only members forward a policy's blocks.
func (g *simOpfield) redeliverUntilAdopted(policyID string, epoch uint64, voters []string, deliverP float64) {
	var poll func()
	poll = func() {
		p := g.policies[policyID]
		if !g.alive || p.epoch != epoch {
			return
		}
		missing := false
		for _, id := range voters {
			if n := g.w.nodes[id]; n.processUp() && n.node.Epoch(policyID) < epoch {
				missing = true
			}
		}
		if !missing {
			return
		}
		g.deliver(p.block, deliverP)
		g.w.after(time.Second, poll)
	}
	g.w.after(time.Second, poll)
}

// renewedUnder reports whether a live holder of every key of a policy
// reported a commit under epoch, like the lease reports' HeldCommit.
func (g *simOpfield) renewedUnder(policyID string, epoch uint64) bool {
	for _, key := range g.w.keys {
		if key.PolicyID != policyID {
			continue
		}
		holder := g.w.holder(key)
		if holder == "" {
			return false
		}
		if held, _, ok := g.w.nodes[holder].node.HeldCommit(key); !ok || held < epoch {
			return false
		}
	}
	return true
}

func (g *simOpfield) republish(policyID string, deliverP float64) {
	if !g.alive {
		return
	}
	g.deliver(g.buildManifest(g.policies[policyID]), deliverP)
}

// closeLease publishes a closed manifest that names, per slot, the holder the
// Opfield sees (graceful close); stale makes it name another candidate.
func (g *simOpfield) closeLease(policyID string, stale bool, deliverP float64) {
	p := g.policies[policyID]
	if !g.alive || p.closed {
		return
	}
	p.closed, p.retained = true, map[uint32]RetainedHolder{}
	for slot := uint32(0); slot < p.slots; slot++ {
		key := Key{PolicyID: policyID, Slot: slot}
		for _, id := range p.candidates {
			n := g.w.nodes[id]
			if !n.processUp() || n.node == nil {
				continue
			}
			if st := n.node.HolderStatus(key); st.Holding {
				holder := RetainedHolder{Holder: id, Ballot: st.Ballot}
				if stale {
					// A stale view names another node for the slot. The
					// simulator keys copies by slot, so it never names a node
					// that runs another slot's copy (on a real node that
					// copy is simply its one placement of the policy).
					for _, other := range p.candidates {
						if other != id && !g.runsOtherSlot(p, other, slot) {
							holder = RetainedHolder{Holder: other}
							break
						}
					}
				}
				p.retained[slot] = holder
			}
		}
	}
	if p.adopted == nil {
		p.adopted = map[uint32]string{}
	}
	for slot := uint32(0); slot < p.slots; slot++ {
		// The placement the Opfield records as running: the retained holder,
		// else a pending bootstrap holder's legacy copy (D1), else the one
		// recorded before.
		if holder, ok := p.retained[slot]; ok {
			p.adopted[slot] = holder.Holder
		} else if holder := p.bootstrap[slot]; holder != "" {
			p.adopted[slot] = holder
		}
	}
	g.w.tracef("gateway closes %s retained=%v", policyID, p.retained)
	g.deliver(g.buildManifest(p), deliverP)
}

// reopenLease enters lease mode again: the node running a slot's copy is its
// bootstrap holder (D1), a slot without a running copy has none.
func (g *simOpfield) reopenLease(policyID string, deliverP float64) {
	p := g.policies[policyID]
	if !g.alive || !p.closed {
		return
	}
	p.closed, p.retained = false, nil
	p.bootstrapID++
	p.bootstrap = map[uint32]string{}
	named := map[string]bool{} // one slot per node
	for slot := uint32(0); slot < p.slots; slot++ {
		key := Key{PolicyID: policyID, Slot: slot}
		// D1: the node running the slot's copy. Opfield adopted a retained
		// holder's placement as running, so it names that node (even while
		// its daemon is restarting) unless its host went down, which ends a
		// lease-mode container; otherwise the copy a reachable node reports.
		reporting := func(id string) bool {
			n := g.w.nodes[id]
			return n.hostUp && n.processUp() && !n.frozen && n.node != nil
		}
		if holder, ok := p.adopted[slot]; ok {
			if n := g.w.nodes[holder]; n.hostUp && !named[holder] {
				p.bootstrap[slot], named[holder] = holder, true
				continue
			}
			delete(p.adopted, slot)
		}
		for _, id := range p.candidates {
			if c := g.w.nodes[id].containers[key]; reporting(id) && c != nil && c.live && !named[id] {
				p.bootstrap[slot], named[id] = id, true
				break
			}
		}
	}
	p.bootstrapAt = g.w.now
	g.w.tracef("gateway reopens %s bootstrap=%v", policyID, p.bootstrap)
	g.deliver(g.buildManifest(p), deliverP)
	if policyID == "p1" && len(p.bootstrap) > 0 {
		g.w.after(5*time.Second, func() { opfieldBootstrapLoop(g.w) })
	}
}

// runsOtherSlot reports whether id has a copy of another slot of the policy.
func (g *simOpfield) runsOtherSlot(p *simPolicy, id string, slot uint32) bool {
	n := g.w.nodes[id]
	for other := uint32(0); other < p.slots; other++ {
		if other == slot {
			continue
		}
		if c := n.containers[Key{PolicyID: p.id, Slot: other}]; c != nil && (c.live || c.starting) {
			return true
		}
	}
	return false
}
