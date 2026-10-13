package lease

import (
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// restartDaemon simulates a daemon process restart on a live host: the
// container keeps running, the store and watchdog records survive.
func (w *world) restartDaemon(id string) *daemonHost {
	h := w.daemon(id)
	w.startDaemon(h)
	w.logf("%s daemon restarted", id)
	return h
}

func TestStartupRecoversContainerWithLiveRecordWhenRenewalSucceeds(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.restartDaemon("d1")
	w.run(500 * time.Millisecond)
	if !d1.engine.running() {
		t.Fatalf("a container with budget left must survive the restart until its renewal\n%s", w.dump())
	}
	role := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role
	if role != availabilitylease.RoleRecovering && role != availabilitylease.RoleHolding {
		t.Fatalf("restarted holder role %s, want recovering or holding", role)
	}
	w.waitServing("d1", 10*time.Second)
	w.run(60 * time.Second)
	w.requireClean()
	if w.indexOf("d1 docker stop") >= 0 || w.indexOf("d1 docker kill") >= 0 || w.holderOf() != "d1" {
		t.Fatalf("recovered holder must keep serving after renewing\n%s", w.dump())
	}
}

// A daemon that may not read the watchdog records at its start (a switch of its user the watchdog has not followed
// yet) must not take its running copies for unfenced and kill them: it waits, and recovers them once it reads them.
func TestStartupWaitsForUnreadableRecords(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	d1.fence.unreadable = true
	w.restartDaemon("d1")
	restart := w.lastIndexOf("d1 daemon restarted")
	w.run(time.Second)
	if !d1.engine.running() || w.lastIndexOf("d1 docker stop") > restart || w.lastIndexOf("d1 docker kill") > restart {
		t.Fatalf("a copy was killed while the records could not be read\n%s", w.dump())
	}
	d1.fence.unreadable = false
	w.run(500 * time.Millisecond)
	role := d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role
	if role != availabilitylease.RoleRecovering && role != availabilitylease.RoleHolding {
		t.Fatalf("restarted holder role %s once the records are readable, want recovering or holding\n%s", role, w.dump())
	}
	w.waitServing("d1", 10*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if w.lastIndexOf("d1 docker stop") > restart || w.lastIndexOf("d1 docker kill") > restart || w.holderOf() != "d1" {
		t.Fatalf("the recovered copy must keep serving\n%s", w.dump())
	}
}

// Unreadable records do not hold the daemon's start (its relays and links wait for Prime) for the whole prime wait: on
// the stand that added five seconds to every link cut of a switch to a non-root daemon.
func TestPrimeDoesNotWaitOutUnreadableRecords(t *testing.T) {
	previous := primeUnreadableWait
	primeUnreadableWait = 100 * time.Millisecond
	t.Cleanup(func() { primeUnreadableWait = previous })
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.fence.unreadable = true
	w.restartDaemon("d1")
	started := time.Now()
	d1.runtime.Prime(3 * time.Second)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Prime waited %s with unreadable records", elapsed)
	}
}

func TestStartupKillsContainerWithoutRecord(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	for id := range d1.fence.records {
		delete(d1.fence.records, id) // lost tmpfs record: no budget is known
	}
	w.restartDaemon("d1")
	w.run(150 * time.Millisecond)
	requireKilledAtStart(t, w, "d1")
}

// requireKilledAtStart checks the first container action after the restart
// is an immediate kill (grace 0). The node may later re-acquire its own key
// and start again under a fresh lease, which is correct.
func requireKilledAtStart(t *testing.T, w *world, id string) {
	t.Helper()
	restart := w.lastIndexOf(id + " daemon restarted")
	kill := w.lastIndexOf(id + " docker stop")
	if kill < restart || !strings.Contains(w.log[kill], "grace=0s") || w.daemon(id).engine.running() {
		t.Fatalf("an unfenced container must be killed at daemon start (A2.3)\n%s", w.dump())
	}
}

func TestStartupKillsContainerWithStaleRecord(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.watchdogOn = false // the daemon alone must enforce A2.3 here
	for id, record := range d1.fence.records {
		record.DeadlineNs = int64(w.clock.now - time.Second)
		d1.fence.records[id] = record
	}
	w.restartDaemon("d1")
	w.run(150 * time.Millisecond)
	requireKilledAtStart(t, w, "d1")
}

func TestStartupKillsWhenWatchdogIsMissing(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.fence.removeWatchdog()
	w.restartDaemon("d1")
	w.run(150 * time.Millisecond)
	requireKilledAtStart(t, w, "d1")
	w.run(60 * time.Second)
	if d1.engine.running() {
		t.Fatalf("without a watchdog the daemon must never start a lease-mode container\n%s", w.dump())
	}
}

// N2: a fresh process reports the named holder's bootstrap reservation
// pending until it hears a commit. Once the bootstrap committed, the live
// records prove the lease was held: the running copy is recovered, never
// stopped as unowned.
func TestBootstrapHolderRecoversItsCopyAfterTheBootstrapCommitted(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, bootstrap: "d2"})
	w.daemon("d1").addContainer(testPolicy, false)
	w.daemon("d2").addContainer(testPolicy, true)
	w.waitServing("d2", 45*time.Second)
	w.run(3 * time.Second)
	d2 := w.restartDaemon("d2")
	w.run(500 * time.Millisecond)
	role := d2.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role
	if !d2.engine.running() || (role != availabilitylease.RoleRecovering && role != availabilitylease.RoleHolding) {
		t.Fatalf("the bootstrap holder's copy must be recovered after a restart, role %s\n%s", role, w.dump())
	}
	w.run(60 * time.Second)
	w.requireClean()
	if w.lastIndexOf("d2 docker stop") > w.lastIndexOf("d2 daemon restarted") || w.holderOf() != "d2" || !d2.engine.running() {
		t.Fatalf("the recovered bootstrap holder must keep serving without a restart\n%s", w.dump())
	}
}

func TestStartupRecoversWithASlowWatchdog(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	d1.fence.lag = leasefence.HeartbeatMaxAge + 2*time.Second
	w.restartDaemon("d1")
	w.run(5 * time.Second)
	d1.fence.lag = 0
	w.run(30 * time.Second)
	w.requireClean()
	if w.lastIndexOf("d1 docker stop") > w.lastIndexOf("d1 daemon restarted") || w.holderOf() != "d1" {
		t.Fatalf("a slow watchdog at daemon start must not kill a recoverable container\n%s", w.dump())
	}
}

func TestBootstrapHolderKeepsLegacyCopyAcrossRestart(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, bootstrap: "d2"})
	w.daemon("d1").addContainer(testPolicy, false)
	legacy := w.daemon("d2").addContainer(testPolicy, true)
	w.run(5 * time.Second)
	w.restartDaemon("d2")
	w.run(5 * time.Second)
	if !legacy.Running {
		t.Fatalf("the named bootstrap holder's legacy copy must keep running while it acquires (A5)\n%s", w.dump())
	}
	w.waitServing("d2", 45*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if w.daemon("d1").engine.running() {
		t.Fatal("a non-named candidate acquired a reserved bootstrap key")
	}
}
