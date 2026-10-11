package availabilitylease

import (
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type observation struct {
	state       pb.LeaseKeyState
	holder      string
	reservedFor string
	at          time.Duration
	// accepted is the acceptor's memory of a stateful key (v3).
	accepted *pb.LeaseAcceptedState
}

// proposerKey is the candidate/holder state of one key on this node.
type proposerKey struct {
	key   Key
	role  Role
	round *round
	// settled is the last round that reached its quorum; members whose
	// promise arrives before its deadline still get the propose.
	settled *round

	ballot        Ballot // last committed ballot of this node
	ownMajority   bool
	lastIssued    Ballot
	maxRound      uint64
	anchor        time.Duration
	deadline      time.Duration
	softAt        time.Duration
	lastProposeAt time.Duration
	retry         bool
	nextRoundAt   time.Duration
	fenceReason   FenceReason

	// commit is the highest valid commit seen for the key, any holder.
	commit          *pb.LeaseCommit
	commitBallot    Ballot
	freshCommitAt   time.Duration
	hasFreshCommit  bool
	obs             map[string]observation
	expiredSeen     bool
	expiredSince    time.Duration
	nextQueryAt     time.Duration
	designatedUntil time.Duration
	designated      bool
	bootstrapDone   uint64
	recoverUntil    time.Duration

	release releaseState
	// retain is the graceful-close confirmation in progress (retain.go).
	retain *retainState

	// releasedBy is a holder whose final release of its committed ballot this
	// node saw at releasedAt; it lifts the quiet period and does not count
	// in the rank for a successor window (B-9).
	releasedBy string
	releasedAt time.Duration

	// Stateful keys (state_proposer.go, force.go): this node's latest
	// certified state, the transition queued on it, recent transition
	// outcomes and an armed forced acquisition.
	certified   *certified
	pending     *pendingTransition
	results     map[string]transitionResult
	resultOrder []string
	force       *forceState
}

func (n *Node) proposerFor(key Key) *proposerKey {
	pk := n.proposers[key]
	if pk == nil {
		pk = &proposerKey{key: key, obs: map[string]observation{}}
		n.proposers[key] = pk
	}
	return pk
}

func (pk *proposerKey) holdsLease() bool {
	return pk.role == RoleHolding || pk.role == RoleRecovering
}

// tickProposers advances every candidate key. Renewals of all held keys start
// on one node-wide schedule so they share frames (per-holder batching).
func (n *Node) tickProposers(now time.Duration) {
	renewDue := now >= n.renewAt
	if renewDue {
		n.renewAt = now + RenewInterval
	}
	keys := make(map[Key]bool, len(n.proposers))
	for key := range n.proposers {
		keys[key] = true
	}
	for _, policyID := range sortedKeys(n.manifests) {
		manifest := n.manifests[policyID]
		if !manifest.isCandidate(n.id) {
			continue
		}
		for slot := uint32(0); slot < manifest.Slots; slot++ {
			keys[Key{PolicyID: policyID, Slot: slot}] = true
		}
	}
	for _, key := range sortKeys(keys) {
		n.tickKey(n.proposerFor(key), now, renewDue)
	}
}

func sortKeys(set map[Key]bool) []Key {
	keys := make([]Key, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].PolicyID != keys[j].PolicyID {
			return keys[i].PolicyID < keys[j].PolicyID
		}
		return keys[i].Slot < keys[j].Slot
	})
	return keys
}

func (n *Node) tickKey(pk *proposerKey, now time.Duration, renewDue bool) {
	manifest := n.manifests[pk.key.PolicyID]
	if manifest != nil && manifest.Closed {
		n.tickClosed(pk, manifest, now)
		return
	}
	slotGone := manifest == nil || pk.key.Slot >= manifest.Slots
	if slotGone && pk.round != nil {
		// The adopted manifest removed the slot: originate nothing more for
		// it. A holder's release is driven by the daemon (A6); without it the
		// timer fence still applies.
		pk.round = nil
		if pk.role == RoleAcquiring || pk.role == RoleBootstrapping {
			pk.role = RoleNone
		}
	}
	if pk.round != nil {
		n.tickRound(pk, now)
	}
	switch pk.role {
	case RoleHolding:
		if manifest != nil && manifest.Available {
			pk.deadline, pk.softAt = now+FenceCompleteAfter, now+FenceCompleteAfter
		} else if now >= pk.softAt {
			n.fence(pk, FenceTimer, now)
			return
		}
	case RoleRecovering:
		if manifest != nil && manifest.Available {
			pk.deadline = now + FenceCompleteAfter
		}
		if now >= pk.softAt {
			n.fence(pk, FenceRecovery, now)
			return
		}
		if now < pk.recoverUntil {
			return
		}
		if pk.commit != nil && pk.commitBallot.Proposer != n.id && pk.ballot.Less(pk.commitBallot) {
			n.fence(pk, FenceOtherHolder, now)
			return
		}
	case RoleReleasing:
		n.tickRelease(pk, now)
		return
	case RoleFencing, RoleAbandoned:
		return
	case RoleNone, RoleCandidate:
		n.tickCandidate(pk, manifest, now)
		return
	}
	retryDue := (pk.retry || pk.role == RoleRecovering) && now >= pk.nextRoundAt
	if pk.holdsLease() && pk.round == nil && !slotGone && (renewDue || retryDue) {
		if !manifest.isCandidate(n.id) {
			n.fence(pk, FenceRemoved, now)
			return
		}
		n.startRound(pk, manifest, pk.role, now)
	}
}

func (n *Node) onStatus(from string, msg *pb.LeaseStatus, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	pk := n.proposers[key]
	if !ok || pk == nil {
		return
	}
	if manifest := n.manifests[key.PolicyID]; manifest != nil &&
		(msg.GetEpoch() < manifest.Epoch || msg.GetManifestVersion() < manifest.Version) {
		n.attachBlocks(from, key.PolicyID)
	}
	if msg.GetState() == pb.LeaseKeyState_LEASE_KEY_STATE_UNSPECIFIED {
		return
	}
	if msg.GetLatestCommit() != nil {
		n.observeCommit(msg.GetLatestCommit(), false, now)
	}
	// Commits are self-certifying: hand a newer one to a lagging acceptor,
	// for example one that lost its state and re-reserved a bootstrap key
	// whose holder already acquired (A5, A13).
	if pk.commit != nil && ballotFromProto(msg.GetLatestCommit().GetBallot()).Less(pk.commitBallot) {
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Commit{Commit: pk.commit}})
	}
	n.observeRound(pk, from, msg.GetPromised())
	pk.obs[from] = observation{state: msg.GetState(), holder: msg.GetHolderId(), reservedFor: msg.GetReservedFor(), at: now, accepted: msg.GetAccepted()}
}

// observeRound lets the next round go past a ballot a member of the key's
// policy reports as promised (a status or a NACK). Members are listed in the
// policy's own signed manifest (A18); a node or relay of another policy is
// not, so it cannot move this policy's rounds, for example to the top of the
// range where they would wrap.
func (n *Node) observeRound(pk *proposerKey, from string, promised *pb.LeaseBallot) {
	config := n.policyConfig(pk.key.PolicyID)
	if config == nil || !config.isMember(from) {
		return
	}
	pk.maxRound = max(pk.maxRound, promised.GetRound())
}

// observeCommit learns a verified commit. A holder fences immediately only on
// a commit for another holder that beats its own (A13), never on a bare
// higher ballot.
func (n *Node) observeCommit(commit *pb.LeaseCommit, direct bool, now time.Duration) {
	key, ok := keyFromProto(commit.GetKey())
	manifest := n.manifests[key.PolicyID]
	pk := n.proposers[key]
	if !ok || manifest == nil || pk == nil {
		return
	}
	ballot := ballotFromProto(commit.GetBallot())
	if pk.commit != nil && !pk.commitBallot.Less(ballot) {
		return
	}
	majority, err := n.commitQuorum(commit, manifest)
	if err != nil {
		return
	}
	// Only a quorum-certified ballot moves the next round: an unverified
	// commit is just a number anyone can write.
	pk.maxRound = max(pk.maxRound, ballot.Round)
	pk.commit, pk.commitBallot = commit, ballot
	n.supersedeForce(pk, ballot)
	if direct {
		pk.freshCommitAt, pk.hasFreshCommit = now, true
	}
	if ballot.Proposer == n.id {
		if pk.ballot.Less(ballot) && pk.role == RoleRecovering {
			pk.ballot, pk.ownMajority = ballot, majority
		}
		return
	}
	if bootstrapSatisfiedBy(manifest, key, commit) {
		pk.bootstrapDone = manifest.BootstrapID
	}
	switch pk.role {
	case RoleHolding:
		if n.beats(pk, manifest, ballot, majority) {
			n.fence(pk, FenceOtherHolder, now)
		}
	case RoleRecovering:
		if now >= pk.recoverUntil && pk.ballot.Less(ballot) {
			n.fence(pk, FenceOtherHolder, now)
		}
	case RoleAcquiring, RoleBootstrapping:
		if pk.round != nil && pk.round.ballot.Less(ballot) {
			n.finishRound(pk, now)
		}
	}
}

// beats reports whether another holder's commit wins over this holder's.
// Strict: any higher committed ballot (it can only exist if our lease is
// gone). Available: a majority certificate beats a minority one; between
// minority certificates the better manifest rank wins, so both sides of a
// healed partition agree on one survivor (A7, I4).
func (n *Node) beats(pk *proposerKey, manifest *Manifest, ballot Ballot, majority bool) bool {
	if !manifest.Available {
		return pk.ballot.Less(ballot)
	}
	if majority != pk.ownMajority {
		return majority
	}
	if majority {
		return pk.ballot.Less(ballot)
	}
	other, ok := manifest.rank[ballot.Proposer]
	return ok && other < manifest.rank[n.id]
}

func (n *Node) fence(pk *proposerKey, reason FenceReason, now time.Duration) {
	switch pk.role {
	case RoleHolding, RoleRecovering:
	default:
		return
	}
	pk.round = nil
	pk.role = RoleFencing
	pk.fenceReason = reason
	n.dropPending(pk, "the lease was lost ("+string(reason)+")")
	n.emit(Event{Kind: EventFence, Key: pk.key, Ballot: pk.ballot, Reason: reason, At: now})
}

// onManifestChanged fences on a lease-closed manifest (A5, A13) unless it
// names the holder retained (graceful close). On a switch
// from available to strict a holder keeps only a strict lease: one backed
// by a majority certificate, timed from its send time (A7).
func (n *Node) onManifestChanged(previous, manifest *Manifest, now time.Duration) {
	toStrict := previous != nil && previous.Available && !manifest.Available
	for key, pk := range n.proposers {
		if key.PolicyID != manifest.PolicyID {
			continue
		}
		if manifest.Closed {
			// Graceful close: the named retained holder keeps its copy while
			// the voters confirm; any other holder fences (retain.go).
			n.tickClosed(pk, manifest, now)
			continue
		}
		if pk.role == RoleRetained || pk.retain != nil {
			// Lease mode again: a retained copy is legacy-owned until its
			// node acquires as the bootstrap holder (D1); a confirmation in
			// progress is moot.
			if pk.role == RoleRetained {
				pk.role = RoleNone
			}
			pk.retain = nil
		}
		if toStrict && pk.holdsLease() {
			if !pk.ownMajority {
				n.fence(pk, FenceTimer, now)
				continue
			}
			pk.deadline, pk.softAt = pk.anchor+FenceCompleteAfter, pk.anchor+SoftFenceAfter
		}
	}
}

// observeRelease is the candidate side of a final release: when the holder
// of the commit this node knows lets go of it, the quiet period after that
// commit ends and the key is queried at once (B-9).
func (n *Node) observeRelease(key Key, from string, ballot Ballot, now time.Duration) {
	pk := n.proposers[key]
	if pk == nil || from == n.id || pk.commit == nil || pk.commitBallot.Proposer != from || ballot.Less(pk.commitBallot) {
		return
	}
	pk.hasFreshCommit = false
	pk.releasedBy, pk.releasedAt = from, now
	pk.nextQueryAt = now
}

func (n *Node) onDesignated(key Key, now time.Duration) {
	pk := n.proposers[key]
	if pk == nil {
		pk = n.proposerFor(key)
	}
	pk.designated, pk.designatedUntil = true, now+SuccessorWindow
	pk.nextRoundAt = now
}

func (n *Node) nextWakeup(now time.Duration) time.Duration {
	next := now + queryInterval
	consider := func(at time.Duration) {
		if at > now && at < next {
			next = at
		}
	}
	consider(n.renewAt)
	for _, pk := range n.proposers {
		if r := pk.round; r != nil {
			consider(r.deadline)
			consider(r.anchor + availableCollect)
			consider(r.proposeAt + availableCollect)
		}
		consider(pk.nextRoundAt)
		consider(pk.nextQueryAt)
		consider(pk.softAt)
		consider(pk.recoverUntil)
		consider(pk.release.nextAt)
		consider(pk.designatedUntil)
		if pk.force != nil && pk.force.outcome == ForcePending {
			consider(pk.force.until)
		}
		if manifest := n.manifests[pk.key.PolicyID]; pk.expiredSeen && manifest != nil {
			consider(pk.expiredSince + time.Duration(n.rank(pk, manifest))*RankStep)
		}
	}
	if next <= now {
		next = now + time.Millisecond
	}
	return next
}
