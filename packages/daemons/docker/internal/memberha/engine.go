package memberha

import (
	"context"
	"net"
	"time"
)

// ContainerState is the Docker view of a member's engine container.
type ContainerState struct {
	Exists     bool
	Running    bool
	ID         string
	CgroupPath string
	StartedAt  time.Time
	// Absent: the member's resource is not on this node (no record of it):
	// Opfield configures a new member before its create command made it (a
	// create on several servers, make available), and a deleted one is
	// forgotten right after. Such a member is neither started nor seeded,
	// and nothing failed.
	Absent bool
}

// EngineStatus is one sample of a member's engine.
type EngineStatus struct {
	// Answering is false when the engine did not answer the sample.
	Answering bool
	// Writable: the engine runs as the primary (it accepts writes).
	Writable bool
	// Streaming: a copy that follows the primary now.
	Streaming bool
	// NeedsRejoin: the copy diverged from the primary (or lost the history it
	// needs) and must rejoin (rewind, resync, rebuild) before it streams.
	NeedsRejoin bool
	// DiskFull: the engine reported a full disk recently (never a release
	// reason: it would repeat on the successor; it alerts).
	DiskFull bool
	// Replication progress for reports; LagBytes/LagSeconds are the copy's
	// distance from the primary, SyncState "sync", "async" or "none".
	LagBytes   uint64
	LagSeconds float64
	SyncState  string
	// Position is the engine's replication position for reports (lsn and
	// timeline, offset and replid, zxid, volume ids).
	Position map[string]string
	// DiskFreeBytes of the member's data volume, 0 when unknown.
	DiskFreeBytes uint64
	Detail        string
}

// Engine is one member's engine (Postgres, Valkey, SeaweedFS, ClickHouse).
// Every method that touches the container or the engine runs in a background
// operation of the runtime (never on the lease loop) and must honour ctx.
type Engine interface {
	// Container samples the engine container.
	Container(ctx context.Context) (ContainerState, error)
	// Status samples the engine; only called while the container runs.
	Status(ctx context.Context) (EngineStatus, error)
	// PrepareStandby writes the standby-at-rest configuration, durably, so
	// the next start comes up read-only as a copy of the primary (reached as
	// "primary-<port>" on the set's private bridge). Called before every
	// start, and after every promotion for the next start.
	PrepareStandby(ctx context.Context) error
	// Start starts the container (after PrepareStandby).
	Start(ctx context.Context) error
	// StopClean stops the container cleanly within timeout.
	StopClean(ctx context.Context, timeout time.Duration) error
	// Kill stops the container immediately.
	Kill(ctx context.Context) error
	// CgroupEmpty reports whether no process of the container remains.
	CgroupEmpty(ctx context.Context) (bool, error)
	// Promote makes the running copy writable. It runs only on the holder (or
	// a manual pair's assigned primary), with the deadline record armed.
	Promote(ctx context.Context, certified []byte) error
	// Rejoin makes a stopped or diverged member a copy of the current primary
	// again (rewind, resync, rebuild); the container is stopped when it
	// returns and starts through PrepareStandby and Start.
	Rejoin(ctx context.Context) error
	// Switchover prepares a planned handoff to successorMemberID: writes stop
	// and the successor caught up. The holder releases right after it.
	Switchover(ctx context.Context, successorMemberID string) error

	// Eligible is the lease eligibility callback: may this member take the
	// primary role over under the certified state of the input. It runs on
	// the lease loop and must not block (it reads the last status).
	Eligible(input EligibilityInput, status EngineStatus) (bool, string)
	// BootstrapValue is the first certified value, from the named bootstrap
	// holder (the member that serves when the set's lease starts).
	BootstrapValue(status EngineStatus) ([]byte, error)
	// PromotedValue is the value that certifies this member's promotion
	// (computed from the certified value and the promoted engine).
	PromotedValue(certified []byte, status EngineStatus) ([]byte, error)
	// NextValue is a steady-state change the holder certifies (floors,
	// degraded state), or ok=false when the certified value is current.
	NextValue(certified []byte, status EngineStatus, now time.Duration) (value []byte, kind string, ok bool, err error)
	// ReleaseTarget names the member a holder whose engine failed should hand
	// the primary role to (an eligible copy), or ok=false when none is.
	ReleaseTarget(certified []byte) (memberID string, ok bool)
	// DialPeer connects to this member's engine port (an incoming peer tunnel:
	// "pg-repl", "sw-volume", "ch-keeper", ...) on the set's private bridge.
	DialPeer(ctx context.Context, port string) (net.Conn, error)
}

// MemberControlPort is the peer port the member runtime serves itself (a
// manual pair's peer asks it for the primary assignment), on every engine.
const MemberControlPort = "member-control"
