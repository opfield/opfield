package availabilitylease

import (
	"errors"
	"time"
)

// CapabilityV3 is advertised by relays and daemons that speak the stateful
// lease protocol (certified holder state). A stateful policy may only be
// published when every participant advertises it; stateless policies keep
// working with availability_lease_v2 participants.
const CapabilityV3 = "availability_lease_v3"

// MaxStateValueBytes bounds HolderState.Value, the application part of a
// certified holder state.
const MaxStateValueBytes = 1024

// ForceWindow is how long an armed forced acquisition stays valid (AS10).
const ForceWindow = 5 * time.Minute

var (
	// ErrNoManifest: this node holds no manifest for the key's policy (yet);
	// it learns it from the Gateway or from a peer's frames.
	ErrNoManifest = errors.New("no availability lease manifest for the policy on this node")
	// ErrNotStateful: the key's policy is not stateful (or is lease closed).
	ErrNotStateful = errors.New("availability lease policy is not stateful")
	// ErrNotHolding: this node does not hold the key.
	ErrNotHolding = errors.New("availability lease is not held")
	// ErrTransitionPending: another transition of the key is queued or
	// possibly chosen; wait until TransitionStatus resolves it.
	ErrTransitionPending = errors.New("availability lease transition already pending")
	// ErrStateTooLarge: a state value exceeds MaxStateValueBytes.
	ErrStateTooLarge = errors.New("availability lease state value is too large")
	// ErrInvalidTransition: a transition without an id.
	ErrInvalidTransition = errors.New("availability lease transition needs an id")
	// ErrNotCandidate: this node is not a candidate of the key's policy.
	ErrNotCandidate = errors.New("node is not an availability lease candidate of the policy")
	// ErrNotReady: this node is not marked ready for the policy
	// (SetCandidateReady) or has no state handler, so it could not hold.
	ErrNotReady = errors.New("node is not ready to hold the policy's keys")
	// ErrHolding: a forced acquisition was requested on the holder itself.
	ErrHolding = errors.New("availability lease is already held by this node")
	// ErrForceStale: this node knows a commit newer than the ballot the
	// operator forced over.
	ErrForceStale = errors.New("a newer availability lease commit exists than the one forced over")
	// ErrForceArmed: another forced acquisition of the key is armed.
	ErrForceArmed = errors.New("another forced availability lease acquisition is armed")
	// ErrNoQuorum: fresh statuses do not show a strict majority of every
	// quorum set answering; retry after about a second.
	ErrNoQuorum = errors.New("no availability lease voter majority is reachable")
)

// HolderState is the certified value of a stateful key. The library
// maintains every field but Value, which is the application's state.
type HolderState struct {
	// Value is the application state, opaque to the library (at most
	// MaxStateValueBytes).
	Value []byte
	// Holder is the proposer of the ballot that proposed this state.
	Holder string
	// PendingPromotion is set by every acquisition and cleared by the
	// holder's Promoted transition.
	PendingPromotion bool
	// PromotedHolder is the last holder whose Promoted transition was
	// certified.
	PromotedHolder string
	// Generation grows by one on every change of the state.
	Generation uint64
	// TransitionID is the id of the last application transition applied to
	// Value; empty after an acquisition or bootstrap.
	TransitionID string
	// Forced is set by a forced acquisition (AS10) and kept until the next
	// Promoted transition.
	Forced *ForcedMarker
}

// ForcedMarker records a forced acquisition in the certified state.
type ForcedMarker struct {
	OperationID string
	// Over is the highest commit ballot the operator saw when forcing.
	Over   Ballot
	Holder string
	// Base is the highest KNOWN accepted ballot the forced state replaced;
	// zero when none was known.
	Base Ballot
}

// EligibilityPhase says which evidence an eligibility check is based on.
type EligibilityPhase int

const (
	// EligibilityQuery: fresh query statuses, before a prepare is sent, so an
	// ineligible candidate does not duel with an eligible one.
	EligibilityQuery EligibilityPhase = iota + 1
	// EligibilityPromise: the promise quorum of the round, before propose.
	// This is the authoritative check.
	EligibilityPromise
)

// EligibilityInput is what a candidate's eligibility callback decides on. It
// always comes from a majority of every quorum set of KNOWN acceptors.
type EligibilityInput struct {
	Key   Key
	Phase EligibilityPhase
	// Adopted is the state of the highest KNOWN accepted ballot, AdoptedBallot.
	Adopted       HolderState
	AdoptedBallot Ballot
	// PreviousHolder is AdoptedBallot's proposer (AS6).
	PreviousHolder string
	// PreviousReleased: that proposer released AdoptedBallot (final
	// release) as far as any KNOWN acceptor of the majority knows, and the
	// successor that release designated.
	PreviousReleased  bool
	ReleasedSuccessor string
	// Designated: this node is the designated successor of a release it saw
	// (D9).
	Designated bool
}

// StateHandler is the application side of a stateful policy on a candidate.
// Its callbacks run under the node lock and must not call the Node.
type StateHandler struct {
	// Eligible decides whether this node may take the key over under the
	// adopted state. A nil Eligible means never eligible.
	Eligible func(EligibilityInput) (ok bool, reason string)
	// BootstrapValue returns the initial application value the named
	// bootstrap holder certifies when every voter reports UNKNOWN.
	BootstrapValue func(Key) ([]byte, error)
}

// Transition is one application change of a held stateful key.
type Transition struct {
	// ID is unique per key; it appears as HolderState.TransitionID once
	// certified.
	ID string
	// Value is the complete new application value, computed from the
	// certified value current when the transition is proposed.
	Value []byte
	// Promoted clears PendingPromotion, records this holder as
	// PromotedHolder and clears a forced marker.
	Promoted bool
}

// TransitionOutcome is the state of a proposed transition.
type TransitionOutcome int

const (
	TransitionUnknown TransitionOutcome = iota
	// TransitionQueued: waiting for the next round.
	TransitionQueued
	// TransitionSent: a round carrying it was proposed; it is possibly
	// chosen until a later round resolves it.
	TransitionSent
	// TransitionCertified: a QC over every quorum set covers it.
	TransitionCertified
	// TransitionRejected: the adopted state no longer matches the state it
	// was computed from; propose it again from CommittedState.
	TransitionRejected
)

// CertifiedState is a stateful key's state with the ballot whose QC (a
// majority of every quorum set) certified it.
type CertifiedState struct {
	Key             Key
	Ballot          Ballot
	Epoch           uint64
	ManifestVersion uint64
	State           HolderState
	// Hash is sha256 of the encoded state, which the accept v2 statements of
	// the QC cover.
	Hash [32]byte
	// Restored: loaded from the store after a restart and not certified
	// again by this incarnation yet.
	Restored bool
}

// PendingTransition is a queued or possibly chosen transition. Configure the
// application for the certified state AND this one until it resolves (AS5).
type PendingTransition struct {
	Transition
	// Base is the hash of the certified state it was computed from.
	Base [32]byte
	// Sent: a round carrying it was proposed, so it is possibly chosen.
	Sent bool
}

// ForceRequest arms a forced acquisition (AS10).
type ForceRequest struct {
	// OperationID is the audit id; it becomes ForcedMarker.OperationID and
	// the certified TransitionID.
	OperationID string
	// Over is the highest commit ballot the operator saw.
	Over Ballot
	// Value is the application value to certify, for example the forced
	// flag, timeline and fork position of a database.
	Value []byte
}

// ForceOutcome is the state of an armed forced acquisition.
type ForceOutcome int

const (
	ForceNone ForceOutcome = iota
	// ForcePending: armed; the node acquires once the key is free and a
	// strict voter majority promises.
	ForcePending
	// ForceAcquired: the forced acquisition committed (single use).
	ForceAcquired
	// ForceExpired: ForceWindow passed.
	ForceExpired
	// ForceSuperseded: a commit newer than Over was observed.
	ForceSuperseded
)

// ForceStatus reports the forced acquisition of a key.
type ForceStatus struct {
	OperationID string
	Over        Ballot
	ExpiresAt   time.Duration
	Outcome     ForceOutcome
	Reason      string
	// Newer is the accepted ballot of another proposer, newer than Over, that
	// a forced round found in its promise quorum and that ended the override
	// (ForceSuperseded). An operator who still wants to force must decide
	// again, over this ballot. Zero when a commit superseded the override.
	Newer Ballot
}
