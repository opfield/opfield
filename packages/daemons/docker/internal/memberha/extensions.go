package memberha

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

// Optional engine extensions. An engine implements Engine; it may also
// implement any of the interfaces below when its rules need more than the
// framework's defaults (Postgres implements all of them). An engine that
// implements none runs exactly as before.

// Reconfigurer takes a newer configuration of its member (Gateway's
// configure), before the runtime acts on it.
type Reconfigurer interface {
	Reconfigure(config Config) error
}

// HolderView is what the promoted, serving holder's engine sees each step.
type HolderView struct {
	// Certified is the certified value; Pending the value of the transition
	// in flight (nil without one). Configure the engine for both (AS5).
	Certified []byte
	Pending   []byte
	Status    EngineStatus
	Now       time.Duration
	// Free: no transition is in flight (NextValue runs right after).
	Free bool
}

// HolderWorker returns engine work the promoted, serving holder must run now
// (Postgres: synchronous_standby_names ⊇ certified ∪ pending, the sync
// barrier, replication slots), or ok=false. It runs on the lease loop and
// must not block; the work runs as one background operation.
type HolderWorker interface {
	HolderWork(view HolderView) (name string, work func(ctx context.Context) error, ok bool)
}

// CopyWorker returns work of a running copy that follows the primary (slot
// upkeep, dropping a data directory a rebuild kept), or ok=false.
type CopyWorker interface {
	CopyWork(status EngineStatus, now time.Duration) (name string, work func(ctx context.Context) error, ok bool)
}

// CertifiedChecker reports false when the certified value no longer
// describes the promoted engine (Postgres: a re-promotion after a restart
// moved it to a new timeline); the holder stops serving and certifies again
// (M3).
type CertifiedChecker interface {
	CertifiedCurrent(certified []byte, status EngineStatus) bool
}

// PendingPromoter is Promote that also sees the pending transition's value
// (Postgres: the synchronous names must cover certified ∪ pending before
// the promotion, M4).
type PendingPromoter interface {
	PromoteWithPending(ctx context.Context, certified, pending []byte) error
}

// EventSource hands engine events (rewinds, sync changes, ...) to the
// runtime's durable event queue; an event's AtUnixMs is kept when set.
type EventSource interface {
	DrainEvents() []Event
}

// RejoinPlanner reports that a stopped member must rejoin before it may
// start at all (no data yet: seed; a rewind that failed part-way: rebuild,
// never start that directory). The copy path then runs Rejoin instead of a
// start once a primary is known.
type RejoinPlanner interface {
	RejoinNeeded() bool
}

// SwitchoverPreparer prepares a planned handoff on the lease loop before the
// holder stops (Postgres, synchronous durability: the successor becomes the
// certified sync member first, AS11). PrepareSwitchover names the successor
// ("" cancels); the engine's HolderWork and NextValue work toward it, and the
// release runs once SwitchoverReady holds with no transition in flight.
type SwitchoverPreparer interface {
	PrepareSwitchover(successorMemberID string)
	SwitchoverReady(certified []byte, successorMemberID string) bool
}

// ForcedValuer is the value a forced promotion of this member certifies
// (AS10: the forced flag and the fork position).
type ForcedValuer interface {
	ForcedValue(operationID string, status EngineStatus) ([]byte, error)
}

// Optional lease abilities (the protocol node has them; test fakes may not).
type (
	ForceRequest = availabilitylease.ForceRequest
	ForceStatus  = availabilitylease.ForceStatus
)

type pendingLease interface {
	PendingState(key Key) (PendingTransition, bool)
}

type forceLease interface {
	ForceAcquire(key Key, request ForceRequest) error
	ForceStatus(key Key) ForceStatus
}

// switchoverStageTimeout bounds a staged switchover before it stops writes.
const switchoverStageTimeout = 60 * time.Second

type stagedSwitchover struct {
	successor   Peer
	operationID string
	deadline    time.Duration
}

// DetachState records a detach before the first holder (H2).
type DetachState struct {
	OperationID   string `json:"operationId"`
	StartedUnixMs int64  `json:"startedUnixMs"`
}

// DetachEvidence is Gateway's side of a detach.
type DetachEvidence struct {
	// NeverHeld: Gateway never observed a holder of the set's lease.
	NeverHeld bool
	// SeededMemberIDs: the members Gateway prepared besides this one; a
	// detach needs none.
	SeededMemberIDs []string
}

// RestartRequest is a restart Gateway asked for.
type RestartRequest struct {
	OperationID  string `json:"operationId"`
	AllowPrimary bool   `json:"allowPrimary,omitempty"`
}

// Errors of the extension operations.
var (
	ErrDetachRefused = errors.New("detach refused")
	ErrForceRefused  = errors.New("forced promotion refused")
	ErrNotRetained   = errors.New("this member is not the retained primary of its set")
	ErrRemovePrimary = errors.New("the primary of a set cannot be removed; switch over first")
)

// ----- holder and copy extras -------------------------------------------

func (m *Manager) libraryPendingLocked(key Key) bool {
	lease, ok := m.deps.Lease.(pendingLease)
	if !ok {
		return false
	}
	pending, found := lease.PendingState(key)
	return found && pending.ID != ""
}

// pendingValueLocked is the value of the transition in flight: this
// holder's own proposal, or one the library restored after a restart.
func (m *Manager) pendingValueLocked(mem *member, key Key) []byte {
	if p := mem.holder.pending; p != nil {
		return p.value
	}
	if lease, ok := m.deps.Lease.(pendingLease); ok {
		if pending, found := lease.PendingState(key); found && pending.ID != "" {
			return pending.Value
		}
	}
	return nil
}

func (m *Manager) promoteEngine(ctx context.Context, mem *member, certified, pending []byte) error {
	if promoter, ok := mem.engine.(PendingPromoter); ok {
		return promoter.PromoteWithPending(ctx, certified, pending)
	}
	return mem.engine.Promote(ctx, certified)
}

func (m *Manager) certifiedCurrentLocked(mem *member, cert CertifiedState) bool {
	checker, ok := mem.engine.(CertifiedChecker)
	return !ok || checker.CertifiedCurrent(cert.State.Value, mem.obs.status)
}

// holderExtrasLocked runs, on the promoted and serving holder, a requested
// restart, a staged switchover that became ready, or engine holder work. It
// reports whether it started something (the step ends there).
func (m *Manager) holderExtrasLocked(mem *member, status HolderStatus, cert CertifiedState, free bool, now time.Duration) bool {
	if r := mem.state.Restart; r != nil {
		if !r.AllowPrimary {
			// Gateway asked for a copy's restart; this member holds now.
			m.finishRestartLocked(mem, errors.New("the member became the primary; switch over first"))
			return false
		}
		m.restartHolderCleanLocked(mem, status)
		return true
	}
	if sw := mem.switchover; sw != nil {
		prep, _ := mem.engine.(SwitchoverPreparer)
		if free && prep != nil && prep.SwitchoverReady(cert.State.Value, sw.successor.MemberID) {
			mem.switchover = nil
			m.runSwitchoverLocked(mem, sw.successor, sw.operationID)
			return true
		}
	}
	worker, ok := mem.engine.(HolderWorker)
	if !ok {
		return false
	}
	name, work, run := worker.HolderWork(HolderView{Certified: cert.State.Value, Pending: m.pendingValueLocked(mem, mem.cfg.Key()),
		Status: mem.obs.status, Now: now, Free: free})
	if !run || work == nil {
		return false
	}
	m.launch(mem, firstReason(name, "holder_work"), opTimeout, func(ctx context.Context) func() {
		err := work(ctx)
		return func() {
			if err != nil {
				m.setErrorLocked(mem, fmt.Sprintf("%s failed: %v", firstReason(name, "holder work"), err))
			}
		}
	})
	return true
}

// manualHolderWorkLocked runs engine work of a manual pair's serving primary
// (HolderView with no certified value: Postgres keeps its synchronous names
// on the peer while it confirms).
func (m *Manager) manualHolderWorkLocked(mem *member, now time.Duration) {
	worker, ok := mem.engine.(HolderWorker)
	if !ok || mem.busy {
		return
	}
	name, work, run := worker.HolderWork(HolderView{Status: mem.obs.status, Now: now, Free: true})
	if !run || work == nil {
		return
	}
	m.launch(mem, firstReason(name, "holder_work"), opTimeout, func(ctx context.Context) func() {
		err := work(ctx)
		return func() {
			if err != nil {
				m.setErrorLocked(mem, fmt.Sprintf("%s failed: %v", firstReason(name, "holder work"), err))
			}
		}
	})
}

// copyExtrasLocked runs a requested restart or engine work of a running copy.
func (m *Manager) copyExtrasLocked(mem *member, now time.Duration) {
	if mem.state.Restart != nil {
		m.restartCopyLocked(mem)
		return
	}
	worker, ok := mem.engine.(CopyWorker)
	if !ok || !mem.obs.status.Answering {
		return
	}
	name, work, run := worker.CopyWork(mem.obs.status, now)
	if !run || work == nil {
		return
	}
	m.launch(mem, firstReason(name, "copy_work"), opTimeout, func(ctx context.Context) func() {
		err := work(ctx)
		return func() {
			if err != nil {
				m.logger.Debug("availability copy work failed", "set_id", mem.cfg.SetID, "work", name, "error", err)
			}
		}
	})
}

// stoppedNeedsRejoinLocked: a stopped member the engine must rejoin (seed,
// rebuild) before any start; it is never started meanwhile.
func (m *Manager) stoppedNeedsRejoinLocked(mem *member, now time.Duration, primaryKnown bool) bool {
	planner, ok := mem.engine.(RejoinPlanner)
	if !ok || !planner.RejoinNeeded() {
		return false
	}
	if primaryKnown && now >= mem.standby.nextRejoinAt {
		m.rejoinLocked(mem)
	}
	return true
}

func (m *Manager) drainEngineEventsLocked(mem *member) {
	source, ok := mem.engine.(EventSource)
	if !ok {
		return
	}
	for _, event := range source.DrainEvents() {
		m.eventLocked(mem, event)
	}
}

// ----- staged switchover --------------------------------------------------

func (m *Manager) stageSwitchoverLocked(mem *member, prep SwitchoverPreparer, successor Peer, operationID string) error {
	if sw := mem.switchover; sw != nil {
		if sw.operationID == operationID && sw.successor.MemberID == successor.MemberID {
			return nil
		}
		return errors.New("another switchover of this set is being prepared")
	}
	mem.switchover = &stagedSwitchover{successor: successor, operationID: operationID,
		deadline: m.deps.Clock.Now() + switchoverStageTimeout}
	prep.PrepareSwitchover(successor.MemberID)
	return nil
}

// switchoverGuardLocked ends a staged switchover that timed out or whose
// member no longer holds; nothing was stopped yet, so the holder simply goes
// on (or the new holder serves).
func (m *Manager) switchoverGuardLocked(mem *member, status HolderStatus, now time.Duration) {
	sw := mem.switchover
	if sw == nil {
		return
	}
	reason := ""
	switch {
	case status.Role != RoleHolding:
		reason = "the member no longer holds the primary role"
	case now > sw.deadline:
		reason = "the successor did not become ready in time"
	default:
		if peer, ok := mem.cfg.Peer(sw.successor.MemberID); !ok || peer.Removing {
			reason = "the successor is no longer a member"
		}
	}
	if reason == "" {
		return
	}
	mem.switchover = nil
	if prep, ok := mem.engine.(SwitchoverPreparer); ok {
		prep.PrepareSwitchover("")
	}
	m.eventLocked(mem, Event{Kind: EventSwitchoverFail, Reason: reason, OperationID: sw.operationID})
}

// ----- removal guard ------------------------------------------------------

// removableLocked refuses to remove the member that is (or may be) the
// set's primary: the holder, a retained primary of a closed set, a manual
// pair's assigned primary (B2).
func (m *Manager) removableLocked(mem *member) error {
	if mem.cfg.Mode == ModeManual {
		if mem.state.Assignment.PrimaryMemberID == mem.cfg.MemberID {
			return ErrRemovePrimary
		}
		return nil
	}
	switch m.deps.Lease.HolderStatus(mem.cfg.Key()).Role {
	case RoleHolding, RoleRecovering, RoleRetained, RoleAcquiring, RoleBootstrapping:
		return ErrRemovePrimary
	}
	return nil
}

// ----- forced promotion (AS10) -------------------------------------------

// ForceResult describes an armed or finished forced promotion.
type ForceResult struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason,omitempty"`
}

// ForcePromote arms a forced acquisition of this node's member (the operator
// accepts data loss when no copy is eligible). It skips only the eligibility
// callback: the lease still needs a strict majority of voters, the override
// is single use, bound to the newest commit ballot the operator saw and
// expires after five minutes or on any newer commit (library).
func (m *Manager) ForcePromote(setID, operationID string, over Ballot) (ForceResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	refuse := func(reason string) (ForceResult, error) {
		return ForceResult{}, fmt.Errorf("%w: %s", ErrForceRefused, reason)
	}
	switch {
	case mem == nil:
		return refuse("the set has no member on this node")
	case mem.cfg.Mode != ModeAutomatic:
		return refuse("a manual pair is switched with a primary assignment, not a forced promotion")
	case operationID == "":
		return refuse("the operation id is required")
	case over.IsZero():
		return refuse("the commit ballot the operator saw is required")
	case mem.state.Stopped || mem.state.Detached != nil:
		return refuse("the member is being removed")
	}
	lease, ok := m.deps.Lease.(forceLease)
	valuer, valueOK := mem.engine.(ForcedValuer)
	if !ok || !valueOK {
		return refuse("this member cannot be force promoted")
	}
	key := mem.cfg.Key()
	switch m.deps.Lease.HolderStatus(key).Role {
	case RoleHolding, RoleRecovering:
		return refuse("this member already holds the primary role")
	}
	now := m.deps.Clock.Now()
	switch {
	case !mem.fresh(now) || !mem.copyRunning():
		return refuse("this member does not run as a copy")
	case mem.dataBusy():
		return refuse("this member's data is being rewritten")
	case !m.watchdog.fresh:
		return refuse("the lease watchdog is not running")
	}
	value, err := valuer.ForcedValue(operationID, mem.obs.status)
	if err != nil {
		return refuse(err.Error())
	}
	if err := lease.ForceAcquire(key, ForceRequest{OperationID: operationID, Over: over, Value: value}); err != nil {
		return refuse(err.Error())
	}
	m.eventLocked(mem, Event{Kind: EventForceArmed, OperationID: operationID, Detail: map[string]string{"over": over.String()}})
	return ForceResult{OperationID: operationID, Outcome: "armed"}, nil
}

// ForceStatusOf reports the forced acquisition of this node's member.
func (m *Manager) ForceStatusOf(setID string) (ForceResult, error) {
	m.mu.Lock()
	mem := m.members[setID]
	m.mu.Unlock()
	if mem == nil {
		return ForceResult{}, errors.New("the set has no member on this node")
	}
	lease, ok := m.deps.Lease.(forceLease)
	if !ok || mem.cfg.Mode != ModeAutomatic {
		return ForceResult{Outcome: "none"}, nil
	}
	status := lease.ForceStatus(mem.cfg.Key())
	result := ForceResult{OperationID: status.OperationID, Outcome: forceOutcomeText(status.Outcome), Reason: status.Reason}
	if !status.Newer.IsZero() {
		result.Reason = firstReason(result.Reason, "a newer accepted ballot exists: "+status.Newer.String())
	}
	return result, nil
}

func forceOutcomeText(outcome availabilitylease.ForceOutcome) string {
	switch outcome {
	case availabilitylease.ForcePending:
		return "armed"
	case availabilitylease.ForceAcquired:
		return "acquired"
	case availabilitylease.ForceExpired:
		return "expired"
	case availabilitylease.ForceSuperseded:
		return "superseded"
	}
	return "none"
}

// ----- detach before the first holder (H2) and lift after a close -------

// Detach returns an origin to a single-node resource when no commit of the
// set's lease can exist: Gateway never saw a holder and seeded no other
// member, this member never held, its lease role is idle and it knows no
// commit or pending transition. Candidacy stops before the checks, so no
// bootstrap starts meanwhile; on refusal it is restored. From then on the
// member takes no lease role; the daemon returns the resource to single node
// and calls Forget. A repeat after the detach began succeeds.
func (m *Manager) Detach(setID, operationID string, evidence DetachEvidence) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return errors.New("the set has no member on this node")
	}
	if mem.state.Detached != nil {
		return nil
	}
	refuse := func(reason string) error { return fmt.Errorf("%w: %s", ErrDetachRefused, reason) }
	others := 0
	for _, id := range evidence.SeededMemberIDs {
		if id != "" && id != mem.cfg.MemberID {
			others++
		}
	}
	switch {
	case !evidence.NeverHeld:
		return refuse("Gateway observed a holder of the set's lease")
	case others > 0:
		return refuse("other members were prepared")
	case mem.state.Held:
		return refuse("this member held the primary role")
	case mem.busy:
		return refuse("the member is busy; retry")
	}
	if mem.cfg.Mode == ModeAutomatic {
		key := mem.cfg.Key()
		m.deps.Lease.SetCandidateReady(mem.cfg.LeasePolicyID, false)
		mem.ready = false
		m.deps.Lease.SetStateHandler(mem.cfg.LeasePolicyID, nil)
		reason := ""
		if status := m.deps.Lease.HolderStatus(key); status.Role != RoleNone && status.Role != RoleCandidate {
			reason = "the lease role on this node is " + status.Role.String()
		} else if _, ok := m.deps.Lease.CommittedState(key); ok {
			reason = "a commit of the lease exists"
		} else if _, ok := m.deps.Lease.ObservedCommit(key); ok {
			reason = "a commit of the lease was observed"
		} else if m.libraryPendingLocked(key) {
			reason = "a lease transition is pending"
		}
		if reason != "" {
			m.registerHandlerLocked(mem)
			return refuse(reason)
		}
	}
	mem.state.Detached = &DetachState{OperationID: operationID, StartedUnixMs: m.deps.Clock.Wall().UnixMilli()}
	if err := m.saveLocked(mem); err != nil {
		mem.state.Detached = nil
		if mem.cfg.Mode == ModeAutomatic {
			m.registerHandlerLocked(mem)
		}
		return refuse("the detach could not be persisted: " + err.Error())
	}
	m.eventLocked(mem, Event{Kind: EventDetached, OperationID: operationID})
	return nil
}

// LiftCheck says whether this node's member may become the single-node
// resource of its set now: a retained primary of a closed set (a majority
// of voters confirmed the close to it, so no member can acquire any more), a
// manual pair's assigned primary whose peer was removed, or a detached
// origin. primaryRunning reports whether its engine runs writable. Call it
// under Hold.
func (m *Manager) LiftCheck(setID, memberID string) (primaryRunning bool, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil || mem.cfg.MemberID != memberID {
		return false, errors.New("the set has no such member on this node")
	}
	primaryRunning = mem.primaryRunning()
	switch {
	case mem.state.Detached != nil:
		return primaryRunning, nil
	case mem.cfg.Mode == ModeManual:
		if mem.state.Assignment.PrimaryMemberID != mem.cfg.MemberID || len(mem.cfg.Others()) > 0 {
			return false, fmt.Errorf("%w: a manual pair lifts its assigned primary once the other member is gone", ErrNotRetained)
		}
		return primaryRunning, nil
	}
	if role := m.deps.Lease.HolderStatus(mem.cfg.Key()).Role; role != RoleRetained {
		return false, fmt.Errorf("%w (lease role %s)", ErrNotRetained, role)
	}
	return primaryRunning, nil
}

// ----- restarts (settings that need one, M4) -----------------------------

// RestartMember asks for a restart of this node's member with its current
// configuration. A holder restarts only with allowPrimary (normally Gateway
// switches over first): serving closes, the record stays armed, a clean
// stop, standby at rest, a start, and the holder path promotes again.
func (m *Manager) RestartMember(setID, operationID string, allowPrimary bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mem := m.members[setID]
	if mem == nil {
		return errors.New("the set has no member on this node")
	}
	if r := mem.state.Restart; r != nil && r.OperationID == operationID {
		return nil
	}
	if !allowPrimary && m.isPrimaryLocked(mem) {
		return errors.New("the member is the primary; switch over first or allow the primary's restart")
	}
	mem.state.Restart = &RestartRequest{OperationID: operationID, AllowPrimary: allowPrimary}
	return m.saveLocked(mem)
}

func (m *Manager) isPrimaryLocked(mem *member) bool {
	if mem.cfg.Mode == ModeManual {
		return mem.state.Assignment.PrimaryMemberID == mem.cfg.MemberID || mem.primaryRunning()
	}
	switch m.deps.Lease.HolderStatus(mem.cfg.Key()).Role {
	case RoleHolding, RoleRecovering, RoleRetained:
		return true
	}
	return mem.primaryRunning()
}

func (m *Manager) finishRestartLocked(mem *member, err error) {
	r := mem.state.Restart
	if r == nil {
		return
	}
	mem.state.Restart = nil
	if err != nil {
		m.eventLocked(mem, Event{Kind: EventRestartFailed, OperationID: r.OperationID, Reason: err.Error()})
		return
	}
	m.eventLocked(mem, Event{Kind: EventRestarted, OperationID: r.OperationID})
}

func (m *Manager) restartCopyLocked(mem *member) {
	m.launch(mem, opLocalRestart, opTimeout, func(ctx context.Context) func() {
		err := m.stopConfirmed(ctx, mem, false)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil {
			err = mem.engine.Start(ctx)
		}
		return func() { m.finishRestartLocked(mem, err) }
	})
}

// restartHolderCleanLocked restarts the holder in place: the deadline record
// stays armed (it covers the new container once the next step re-arms it),
// serving closed and tunnels ended first, a clean stop, standby at rest, then
// a start only while the lease allows one.
func (m *Manager) restartHolderCleanLocked(mem *member, status HolderStatus) {
	key := mem.cfg.Key()
	m.closeServingLocked(mem)
	m.launch(mem, opLocalRestart, opTimeout, func(ctx context.Context) func() {
		m.closeServing(mem)
		err := m.stopConfirmed(ctx, mem, false)
		if err == nil {
			err = mem.engine.PrepareStandby(ctx)
		}
		if err == nil {
			if st := m.deps.Lease.HolderStatus(key); !st.MayStart {
				err = errors.New("the lease no longer allows a start")
			} else {
				err = mem.engine.Start(ctx)
			}
		}
		return func() { m.finishRestartLocked(mem, err) }
	})
	_ = status
}

// ----- signed primary assignments -----------------------------------------

// AssignmentDomain separates Gateway's assignment signatures from every other
// statement signed with the relay policy key.
const AssignmentDomain = "gateway-availability-member/primary-assignment/v1"

// AssignmentStatement is the payload Gateway signs (under AssignmentDomain,
// as domain || 0x00 || payload): the set id, the primary member id (each a
// 4-byte big endian length and the bytes) and the generation (8-byte big
// endian).
func AssignmentStatement(setID string, assignment Assignment) []byte {
	out := make([]byte, 0, 96)
	appendText := func(value string) {
		n := len(value)
		out = append(out, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
		out = append(out, value...)
	}
	appendText(setID)
	appendText(assignment.PrimaryMemberID)
	g := assignment.Generation
	out = append(out, byte(g>>56), byte(g>>48), byte(g>>40), byte(g>>32), byte(g>>24), byte(g>>16), byte(g>>8), byte(g))
	return out
}
