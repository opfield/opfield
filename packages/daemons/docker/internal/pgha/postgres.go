package pgha

import (
	"context"
	"net"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// ContainerState is the Docker view of the member's Postgres container.
type ContainerState = memberha.ContainerState

// ServerStatus is one SQL sample of the member's Postgres.
type ServerStatus struct {
	// Answering is false when the server did not answer the sample.
	Answering  bool
	InRecovery bool
	// Timeline is the insert timeline on a primary and the timeline the
	// standby receives or last checkpointed on.
	Timeline uint32
	// FlushLSN is pg_current_wal_flush_lsn() on a primary.
	FlushLSN LSN
	// ReceiveLSN and ReplayLSN are the standby positions.
	ReceiveLSN LSN
	ReplayLSN  LSN
	// ReceiverStatus is pg_stat_wal_receiver.status ("" without a receiver).
	ReceiverStatus   string
	ReceiverTimeline uint32
	// LatestEndLSN is the last WAL end the primary reported to the receiver:
	// the standby's freshest evidence of the primary's position (AS7).
	LatestEndLSN LSN
	// ServerVersion is server_version_num.
	ServerVersion int
	// SystemID is the cluster's system identifier (pg_control_system): a
	// copy of the primary has the primary's; a cluster created on its own
	// (initdb) has another and can never stream from it.
	SystemID string
}

// Position is the standby's durable WAL position: what it would have after
// promotion.
func (s ServerStatus) Position() LSN { return maxLSN(s.ReceiveLSN, s.ReplayLSN) }

// ReplicationPeer is one row of pg_stat_replication on the primary.
type ReplicationPeer struct {
	ApplicationName string
	UseName         string
	State           string
	SyncState       string
	SentLSN         LSN
	WriteLSN        LSN
	FlushLSN        LSN
	ReplayLSN       LSN
	// ReplyAge is how long ago the standby last replied; negative when
	// unknown. A walsender whose standby vanished keeps its row until
	// wal_sender_timeout, so a stale reply is not streaming.
	ReplyAge time.Duration
}

// SyncWaiters are the backends waiting in SyncRepWaitForLSN.
type SyncWaiters struct {
	Count     int
	OldestAge time.Duration
	PIDs      []int
	// Keys identify each wait (backend and statement start), stable while
	// it waits.
	Keys []string
}

// TimelineEntry is one line of a timeline history file: timeline ended at
// SwitchLSN, where its child begins.
type TimelineEntry struct {
	Timeline  uint32
	SwitchLSN LSN
}

// StandbyConfig is what the member writes before every start (standby at
// rest, M6): standby.signal and the conninfo to the local replication
// listener with application_name = member id and its own role.
type StandbyConfig struct {
	MemberID        string
	ReplicationRole string
	SlotName        string
	// Parameters are the member-equal settings written into
	// postgresql.auto.conf before the start (M4).
	Parameters Parameters
}

// RewindResult describes a pg_rewind run (M9).
type RewindResult struct {
	// NotNeeded: the target had not diverged ("no rewind required").
	NotNeeded bool
	// DivergedAt and TargetEnd bound the discarded WAL range.
	DivergedAt LSN
	TargetEnd  LSN
	Timeline   uint32
	// KeptAt is where the diverged WAL segments were copied, "" when they
	// did not fit on disk.
	KeptAt string
	// NeedsRebuild: the rewind is impossible (WAL gone, history mismatch).
	NeedsRebuild bool
	Detail       string
	// Started: the real (not dry) pg_rewind began, so the data directory
	// may be partly rewritten; set with an error too. Such a directory is
	// never started, only rebuilt (H3).
	Started bool
}

// RebuildResult describes a pg_basebackup rebuild or seed.
type RebuildResult struct {
	// PreviousKept is true when the old data directory was kept until the
	// new one started; false when disk space forced discarding it first.
	PreviousKept bool
	// DivergedWALKeptAt is where the old directory's WAL tail was copied
	// when the directory itself could not be kept.
	DivergedWALKeptAt string
	Detail            string
}

// Postgres is the member's Postgres and its container. Implementations run
// fixed commands through docker exec and helper containers; every call may
// block, so the runtime only calls it from background operations.
type Postgres interface {
	Container(ctx context.Context) (ContainerState, error)
	// PrepareStandby writes standby.signal, the conninfo and the daemon's
	// settings into the stopped data directory and fsyncs the files and the
	// directory. Refused while the container runs.
	PrepareStandby(ctx context.Context, config StandbyConfig) error
	// MarkStandbyAtRest rewrites standby.signal (fsync file and directory)
	// while the server runs, right after a promotion.
	MarkStandbyAtRest(ctx context.Context) error
	// ClearStandbySignal removes standby.signal: only the retained primary of
	// a closed database (AS9) after the relay revision dropped the lease.
	ClearStandbySignal(ctx context.Context) error
	Start(ctx context.Context) error
	// StopClean stops Postgres with a fast shutdown within timeout.
	StopClean(ctx context.Context, timeout time.Duration) error
	Kill(ctx context.Context) error
	CgroupEmpty(ctx context.Context) (bool, error)

	Status(ctx context.Context) (ServerStatus, error)
	Replication(ctx context.Context) ([]ReplicationPeer, error)
	Waiters(ctx context.Context) (SyncWaiters, error)
	// SetSyncNames runs ALTER SYSTEM SET synchronous_standby_names and a
	// reload.
	SetSyncNames(ctx context.Context, names string) error
	Checkpoint(ctx context.Context) error
	CurrentFlushLSN(ctx context.Context) (LSN, error)
	Promote(ctx context.Context) error
	// TimelineHistory reads the member's history of a timeline (empty for 1).
	TimelineHistory(ctx context.Context, timeline uint32) ([]TimelineEntry, error)
	// SyncSlots makes the member's physical slots exactly keep (drop the
	// others), creating missing ones; on a standby it also advances them to
	// the replay position (M9).
	SyncSlots(ctx context.Context, keep []string) error
	EnsureIdentities(ctx context.Context, identities Identities) error
	// TerminateClients ends every client backend (not replication).
	TerminateClients(ctx context.Context) error
	// LogSince returns server log lines written after since.
	LogSince(ctx context.Context, since time.Time) ([]LogLine, error)

	// Rewind runs pg_rewind against the current primary through the
	// replication listener; it copies the diverged WAL range aside first
	// when the disk allows (M9) and rewrites the daemon's settings after.
	Rewind(ctx context.Context, config StandbyConfig) (RewindResult, error)
	// Rebuild seeds a fresh data directory with pg_basebackup through the
	// replication listener, keeping the old one until the new one works when
	// the disk allows, then writes the standby configuration.
	Rebuild(ctx context.Context, config StandbyConfig) (RebuildResult, error)
	// CommitRebuild drops the previous data directory kept by Rebuild.
	CommitRebuild(ctx context.Context) error
	// ShutdownState reads pg_controldata's cluster state of the stopped data
	// directory ("shut down", "shut down in recovery", "in production", ...).
	ShutdownState(ctx context.Context) (string, error)

	// DataInitialized reports whether the data directory holds a cluster
	// (PG_VERSION); it must not block (a file check).
	DataInitialized() bool
	// DiskFree is the free space of the member's data volume.
	DiskFree() uint64
	// DialServer connects to the member's Postgres on its private bridge (an
	// incoming pg-repl peer tunnel, the member proxy).
	DialServer(ctx context.Context) (net.Conn, error)
}

// LogLine is one line of the server log.
type LogLine struct {
	At   time.Time
	Text string
}
