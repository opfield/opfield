package availabilitylease

import (
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// forceState is an armed forced acquisition of one key (AS10).
type forceState struct {
	req     ForceRequest
	until   time.Duration
	outcome ForceOutcome
	reason  string
	// newer is the accepted ballot that superseded the override in its own
	// promise quorum; zero when a commit superseded it.
	newer Ballot
}

// ForceAcquire arms a single-use forced acquisition (AS10). It skips only
// the eligibility callback (with the KNOWN-majority rule that belongs to it)
// and still needs a strict majority of voting promises: without one nothing
// happens. It expires after ForceWindow or when a commit newer than req.Over
// is observed, and is consumed by the acquisition, whose certified state
// records the forced marker. Errors: ErrNoManifest, ErrNotStateful, ErrNotCandidate,
// ErrNotReady, ErrHolding, ErrForceStale, ErrForceArmed, ErrNoQuorum,
// ErrStateTooLarge, ErrInvalidTransition.
func (n *Node) ForceAcquire(key Key, req ForceRequest) error {
	var err error
	n.run(func(now time.Duration) { err = n.forceAcquire(key, req, now) })
	return err
}

func (n *Node) forceAcquire(key Key, req ForceRequest, now time.Duration) error {
	manifest := n.manifests[key.PolicyID]
	switch {
	case manifest == nil:
		return ErrNoManifest
	case !manifest.Stateful || manifest.Closed:
		return ErrNotStateful
	case req.OperationID == "":
		return ErrInvalidTransition
	case len(req.Value) > MaxStateValueBytes:
		return ErrStateTooLarge
	case !manifest.isCandidate(n.id) || key.Slot >= manifest.Slots:
		return ErrNotCandidate
	case !n.ready[key.PolicyID] || n.handlers[key.PolicyID] == nil:
		return ErrNotReady
	}
	pk := n.proposerFor(key)
	if pk.holdsLease() {
		return ErrHolding
	}
	if active := n.activeForce(pk, now); active != nil {
		if active.req.OperationID == req.OperationID && active.req.Over == req.Over && sameBytes(active.req.Value, req.Value) {
			return nil
		}
		return ErrForceArmed
	}
	if pk.commit != nil && req.Over.Less(pk.commitBallot) {
		return ErrForceStale
	}
	if !n.voterMajorityAnswers(pk, manifest, now) {
		n.sendQuery(key)
		pk.nextQueryAt = now + queryInterval
		return ErrNoQuorum
	}
	req.Value = append([]byte(nil), req.Value...)
	pk.force = &forceState{req: req, until: now + ForceWindow, outcome: ForcePending}
	pk.nextRoundAt = now
	return nil
}

// voterMajorityAnswers reports whether fresh statuses from a majority of
// every quorum set arrived, so a forced acquisition is not armed where it
// cannot reach a strict majority (the CLI refuses then).
func (n *Node) voterMajorityAnswers(pk *proposerKey, manifest *Manifest, now time.Duration) bool {
	config := manifest.Voters
	if config == nil {
		return false
	}
	answered := map[string]bool{}
	for id, obs := range pk.obs {
		if now-obs.at <= observationMaxAge && config.isVoter(id) && obs.state != pb.LeaseKeyState_LEASE_KEY_STATE_UNSPECIFIED {
			answered[id] = true
		}
	}
	return config.quorum(answered)
}

// activeForce returns the armed forced acquisition of a key, expiring it
// after ForceWindow.
func (n *Node) activeForce(pk *proposerKey, now time.Duration) *forceState {
	force := pk.force
	if force == nil || force.outcome != ForcePending {
		return nil
	}
	if now >= force.until {
		force.outcome, force.reason = ForceExpired, "no acquisition within the force window"
		return nil
	}
	return force
}

// supersedeForce ends an armed forced acquisition when a commit newer than
// the one the operator forced over appears (AS10).
func (n *Node) supersedeForce(pk *proposerKey, ballot Ballot) {
	if force := pk.force; force != nil && force.outcome == ForcePending && force.req.Over.Less(ballot) && ballot.Proposer != n.id {
		force.outcome, force.reason = ForceSuperseded, "a newer commit of "+ballot.Proposer+" appeared"
	}
}

// ForceStatus reports the forced acquisition armed for a key.
func (n *Node) ForceStatus(key Key) ForceStatus {
	n.mu.Lock()
	defer n.mu.Unlock()
	pk := n.proposers[key]
	if pk == nil || pk.force == nil {
		return ForceStatus{}
	}
	n.activeForce(pk, n.clock.Now())
	force := pk.force
	return ForceStatus{
		OperationID: force.req.OperationID, Over: force.req.Over, ExpiresAt: force.until, Outcome: force.outcome, Reason: force.reason,
		Newer: force.newer,
	}
}
