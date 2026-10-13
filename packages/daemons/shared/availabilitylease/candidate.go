package availabilitylease

import (
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

func (n *Node) tickCandidate(pk *proposerKey, manifest *Manifest, now time.Duration) {
	if manifest == nil || manifest.Closed || !manifest.isCandidate(n.id) || !n.ready[manifest.PolicyID] || pk.key.Slot >= manifest.Slots ||
		(manifest.Stateful && n.handlers[manifest.PolicyID] == nil) {
		pk.role = RoleNone
		return
	}
	forced := manifest.Stateful && n.activeForce(pk, now) != nil
	pk.role = RoleCandidate
	if pk.round != nil || now < pk.nextRoundAt {
		return
	}
	reserved := false
	if holder, ok := manifest.Bootstrap[pk.key.Slot]; ok && pk.bootstrapDone != manifest.BootstrapID &&
		!(pk.commit != nil && bootstrapSatisfiedBy(manifest, pk.key, pk.commit)) {
		if holder == n.id && !n.holdsOtherSlot(pk.key) {
			n.startRound(pk, manifest, RoleBootstrapping, now)
			return
		}
		// The named holder may have missed the manifest while Opfield
		// is gone; hand it over so it can acquire (A5). Keep observing to
		// learn its commit, which lifts the reservation.
		n.forwardOnce(holder, manifest.PolicyID)
		reserved = true
	}
	// One slot per node (anti-affinity): no path acquires a slot while this
	// node holds, recovers, fences or releases another slot of the policy,
	// designated successor or not.
	if n.holdsOtherSlot(pk.key) {
		pk.designated = false
		return
	}
	if pk.designated && now < pk.designatedUntil && !reserved {
		if manifest.Stateful && !forced && !n.queryEligible(pk, manifest, now) {
			// A stateful successor proves eligibility from fresh statuses
			// before it prepares.
			if now >= pk.nextQueryAt {
				n.sendQuery(pk.key)
				pk.nextQueryAt = now + queryInterval
			}
			return
		}
		n.startRound(pk, manifest, RoleAcquiring, now)
		return
	}
	pk.designated = false
	if pk.hasFreshCommit && pk.commitBallot.Proposer != n.id && now-pk.freshCommitAt < commitQuietPeriod {
		pk.expiredSeen = false
		return
	}
	if now >= pk.nextQueryAt {
		n.sendQuery(pk.key)
		pk.nextQueryAt = now + queryInterval
	}
	if reserved || !n.expiredOnQuorum(pk, manifest, now) {
		pk.expiredSeen = false
		return
	}
	if !pk.expiredSeen {
		pk.expiredSeen, pk.expiredSince = true, now
	}
	if forced || now >= pk.expiredSince+time.Duration(n.rank(pk, manifest))*RankStep {
		// Stateful: an ineligible candidate never prepares, so it does not
		// duel with an eligible one; a forced acquisition skips only this
		// check and the rank delay (AS10).
		if manifest.Stateful && !forced && !n.queryEligible(pk, manifest, now) {
			return
		}
		n.startRound(pk, manifest, RoleAcquiring, now)
	}
}

func (n *Node) sendQuery(key Key) {
	config := n.policyConfig(key.PolicyID)
	if config == nil {
		return
	}
	for _, id := range config.memberIDs {
		n.forwardOnce(id, key.PolicyID)
		n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Query{Query: &pb.LeaseQuery{Keys: []*pb.LeaseKey{key.proto()}}}})
	}
}

// holdsOtherSlot keeps one replica per node: it is true while this node
// holds, acquires or fences another slot of the policy, or is the named
// bootstrap holder of another slot (its legacy copy runs there).
func (n *Node) holdsOtherSlot(key Key) bool {
	if manifest := n.manifests[key.PolicyID]; manifest != nil {
		for slot, holder := range manifest.Bootstrap {
			if slot != key.Slot && holder == n.id {
				if pk := n.proposers[Key{PolicyID: key.PolicyID, Slot: slot}]; pk == nil || pk.bootstrapDone != manifest.BootstrapID {
					return true
				}
			}
		}
	}
	for other, pk := range n.proposers {
		if other.PolicyID == key.PolicyID && other.Slot != key.Slot {
			switch pk.role {
			case RoleCandidate, RoleNone:
			default:
				return true
			}
		}
	}
	return false
}

// expiredOnQuorum decides whether the key looks free: a fresh FREE (or
// reserved-for-us) observation from a majority of every quorum set; in
// available mode every fresh observation is free and a voting relay answered.
func (n *Node) expiredOnQuorum(pk *proposerKey, manifest *Manifest, now time.Duration) bool {
	config := manifest.Voters
	if config == nil {
		return false
	}
	free := map[string]bool{}
	fresh, relay := 0, false
	for _, id := range sortedKeys(pk.obs) {
		obs := pk.obs[id]
		if now-obs.at > observationMaxAge || !config.isVoter(id) {
			continue
		}
		fresh++
		// Our own leftover lease counts as free for us: acceptors accept
		// the same proposer again.
		ok := obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_FREE ||
			(obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_RESERVED && obs.reservedFor == n.id) ||
			(obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_HELD && obs.holder == n.id)
		if ok {
			free[id] = true
			relay = relay || config.isRelay(id)
		}
	}
	if config.quorum(free) {
		return true
	}
	return manifest.Available && relay && len(free) == fresh
}

// rank is the manifest rank among candidates (D5), skipping holders of the
// policy's other slots, which never compete for this one, and a holder that
// just released this key (it stopped its copy and does not take it back).
func (n *Node) rank(pk *proposerKey, manifest *Manifest) int {
	skip := map[string]bool{}
	for key, other := range n.proposers {
		if key.PolicyID == pk.key.PolicyID && key.Slot != pk.key.Slot && other.commit != nil && other.hasFreshCommit {
			skip[other.commitBallot.Proposer] = true
		}
	}
	if pk.releasedBy != "" && n.clock.Now() < pk.releasedAt+SuccessorWindow {
		skip[pk.releasedBy] = true
	}
	// Slot affinity: a node whose own last slot of the policy is free takes
	// that one first, so slots do not swap between nodes after a restart.
	penalty := 0
	if pk.commit == nil || pk.commitBallot.Proposer != n.id {
		for key, other := range n.proposers {
			if key.PolicyID == pk.key.PolicyID && key.Slot != pk.key.Slot && other.commit != nil && other.commitBallot.Proposer == n.id {
				penalty = len(manifest.Candidates)
				break
			}
		}
	}
	rank := penalty
	for _, id := range manifest.Candidates {
		if id == n.id {
			break
		}
		if !skip[id] {
			rank++
		}
	}
	return rank
}
