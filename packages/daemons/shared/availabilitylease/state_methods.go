package availabilitylease

import (
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// ProposeTransition queues one transition on top of the holder's certified
// state (AS2). It rides the next round (a renewal starts at once) and is
// persisted before the call returns. Proposing the id of the queued or the
// certified transition again is a no-op. Errors: ErrNoManifest, ErrNotStateful,
// ErrNotHolding, ErrTransitionPending, ErrStateTooLarge,
// ErrInvalidTransition.
func (n *Node) ProposeTransition(key Key, transition Transition) error {
	var err error
	n.run(func(now time.Duration) { err = n.proposeTransition(key, transition, now) })
	return err
}

func (n *Node) proposeTransition(key Key, transition Transition, now time.Duration) error {
	manifest := n.manifests[key.PolicyID]
	switch {
	case manifest == nil:
		return ErrNoManifest
	case !manifest.Stateful:
		return ErrNotStateful
	case transition.ID == "":
		return ErrInvalidTransition
	case len(transition.Value) > MaxStateValueBytes:
		return ErrStateTooLarge
	}
	pk := n.proposers[key]
	if pk == nil || pk.role != RoleHolding || pk.certified == nil || pk.certified.restored {
		return ErrNotHolding
	}
	if pending := pk.pending; pending != nil {
		if pending.ID == transition.ID && pending.Promoted == transition.Promoted && sameBytes(pending.Value, transition.Value) {
			return nil
		}
		return ErrTransitionPending
	}
	if pk.certified.state.TransitionID == transition.ID {
		return nil
	}
	transition.Value = append([]byte(nil), transition.Value...)
	pk.pending = &pendingTransition{Transition: transition, base: pk.certified.hash}
	n.setResult(pk, transition.ID, TransitionQueued, "")
	n.holderDirty[key] = true
	pk.retry, pk.nextRoundAt = true, now
	return nil
}

// TransitionStatus reports the outcome of a transition this node proposed,
// with the reason of a rejection. Outcomes of earlier transitions are kept
// for the last 16 per key and are lost on restart; a certified transition
// stays visible as CommittedState().State.TransitionID.
func (n *Node) TransitionStatus(key Key, id string) (TransitionOutcome, string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	pk := n.proposers[key]
	if pk == nil {
		return TransitionUnknown, ""
	}
	if pk.pending != nil && pk.pending.ID == id {
		if pk.pending.sent {
			return TransitionSent, ""
		}
		return TransitionQueued, ""
	}
	if result, ok := pk.results[id]; ok {
		return result.outcome, result.reason
	}
	if pk.certified != nil && pk.certified.state.TransitionID == id {
		return TransitionCertified, ""
	}
	return TransitionUnknown, ""
}

// CommittedState returns the state of this node's latest ballot for which it
// collected a QC over every quorum set (stateful policies are strict only,
// so never a minority). It is never taken from another node's commit. It
// stays available after the node stopped holding; check HolderStatus.
func (n *Node) CommittedState(key Key) (CertifiedState, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	pk := n.proposers[key]
	if pk == nil || pk.certified == nil {
		return CertifiedState{}, false
	}
	return pk.certified.public(key), true
}

// PendingState returns the queued or possibly chosen transition of a key.
// Configure the application for the certified state AND this one until it
// resolves (AS5).
func (n *Node) PendingState(key Key) (PendingTransition, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	pk := n.proposers[key]
	if pk == nil || pk.pending == nil {
		return PendingTransition{}, false
	}
	pending := *pk.pending
	pending.Value = append([]byte(nil), pending.Value...)
	return PendingTransition{Transition: pending.Transition, Base: pending.base, Sent: pending.sent}, true
}

// ObservedCommit returns the latest verified commit of a stateful key this
// node knows, of any holder, with its state. It is informational (views and
// reports); no safety decision may rest on it (M1).
func (n *Node) ObservedCommit(key Key) (CertifiedState, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.stateful(key.PolicyID) {
		return CertifiedState{}, false
	}
	var commit *pb.LeaseCommit
	var ballot Ballot
	if pk := n.proposers[key]; pk != nil && pk.commit != nil {
		commit, ballot = pk.commit, pk.commitBallot
	}
	if ak := n.acceptors[key]; ak != nil && ak.commit != nil && (commit == nil || ballot.Less(ak.commitBallot)) {
		commit, ballot = ak.commit, ak.commitBallot
	}
	if commit == nil {
		return CertifiedState{}, false
	}
	state, err := decodeHolderState(commit.GetState())
	if err != nil {
		return CertifiedState{}, false
	}
	return CertifiedState{
		Key: key, Ballot: ballot, Epoch: commit.GetEpoch(), ManifestVersion: commit.GetManifestVersion(),
		State: cloneHolderState(state), Hash: stateHash(commit.GetState()),
	}, true
}
