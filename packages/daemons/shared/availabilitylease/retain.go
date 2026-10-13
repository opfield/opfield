package availabilitylease

import (
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Graceful close: leaving lease mode without stopping the serving copy.
//
// A closed manifest names, per slot, the retained holder: the committed
// holder Opfield saw when it closed the lease. Every acceptor that adopted
// the closed manifest refuses every prepare and propose of the policy (as for
// any closed manifest) and confirms the close to the slot's retained holder
// when it asks (LeaseRetain -> LeaseRetained). Anyone else, or a named holder
// the acceptor knows was superseded by another proposer, is refused
// (RETAIN_REFUSED).
//
// The holder keeps its copy running on its lease budget while it asks, every
// retainRetry. It becomes retained once a majority of every quorum set of the
// closed manifest confirmed: every acquiring majority of the policy now
// intersects a majority that refuses every acquisition, so no node can ever
// acquire the key while the manifest stays closed, and the copy runs on
// without a lease. The node stops renewing and reports RoleRetained; the
// docker daemon disarms the watchdog deadline of exactly that copy and keeps
// its endpoints. A holder that cannot reach such a majority before its soft
// fence point, or that a majority refuses, fences as any holder does
// (lease_closed) and releases once the stop is confirmed; a holder the
// manifest does not name fences at once.
//
// Only a newer non-closed manifest ends the retained state (lease mode entered
// again): Opfield then names the running copy's node the bootstrap holder
// (D1), which acquires while its copy keeps running.

// retainRetry is how often a holder asks the members to confirm the close.
const retainRetry = time.Second

type retainState struct {
	// version is the closed manifest the confirmations are for.
	version uint64
	acks    map[string]bool
	refused map[string]bool
	nextAt  time.Duration
	// leaseless re-confirms a copy that was already retained before a
	// daemon restart: no lease budget, and a refusal only drops the claim.
	leaseless bool
}

func newRetainState(version uint64, now time.Duration, leaseless bool) *retainState {
	return &retainState{version: version, acks: map[string]bool{}, refused: map[string]bool{}, nextAt: now, leaseless: leaseless}
}

// tickClosed drives every key of a policy whose adopted manifest is closed.
func (n *Node) tickClosed(pk *proposerKey, manifest *Manifest, now time.Duration) {
	if pk.round != nil {
		pk.round = nil
		if pk.role == RoleAcquiring || pk.role == RoleBootstrapping {
			pk.role = RoleNone
		}
	}
	switch {
	case pk.role == RoleRetained:
	case pk.role == RoleReleasing:
		n.tickRelease(pk, now)
	case pk.holdsLease():
		if pk.retain == nil || pk.retain.version != manifest.Version {
			if !manifest.retains(pk.key.Slot, n.id) {
				n.fence(pk, FenceClosed, now)
				return
			}
			pk.retain = newRetainState(manifest.Version, now, false)
		}
		// The lease budget still applies while the voters confirm: a holder
		// that cannot reach a confirming majority fences like any other.
		if now >= pk.softAt {
			n.fence(pk, FenceClosed, now)
			return
		}
		n.sendRetain(pk, manifest, now)
	case pk.retain != nil && pk.retain.leaseless:
		if pk.retain.version != manifest.Version {
			if !manifest.retains(pk.key.Slot, n.id) {
				pk.retain = nil
				return
			}
			pk.retain = newRetainState(manifest.Version, now, true)
		}
		n.sendRetain(pk, manifest, now)
	case pk.role == RoleCandidate:
		pk.role = RoleNone
	}
}

func (n *Node) sendRetain(pk *proposerKey, manifest *Manifest, now time.Duration) {
	if now < pk.retain.nextAt {
		return
	}
	pk.retain.nextAt = now + retainRetry
	request := &pb.LeaseRetain{Key: pk.key.proto(), Ballot: pk.ballot.proto(), Epoch: manifest.Epoch, ManifestVersion: manifest.Version}
	for _, id := range manifest.Voters.memberIDs {
		if pk.retain.acks[id] || pk.retain.refused[id] {
			continue
		}
		n.forwardOnce(id, manifest.PolicyID)
		n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Retain{Retain: request}})
	}
}

// ReconfirmRetained asks the voters to confirm again that this node is the
// retained holder of key, after a daemon restart found the copy running with
// its watchdog deadline already disarmed. It changes nothing unless the
// adopted manifest is closed and names this node for key.
func (n *Node) ReconfirmRetained(key Key) {
	n.run(func(now time.Duration) {
		manifest := n.manifests[key.PolicyID]
		if !manifest.retains(key.Slot, n.id) {
			return
		}
		pk := n.proposerFor(key)
		if pk.role != RoleNone && pk.role != RoleCandidate {
			return
		}
		pk.role = RoleNone
		pk.retain = newRetainState(manifest.Version, now, true)
		n.sendRetain(pk, manifest, now)
	})
}

// onRetain is the acceptor side: confirm the close to the slot's retained
// holder, refuse everyone else.
func (n *Node) onRetain(from string, msg *pb.LeaseRetain, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	ballot := ballotFromProto(msg.GetBallot())
	if !ok || (!ballot.IsZero() && ballot.Proposer != from) {
		return
	}
	manifest := n.manifests[key.PolicyID]
	ak := n.acceptors[key]
	refuse := func(reason pb.LeaseNackReason) { n.nack(from, key, ballot, reason, "", ak) }
	switch {
	case manifest == nil:
		refuse(pb.LeaseNackReason_LEASE_NACK_REASON_UNKNOWN_POLICY)
		return
	case msg.GetManifestVersion() > manifest.Version:
		refuse(pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND)
		return
	case msg.GetManifestVersion() < manifest.Version:
		refuse(pb.LeaseNackReason_LEASE_NACK_REASON_STALE_MANIFEST)
		n.attachBlocks(from, key.PolicyID)
		return
	case !manifest.Closed:
		refuse(pb.LeaseNackReason_LEASE_NACK_REASON_RETAIN_REFUSED)
		return
	}
	retained, named := manifest.Retained[key.Slot]
	if !named || retained.Holder != from || n.supersedesRetained(ak, retained, now) {
		refuse(pb.LeaseNackReason_LEASE_NACK_REASON_RETAIN_REFUSED)
		return
	}
	confirmed := &pb.LeaseRetained{
		Key: key.proto(), Ballot: ballot.proto(), Epoch: manifest.Epoch, ManifestVersion: manifest.Version,
		AcceptorIncarnation: n.incarnation,
	}
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Retained{Retained: confirmed}})
}

// supersedesRetained reports whether this acceptor knows a commit or an
// accept of another proposer after the named holder's latest ballot it knows
// (or the one Opfield named): the named holder is stale, and the actual
// holder must not be outlived by a retained copy.
func (n *Node) supersedesRetained(ak *acceptorKey, retained RetainedHolder, _ time.Duration) bool {
	if ak == nil {
		return false
	}
	holder, reference := retained.Holder, retained.Ballot
	consider := func(ballot Ballot) {
		if ballot.Proposer == holder && reference.Less(ballot) {
			reference = ballot
		}
	}
	consider(ak.commitBallot)
	consider(ak.lease.ballot)
	for _, record := range ak.accepts {
		consider(record.ballot)
	}
	other := func(ballot Ballot) bool {
		return !ballot.IsZero() && ballot.Proposer != holder && reference.Less(ballot)
	}
	if ak.commit != nil && other(ak.commitBallot) {
		return true
	}
	if ak.lease.holder != "" && other(ak.lease.ballot) {
		return true
	}
	for _, record := range ak.accepts {
		if other(record.ballot) {
			return true
		}
	}
	return false
}

// onRetained is the holder side: count confirmations from voters of the
// closed manifest until a majority of every quorum set confirmed.
func (n *Node) onRetained(from string, msg *pb.LeaseRetained, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	pk := n.proposers[key]
	manifest := n.manifests[key.PolicyID]
	if !ok || pk == nil || pk.retain == nil || manifest == nil || !manifest.Closed || msg.GetManifestVersion() != pk.retain.version ||
		msg.GetManifestVersion() != manifest.Version || !manifest.Voters.isVoter(from) {
		return
	}
	if !pk.holdsLease() && !pk.retain.leaseless {
		return
	}
	pk.retain.acks[from] = true
	if !manifest.Voters.quorum(pk.retain.acks) {
		return
	}
	pk.round = nil
	pk.role = RoleRetained
	pk.deadline, pk.softAt = 0, 0
	pk.retain = nil
	n.emit(Event{Kind: EventRetained, Key: key, Ballot: pk.ballot, At: now})
}

// onRetainRefused handles a NACK that answers a LeaseRetain.
func (n *Node) onRetainRefused(from string, pk *proposerKey, msg *pb.LeaseNack, now time.Duration) {
	manifest := n.manifests[pk.key.PolicyID]
	if pk.retain == nil || manifest == nil || !manifest.Closed || msg.GetManifestVersion() > pk.retain.version {
		return
	}
	switch msg.GetReason() {
	case pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND, pb.LeaseNackReason_LEASE_NACK_REASON_UNKNOWN_POLICY:
		// The acceptor lags: the next ask carries the closed manifest.
		n.attachBlocks(from, pk.key.PolicyID)
		return
	case pb.LeaseNackReason_LEASE_NACK_REASON_RETAIN_REFUSED:
	default:
		return
	}
	if !manifest.Voters.isVoter(from) {
		return
	}
	pk.retain.refused[from] = true
	if !manifest.Voters.quorumImpossible(pk.retain.refused) {
		return
	}
	if pk.retain.leaseless {
		pk.retain = nil
		return
	}
	n.fence(pk, FenceClosed, now)
}
