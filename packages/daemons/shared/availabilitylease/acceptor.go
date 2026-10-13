package availabilitylease

import (
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

const (
	echoSlots   = 4
	acceptSlots = 6
	maxReleased = 8
	// maxBallotJump bounds how far a ballot may go above the highest round
	// an acceptor knows of a key. Honest rounds grow by one per round (a
	// renewal every RenewInterval: 2^32 rounds take centuries), so a larger
	// jump is a forged ballot; promising it would push the key's rounds to
	// the top of the range for every proposer.
	maxBallotJump = 1 << 32
)

// acceptorKey is the acceptor state of one key. Only rec is persisted.
type acceptorKey struct {
	rec keyRecord
	// shadowPromised tracks promises made while abstaining or not voting;
	// they are never persisted or counted but keep the state conservative.
	shadowPromised Ballot
	lease          acceptedLease
	commit         *pb.LeaseCommit
	commitBallot   Ballot
	echoes         [echoSlots]echoRecord
	echoNext       int
	accepts        [acceptSlots]acceptRecord
	acceptNext     int
	relinquished   map[string]Ballot
	release        releaseWindow
	// commitSince is the local time the current commit holder's first commit
	// was stored; zero when unknown (restored after a restart). N-5.
	commitSince time.Duration
}

type acceptedLease struct {
	holder string
	ballot Ballot
	at     time.Duration
	open   bool
}

type echoRecord struct {
	ballot Ballot
	echo   uint64
	at     time.Duration
}

// acceptRecord is an own (or shadow) accept, anchored at the local time this
// acceptor promised the ballot when the propose echoed that promise (A11).
type acceptRecord struct {
	ballot   Ballot
	at       time.Duration
	anchor   time.Duration
	anchored bool
}

type releaseWindow struct {
	active    bool
	at        time.Duration
	successor string
}

func restoreAcceptorKey(record keyRecord) *acceptorKey {
	ak := &acceptorKey{rec: record, relinquished: map[string]Ballot{}}
	if len(record.Commit) > 0 {
		commit := &pb.LeaseCommit{}
		if proto.Unmarshal(record.Commit, commit) == nil {
			ak.commit = commit
			ak.commitBallot = ballotFromProto(commit.GetBallot())
		}
	}
	return ak
}

func (ak *acceptorKey) promised() Ballot { return maxBallot(ak.rec.Promised, ak.shadowPromised) }

// farAbove reports a ballot more than maxBallotJump rounds above every round
// this acceptor knows of the key: its promise and its commit.
func (ak *acceptorKey) farAbove(ballot Ballot) bool {
	known := max(ak.promised().Round, ak.commitBallot.Round)
	return ballot.Round > known && ballot.Round-known > maxBallotJump
}

func (a acceptedLease) openAt(now time.Duration) bool { return a.open && now < a.at+AcceptorHold }

func (ak *acceptorKey) echoFor(ballot Ballot, now time.Duration, next func() uint64) uint64 {
	for _, record := range ak.echoes {
		if record.echo != 0 && record.ballot == ballot {
			return record.echo
		}
	}
	echo := next()
	ak.echoes[ak.echoNext] = echoRecord{ballot: ballot, echo: echo, at: now}
	ak.echoNext = (ak.echoNext + 1) % echoSlots
	return echo
}

func (ak *acceptorKey) recordAccept(ballot Ballot, echo uint64, now time.Duration) {
	record := acceptRecord{ballot: ballot, at: now}
	for _, promise := range ak.echoes {
		if echo != 0 && promise.echo == echo && promise.ballot == ballot {
			record.anchor, record.anchored = promise.at, true
		}
	}
	for i, existing := range ak.accepts {
		if existing.ballot == ballot && !existing.ballot.IsZero() {
			if !existing.anchored {
				ak.accepts[i] = record
			}
			return
		}
	}
	ak.accepts[ak.acceptNext] = record
	ak.acceptNext = (ak.acceptNext + 1) % acceptSlots
}

func (n *Node) acceptorFor(key Key) *acceptorKey {
	ak := n.acceptors[key]
	if ak == nil {
		ak = &acceptorKey{relinquished: map[string]Ballot{}}
		n.acceptors[key] = ak
	}
	return ak
}

func (n *Node) nextEcho() uint64 {
	n.echoSeq++
	return n.incarnation<<32 | n.echoSeq&0xffffffff
}

// voting reports whether this node's votes for a policy count now: it is in
// one of the policy's quorum sets (A18) and the restart abstention (A3) has
// passed.
func (n *Node) voting(policyID string, now time.Duration) bool {
	config := n.policyConfig(policyID)
	return config != nil && config.isVoter(n.id) && now >= n.abstainUntil
}

// validateProposal applies the manifest, epoch and candidacy checks (A4).
func (n *Node) validateProposal(from string, key Key, epoch, version uint64) (*Manifest, pb.LeaseNackReason) {
	manifest := n.manifests[key.PolicyID]
	config := n.policyConfig(key.PolicyID)
	switch {
	case manifest == nil:
		return nil, pb.LeaseNackReason_LEASE_NACK_REASON_UNKNOWN_POLICY
	case config == nil:
		return nil, pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND
	case version < manifest.Version:
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_STALE_MANIFEST
	case version > manifest.Version:
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND
	case epoch < config.Epoch:
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_STALE_EPOCH
	case epoch > config.Epoch:
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND
	case manifest.Closed:
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_LEASE_CLOSED
	case key.Slot >= manifest.Slots || !manifest.isCandidate(from):
		return manifest, pb.LeaseNackReason_LEASE_NACK_REASON_NOT_CANDIDATE
	}
	return manifest, 0
}

// refuse applies ballot order, release binding (A6), bootstrap reservation
// (A5), the T × 1.1 hold for other proposers and the successor window (D9).
func (n *Node) refuse(ak *acceptorKey, manifest *Manifest, key Key, ballot Ballot, proposer string, now time.Duration) (pb.LeaseNackReason, string) {
	if ballot.Less(ak.promised()) || ballot.Less(ak.commitBallot) {
		// Below a commit this acceptor stores (it may have learned the commit
		// without promising it, or lost its promises): a lease under a lower
		// ballot would lose to that older commit everywhere (A13), and could
		// never satisfy a bootstrap reservation. The NACK names the commit's
		// ballot, so the proposer goes past it.
		return pb.LeaseNackReason_LEASE_NACK_REASON_BALLOT_TOO_LOW, ""
	}
	if released, ok := ak.rec.Released[proposer]; ok && !released.Less(ballot) {
		return pb.LeaseNackReason_LEASE_NACK_REASON_RELEASED, ""
	}
	if ak.lease.openAt(now) && ak.lease.holder != proposer {
		// Also for a bootstrap holder: a lease another node still holds here
		// (lease mode entered again soon after a close, whose unnamed holder
		// is still stopping) must lapse first, or two copies overlap.
		return pb.LeaseNackReason_LEASE_NACK_REASON_HELD, ak.lease.holder
	}
	if holder := manifest.Bootstrap[key.Slot]; holder != "" && ak.rec.BootstrapSatisfied != manifest.BootstrapID {
		if proposer != holder {
			return pb.LeaseNackReason_LEASE_NACK_REASON_RESERVED, holder
		}
		return 0, ""
	}
	if ak.release.active && ak.release.successor != "" && proposer != ak.release.successor && now < ak.release.at+SuccessorWindow {
		return pb.LeaseNackReason_LEASE_NACK_REASON_RESERVED, ak.release.successor
	}
	return 0, ""
}

func (n *Node) nack(to string, key Key, ballot Ballot, reason pb.LeaseNackReason, holder string, ak *acceptorKey) {
	nack := &pb.LeaseNack{
		Key: key.proto(), Ballot: ballot.proto(), Reason: reason, HolderId: holder,
		AcceptorIncarnation: n.incarnation,
	}
	if config := n.policyConfig(key.PolicyID); config != nil {
		nack.Epoch = config.Epoch
	}
	if manifest := n.manifests[key.PolicyID]; manifest != nil {
		nack.ManifestVersion = manifest.Version
	}
	if ak != nil {
		promised := maxBallot(ak.promised(), ak.commitBallot)
		if released, ok := ak.rec.Released[to]; ok && reason == pb.LeaseNackReason_LEASE_NACK_REASON_RELEASED {
			// The proposer lost its own released ballot (a restart with a
			// new incarnation): name it so the next round goes past it
			// instead of retrying below it round after round.
			promised = maxBallot(promised, released)
		}
		nack.Promised = promised.proto()
		nack.LatestCommit = ak.commit
	}
	switch reason {
	case pb.LeaseNackReason_LEASE_NACK_REASON_STALE_EPOCH, pb.LeaseNackReason_LEASE_NACK_REASON_STALE_MANIFEST,
		pb.LeaseNackReason_LEASE_NACK_REASON_LEASE_CLOSED:
		n.attachBlocks(to, key.PolicyID)
	}
	n.queue(to, &pb.LeaseItem{Body: &pb.LeaseItem_Nack{Nack: nack}})
}

func (n *Node) onPrepare(from string, msg *pb.LeasePrepare, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	ballot := ballotFromProto(msg.GetBallot())
	if !ok || ballot.Proposer != from || ballot.Round == 0 {
		return
	}
	manifest, reason := n.validateProposal(from, key, msg.GetEpoch(), msg.GetManifestVersion())
	if reason != 0 {
		n.nack(from, key, ballot, reason, "", n.acceptors[key])
		return
	}
	ak := n.acceptorFor(key)
	if ak.farAbove(ballot) {
		return
	}
	if reason, holder := n.refuse(ak, manifest, key, ballot, from, now); reason != 0 {
		n.nack(from, key, ballot, reason, holder, ak)
		return
	}
	voting := n.voting(key.PolicyID, now)
	if voting {
		if ak.rec.Promised.Less(ballot) {
			ak.rec.Promised = ballot
			n.markDirty(key)
		}
	} else {
		ak.shadowPromised = maxBallot(ak.shadowPromised, ballot)
	}
	promise := &pb.LeasePromise{
		Key: key.proto(), Ballot: ballot.proto(), Echo: ak.echoFor(ballot, now, n.nextEcho),
		Shadow: !voting, AcceptorIncarnation: n.incarnation,
	}
	if manifest.Stateful {
		promise.Accepted = n.acceptedState(ak, key)
	}
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Promise{Promise: promise}})
}

func (n *Node) onPropose(from string, msg *pb.LeasePropose, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	ballot := ballotFromProto(msg.GetBallot())
	if !ok || ballot.Proposer != from || ballot.Round == 0 {
		return
	}
	manifest, reason := n.validateProposal(from, key, msg.GetEpoch(), msg.GetManifestVersion())
	if reason != 0 {
		n.nack(from, key, ballot, reason, "", n.acceptors[key])
		return
	}
	ak := n.acceptorFor(key)
	if ak.farAbove(ballot) {
		return
	}
	if reason, holder := n.refuse(ak, manifest, key, ballot, from, now); reason != 0 {
		n.nack(from, key, ballot, reason, holder, ak)
		return
	}
	var hash [32]byte
	if manifest.Stateful {
		var reason pb.LeaseNackReason
		if hash, reason = n.checkStatefulPropose(ak, ballot, msg); reason != 0 {
			n.nack(from, key, ballot, reason, "", ak)
			return
		}
	}
	voting := n.voting(key.PolicyID, now)
	if voting {
		if ak.rec.Promised.Less(ballot) {
			ak.rec.Promised = ballot
			n.markDirty(key)
		}
	} else {
		ak.shadowPromised = maxBallot(ak.shadowPromised, ballot)
	}
	ak.lease = acceptedLease{holder: from, ballot: ballot, at: now, open: true}
	if ak.release.active && from == ak.release.successor {
		ak.release.active = false
	}
	ak.recordAccept(ballot, msg.GetEcho(), now)
	if !voting {
		return
	}
	// Persisted before the accepted reply leaves (commitLocked), so a
	// restart within the same boot restores this hold exactly.
	if manifest.Stateful {
		n.recordStatefulAccept(ak, key, ballot, msg.GetEpoch(), msg.GetState(), hash, int64(now))
	} else {
		ak.rec.Accepted = &acceptedRecord{Ballot: ballot, AtNs: int64(now)}
		n.markDirty(key)
	}
	accepted := &pb.LeaseAccepted{
		Key: key.proto(), Ballot: ballot.proto(), Epoch: msg.GetEpoch(), ManifestVersion: msg.GetManifestVersion(),
		AcceptorId: n.id, AcceptorIncarnation: n.incarnation,
	}
	if manifest.Stateful {
		accepted.StateHash = append([]byte(nil), hash[:]...)
	}
	statement := statementFor(manifest.Stateful, key, ballot, msg.GetEpoch(), msg.GetManifestVersion(), n.id, n.incarnation, hash)
	signature, extra, err := signAll(n.signers(), statement)
	if err != nil {
		n.logf("sign lease accept: %v", err)
		return
	}
	accepted.Signature, accepted.AdditionalSignatures = signature, extra
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Accepted{Accepted: accepted}})
}

// storeCommit keeps the highest valid commit per key (A13). It is persisted
// when the holder changes or it satisfies a bootstrap reservation.
func (n *Node) storeCommit(commit *pb.LeaseCommit, now time.Duration) {
	key, ok := keyFromProto(commit.GetKey())
	manifest := n.manifests[key.PolicyID]
	if !ok || manifest == nil {
		return
	}
	ballot := ballotFromProto(commit.GetBallot())
	ak := n.acceptorFor(key)
	if !ak.commitBallot.Less(ballot) {
		return
	}
	if err := n.verifyCommit(commit, manifest); err != nil {
		return
	}
	persist := ak.commitBallot.Proposer != ballot.Proposer
	if persist {
		ak.commitSince = now
	}
	// Stateful keys: the latest commit is persisted whenever its state
	// changes too, so views and reports after a restart show the certified
	// state (M1).
	persist = persist || (manifest.Stateful && (ak.commit == nil || !sameBytes(ak.commit.GetState(), commit.GetState())))
	ak.commit, ak.commitBallot = commit, ballot
	if bootstrapSatisfiedBy(manifest, key, commit) && ak.rec.BootstrapSatisfied != manifest.BootstrapID {
		ak.rec.BootstrapSatisfied = manifest.BootstrapID
		persist = true
	}
	if persist {
		ak.rec.Commit, _ = proto.Marshal(commit)
		n.markDirty(key)
	}
}

func (n *Node) onRelease(from string, msg *pb.LeaseRelease, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	ballot := ballotFromProto(msg.GetBallot())
	if !ok || ballot.Proposer != from || n.manifests[key.PolicyID] == nil {
		return
	}
	final := msg.GetPhase() == pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_FINAL
	if final {
		n.observeRelease(key, from, ballot, now)
	}
	if config := n.policyConfig(key.PolicyID); config == nil || !config.isMember(n.id) {
		// A candidate outside the policy's members keeps no acceptor state;
		// it only learns that the holder let go (and whether it is the
		// designated successor).
		if final && msg.GetSuccessorId() == n.id {
			n.onDesignated(key, now)
		}
		ack := &pb.LeaseReleaseAck{Key: key.proto(), Ballot: ballot.proto(), Phase: msg.GetPhase()}
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_ReleaseAck{ReleaseAck: ack}})
		return
	}
	ak := n.acceptorFor(key)
	if previous, ok := ak.relinquished[from]; !ok || previous.Less(ballot) {
		ak.relinquished[from] = ballot
	}
	if msg.GetPhase() == pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_FINAL {
		if previous, ok := ak.rec.Released[from]; !ok || previous.Less(ballot) {
			if ak.rec.Released == nil {
				ak.rec.Released = map[string]Ballot{}
			}
			ak.rec.Released[from] = ballot
			for len(ak.rec.Released) > maxReleased {
				oldest := ""
				for _, id := range sortedKeys(ak.rec.Released) {
					if oldest == "" || ak.rec.Released[id].Less(ak.rec.Released[oldest]) {
						oldest = id
					}
				}
				delete(ak.rec.Released, oldest)
			}
			n.markDirty(key)
		}
		if ak.lease.holder == from && !ballot.Less(ak.lease.ballot) && ak.lease.open {
			ak.lease.open = false
			ak.release = releaseWindow{active: true, at: now, successor: msg.GetSuccessorId()}
		}
		if msg.GetSuccessorId() == n.id {
			n.onDesignated(key, now)
		}
	}
	ack := &pb.LeaseReleaseAck{Key: key.proto(), Ballot: ballot.proto(), Phase: msg.GetPhase()}
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_ReleaseAck{ReleaseAck: ack}})
}

func (n *Node) keyState(ak *acceptorKey, manifest *Manifest, key Key, now time.Duration) (pb.LeaseKeyState, string, string) {
	switch {
	case manifest.Closed:
		return pb.LeaseKeyState_LEASE_KEY_STATE_CLOSED, "", ""
	case !n.voting(key.PolicyID, now):
		return pb.LeaseKeyState_LEASE_KEY_STATE_ABSTAINING, ak.lease.holder, ""
	}
	if holder := manifest.Bootstrap[key.Slot]; holder != "" && ak.rec.BootstrapSatisfied != manifest.BootstrapID {
		return pb.LeaseKeyState_LEASE_KEY_STATE_RESERVED, "", holder
	}
	if ak.lease.openAt(now) {
		return pb.LeaseKeyState_LEASE_KEY_STATE_HELD, ak.lease.holder, ""
	}
	if ak.release.active && ak.release.successor != "" && now < ak.release.at+SuccessorWindow {
		return pb.LeaseKeyState_LEASE_KEY_STATE_RESERVED, "", ak.release.successor
	}
	return pb.LeaseKeyState_LEASE_KEY_STATE_FREE, "", ""
}

func (n *Node) onQuery(from string, msg *pb.LeaseQuery, now time.Duration) {
	for _, value := range msg.GetKeys() {
		key, ok := keyFromProto(value)
		if !ok {
			continue
		}
		manifest, config := n.manifests[key.PolicyID], n.policyConfig(key.PolicyID)
		if manifest == nil || config == nil {
			// Report that we lag so the querier forwards its blocks (A4).
			status := &pb.LeaseStatus{Key: key.proto()}
			if config != nil {
				status.Epoch = config.Epoch
			}
			n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
			continue
		}
		ak := n.acceptorFor(key)
		state, holder, reserved := n.keyState(ak, manifest, key, now)
		status := &pb.LeaseStatus{
			Key: key.proto(), State: state, HolderId: holder, Promised: ak.promised().proto(),
			LatestCommit: ak.commit, Epoch: config.Epoch, ManifestVersion: manifest.Version, ReservedFor: reserved,
		}
		if manifest.Stateful {
			status.Accepted = n.acceptedState(ak, key)
		}
		n.forwardOnce(from, key.PolicyID)
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
	}
}

// bootstrapSatisfiedBy reports whether a verified commit proves the bootstrap
// reservation of its key was satisfied (A5): it was formed under a manifest
// version that carries this reservation (bootstrapSince) and it is the named
// holder's, or it was formed under this very manifest version, whose
// acceptors only accept another proposer after they saw the named holder's
// commit. A commit from an earlier lease period of the policy (lease mode was
// left and entered again) never satisfies a new reservation: it would let the
// named holder, whose copy runs, look like it already acquired (stand run
// rc.20 B-12a: the copy was stopped as unowned and restarted a second later).
func bootstrapSatisfiedBy(manifest *Manifest, key Key, commit *pb.LeaseCommit) bool {
	holder := manifest.Bootstrap[key.Slot]
	if manifest.BootstrapID == 0 || holder == "" || commit.GetManifestVersion() < manifest.bootstrapSince {
		return false
	}
	return commit.GetBallot().GetProposerId() == holder || commit.GetManifestVersion() == manifest.Version
}
