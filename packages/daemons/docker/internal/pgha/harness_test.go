package pgha

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// The harness runs the generic member runtime (memberha.Manager) with the
// Postgres engine against fakes. Every fake appends to one ordered log, so
// tests assert the ordering rules across components.

type (
	Key               = availabilitylease.Key
	Ballot            = availabilitylease.Ballot
	Role              = availabilitylease.Role
	FenceReason       = availabilitylease.FenceReason
	HolderStatus      = availabilitylease.HolderStatus
	ManifestInfo      = availabilitylease.ManifestInfo
	CertifiedState    = availabilitylease.CertifiedState
	HolderState       = availabilitylease.HolderState
	PendingTransition = availabilitylease.PendingTransition
	Transition        = availabilitylease.Transition
	TransitionOutcome = availabilitylease.TransitionOutcome
	StateHandler      = availabilitylease.StateHandler
	ForceRequest      = availabilitylease.ForceRequest
	ForceStatus       = availabilitylease.ForceStatus
)

const (
	setID      = "11111111-1111-4111-8111-111111111111"
	selfMember = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	memberB    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	memberC    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	selfNode   = "node-a"
	nodeB      = "node-b"
	nodeC      = "node-c"
	policyID   = "22222222-2222-4222-8222-222222222222"
	databaseID = "33333333-3333-4333-8333-333333333333"
	containerA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	roleA      = "gw_repl_a"
	roleB      = "gw_repl_b"
	roleC      = "gw_repl_c"
)

type harness struct {
	t        *testing.T
	clock    *fakeClock
	lease    *fakeLease
	pg       *fakePG
	watchdog *fakeWatchdog
	ends     *fakeEndpoints
	gates    *fakeGates
	manager  *memberha.Manager
	store    *memberha.Store
	pgStore  *Store
	config   memberha.Config
	engine   *Engine

	mu    sync.Mutex
	log   []string
	queue []func()
	// autoCertify certifies queued transitions after every step.
	autoCertify bool
}

func testEngineConfig() EngineConfig {
	return EngineConfig{
		ReplicationRoles:    map[string]string{selfMember: roleA, memberB: roleB, memberC: roleC},
		RewindRole:          "gw_rewind_x",
		ReplicationPassword: "secret-a", RewindPassword: "rewind-secret",
	}
}

func testConfig(engine EngineConfig) memberha.Config {
	data, _ := json.Marshal(engine)
	return memberha.Config{
		SetID: setID, MemberID: selfMember, NodeID: selfNode, Engine: "postgres", OwnerKind: "managed_database",
		OwnerID: databaseID, Mode: memberha.ModeAutomatic, LeasePolicyID: policyID,
		Durability: DurabilitySynchronous, MaxLagBytes: 1 << 20, SyncDegradeAfterSeconds: 10,
		Members: []memberha.Peer{
			{MemberID: selfMember, NodeID: selfNode, MemberIndex: 0, Priority: 3},
			{MemberID: memberB, NodeID: nodeB, MemberIndex: 1, Priority: 2},
			{MemberID: memberC, NodeID: nodeC, MemberIndex: 2, Priority: 1},
		},
		ConfigRevision: 1, EngineConfig: data,
	}
}

func newHarness(t *testing.T, mutate ...func(*harness)) *harness {
	t.Helper()
	h := &harness{t: t, autoCertify: true}
	h.config = testConfig(testEngineConfig())
	h.clock = &fakeClock{now: time.Hour, wall: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)}
	h.lease = newFakeLease(h)
	h.pg = newFakePG(h)
	h.watchdog = &fakeWatchdog{h: h, records: map[string]leasefence.Record{}}
	h.ends = &fakeEndpoints{h: h}
	h.gates = &fakeGates{open: true}
	for _, fn := range mutate {
		fn(h)
	}
	store, err := memberha.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.store = store
	pgStore, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.pgStore = pgStore
	h.manager = h.newManager()
	if err := h.manager.Configure(h.config); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *harness) newManager() *memberha.Manager {
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: h.lease, Watchdog: h.watchdog, Endpoints: h.ends, Gates: h.gates, Clock: h.clock,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine: func(config memberha.Config) (memberha.Engine, error) {
			engine, err := New(config, h.pg, h.pgStore, h.clock, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err == nil {
				h.engine = engine
			}
			return engine, err
		},
		Async:            func(fn func()) { h.mu.Lock(); h.queue = append(h.queue, fn); h.mu.Unlock() },
		OpfieldConnected: func() bool { return true },
		VerifyAssignment: func(string, memberha.Assignment) error { return nil },
	}, h.store)
	if err != nil {
		h.t.Fatal(err)
	}
	return manager
}

func (h *harness) record(format string, args ...any) {
	h.mu.Lock()
	h.log = append(h.log, fmt.Sprintf(format, args...))
	h.mu.Unlock()
}

// drain runs queued background work until none is left.
func (h *harness) drain() {
	for i := 0; i < 1000; i++ {
		h.mu.Lock()
		queue := h.queue
		h.queue = nil
		h.mu.Unlock()
		if len(queue) == 0 {
			return
		}
		for _, fn := range queue {
			fn()
		}
	}
	h.t.Fatal("background work did not settle")
}

// tick advances the clock and runs one step with its background work.
func (h *harness) tick(d time.Duration) {
	h.clock.advance(d)
	h.manager.Step()
	h.drain()
	if h.autoCertify {
		h.lease.certifyPending()
	}
}

func (h *harness) run(n int, d time.Duration) {
	for i := 0; i < n; i++ {
		h.tick(d)
	}
}

// settle runs until the step produces no new log entries for a few rounds.
func (h *harness) settle() {
	quiet := 0
	for i := 0; i < 300 && quiet < 12; i++ {
		before := len(h.logSnapshot())
		h.tick(time.Second)
		if len(h.logSnapshot()) == before {
			quiet++
		} else {
			quiet = 0
		}
	}
}

func (h *harness) logSnapshot() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.log...)
}

func (h *harness) resetLog() {
	h.mu.Lock()
	h.log = nil
	h.mu.Unlock()
}

func (h *harness) index(prefix string, from int) int {
	log := h.logSnapshot()
	for i := from; i < len(log); i++ {
		if strings.HasPrefix(log[i], prefix) {
			return i
		}
	}
	return -1
}

// requireOrder fails unless the prefixes appear in this order.
func (h *harness) requireOrder(prefixes ...string) {
	h.t.Helper()
	at := 0
	for _, prefix := range prefixes {
		i := h.index(prefix, at)
		if i < 0 {
			h.t.Fatalf("log entry %q not found after position %d; log:\n%s", prefix, at, strings.Join(h.logSnapshot(), "\n"))
		}
		at = i + 1
	}
}

func (h *harness) requireNo(prefix string) {
	h.t.Helper()
	if i := h.index(prefix, 0); i >= 0 {
		h.t.Fatalf("unexpected log entry %q at %d; log:\n%s", prefix, i, strings.Join(h.logSnapshot(), "\n"))
	}
}

// events are the queued member events of a kind (runtime and engine).
func (h *harness) events(kind string) []memberha.Event {
	var out []memberha.Event
	for _, report := range h.manager.Reports() {
		for _, event := range report.Events {
			if event.Kind == kind {
				out = append(out, event)
			}
		}
	}
	return out
}

func (h *harness) proposals(kind string) int {
	count := 0
	for _, entry := range h.logSnapshot() {
		if strings.HasPrefix(entry, "lease:propose:"+kind+":") {
			count++
		}
	}
	return count
}

func (h *harness) serving() bool {
	serving, _ := h.manager.MemberServing(setID, selfMember)
	return serving
}

// reconfigure applies a changed configuration with the next revision.
func (h *harness) reconfigure(mutate func(*memberha.Config, *EngineConfig)) {
	h.t.Helper()
	engine := testEngineConfig()
	_ = json.Unmarshal(h.config.EngineConfig, &engine)
	mutate(&h.config, &engine)
	data, _ := json.Marshal(engine)
	h.config.EngineConfig = data
	h.config.ConfigRevision++
	if err := h.manager.Configure(h.config); err != nil {
		h.t.Fatal(err)
	}
}

// --- clock ---

type fakeClock struct {
	mu   sync.Mutex
	now  time.Duration
	wall time.Time
}

func (c *fakeClock) Now() time.Duration { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) Wall() time.Time    { c.mu.Lock(); defer c.mu.Unlock(); return c.wall }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	c.wall = c.wall.Add(d)
	c.mu.Unlock()
}

// --- watchdog, endpoints, gates ---

type fakeWatchdog struct {
	h       *harness
	mu      sync.Mutex
	gone    bool
	records map[string]leasefence.Record
}

func (w *fakeWatchdog) HeartbeatAge(time.Duration) (time.Duration, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.gone {
		return 0, false
	}
	return 200 * time.Millisecond, true
}

func (w *fakeWatchdog) Records() (map[string]leasefence.Record, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := map[string]leasefence.Record{}
	for id, record := range w.records {
		out[id] = record
	}
	return out, nil
}

func (w *fakeWatchdog) WriteRecord(record leasefence.Record) error {
	w.mu.Lock()
	w.records[record.ContainerID] = record
	w.mu.Unlock()
	w.h.record("watchdog:write:%s", time.Duration(record.DeadlineNs))
	return nil
}

func (w *fakeWatchdog) DeleteRecord(id string) error {
	w.mu.Lock()
	delete(w.records, id)
	w.mu.Unlock()
	w.h.record("watchdog:delete")
	return nil
}

type fakeEndpoints struct {
	h       *harness
	mu      sync.Mutex
	serving bool
}

func (e *fakeEndpoints) SetServing(_, _ string, serving bool) {
	e.mu.Lock()
	e.serving = serving
	e.mu.Unlock()
	e.h.record("endpoints:%v", serving)
}

func (e *fakeEndpoints) isServing() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.serving
}

type fakeGates struct{ open bool }

func (g *fakeGates) OpenFor(string, string, time.Time) bool { return g.open }

// --- lease ---

type fakeLease struct {
	h                *harness
	mu               sync.Mutex
	role             Role
	fenceReason      FenceReason
	deadlineAhead    time.Duration
	mayStart         bool
	retaining        bool
	manifest         *ManifestInfo
	ready            bool
	handler          *StateHandler
	committed        *CertifiedState
	pending          *PendingTransition
	outcomes         map[string]TransitionOutcome
	rejectNext       bool
	observed         *CertifiedState
	forceErr         error
	force            ForceStatus
	bootstrapPending bool
	released         string
	ballotRound      uint64
}

func newFakeLease(h *harness) *fakeLease {
	return &fakeLease{h: h, role: availabilitylease.RoleCandidate, outcomes: map[string]TransitionOutcome{}, deadlineAhead: 24 * time.Second,
		manifest: &ManifestInfo{PolicyID: policyID, Version: 1, Slots: 1, Candidates: []string{selfNode, nodeB, nodeC}}}
}

func stateHash(value []byte) [32]byte { return sha256.Sum256(value) }

// hold makes this node the holder with the given certified value.
func (f *fakeLease) hold(value Value, pendingPromotion bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := value.Encode()
	if err != nil {
		panic(err)
	}
	f.ballotRound++
	f.role, f.mayStart, f.fenceReason = availabilitylease.RoleHolding, true, ""
	f.committed = &CertifiedState{
		Key: Key{PolicyID: policyID}, Ballot: Ballot{Round: f.ballotRound, Incarnation: 1, Proposer: selfNode},
		State: HolderState{Value: data, Holder: selfNode, PendingPromotion: pendingPromotion, Generation: f.ballotRound},
		Hash:  stateHash(data),
	}
	if !pendingPromotion {
		f.committed.State.PromotedHolder = selfNode
	}
}

func (f *fakeLease) value() Value {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.committed == nil {
		return Value{}
	}
	value, err := DecodeValue(f.committed.State.Value)
	if err != nil {
		panic(err)
	}
	return value
}

func (f *fakeLease) setRole(role Role, reason FenceReason) {
	f.mu.Lock()
	f.role, f.fenceReason = role, reason
	f.mayStart = role == availabilitylease.RoleHolding
	f.mu.Unlock()
}

func (f *fakeLease) HolderStatus(key Key) HolderStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := HolderStatus{Key: key, Role: f.role}
	now := f.h.clock.Now()
	switch f.role {
	case availabilitylease.RoleHolding:
		status.Holding, status.MayStart, status.Deadline = true, f.mayStart, now+f.deadlineAhead
		status.SoftFenceAt = status.Deadline - 9*time.Second
		status.FenceNow = !f.mayStart
		status.Retaining = f.retaining
		if status.FenceNow {
			status.FenceReason = "renewal_timeout"
		}
	case availabilitylease.RoleRecovering:
		status.Deadline = now + f.deadlineAhead
	case availabilitylease.RoleFencing:
		status.FenceNow, status.FenceReason, status.Deadline = true, f.fenceReason, now+f.deadlineAhead
	case availabilitylease.RoleAbandoned:
		status.Deadline = now + f.deadlineAhead
	case availabilitylease.RoleRetained:
		status.Retained = true
	}
	if f.committed != nil {
		status.Ballot = f.committed.Ballot
	}
	return status
}

func (f *fakeLease) ManifestInfo(string) (ManifestInfo, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.manifest == nil {
		return ManifestInfo{}, false
	}
	return *f.manifest, true
}

func (f *fakeLease) BootstrapPending(Key) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bootstrapPending
}

func (f *fakeLease) SetCandidateReady(_ string, ready bool) {
	f.mu.Lock()
	changed := f.ready != ready
	f.ready = ready
	f.mu.Unlock()
	if changed {
		f.h.record("lease:ready:%v", ready)
	}
}

func (f *fakeLease) SetStateHandler(_ string, handler *StateHandler) {
	f.mu.Lock()
	f.handler = handler
	f.mu.Unlock()
}

func (f *fakeLease) ProposeTransition(_ Key, t Transition) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.role != availabilitylease.RoleHolding {
		return availabilitylease.ErrNotHolding
	}
	if f.pending != nil {
		return availabilitylease.ErrTransitionPending
	}
	base := [32]byte{}
	if f.committed != nil {
		base = f.committed.Hash
	}
	f.pending = &PendingTransition{Transition: t, Base: base}
	f.outcomes[t.ID] = availabilitylease.TransitionQueued
	value, _ := DecodeValue(t.Value)
	f.h.record("lease:propose:%s:promoted=%v:tl=%d:sync=%s", strings.SplitN(t.ID, "-", 2)[0], t.Promoted, value.Timeline, strings.Join(value.SyncSet, ","))
	return nil
}

// certifyPending applies the queued transition as a majority would.
func (f *fakeLease) certifyPending() {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.pending
	if p == nil {
		return
	}
	f.pending = nil
	if f.rejectNext {
		f.rejectNext = false
		f.outcomes[p.ID] = availabilitylease.TransitionRejected
		f.h.record("lease:rejected:%s", p.ID)
		return
	}
	state := f.committed.State
	state.Value, state.TransitionID = p.Value, p.ID
	state.Generation++
	if p.Promoted {
		state.PendingPromotion, state.PromotedHolder, state.Forced = false, selfNode, nil
	}
	f.committed.State = state
	f.committed.Hash = stateHash(p.Value)
	f.outcomes[p.ID] = availabilitylease.TransitionCertified
	f.h.record("lease:certified:%s", strings.SplitN(p.ID, "-", 2)[0])
}

func (f *fakeLease) TransitionStatus(_ Key, id string) (TransitionOutcome, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.outcomes[id], ""
}

func (f *fakeLease) CommittedState(Key) (CertifiedState, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.committed == nil || (f.role != availabilitylease.RoleHolding && f.role != availabilitylease.RoleRecovering &&
		f.role != availabilitylease.RoleFencing) {
		return CertifiedState{}, false
	}
	return *f.committed, true
}

func (f *fakeLease) PendingState(Key) (PendingTransition, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pending == nil {
		return PendingTransition{}, false
	}
	return *f.pending, true
}

func (f *fakeLease) ObservedCommit(Key) (CertifiedState, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.observed == nil {
		return CertifiedState{}, false
	}
	return *f.observed, true
}

func (f *fakeLease) ForceAcquire(_ Key, request ForceRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.forceErr != nil {
		return f.forceErr
	}
	f.force = ForceStatus{OperationID: request.OperationID, Over: request.Over, Outcome: availabilitylease.ForcePending}
	value, _ := DecodeValue(request.Value)
	f.h.record("lease:force:%s:over=%s:tl=%d:forced=%v", request.OperationID, request.Over.String(), value.Timeline, value.Forced != nil)
	return nil
}

func (f *fakeLease) ForceStatus(Key) ForceStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.force
}

func (f *fakeLease) Recover(_ Key, deadline time.Duration) {
	f.mu.Lock()
	f.role = availabilitylease.RoleRecovering
	f.mu.Unlock()
	f.h.record("lease:recover:%s", deadline)
}

func (f *fakeLease) Release(_ Key, successor string) error {
	f.mu.Lock()
	f.role, f.released = availabilitylease.RoleReleasing, successor
	f.mu.Unlock()
	f.h.record("lease:release:%s", successor)
	return nil
}

func (f *fakeLease) FenceComplete(Key) {
	f.mu.Lock()
	f.role = availabilitylease.RoleCandidate
	f.mu.Unlock()
	f.h.record("lease:fence_complete")
}

func (f *fakeLease) Abandon(Key) {
	f.mu.Lock()
	if f.role == availabilitylease.RoleHolding || f.role == availabilitylease.RoleFencing || f.role == availabilitylease.RoleRecovering {
		f.role = availabilitylease.RoleAbandoned
	}
	f.mu.Unlock()
	f.h.record("lease:abandon")
}

// --- postgres ---

type fakePG struct {
	h  *harness
	mu sync.Mutex

	exists, running, answering bool
	signal                     bool
	inRecovery                 bool
	initialized                bool
	timeline                   uint32
	history                    map[uint32][]TimelineEntry
	flush, receive, replay     LSN
	latestEnd                  LSN
	receiver                   string
	names                      string
	// loadedNames are the names the walsenders run with; namesLoadedLag
	// counts replication reads before a names change reaches them.
	loadedNames    string
	namesLoadedLag int
	peers          []ReplicationPeer
	waiters        SyncWaiters
	logs           []LogLine
	cgroupBusy     bool
	shutdownState  string
	promoteErr     error
	rewindErr      error
	rewind         RewindResult
	// rewindPartErr fails the real pg_rewind after it began rewriting the
	// directory (H3); partial marks such a directory until a rebuild.
	rewindPartErr   error
	partial         bool
	rebuild         RebuildResult
	rebuildErr      error
	violations      []string
	slots           []string
	terminated      int
	stopUncleanOnce bool
	identities      int
	// startReceiver is the walreceiver status after a start.
	startReceiver string
	// onReplication runs on every replication read (successor catch-up).
	onReplication func(p *fakePG)
}

func newFakePG(h *harness) *fakePG {
	return &fakePG{h: h, exists: true, running: true, answering: true, signal: true, inRecovery: true, initialized: true, timeline: 1,
		history: map[uint32][]TimelineEntry{}, receiver: "streaming", replay: MustLSN("0/3000000"), receive: MustLSN("0/3000000"),
		shutdownState: "shut down in recovery", startReceiver: "streaming"}
}

func (p *fakePG) set(fn func(*fakePG)) { p.mu.Lock(); fn(p); p.mu.Unlock() }

func (p *fakePG) setPeers(peers ...ReplicationPeer) { p.set(func(p *fakePG) { p.peers = peers }) }

func (p *fakePG) Container(context.Context) (ContainerState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return ContainerState{Exists: p.exists, Running: p.running, ID: containerA, CgroupPath: "/sys/fs/cgroup/x"}, nil
}

func (p *fakePG) PrepareStandby(_ context.Context, config StandbyConfig) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return errors.New("running")
	}
	if !p.initialized {
		return errors.New("not initialized")
	}
	p.signal = true
	p.names = ""
	p.h.record("pg:prepare_standby:%s:%s", config.MemberID, config.ReplicationRole)
	return nil
}

func (p *fakePG) MarkStandbyAtRest(context.Context) error {
	p.mu.Lock()
	p.signal = true
	p.mu.Unlock()
	p.h.record("pg:mark_at_rest")
	return nil
}

func (p *fakePG) ClearStandbySignal(context.Context) error {
	p.mu.Lock()
	p.signal = false
	p.mu.Unlock()
	p.h.record("pg:clear_signal")
	return nil
}

func (p *fakePG) Start(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.signal {
		p.violations = append(p.violations, "started without standby.signal")
	}
	if p.partial {
		p.violations = append(p.violations, "started a partly rewound data directory")
	}
	if !p.initialized {
		p.violations = append(p.violations, "started an empty data directory")
	}
	p.running, p.answering, p.inRecovery = true, true, p.signal
	p.receiver = p.startReceiver
	p.h.record("pg:start:recovery=%v", p.inRecovery)
	return nil
}

func (p *fakePG) StopClean(context.Context, time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		p.shutdownState = "shut down"
		if p.inRecovery {
			p.shutdownState = "shut down in recovery"
		}
	}
	if p.stopUncleanOnce {
		// The stop timed out and the container was killed.
		p.stopUncleanOnce, p.shutdownState = false, "in production"
	}
	p.running = false
	p.h.record("pg:stop_clean")
	return nil
}

func (p *fakePG) Kill(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running && !p.inRecovery {
		p.shutdownState = "in production"
	}
	p.running = false
	p.h.record("pg:kill")
	return nil
}

func (p *fakePG) CgroupEmpty(context.Context) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.running && !p.cgroupBusy, nil
}

func (p *fakePG) Status(context.Context) (ServerStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.running || !p.answering {
		return ServerStatus{}, nil
	}
	status := ServerStatus{Answering: true, InRecovery: p.inRecovery, Timeline: p.timeline, ServerVersion: 180000}
	if p.inRecovery {
		status.ReceiveLSN, status.ReplayLSN, status.ReceiverStatus, status.LatestEndLSN = p.receive, p.replay, p.receiver, p.latestEnd
		status.ReceiverTimeline = p.timeline
	} else {
		status.FlushLSN = p.flush
	}
	return status, nil
}

// Replication reports sync_state as Postgres does: sync for a member the
// walsenders' loaded names include (namesLoadedLag delays that after a
// names change, as the asynchronous reload does), async otherwise.
func (p *fakePG) Replication(context.Context) ([]ReplicationPeer, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.onReplication != nil {
		p.onReplication(p)
	}
	if p.names != p.loadedNames {
		if p.namesLoadedLag > 0 {
			p.namesLoadedLag--
		} else {
			p.loadedNames = p.names
		}
	}
	out := append([]ReplicationPeer(nil), p.peers...)
	for i := range out {
		out[i].SyncState = "async"
		if strings.Contains(p.loadedNames, `"`+out[i].ApplicationName+`"`) {
			out[i].SyncState = "sync"
		}
	}
	return out, nil
}

func (p *fakePG) Waiters(context.Context) (SyncWaiters, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waiters, nil
}

func (p *fakePG) SetSyncNames(_ context.Context, names string) error {
	p.mu.Lock()
	p.names = names
	p.mu.Unlock()
	p.h.record("pg:names:%s", names)
	return nil
}

func (p *fakePG) Checkpoint(context.Context) error {
	p.h.record("pg:checkpoint")
	return nil
}

func (p *fakePG) CurrentFlushLSN(context.Context) (LSN, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.h.record("pg:flush_sample:%s", p.flush)
	return p.flush, nil
}

func (p *fakePG) Promote(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.promoteErr != nil {
		return p.promoteErr
	}
	if !p.inRecovery {
		return errors.New("server is not in recovery")
	}
	previous := p.timeline
	p.timeline++
	p.history[p.timeline] = append(append([]TimelineEntry(nil), p.history[previous]...), TimelineEntry{Timeline: previous, SwitchLSN: p.replay})
	p.inRecovery, p.signal = false, false
	p.flush = p.replay
	p.h.record("pg:promote:tl=%d", p.timeline)
	return nil
}

func (p *fakePG) TimelineHistory(_ context.Context, timeline uint32) ([]TimelineEntry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]TimelineEntry(nil), p.history[timeline]...), nil
}

func (p *fakePG) SyncSlots(_ context.Context, keep []string) error {
	p.mu.Lock()
	p.slots = append([]string(nil), keep...)
	p.mu.Unlock()
	p.h.record("pg:slots:%s", strings.Join(keep, ","))
	return nil
}

func (p *fakePG) EnsureIdentities(_ context.Context, identities Identities) error {
	p.mu.Lock()
	p.identities++
	p.mu.Unlock()
	p.h.record("pg:identities:%d", len(identities.Replication))
	return nil
}

func (p *fakePG) TerminateClients(context.Context) error {
	p.mu.Lock()
	p.terminated++
	p.mu.Unlock()
	p.h.record("pg:terminate_clients")
	return nil
}

func (p *fakePG) LogSince(_ context.Context, since time.Time) ([]LogLine, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []LogLine
	for _, line := range p.logs {
		if line.At.After(since) {
			out = append(out, line)
		}
	}
	return out, nil
}

func (p *fakePG) logLine(text string) {
	p.mu.Lock()
	p.logs = append(p.logs, LogLine{At: p.h.clock.Wall(), Text: text})
	p.mu.Unlock()
}

func (p *fakePG) Rewind(_ context.Context, _ StandbyConfig) (RewindResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return RewindResult{}, errors.New("target running")
	}
	if p.shutdownState != "shut down" && p.shutdownState != "shut down in recovery" {
		p.violations = append(p.violations, "rewind of an uncleanly stopped target")
	}
	p.h.record("pg:rewind")
	if p.rewindErr != nil {
		return RewindResult{}, p.rewindErr
	}
	if p.rewindPartErr != nil {
		p.partial = true
		return RewindResult{Started: true, DivergedAt: p.rewind.DivergedAt}, p.rewindPartErr
	}
	if !p.rewind.NeedsRebuild {
		p.signal = true
	}
	return p.rewind, nil
}

func (p *fakePG) Rebuild(_ context.Context, _ StandbyConfig) (RebuildResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return RebuildResult{}, errors.New("target running")
	}
	p.h.record("pg:rebuild")
	if p.rebuildErr != nil {
		return RebuildResult{}, p.rebuildErr
	}
	p.signal, p.partial, p.initialized = true, false, true
	return p.rebuild, nil
}

func (p *fakePG) CommitRebuild(context.Context) error {
	p.h.record("pg:commit_rebuild")
	return nil
}

func (p *fakePG) ShutdownState(context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.shutdownState, nil
}

func (p *fakePG) DataInitialized() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.initialized
}

func (p *fakePG) DiskFree() uint64 { return 10 << 30 }

func (p *fakePG) DialServer(context.Context) (net.Conn, error) {
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

func (p *fakePG) requireNoViolations(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.violations) > 0 {
		t.Fatalf("postgres violations: %v", p.violations)
	}
}

func streamingPeer(member, role string, flush LSN) ReplicationPeer {
	return ReplicationPeer{ApplicationName: member, UseName: role, State: "streaming", SyncState: "async", SentLSN: flush, WriteLSN: flush, FlushLSN: flush, ReplayLSN: flush}
}

func syncValue(timeline uint32, set ...string) Value {
	return Value{Timeline: timeline, Durability: DurabilitySynchronous, SyncSet: normalizeSet(set)}
}

// steadyHolder makes this member a promoted, certified primary on timeline 2.
func steadyHolder(t *testing.T, h *harness, value Value) {
	t.Helper()
	value.Timeline, value.ParentTimeline, value.SwitchLSN = 2, 1, MustLSN("0/2000000")
	h.pg.set(func(p *fakePG) {
		p.inRecovery, p.timeline, p.signal, p.flush = false, 2, true, MustLSN("0/5000000")
		p.history[2] = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/2000000")}}
	})
	h.lease.hold(value, false)
}

func recordFor(h *harness, ahead time.Duration) leasefence.Record {
	return leasefence.Record{ContainerID: containerA, PolicyID: policyID, DeadlineNs: int64(h.clock.Now() + ahead)}
}
