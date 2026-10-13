package lease

import (
	"testing"
	"time"
)

func TestHealthCooldownBacksOffUntilTheCopyStaysUp(t *testing.T) {
	wl := &workload{serveIDs: map[string]bool{"copy-1": true}}
	now := time.Hour
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 160 * time.Second, 5 * time.Minute, 5 * time.Minute}
	for i, expected := range want {
		// Each copy fails a minute after it started.
		wl.servingSince = now - time.Minute
		if got := healthCooldown(wl, now); got != expected {
			t.Fatalf("release %d: cooldown %s, want %s", i+1, got, expected)
		}
		now += 2 * time.Minute
	}
	// A copy that served for healthStableAfter starts over at the base.
	wl.servingSince = now - healthStableAfter
	if got := healthCooldown(wl, now); got != healthCooldownBase {
		t.Fatalf("cooldown after a stable copy %s, want %s", got, healthCooldownBase)
	}
}

// The backoff belongs to one copy: after a rollout replaced the containers
// that kept failing, the first failure of the new copy is healed after the
// base cooldown, not after the doubled one of the old copy.
func TestHealthCooldownStartsOverForANewCopy(t *testing.T) {
	wl := &workload{serveIDs: map[string]bool{"old-copy": true}}
	now := time.Hour
	for range 3 {
		wl.servingSince = now - time.Minute
		healthCooldown(wl, now)
		now += time.Minute
	}
	wl.serveIDs = map[string]bool{"new-copy": true}
	wl.servingSince = now - 2*time.Minute
	if got := healthCooldown(wl, now); got != healthCooldownBase {
		t.Fatalf("first release of a new copy: cooldown %s, want %s", got, healthCooldownBase)
	}
	// The same copy restarted in place keeps backing off.
	now += time.Minute
	wl.servingSince = now - time.Minute
	if got := healthCooldown(wl, now); got != 2*healthCooldownBase {
		t.Fatalf("second release of the same copy: cooldown %s, want %s", got, 2*healthCooldownBase)
	}
}

// A killed replica of a replicated policy whose other candidate holds
// the other slot is started again on its own node in well under a minute
// (it took 68 s with the fixed 60 s cooldown).
func TestKilledReplicaRestartsInPlaceWithinHalfAMinute(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, slots: 2})
	w.daemon("d1").addContainer(testPolicy, false)
	w.daemon("d2").addContainer(testPolicy, false)
	w.waitServing("d1", 60*time.Second)
	w.waitServing("d2", 60*time.Second)
	w.run(10 * time.Second)
	d2 := w.daemon("d2")
	for _, c := range d2.engine.containers {
		c.Running = false
	}
	w.logf("d2 container killed")
	killedAt := w.clock.now
	if !w.runUntil(60*time.Second, func() bool { return d2.engine.running() }) {
		t.Fatalf("the killed replica was not started again within a minute\n%s", w.dump())
	}
	healed := w.clock.now - killedAt
	if healed > 35*time.Second {
		t.Fatalf("the killed replica was started again after %s, want at most 35 s\n%s", healed, w.dump())
	}
	t.Logf("killed replica started again after %s", healed)
	w.waitServing("d2", 15*time.Second)
	w.requireClean()
	if !w.daemon("d1").engine.running() {
		t.Fatal("the other replica stopped")
	}
}

// Opfield asks the holder to release for its failing HTTP health check: in
// Failover the standby takes over, the released node does not take the slot
// back, and a node that does not hold refuses the request.
func TestReleaseUnhealthyHandsTheSlotToTheStandby(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	if d2.runtime.ReleaseUnhealthy(testPolicy, "fails its HTTP health check") {
		t.Fatal("a standby accepted a health release")
	}
	if !d1.runtime.ReleaseUnhealthy(testPolicy, "fails its HTTP health check") {
		t.Fatal("the holder refused a health release")
	}
	w.waitServing("d2", 30*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if d1.engine.running() || w.holderOf() != "d2" {
		t.Fatalf("the released holder took the slot back\n%s", w.dump())
	}
	if w.indexOf("d1 endpoints serving=false") > w.indexOf("d1 docker stop") {
		t.Fatal("the holder stopped its container before deregistering its endpoint")
	}
}
