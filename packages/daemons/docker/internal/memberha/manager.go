package memberha

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
)

const (
	observeInterval = time.Second
	opTimeout       = 2 * time.Minute
	// longOpTimeout bounds rejoins (rewind, resync, rebuild).
	longOpTimeout = 30 * time.Minute
	callTimeout   = 10 * time.Second
	// watchdogLostConfirm mirrors the lease runtime: a heartbeat older than
	// leasefence.HeartbeatLostAge on two steps a second apart is lost.
	watchdogLostConfirm = time.Second
	cgroupConfirmWait   = 5 * time.Second
)

// Manager runs the availability set members of this node.
type Manager struct {
	deps   Deps
	store  *Store
	logger *slog.Logger

	mu       sync.Mutex
	members  map[string]*member // by set id
	results  []func()
	watchdog watchdogTracker
	// watchdogFresh mirrors watchdog.fresh for the lease callbacks, which never take mu.
	watchdogFresh atomic.Bool
	proxies       map[string]*Proxy
	held          map[string]int
	// confirmWait bounds the wait for an empty cgroup after a stop.
	confirmWait time.Duration
}

type watchdogTracker struct {
	fresh     bool
	lost      bool
	lostSince time.Duration
	lostSteps int
}

// member is the runtime of one set's member on this node.
type member struct {
	cfg    Config
	state  MemberState
	engine Engine

	obs         observation
	observing   bool
	nextObserve time.Duration

	busy       bool
	op         string
	lastOpDone time.Duration
	started    bool

	// serving: endpoints SERVING and the proxy admitting.
	serving         atomic.Bool
	endpointMu      sync.Mutex
	endpointApplied bool
	endpointKnown   bool
	// legacy: the member that serves as the single-node resource before its
	// set's lease bootstrap committed.
	legacy atomic.Bool

	holder  holderRuntime
	standby standbyRuntime
	manual  manualRuntime
	ready   bool
	// switchover is a planned handoff the engine prepares first
	// (SwitchoverPreparer, extensions.go).
	switchover *stagedSwitchover
	// gate mirrors what the lease callbacks need (they never take the manager's lock).
	gateStopped  atomic.Bool
	gateDataBusy atomic.Bool
	// gatePaused mirrors cfg.Stopped (Gateway paused the set); gateHeld: the
	// daemon holds the member to replace its container or files.
	gatePaused atomic.Bool
	gateHeld   atomic.Bool
	// resumeStart: the primary's engine is down because the set was paused;
	// once the pause ends the holder starts it at once (standby at rest, then
	// promoted again) instead of treating it as a failed engine.
	resumeStart bool

	// status is the last engine status, for the eligibility callback.
	statusMu   sync.Mutex
	lastStatus EngineStatus
	statusAt   time.Duration

	eligMu         sync.Mutex
	eligible       bool
	eligibleReason string
	lastError      string
}

type observation struct {
	at        time.Duration
	container ContainerState
	cErr      error
	status    EngineStatus
	sErr      error
}

// NewManager loads every stored member and registers its state handler.
func NewManager(deps Deps, store *Store) (*Manager, error) {
	if err := deps.defaults(); err != nil {
		return nil, err
	}
	if store == nil {
		return nil, errors.New("the availability member runtime needs a store")
	}
	m := &Manager{deps: deps, store: store, logger: deps.Logger, members: map[string]*member{}, proxies: map[string]*Proxy{},
		held: map[string]int{}, confirmWait: cgroupConfirmWait}
	stored, err := store.LoadAll()
	if err != nil {
		m.logger.Error("some availability member files could not be read; those members stay stopped until Opfield configures them again", "error", err)
	}
	ids := make([]string, 0, len(stored))
	for id := range stored {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		entry := stored[id]
		if _, addErr := m.addMemberLocked(entry.Config, entry.State); addErr != nil {
			m.logger.Error("availability member could not be loaded", "set_id", id, "error", addErr)
		}
	}
	return m, nil
}

func (m *Manager) addMemberLocked(config Config, state MemberState) (*member, error) {
	engine, err := m.deps.Engine(config)
	if err != nil {
		return nil, err
	}
	mem := &member{cfg: config, state: state, engine: engine}
	mem.gateStopped.Store(state.Stopped)
	mem.gatePaused.Store(config.Stopped)
	m.members[config.SetID] = mem
	if config.Mode == ModeAutomatic {
		m.registerHandlerLocked(mem)
	}
	return mem, nil
}

// registerHandlerLocked registers the member's lease state handler. The
// callbacks run on the lease loop: they read the last sample, never the engine.
func (m *Manager) registerHandlerLocked(mem *member) {
	if mem.state.Detached != nil {
		return
	}
	m.deps.Lease.SetStateHandler(mem.cfg.LeasePolicyID, &StateHandler{
		Eligible: func(in EligibilityInput) (bool, string) {
			ok, reason := m.eligible(mem, in)
			mem.eligMu.Lock()
			mem.eligible, mem.eligibleReason = ok, reason
			mem.eligMu.Unlock()
			return ok, reason
		},
		BootstrapValue: func(Key) ([]byte, error) {
			status, fresh := mem.sample(m.deps.Clock.Now())
			if !fresh || !status.Answering {
				return nil, errors.New("the member has not been observed yet")
			}
			return mem.engine.BootstrapValue(status)
		},
	})
}

// eligible applies the rules every engine shares before asking the engine:
// a fresh sample of an answering engine, a live watchdog, no operation
// rewriting the data, not being removed.
func (m *Manager) eligible(mem *member, in EligibilityInput) (bool, string) {
	now := m.deps.Clock.Now()
	watchdogFresh, stopped, busy := m.watchdogFresh.Load(), mem.gateStopped.Load(), mem.gateDataBusy.Load()
	status, fresh := mem.sample(now)
	switch {
	case stopped:
		return false, "removing"
	case mem.gatePaused.Load():
		return false, "stopped"
	case mem.gateHeld.Load():
		return false, "held"
	case !watchdogFresh:
		return false, "watchdog_not_fresh"
	case busy:
		return false, "rejoining"
	case !fresh:
		return false, "not_observed"
	case !status.Answering:
		return false, "engine_not_answering"
	case status.NeedsRejoin:
		return false, "needs_rejoin"
	}
	return mem.engine.Eligible(in, status)
}

// sample is the last engine status and whether it is recent.
func (mem *member) sample(now time.Duration) (EngineStatus, bool) {
	mem.statusMu.Lock()
	defer mem.statusMu.Unlock()
	return mem.lastStatus, mem.statusAt > 0 && now-mem.statusAt <= 3*observeInterval
}

// Owns reports whether a lease policy is a set policy of this node: the
// Availability lease runtime leaves those to the Manager.
func (m *Manager) Owns(policyID string) bool {
	if policyID == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mem := range m.members {
		if mem.cfg.LeasePolicyID == policyID {
			return true
		}
	}
	return false
}

// ObserveFreeze: a freeze of this host the lease protocol detected; the lease
// fences the holders itself, the proxy re-checks on its next sweep.
func (m *Manager) ObserveFreeze(time.Duration) {}

// Step runs one iteration: completed operations, observations, then every
// member's decision. It never waits on Docker or an engine.
func (m *Manager) Step() {
	now := m.deps.Clock.Now()
	age, present := m.deps.Watchdog.HeartbeatAge(now)
	m.mu.Lock()
	defer m.mu.Unlock()
	results := m.results
	m.results = nil
	for _, done := range results {
		done()
	}
	m.observeWatchdogLocked(now, age, present)
	ids := make([]string, 0, len(m.members))
	for id := range m.members {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		mem := m.members[id]
		if m.held[id] > 0 {
			// The daemon replaces the member's container or files: no
			// decision until it hands the member back.
			continue
		}
		m.drainEngineEventsLocked(mem)
		if mem.state.Detached != nil {
			// Detached before its first holder (H2): no lease role, no
			// engine decision until the daemon forgets it.
			continue
		}
		m.maybeObserveLocked(mem, now)
		if mem.cfg.Mode == ModeManual {
			m.manualStepLocked(mem, now)
		} else {
			m.stepMemberLocked(mem, now)
		}
	}
}

// Hold stops the runtime from acting on a set's member while the daemon
// changes its container or files, and waits until the member's running
// operation ended. The returned release hands it back.
func (m *Manager) Hold(ctx context.Context, setID string) (func(), error) {
	m.mu.Lock()
	m.held[setID]++
	if mem := m.members[setID]; mem != nil {
		// A held member may not take the primary role over: its container or
		// files change under it.
		mem.gateHeld.Store(true)
		if mem.cfg.Mode == ModeAutomatic && mem.ready {
			mem.ready = false
			m.deps.Lease.SetCandidateReady(mem.cfg.LeasePolicyID, false)
		}
	}
	m.mu.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			still := true
			if m.held[setID]--; m.held[setID] <= 0 {
				delete(m.held, setID)
				still = false
			}
			if mem := m.members[setID]; mem != nil {
				mem.gateHeld.Store(still)
				mem.lastOpDone = m.deps.Clock.Now()
				mem.nextObserve = 0
			}
		})
	}
	for {
		m.mu.Lock()
		mem := m.members[setID]
		idle := mem == nil || !mem.busy
		m.mu.Unlock()
		if idle {
			return release, nil
		}
		select {
		case <-ctx.Done():
			release()
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (m *Manager) observeWatchdogLocked(now, age time.Duration, present bool) {
	wd := &m.watchdog
	wd.fresh = present && age <= leasefence.HeartbeatMaxAge
	m.watchdogFresh.Store(wd.fresh)
	if present && age <= leasefence.HeartbeatLostAge {
		wd.lost, wd.lostSteps = false, 0
		return
	}
	if wd.lostSteps == 0 {
		wd.lostSince = now
	}
	wd.lostSteps++
	if !wd.lost && wd.lostSteps >= 2 && now-wd.lostSince >= watchdogLostConfirm {
		wd.lost = true
		m.logger.Warn("lease watchdog heartbeat lost; availability primaries on this node stop renewing and are killed")
	}
}

func (m *Manager) maybeObserveLocked(mem *member, now time.Duration) {
	if mem.observing || now < mem.nextObserve {
		return
	}
	mem.observing = true
	engine := mem.engine
	m.deps.Async(func() {
		start := m.deps.Clock.Now()
		ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		defer cancel()
		var obs observation
		obs.container, obs.cErr = engine.Container(ctx)
		if obs.cErr == nil && obs.container.Running {
			obs.status, obs.sErr = engine.Status(ctx)
			if obs.sErr != nil {
				obs.status = EngineStatus{}
			}
		}
		obs.at = start
		m.mu.Lock()
		m.results = append(m.results, func() {
			mem.observing = false
			mem.nextObserve = start + observeInterval
			mem.obs = obs
			mem.statusMu.Lock()
			mem.lastStatus, mem.statusAt = obs.status, obs.at
			if obs.at <= mem.lastOpDone {
				// An operation changed the member since the sample.
				mem.statusAt = 0
			}
			mem.statusMu.Unlock()
		})
		m.mu.Unlock()
	})
}

// fresh reports an observation taken after the member's last operation.
func (mem *member) fresh(now time.Duration) bool {
	return mem.obs.at > 0 && mem.obs.at > mem.lastOpDone && now-mem.obs.at <= 3*observeInterval
}

// primaryRunning: the container runs an engine that answers as the primary.
func (mem *member) primaryRunning() bool {
	return mem.obs.container.Running && mem.obs.status.Answering && mem.obs.status.Writable
}

// copyRunning: the container runs an engine that answers as a copy.
func (mem *member) copyRunning() bool {
	return mem.obs.container.Running && mem.obs.status.Answering && !mem.obs.status.Writable
}

// dataBusy: an operation is rewriting the member's data.
func (mem *member) dataBusy() bool { return mem.busy && mem.op == opRejoin }

// launch runs one background operation of a member; its result is applied
// by the next Step under the lock.
func (m *Manager) launch(mem *member, name string, timeout time.Duration, op func(ctx context.Context) func()) {
	mem.busy, mem.op = true, name
	mem.gateDataBusy.Store(name == opRejoin)
	m.deps.Async(func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		done := op(ctx)
		cancel()
		at := m.deps.Clock.Now()
		m.mu.Lock()
		m.results = append(m.results, func() {
			mem.busy, mem.op = false, ""
			mem.gateDataBusy.Store(false)
			mem.lastOpDone = at
			mem.nextObserve = 0
			if done != nil {
				done()
			}
		})
		m.mu.Unlock()
	})
}

// saveLocked persists the member before the runtime acts on its new state.
func (m *Manager) saveLocked(mem *member) error {
	mem.gateStopped.Store(mem.state.Stopped)
	mem.gatePaused.Store(mem.cfg.Stopped)
	if err := m.store.Save(mem.cfg, mem.state); err != nil {
		m.logger.Error("could not persist availability member state", "set_id", mem.cfg.SetID, "error", err)
		return err
	}
	return nil
}

// eventLocked records and persists an event with the time it happened.
func (m *Manager) eventLocked(mem *member, event Event) {
	recorded := mem.state.addEvent(m.deps.Clock.Wall(), event)
	_ = m.saveLocked(mem)
	m.logger.Info("availability member event", "set_id", mem.cfg.SetID, "member_id", mem.cfg.MemberID,
		"kind", recorded.Kind, "reason", recorded.Reason, "operation_id", recorded.OperationID)
}

func (m *Manager) setErrorLocked(mem *member, message string) {
	if mem.lastError != message {
		m.logger.Warn("availability member", "set_id", mem.cfg.SetID, "member_id", mem.cfg.MemberID, "error", message)
	}
	mem.lastError = message
}

// openServingLocked registers the member's relay endpoints SERVING and lets
// the proxy admit.
func (m *Manager) openServingLocked(mem *member) {
	if !mem.serving.Swap(true) {
		m.deps.Async(func() { m.applyEndpoints(mem) })
	}
}

// closeServingLocked stops the proxy admitting (and ends its sessions) at once
// and deregisters the endpoints in the background.
func (m *Manager) closeServingLocked(mem *member) {
	wasServing := mem.serving.Swap(false)
	if proxy := m.proxies[mem.cfg.SetID]; proxy != nil {
		proxy.CloseAll()
	}
	if wasServing || !mem.endpointKnown {
		m.deps.Async(func() { m.applyEndpoints(mem) })
	}
}

// closeServing is closeServingLocked for operations (no manager lock): it
// returns once the endpoints are dormant and their tunnels ended (A6).
func (m *Manager) closeServing(mem *member) {
	mem.serving.Store(false)
	m.mu.Lock()
	proxy := m.proxies[mem.cfg.SetID]
	m.mu.Unlock()
	if proxy != nil {
		proxy.CloseAll()
	}
	m.applyEndpoints(mem)
}

// applyEndpoints serializes endpoint changes per member; each call applies the
// latest desired state, so calls that run out of order converge.
func (m *Manager) applyEndpoints(mem *member) {
	mem.endpointMu.Lock()
	defer mem.endpointMu.Unlock()
	desired := mem.serving.Load()
	if mem.endpointApplied == desired && mem.endpointKnown {
		return
	}
	m.deps.Endpoints.SetServing(mem.cfg.SetID, mem.cfg.MemberID, desired)
	mem.endpointApplied, mem.endpointKnown = desired, true
}

// MemberServing reports whether this node's member of setID serves client
// traffic now; known is false when no member of setID runs here.
func (m *Manager) MemberServing(setID, memberID string) (serving bool, known bool) {
	m.mu.Lock()
	mem := m.members[setID]
	m.mu.Unlock()
	if mem == nil || mem.cfg.MemberID != memberID {
		return false, false
	}
	return mem.serving.Load() || mem.legacy.Load(), true
}

// PeerServing reports whether this node's member of setID takes peer traffic on
// port: the member-control port while the member exists, an engine port while
// its container runs and the member is not being removed.
func (m *Manager) PeerServing(setID, memberID, port string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil || mem.cfg.MemberID != memberID {
		return false
	}
	if port == MemberControlPort {
		return true
	}
	return !mem.state.Stopped && mem.obs.container.Running
}

// DialPeer connects an incoming peer tunnel to this node's member's engine port.
func (m *Manager) DialPeer(ctx context.Context, setID, memberID, port string) (net.Conn, error) {
	m.mu.Lock()
	mem := m.members[setID]
	m.mu.Unlock()
	if mem == nil || mem.cfg.MemberID != memberID {
		return nil, errors.New("the set has no such member on this node")
	}
	return mem.engine.DialPeer(ctx, port)
}

// Members lists the set ids of this node's members.
func (m *Manager) Members() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.members))
	for id := range m.members {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Config is the configuration of this node's member of setID.
func (m *Manager) Config(setID string) (Config, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return Config{}, false
	}
	return mem.cfg, true
}

// Configure adds or updates this node's member of a set (Gateway's
// configuration). A configuration older than the one applied is ignored.
func (m *Manager) Configure(config Config) error {
	if err := config.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[config.SetID]
	if mem != nil {
		if config.ConfigRevision < mem.cfg.ConfigRevision {
			return nil
		}
		if mem.cfg.MemberID != config.MemberID {
			return fmt.Errorf("set %s already has member %s on this node", config.SetID, mem.cfg.MemberID)
		}
		if mem.cfg.LeasePolicyID != config.LeasePolicyID && mem.cfg.LeasePolicyID != "" {
			// A new availability period: the old policy is never adopted again.
			m.deps.Lease.SetStateHandler(mem.cfg.LeasePolicyID, nil)
			m.deps.Lease.SetCandidateReady(mem.cfg.LeasePolicyID, false)
			mem.ready = false
		}
		if reconfigurer, ok := mem.engine.(Reconfigurer); ok {
			if err := reconfigurer.Reconfigure(config); err != nil {
				return err
			}
		}
		if mem.cfg.Stopped && !config.Stopped {
			// The pause ends: a primary whose engine is down starts at once.
			mem.resumeStart = true
		}
		mem.cfg = config
		mem.state.Stopped = false
		if err := m.saveLocked(mem); err != nil {
			return err
		}
		if config.Mode == ModeAutomatic {
			m.registerHandlerLocked(mem)
		}
		return nil
	}
	if err := m.store.Save(config, MemberState{}); err != nil {
		return err
	}
	_, err := m.addMemberLocked(config, MemberState{})
	return err
}

// Remove stops this node's member of setID for good: it keeps running as a
// stopped copy until the daemon removes its container and calls Forget.
func (m *Manager) Remove(setID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return nil
	}
	if !mem.state.Stopped {
		if err := m.removableLocked(mem); err != nil {
			return err
		}
	}
	mem.state.Stopped = true
	return m.saveLocked(mem)
}

// Forget drops a removed member once its container and data are gone.
func (m *Manager) Forget(setID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return nil
	}
	if mem.cfg.LeasePolicyID != "" {
		m.deps.Lease.SetStateHandler(mem.cfg.LeasePolicyID, nil)
		m.deps.Lease.SetCandidateReady(mem.cfg.LeasePolicyID, false)
	}
	if proxy := m.proxies[setID]; proxy != nil {
		proxy.Close()
		delete(m.proxies, setID)
	}
	delete(m.members, setID)
	return m.store.Delete(setID)
}

// AckEvents drops the events Gateway stored, up to through.
func (m *Manager) AckEvents(setID string, through uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil || !mem.state.ackEvents(through) {
		return nil
	}
	return m.saveLocked(mem)
}

// AssignPrimary records a manual pair's primary assignment Gateway signed; an
// assignment not newer than the one recorded is ignored, an unverified one is
// refused.
func (m *Manager) AssignPrimary(setID string, assignment Assignment) error {
	if err := m.deps.VerifyAssignment(setID, assignment); err != nil {
		return fmt.Errorf("primary assignment refused: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return fmt.Errorf("set %s has no member on this node", setID)
	}
	return m.adoptAssignmentLocked(mem, assignment, "gateway")
}

// adoptAssignmentLocked records a verified assignment newer than the one
// this member knows.
func (m *Manager) adoptAssignmentLocked(mem *member, assignment Assignment, source string) error {
	if mem.cfg.Mode != ModeManual {
		return errors.New("only a manual pair has a primary assignment")
	}
	if assignment.Generation <= mem.state.Assignment.Generation {
		return nil
	}
	if _, ok := mem.cfg.Peer(assignment.PrimaryMemberID); !ok {
		return errors.New("the assigned primary is no member of the set")
	}
	mem.state.Assignment = assignment
	if err := m.saveLocked(mem); err != nil {
		return err
	}
	if source != "gateway" {
		m.eventLocked(mem, Event{Kind: EventAssignmentLearned, Reason: source,
			Detail: map[string]string{"generation": strconv.FormatUint(assignment.Generation, 10), "primaryMemberId": assignment.PrimaryMemberID}})
	}
	return nil
}

// PeerState is what this node's member of setID tells its peer over the
// member-control port.
func (m *Manager) PeerState(setID string) (PeerState, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return PeerState{}, false
	}
	state := PeerState{MemberID: mem.cfg.MemberID, Generation: mem.state.Assignment.Generation,
		Primary: mem.state.Assignment.PrimaryMemberID}
	if len(mem.state.Assignment.Signature) > 0 {
		assignment := mem.state.Assignment
		state.Assignment = &assignment
	}
	if stater, ok := mem.engine.(PeerStater); ok {
		state.Engine = stater.PeerEngineState()
	}
	return state, true
}
