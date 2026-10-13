package availabilitylease

import (
	"crypto/ed25519"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// closeWorld: three daemon candidates that are the voters, two non-voting
// relays; d1 holds.
func closeWorld(t *testing.T) *simWorld {
	t.Helper()
	w := newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "r1"}, {id: "r2"}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}, {id: "d3", voter: true}},
		candidates: []string{"d1", "d2", "d3"},
	})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	return w
}

// liveUntil fails when d's copy of key stops before end.
func requireCopyRunsThrough(t *testing.T, w *simWorld, id string, key Key, end time.Duration) {
	t.Helper()
	w.observers = append(w.observers, func() {
		if w.now > end {
			return
		}
		if c := w.nodes[id].containers[key]; c == nil || !c.live || c.stopping {
			t.Errorf("%s's copy of %s stopped at %s", id, key, w.now)
		}
	})
}

// Graceful close: the named holder keeps its copy running, a majority of the
// voters confirms, the watchdog deadline is disarmed, and nobody acquires.
func TestCloseRetainsTheServingCopy(t *testing.T) {
	w := closeWorld(t)
	requireCopyRunsThrough(t, w, "d1", keyP1, w.now+3*time.Minute)
	start := w.now
	w.gw.closeLease("p1", false, 1)
	if !w.waitFor(5*time.Second, func() bool { return w.nodes["d1"].node.HolderStatus(keyP1).Retained }) {
		t.Fatalf("holder not retained within 5 s\n%s", w.dumpTrace(60))
	}
	if retained := w.eventsOf("d1", EventRetained); len(retained) != 1 || retained[0].at-start > 3*time.Second {
		t.Fatalf("retained events %+v", retained)
	}
	if _, armed := w.nodes["d1"].watchdog[keyP1]; armed {
		t.Fatal("the retained copy's watchdog deadline is still armed")
	}
	w.runUntil(w.now + 3*time.Minute)
	w.requireClean(t)
	if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d1" {
		t.Fatalf("copies %v, want d1 only", copies)
	}
	if fences := w.eventsOf("d1", EventFence); len(fences) != 0 {
		t.Fatalf("retained holder fenced: %+v", fences)
	}
	for _, id := range []string{"d2", "d3"} {
		if st := w.nodes[id].node.HolderStatus(keyP1); st.Role != RoleNone && st.Role != RoleCandidate {
			t.Fatalf("%s is %s after the close", id, st.Role)
		}
	}
	for _, id := range w.relays {
		gate := w.nodes[id].node.Gate(keyP1)
		if gate.LeaseMode || gate.Holder != "d1" {
			t.Fatalf("relay %s gate after the close %+v: legacy admission naming the retained holder expected", id, gate)
		}
	}
}

// A holder the closed manifest does not name (Opfield's view was stale)
// fences at once; the named node, which has no copy, stays out.
func TestCloseFencesAHolderItDoesNotName(t *testing.T) {
	w := closeWorld(t)
	w.gw.closeLease("p1", true, 1)
	w.waitFor(3*time.Second, func() bool { return len(w.eventsOf("d1", EventFence)) > 0 })
	fences := w.eventsOf("d1", EventFence)
	if len(fences) == 0 || fences[0].event.Reason != FenceClosed {
		t.Fatalf("unnamed holder did not fence: %+v", fences)
	}
	w.runUntil(w.now + time.Minute)
	w.requireClean(t)
	if copies := w.liveCopies(keyP1); len(copies) != 0 {
		t.Fatalf("copies %v after closing without the holder named", copies)
	}
	for _, id := range w.daemons {
		if w.nodes[id].node.HolderStatus(keyP1).Retained {
			t.Fatalf("%s retained without a copy", id)
		}
	}
}

// Acceptors refuse the retention to anyone but the named holder, and to a
// named holder they know was superseded by another proposer.
func TestCloseRefusesAnyoneButTheNamedHolder(t *testing.T) {
	w := closeWorld(t)
	d1 := w.nodes["d1"]
	ballot := d1.node.HolderStatus(keyP1).Ballot
	w.gw.closeLease("p1", false, 1)
	w.runUntil(w.now + time.Second)
	var answers []*pb.LeaseItem
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		if from == "d2" && to == "d3" {
			answers = append(answers, batch.GetItems()...)
		}
	}
	version := w.nodes["d2"].node.ManifestVersion("p1")
	ask := &pb.LeaseRetain{Key: keyP1.proto(), Ballot: Ballot{Round: ballot.Round, Incarnation: 1, Proposer: "d3"}.proto(), ManifestVersion: version}
	w.injectFrom("d3", "d2", &pb.LeaseItem{Body: &pb.LeaseItem_Retain{Retain: ask}})
	w.runUntil(w.now + time.Second)
	refused := false
	for _, item := range answers {
		if nack := item.GetNack(); nack != nil && nack.GetReason() == pb.LeaseNackReason_LEASE_NACK_REASON_RETAIN_REFUSED {
			refused = true
		}
		if item.GetRetained() != nil {
			t.Fatal("an acceptor confirmed the close to a node the manifest does not name")
		}
	}
	if !refused {
		t.Fatalf("no refusal for the unnamed node: %v", answers)
	}

	// An acceptor that accepted another proposer after the named ballot.
	ak := w.nodes["d2"].node.acceptors[keyP1]
	stale := RetainedHolder{Holder: "d1", Ballot: ballot}
	ak.accepts[0] = acceptRecord{ballot: Ballot{Round: ballot.Round + 5, Incarnation: 1, Proposer: "d3"}, anchored: true}
	if !w.nodes["d2"].node.supersedesRetained(ak, stale, w.now) {
		t.Fatal("an accept of another proposer after the named ballot must refuse the retention")
	}
	ak.accepts[0] = acceptRecord{ballot: Ballot{Round: ballot.Round - 1, Incarnation: 1, Proposer: "d3"}, anchored: true}
	if w.nodes["d2"].node.supersedesRetained(ak, stale, w.now) {
		t.Fatal("an older accept of another proposer refused the retention")
	}
}

// A holder partitioned from the voters when the lease closes cannot get a
// confirming majority: it fences at its renewal timeout like any holder, and
// nobody acquires the closed key.
func TestClosePartitionedHolderFencesAtItsTimeout(t *testing.T) {
	w := closeWorld(t)
	d1 := w.nodes["d1"]
	d1.stopDelay = 300 * time.Millisecond
	w.isolate("d1", true) // Opfield still reaches it (CommandStream)
	w.gw.closeLease("p1", false, 1)
	start := w.now
	w.runUntil(w.now + FenceCompleteAfter + time.Second)
	fences := w.eventsOf("d1", EventFence)
	if len(fences) == 0 || fences[0].event.Reason != FenceClosed || fences[0].at-start > SoftFenceAfter+time.Second {
		t.Fatalf("partitioned holder did not fence at its timeout: %+v", fences)
	}
	if d1.node.HolderStatus(keyP1).Retained {
		t.Fatal("partitioned holder retained without a majority")
	}
	w.isolate("d1", false)
	w.runUntil(w.now + time.Minute)
	w.requireClean(t)
	if copies := w.liveCopies(keyP1); len(copies) != 0 {
		t.Fatalf("copies %v after a failed close", copies)
	}
}

// Joint voter sets: the confirmation needs a majority of every set.
func TestCloseNeedsAMajorityOfEveryQuorumSet(t *testing.T) {
	build := func(t *testing.T) *simWorld {
		w := newScenario(t, scenarioSpec{
			relays: []nodeSpec{{id: "r1"}},
			daemons: []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}, {id: "d3", voter: true},
				{id: "d4"}, {id: "d5"}},
			candidates: []string{"d1", "d2"},
		})
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 6*time.Second)
		// Joint: old set {d1,d2,d3}, new set {d1,d4,d5}.
		policy := w.gw.policies["p1"]
		policy.epoch++
		policy.sets = [][]string{{"d1", "d2", "d3"}, {"d1", "d4", "d5"}}
		w.gw.republish("p1", 1)
		w.runUntil(w.now + 6*time.Second)
		return w
	}
	t.Run("one set short", func(t *testing.T) {
		w := build(t)
		// d4 and d5 never answer d1: no majority of the new set.
		w.drop = func(from, to string, _ *pb.LeaseBatch) bool { return to == "d1" && (from == "d4" || from == "d5") }
		w.gw.closeLease("p1", false, 1)
		w.runUntil(w.now + FenceCompleteAfter + time.Second)
		if w.nodes["d1"].node.HolderStatus(keyP1).Retained {
			t.Fatal("retained with a majority of one quorum set only")
		}
		if fences := w.eventsOf("d1", EventFence); len(fences) == 0 || fences[0].event.Reason != FenceClosed {
			t.Fatalf("holder without a joint majority did not fence: %+v", fences)
		}
		w.requireClean(t)
	})
	t.Run("both sets", func(t *testing.T) {
		w := build(t)
		w.gw.closeLease("p1", false, 1)
		if !w.waitFor(5*time.Second, func() bool { return w.nodes["d1"].node.HolderStatus(keyP1).Retained }) {
			t.Fatalf("not retained with majorities of both sets\n%s", w.dumpTrace(40))
		}
		w.runUntil(w.now + time.Minute)
		w.requireClean(t)
		if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d1" {
			t.Fatalf("copies %v", copies)
		}
	})
}

// Entering lease mode again: the retained copy's node is the bootstrap holder
// and acquires while its copy keeps running (D1, B-12a).
func TestReentryAfterACloseKeepsTheRetainedCopy(t *testing.T) {
	w := closeWorld(t)
	requireCopyRunsThrough(t, w, "d1", keyP1, w.now+3*time.Minute)
	w.gw.closeLease("p1", false, 1)
	w.waitFor(5*time.Second, func() bool { return w.nodes["d1"].node.HolderStatus(keyP1).Retained })
	w.runUntil(w.now + time.Minute)
	w.gw.reopenLease("p1", 1)
	if w.gw.policies["p1"].bootstrap[0] != "d1" {
		t.Fatalf("bootstrap %v", w.gw.policies["p1"].bootstrap)
	}
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + time.Minute)
	w.requireClean(t)
}

// B-12a: a commit from an earlier lease period of the policy does not satisfy
// a new bootstrap reservation, so the named holder's running copy is not
// taken for unowned, and it acquires as the bootstrap holder.
func TestOldCommitDoesNotSatisfyANewBootstrap(t *testing.T) {
	w := closeWorld(t)
	d1 := w.nodes["d1"]
	oldCommit := d1.node.proposers[keyP1].commit
	// The lease closes the old way (no retained holder named) and legacy runs
	// d1's copy on; then lease mode is entered again naming d1.
	policy := w.gw.policies["p1"]
	policy.closed = true
	w.gw.republish("p1", 1)
	w.runUntil(w.now + 10*time.Second)
	d1.containers[keyP1] = &simContainer{live: true, legacy: true}
	policy.closed = false
	policy.bootstrapID++
	policy.bootstrap = map[uint32]string{0: "d1"}
	w.gw.republish("p1", 1)
	manifest := d1.node.manifests["p1"]
	if bootstrapSatisfiedBy(manifest, keyP1, oldCommit) {
		t.Fatal("a commit from the previous lease period satisfied the new bootstrap")
	}
	if !d1.node.BootstrapPending(keyP1) {
		t.Fatal("the named holder with an old commit is not bootstrap-pending")
	}
	requireCopyRunsThrough(t, w, "d1", keyP1, w.now+time.Minute)
	w.waitHolderIs(t, keyP1, "d1", 30*time.Second)
	w.runUntil(w.now + time.Minute)
	w.requireClean(t)
}

func TestClosedManifestRetainedHolderIsValidated(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(nil)
	parse := func(mutate func(*pb.LeaseManifest)) (*Manifest, error) {
		return parseManifest(manifestBlock(t, key, mutate))
	}
	closed := func(entries ...*pb.LeaseRetainedSlot) func(*pb.LeaseManifest) {
		return func(m *pb.LeaseManifest) { m.Closed, m.Retained = true, entries }
	}
	good := &pb.LeaseRetainedSlot{Slot: 0, HolderId: "d1", Ballot: &pb.LeaseBallot{Round: 4, Incarnation: 1, ProposerId: "d1"}}
	manifest, err := parse(closed(good))
	if err != nil || manifest.Retained[0].Holder != "d1" || manifest.Retained[0].Ballot.Round != 4 || !manifest.retains(0, "d1") || manifest.retains(0, "d2") {
		t.Fatalf("valid retained entry: %+v %v", manifest, err)
	}
	for name, entry := range map[string]*pb.LeaseRetainedSlot{
		"not a candidate": {Slot: 0, HolderId: "x"},
		"slot range":      {Slot: 1, HolderId: "d1"},
		"foreign ballot":  {Slot: 0, HolderId: "d1", Ballot: &pb.LeaseBallot{Round: 4, ProposerId: "d2"}},
	} {
		if _, err := parse(closed(entry)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	if _, err := parse(closed(good, good)); err == nil {
		t.Fatal("two retained holders for one slot accepted")
	}
	open, err := parse(func(m *pb.LeaseManifest) { m.Retained = []*pb.LeaseRetainedSlot{good} })
	if err != nil || len(open.Retained) != 0 || open.retains(0, "d1") {
		t.Fatalf("an open manifest must ignore retained entries: %+v %v", open, err)
	}
}
