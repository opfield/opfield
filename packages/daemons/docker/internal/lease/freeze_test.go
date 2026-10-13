package lease

import (
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

// D4, B-7: the wall clock is never evidence of a freeze. NTP steps in either
// direction and of any size leave a holder alone.
func TestWallClockStepNeverFences(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	for _, step := range []time.Duration{100 * time.Second, -100 * time.Second, 116 * time.Second, -10 * time.Minute, time.Hour} {
		w.wallJump += step
		w.logf("wall clock stepped by %s", step)
		w.run(3 * time.Second)
	}
	w.run(20 * time.Second)
	w.requireClean()
	if w.indexOf("d1 docker stop") >= 0 || w.holderOf() != "d1" || !w.daemon("d1").engine.running() {
		t.Fatalf("a wall-clock step fenced the holder\n%s", w.dump())
	}
	for _, event := range w.daemon("d1").runtime.Report().Events {
		if event.Kind == string(availabilitylease.EventFence) {
			t.Fatalf("fence event after a wall-clock step: %+v", event)
		}
	}
}

// Scenario i: the holder's VM is frozen past the failover. It learns of the
// freeze from the first frame of a peer after the resume (a relay beacon) and
// kills its copy at once, without waiting for its frozen budget.
func TestFrozenHolderFencesAtTheFirstFrameAfterResume(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	w.freeze(d1, 100*time.Second)
	if !w.daemon("d2").engine.running() {
		t.Fatalf("no takeover during the freeze\n%s", w.dump())
	}
	resumed := w.clock.now
	if !w.runUntil(1500*time.Millisecond, func() bool { return !d1.engine.running() }) {
		t.Fatalf("resumed holder still runs %s after the resume\n%s", w.clock.now-resumed, w.dump())
	}
	stop := w.lastIndexOf("d1 docker stop")
	if stop < 0 || !strings.Contains(w.log[stop], "grace=0s") {
		t.Fatalf("a copy whose budget ran out during the freeze must be killed without grace\n%s", w.dump())
	}
	w.run(30 * time.Second)
	w.requireClean()
	assertFenceReason(t, w, "d1", availabilitylease.FenceFrozen)
	if w.holderOf() != "d2" || !w.daemon("d2").engine.running() {
		t.Fatalf("the successor was disturbed by the resumed holder, holder %q\n%s", w.holderOf(), w.dump())
	}
}

// Scenario i2 (B-11): the resumed holder reaches only a relay that missed the
// failover. No voter answers and the relay has no newer commit, so only its
// clock tells: the holder stops within about a second, not after its
// remaining budget.
func TestFrozenHolderReachingOnlyAStaleRelayStopsAtOnce(t *testing.T) {
	w := newWorld(t, worldSpec{
		relays: []string{"r1", "r2"}, daemons: []string{"d1", "d2", "d3"},
		candidates: []string{"d1", "d2", "d3"}, voters: []string{"d1", "d2", "d3"},
	})
	for _, id := range []string{"d1", "d2", "d3"} {
		w.daemon(id).addContainer(testPolicy, false)
	}
	w.waitServing("d1", 45*time.Second)
	w.run(4 * time.Second)
	d1 := w.daemon("d1")
	// r2 stops shortly before the VM freezes and misses the failover.
	for _, relay := range w.relays {
		if relay.id == "r2" {
			relay.down = true
		}
	}
	w.run(9 * time.Second)
	w.freeze(d1, 116*time.Second)
	for _, relay := range w.relays {
		if relay.id == "r2" {
			relay.down = false
		}
	}
	for _, id := range []string{"r1", "d2", "d3"} {
		w.block("d1", id, true)
	}
	if !w.daemon("d2").engine.running() {
		t.Fatalf("no takeover during the freeze\n%s", w.dump())
	}
	resumed := w.clock.now
	if !w.runUntil(1500*time.Millisecond, func() bool { return !d1.engine.running() }) {
		t.Fatalf("resumed holder reaching only a stale relay still runs %s after the resume\n%s", w.clock.now-resumed, w.dump())
	}
	w.run(20 * time.Second)
	w.requireClean()
	assertFenceReason(t, w, "d1", availabilitylease.FenceFrozen)
}

// A resumed holder that reaches nobody has no evidence of the freeze: it
// fences on its own timer within its remaining budget, and learns nothing new
// when the network returns (its lease is gone already).
func TestFrozenHolderReachingNobodyFencesOnItsTimer(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	w.freeze(d1, 100*time.Second)
	d1.cut = true
	d1.residualUntil = w.clock.now + availabilitylease.FenceCompleteAfter
	resumed := w.clock.now
	if !w.runUntil(availabilitylease.FenceCompleteAfter, func() bool { return !d1.engine.running() }) {
		t.Fatalf("isolated resumed holder outlived its budget\n%s", w.dump())
	}
	if took := w.clock.now - resumed; took > availabilitylease.SoftFenceAfter+time.Second {
		t.Fatalf("isolated resumed holder stopped %s after the resume, beyond its soft fence", took)
	}
	assertFenceReason(t, w, "d1", availabilitylease.FenceTimer)
	d1.cut = false
	w.run(20 * time.Second)
	w.requireClean()
	if w.holderOf() != "d2" || d1.engine.running() {
		t.Fatalf("holder %q after the network returned\n%s", w.holderOf(), w.dump())
	}
}

// B-7: a lease acquired after a detected freeze is never fenced for it, not
// by a late frame from a peer that was silent since before the freeze, and
// not by the NTP step that finally corrects the wall clock.
func TestLeaseAcquiredAfterADetectedFreezeIsNeverFencedForIt(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	// r3 goes silent for d1 just before the freeze.
	w.block("d1", "r3", true)
	w.run(2 * time.Second)
	w.freeze(d1, 100*time.Second)
	w.run(5 * time.Second)
	assertFenceReason(t, w, "d1", availabilitylease.FenceFrozen)
	// The holder hands the key back (a priority failback).
	if err := w.daemon("d2").runtime.Handoff(handoffRequest(w, "d1")); err != nil {
		t.Fatal(err)
	}
	w.waitServing("d1", 30*time.Second)
	fences := countFences(w, "d1")
	// r3's first frame since before the freeze, 20 s of local time later.
	w.block("d1", "r3", false)
	w.run(5 * time.Second)
	// NTP steps the VM clock forward by the frozen time, minutes later.
	w.run(2 * time.Minute)
	w.wallJump += 100 * time.Second
	w.run(10 * time.Second)
	w.requireClean()
	if got := countFences(w, "d1"); got != fences || w.holderOf() != "d1" || !d1.engine.running() {
		t.Fatalf("lease acquired after the freeze was fenced (fences %d -> %d, holder %q)\n%s", fences, got, w.holderOf(), w.dump())
	}
}

func assertFenceReason(t *testing.T, w *world, id string, reason availabilitylease.FenceReason) {
	t.Helper()
	for _, line := range w.fenceLog(id) {
		if line == string(reason) {
			return
		}
	}
	t.Fatalf("%s did not fence with %q (fences %v)\n%s", id, reason, w.fenceLog(id), w.dump())
}

func countFences(w *world, id string) int { return len(w.fenceLog(id)) }

// B-9 (scenario l): after the watchdog is lost the holder kills its copy and,
// once the kill is confirmed, releases the key: the successor starts at once
// instead of waiting for the acceptors' hold to lapse.
func TestLostWatchdogReleasesOnlyAfterTheConfirmedKill(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.fence.heartbeat = false
	w.logf("d1 watchdog died")
	if !w.runUntil(20*time.Second, func() bool { return !d1.engine.running() }) {
		t.Fatalf("holder kept its copy without a watchdog\n%s", w.dump())
	}
	killed := w.clock.now
	w.waitServing("d2", 10*time.Second)
	if took := w.clock.now - killed; took > 5*time.Second {
		t.Fatalf("successor served %s after the confirmed kill; the release must let it start at once\n%s", took, w.dump())
	}
	w.requireClean()
	empty, started := w.indexOf("d1 cgroup empty"), w.lastIndexOf("d2 docker start")
	if empty < 0 || empty > started {
		t.Fatalf("successor started before the holder's cgroup was confirmed empty\n%s", w.dump())
	}
	events := d1.runtime.Report().Events
	fenceAt, releaseAt := -1, -1
	for i, event := range events {
		switch event.Kind {
		case string(availabilitylease.EventFence):
			if event.Reason != string(availabilitylease.FenceWatchdogLost) {
				t.Fatalf("fence reason %q, want %q", event.Reason, availabilitylease.FenceWatchdogLost)
			}
			fenceAt = i
		case string(availabilitylease.EventReleased):
			releaseAt = i
		}
	}
	if fenceAt < 0 || releaseAt < fenceAt {
		t.Fatalf("want a watchdog fence followed by a release, have %+v", events)
	}
}

// A kill that cannot be confirmed never releases (A6): with the watchdog gone
// and dockerd refusing the kill, the key is abandoned but not released.
func TestLostWatchdogWithUnconfirmedKillNeverReleases(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.watchdogOn = false
	d1.fence.heartbeat = false
	d1.engine.stopFails = true
	w.run(40 * time.Second)
	if !d1.engine.running() {
		t.Fatalf("the fake refused kill did not hold\n%s", w.dump())
	}
	sawFence := false
	for _, event := range d1.runtime.Report().Events {
		switch event.Kind {
		case string(availabilitylease.EventReleased), string(availabilitylease.EventHandoff):
			t.Fatalf("released without a confirmed stop: %+v", event)
		case string(availabilitylease.EventFence):
			sawFence = true
		}
	}
	if !sawFence {
		t.Fatal("the holder did not stop renewing without a watchdog")
	}
}
