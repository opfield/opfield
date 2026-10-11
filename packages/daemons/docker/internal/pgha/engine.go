package pgha

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// ReplicationPort is the member mesh port name of Postgres replication; the
// primary's is reached as "primary-pg-repl".
const ReplicationPort = "pg-repl"

const (
	// rejoinAfter: a copy that has not streamed this long with a divergence
	// in its log rejoins (rewind or rebuild) once a primary is known.
	rejoinAfter = 5 * time.Second
	// slotsInterval: replication slot upkeep on the primary and copies.
	slotsInterval = 30 * time.Second
	// successorEvidenceAge bounds how old the replication sample may be that
	// names an eligible successor for a health release.
	successorEvidenceAge = 15 * time.Second
	// diskFullWindow: a full disk seen this recently blocks a health release.
	diskFullWindow = 10 * time.Minute
	// staleReplyAge: a standby that has not replied for longer is not treated
	// as streaming (its connection may be dead but not yet timed out).
	staleReplyAge = 10 * time.Second
)

// Clock is the lease clock and the wall clock.
type Clock interface {
	Now() time.Duration
	Wall() time.Time
}

// Engine is the Postgres engine of one member.
type Engine struct {
	pg     Postgres
	store  *Store
	clock  Clock
	logger *slog.Logger

	mu        sync.Mutex
	cfg       Config
	state     State
	obs       sample
	logCursor time.Time
	sync      syncRuntime
	standby   standbyRuntime
	holder    holderRuntime
	events    []memberha.Event
}

type sample struct {
	at        time.Duration
	status    ServerStatus
	peers     []ReplicationPeer
	peersOK   bool
	waiters   SyncWaiters
	waitersOK bool
	history   []TimelineEntry
	historyOK bool
	diskFree  uint64
}

type standbyRuntime struct {
	notStreamingSince time.Duration
	divergence        string
	divergenceDetail  string
	// progress is the highest primary position the walreceiver saw (AS7,
	// in memory only).
	progress       LSN
	diskFullAt     time.Duration
	diskFullDetail string
	slotsAt        time.Duration
}

type holderRuntime struct {
	lastPeers      []ReplicationPeer
	lastPeersAt    time.Duration
	cancelledWaits int
	waiters        map[string]waitSeen
	lastPFAt       time.Duration
	degraded       *bool
	slotsAt        time.Duration
	// identities is the hash of the principals this primary converged.
	identities string
}

const (
	divergenceRewind  = "diverged"
	divergenceWALGone = "wal_removed"
	// divergenceOtherCluster: the copy's cluster is not a copy of the
	// primary's (another system identifier); only a rebuild makes it one.
	divergenceOtherCluster = "other_cluster"
)

var (
	_ memberha.Engine             = (*Engine)(nil)
	_ memberha.HolderWorker       = (*Engine)(nil)
	_ memberha.CopyWorker         = (*Engine)(nil)
	_ memberha.CertifiedChecker   = (*Engine)(nil)
	_ memberha.PendingPromoter    = (*Engine)(nil)
	_ memberha.EventSource        = (*Engine)(nil)
	_ memberha.RejoinPlanner      = (*Engine)(nil)
	_ memberha.SwitchoverPreparer = (*Engine)(nil)
	_ memberha.ForcedValuer       = (*Engine)(nil)
	_ memberha.Reconfigurer       = (*Engine)(nil)
)

// New opens the engine of a member.
func New(config memberha.Config, pg Postgres, store *Store, clock Clock, logger *slog.Logger) (*Engine, error) {
	cfg, err := ParseConfig(config)
	if err != nil {
		return nil, err
	}
	state, err := store.Load(config.SetID)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Engine{pg: pg, store: store, clock: clock, logger: logger, cfg: cfg, state: state}, nil
}

// Reconfigure takes Gateway's newer configuration; settings apply at the
// next start (Gateway orders restarts), durability through the sync manager.
func (e *Engine) Reconfigure(config memberha.Config) error {
	cfg, err := ParseConfig(config)
	if err != nil {
		return err
	}
	e.mu.Lock()
	e.cfg = cfg
	e.mu.Unlock()
	return nil
}

// Config is the engine's current configuration.
func (e *Engine) Config() Config {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.cfg
}

// State is the engine's persisted state.
func (e *Engine) State() State {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state
}

// Postgres is the member's Postgres.
func (e *Engine) Postgres() Postgres { return e.pg }

func (e *Engine) saveLocked() error {
	if err := e.store.Save(e.cfg.SetID, e.state); err != nil {
		e.logger.Error("could not persist the Postgres member state", "set_id", e.cfg.SetID, "error", err)
		return err
	}
	return nil
}

func (e *Engine) eventLocked(event memberha.Event) {
	if event.AtUnixMs == 0 {
		event.AtUnixMs = e.clock.Wall().UnixMilli()
	}
	e.events = append(e.events, event)
}

// DrainEvents hands the engine's events to the runtime's durable queue.
func (e *Engine) DrainEvents() []memberha.Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := e.events
	e.events = nil
	return out
}

// ----- container ------------------------------------------------------------

func (e *Engine) Container(ctx context.Context) (memberha.ContainerState, error) {
	return e.pg.Container(ctx)
}

func (e *Engine) StopClean(ctx context.Context, timeout time.Duration) error {
	return e.pg.StopClean(ctx, timeout)
}

func (e *Engine) Kill(ctx context.Context) error { return e.pg.Kill(ctx) }

func (e *Engine) CgroupEmpty(ctx context.Context) (bool, error) { return e.pg.CgroupEmpty(ctx) }

// PrepareStandby writes standby at rest: into the stopped data directory
// (standby.signal and the daemon's settings, fsynced), or only
// standby.signal while the server runs (right after a promotion). A data
// directory that is missing or must be rebuilt is refused: it is never
// started (the runtime rejoins it first).
func (e *Engine) PrepareStandby(ctx context.Context) error {
	container, err := e.pg.Container(ctx)
	if err != nil {
		return err
	}
	if container.Running {
		return e.pg.MarkStandbyAtRest(ctx)
	}
	e.mu.Lock()
	needsRebuild, config := e.state.NeedsRebuild, e.cfg.StandbyConfig()
	e.mu.Unlock()
	if needsRebuild {
		return errors.New("the data directory must be rebuilt before it starts (a rewind failed part-way)")
	}
	if !e.pg.DataInitialized() {
		return errors.New("the data directory is not seeded yet")
	}
	return e.pg.PrepareStandby(ctx, config)
}

// Start starts the container; Postgres always starts with empty synchronous
// names (the holder path sets them before any promotion).
func (e *Engine) Start(ctx context.Context) error {
	if err := e.pg.Start(ctx); err != nil {
		return err
	}
	e.mu.Lock()
	e.sync.names, e.sync.namesKnown = nil, false
	e.holder.identities = ""
	e.mu.Unlock()
	return nil
}

// DialPeer connects an incoming peer tunnel: pg-repl reaches Postgres.
func (e *Engine) DialPeer(ctx context.Context, port string) (net.Conn, error) {
	if port != ReplicationPort {
		return nil, fmt.Errorf("Postgres members take no %q peer traffic", port)
	}
	return e.pg.DialServer(ctx)
}

// ----- observation ------------------------------------------------------------

// Server log markers (Postgres syncrep.c, walreceiver.c, xlog.c).
var (
	cancelledWaitMarkers = []string{
		"canceling wait for synchronous replication",
		"canceling the wait for synchronous replication",
	}
	divergenceMarkers = []string{
		"forked off current database system timeline",
		"is not a child of this server's history",
		"is ahead of the WAL flush position of this server",
		"is not in this server's history",
	}
	walRemovedMarker = "has already been removed"
	// walreceiver.c: the primary belongs to another database cluster.
	otherClusterMarker = "database system identifier differs"
	diskFullMarker     = "No space left on device"
)

type logMarkers struct {
	cancelledWaits int
	diverged       bool
	walRemoved     bool
	otherCluster   bool
	diskFull       bool
	detail         string
}

func (l *logMarkers) scan(text string) {
	if strings.Contains(text, diskFullMarker) {
		l.diskFull, l.detail = true, trimLog(text)
		return
	}
	for _, marker := range cancelledWaitMarkers {
		if strings.Contains(text, marker) {
			l.cancelledWaits++
			return
		}
	}
	if strings.Contains(text, otherClusterMarker) {
		l.otherCluster, l.detail = true, trimLog(text)
		return
	}
	for _, marker := range divergenceMarkers {
		if strings.Contains(text, marker) {
			l.diverged, l.detail = true, trimLog(text)
			return
		}
	}
	if strings.Contains(text, walRemovedMarker) && strings.Contains(text, "WAL segment") {
		l.walRemoved, l.detail = true, trimLog(text)
	}
}

func trimLog(text string) string {
	if len(text) > 300 {
		return text[:300]
	}
	return text
}

// Status samples Postgres: the server, on a primary its walsenders and
// SyncRep waiters, the timeline history and the server log since the last
// sample.
func (e *Engine) Status(ctx context.Context) (memberha.EngineStatus, error) {
	status, err := e.pg.Status(ctx)
	if err != nil {
		return memberha.EngineStatus{}, err
	}
	s := sample{status: status}
	if status.Answering {
		if !status.InRecovery {
			peers, peersErr := e.pg.Replication(ctx)
			s.peers, s.peersOK = peers, peersErr == nil
			waiters, waitersErr := e.pg.Waiters(ctx)
			s.waiters, s.waitersOK = waiters, waitersErr == nil
		}
		history, historyErr := e.pg.TimelineHistory(ctx, status.Timeline)
		s.history, s.historyOK = history, historyErr == nil
	}
	e.mu.Lock()
	cursor := e.logCursor
	e.mu.Unlock()
	var markers logMarkers
	var lastLog time.Time
	if lines, logErr := e.pg.LogSince(ctx, cursor); logErr == nil {
		for _, line := range lines {
			if line.At.After(lastLog) {
				lastLog = line.At
			}
			markers.scan(line.Text)
		}
	}
	s.diskFree = e.pg.DiskFree()
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.clock.Now()
	s.at = now
	if !lastLog.IsZero() {
		e.logCursor = lastLog
	}
	e.absorbLocked(s, markers, now)
	return e.engineStatusLocked(now), nil
}

// absorbLocked keeps the latest sample and folds log markers, the
// walreceiver's progress and the walsenders into the engine's state.
func (e *Engine) absorbLocked(s sample, markers logMarkers, now time.Duration) {
	e.obs = s
	st := s.status
	if markers.cancelledWaits > 0 {
		e.holder.cancelledWaits += markers.cancelledWaits
	}
	if markers.diverged {
		e.standby.divergence, e.standby.divergenceDetail = divergenceRewind, markers.detail
	}
	if markers.walRemoved {
		e.standby.divergence, e.standby.divergenceDetail = divergenceWALGone, markers.detail
	}
	if markers.otherCluster {
		e.standby.divergence, e.standby.divergenceDetail = divergenceOtherCluster, markers.detail
	}
	if markers.diskFull {
		e.standby.diskFullAt, e.standby.diskFullDetail = now, markers.detail
	}
	if !st.Answering {
		return
	}
	if st.InRecovery {
		if st.LatestEndLSN > e.standby.progress {
			e.standby.progress = st.LatestEndLSN
		}
		// A diverged copy's walreceiver restarts in a loop and streams the
		// shared part of the old timeline for a moment each time before the
		// fork is found again: a "streaming" sample whose log still reports
		// the divergence does not reset the rejoin clock.
		if st.ReceiverStatus == "streaming" && !markers.diverged && !markers.walRemoved && !markers.otherCluster {
			e.standby.notStreamingSince = 0
			e.standby.divergence, e.standby.divergenceDetail = "", ""
		} else if e.standby.notStreamingSince == 0 {
			e.standby.notStreamingSince = now
		}
		return
	}
	e.standby.notStreamingSince = 0
	e.standby.divergence, e.standby.divergenceDetail = "", ""
	if s.peersOK {
		e.holder.lastPeers, e.holder.lastPeersAt = s.peers, now
		if s.waitersOK {
			e.holder.cancelledWaits += e.trackWaitersLocked(s)
		}
	}
}

func (e *Engine) diskFullLocked(now time.Duration) bool {
	return e.standby.diskFullAt != 0 && now-e.standby.diskFullAt < diskFullWindow
}

// engineStatusLocked maps the last sample for the runtime.
func (e *Engine) engineStatusLocked(now time.Duration) memberha.EngineStatus {
	st := e.obs.status
	out := memberha.EngineStatus{
		Answering: st.Answering, Writable: st.Answering && !st.InRecovery,
		Streaming: st.Answering && st.InRecovery && st.ReceiverStatus == "streaming",
		DiskFull:  e.diskFullLocked(now), DiskFreeBytes: e.obs.diskFree, SyncState: "none",
	}
	if !st.Answering {
		return out
	}
	out.Position = map[string]string{"timeline": strconv.FormatUint(uint64(st.Timeline), 10)}
	if st.SystemID != "" {
		// Gateway compares the members' clusters (a planned switchover never
		// promotes another cluster).
		out.Position["systemId"] = st.SystemID
	}
	if st.InRecovery {
		position := st.Position()
		out.Position["lsn"] = position.String()
		out.Position["replayLsn"] = st.ReplayLSN.String()
		if e.standby.progress > position {
			out.LagBytes = uint64(e.standby.progress - position)
		}
		if out.Streaming {
			out.SyncState = "async"
		}
		out.NeedsRejoin = e.state.NeedsRebuild || (e.standby.divergence != "" && e.standby.notStreamingSince != 0 &&
			now-e.standby.notStreamingSince >= rejoinAfter)
		out.Detail = e.standby.divergenceDetail
	} else {
		out.Position["lsn"] = st.FlushLSN.String()
		if e.obs.peersOK {
			// The copies the primary's walsenders confirm synchronously: a
			// standby cannot see its own sync_state (manual pairs certify
			// nothing, so Gateway reads it here).
			var syncCopies []string
			for _, peer := range e.cfg.ActiveOthers() {
				if row, found := findPeer(e.obs.peers, peer); found && (row.SyncState == "sync" || row.SyncState == "quorum") {
					syncCopies = append(syncCopies, peer.MemberID)
				}
			}
			out.Position["syncCopies"] = strings.Join(syncCopies, ",")
		}
	}
	if out.DiskFull {
		out.Detail = e.standby.diskFullDetail
	}
	return out
}

// waitSeen is a synchronous commit wait as first seen: the primary's flush
// then (at or above the waiting commit) and the names it waited under.
type waitSeen struct {
	lsn   LSN
	names string
}

// trackWaitersLocked finds waits that ended without the named members having
// flushed their commit: cancelled or terminated (AS4, next to the server
// log). A names change ends waits legitimately (the reduction was certified
// first) and is not counted.
func (e *Engine) trackWaitersLocked(s sample) int {
	h := &e.holder
	names := strings.Join(e.sync.names, ",")
	current := map[string]bool{}
	for _, key := range s.waiters.Keys {
		current[key] = true
	}
	cancelled := 0
	for key, seen := range h.waiters {
		if current[key] {
			continue
		}
		delete(h.waiters, key)
		if seen.names != names || names == "" {
			continue
		}
		for _, member := range e.sync.names {
			peer, ok := e.cfg.Peer(member)
			row, found := findPeer(s.peers, peer)
			if !ok || !found || row.FlushLSN < seen.lsn {
				cancelled++
				break
			}
		}
	}
	if h.waiters == nil {
		h.waiters = map[string]waitSeen{}
	}
	for key := range current {
		if _, ok := h.waiters[key]; !ok {
			h.waiters[key] = waitSeen{lsn: s.status.FlushLSN, names: names}
		}
	}
	return cancelled
}

// findPeer matches a pg_stat_replication row by application_name AND usename
// (M6).
func findPeer(rows []ReplicationPeer, peer Peer) (ReplicationPeer, bool) {
	for _, row := range rows {
		if row.ApplicationName == peer.MemberID && row.UseName == peer.ReplicationRole {
			return row, true
		}
	}
	return ReplicationPeer{}, false
}

func without(set []string, member string) []string {
	var out []string
	for _, item := range set {
		if item != member {
			out = append(out, item)
		}
	}
	return normalizeSet(out)
}

func firstReason(reasons ...string) string {
	for _, reason := range reasons {
		if reason != "" {
			return reason
		}
	}
	return ""
}
