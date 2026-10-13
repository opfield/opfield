// Package lease runs the Docker Availability data-plane lease on a docker
// daemon: the availabilitylease node (acceptor when the daemon votes,
// proposer when it is a candidate), the container side of the lease (start
// only while holding, self-fence, two-phase handoff), the watchdog deadline
// records, health release and the backend gate.
//
// The runtime talks to Docker, the watchdog directory, relay endpoint
// registrations and the Gateway only through the small interfaces below, so
// the whole loop runs against fakes in tests.
package lease

import (
	"context"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Container is the lease-relevant view of one Docker container.
type Container struct {
	ID           string
	Name         string
	PolicyID     string
	PlacementID  string
	Labels       map[string]string
	Running      bool
	Paused       bool
	Restarting   bool
	Status       string
	ExitCode     int
	Health       string // "", "starting", "healthy", "unhealthy"
	RestartCount int
	// RestartPolicy is Docker's restart policy name; lease-mode containers
	// are forced to "no" (A2.1).
	RestartPolicy string
	// StopTimeout is the container's own stop timeout; 0 means the default.
	StopTimeout time.Duration
	// CgroupPath is the actual cgroup when running, else the predicted one.
	CgroupPath string
	// StartedAt is when Docker last started the container; zero if never.
	StartedAt time.Time
}

// Engine is the Docker surface the runtime needs. Every call may block while
// dockerd hangs; the runtime only calls it from background operations.
type Engine interface {
	// ListLeaseContainers returns every container that carries the
	// availability policy label, running or not.
	ListLeaseContainers(ctx context.Context) ([]Container, error)
	// Inspect returns found=false when the container no longer exists.
	Inspect(ctx context.Context, id string) (Container, bool, error)
	Start(ctx context.Context, id string) error
	// Stop sends the stop signal, waits up to grace, then kills.
	Stop(ctx context.Context, id string, grace time.Duration) error
	Kill(ctx context.Context, id string) error
	// DisableRestart sets RestartPolicy "no" without touching anything else.
	DisableRestart(ctx context.Context, id string) error
	// CgroupEmpty reports whether no process of the container remains.
	CgroupEmpty(ctx context.Context, c Container) (bool, error)
}

// Fence is the watchdog directory (records and heartbeat, A12).
type Fence interface {
	// HeartbeatAge is the age of the watchdog heartbeat at now; false when
	// there is none (never written, unreadable or invalid).
	HeartbeatAge(now time.Duration) (time.Duration, bool)
	Records() (map[string]leasefence.Record, error)
	WriteRecord(record leasefence.Record) error
	DeleteRecord(containerID string) error
	// DaemonAlive tells the watchdog a lease-aware daemon runs, so it keeps
	// the records (leasefence.DaemonGoneAfter).
	DaemonAlive(now time.Duration) error
}

// Endpoints controls the relay Secure Link endpoint registrations of a
// policy's placement on this node (D8, A6, A8).
type Endpoints interface {
	// SetServing registers (true) or deregisters (false) the endpoints.
	// Deregistration returns only once every registration stream of the
	// policy has ended, so a release that follows is ordered after it.
	SetServing(policyID string, serving bool)
}

// IdentityRotation hands certificate renewals to the protocol node (H3).
// After a renewal the node dual-signs every frame and accept with the new and
// the previous key (Node.RotateIdentityKey) until every adopted manifest that
// names it lists the new key, or availabilitylease.IdentityKeyOverlap passed.
type IdentityRotation interface {
	// PendingRotation returns a renewed key the node does not sign with yet.
	PendingRotation() (next availabilitylease.Signer, publicKeyDER []byte, ok bool)
	// RotationApplied records that the node now signs with publicKeyDER and
	// keeps the replaced key for the overlap (persisted across restarts).
	RotationApplied(publicKeyDER []byte)
	// OverlapEnded tells the source the node retired the previous key.
	OverlapEnded()
}

// Placement is this node's placement of a policy (D12 mapping).
type Placement struct {
	PlacementID string
	Generation  uint64
}

// Placements maps a policy to this node's placement and its serving set.
type Placements interface {
	Local(policyID string) (Placement, bool)
	// ServeSet selects, from every container labeled with the policy, the
	// ones that run while the lease is held. The others stay stopped.
	ServeSet(policyID string, containers []Container) []Container
	// MarkServing records the placement lifecycle for the backend (T6 §3.1):
	// active once the lease holder started it, stopped after a confirmed
	// stop. Called from background operations.
	MarkServing(policyID string, serving bool)
}

// PolicyKey is a Gateway policy signing key delivered over the
// authenticated CommandStream (A4).
type PolicyKey struct {
	ID        string
	PublicKey []byte
}

// BlockUpdate is one lease distribution from the Gateway: T3's
// SyncAvailabilityLeaseCommand after decoding its opaque relay.v1 blocks.
// Each manifest carries its policy's voters and voter epoch (A18); there is
// no cluster-wide voter config any more.
type BlockUpdate struct {
	Revision     uint64
	MemberID     string
	PolicyKeys   []PolicyKey
	KeyRotations []*relayv1.LeasePolicyKeyRotation
	Manifests    []*relayv1.LeaseSignedBlock
}

// ManifestSource receives signed lease blocks and the rotation chain.
type ManifestSource interface {
	ApplyLeaseBlocks(update BlockUpdate) error
}

// Handoff asks the current holder to release a key to a successor (D9).
type Handoff struct {
	PolicyID            string
	Slot                uint32
	SuccessorID         string
	OperationID         string
	SuccessorGeneration uint64
	ManifestVersion     uint64
}

// HandoffCommand accepts planned handoffs; the outcome arrives as a
// "handoff" (or "fence") event in the next report.
type HandoffCommand interface {
	Handoff(request Handoff) error
}

// LeaseReporter produces the lease part of the health report.
type LeaseReporter interface {
	Report() Report
}

var (
	_ ManifestSource = (*Runtime)(nil)
	_ HandoffCommand = (*Runtime)(nil)
	_ LeaseReporter  = (*Runtime)(nil)
)
