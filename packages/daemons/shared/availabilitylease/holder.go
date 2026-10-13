package availabilitylease

import (
	"errors"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const noDeadline = time.Duration(1<<62 - 1)

type releaseState struct {
	successor  string
	ballot     Ballot
	acks       map[string]bool
	final      bool
	finalSent  int
	nextAt     time.Duration
	finalAcked map[string]bool
}

// HolderStatus returns the proposer view of a key for the docker daemon.
func (n *Node) HolderStatus(key Key) HolderStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.holderStatusLocked(key, n.clock.Now())
}

func (n *Node) holderStatusLocked(key Key, now time.Duration) HolderStatus {
	status := HolderStatus{Key: key}
	manifest := n.manifests[key.PolicyID]
	status.Available = manifest != nil && manifest.Available
	pk := n.proposers[key]
	if pk == nil {
		return status
	}
	status.Role, status.Ballot = pk.role, pk.ballot
	switch pk.role {
	case RoleHolding:
		status.Holding = true
		status.Deadline, status.SoftFenceAt = pk.deadline, pk.softAt
		status.MayStart = now < pk.softAt
		status.FenceNow = !status.MayStart
		if status.FenceNow {
			status.FenceReason = FenceTimer
		}
	case RoleRecovering, RoleAbandoned:
		status.Deadline, status.SoftFenceAt = pk.deadline, pk.softAt
		status.FenceNow = now >= pk.softAt
	case RoleFencing:
		status.Deadline, status.SoftFenceAt = pk.deadline, pk.softAt
		status.FenceNow, status.FenceReason = true, pk.fenceReason
	case RoleReleasing:
		status.Deadline = pk.deadline
	case RoleRetained:
		status.Retained = true
	}
	if manifest != nil && manifest.Closed && pk.holdsLease() {
		// Nothing starts under a closing lease; the copy keeps running on
		// its budget while the voters confirm it retained (or it fences).
		status.MayStart = false
		status.Retaining = pk.retain != nil && !status.FenceNow
	}
	return status
}

// Holders lists every key this node holds, recovers, fences or releases.
func (n *Node) Holders() []HolderStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := n.clock.Now()
	set := map[Key]bool{}
	for key, pk := range n.proposers {
		if pk.role != RoleNone && pk.role != RoleCandidate {
			set[key] = true
		}
	}
	var out []HolderStatus
	for _, key := range sortKeys(set) {
		out = append(out, n.holderStatusLocked(key, now))
	}
	return out
}

// Recover registers a lease-mode container that was running when the daemon
// started (A2.3). deadline is the watchdog record. The container is treated
// as unfenced: unless a round succeeds before RecoverStopReserve ahead of the
// deadline the daemon must kill it, and the watchdog kills it at deadline.
// Renewing until then, rather than keeping the holder's usual graceful-stop
// budget, lets a daemon restart that took most of the budget (a rolling
// update) keep its slot.
func (n *Node) Recover(key Key, deadline time.Duration) {
	n.run(func(now time.Duration) {
		pk := n.proposerFor(key)
		if pk.holdsLease() {
			return
		}
		pk.role, pk.round, pk.fenceReason = RoleRecovering, nil, FenceNone
		pk.deadline, pk.softAt = deadline, deadline-RecoverStopReserve
		if manifest := n.manifests[key.PolicyID]; manifest != nil && manifest.Available {
			// Available mode never fences on time (A7): renew or yield to a
			// commit that beats ours.
			pk.deadline, pk.softAt = now+FenceCompleteAfter, noDeadline
		}
		pk.lastProposeAt = now
		// The container ran under the previous process, whose proposes
		// this one does not know: every relay is waited for in full.
		pk.proposeFloor = max(pk.proposeFloor, now)
		pk.recoverUntil = now + recoveryQueryWait
		pk.ballot = Ballot{}
		n.sendQuery(key)
		if now >= pk.softAt {
			n.fence(pk, FenceRecovery, now)
		}
	})
}

// FenceComplete tells the node the container is confirmed dead (cgroup
// empty). The caller must not call it before the stop is confirmed. After any
// local fence (timer, recovery, freeze, lost watchdog, abandoned renewals,
// lease closed, slot removed) it releases the key so successors need not wait
// for the acceptors' hold to lapse; after another holder's commit there is
// nothing to release.
func (n *Node) FenceComplete(key Key) {
	n.run(func(now time.Duration) {
		pk := n.proposers[key]
		if pk == nil {
			return
		}
		switch pk.role {
		case RoleFencing, RoleAbandoned:
		default:
			return
		}
		// Stateful keys are not released after a local fence: a release makes
		// the previous holder ineligible (AS6), and while the state is
		// degraded it may be the only member with every acknowledged write.
		// Successors wait out the acceptor hold instead.
		if releaseAfterFence(pk.fenceReason) && !pk.lastIssued.IsZero() && !n.stateful(key.PolicyID) {
			n.beginRelease(pk, "", now)
			return
		}
		pk.role, pk.deadline, pk.softAt = RoleNone, 0, 0
	})
}

// releaseAfterFence says whether a confirmed local fence releases the key, so
// successors start at once instead of waiting for the acceptors' hold to
// lapse (D4, B-9). Only a fence for another holder's commit does not: that
// holder already has the key.
func releaseAfterFence(reason FenceReason) bool {
	return reason != FenceOtherHolder
}

// Release gives the key up, optionally to a designated successor (D9). The
// caller guarantees the container's cgroup is empty and its endpoint is
// deregistered (A6). A retained key is released when its copy stopped after
// all (a drain that was under way, or a start the close cut short). Relays are relinquished first; acceptors are released
// only once every relay acked or RelinquishWait passed since the last propose this node sent it (relinquishUntil).
func (n *Node) Release(key Key, successor string) error {
	var err error
	n.run(func(now time.Duration) {
		pk := n.proposers[key]
		if pk == nil || (!pk.holdsLease() && pk.role != RoleFencing && pk.role != RoleAbandoned && pk.role != RoleRetained) {
			err = errors.New("availability lease is not held")
			return
		}
		n.beginRelease(pk, successor, now)
	})
	return err
}

// Abandon stops renewing without releasing, for a stop that did not
// complete: the watchdog fences at the deadline (A6). The key is released
// once FenceComplete confirms the stop.
func (n *Node) Abandon(key Key) { n.AbandonFor(key, FenceAbandoned) }

// AbandonFor is Abandon with the reason reported for a key that was not
// fencing yet (for example FenceWatchdogLost); a fencing key keeps its reason.
func (n *Node) AbandonFor(key Key, reason FenceReason) {
	n.run(func(now time.Duration) {
		pk := n.proposers[key]
		if pk == nil || (!pk.holdsLease() && pk.role != RoleFencing) {
			return
		}
		if pk.role != RoleFencing {
			pk.fenceReason = reason
		}
		pk.round = nil
		pk.role = RoleAbandoned
		n.dropPending(pk, "renewals were abandoned")
		n.emit(Event{Kind: EventFence, Key: key, Ballot: pk.ballot, Reason: pk.fenceReason, At: now})
	})
}

func (n *Node) beginRelease(pk *proposerKey, successor string, now time.Duration) {
	pk.round = nil
	pk.role = RoleReleasing
	n.dropPending(pk, "the lease was released")
	pk.release = releaseState{successor: successor, ballot: pk.lastIssued, acks: map[string]bool{}, finalAcked: map[string]bool{}, nextAt: now}
	kind := EventReleased
	if successor != "" {
		kind = EventHandoff
	}
	n.emit(Event{Kind: kind, Key: pk.key, Ballot: pk.ballot, Successor: successor, At: now})
	n.tickRelease(pk, now)
}

func (n *Node) tickRelease(pk *proposerKey, now time.Duration) {
	config := n.policyConfig(pk.key.PolicyID)
	if config == nil {
		pk.role = RoleNone
		return
	}
	rel := &pk.release
	if !rel.final {
		waiting := false
		for _, id := range config.relayIDs {
			if !rel.acks[id] && now < n.relinquishUntil(pk, id) {
				waiting = true
			}
		}
		if !waiting {
			rel.final, rel.nextAt = true, now
		} else if now >= rel.nextAt {
			item := &pb.LeaseRelease{Key: pk.key.proto(), Ballot: rel.ballot.proto(), Phase: pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_RELINQUISH}
			for _, id := range config.relayIDs {
				if !rel.acks[id] {
					n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Release{Release: item}})
				}
			}
			rel.nextAt = now + releaseRetry
		}
	}
	if !rel.final || now < rel.nextAt {
		return
	}
	if rel.finalSent >= releaseAttempts {
		pk.role, pk.deadline, pk.softAt = RoleNone, 0, 0
		pk.release.nextAt = 0
		pk.nextRoundAt = now + SuccessorWindow
		return
	}
	item := &pb.LeaseRelease{
		Key: pk.key.proto(), Ballot: rel.ballot.proto(), Phase: pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_FINAL,
		SuccessorId: rel.successor,
	}
	targets := map[string]bool{}
	for _, id := range config.memberIDs {
		targets[id] = !rel.finalAcked[id]
	}
	if rel.successor != "" {
		targets[rel.successor] = !rel.finalAcked[rel.successor]
	} else if manifest := n.manifests[pk.key.PolicyID]; manifest != nil {
		// An open release also goes to every candidate, so the next one by
		// rank takes over at once instead of waiting out the quiet period
		// after this holder's last commit (B-9).
		for _, id := range manifest.Candidates {
			if id != n.id {
				targets[id] = !rel.finalAcked[id]
			}
		}
	}
	for _, id := range sortedKeys(targets) {
		if targets[id] {
			n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Release{Release: item}})
		}
	}
	rel.finalSent++
	rel.nextAt = now + releaseRetry
}

// relinquishUntil is how long a releasing holder waits for relay id to ack
// the relinquish. A relay's gate opens for this holder only on an accept
// anchored at its own promise, echoed in a propose this node sent after that
// promise arrived (acceptor.go recordAccept, round.go sendPropose), and it
// closes GateWindow after that promise on the relay's clock. So the relay's
// gate is closed RelinquishWait after the last propose this node sent it,
// whatever happens to that propose on the way. A relay that got no propose
// for RelinquishWait (offline, cut off, or not carrying the policy) is not
// waited for. Proposes of an earlier process are unknown here: they are
// bounded by the process start, or by Recover. The wait never exceeds the
// one from the last propose to anyone.
func (n *Node) relinquishUntil(pk *proposerKey, id string) time.Duration {
	last := max(pk.proposedAt[id], pk.proposeFloor, n.startedAt)
	return min(last, pk.lastProposeAt) + RelinquishWait
}

func (n *Node) onReleaseAck(from string, msg *pb.LeaseReleaseAck, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	pk := n.proposers[key]
	if !ok || pk == nil || pk.role != RoleReleasing || ballotFromProto(msg.GetBallot()) != pk.release.ballot {
		return
	}
	switch msg.GetPhase() {
	case pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_RELINQUISH:
		pk.release.acks[from] = true
		n.tickRelease(pk, now)
	case pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_FINAL:
		pk.release.finalAcked[from] = true
	}
}
