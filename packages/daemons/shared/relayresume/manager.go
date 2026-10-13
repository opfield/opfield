package relayresume

import (
	"context"
	crand "crypto/rand"
	"errors"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Dialer opens a new tunnel for a source session's route: on the best
// candidate of the route's current assignment, each within OpenTimeout.
type Dialer func(ctx context.Context, request DialRequest) (OpenedPath, error)

// DialRequest is what a new path is for.
type DialRequest struct {
	// Avoid is a relay the stream has to leave: it failed the stream's path,
	// its lane got GOAWAY, or it left (or drains in) the assignment. The
	// dialer tries it last, only when no other relay takes the stream. ""
	// when the stream may stay on its relay: a planned move to the best path
	// (a new assignment generation, a target's drain hint, the return to the
	// nearest relay).
	Avoid string
	// FromRelay and FromGeneration name the path a planned move leaves (the
	// generation is the driver's label, OpenedPath.Generation; 0 unknown).
	// A dialer whose best path is that same path answers ErrStay.
	FromRelay      string
	FromGeneration uint64
	// NewPath: the move leaves the connection the path runs on (TriggerLane):
	// the dialer opens a new path even when the relay and generation stay.
	NewPath bool
}

// ErrStay is a dialer's answer to a planned move when the stream's current
// path is already the best one: the move ends and the stream stays.
var ErrStay = errors.New("relayresume: the current path is the best one")

// SourceConfig configures a source session.
type SourceConfig struct {
	RouteID string
	// Key returns the route key of the latest bundle; every RESUME is signed
	// with it (rotation). ok=false: the route is no longer resumable.
	Key              func() (keyID string, key []byte, ok bool)
	HalfCloseTimeout time.Duration
	Dial             Dialer
	// Wake, if set, returns a channel that closes when a relay path may have
	// become available (a relay transport got ready, the assignment
	// changed): a migration attempt that failed retries then instead of
	// waiting out its backoff. Streams a daemon took over from its previous
	// process fail their first attempts until the new process's relay
	// connections are up; with the backoff alone (250 ms, 500 ms, 1 s) a
	// pause grew from 0.4 s to 1.0-1.2 s whenever they took longer than the
	// first step (stand rc.10 O-6: four nodes updated at once).
	Wake func() <-chan struct{}
	// Tag is the caller's (owner kind and id, for logs).
	Tag any
}

// Trigger names why a stream migrated.
type Trigger string

const (
	TriggerDrain       Trigger = "drain"
	TriggerGoAway      Trigger = "goaway"
	TriggerPathFailure Trigger = "path_failure"
	TriggerTargetHint  Trigger = "target_hint"
	// TriggerRegrant re-paths a stream whose assignment generation drains
	// while its relay stays in the new one: onto the same relay under the
	// new grant, unless another relay is now the better path.
	TriggerRegrant Trigger = "regrant"
	// TriggerReturn moves a stream from a standby or farther relay back to
	// the nearest one.
	TriggerReturn Trigger = "return"
	// TriggerLane moves a stream to a new path because the connection its
	// path runs on is replaced (its TCP state learned a path that changed).
	// Housekeeping: not counted as a migration.
	TriggerLane Trigger = "lane"
)

// MigrationEvent reports one finished migration attempt series (logs,
// metrics).
type MigrationEvent struct {
	Session *Session
	Trigger Trigger
	OK      bool
	From    string
	To      string
	Stall   time.Duration
	Err     error
}

// Manager is the process-wide source side: the registry of resumable
// streams, the migration workers (at most MaxMigrationsInFlight at a time),
// the legacy latch and the counters reported to Opfield.
type Manager struct {
	budget *WindowBudget
	slots  chan struct{}

	mu       sync.Mutex
	sessions map[*Session]struct{}
	legacy   map[string]legacyLatch
	routeKey map[string]string // last applied resume key id per route ("" absent)
	legacyBy map[string]int    // live legacy streams per relay
	stalls   []time.Duration
	stallPos int

	// OnMigration observes migrations (optional; called without locks held).
	OnMigration func(MigrationEvent)
	// OnEnd observes resumable streams that ended (optional).
	OnEnd func(s *Session, err error)
	// MigrateRequestDeadline paces a target's drain hint (MIGRATE_REQ drain):
	// the time the stream must leave relayID by (optional; called with the
	// session locked, so it must not call into the session).
	MigrateRequestDeadline func(relayID string, tag any) time.Time

	migrationsOK     atomic.Uint64
	migrationsFailed atomic.Uint64
	laneMoves        atomic.Uint64
	cut              atomic.Uint64
	retransmitted    atomic.Uint64
	// exiting: the process exits (BeginExit); a stream it ends from now on
	// is cut by the exit.
	exiting atomic.Bool
}

// NewManager creates the source side of a process.
func NewManager(budget *WindowBudget) *Manager {
	if budget == nil {
		budget = NewWindowBudget(0)
	}
	return &Manager{budget: budget, slots: make(chan struct{}, MaxMigrationsInFlight), sessions: map[*Session]struct{}{},
		legacy: map[string]legacyLatch{}, legacyBy: map[string]int{}, routeKey: map[string]string{}}
}

// Budget is the process window budget (shared with the target table).
func (m *Manager) Budget() *WindowBudget { return m.budget }

type sourceState struct {
	mgr       *Manager
	cfg       SourceConfig
	migrating bool
	trigger   Trigger
	stalled   time.Time // the stream stopped carrying data (its path failed, or a planned move stopped it)
	movedAt   time.Time // the last move that succeeded
	ended     bool
	// deferred is a planned move that arrived while the stream could not
	// start one (handshake, a migration running): it starts once it can,
	// unless the stream left that relay (or that path) meanwhile.
	deferred *plannedMove
}

// plannedMove is a move off the relay avoid (it has to be left), or, with
// avoid empty, off the path from to the best path of the assignment, which
// may be the same relay under a newer grant.
type plannedMove struct {
	trigger Trigger
	avoid   string
	from    *Path
	at      time.Time
	// newPath: DialRequest.NewPath.
	newPath bool
}

// stale reports a move whose stream already left what it was asked to leave.
func (move plannedMove) stale(current *Path) bool {
	if current == nil {
		return false
	}
	if move.avoid != "" {
		return current.RelayID() != move.avoid
	}
	return move.from != nil && current != move.from
}

// requestLocked starts a planned move at at, or keeps it for later (mu
// held). A move off a relay outranks a move to the best path.
func (st *sourceState) requestLocked(s *Session, move plannedMove) {
	c := s.core
	if s.detached || (move.avoid == "" && move.from == nil) {
		return
	}
	if st.migrating || !c.CanResume() || c.Current() == nil {
		deferred := st.deferred
		if deferred == nil || (move.avoid != "" && deferred.avoid == "") ||
			((move.avoid == "") == (deferred.avoid == "") && move.at.Before(deferred.at)) {
			st.deferred = &move
		}
		return
	}
	if move.stale(c.Current()) {
		return // already elsewhere
	}
	st.start(s, move.trigger, false, move, move.at)
}

// NewSource starts a resumable stream on first (HELLO, then data at once).
func (m *Manager) NewSource(cfg SourceConfig, first OpenedPath) (*Session, error) {
	keyID, key, ok := cfg.Key()
	if !ok || !validKeyID(keyID) || len(key) == 0 {
		return nil, errors.New("relayresume: route has no resume key")
	}
	var sid [SessionIDLen]byte
	if _, err := crand.Read(sid[:]); err != nil {
		return nil, err
	}
	path := NewPath(nil, first.RelayID, first.MaxFrame)
	core := NewSource(Config{RouteID: cfg.RouteID, KeyID: keyID, Key: key, SessionID: sid, HalfCloseTimeout: cfg.HalfCloseTimeout, Budget: m.budget}, path, time.Now())
	s := newSession(core, cfg.RouteID, first.MaxFrame)
	s.source = &sourceState{mgr: m, cfg: cfg}
	m.mu.Lock()
	m.sessions[s] = struct{}{}
	m.mu.Unlock()
	s.mu.Lock()
	s.attach(path, first)
	s.afterLocked(false)
	s.mu.Unlock()
	return s, nil
}

// RestoreSource takes over a source stream another process handed over
// (SessionState of RoleSource): suspended, it looks for a path at once, within
// UnplannedBudget of its freeze, and RESUMEs on it as after a path failure. cfg
// is the stream's configuration in this process: its Key must answer for the
// route (else the route was revoked meanwhile and the stream is not taken).
func (m *Manager) RestoreSource(cfg SourceConfig, st *SessionState) (*Session, error) {
	if st.Role != RoleSource || st.RouteID != cfg.RouteID {
		return nil, errors.New("relayresume: not a source stream of this route")
	}
	keyID, key, ok := cfg.Key()
	if !ok || !validKeyID(keyID) || len(key) == 0 {
		return nil, ErrRevoked
	}
	now := time.Now()
	core, err := restoreCore(Config{Budget: m.budget}, st, now)
	if err != nil {
		return nil, err
	}
	core.keyID, core.key = keyID, key
	cfg.HalfCloseTimeout = st.HalfCloseTimeout
	s := newSession(core, cfg.RouteID, st.MaxFrame)
	s.partial = append([]byte(nil), st.Unwritten...)
	s.restoredFrozenAt = core.suspendDeadline.Add(-UnplannedBudget)
	s.source = &sourceState{mgr: m, cfg: cfg, stalled: s.restoredFrozenAt}
	m.mu.Lock()
	m.sessions[s] = struct{}{}
	m.mu.Unlock()
	s.mu.Lock()
	s.afterLocked(false)
	s.mu.Unlock()
	return s, nil
}

// forget drops a stream another process took over, without counting it.
func (m *Manager) forget(s *Session) {
	m.mu.Lock()
	delete(m.sessions, s)
	m.mu.Unlock()
}

// Tag is the SourceConfig tag (source) or the Establish tag (target).
func (s *Session) Tag() any {
	if s.source == nil {
		return s.tag
	}
	return s.source.cfg.Tag
}

// RequestMigrate asks the source of a target session to move (MIGRATE_REQ;
// see Core.RequestMigrate) and reports whether the request was sent.
func (s *Session) RequestMigrate(reason byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.detached {
		return false
	}
	sent := s.core.RequestMigrate(reason)
	s.afterLocked(false)
	return sent
}

// observeLocked runs after every session event (mu held): it starts the
// unplanned migration loop, answers MIGRATE_REQ and ends the bookkeeping.
func (st *sourceState) observeLocked(s *Session) {
	c := s.core
	if s.detached {
		return
	}
	if c.State().Terminal() {
		if !st.ended {
			st.ended = true
			go st.mgr.ended(s, c.Err(), c.Retransmitted)
		}
		return
	}
	if reason, ok := c.TakeMigrateRequest(); ok && c.Current() != nil {
		if reason == MigrateLane {
			// The target's connection under the path is replaced: a new path
			// on the same relay, like a move off the source's own lane.
			if c.State() == StateOpen {
				st.requestLocked(s, plannedMove{trigger: TriggerLane, from: c.Current(), at: time.Now(), newPath: true})
			}
			return
		}
		if reason == MigrateDrain {
			// The target's candidate drains: the source moves to the best
			// path of its own assignment, which leaves a relay that drains
			// and keeps one that stays (under its newer grant). A drain hint
			// is paced like the source's own drain.
			at := time.Now()
			if hook := st.mgr.MigrateRequestDeadline; hook != nil {
				at = pacedStart(hook(c.Current().RelayID(), st.cfg.Tag))
			}
			st.requestLocked(s, plannedMove{trigger: TriggerTargetHint, from: c.Current(), at: at})
			return
		}
		st.requestLocked(s, plannedMove{trigger: TriggerTargetHint, avoid: c.Current().RelayID(), at: time.Now()})
		return
	}
	if c.NeedsPath() && !st.migrating {
		st.start(s, TriggerPathFailure, true, plannedMove{}, time.Time{})
		return
	}
	if d := st.deferred; d != nil && !st.migrating && c.CanResume() && c.Current() != nil {
		st.deferred = nil
		st.requestLocked(s, *d)
	}
}

// start hands the session to a migration worker (mu held). An unplanned
// move starts when the stream's path failed, so its stall starts now; a
// planned one keeps carrying data on its path until the move stops it
// (attempt), after its paced start.
func (st *sourceState) start(s *Session, trigger Trigger, unplanned bool, move plannedMove, at time.Time) {
	st.migrating = true
	st.trigger = trigger
	if unplanned {
		st.markStalled()
	}
	go st.mgr.migrate(s, trigger, unplanned, move, at)
}

// markStalled notes when the stream stopped carrying data, unless it already
// stood still (mu held).
func (st *sourceState) markStalled() {
	if st.stalled.IsZero() {
		st.stalled = time.Now()
	}
}

func (m *Manager) ended(s *Session, err error, retransmitted uint64) {
	m.mu.Lock()
	delete(m.sessions, s)
	m.mu.Unlock()
	m.retransmitted.Add(retransmitted)
	if err != nil && (isCut(err) || (m.exiting.Load() && endedByThisSide(err))) {
		m.cut.Add(1)
	}
	if errors.Is(err, ErrLegacyPeer) {
		s.mu.Lock()
		keyID := s.core.keyID
		s.mu.Unlock()
		m.MarkLegacyKey(s.routeID, keyID)
	}
	if m.OnEnd != nil {
		m.OnEnd(s, err)
	}
}

// BeginExit marks the process's exit (a stop, a restart of its unit, an
// update): the streams it ends from now on (its drain) and the ones it still
// carries when it exits (ExitCut) are cut by the exit, unless the next process
// took them over.
func (m *Manager) BeginExit() { m.exiting.Store(true) }

// ExitCut is the cut total once the process exits now: what it counted, and
// every stream it still carries, which the exit ends.
func (m *Manager) ExitCut() uint64 {
	m.mu.Lock()
	live := len(m.sessions)
	m.mu.Unlock()
	return m.cut.Load() + uint64(live)
}

// CarryCut adds the cut total of the daemon's previous process (ExitCut) to
// this one's: the total counts the streams the daemon lost across its
// restarts, a launcher crash's included (stand rc.7 O-5), not since this
// process started.
func (m *Manager) CarryCut(n uint64) { m.cut.Add(n) }

// endedByThisSide reports a stream this process reset itself (its socket
// closed, its drain): during the exit, that is the exit's cut.
func endedByThisSide(err error) bool {
	var reset *ResetError
	return errors.As(err, &reset) && !reset.Remote && !errors.Is(err, ErrHandedOver)
}

// isCut reports a resumable stream that ended because it could not move:
// not a local or peer socket decision.
func isCut(err error) bool {
	var reset *ResetError
	if !errors.As(err, &reset) || reset.Remote {
		return false
	}
	return reset.Reject != 0 || errors.Is(err, ErrSuspendTimeout) || errors.Is(err, ErrNotResumable) || errors.Is(err, ErrRevoked)
}

// migrate is one migration worker run for s.
func (m *Manager) migrate(s *Session, trigger Trigger, unplanned bool, move plannedMove, at time.Time) {
	if wait := time.Until(at); wait > 0 {
		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-s.done:
			timer.Stop()
		}
	}
	select {
	case m.slots <- struct{}{}:
	case <-s.done:
	}
	defer func() {
		select {
		case <-m.slots:
		default:
		}
	}()
	from := s.RelayID()
	ok, to, err := m.attempts(s, unplanned, move)
	s.mu.Lock()
	st := s.source
	stall := time.Duration(0)
	if ok && !st.stalled.IsZero() {
		stall = time.Since(st.stalled)
	}
	if ok || s.core.State() == StateOpen {
		st.stalled = time.Time{}
	}
	if ok {
		st.movedAt = time.Now()
	}
	st.migrating = false
	// A planned move that left the stream without a path: the unplanned
	// loop takes over.
	st.observeLocked(s)
	s.mu.Unlock()
	switch {
	case trigger == TriggerLane:
		// Housekeeping, not a migration a user would see.
		if ok {
			m.laneMoves.Add(1)
		}
	case ok:
		m.migrationsOK.Add(1)
		m.recordStall(stall)
	case err != nil:
		m.migrationsFailed.Add(1)
	}
	if m.OnMigration != nil && (ok || err != nil) {
		m.OnMigration(MigrationEvent{Session: s, Trigger: trigger, OK: ok, From: from, To: to, Stall: stall, Err: err})
	}
}

// attempts tries until the stream moved, the budget ran out or the stream
// ended. Planned: within PlannedBudget, staying on the old path on failure
// (or when the dialer finds it is the best one, ErrStay). Unplanned: until
// the core's suspend deadline (UnplannedBudget).
func (m *Manager) attempts(s *Session, unplanned bool, move plannedMove) (bool, string, error) {
	deadline := time.Now().Add(PlannedBudget)
	if unplanned {
		deadline = time.Now().Add(UnplannedBudget + time.Second)
	}
	backoff := UnplannedBackoffMin
	var lastErr error
	for time.Now().Before(deadline) {
		s.mu.Lock()
		// A stream read out for a handover begins no move (Session.sealed):
		// the next process resumes it, or this one once it thaws.
		for s.sealed && !s.detached && !s.core.State().Terminal() {
			s.stateCond.Wait()
		}
		state := s.core.State()
		canResume := s.core.CanResume() && !s.detached
		current := s.core.Current()
		lost := s.core.LostRelay()
		var currentGeneration uint64
		if run := s.runOf(current); current != nil && run != nil {
			currentGeneration = run.op.Generation
		}
		s.mu.Unlock()
		if state.Terminal() {
			return false, "", lastErr
		}
		if !canResume {
			return false, "", lastErr
		}
		if !unplanned && (current == nil || move.stale(current)) {
			if current == nil {
				// The old path died meanwhile: carry on unplanned.
				unplanned = true
				deadline = time.Now().Add(UnplannedBudget + time.Second)
				s.mu.Lock()
				s.source.markStalled()
				s.mu.Unlock()
				continue
			}
			return false, "", nil // already moved
		}
		request := DialRequest{Avoid: move.avoid}
		switch {
		case request.Avoid != "":
		case current == nil:
			// Unplanned: the relay that just failed goes last (the dialers
			// still try it when nothing else takes the stream).
			request.Avoid = lost
		case move.from == nil:
			request.Avoid = current.RelayID()
		}
		if !unplanned && current != nil {
			request.FromRelay, request.FromGeneration = current.RelayID(), currentGeneration
			request.NewPath = move.newPath
		}
		// Taken before the attempt, so a path that comes up while it fails
		// is not missed.
		var wake <-chan struct{}
		if s.source.cfg.Wake != nil {
			wake = s.source.cfg.Wake()
		}
		ok, to, err := m.attempt(s, unplanned, request)
		if ok {
			return true, to, nil
		}
		if errors.Is(err, ErrStay) && !unplanned {
			return false, "", nil
		}
		lastErr = err
		timer := time.NewTimer(backoff + time.Duration(rand.Int64N(int64(backoff/4)+1)))
		select {
		case <-timer.C:
		case <-wake:
			timer.Stop()
		case <-s.done:
			timer.Stop()
			return false, "", lastErr
		}
		backoff = min(backoff*2, UnplannedBackoffMax)
	}
	if lastErr == nil {
		lastErr = errors.New("relayresume: migration budget exhausted")
	}
	return false, "", lastErr
}

var errNotResumableNow = errors.New("relayresume: stream cannot resume now")

// attempt opens one path and runs one RESUME exchange on it.
func (m *Manager) attempt(s *Session, unplanned bool, request DialRequest) (bool, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), OpenTimeout*3)
	defer cancel()
	go func() {
		select {
		case <-s.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	op, err := s.source.cfg.Dial(ctx, request)
	if err != nil {
		return false, "", err
	}
	s.mu.Lock()
	if s.detached || s.sealed || !s.core.CanResume() || (!unplanned && s.core.Current() == nil && s.core.State() == StateOpen) {
		s.mu.Unlock()
		if op.Cancel != nil {
			op.Cancel()
		}
		return false, "", errNotResumableNow
	}
	if keyID, key, ok := s.source.cfg.Key(); ok {
		s.core.SetKey(keyID, key)
	}
	path := NewPath(nil, op.RelayID, op.MaxFrame)
	s.attach(path, op)
	// BeginResume stops a planned move's stream on its path: its stall starts
	// here, not when the move was requested (the paced wait and the dial
	// carried data as before). An unplanned one stood still since its path
	// failed.
	planned := s.core.Current() != nil
	if !s.core.BeginResume(path, time.Now()) {
		s.core.DropPath(path)
		s.afterLocked(false)
		s.mu.Unlock()
		return false, "", errNotResumableNow
	}
	s.source.markStalled()
	s.afterLocked(false)
	for s.core.Pending() == path && !s.core.State().Terminal() && !s.detached {
		s.stateCond.Wait()
	}
	ok := s.core.Current() == path
	err = nil
	if !ok {
		err = s.core.Err()
		if err == nil {
			err = errors.New("relayresume: resume attempt failed")
		}
		if planned && s.core.State() == StateOpen {
			// Back on its old path, carrying data again until the next attempt.
			s.source.stalled = time.Time{}
		}
	}
	s.mu.Unlock()
	return ok, op.RelayID, err
}

// pacedStart is when a paced move starts: uniformly before deadline, but
// within DefaultDrainSpreadTime. A long drain grace exists for raw streams
// that cannot move; a resumable stream leaves early, so a forced end of the
// drain finds none (zero deadline: within a second).
func pacedStart(deadline time.Time) time.Time {
	spread := min(time.Until(deadline), DefaultDrainSpreadTime)
	if spread <= 0 {
		spread = time.Second
	}
	return time.Now().Add(time.Duration(rand.Int64N(int64(spread))))
}

// Migrate moves s off its relay, paced: the attempt starts at a random time
// before deadline (zero deadline: within a second). Planned: the stream
// stays where it is if no other relay takes it.
func (m *Manager) Migrate(s *Session, trigger Trigger, deadline time.Time) {
	at := pacedStart(deadline)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil || s.core.Current() == nil {
		return // suspended: the unplanned loop picks a relay anyway
	}
	s.source.requestLocked(s, plannedMove{trigger: trigger, avoid: s.core.Current().RelayID(), at: at})
}

// Repath moves s off its current path to the best path of its assignment at
// at: the same relay under a newer grant when that relay stays, a nearer
// relay for TriggerReturn. Planned: the stream stays where it is when the
// dialer finds nothing better (ErrStay) or no path opens.
func (m *Manager) Repath(s *Session, trigger Trigger, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil || s.core.Current() == nil {
		return
	}
	s.source.requestLocked(s, plannedMove{trigger: trigger, from: s.core.Current(), at: at})
}

// MoveOffLane moves s to a new path at once, on the same relay when that one
// stays the best, because the connection its path runs on is replaced
// (TriggerLane). Planned: the stream stays where it is when no path opens.
func (m *Manager) MoveOffLane(s *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// A stream still opening (its HELLO not answered) stays where it is, like the lane's raw tunnels: the old lane
	// carries it until it ends.
	if s.source == nil || s.core.Current() == nil || s.core.State() != StateOpen {
		return
	}
	s.source.requestLocked(s, plannedMove{trigger: TriggerLane, from: s.core.Current(), at: time.Now(), newPath: true})
}

// DrainRelay moves every resumable stream off relayID, spread until
// deadline.
func (m *Manager) DrainRelay(relayID string, deadline time.Time) {
	for _, s := range m.Sessions() {
		if s.RelayID() == relayID {
			m.Migrate(s, TriggerDrain, deadline)
		}
	}
}

// RelayLost moves every resumable stream off relayID at once (its lane got
// GOAWAY: the relay stops within seconds).
func (m *Manager) RelayLost(relayID string) {
	for _, s := range m.Sessions() {
		if s.RelayID() != relayID {
			continue
		}
		s.mu.Lock()
		if s.source != nil {
			s.source.requestLocked(s, plannedMove{trigger: TriggerGoAway, avoid: relayID,
				at: time.Now().Add(time.Duration(rand.Int64N(int64(100 * time.Millisecond))))})
		}
		s.mu.Unlock()
	}
}

// Sessions is a snapshot of the live resumable source streams.
func (m *Manager) Sessions() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Session, 0, len(m.sessions))
	for s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// Legacy reports a route latched to raw streams (its target answered a
// HELLO with something else).
func (m *Manager) Legacy(routeID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	latch, ok := m.legacy[routeID]
	if ok && time.Now().After(latch.until) {
		delete(m.legacy, routeID)
		return false
	}
	return ok
}

type legacyLatch struct {
	until time.Time
	keyID string // the key the refused HELLO carried ("" unknown)
}

// MarkLegacy latches routeID to raw streams for LegacyLatch.
func (m *Manager) MarkLegacy(routeID string) { m.MarkLegacyKey(routeID, "") }

// MarkLegacyKey latches routeID to raw streams for LegacyLatch, noting the
// key the refused HELLO carried: a bundle with another key clears it.
func (m *Manager) MarkLegacyKey(routeID, keyID string) {
	m.mu.Lock()
	m.legacy[routeID] = legacyLatch{until: time.Now().Add(LegacyLatch), keyID: keyID}
	m.mu.Unlock()
}

// NoteRouteKey records the resume key id an applied bundle gives routeID
// ("" when the route has none). A key id other than the one the latched
// HELLO carried, or other than the last one applied (absent → present
// included), clears the route's legacy latch: Opfield turned the route on
// again for a target that is resume-aware now.
func (m *Manager) NoteRouteKey(routeID, keyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, seen := m.routeKey[routeID]
	m.routeKey[routeID] = keyID
	if keyID == "" {
		return
	}
	latch, latched := m.legacy[routeID]
	if latched && ((latch.keyID != "" && latch.keyID != keyID) || (seen && last != keyID)) {
		delete(m.legacy, routeID)
	}
}

// ForgetRoutes drops the recorded keys of routes keep refuses (gone from
// the bundle).
func (m *Manager) ForgetRoutes(keep func(routeID string) bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for routeID := range m.routeKey {
		if !keep(routeID) {
			delete(m.routeKey, routeID)
		}
	}
}

// TrackLegacy counts a raw (not resumable) stream through relayID until the
// returned func is called.
func (m *Manager) TrackLegacy(relayID string) func() {
	m.mu.Lock()
	m.legacyBy[relayID]++
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			if m.legacyBy[relayID]--; m.legacyBy[relayID] <= 0 {
				delete(m.legacyBy, relayID)
			}
			m.mu.Unlock()
		})
	}
}

func (m *Manager) recordStall(stall time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.stalls) < 256 {
		m.stalls = append(m.stalls, stall)
		return
	}
	m.stalls[m.stallPos] = stall
	m.stallPos = (m.stallPos + 1) % len(m.stalls)
}

// SourceStats are the source-side counters (each stream counted once, at
// the daemon that opened it).
type SourceStats struct {
	Resumable        uint64
	Legacy           uint64
	Suspended        uint64
	MigrationsOK     uint64
	MigrationsFailed uint64
	// LaneMoves counts moves off a replaced connection (TriggerLane).
	LaneMoves          uint64
	Cut                uint64
	Retransmitted      uint64
	Unacked            uint64
	StallP50, StallP95 time.Duration
	ByRelay            map[string][2]uint64 // relay -> {resumable, legacy}
}

// Stats snapshots the counters.
func (m *Manager) Stats() SourceStats {
	stats := SourceStats{ByRelay: map[string][2]uint64{}, MigrationsOK: m.migrationsOK.Load(), MigrationsFailed: m.migrationsFailed.Load(), LaneMoves: m.laneMoves.Load(),
		Cut: m.cut.Load(), Retransmitted: m.retransmitted.Load()}
	sessions := m.Sessions()
	for _, s := range sessions {
		s.mu.Lock()
		stats.Resumable++
		stats.Unacked += s.core.Unacked()
		stats.Retransmitted += s.core.Retransmitted
		state := s.core.State()
		relay := ""
		if p := s.core.Current(); p != nil {
			relay = p.RelayID()
		}
		s.mu.Unlock()
		if state == StateSuspended || state == StateResuming {
			stats.Suspended++
		}
		if relay != "" {
			entry := stats.ByRelay[relay]
			entry[0]++
			stats.ByRelay[relay] = entry
		}
	}
	m.mu.Lock()
	for relay, n := range m.legacyBy {
		stats.Legacy += uint64(n)
		entry := stats.ByRelay[relay]
		entry[1] += uint64(n)
		stats.ByRelay[relay] = entry
	}
	stalls := slices.Clone(m.stalls)
	m.mu.Unlock()
	if len(stalls) > 0 {
		slices.Sort(stalls)
		stats.StallP50 = stalls[len(stalls)/2]
		stats.StallP95 = stalls[min(len(stalls)-1, len(stalls)*95/100)]
	}
	return stats
}
