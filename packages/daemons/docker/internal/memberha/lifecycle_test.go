package memberha

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// Rolling updates and set-aware lifecycle (P3-T07): a paused set
// (Config.Stopped), the restart command, the copy-only hold of a recreate.

// pause applies Opfield's configuration with Stopped set as given.
func pause(t *testing.T, h *harness, stopped bool) {
	t.Helper()
	config, ok := h.manager.Config(testSet)
	if !ok {
		t.Fatal("no member")
	}
	config.Stopped = stopped
	config.ConfigRevision++
	if err := h.manager.Configure(config); err != nil {
		t.Fatal(err)
	}
}

func report(t *testing.T, h *harness) Report {
	t.Helper()
	reports := h.manager.Reports()
	if len(reports) != 1 {
		t.Fatalf("reports = %v", reports)
	}
	return reports[0]
}

func hasEvent(h *harness, kind string) bool {
	for _, event := range h.events() {
		if event == kind {
			return true
		}
	}
	return false
}

func TestAPausedCopyStopsCleanlyIsIneligibleAndNeverStarts(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(3, time.Second)
	if !h.lease.ready {
		t.Fatal("a running copy is a candidate")
	}
	h.calls.take()
	pause(t, h, true)
	h.step(30, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 || indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("a paused copy stops cleanly: %v", log)
	}
	if indexOf(log, "engine.start") >= 0 {
		t.Fatalf("a paused copy is never started: %v", log)
	}
	if h.lease.ready {
		t.Fatal("a paused copy is no candidate")
	}
	if ok, reason := h.lease.handler.Eligible(EligibilityInput{}); ok || reason != "stopped" {
		t.Fatalf("eligibility = %v %q, want false stopped", ok, reason)
	}
	r := report(t, h)
	if !r.Stopped || r.Eligible || r.EligibilityReason != "stopped" {
		t.Fatalf("report = %+v, want stopped and ineligible", r)
	}
	// The pause ends: the copy starts again, standby at rest first.
	pause(t, h, false)
	h.step(3, time.Second)
	log = h.calls.take()
	if indexOf(log, "engine.start") < 0 {
		t.Fatalf("the copy did not start after the pause: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	if r := report(t, h); r.Stopped {
		t.Fatalf("report = %+v after the pause", r)
	}
}

func TestAPausedHolderKeepsItsRoleWithoutReleaseOrRestartAndStartsFirst(t *testing.T) {
	h, _ := newExtHarness(t, ModeAutomatic)
	servingHolder(t, h)
	pause(t, h, true)
	h.step(40, time.Second)
	log := h.calls.take()
	if indexOf(log, "endpoints false") < 0 || indexOf(log, "engine.stop_clean") < 0 {
		t.Fatalf("the paused holder must close serving and stop cleanly: %v", log)
	}
	if indexOf(log, "endpoints false") > indexOf(log, "engine.stop_clean") {
		t.Fatalf("serving closes before the stop: %v", log)
	}
	for _, forbidden := range []string{"lease.release", "lease.abandon", "lease.fence_complete", "engine.kill", "engine.start", "record.delete"} {
		if indexOf(log, forbidden) >= 0 {
			t.Fatalf("a paused holder keeps its role (no %s): %v", forbidden, log)
		}
	}
	for _, kind := range []string{EventHealthRestart, EventHealthRelease, EventHealthAlert, EventFenced} {
		if hasEvent(h, kind) {
			t.Fatalf("a requested stop is no failure (%s): %v", kind, h.events())
		}
	}
	if _, ok := h.watchdog.records[testCID]; !ok {
		t.Fatal("the paused holder's deadline record must stay armed")
	}
	if serving, _ := h.manager.MemberServing(testSet, testMemberA); serving || h.manager.ProxyAdmits(testSet) {
		t.Fatal("a paused holder does not serve")
	}
	if r := report(t, h); !r.Stopped {
		t.Fatalf("report = %+v, want stopped", r)
	}
	// The pause ends: the primary starts at once (standby at rest), is
	// promoted again and serves.
	pause(t, h, false)
	h.step(6, time.Second)
	log = h.calls.take()
	start, promote, serve := indexOf(log, "engine.start"), indexOf(log, "engine.promote"), indexOf(log, "endpoints true")
	if start < 0 || promote < start || serve < promote {
		t.Fatalf("after the pause the holder starts, promotes and serves: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	if indexOf(log, "lease.release") >= 0 || hasEvent(h, EventHealthRestart) {
		t.Fatalf("the resume is no health event: %v %v", log, h.events())
	}
}

func TestAPausedHolderRecoversItsRoleAfterADaemonRestart(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	config, _ := h.manager.Config(testSet)
	config.Stopped = true
	config.ConfigRevision++
	if err := h.manager.Configure(config); err != nil {
		t.Fatal(err)
	}
	h.engine.container = ContainerState{Exists: true, ID: testCID}
	deadline := h.clock.now + 15*time.Second
	h.watchdog.records[testCID] = leasefence.Record{ContainerID: testCID, PolicyID: testPolicy, DeadlineNs: int64(deadline)}
	h.step(2, time.Second)
	if log := h.calls.take(); indexOf(log, "lease.recover") < 0 || indexOf(log, "engine.start") >= 0 {
		t.Fatalf("a paused holder with a live record recovers its role and stays down: %v", log)
	}
}

func TestAPausedManualPrimaryKeepsItsAssignmentAndStartsAgain(t *testing.T) {
	h := newHarness(t, ModeManual)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.step(5, time.Second)
	h.calls.take()
	pause(t, h, true)
	h.step(40, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 || indexOf(log, "engine.start") >= 0 || indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("the paused manual primary stops cleanly and stays down: %v", log)
	}
	h.manager.mu.Lock()
	assigned := h.manager.members[testSet].state.Assignment.PrimaryMemberID
	h.manager.mu.Unlock()
	if assigned != testMemberA {
		t.Fatal("the manual primary keeps its assignment")
	}
	pause(t, h, false)
	h.step(6, time.Second)
	log = h.calls.take()
	if indexOf(log, "engine.start") < 0 || indexOf(log, "engine.promote") < 0 || indexOf(log, "endpoints true") < 0 {
		t.Fatalf("after the pause the manual primary starts, promotes and serves: %v", log)
	}
	assertStandbyBeforeStart(t, log)
}

func TestTheRestartCommandRefusesThePrimaryAndAcceptsARepeat(t *testing.T) {
	h, _ := newExtHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(2, time.Second)
	h.calls.take()
	if err := h.manager.RestartMember(testSet, "op-r", false); err != nil {
		t.Fatal(err)
	}
	if r := report(t, h); r.PendingRestartOperationID != "op-r" {
		t.Fatalf("pending restart = %q", r.PendingRestartOperationID)
	}
	if err := h.manager.RestartMember(testSet, "op-r", false); err != nil {
		t.Fatalf("a repeat while pending is accepted: %v", err)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.start") < 0 {
		t.Fatalf("the copy was not restarted: %v", log)
	}
	if r := report(t, h); r.PendingRestartOperationID != "" || !hasEvent(h, EventRestarted) {
		t.Fatalf("the finished restart clears the pending id: %+v %v", r, h.events())
	}
	if err := h.manager.RestartMember(testSet, "op-r", false); err != nil {
		t.Fatalf("a repeat after the restart is accepted: %v", err)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.stop_clean") >= 0 {
		t.Fatalf("a repeat of a finished restart restarts nothing: %v", log)
	}
	servingHolder(t, h)
	err := h.manager.RestartMember(testSet, "op-p", false)
	if err == nil || !strings.Contains(err.Error(), SwitchoverRequiredCode) || !errors.Is(err, ErrSwitchoverRequired) {
		t.Fatalf("the primary's restart without allowPrimary = %v", err)
	}
	if err := h.manager.RestartMember(testSet, "op-p2", true); err != nil {
		t.Fatal(err)
	}
	h.step(6, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 || indexOf(log, "engine.start") < 0 || indexOf(log, "engine.promote") < 0 {
		t.Fatalf("an allowed primary restart stops, starts and promotes again: %v", log)
	}
	if indexOf(log, "lease.release") >= 0 {
		t.Fatalf("a primary restart keeps the role: %v", log)
	}
}

func TestARestartWhilePausedFinishesWithoutStarting(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(2, time.Second)
	pause(t, h, true)
	h.step(3, time.Second)
	h.calls.take()
	if err := h.manager.RestartMember(testSet, "op-r", false); err != nil {
		t.Fatal(err)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.start") >= 0 {
		t.Fatalf("a paused member is never started: %v", log)
	}
	if r := report(t, h); r.PendingRestartOperationID != "" || !hasEvent(h, EventRestarted) {
		t.Fatalf("the restart of a paused member finishes: %+v", r)
	}
}

func TestHoldCopyRefusesThePrimaryAndKeepsAHeldCopyIneligible(t *testing.T) {
	h, _ := newExtHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(3, time.Second)
	if !h.lease.ready {
		t.Fatal("a running copy is a candidate")
	}
	done := make(chan struct{})
	var release func()
	var holdErr error
	go func() { release, holdErr = h.manager.HoldCopy(context.Background(), testSet); close(done) }()
	<-done
	if holdErr != nil {
		t.Fatalf("a copy is held: %v", holdErr)
	}
	if h.lease.ready {
		t.Fatal("a held copy is no candidate")
	}
	if ok, reason := h.lease.handler.Eligible(EligibilityInput{}); ok || reason != "held" {
		t.Fatalf("eligibility of a held copy = %v %q", ok, reason)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.") >= 0 {
		t.Fatalf("the runtime leaves a held member alone: %v", log)
	}
	release()
	release()
	h.step(3, time.Second)
	if !h.lease.ready {
		t.Fatal("the released copy is a candidate again")
	}
	servingHolder(t, h)
	if _, err := h.manager.HoldCopy(context.Background(), testSet); !errors.Is(err, ErrSwitchoverRequired) ||
		!strings.Contains(err.Error(), SwitchoverRequiredCode) {
		t.Fatalf("holding the primary for a recreate = %v", err)
	}
	// The refused hold was released: the holder keeps working.
	h.step(2, time.Second)
	if serving, _ := h.manager.MemberServing(testSet, testMemberA); !serving {
		t.Fatal("the holder stopped serving after a refused hold")
	}
}

func TestHoldCopyRefusesAManualPairsAssignedPrimary(t *testing.T) {
	h := newHarness(t, ModeManual)
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.HoldCopy(context.Background(), testSet); !errors.Is(err, ErrSwitchoverRequired) {
		t.Fatalf("holding the assigned primary = %v", err)
	}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberB, 2)); err != nil {
		t.Fatal(err)
	}
	release, err := h.manager.HoldCopy(context.Background(), testSet)
	if err != nil {
		t.Fatalf("the manual copy is held: %v", err)
	}
	release()
}

func TestAStoppedConfigurationIsPersisted(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	pause(t, h, true)
	reloaded, err := NewManager(Deps{
		Lease: h.lease, Watchdog: h.watchdog, Endpoints: h.ends, Clock: h.clock,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine: func(Config) (Engine, error) { return h.engine, nil },
		Async:  func(fn func()) { h.pending = append(h.pending, fn) },
	}, h.manager.store)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.Stopped(testSet) {
		t.Fatal("a pause survives a daemon restart (Gateway may be down)")
	}
}
