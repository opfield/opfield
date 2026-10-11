package memberha

import (
	"context"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
)

// Every start of a member is preceded by standby at rest, on every path.
func assertStandbyBeforeStart(t *testing.T, log []string) {
	t.Helper()
	prepared := false
	for _, entry := range log {
		switch entry {
		case "engine.prepare_standby":
			prepared = true
		case "engine.start":
			if !prepared {
				t.Fatalf("engine started without standby at rest first: %v", log)
			}
			prepared = false
		}
	}
}

func TestAStoppedMemberStartsAsACopyWithStandbyAtRestFirst(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.step(3, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.start") < 0 {
		t.Fatalf("the stopped copy was not started: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	if indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("a member that does not hold must never promote: %v", log)
	}
}

func TestTheHolderArmsItsRecordPromotesCertifiesThenServes(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(2, time.Second)
	h.calls.take()
	h.holding(h.clock.now + 20*time.Second)
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v1"), PendingPromotion: true, Holder: testNodeA}}
	h.step(3, time.Second)
	log := h.calls.take()
	record, promote := indexOf(log, "record.write"), indexOf(log, "engine.promote")
	if record < 0 || promote < 0 || record > promote {
		t.Fatalf("the deadline record must be written before the promotion: %v", log)
	}
	if indexOf(log, "endpoints true") >= 0 {
		t.Fatalf("the holder must not serve before its promotion is certified: %v", log)
	}
	if indexOf(log, "propose promoted promoted=true") < 0 {
		t.Fatalf("the promotion was not proposed for certification: %v", log)
	}
	if h.manager.ProxyAdmits(testSet) {
		t.Fatal("the proxy must not admit before the promotion is certified")
	}
	// Certified: PendingPromotion cleared with this node as holder.
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("promoted"), Holder: testNodeA, PromotedHolder: testNodeA}}
	h.lease.outcome = TransitionCertified
	h.step(2, time.Second)
	log = h.calls.take()
	if indexOf(log, "endpoints true") < 0 {
		t.Fatalf("the certified holder must serve: %v", log)
	}
	if !h.manager.ProxyAdmits(testSet) {
		t.Fatal("the proxy must admit the serving holder with a fresh gate view")
	}
	h.gates.open = false
	if h.manager.ProxyAdmits(testSet) {
		t.Fatal("the proxy must not admit without a fresh relay gate view naming this node")
	}
	if events := h.events(); len(events) != 1 || events[0] != EventPromoted {
		t.Fatalf("events = %v, want one promotion", events)
	}
}

func TestAPromotionWaitsWhileTheLeaseForbidsAStart(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	h.step(2, time.Second)
	h.holding(h.clock.now + 20*time.Second)
	h.lease.status.MayStart = false
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v1"), PendingPromotion: true, Holder: testNodeA}}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("promoted although the lease forbids a start: %v", log)
	}
}

func TestAFenceStopsServingKillsThenWritesStandbyBeforeTheRecordGoes(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.watchdog.records[testCID] = leasefence.Record{ContainerID: testCID, PolicyID: testPolicy}
	h.step(2, time.Second)
	h.calls.take()
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleFencing, FenceNow: true, FenceReason: "other_holder_committed"}
	h.step(2, time.Second)
	log := h.calls.take()
	order := []string{"endpoints false", "engine.kill", "engine.prepare_standby", "record.delete", "lease.fence_complete"}
	last := -1
	for _, step := range order {
		at := indexOf(log, step)
		if at < 0 || at < last {
			t.Fatalf("fence order broken at %q: %v", step, log)
		}
		last = at
	}
	// The member comes back as a copy, standby at rest first.
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleCandidate}
	h.step(3, time.Second)
	log = h.calls.take()
	if indexOf(log, "engine.start") < 0 {
		t.Fatalf("the fenced member did not start as a copy: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	if events := h.events(); len(events) == 0 || events[0] != EventFenced {
		t.Fatalf("events = %v, want a fence", events)
	}
}

func TestAFenceThatCannotStopAbandonsTheKey(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.engine.failKill = true
	h.step(2, time.Second)
	h.calls.take()
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleFencing, FenceNow: true}
	h.step(2, time.Second)
	log := h.calls.take()
	if indexOf(log, "lease.abandon") < 0 || indexOf(log, "lease.fence_complete") >= 0 || indexOf(log, "record.delete") >= 0 {
		t.Fatalf("an unconfirmed stop must abandon, keep the record and not complete the fence: %v", log)
	}
}

func TestAPrimaryWithoutTheLeaseIsFencedAsUnowned(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleCandidate}
	h.step(4, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.kill") < 0 {
		t.Fatalf("a primary without the lease in lease mode must be killed: %v", log)
	}
	if events := h.events(); len(events) == 0 || events[0] != EventUnownedPrimary {
		t.Fatalf("events = %v, want unowned_primary_stopped", events)
	}
}

func TestBeforeTheLeaseRunsTheWritableMemberKeepsServing(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.lease.hasManifest = false
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.step(4, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("the single-node primary must keep running before the lease starts: %v", log)
	}
	if serving, known := h.manager.MemberServing(testSet, testMemberA); !known || !serving {
		t.Fatalf("serving = %v, known = %v: the member that serves the resource before the lease must serve", serving, known)
	}
}

func TestAStartWithALiveRecordRecoversTheKey(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	deadline := h.clock.now + 15*time.Second
	h.watchdog.records[testCID] = leasefence.Record{ContainerID: testCID, PolicyID: testPolicy, DeadlineNs: int64(deadline)}
	h.step(2, time.Second)
	if log := h.calls.take(); indexOf(log, "lease.recover") < 0 || indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("a running primary with a live record must be recovered, not killed: %v", log)
	}
}

func TestAFailedHolderReleasesToAnEligibleCopyOrRestartsLocally(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.step(2, time.Second)
	h.holding(h.clock.now + 60*time.Second)
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v"), Holder: testNodeA, PromotedHolder: testNodeA}}
	h.step(2, time.Second)
	h.calls.take()
	// The engine stops answering; after the health window, no eligible copy: local restart.
	h.engine.status = EngineStatus{}
	h.step(14, time.Second)
	log := h.calls.take()
	if indexOf(log, "lease.release") >= 0 || indexOf(log, "engine.start") < 0 {
		t.Fatalf("without an eligible copy the holder restarts locally: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	// With an eligible copy it releases to it, in the A6 order.
	h.engine.status = EngineStatus{}
	h.engine.releaseTarget = testMemberB
	h.step(14, time.Second)
	log = h.calls.take()
	release := indexOf(log, "lease.release node-b")
	if release < 0 || indexOf(log, "endpoints false") > release || indexOf(log, "engine.prepare_standby") > release {
		t.Fatalf("health release must close serving and write standby at rest before releasing to the copy: %v", log)
	}
}

func TestADiskFullHolderAlertsButKeepsTheRole(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true, DiskFull: true}
	h.step(2, time.Second)
	h.holding(h.clock.now + 60*time.Second)
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v"), Holder: testNodeA, PromotedHolder: testNodeA}}
	h.step(3, time.Second)
	log := h.calls.take()
	if indexOf(log, "lease.release") >= 0 || indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("a full disk is no release reason: %v", log)
	}
	found := false
	for _, kind := range h.events() {
		found = found || kind == EventDiskAlert
	}
	if !found {
		t.Fatalf("events = %v, want a disk alert", h.events())
	}
}

func TestAHolderCertifiesItsSteadyStateOneTransitionAtATime(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	h.step(2, time.Second)
	h.holding(h.clock.now + 60*time.Second)
	h.lease.committed = &CertifiedState{State: HolderState{Value: []byte("v"), Holder: testNodeA, PromotedHolder: testNodeA}}
	h.lease.outcome = TransitionQueued
	h.engine.nextValue = []byte("floor-1")
	h.step(2, time.Second)
	h.engine.nextValue = []byte("floor-2")
	h.step(3, time.Second)
	log := h.calls.take()
	if indexOf(log, "propose floor-1") < 0 || indexOf(log, "propose floor-2") >= 0 {
		t.Fatalf("a second transition must wait for the first: %v", log)
	}
	h.lease.outcome = TransitionCertified
	h.step(2, time.Second)
	if log := h.calls.take(); indexOf(log, "propose floor-2") < 0 {
		t.Fatalf("the next transition follows the certified one: %v", log)
	}
}

func TestADivergedCopyRejoinsOnlyWhenAnotherPrimaryIsKnown(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, NeedsRejoin: true}
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleCandidate}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.rejoin") >= 0 {
		t.Fatalf("no rejoin without a known primary: %v", log)
	}
	h.lease.observed = &CertifiedState{State: HolderState{Holder: testNodeB}}
	h.step(3, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.rejoin") < 0 {
		t.Fatalf("a diverged copy must rejoin the known primary: %v", log)
	}
	assertStandbyBeforeStart(t, log)
}

func TestManualPrimarySelfFencesWithoutGatewayAndPeerAndResumes(t *testing.T) {
	h := newHarness(t, ModeManual)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") < 0 || indexOf(log, "endpoints true") < 0 {
		t.Fatalf("the assigned primary must promote and serve: %v", log)
	}
	// Only Gateway lost: writes continue.
	h.gateway = false
	h.peer = peerWith(signed(testMemberA, 1))
	h.step(40, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("one failure must never stop writes: %v", log)
	}
	// Gateway and the peer lost for 30 s: the primary demotes itself.
	h.peer = nil
	h.step(40, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.kill") < 0 || indexOf(log, "endpoints false") < 0 {
		t.Fatalf("the isolated primary must demote itself: %v", log)
	}
	if serving, _ := h.manager.MemberServing(testSet, testMemberA); serving {
		t.Fatal("a self-fenced primary must not serve")
	}
	// The peer answers again under the same generation: the primary serves again.
	h.peer = peerWith(signed(testMemberA, 1))
	h.step(10, time.Second)
	log = h.calls.take()
	if indexOf(log, "engine.promote") < 0 {
		t.Fatalf("the primary must resume once it reaches its peer without a newer assignment: %v", log)
	}
	assertStandbyBeforeStart(t, log)
}

func TestManualMemberStepsDownWhenThePeerServesANewerGeneration(t *testing.T) {
	h := newHarness(t, ModeManual)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, Writable: true}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.peer = peerWith(signed(testMemberB, 2))
	h.step(10, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.stop_clean") < 0 {
		t.Fatalf("a primary that sees a newer generation must step down (clean stop): %v", log)
	}
	if indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("it must never promote again under the older generation: %v", log)
	}
}

func TestManualCopyNeverPromotes(t *testing.T) {
	h := newHarness(t, ModeManual)
	if err := h.manager.AssignPrimary(testSet, signed(testMemberB, 3)); err != nil {
		t.Fatal(err)
	}
	h.step(10, time.Second)
	log := h.calls.take()
	if indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("a manual copy must never promote: %v", log)
	}
	assertStandbyBeforeStart(t, log)
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 2)); err != nil {
		t.Fatal(err)
	}
	if state, _ := h.manager.PeerState(testSet); state.Generation != 3 {
		t.Fatalf("an older assignment must be ignored, generation = %d", state.Generation)
	}
}

func TestEventsSurviveARestartUntilGatewayAcknowledgesThem(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.manager.mu.Lock()
	mem := h.manager.members[testSet]
	h.manager.eventLocked(mem, Event{Kind: EventFenced})
	h.manager.eventLocked(mem, Event{Kind: EventRejoined})
	h.manager.mu.Unlock()
	reports := h.manager.Reports()
	if len(reports) != 1 || len(reports[0].Events) != 2 || reports[0].Events[0].AtUnixMs == 0 {
		t.Fatalf("reports = %+v", reports)
	}
	if err := h.manager.AckEvents(testSet, reports[0].Events[0].Seq); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewManager(h.manager.deps, h.manager.store)
	if err != nil {
		t.Fatal(err)
	}
	reports = reloaded.Reports()
	if len(reports) != 1 || len(reports[0].Events) != 1 || reports[0].Events[0].Kind != EventRejoined {
		t.Fatalf("after a restart the unacknowledged event stays: %+v", reports)
	}
}

func TestTheProxyAdmitsOnlyWhileTheMemberServesAndClosesSessionsAfter(t *testing.T) {
	var admit atomic.Bool
	admit.Store(true)
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		for {
			conn, acceptErr := backend.Accept()
			if acceptErr != nil {
				return
			}
			go func() { _, _ = io.Copy(conn, conn) }()
		}
	}()
	proxy := NewProxy("127.0.0.1:0", admit.Load, func(ctx context.Context) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "tcp", backend.Addr().String())
	}, nil)
	if err := proxy.Start(); err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	client, err := net.Dial("tcp", proxy.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 4)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(client, buffer); err != nil || string(buffer) != "ping" {
		t.Fatalf("echo through the admitting proxy = %q, %v", buffer, err)
	}
	admit.Store(false)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := client.Read(buffer); err == nil {
		t.Fatal("a session must be closed once the member stops serving")
	}
	refused, err := net.Dial("tcp", proxy.Addr().String())
	if err == nil {
		_ = refused.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, readErr := refused.Read(buffer); readErr == nil {
			t.Fatal("a new connection must be refused while the member does not serve")
		}
		refused.Close()
	}
}

// A copy reports whether it could take the primary role over now, under the
// latest verified commit (the lease asks only when it acquires), and its sync
// state from the certified synchronous set (a standby cannot see its own).
func TestReportsTellWhetherACopyCouldTakeOverAndReplicatesSynchronously(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true, SyncState: "async"}
	h.step(3, time.Second)
	report := h.manager.Reports()[0]
	if report.Eligible || report.SyncState != "async" {
		t.Fatalf("without a commit the report keeps what the lease last answered: %+v", report)
	}
	h.lease.observed = &CertifiedState{State: HolderState{Holder: testNodeB, Value: []byte("sync-set")}}
	report = h.manager.Reports()[0]
	if !report.Eligible || report.SyncState != "sync" {
		t.Fatalf("a streaming copy in the certified sync set reports eligible and sync: %+v", report)
	}
	h.lease.observed.State.Value = []byte("other")
	if report = h.manager.Reports()[0]; report.SyncState != "async" {
		t.Fatalf("a copy outside the sync set reports async: %+v", report)
	}
	h.watchdog.present = false
	h.step(1, time.Second)
	if report = h.manager.Reports()[0]; report.Eligible || report.EligibilityReason != "watchdog_not_fresh" {
		t.Fatalf("the shared rules apply to the reported eligibility: %+v", report)
	}
	// The holder reports what the lease answered it, not a copy's evaluation.
	h.watchdog.present = true
	h.holding(h.clock.now + time.Minute)
	h.lease.observed.State.Holder = testNodeA
	if report = h.manager.Reports()[0]; report.Eligible {
		t.Fatalf("the holder is not evaluated as a copy: %+v", report)
	}
}

// promotedPrimary is a manual pair whose member A was assigned and promoted
// (Gateway's assignment, the engine running writable).
func promotedPrimary(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t, ModeManual)
	h.engine.container.Running = true
	h.engine.status = EngineStatus{Answering: true}
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") < 0 {
		t.Fatalf("the assigned primary must promote: %v", log)
	}
	return h
}

// The self-fence counts from the last command that arrived from Gateway, not
// from a control session that is dead without knowing it yet: it fires at
// its 30 s bound, inside Gateway's 45 s rule.
func TestManualPrimarySelfFencesThirtySecondsAfterTheLastGatewayCommand(t *testing.T) {
	h := promotedPrimary(t)
	lastCommand := h.clock.now
	h.manager.deps.GatewayContactAt = func() time.Duration { return lastCommand }
	h.gateway = true // the session still looks up
	h.step(28, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") >= 0 {
		t.Fatalf("no fence before the bound: %v", log)
	}
	h.step(3, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") < 0 {
		t.Fatalf("the primary must fence at 30 s after the last command: %v", log)
	}
	if fencedAt := h.clock.now - lastCommand; fencedAt > selfFenceAfter+2*time.Second {
		t.Fatalf("fenced %v after the last command", fencedAt)
	}
}

// A primary that self-fenced never promotes itself when contact returns: it
// stays read-only until Gateway or the peer confirmed the newest assignment
// still names it, and a newer one naming the copy keeps it a copy.
func TestASelfFencedPrimaryWaitsForAConfirmedAssignment(t *testing.T) {
	h := promotedPrimary(t)
	h.gateway = false
	h.step(35, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.kill") < 0 {
		t.Fatalf("the isolated primary must fence: %v", log)
	}
	// Gateway reaches the node again, without an assignment yet.
	h.manager.deps.GatewayContactAt = func() time.Duration { return h.clock.now }
	h.step(20, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("a fenced primary must not promote on contact alone: %v", log)
	}
	// Gateway sends the current assignment again: it names A, A serves again.
	if err := h.manager.AssignPrimary(testSet, signed(testMemberA, 1)); err != nil {
		t.Fatal(err)
	}
	h.step(5, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") < 0 {
		t.Fatalf("a confirmed assignment ends the fence: %v", log)
	}
}

func TestASelfFencedPrimaryStaysACopyUnderANewerAssignment(t *testing.T) {
	h := promotedPrimary(t)
	h.gateway = false
	h.step(35, time.Second)
	h.calls.take()
	h.manager.deps.GatewayContactAt = func() time.Duration { return h.clock.now }
	if err := h.manager.AssignPrimary(testSet, signed(testMemberB, 2)); err != nil {
		t.Fatal(err)
	}
	h.step(20, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("the copy was promoted meanwhile: the old primary must stay a copy: %v", log)
	}
}

// After a restart the stored assignment is not enough to promote: the member
// waits for Gateway or its peer.
func TestARestartedManualPrimaryPromotesOnlyAfterConfirmation(t *testing.T) {
	h := promotedPrimary(t)
	h.engine.status = EngineStatus{Answering: true} // the engine came back read-only
	reloaded, err := NewManager(h.manager.deps, h.manager.store)
	if err != nil {
		t.Fatal(err)
	}
	h.manager = reloaded
	h.step(10, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") >= 0 {
		t.Fatalf("a restarted member must not promote from its stored assignment alone: %v", log)
	}
	h.peer = peerWith(signed(testMemberA, 1))
	h.step(10, time.Second)
	if log := h.calls.take(); indexOf(log, "engine.promote") < 0 {
		t.Fatalf("the peer's confirmation lets it promote: %v", log)
	}
}

// Forgetting a member (lift, removal, set deleted) lets the node release what
// it kept for the set, every published port included.
func TestForgetReleasesTheSet(t *testing.T) {
	h := newHarness(t, ModeAutomatic)
	var released []string
	h.manager.deps.Forgotten = func(setID string) { released = append(released, setID) }
	if err := h.manager.AttachProxyPort(testSet, "native", "127.0.0.1:0", func(context.Context) (net.Conn, error) {
		return nil, io.EOF
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.Forget(testSet); err != nil {
		t.Fatal(err)
	}
	if len(released) != 1 || released[0] != testSet {
		t.Fatalf("released = %v", released)
	}
	h.manager.mu.Lock()
	left := len(h.manager.proxies)
	h.manager.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d published ports of the forgotten set remain", left)
	}
	// Idempotent: a set the node does not know is released again.
	if err := h.manager.Forget(testSet); err != nil || len(released) != 2 {
		t.Fatalf("a repeated forget = %v, released %v", err, released)
	}
}
