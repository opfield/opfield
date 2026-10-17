package lease

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
)

func twoCandidateWorld(t *testing.T) *world {
	t.Helper()
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}})
	w.daemon("d1").addContainer(testPolicy, false)
	w.daemon("d2").addContainer(testPolicy, false)
	return w
}

func TestLeaseLoopAcquiresStartsAfterRecordAndServes(t *testing.T) {
	w := twoCandidateWorld(t)
	// Acceptors abstain 33 s after their start (A3); rank 0 then acquires.
	w.waitServing("d1", 45*time.Second)
	w.requireClean()
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	for id, c := range d1.engine.containers {
		if c.RestartPolicy != "no" {
			t.Fatalf("lease-mode container %s kept restart policy %q (A2.1)", shortID(id), c.RestartPolicy)
		}
		record := d1.fence.records[id]
		status := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy})
		if record.Deadline() <= w.clock.now || record.Deadline() > status.Deadline {
			t.Fatalf("holder record deadline %s not within (now, lease deadline %s]", record.Deadline(), status.Deadline)
		}
	}
	for id, c := range d2.engine.containers {
		if c.Running || c.RestartPolicy != "no" {
			t.Fatalf("standby %s running=%v restart=%q", shortID(id), c.Running, c.RestartPolicy)
		}
		if record, ok := d2.fence.records[id]; !ok || record.DeadlineNs != 0 {
			t.Fatalf("standby must carry an always-stale record after create, have %+v ok=%v", record, ok)
		}
	}
	if w.indexOf("d1 docker start") > w.indexOf("d1 endpoints serving=true") {
		t.Fatal("endpoint registered before the container started")
	}
	// Renewals keep it serving well past the lease term.
	w.run(90 * time.Second)
	w.requireClean()
	if w.holderOf() != "d1" || !d1.engine.running() {
		t.Fatalf("holder lost the lease while renewing: holder %q\n%s", w.holderOf(), w.dump())
	}
}

func TestPartitionedHolderSelfFencesBeforeSuccessorStarts(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.cut = true
	cutAt := w.clock.now
	w.waitServing("d2", 60*time.Second)
	w.requireClean()
	stopped := w.indexOf("d1 docker stop")
	started := w.lastIndexOf("d2 docker start")
	if stopped < 0 || started < stopped {
		t.Fatalf("successor started before the partitioned holder stopped\n%s", w.dump())
	}
	if w.indexOf("d1 endpoints serving=false") > stopped {
		t.Fatal("holder stopped its container before deregistering its endpoint")
	}
	if d1.engine.running() {
		t.Fatal("partitioned holder still runs its container")
	}
	if elapsed := w.clock.now - cutAt; elapsed > 45*time.Second {
		t.Fatalf("failover took %s", elapsed)
	}
}

func TestTakeoverFollowsManifestRank(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2", "d3"}, candidates: []string{"d1", "d2", "d3"}})
	for _, id := range []string{"d1", "d2", "d3"} {
		w.daemon(id).addContainer(testPolicy, false)
	}
	w.waitServing("d1", 45*time.Second)
	// The holder's host dies with its container.
	d1 := w.daemon("d1")
	d1.down = true
	for _, c := range d1.engine.containers {
		c.Running = false
	}
	w.waitServing("d2", 45*time.Second)
	w.run(20 * time.Second)
	w.requireClean()
	if w.daemon("d3").engine.running() || w.indexOf("d3 docker start") >= 0 {
		t.Fatalf("rank 2 started while rank 1 took over\n%s", w.dump())
	}
}

// A12 scenario l: the watchdog dies while its node holds. The daemon stops
// renewing and kills the container once the heartbeat is lost, well before
// the successor may start.
func TestDeadWatchdogStopsRenewingAndKills(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.fence.heartbeat = false // the watchdog process dies; its file stays
	w.logf("d1 watchdog died")
	w.run(leasefence.HeartbeatMaxAge + time.Second)
	if err := d1.runtime.CheckServe(testPolicy); err == nil {
		t.Fatal("backend start must be refused once the heartbeat is not fresh")
	}
	if !d1.engine.running() {
		t.Fatalf("a late heartbeat alone must not fence\n%s", w.dump())
	}
	w.run(leasefence.HeartbeatLostAge - leasefence.HeartbeatMaxAge + watchdogLostConfirm)
	status := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy})
	if d1.engine.running() {
		t.Fatalf("daemon kept its container without a watchdog (A12.4)\n%s", w.dump())
	}
	if status.Role == availabilitylease.RoleHolding {
		t.Fatalf("daemon still renews without a watchdog, role %s", status.Role)
	}
	w.waitServing("d2", 45*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if kill, start := w.lastIndexOf("d1 docker stop"), w.indexOf("d2 docker start"); kill < w.indexOf("d1 watchdog died") || kill > start {
		t.Fatalf("the holder must kill its container before the successor starts\n%s", w.dump())
	}
	if d1.engine.running() {
		t.Fatal("daemon without a watchdog re-acquired")
	}
}

// N1: a CPU-starved watchdog writes its heartbeat late. That blocks new
// starts but must never fence the running workload.
func TestSlowWatchdogNeverFences(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	for _, lag := range []time.Duration{4 * time.Second, 8 * time.Second, leasefence.HeartbeatLostAge - worldTick} {
		d1.fence.lag = lag
		w.run(20 * time.Second)
		d1.fence.lag = 0
		w.run(2 * time.Second)
	}
	// Stale observations that do not last: a single step past the loss age.
	d1.fence.lag = leasefence.HeartbeatLostAge + time.Second
	w.run(worldTick)
	d1.fence.lag = 0
	w.run(5 * time.Second)
	w.requireClean()
	if w.indexOf("d1 docker stop") >= 0 || !d1.engine.running() || w.holderOf() != "d1" {
		t.Fatalf("a slow watchdog fenced the holder\n%s", w.dump())
	}
}

func TestDockerdHangLeavesFencingToTheWatchdog(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.cut = true
	d1.engine.hung = true
	w.waitServing("d2", 60*time.Second)
	w.requireClean()
	if w.indexOf("d1 watchdog killed") < 0 || w.indexOf("d1 watchdog killed") > w.lastIndexOf("d2 docker start") {
		t.Fatalf("the watchdog must kill the hung holder's cgroup before the successor starts\n%s", w.dump())
	}
}

func TestLeaseClosedFencesHolderAndLiftsGate(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.closeLease()
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	if d1.engine.running() {
		t.Fatalf("holder must fence on a lease-closed manifest (A5)\n%s", w.dump())
	}
	if d1.runtime.LeaseMode(testPolicy) {
		t.Fatal("closed manifest must leave lease mode")
	}
	if err := w.daemon("d2").runtime.CheckServe(testPolicy); err != nil {
		t.Fatalf("legacy commands must pass the gate after close: %v", err)
	}
	w.run(3 * time.Second)
	if len(d1.fence.records) != 0 {
		t.Fatalf("records must be removed once the lease is closed and the cgroup is empty, have %d", len(d1.fence.records))
	}
}

// A lease that closed and is entered again watches the copy its holder finds
// then. In between the legacy path replaced the copy (a disable keeps it under
// the workload's own name); the holder of the new period must not release it
// for the previous period's container, which no longer exists.
func TestReenteredLeaseAdoptsTheCopyItFinds(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, bootstrap: "d1"})
	d1 := w.daemon("d1")
	previous := d1.addContainer(testPolicy, true)
	w.daemon("d2").addContainer(testPolicy, false)
	w.waitServing("d1", 45*time.Second)
	w.run(15 * time.Second)
	w.closeGracefully()
	w.run(5 * time.Second)
	delete(d1.engine.containers, previous.ID)
	replacement := d1.addContainer(testPolicy, true)
	w.run(5 * time.Second)
	w.reopen(map[uint32]string{0: "d1"})
	reopened := w.lastIndexOf("opfield reopens")
	w.run(60 * time.Second)
	w.requireClean()
	if !replacement.Running || w.holderOf() != "d1" || w.lastIndexOf("d1 docker stop") > reopened {
		t.Fatalf("the holder of the re-entered lease must keep serving the copy it found (holder %q)\n%s", w.holderOf(), w.dump())
	}
}
