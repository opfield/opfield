package memberha

import (
	"context"
	"errors"
	"testing"
	"time"
)

// extEngine is the fake engine with every optional extension.
type extEngine struct {
	*fakeEngine
	rejoinNeeded bool
	holderWork   int
	copyWork     int
	events       []Event
	prepared     []string
	ready        bool
	current      bool
	forced       []byte
}

func (e *extEngine) RejoinNeeded() bool { return e.rejoinNeeded }
func (e *extEngine) Rejoin(ctx context.Context) error {
	e.rejoinNeeded = false
	return e.fakeEngine.Rejoin(ctx)
}
func (e *extEngine) HolderWork(HolderView) (string, func(context.Context) error, bool) {
	if e.holderWork == 0 {
		return "", nil, false
	}
	e.holderWork--
	return "sync_names", func(context.Context) error { e.calls.add("engine.holder_work"); return nil }, true
}
func (e *extEngine) CopyWork(EngineStatus, time.Duration) (string, func(context.Context) error, bool) {
	if e.copyWork == 0 {
		return "", nil, false
	}
	e.copyWork--
	return "slots", func(context.Context) error { e.calls.add("engine.copy_work"); return nil }, true
}
func (e *extEngine) DrainEvents() []Event {
	out := e.events
	e.events = nil
	return out
}
func (e *extEngine) PrepareSwitchover(successor string) { e.prepared = append(e.prepared, successor) }
func (e *extEngine) SwitchoverReady([]byte, string) bool {
	return e.ready
}
func (e *extEngine) CertifiedCurrent([]byte, EngineStatus) bool { return e.current }
func (e *extEngine) ForcedValue(string, EngineStatus) ([]byte, error) {
	return e.forced, nil
}

func newExtHarness(t *testing.T, mode string) (*harness, *extEngine) {
	t.Helper()
	h := newHarness(t, mode)
	ext := &extEngine{fakeEngine: h.engine, current: true}
	h.manager.mu.Lock()
	h.manager.members[testSet].engine = ext
	h.manager.mu.Unlock()
	return h, ext
}

// servingHolder brings the member to a certified, serving holder.
func servingHolder(t *testing.T, h *harness) {
	t.Helper()
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.holding(h.clock.now + time.Hour)
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v1"), Holder: testNodeA, PromotedHolder: testNodeA}}
	h.step(3, time.Second)
	if serving, _ := h.manager.MemberServing(testSet, testMemberA); !serving {
		t.Fatalf("the holder does not serve: %v", h.calls.take())
	}
	h.calls.take()
}

func TestAnUnsignedAssignmentIsRefusedFromGatewayAndFromThePeer(t *testing.T) {
	h := newHarness(t, ModeManual)
	if err := h.manager.AssignPrimary(testSet, Assignment{PrimaryMemberID: testMemberA, Generation: 1}); err == nil {
		t.Fatal("an unsigned assignment from Gateway must be refused")
	}
	forged := signed(testMemberB, 5)
	forged.Signature = []byte("forged")
	if err := h.manager.AssignPrimary(testSet, forged); err == nil {
		t.Fatal("an assignment with a bad signature must be refused")
	}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	// The peer claims a newer generation without Gateway's signature: ignored.
	h.peer = &PeerState{MemberID: testMemberB, Generation: 9, Primary: testMemberB}
	h.step(10, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") >= 0 || indexOf(log, "engine.stop_clean") >= 0 {
		t.Fatalf("an unverified generation from the peer must not demote the primary: %v", log)
	}
	if state, _ := h.manager.PeerState(testSet); state.Generation != 1 {
		t.Fatalf("the unverified peer generation was adopted: %+v", state)
	}
}

func TestAVerifiedNewerAssignmentFromThePeerIsAdoptedAndDemotes(t *testing.T) {
	h := newHarness(t, ModeManual)
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.peer = peerWith(signed(testMemberB, 2))
	h.step(10, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 {
		t.Fatalf("the old primary must step down with a clean stop: %v", log)
	}
	state, _ := h.manager.PeerState(testSet)
	if state.Generation != 2 || state.Primary != testMemberB || state.Assignment == nil {
		t.Fatalf("the verified peer assignment must be adopted and passed on: %+v", state)
	}
	found := false
	for _, kind := range h.events() {
		found = found || kind == EventAssignmentLearned
	}
	if !found {
		t.Fatalf("adopting from the peer must be an event: %v", h.events())
	}
}

func TestAStoppedMemberThatMustRejoinIsNeverStartedFirst(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	ext.rejoinNeeded = true
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.start") >= 0 || indexOf(log, "engine.rejoin") >= 0 {
		t.Fatalf("without a known primary a member that must rejoin waits, never starts: %v", log)
	}
	h.lease.observed = &CertifiedState{State: HolderState{Holder: testNodeB}}
	h.step(3, time.Second)
	log := h.calls.take()
	rejoin, start := indexOf(log, "engine.rejoin"), indexOf(log, "engine.start")
	if rejoin < 0 || start < 0 || start < rejoin {
		t.Fatalf("the member must rejoin, then start: %v", log)
	}
	assertStandbyBeforeStart(t, log)
}

func TestHolderWorkAndCopyWorkRunAsOperations(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	ext.copyWork = 1
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.copy_work") < 0 {
		t.Fatalf("copy work did not run: %v", log)
	}
	servingHolder(t, h)
	ext.holderWork = 1
	h.step(2, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.holder_work") < 0 {
		t.Fatalf("holder work did not run: %v", log)
	}
}

func TestEngineEventsKeepTheirTime(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	ext.events = []Event{{Kind: "rewound", AtUnixMs: 42}}
	h.step(1, time.Second)
	h.manager.mu.Lock()
	events := h.manager.members[testSet].state.Events
	h.manager.mu.Unlock()
	if len(events) != 1 || events[0].Kind != "rewound" || events[0].AtUnixMs != 42 {
		t.Fatalf("engine event not queued with its time: %+v", events)
	}
}

func TestAStaleCertifiedValueIsCertifiedAgainBeforeServing(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	servingHolder(t, h)
	ext.current = false
	h.step(2, time.Second)
	log := h.calls.take()
	if indexOf(log, "endpoints false") < 0 || indexOf(log, "propose promoted promoted=true") < 0 {
		t.Fatalf("a holder whose certified value is stale must stop serving and certify again: %v", log)
	}
}

func TestAStagedSwitchoverWaitsUntilTheEngineIsReady(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	servingHolder(t, h)
	if err := h.manager.Switchover(testSet, testMemberB, "op-1"); err != nil {
		t.Fatal(err)
	}
	if len(ext.prepared) != 1 || ext.prepared[0] != testMemberB {
		t.Fatalf("the engine was not told the successor: %v", ext.prepared)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "lease.release") >= 0 || indexOf(log, "engine.switchover") >= 0 {
		t.Fatalf("the handoff must wait for the engine: %v", log)
	}
	ext.ready = true
	h.lease.outcome = TransitionCertified
	h.step(3, time.Second)
	log := h.calls.take()
	sw, release := indexOf(log, "engine.switchover"), indexOf(log, "lease.release "+testNodeB)
	if sw < 0 || release < 0 || release < sw || indexOf(log, "endpoints false") > sw {
		t.Fatalf("serving closed, the engine handoff, then the release to the successor: %v", log)
	}
}

func TestAStagedSwitchoverThatTimesOutKeepsThePrimary(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	servingHolder(t, h)
	if err := h.manager.Switchover(testSet, testMemberB, "op-1"); err != nil {
		t.Fatal(err)
	}
	h.step(70, time.Second)
	log := h.calls.take()
	if indexOf(log, "lease.release") >= 0 || indexOf(log, "engine.kill") >= 0 || indexOf(log, "engine.stop_clean") >= 0 {
		t.Fatalf("a staged switchover that timed out must not stop the primary: %v", log)
	}
	if len(ext.prepared) != 2 || ext.prepared[1] != "" {
		t.Fatalf("the engine must be told the switchover was cancelled: %v", ext.prepared)
	}
	found := false
	for _, kind := range h.events() {
		found = found || kind == EventSwitchoverFail
	}
	if !found {
		t.Fatal("the cancelled switchover must be an event")
	}
}

func TestTheHolderAndTheAssignedPrimaryCannotBeRemoved(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.holding(h.clock.now + time.Hour)
	if err := h.manager.Remove(testSet); !errors.Is(err, ErrRemovePrimary) {
		t.Fatalf("removing the holder must be refused: %v", err)
	}
	h.lease.status = HolderStatus{Role: RoleRetained}
	if err := h.manager.Remove(testSet); !errors.Is(err, ErrRemovePrimary) {
		t.Fatalf("removing the retained primary must be refused (B2): %v", err)
	}
	h.lease.status = HolderStatus{Role: RoleCandidate}
	if err := h.manager.Remove(testSet); err != nil {
		t.Fatalf("a copy may be removed: %v", err)
	}
	m := newHarness(t, ModeManual)
	if err := m.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	if err := m.manager.Remove(testSet); !errors.Is(err, ErrRemovePrimary) {
		t.Fatalf("removing the assigned primary must be refused: %v", err)
	}
}

func TestDetachOnlyBeforeAnyCommitAndNeverAfterHolding(t *testing.T) {
	cases := []struct {
		name     string
		evidence DetachEvidence
		setup    func(h *harness)
	}{
		{"gateway saw a holder", DetachEvidence{NeverHeld: false}, func(*harness) {}},
		{"other members seeded", DetachEvidence{NeverHeld: true, SeededMemberIDs: []string{testMemberB}}, func(*harness) {}},
		{"a commit exists", DetachEvidence{NeverHeld: true}, func(h *harness) {
			h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v")}}
		}},
		{"a commit was observed", DetachEvidence{NeverHeld: true}, func(h *harness) {
			h.lease.observed = &CertifiedState{State: HolderState{Holder: testNodeB}}
		}},
		{"the role is not idle", DetachEvidence{NeverHeld: true}, func(h *harness) { h.lease.status = HolderStatus{Role: RoleBootstrapping} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, ModeAutomatic)
			tc.setup(h)
			err := h.manager.Detach(testSet, "op", tc.evidence)
			if !errors.Is(err, ErrDetachRefused) {
				t.Fatalf("expected a refusal, got %v", err)
			}
			if h.lease.handler == nil {
				t.Fatal("a refused detach must restore the member's lease candidacy")
			}
		})
	}
	h := newHarness(t, ModeAutomatic)
	if err := h.manager.Detach(testSet, "op", DetachEvidence{NeverHeld: true, SeededMemberIDs: []string{testMemberA}}); err != nil {
		t.Fatal(err)
	}
	if h.lease.handler != nil || h.lease.ready {
		t.Fatal("a detached member must leave the lease")
	}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); err != nil {
		t.Fatalf("a detached origin may be lifted: %v", err)
	}
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.start") >= 0 || indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("the runtime must leave a detached member alone: %v", log)
	}
	// A member that held once is never detached.
	held := newHarness(t, ModeAutomatic)
	servingHolder(t, held)
	held.lease.status = HolderStatus{Role: RoleNone}
	held.lease.committed = nil
	if err := held.manager.Detach(testSet, "op", DetachEvidence{NeverHeld: true}); !errors.Is(err, ErrDetachRefused) {
		t.Fatalf("a member that held must not detach: %v", err)
	}
}

func TestOnlyARetainedPrimaryIsLifted(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.holding(h.clock.now + time.Hour)
	if _, err := h.manager.LiftCheck(testSet, testMemberA); !errors.Is(err, ErrNotRetained) {
		t.Fatalf("a holder whose close is not confirmed must not be lifted (B1): %v", err)
	}
	h.lease.status = HolderStatus{Role: RoleRetained, Retained: true}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); err != nil {
		t.Fatalf("a retained primary may be lifted: %v", err)
	}
	if _, err := h.manager.LiftCheck(testSet, testMemberB); err == nil {
		t.Fatal("a lift must name this node's member")
	}
	// A close that fenced the holder before the voters confirmed it: with the lease closed and every other member
	// gone, the last copy may be lifted; with another member still configured it may not.
	h.lease.status = HolderStatus{Role: RoleNone}
	h.lease.manifest = ManifestInfo{PolicyID: testPolicy, Closed: true}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); !errors.Is(err, ErrNotRetained) {
		t.Fatalf("a member with another member configured must not be lifted: %v", err)
	}
	alone := h.manager.members[testSet].cfg
	alone.Members = alone.Members[:1]
	alone.ConfigRevision++
	if err := h.manager.Configure(alone); err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); err != nil {
		t.Fatalf("the last copy under a closed lease may be lifted: %v", err)
	}
	h.lease.status = HolderStatus{Role: RoleHolding}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); err == nil {
		t.Fatal("a member that still holds (the close is being confirmed) waits for its retained role")
	}
}

func TestAHolderWhoseCloseIsNotConfirmedFencesAtItsLeaseTime(t *testing.T) {
	// B1: the closed manifest reached the holder, but no voter majority
	// confirmed it before the soft fence point; the library fences
	// (lease_closed) and the runtime kills the primary as for any fence.
	h := newHarness(t, ModeAutomatic)
	servingHolder(t, h)
	h.lease.status.Retaining = true
	h.step(2, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("a retaining holder keeps serving within its lease: %v", log)
	}
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleFencing, FenceNow: true, FenceReason: "lease_closed"}
	h.step(3, time.Second)
	log := h.calls.take()
	stop, kill := indexOf(log, "endpoints false"), indexOf(log, "engine.kill")
	if stop < 0 || kill < 0 || stop > kill || indexOf(log, "lease.fence_complete") < 0 {
		t.Fatalf("an unconfirmed close fences in order: %v", log)
	}
	if _, err := h.manager.LiftCheck(testSet, testMemberA); err == nil {
		t.Fatal("a fenced holder must not be lifted")
	}
}

func TestARestartOfACopyRunsThroughStandbyAtRest(t *testing.T) {
	h, _ := newExtHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(2, time.Second)
	h.calls.take()
	if err := h.manager.RestartMember(testSet, "op-r", false); err != nil {
		t.Fatal(err)
	}
	h.step(3, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 || indexOf(log, "engine.start") < 0 {
		t.Fatalf("the copy was not restarted: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	found := false
	for _, kind := range h.events() {
		found = found || kind == EventRestarted
	}
	if !found {
		t.Fatal("the restart must be an event")
	}
	servingHolder(t, h)
	if err := h.manager.RestartMember(testSet, "op-p", false); err == nil {
		t.Fatal("restarting the primary must need allowPrimary")
	}
}

func TestForcePromoteArmsOnlyACopyWithTheValue(t *testing.T) {
	h, ext := newExtHarness(t, ModeAutomatic)
	if _, err := h.manager.ForcePromote(testSet, "op-f", Ballot{}); !errors.Is(err, ErrForceRefused) {
		t.Fatalf("a force without the ballot the operator saw must be refused: %v", err)
	}
	ext.forced = []byte("forced")
	if _, err := h.manager.ForcePromote(testSet, "op-f", Ballot{Round: 3, Proposer: testNodeB}); !errors.Is(err, ErrForceRefused) {
		t.Fatalf("a lease without forced acquisition must refuse: %v", err)
	}
}
