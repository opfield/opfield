package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

var keyP1 = Key{PolicyID: "p1"}

func voterRelays(rate float64, ids ...string) []nodeSpec {
	var out []nodeSpec
	for _, id := range ids {
		out = append(out, nodeSpec{id: id, rate: rate, voter: true})
	}
	return out
}

// requireGap asserts the old holder's container died at least margin before
// the new holder's container started.
func requireGap(t *testing.T, log []containerEvent, oldHolder, newHolder string, margin time.Duration) {
	t.Helper()
	died, ok := lastChange(log, oldHolder, false)
	if !ok {
		t.Fatalf("%s container never died", oldHolder)
	}
	started, ok := firstChange(log, newHolder, true, died)
	if !ok {
		t.Fatalf("%s container never started after %s died", newHolder, oldHolder)
	}
	if started-died < margin {
		t.Fatalf("%s started %s after %s died; want at least %s", newHolder, started-died, oldHolder, margin)
	}
}

// R1: the fence counts from the send time of the last successful round and
// completes by 24 s local, so a 10% slow holder is dead before 10% fast
// acceptors let anyone else in, even with delayed acks.
func TestR1FenceAnchoredAtSendTimeFastAcceptorsSlowHolder(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     voterRelays(1+MaxClockDrift, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1", rate: 1 - MaxClockDrift}, {id: "d2", rate: 1 + MaxClockDrift}},
		candidates: []string{"d1", "d2"},
	})
	log := w.watchContainers()
	w.startAll()
	if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
		t.Fatalf("holder %s, want d1", holder)
	}
	// Delay every ack to d1 by 1.2 s each way: rounds still succeed, and the
	// deadline must stay anchored before the prepare was sent.
	for _, r := range w.relays {
		l := w.link("d1", r)
		l.minDelay, l.maxDelay = 1200*time.Millisecond, 1300*time.Millisecond
	}
	d1 := w.nodes["d1"]
	var checked bool
	w.observers = append(w.observers, func() {
		pk := d1.node.proposers[keyP1]
		if pk != nil && pk.role == RoleHolding && pk.round == nil && pk.deadline != pk.anchor+FenceCompleteAfter {
			t.Errorf("deadline %s is not anchor %s + %s", pk.deadline, pk.anchor, FenceCompleteAfter)
		}
		if pk != nil && pk.role == RoleHolding && pk.round == nil && d1.local()-pk.anchor >= 2400*time.Millisecond {
			checked = true
		}
	})
	w.runUntil(w.now + 20*time.Second)
	if !checked {
		t.Fatal("no renewal completed with its deadline anchored at least one delayed round trip before completion")
	}
	w.isolate("d1", true)
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.requireClean(t)
	requireGap(t, *log, "d1", "d2", 3*time.Second)
}

// R2: the fence does not depend on the daemon process, on dockerd, or on a
// restart policy; a frozen VM is refused by the relays after it resumes.
func TestR2FenceIndependentOfDaemonDockerdAndClock(t *testing.T) {
	spec := scenarioSpec{
		relays:     voterRelays(1+MaxClockDrift, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1", rate: 1 - MaxClockDrift}, {id: "d2", rate: 1}},
		candidates: []string{"d1", "d2"},
	}
	setup := func(t *testing.T) (*simWorld, *[]containerEvent) {
		w := newScenario(t, spec)
		log := w.watchContainers()
		w.startAll()
		if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
			t.Fatalf("holder %s, want d1", holder)
		}
		w.runUntil(w.now + 7*time.Second)
		return w, log
	}
	t.Run("daemon deadlock", func(t *testing.T) {
		w, log := setup(t)
		w.nodes["d1"].stopProcess() // renewer and fencer stuck; watchdog alive
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 3*time.Second)
	})
	t.Run("daemon down longer than the budget", func(t *testing.T) {
		w, log := setup(t)
		d1 := w.nodes["d1"]
		d1.stopProcess()
		w.runUntil(w.now + 40*time.Second)
		d1.start()
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		w.runUntil(w.now + 20*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 3*time.Second)
	})
	t.Run("dockerd hung", func(t *testing.T) {
		w, log := setup(t)
		w.nodes["d1"].hangUntil = w.now + time.Hour
		w.isolate("d1", true)
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 3*time.Second)
	})
	t.Run("host reboot does not restart the container", func(t *testing.T) {
		w, _ := setup(t)
		d1 := w.nodes["d1"]
		d1.crashHost()
		w.runUntil(w.now + 5*time.Second)
		d1.bootHost()
		w.observers = append(w.observers, func() {
			if c := d1.containers[keyP1]; c != nil && c.live && !d1.node.HolderStatus(keyP1).Holding {
				t.Errorf("container on d1 runs without the lease after reboot")
			}
		})
		w.runUntil(w.now + 90*time.Second)
		w.requireClean(t)
	})
	t.Run("VM suspend", func(t *testing.T) {
		w, _ := setup(t)
		d1 := w.nodes["d1"]
		d1.freeze()
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		resumed := w.now
		d1.resume()
		w.runUntil(w.now + 2*time.Second)
		st := d1.node.HolderStatus(keyP1)
		if st.Holding || (d1.containers[keyP1].live && !d1.containers[keyP1].stopping) {
			t.Fatalf("resumed d1 still serving %s after resume: %+v", w.now-resumed, st)
		}
		w.runUntil(w.now + 30*time.Second)
		w.requireClean(t)
	})
}

// R3: an acceptor that loses its state (relay.db renamed) or restarts on
// another boot abstains for T x 1.1; one restarted within the same boot
// restores the persisted hold of its last accept instead. Either way
// holder H's lease cannot be taken by P through that acceptor.
func TestR3AcceptorRestartAbstainsAndPersistsBallots(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "r1"}},
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "a", voter: true}, {id: "b", voter: true}, {id: "c", voter: true}},
		candidates: []string{"d1", "d2"},
	})
	log := w.watchContainers()
	// C never hears from H.
	w.drop = func(from, to string, _ *pb.LeaseBatch) bool { return from == "d1" && to == "c" }
	w.startAll()
	if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
		t.Fatalf("holder %s, want d1", holder)
	}
	a := w.nodes["a"]
	promised := a.node.acceptors[keyP1].rec.Promised
	incarnation := a.node.Incarnation()
	restartProcess(w, a, false, 3*time.Second)
	w.runUntil(w.now + 3*time.Second + time.Millisecond)
	if got := a.node.acceptors[keyP1].rec.Promised; got.Less(promised) {
		t.Fatalf("promised ballot not persisted: %s < %s", got, promised)
	}
	if a.node.Incarnation() <= incarnation {
		t.Fatal("incarnation did not increase on restart")
	}
	// A restart within the same boot keeps voting, holding the key for the
	// proposer of its last promise instead of abstaining.
	if !a.node.voting("p1", a.local()) {
		t.Fatal("an acceptor restarted within the same boot abstains")
	}
	if lease := a.node.acceptors[keyP1].lease; lease.holder != "d1" || !lease.openAt(a.local()) {
		t.Fatalf("restarted acceptor holds %+v, want the holder d1", lease)
	}
	w.runUntil(w.now + time.Second)
	restartProcess(w, a, true, 3*time.Second) // relay.db renamed
	w.runUntil(w.now + 4*time.Second)
	if a.node.voting("p1", a.local()) {
		t.Fatal("acceptor with fresh state votes during its abstention window")
	}
	w.waitHolderIs(t, keyP1, "d2", 120*time.Second)
	w.requireClean(t)
	requireGap(t, *log, "d1", "d2", 0)
}

// R4: a stale-epoch proposer cannot win with removed voters, and a newer
// manifest spreads from the proposer instead of blocking failover.
func TestR4EpochChangeRejectsStaleProposerAndSpreadsNewerManifest(t *testing.T) {
	t.Run("stale epoch proposer", func(t *testing.T) {
		w := newScenario(t, scenarioSpec{
			relays: []nodeSpec{{id: "r1"}},
			daemons: []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "A", voter: true}, {id: "B", voter: true}, {id: "C", voter: true},
				{id: "D"}, {id: "E"}},
			candidates: []string{"d1", "d2"},
		})
		w.startAll()
		if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
			t.Fatalf("holder %s, want d1", holder)
		}
		// P (d2) and B never hear from Opfield again.
		policy := w.gw.policies["p1"]
		policy.epoch, policy.sets = 2, [][]string{{"A", "B", "C"}, {"C", "D", "E"}}
		joint := w.gw.buildManifest(policy)
		for _, id := range []string{"d1", "A", "C", "D", "E", "r1"} {
			w.gw.adopt(w.nodes[id], joint)
		}
		w.runUntil(w.now + 50*time.Second)
		policy.epoch, policy.sets = 3, [][]string{{"C", "D", "E"}}
		settled := w.gw.buildManifest(policy)
		for _, id := range []string{"d1", "C", "D", "E", "r1"} {
			w.gw.adopt(w.nodes[id], settled)
		}
		// d2 still believes epoch 1 = {A, B, C}; A and B no longer get
		// renewals, so H's lease lapses there.
		w.observers = append(w.observers, func() {
			if w.nodes["d2"].node.HolderStatus(keyP1).Holding && w.nodes["d1"].hostUp {
				t.Errorf("stale-epoch proposer acquired while the holder is alive")
			}
		})
		w.runUntil(w.now + 120*time.Second)
		w.requireClean(t)
		if holder := w.holder(keyP1); holder != "d1" {
			t.Fatalf("holder %s, want d1 to keep the lease", holder)
		}
		w.nodes["d1"].crashHost()
		killed := w.now
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		if w.now-killed > failoverBudget+2*time.Second {
			t.Fatalf("failover took %s", w.now-killed)
		}
		if w.nodes["d2"].node.Epoch("p1") != policy.epoch {
			t.Fatal("successor did not adopt the settled epoch from forwarded blocks")
		}
		w.requireClean(t)
	})
	t.Run("newer manifest on the proposer only", func(t *testing.T) {
		w := newScenario(t, scenarioSpec{
			relays:     voterRelays(1, "r1", "r2", "r3"),
			daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}},
			candidates: []string{"d1", "d2"},
		})
		w.startAll()
		w.waitHolder(t, keyP1, 60*time.Second)
		v2 := w.gw.buildManifest(w.gw.policies["p1"])
		w.gw.adopt(w.nodes["d2"], v2)
		w.gw.alive = false
		w.nodes["d1"].crashHost()
		killed := w.now
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		if w.now-killed > failoverBudget+2*time.Second {
			t.Fatalf("failover took %s", w.now-killed)
		}
		for _, r := range w.relays {
			if v := w.nodes[r].node.ManifestVersion("p1"); v != 2 {
				t.Fatalf("relay %s has manifest v%d, want v2 adopted from the proposer", r, v)
			}
		}
		w.requireClean(t)
	})
}

// R5: bootstrap reservation, the lease-closed manifest, and the daemon-side
// gate.
func TestR5BootstrapReservationLeaseClosedAndDaemonGate(t *testing.T) {
	t.Run("bootstrap holder never receives the manifest", func(t *testing.T) {
		w := newScenario(t, scenarioSpec{
			relays:     voterRelays(1, "r1", "r2", "r3"),
			daemons:    []nodeSpec{{id: "x"}, {id: "b"}},
			candidates: []string{"b", "x"},
			bootstrap:  "x",
		})
		w.isolate("x", true)
		for _, id := range w.ids {
			if id != "x" {
				w.nodes[id].start()
			}
		}
		w.gw.alive = false
		w.nodes["x"].start()
		w.runUntil(w.now + 150*time.Second)
		w.requireClean(t)
		if st := w.nodes["b"].node.HolderStatus(keyP1); st.Holding || !w.nodes["x"].containers[keyP1].live {
			t.Fatalf("reservation broken: b=%+v", st)
		}
	})
	t.Run("lease closed and daemon gate", func(t *testing.T) {
		w := newScenario(t, scenarioSpec{
			relays:     voterRelays(1, "r1", "r2", "r3"),
			daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}},
			candidates: []string{"d1", "d2"},
		})
		w.startAll()
		if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
			t.Fatalf("holder %s, want d1", holder)
		}
		d2 := w.nodes["d2"].node
		if !d2.LeaseMode("p1") || d2.HolderStatus(keyP1).MayStart {
			t.Fatal("candidate without the lease may start in lease mode")
		}
		policy := w.gw.policies["p1"]
		policy.closed = true
		closed := w.gw.buildManifest(policy)
		for _, r := range w.relays {
			w.gw.adopt(w.nodes[r], closed)
		}
		start := w.now
		w.waitFor(8*time.Second, func() bool { return len(w.eventsOf("d1", EventFence)) > 0 })
		fences := w.eventsOf("d1", EventFence)
		if len(fences) == 0 || fences[0].event.Reason != FenceClosed || fences[0].at-start > RenewInterval+time.Second {
			t.Fatalf("holder did not fence on the lease-closed manifest within one renewal: %+v", fences)
		}
		if w.nodes["d1"].node.LeaseMode("p1") || w.nodes["r1"].node.Gate(keyP1).LeaseMode {
			t.Fatal("lease mode still active after the lease-closed manifest")
		}
		w.runUntil(w.now + 60*time.Second)
		if len(w.liveCopies(keyP1)) != 0 || d2.HolderStatus(keyP1).Holding {
			t.Fatal("a copy runs in lease mode after close")
		}
		w.requireClean(t)
	})
}
