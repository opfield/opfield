package availabilitylease

import (
	"encoding/json"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// pendingTransition is a transition queued on a held stateful key (AS2).
type pendingTransition struct {
	Transition
	base [32]byte
	sent bool
}

type transitionResult struct {
	outcome TransitionOutcome
	reason  string
}

// maxTransitionResults bounds the remembered outcomes per key.
const maxTransitionResults = 16

// proposalBase is a state a round builds its proposal on.
type proposalBase struct {
	ballot Ballot
	data   []byte
	state  HolderState
}

// statefulPromise decides, after each counted promise of a stateful round,
// whether the round can propose, and builds the proposal: the highest KNOWN
// accepted state of its promise quorum plus at most one transition (AS2).
func (n *Node) statefulPromise(pk *proposerKey, r *round, now time.Duration) {
	if !r.config.quorum(r.promised) {
		return
	}
	var ready bool
	switch r.purpose {
	case RoleHolding, RoleRecovering:
		ready = n.holderProposal(pk, r, now)
	default:
		ready = n.acquireProposal(pk, r, now)
	}
	if ready && pk.round == r {
		n.beginPropose(pk, r, now)
	}
}

func (r *round) knownIDs() map[string]bool {
	ids := make(map[string]bool, len(r.known))
	for id := range r.known {
		ids[id] = true
	}
	return ids
}

// holderProposal builds a renewal or recovery proposal. The holder's own
// certified state is the latest chosen one while its lease is continuous (a
// renewal before its soft fence, a recovery before its watchdog deadline): no
// other proposer can collect a majority while acceptors of its last QC hold
// for it, and an acceptor that lost its state abstains for as long. So a
// strict voting majority suffices, and a higher KNOWN ballot of another
// proposer means the lease was lost. Without an own record (a daemon whose
// state directory was lost) the KNOWN-majority rule applies.
func (n *Node) holderProposal(pk *proposerKey, r *round, now time.Duration) bool {
	own := pk.certified
	best, found := highestKnown(r.known)
	if found && best.ballot.Proposer != n.id && (own == nil || own.ballot.Less(best.ballot)) {
		n.logf("stateful lease %s: another proposer's state %s is accepted; fencing", pk.key, best.ballot)
		n.fence(pk, FenceOtherHolder, now)
		return false
	}
	if own == nil && !r.config.quorum(r.knownIDs()) {
		return false
	}
	var base proposalBase
	if own != nil {
		base = proposalBase{ballot: own.ballot, data: own.data, state: own.state}
	}
	if found && (own == nil || own.ballot.Less(best.ballot)) {
		base = proposalBase{ballot: best.ballot, data: best.data, state: best.state}
	}
	data, state := base.data, base.state
	if pending := pk.pending; pending != nil {
		switch {
		case state.TransitionID == pending.ID:
			// A round that carried it was chosen; this one certifies it.
			r.transition = pending.ID
		case stateHash(base.data) == pending.base:
			state = applyTransition(state, pending.Transition, n.id)
			data = encodeHolderState(state)
			r.transition = pending.ID
			if !pending.sent {
				pending.sent = true
				n.holderDirty[pk.key] = true
				n.setResult(pk, pending.ID, TransitionSent, "")
			}
		default:
			n.setResult(pk, pending.ID, TransitionRejected, "the certified state changed since the transition was computed")
			pk.pending = nil
			n.holderDirty[pk.key] = true
		}
	}
	r.setProposal(data, state)
	return true
}

// acquireProposal builds an acquisition proposal (AS1, AS2, AS6, AS10): a
// forced one on a strict voting majority; otherwise the adopted state of a
// KNOWN majority of every quorum set, only when the application finds this
// node eligible under it, proposed unchanged with this node as holder and
// PendingPromotion; or the bootstrap value when every voter reports UNKNOWN.
func (n *Node) acquireProposal(pk *proposerKey, r *round, now time.Duration) bool {
	best, found := highestKnown(r.known)
	if force := n.activeForce(pk, now); force != nil {
		if found && force.req.Over.Less(best.ballot) && best.ballot.Proposer != n.id {
			// A newer ballot of another proposer was accepted after the commit
			// the operator forced over (for example the previous holder came
			// back, took writes and died again, and its commit never reached
			// this node). Overriding it needs a new operator decision (AS10).
			force.outcome, force.newer = ForceSuperseded, best.ballot
			force.reason = "ballot " + best.ballot.String() + " of " + best.ballot.Proposer + " was accepted after the commit forced over"
			n.finishRound(pk, now)
			return false
		}
		state := HolderState{
			Value: force.req.Value, Holder: n.id, PendingPromotion: true, TransitionID: force.req.OperationID,
			Forced: &ForcedMarker{OperationID: force.req.OperationID, Over: force.req.Over, Holder: n.id},
		}
		if found {
			state.PromotedHolder, state.Generation, state.Forced.Base = best.state.PromotedHolder, best.state.Generation, best.ballot
		}
		state.Generation++
		r.forced = force.req.OperationID
		r.setProposal(encodeHolderState(state), state)
		return true
	}
	if r.config.quorum(r.knownIDs()) {
		input := EligibilityInput{
			Key: pk.key, Phase: EligibilityPromise, Adopted: cloneHolderState(best.state), AdoptedBallot: best.ballot,
			PreviousHolder: best.ballot.Proposer, PreviousReleased: best.released, ReleasedSuccessor: best.releasedSuccessor,
			Designated: pk.designated,
		}
		if ok, reason := n.eligible(pk.key, input); !ok {
			n.logf("stateful lease %s: not eligible under %s: %s", pk.key, best.ballot, reason)
			n.finishRound(pk, now)
			return false
		}
		state := best.state
		state.Holder, state.PendingPromotion, state.TransitionID = n.id, true, ""
		state.Generation++
		r.setProposal(encodeHolderState(state), state)
		return true
	}
	return n.bootstrapProposal(pk, r)
}

// bootstrapProposal is the named bootstrap holder's first certification
// (A5, M10): every voter of every quorum set promised, and nobody remembers
// anything but this node's own earlier bootstrap attempts. Then nothing else
// was ever chosen for the key, short of a majority losing its state. The
// highest such attempt is proposed again, else the application's bootstrap
// value.
func (n *Node) bootstrapProposal(pk *proposerKey, r *round) bool {
	if r.purpose != RoleBootstrapping || pk.certified != nil {
		return false
	}
	for _, id := range r.config.voterIDs {
		if !r.promised[id] {
			return false
		}
	}
	for _, report := range r.known {
		if !isBootstrapState(report.state, n.id) {
			return false
		}
	}
	if best, found := highestKnown(r.known); found {
		r.setProposal(best.data, best.state)
		return true
	}
	handler := n.handlers[pk.key.PolicyID]
	if handler == nil || handler.BootstrapValue == nil {
		return false
	}
	value, err := handler.BootstrapValue(pk.key)
	if err != nil || len(value) > MaxStateValueBytes {
		n.logf("stateful lease %s: no bootstrap value: %v", pk.key, err)
		return false
	}
	state := HolderState{Value: append([]byte(nil), value...), Holder: n.id, PromotedHolder: n.id, Generation: 1}
	r.setProposal(encodeHolderState(state), state)
	return true
}

func isBootstrapState(state HolderState, holder string) bool {
	return state.Holder == holder && state.PromotedHolder == holder && state.Generation == 1 && state.TransitionID == "" &&
		!state.PendingPromotion && state.Forced == nil
}

// restartStatefulAcquisition restarts a stateful acquisition at once under
// the newer manifest a stale-manifest or stale-epoch NACK delivered (a voter
// change settling while the key changes hands), instead of waiting out the
// round, the re-observation and the rank delay again. Eligibility is checked
// again on the new round's promises.
func (n *Node) restartStatefulAcquisition(pk *proposerKey, r *round, reason pb.LeaseNackReason, now time.Duration) bool {
	if !r.stateful || reason == pb.LeaseNackReason_LEASE_NACK_REASON_BALLOT_TOO_LOW ||
		(pk.role != RoleAcquiring && pk.role != RoleBootstrapping) {
		return false
	}
	current := n.manifests[pk.key.PolicyID]
	if current == nil || current.Closed || current.Version <= r.manifest.Version || !current.isCandidate(n.id) {
		return false
	}
	pk.round = nil
	n.startRound(pk, current, r.purpose, now)
	return true
}

func (r *round) setProposal(data []byte, state HolderState) {
	r.proposal, r.proposalState, r.proposalHash = data, state, stateHash(data)
}

func applyTransition(state HolderState, transition Transition, holder string) HolderState {
	state.Value = append([]byte(nil), transition.Value...)
	state.TransitionID = transition.ID
	state.Generation++
	if transition.Promoted {
		state.PendingPromotion, state.PromotedHolder, state.Forced = false, holder, nil
	}
	return state
}

func (n *Node) eligible(key Key, input EligibilityInput) (bool, string) {
	handler := n.handlers[key.PolicyID]
	if handler == nil || handler.Eligible == nil {
		return false, "no state handler"
	}
	return handler.Eligible(input)
}

// queryEligible evaluates eligibility on fresh query statuses before a
// prepare, so an ineligible candidate does not bump promised ballots and duel
// with an eligible one. It needs a KNOWN majority of every quorum set.
func (n *Node) queryEligible(pk *proposerKey, manifest *Manifest, now time.Duration) bool {
	config := manifest.Voters
	if config == nil {
		return false
	}
	reports := map[string]knownAccepted{}
	for id, obs := range pk.obs {
		if now-obs.at > observationMaxAge || !config.isVoter(id) {
			continue
		}
		if report, ok := parseKnown(obs.accepted); ok {
			reports[id] = report
		}
	}
	ids := make(map[string]bool, len(reports))
	for id := range reports {
		ids[id] = true
	}
	if !config.quorum(ids) {
		return false
	}
	best, _ := highestKnown(reports)
	ok, _ := n.eligible(pk.key, EligibilityInput{
		Key: pk.key, Phase: EligibilityQuery, Adopted: cloneHolderState(best.state), AdoptedBallot: best.ballot,
		PreviousHolder: best.ballot.Proposer, PreviousReleased: best.released, ReleasedSuccessor: best.releasedSuccessor,
		Designated: pk.designated,
	})
	return ok
}

// certify records the state a stateful round's QC certified (AS2), resolves
// the transition it carried and a forced acquisition, and persists them.
func (n *Node) certify(pk *proposerKey, r *round) {
	pk.certified = &certified{
		ballot: r.ballot, epoch: r.config.Epoch, manifestVersion: r.manifest.Version,
		data: r.proposal, state: r.proposalState, hash: r.proposalHash,
	}
	if pending := pk.pending; pending != nil && r.transition == pending.ID {
		n.setResult(pk, pending.ID, TransitionCertified, "")
		pk.pending = nil
	}
	if pk.pending != nil {
		// Carry the queued transition in the next round at once.
		pk.retry, pk.nextRoundAt = true, 0
	}
	if r.forced != "" && pk.force != nil && pk.force.req.OperationID == r.forced {
		pk.force.outcome = ForceAcquired
	}
	n.holderDirty[pk.key] = true
}

// dropPending resolves a queued transition when the node stops holding.
func (n *Node) dropPending(pk *proposerKey, reason string) {
	if pk.pending == nil {
		return
	}
	if pk.pending.sent {
		reason += "; a round carrying it may still have been chosen"
	}
	n.setResult(pk, pk.pending.ID, TransitionRejected, reason)
	pk.pending = nil
	n.holderDirty[pk.key] = true
}

func (n *Node) setResult(pk *proposerKey, id string, outcome TransitionOutcome, reason string) {
	if pk.results == nil {
		pk.results = map[string]transitionResult{}
	}
	if _, ok := pk.results[id]; !ok {
		pk.resultOrder = append(pk.resultOrder, id)
	}
	pk.results[id] = transitionResult{outcome: outcome, reason: reason}
	for len(pk.resultOrder) > maxTransitionResults {
		delete(pk.results, pk.resultOrder[0])
		pk.resultOrder = pk.resultOrder[1:]
	}
}

// holderPuts adds the holder records of dirty stateful keys to a store
// transaction (AS2, M1).
func (n *Node) holderPuts(puts map[string][]byte) {
	for key := range n.holderDirty {
		pk := n.proposers[key]
		if pk == nil {
			continue
		}
		record := holderRecord{}
		if c := pk.certified; c != nil {
			record.Certified = &certifiedRecord{Ballot: c.ballot, Epoch: c.epoch, ManifestVersion: c.manifestVersion, State: c.data}
		}
		if p := pk.pending; p != nil {
			record.Pending = &pendingRecord{ID: p.ID, Value: p.Value, Promoted: p.Promoted, Base: append([]byte(nil), p.base[:]...), Sent: p.sent}
		}
		data, _ := json.Marshal(record)
		puts[holderRecordName(key)] = data
	}
}

// restoreHolderRecord loads a holder record at start: the certified state is
// marked restored until a round of this incarnation certifies again, and a
// pending transition resumes (AS2).
func (n *Node) restoreHolderRecord(name string, data []byte) {
	key, ok := parseKeyName(name, prefixHolder)
	var record holderRecord
	if !ok || json.Unmarshal(data, &record) != nil {
		return
	}
	pk := n.proposerFor(key)
	if c := record.Certified; c != nil {
		state, err := decodeHolderState(c.State)
		if err != nil {
			return
		}
		pk.certified = &certified{
			ballot: c.Ballot, epoch: c.Epoch, manifestVersion: c.ManifestVersion, data: c.State, state: state,
			hash: stateHash(c.State), restored: true,
		}
	}
	if p := record.Pending; p != nil && p.ID != "" {
		base, ok := hashFromBytes(p.Base)
		if ok {
			pk.pending = &pendingTransition{Transition: Transition{ID: p.ID, Value: p.Value, Promoted: p.Promoted}, base: base, sent: p.Sent}
		}
	}
}
