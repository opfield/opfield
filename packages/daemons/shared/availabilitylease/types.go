package availabilitylease

import (
	"fmt"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// Key identifies one lease: failover policies use slot 0, replicated policies
// slots 0..desiredReplicaCount-1 (D1).
type Key struct {
	PolicyID string
	Slot     uint32
}

func (k Key) String() string { return fmt.Sprintf("%s/%d", k.PolicyID, k.Slot) }

func (k Key) proto() *pb.LeaseKey { return &pb.LeaseKey{PolicyId: k.PolicyID, Slot: k.Slot} }

func keyFromProto(value *pb.LeaseKey) (Key, bool) {
	if value == nil || value.GetPolicyId() == "" {
		return Key{}, false
	}
	return Key{PolicyID: value.GetPolicyId(), Slot: value.GetSlot()}, true
}

// Ballot is (round, incarnation, proposer). Round orders first so any proposer
// can exceed a ballot it has seen; the persisted incarnation keeps ballots of
// a restarted proposer unique (A3).
type Ballot struct {
	Round       uint64
	Incarnation uint64
	Proposer    string
}

func (b Ballot) IsZero() bool { return b.Round == 0 && b.Incarnation == 0 && b.Proposer == "" }

// Compare returns -1, 0 or 1.
func (b Ballot) Compare(other Ballot) int {
	switch {
	case b.Round != other.Round:
		return cmpUint(b.Round, other.Round)
	case b.Incarnation != other.Incarnation:
		return cmpUint(b.Incarnation, other.Incarnation)
	case b.Proposer < other.Proposer:
		return -1
	case b.Proposer > other.Proposer:
		return 1
	}
	return 0
}

func (b Ballot) Less(other Ballot) bool { return b.Compare(other) < 0 }

func (b Ballot) String() string { return fmt.Sprintf("%d.%d.%s", b.Round, b.Incarnation, b.Proposer) }

func (b Ballot) proto() *pb.LeaseBallot {
	return &pb.LeaseBallot{Round: b.Round, Incarnation: b.Incarnation, ProposerId: b.Proposer}
}

func ballotFromProto(value *pb.LeaseBallot) Ballot {
	return Ballot{Round: value.GetRound(), Incarnation: value.GetIncarnation(), Proposer: value.GetProposerId()}
}

func cmpUint(a, b uint64) int {
	if a < b {
		return -1
	}
	return 1
}

func maxBallot(a, b Ballot) Ballot {
	if a.Less(b) {
		return b
	}
	return a
}

// Role is the local proposer state of one key.
type Role int

const (
	RoleNone Role = iota
	// RoleCandidate observes the key and takes over by rank when it expires.
	RoleCandidate
	// RoleAcquiring runs an acquisition round.
	RoleAcquiring
	// RoleBootstrapping is the named initial holder acquiring a reserved key
	// while its legacy container keeps running (A5).
	RoleBootstrapping
	// RoleRecovering holds an unconfirmed container after a daemon restart
	// and must renew before its watchdog deadline (A2.3).
	RoleRecovering
	// RoleHolding holds the lease and renews every RenewInterval.
	RoleHolding
	// RoleFencing must stop its container now; it no longer renews.
	RoleFencing
	// RoleAbandoned stopped renewing without confirming the stop; the
	// watchdog fences at the deadline (A6).
	RoleAbandoned
	// RoleReleasing relinquishes relay gates, then releases acceptors (A6).
	RoleReleasing
	// RoleRetained kept its copy running when the lease closed: a majority
	// of every quorum set of the closed manifest confirmed the close to it,
	// so no node can acquire the key any more. The copy is no longer
	// lease-bound: no renewals, no deadline (graceful close, retain.go).
	RoleRetained
)

var roleNames = [...]string{"none", "candidate", "acquiring", "bootstrapping", "recovering", "holding", "fencing", "abandoned", "releasing", "retained"}

func (r Role) String() string {
	if int(r) < len(roleNames) {
		return roleNames[r]
	}
	return fmt.Sprintf("role(%d)", int(r))
}

// FenceReason says why a holder must stop its container.
type FenceReason string

const (
	FenceNone        FenceReason = ""
	FenceTimer       FenceReason = "renewal_timeout"
	FenceOtherHolder FenceReason = "other_holder_committed"
	FenceClosed      FenceReason = "lease_closed"
	FenceRecovery    FenceReason = "recovery_failed"
	FenceRemoved     FenceReason = "removed_from_manifest"
	// FenceFrozen: a peer's clock showed this host was frozen while it held
	// the key (D4).
	FenceFrozen FenceReason = "host_frozen"
	// FenceWatchdogLost: the watchdog heartbeat is lost; renewals stopped and
	// the daemon kills the containers itself (A12.4).
	FenceWatchdogLost FenceReason = "watchdog_lost"
	// FenceAbandoned: renewals stopped without a fence reason, for a stop
	// that could not be confirmed (A6).
	FenceAbandoned FenceReason = "abandoned"
)

// HolderStatus is the proposer view of one key for the docker daemon.
type HolderStatus struct {
	Key  Key
	Role Role
	// Holding is true while a committed lease is current and not fencing.
	Holding bool
	// MayStart allows starting or restarting the container (A2.1, A5 gate).
	MayStart bool
	// Ballot of the last committed round.
	Ballot Ballot
	// Deadline is the local clock value by which the container must be dead
	// unless a later round succeeds; the watchdog record (A2.2, A12.1).
	// Zero means no lease-bound container is allowed.
	Deadline time.Duration
	// SoftFenceAt is when the daemon begins a graceful stop.
	SoftFenceAt time.Duration
	// FenceNow asks the daemon to stop the container immediately.
	FenceNow    bool
	FenceReason FenceReason
	Available   bool
	// Retained: the lease closed and this node keeps its copy running
	// without a lease (RoleRetained): disarm its watchdog deadline, keep its
	// endpoints, never stop it for lease reasons. Retaining: the lease is
	// closing and a closed manifest names this node the retained holder;
	// the copy keeps running on its lease budget while the voters confirm.
	Retained  bool
	Retaining bool
}

// EventKind classifies lease transitions reported to the Gateway (D9 audit).
type EventKind string

const (
	EventAcquired EventKind = "acquired"
	EventFence    EventKind = "fence"
	EventReleased EventKind = "released"
	EventHandoff  EventKind = "handoff"
	// EventRetained: graceful close confirmed; the copy keeps running.
	EventRetained EventKind = "retained"
)

type Event struct {
	Kind      EventKind
	Key       Key
	Ballot    Ballot
	Successor string
	Reason    FenceReason
	At        time.Duration
	// Forced is the operation id of a forced acquisition (AS10) on
	// EventAcquired; empty otherwise.
	Forced string
	// Recovered: EventAcquired of a key this node recovered after a restart
	// (Recover), not a takeover.
	Recovered bool
}

// GateDecision is the relay data-path gate for one key (A2.4, A8, A11).
type GateDecision struct {
	// LeaseMode is false when this relay has no lease manifest for the policy
	// or the manifest is lease-closed; the caller applies legacy admission.
	LeaseMode bool
	Open      bool
	Holder    string
	Ballot    Ballot
	// Until is the local time the gate closes unless refreshed.
	Until  time.Duration
	Reason string
}

// KeyView is the acceptor view of one key for relay GetHealth and lease reports.
type KeyView struct {
	Key          Key
	State        pb.LeaseKeyState
	Holder       string
	ReservedFor  string
	Promised     Ballot
	CommitBallot Ballot
	Abstaining   bool
	// CommitSince is when this acceptor first stored a commit of the current
	// commit holder (CommitBallot.Proposer), on its lease clock; zero when
	// unknown (a commit restored after a restart). Reports turn it into the
	// takeover time the Gateway records (N-5).
	CommitSince time.Duration
	// Stateful keys (v3): whether this acceptor's memory of the key is KNOWN
	// (AS1), the ballot it last accepted as a voter and the hash of that
	// state, and the hash of the latest commit's state. Hashes only; the state
	// bytes are never exposed in views.
	Stateful        bool
	StateKnown      bool
	AcceptedBallot  Ballot
	StateHash       [32]byte
	CommitStateHash [32]byte
}
