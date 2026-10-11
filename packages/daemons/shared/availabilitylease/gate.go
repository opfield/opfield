package availabilitylease

import (
	"errors"
	"fmt"
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// verifyCommit checks a commit certificate against the voter config of its
// epoch (A11). Strict policies need a majority of every quorum set; available
// policies also accept a minority certificate with at least one voting relay
// (D11). The returned bool reports whether the certificate is a majority.
func (n *Node) verifyCommit(commit *pb.LeaseCommit, manifest *Manifest) error {
	_, err := n.commitQuorum(commit, manifest)
	return err
}

func (n *Node) commitQuorum(commit *pb.LeaseCommit, manifest *Manifest) (bool, error) {
	key, ok := keyFromProto(commit.GetKey())
	if !ok || manifest == nil || key.PolicyID != manifest.PolicyID {
		return false, errors.New("lease commit key is invalid")
	}
	config := n.configByEpoch(key.PolicyID, commit.GetEpoch())
	if config == nil {
		return false, fmt.Errorf("lease commit epoch %d is unknown", commit.GetEpoch())
	}
	ballot := ballotFromProto(commit.GetBallot())
	// Stateful policies: the commit carries the certified state and every
	// accept of its QC signs the v2 statement over that state's hash.
	var hash [32]byte
	if manifest.Stateful {
		state, err := decodeHolderState(commit.GetState())
		if err != nil || state.Holder != ballot.Proposer {
			return false, errors.New("lease commit of a stateful key carries no valid state")
		}
		hash = stateHash(commit.GetState())
	}
	signers := map[string]bool{}
	relay := false
	for _, accepted := range commit.GetQuorum() {
		id := accepted.GetAcceptorId()
		if !config.isVoter(id) || signers[id] {
			continue
		}
		acceptedKey, _ := keyFromProto(accepted.GetKey())
		if acceptedKey != key || ballotFromProto(accepted.GetBallot()) != ballot ||
			accepted.GetEpoch() != commit.GetEpoch() || accepted.GetManifestVersion() != commit.GetManifestVersion() {
			continue
		}
		if manifest.Stateful && !sameBytes(accepted.GetStateHash(), hash[:]) {
			continue
		}
		message := statementFor(manifest.Stateful, key, ballot, accepted.GetEpoch(), accepted.GetManifestVersion(), id, accepted.GetAcceptorIncarnation(), hash)
		if !n.verifyAny(n.identityKeys(id), message, accepted.GetSignature(), accepted.GetAdditionalSignatures()) {
			continue
		}
		signers[id] = true
		relay = relay || config.isRelay(id)
	}
	if config.quorum(signers) {
		return true, nil
	}
	if manifest.Available && relay {
		return false, nil
	}
	return false, errors.New("lease commit lacks a quorum")
}

// Gate evaluates the relay data-path gate for one key (A2.4, A8, A11). It is
// open for the holder of the highest valid commit this node stores when:
//   - no ballot this node accepted from another proposer, and no relinquish
//     or release by the holder, supersedes the commit;
//   - this node itself accepted (or, while abstaining or not voting,
//     shadow-accepted) the committed ballot, or an earlier ballot of the same
//     holder, with an echo of its own promise;
//   - less than GateWindow of local time passed since the latest such promise,
//     and that promise was made after the last freeze of this host detected
//     from peer time (D4).
//
// Anchoring on the promise that the proposer echoed bounds the gate by the
// proposer's send time rather than by message delay, so the gate closes
// before any acceptor that accepted the ballot can accept another holder.
func (n *Node) Gate(key Key) GateDecision {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.gateLocked(key, n.clock.Now())
}

func (n *Node) gateLocked(key Key, now time.Duration) GateDecision {
	manifest := n.manifests[key.PolicyID]
	if manifest == nil {
		return GateDecision{Reason: "not in lease mode"}
	}
	if manifest.Closed {
		// Legacy admission applies to a closed policy, so its retained
		// holder keeps serving through the close (graceful close); the view
		// names it for the lease view.
		if retained, ok := manifest.Retained[key.Slot]; ok {
			return GateDecision{Holder: retained.Holder, Ballot: retained.Ballot, Reason: "lease closed: retained holder"}
		}
		return GateDecision{Reason: "not in lease mode"}
	}
	decision := GateDecision{LeaseMode: true}
	ak := n.acceptors[key]
	if ak == nil || ak.commit == nil {
		decision.Reason = "no commit"
		return decision
	}
	ballot := ak.commitBallot
	holder := ballot.Proposer
	decision.Holder, decision.Ballot = holder, ballot
	if relinquished, ok := ak.relinquished[holder]; ok && !relinquished.Less(ballot) {
		decision.Reason = "relinquished"
		return decision
	}
	if released, ok := ak.rec.Released[holder]; ok && !released.Less(ballot) {
		decision.Reason = "released"
		return decision
	}
	var own *acceptRecord
	for i := range ak.accepts {
		record := &ak.accepts[i]
		if record.ballot.IsZero() {
			continue
		}
		if record.ballot.Proposer != holder && ballot.Less(record.ballot) {
			decision.Reason = "superseded"
			return decision
		}
		// The window runs from this node's latest anchored accept of the
		// committed holder at or below the committed ballot. That is normally
		// the committed ballot itself. A renewal whose propose never reached
		// this node (its promise came after the round had its quorum, or the
		// frame was lost) leaves an earlier ballot of the same holder, promised
		// earlier, so the window closes sooner than the committed ballot's
		// would, and the gate does not close and reopen with every missed
		// renewal (A11, A15).
		if record.anchored && record.ballot.Proposer == holder && !ballot.Less(record.ballot) &&
			(own == nil || own.ballot.Less(record.ballot)) {
			own = record
		}
	}
	if ak.lease.open && ak.lease.holder != holder && ballot.Less(ak.lease.ballot) {
		decision.Reason = "superseded"
		return decision
	}
	if own == nil {
		decision.Reason = "no own accept"
		return decision
	}
	decision.Until = own.anchor + GateWindow
	if n.frozeOnce && own.anchor <= n.freezeBoundary {
		// The promise was timed on a clock that later lost time to a freeze
		// of this host (D4, A17): wait for a promise made after it.
		decision.Reason = "host freeze: waiting for a fresh promise"
		return decision
	}
	if now >= decision.Until {
		decision.Reason = "expired"
		return decision
	}
	decision.Open = true
	return decision
}

// AcceptorView lists the acceptor state of every known key, for relay
// GetHealth and daemon lease reports.
func (n *Node) AcceptorView() []KeyView {
	n.mu.Lock()
	defer n.mu.Unlock()
	now := n.clock.Now()
	keys := make([]Key, 0, len(n.acceptors))
	for key := range n.acceptors {
		if n.manifests[key.PolicyID] != nil {
			keys = append(keys, key)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].PolicyID != keys[j].PolicyID {
			return keys[i].PolicyID < keys[j].PolicyID
		}
		return keys[i].Slot < keys[j].Slot
	})
	views := make([]KeyView, 0, len(keys))
	for _, key := range keys {
		ak := n.acceptors[key]
		state, holder, reserved := n.keyState(ak, n.manifests[key.PolicyID], key, now)
		view := KeyView{
			Key: key, State: state, Holder: holder, ReservedFor: reserved, Promised: ak.promised(),
			CommitBallot: ak.commitBallot, Abstaining: !n.voting(key.PolicyID, now), CommitSince: ak.commitSince,
		}
		n.statefulView(&view, ak)
		views = append(views, view)
	}
	return views
}
