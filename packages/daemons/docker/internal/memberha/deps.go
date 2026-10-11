package memberha

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
)

// The lease protocol node (availabilitylease v3) as the member runtime uses it.
type (
	Key               = availabilitylease.Key
	Ballot            = availabilitylease.Ballot
	HolderStatus      = availabilitylease.HolderStatus
	ManifestInfo      = availabilitylease.ManifestInfo
	Role              = availabilitylease.Role
	FenceReason       = availabilitylease.FenceReason
	HolderState       = availabilitylease.HolderState
	StateHandler      = availabilitylease.StateHandler
	EligibilityInput  = availabilitylease.EligibilityInput
	Transition        = availabilitylease.Transition
	TransitionOutcome = availabilitylease.TransitionOutcome
	CertifiedState    = availabilitylease.CertifiedState
	PendingTransition = availabilitylease.PendingTransition
	EligibilityPhase  = availabilitylease.EligibilityPhase
)

// Roles and outcomes re-exported for readability.
const (
	RoleNone          = availabilitylease.RoleNone
	RoleCandidate     = availabilitylease.RoleCandidate
	RoleAcquiring     = availabilitylease.RoleAcquiring
	RoleBootstrapping = availabilitylease.RoleBootstrapping
	RoleRecovering    = availabilitylease.RoleRecovering
	RoleHolding       = availabilitylease.RoleHolding
	RoleFencing       = availabilitylease.RoleFencing
	RoleAbandoned     = availabilitylease.RoleAbandoned
	RoleReleasing     = availabilitylease.RoleReleasing
	RoleRetained      = availabilitylease.RoleRetained

	TransitionQueued    = availabilitylease.TransitionQueued
	TransitionSent      = availabilitylease.TransitionSent
	TransitionCertified = availabilitylease.TransitionCertified
)

// Lease is the protocol node as the member runtime uses it (a subset of
// *availabilitylease.Node, so the runtime runs against fakes in tests).
type Lease interface {
	HolderStatus(key Key) HolderStatus
	ManifestInfo(policyID string) (ManifestInfo, bool)
	BootstrapPending(key Key) bool
	SetCandidateReady(policyID string, ready bool)
	SetStateHandler(policyID string, handler *StateHandler)
	ProposeTransition(key Key, transition Transition) error
	TransitionStatus(key Key, id string) (TransitionOutcome, string)
	CommittedState(key Key) (CertifiedState, bool)
	ObservedCommit(key Key) (CertifiedState, bool)
	Recover(key Key, deadline time.Duration)
	Release(key Key, successor string) error
	FenceComplete(key Key)
	Abandon(key Key)
}

var _ Lease = (*availabilitylease.Node)(nil)

// Clock is the lease clock (CLOCK_BOOTTIME, the watchdog's clock) and the wall
// clock for events and reports.
type Clock interface {
	Now() time.Duration
	Wall() time.Time
}

// Watchdog is the independent lease watchdog's directory (A12).
type Watchdog interface {
	// HeartbeatAge is the watchdog heartbeat age at now; false without one.
	HeartbeatAge(now time.Duration) (time.Duration, bool)
	Records() (map[string]leasefence.Record, error)
	WriteRecord(record leasefence.Record) error
	DeleteRecord(containerID string) error
}

// Endpoints is told when a member starts or stops serving; the daemon then
// re-registers the member's relay endpoints SERVING or DORMANT (reading
// MemberServing). Calls with serving=false return only once every tunnel the
// member accepted has ended.
type Endpoints interface {
	SetServing(setID, memberID string, serving bool)
}

// Gates are the relay lease gate views of this node (the member proxy admits
// only while a fresh view names this node the holder).
type Gates interface {
	OpenFor(policyID, candidateID string, now time.Time) bool
}

// PeerState is what a manual pair's peer says over the member-control port.
type PeerState struct {
	MemberID   string `json:"memberId"`
	Generation uint64 `json:"generation"`
	Primary    string `json:"primary"`
	// Assignment is the peer's signed primary assignment; only a verified
	// one counts (a newer generation makes this member step down and adopt
	// it).
	Assignment *Assignment `json:"assignment,omitempty"`
	// Engine is what the engine tells its peers (PeerStater), e.g. that its
	// ClickHouse Keeper waits to be added.
	Engine map[string]string `json:"engine,omitempty"`
}

// Deps are the runtime's collaborators.
type Deps struct {
	Lease     Lease
	Watchdog  Watchdog
	Endpoints Endpoints
	Gates     Gates
	Clock     Clock
	Logger    *slog.Logger
	// Engine opens the engine of one member (by its configuration's engine).
	Engine func(config Config) (Engine, error)
	// Async runs background operations; default: a goroutine.
	Async func(func())
	// GatewayConnected reports whether the Gateway control session is up
	// (manual mode self-fence when GatewayContactAt is nil).
	GatewayConnected func() bool
	// GatewayContactAt is when Gateway last reached this node (a command
	// arrived), on Clock; 0 when never. A manual primary counts its contact
	// from it (not from a session that may be dead without knowing it yet).
	GatewayContactAt func() time.Duration
	// PeerState asks a manual pair's peer for its primary assignment over the
	// member mesh; false when the peer does not answer.
	PeerState func(ctx context.Context, setID, peerMemberID string) (PeerState, bool)
	// VerifyAssignment checks Gateway's signature of a manual pair's primary
	// assignment (AssignmentStatement under AssignmentDomain, a trusted relay
	// policy key). Nil refuses every assignment.
	VerifyAssignment func(setID string, assignment Assignment) error
	// Forgotten runs after the runtime forgot a set's member (lift, removal,
	// set deleted): the node releases what it kept for the set (its member
	// mesh listeners and network).
	Forgotten func(setID string)
}

func (d *Deps) defaults() error {
	if d.Lease == nil || d.Watchdog == nil || d.Endpoints == nil || d.Clock == nil || d.Engine == nil {
		return errors.New("the availability member runtime needs lease, watchdog, endpoints, clock and engine")
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Async == nil {
		d.Async = func(fn func()) { go fn() }
	}
	if d.GatewayConnected == nil {
		d.GatewayConnected = func() bool { return false }
	}
	if d.VerifyAssignment == nil {
		d.VerifyAssignment = func(string, Assignment) error {
			return errors.New("primary assignments cannot be verified on this node")
		}
	}
	if d.PeerState == nil {
		d.PeerState = func(context.Context, string, string) (PeerState, bool) { return PeerState{}, false }
	}
	return nil
}
