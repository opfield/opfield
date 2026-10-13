package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// relinquishWorld: three voting relays, a non-voting relay r4 that is a member
// of the manifest (it carries no traffic of its own here), candidates d1 and
// d2 and two voting daemons.
func relinquishWorld(t *testing.T) *simWorld {
	return newScenario(t, scenarioSpec{
		relays:     append(voterRelays(1, "r1", "r2", "r3"), nodeSpec{id: "r4"}),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "d3", voter: true}, {id: "d4", voter: true}},
		candidates: []string{"d1", "d2"},
	})
}

func (w *simWorld) startAllBut(skip string) {
	for _, id := range w.ids {
		if id != skip {
			w.nodes[id].start()
		}
	}
}

// finalReleaseOf records the local time of node's first FINAL release of key
// and, at that moment, whether relay's gate admitted node.
type finalRelease struct {
	sent     bool
	at       time.Duration
	gateOpen bool
}

func (w *simWorld) watchFinal(node, relay string) *finalRelease {
	final := &finalRelease{}
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		if from != node || final.sent {
			return
		}
		for _, item := range batch.GetItems() {
			if rel := item.GetRelease(); rel != nil && rel.GetPhase() == pb.LeaseReleasePhase_LEASE_RELEASE_PHASE_FINAL {
				final.sent, final.at = true, w.nodes[node].local()
				if r := w.nodes[relay]; relay != "" && r.processUp() && r.node != nil {
					decision := r.node.Gate(keyP1)
					final.gateOpen = decision.Open && decision.Holder == node
				}
				return
			}
		}
	}
	return final
}

func handoffAt(t *testing.T, w *simWorld, node string) time.Duration {
	t.Helper()
	events := w.eventsOf(node, EventHandoff)
	if len(events) != 1 {
		t.Fatalf("%s handoff events: %d", node, len(events))
	}
	return events[0].event.At
}

// C-2: a member relay that got no propose from the holder within
// RelinquishWait has no open gate for it, so a planned handoff does not wait
// for its relinquish ack. A relay that got a propose is waited for until
// RelinquishWait after that propose, as before.
func TestRelinquishWaitsOnlyForRelaysProposedToWithinTheWindow(t *testing.T) {
	t.Run("offline member relay is not waited for", func(t *testing.T) {
		w := relinquishWorld(t)
		log := w.watchContainers()
		w.startAllBut("r4")
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 35*time.Second)
		if _, ok := w.nodes["d1"].node.proposers[keyP1].proposedAt["r4"]; ok {
			t.Fatal("d1 proposed to a relay that never ran")
		}
		final := w.watchFinal("d1", "")
		if !w.nodes["d1"].beginDrain(keyP1, "d2") {
			t.Fatal("drain did not start")
		}
		w.waitHolderIs(t, keyP1, "d2", 20*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 0)
		if !final.sent {
			t.Fatal("no final release")
		}
		if wait := final.at - handoffAt(t, w, "d1"); wait > 2*time.Second {
			t.Fatalf("final release %s after the handoff; the offline relay was waited for", wait)
		}
	})

	t.Run("silent relay is waited for RelinquishWait after its last propose", func(t *testing.T) {
		w := relinquishWorld(t)
		log := w.watchContainers()
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 35*time.Second)
		w.isolate("r4", true)
		w.runUntil(w.now + 10*time.Second)
		d1 := w.nodes["d1"]
		last, ok := d1.node.proposers[keyP1].proposedAt["r4"]
		if !ok || d1.local()-last < 9*time.Second {
			t.Fatalf("r4's last propose at %s, now %s", last, d1.local())
		}
		final := w.watchFinal("d1", "r4")
		if !d1.beginDrain(keyP1, "d2") {
			t.Fatal("drain did not start")
		}
		w.waitHolderIs(t, keyP1, "d2", 40*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 0)
		if !final.sent {
			t.Fatal("no final release")
		}
		if final.at < last+RelinquishWait || final.at > last+RelinquishWait+2*time.Second {
			t.Fatalf("final release at %s, want just after %s (last propose to r4 + RelinquishWait)", final.at, last+RelinquishWait)
		}
		if final.gateOpen {
			t.Fatal("r4 still admitted d1 when it sent the final release")
		}
	})

	t.Run("relays acked: no wait", func(t *testing.T) {
		w := relinquishWorld(t)
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 35*time.Second)
		final := w.watchFinal("d1", "")
		w.nodes["d1"].beginDrain(keyP1, "d2")
		w.waitHolderIs(t, keyP1, "d2", 20*time.Second)
		w.requireClean(t)
		if wait := final.at - handoffAt(t, w, "d1"); !final.sent || wait > 2*time.Second {
			t.Fatalf("final release sent=%v %s after the handoff", final.sent, wait)
		}
	})
}

// A restarted daemon does not know the proposes of its previous process: it
// waits RelinquishWait from its start (Recover) for every relay that did not
// ack, as before; later, only for relays it proposed to.
func TestRelinquishAfterRestartWaitsFromTheRecover(t *testing.T) {
	restart := func(t *testing.T) (*simWorld, time.Duration) {
		w := relinquishWorld(t)
		w.startAllBut("r4")
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 35*time.Second)
		d1 := w.nodes["d1"]
		d1.stopProcess()
		w.runUntil(w.now + time.Second)
		d1.start()
		recovered := d1.local()
		if !w.waitFor(10*time.Second, func() bool { return d1.node.HolderStatus(keyP1).Role == RoleHolding }) {
			t.Fatalf("d1 did not renew after the restart: %v", d1.node.HolderStatus(keyP1).Role)
		}
		return w, recovered
	}
	t.Run("handoff right after the restart", func(t *testing.T) {
		w, recovered := restart(t)
		final := w.watchFinal("d1", "")
		w.nodes["d1"].beginDrain(keyP1, "d2")
		w.waitHolderIs(t, keyP1, "d2", 40*time.Second)
		w.requireClean(t)
		if !final.sent || final.at < recovered+RelinquishWait || final.at > recovered+RelinquishWait+2*time.Second {
			t.Fatalf("final release sent=%v at %s, want just after %s (restart + RelinquishWait)", final.sent, final.at, recovered+RelinquishWait)
		}
	})
	t.Run("handoff long after the restart", func(t *testing.T) {
		w, _ := restart(t)
		w.runUntil(w.now + 40*time.Second)
		final := w.watchFinal("d1", "")
		w.nodes["d1"].beginDrain(keyP1, "d2")
		w.waitHolderIs(t, keyP1, "d2", 20*time.Second)
		w.requireClean(t)
		if wait := final.at - handoffAt(t, w, "d1"); !final.sent || wait > 2*time.Second {
			t.Fatalf("final release sent=%v %s after the handoff", final.sent, wait)
		}
	})
}

// A propose that reaches the relay late anchors its gate at the relay's
// promise, which came before the holder sent that propose, so the wait from
// the send time still covers it: the late gate is closed by the final
// release, and the successor is never admitted alongside.
func TestRelinquishCoversALateDeliveredPropose(t *testing.T) {
	w := relinquishWorld(t)
	log := w.watchContainers()
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 35*time.Second)
	held := false
	r4 := w.nodes["r4"]
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		if (from == "r4" && to == "d1") || (from == "d1" && to == "r4" && held) {
			return held
		}
		if from != "d1" || to != "r4" {
			return false
		}
		for _, item := range batch.GetItems() {
			if item.GetPropose() != nil {
				held = true
				w.after(20*time.Second, func() { r4.deliver("d1", batch, nil) })
				return true
			}
		}
		return false
	}
	if !w.waitFor(10*time.Second, func() bool { return held }) {
		t.Fatal("no propose to r4")
	}
	d1 := w.nodes["d1"]
	last := d1.node.proposers[keyP1].proposedAt["r4"]
	final := w.watchFinal("d1", "r4")
	if !d1.beginDrain(keyP1, "d2") {
		t.Fatal("drain did not start")
	}
	w.waitHolderIs(t, keyP1, "d2", 40*time.Second)
	w.runUntil(w.now + 30*time.Second)
	w.requireClean(t)
	requireGap(t, *log, "d1", "d2", 0)
	if !final.sent || final.at < last+RelinquishWait {
		t.Fatalf("final release sent=%v at %s, before %s (late propose to r4 + RelinquishWait)", final.sent, final.at, last+RelinquishWait)
	}
	if final.gateOpen {
		t.Fatal("r4 still admitted d1 when it sent the final release")
	}
	if decision := r4.node.Gate(keyP1); decision.Open && decision.Holder == "d1" {
		t.Fatal("the late propose left r4's gate open for d1")
	}
}
