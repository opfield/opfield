package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func twoCandidateWorld(t *testing.T, available bool) *simWorld {
	return newScenario(t, scenarioSpec{
		relays:     voterRelays(1, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "d3", voter: true}, {id: "d4", voter: true}},
		candidates: []string{"d1", "d2"},
		available:  available,
	})
}

// R6: a handoff releases only after the container is dead; a stop that does
// not finish means no release; a release is bound to its ballot.
func TestR6HandoffReleasesOnlyAfterStopAndBindsBallot(t *testing.T) {
	t.Run("slow stop", func(t *testing.T) {
		w := twoCandidateWorld(t, false)
		log := w.watchContainers()
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.nodes["d1"].stopDelay = 7 * time.Second // slow dockerd, within the 10 s stop timeout
		if !w.nodes["d1"].beginDrain(keyP1, "d2") {
			t.Fatal("drain did not start")
		}
		w.waitHolderIs(t, keyP1, "d2", 40*time.Second)
		w.requireClean(t)
		requireGap(t, *log, "d1", "d2", 0)
		died, _ := lastChange(*log, "d1", false)
		started, _ := firstChange(*log, "d2", true, died)
		if started-died > 5*time.Second {
			t.Fatalf("designated successor took %s after the stop", started-died)
		}
		if len(w.eventsOf("d1", EventHandoff)) != 1 {
			t.Fatal("no handoff event")
		}
	})
	t.Run("stop never completes", func(t *testing.T) {
		w := twoCandidateWorld(t, false)
		log := w.watchContainers()
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.nodes["d1"].hangUntil = w.now + time.Hour
		w.nodes["d1"].beginDrain(keyP1, "d2")
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		w.requireClean(t)
		for _, event := range w.events2 {
			if event.node == "d1" && (event.event.Kind == EventHandoff || event.event.Kind == EventReleased) {
				died, _ := lastChange(*log, "d1", false)
				if event.at < died {
					t.Fatalf("release sent at %s before the container died at %s", event.at, died)
				}
			}
		}
		// The watchdog killed the hung copy; once its cgroup is confirmed
		// empty the abandoned key is released (B-9), so the successor may
		// start right after, never before.
		requireGap(t, *log, "d1", "d2", 0)
	})
	t.Run("release is bound to its ballot", func(t *testing.T) {
		w := twoCandidateWorld(t, false)
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		var stale *pb.LeasePropose
		w.record = func(from, to string, batch *pb.LeaseBatch) {
			for _, item := range batch.GetItems() {
				if p := item.GetPropose(); p != nil && from == "d1" && to == "r1" {
					stale = p
				}
			}
		}
		w.runUntil(w.now + 6*time.Second)
		w.record = nil
		w.nodes["d1"].beginDrain(keyP1, "")
		w.waitFor(20*time.Second, func() bool { return w.nodes["d1"].node.HolderStatus(keyP1).Role == RoleNone })
		r1 := w.nodes["r1"].node
		// The open release reaches the candidates too, so d2 may hold by
		// now; d1's lease at r1 must be over.
		if lease := r1.acceptors[keyP1].lease; lease.holder == "d1" && lease.openAt(w.nodes["r1"].local()) {
			t.Fatal("release did not end the lease at r1")
		}
		w.injectFrom("d1", "r1", &pb.LeaseItem{Body: &pb.LeaseItem_Propose{Propose: stale}})
		w.runUntil(w.now + time.Second)
		if lease := r1.acceptors[keyP1].lease; lease.holder == "d1" && lease.openAt(w.nodes["r1"].local()) {
			t.Fatal("a delayed propose reopened a released ballot")
		}
		w.requireClean(t)
	})
}

// R7: available mode converges to one copy once the partition heals, and a
// switch to strict goes through a bootstrap naming one holder.
func TestR7AvailableModeConvergesAndSwitchesToStrict(t *testing.T) {
	partition := func(w *simWorld, down bool) {
		for _, r := range []string{"r2", "r3"} {
			w.link("d1", r).up = !down
		}
		for _, d := range []string{"d2", "d3", "d4"} {
			w.link(d, "r1").up = !down
		}
	}
	t.Run("heal", func(t *testing.T) {
		w := twoCandidateWorld(t, true)
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		partition(w, true)
		if !w.waitFor(90*time.Second, func() bool { return len(w.liveCopies(keyP1)) == 2 }) {
			t.Fatal("available mode did not start a second copy on the majority side")
		}
		partition(w, false)
		if !w.waitFor(60*time.Second, func() bool { return len(w.liveCopies(keyP1)) == 1 }) {
			t.Fatalf("copies %v did not converge", w.liveCopies(keyP1))
		}
		w.runUntil(w.now + 60*time.Second)
		if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d2" {
			t.Fatalf("copies %v, want the majority holder d2 only", copies)
		}
		fences := w.eventsOf("d1", EventFence)
		if len(fences) == 0 || fences[len(fences)-1].event.Reason != FenceOtherHolder {
			t.Fatalf("d1 did not fence on d2's commit: %+v", fences)
		}
		w.requireClean(t)
	})
	t.Run("switch to strict", func(t *testing.T) {
		w := twoCandidateWorld(t, true)
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		partition(w, true)
		w.waitFor(90*time.Second, func() bool { return len(w.liveCopies(keyP1)) == 2 })
		policy := w.gw.policies["p1"]
		policy.available, policy.bootstrapID, policy.bootstrap = false, 2, map[uint32]string{0: "d2"}
		w.gw.deliver(w.gw.buildManifest(policy), 1)
		partition(w, false)
		if !w.waitFor(60*time.Second, func() bool {
			copies := w.liveCopies(keyP1)
			return len(copies) == 1 && copies[0] == "d2"
		}) {
			t.Fatalf("copies %v after the switch", w.liveCopies(keyP1))
		}
		// Strict counts as active only once every other copy stopped (A7)
		// and relay gates still admitting it lapsed.
		w.runUntil(w.now + GateWindow*10/9 + time.Second)
		w.strict["p1"] = true
		w.runUntil(w.now + 90*time.Second)
		w.requireClean(t)
	})
}

// R8: relay gates follow the lease view and close without any message from
// the holder.
func TestR8RelayGateBoundToLeaseView(t *testing.T) {
	w := twoCandidateWorld(t, false)
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	for _, r := range w.relays {
		gate := w.nodes[r].node.Gate(keyP1)
		if !gate.Open || gate.Holder != "d1" {
			t.Fatalf("gate at %s not open for the holder: %+v", r, gate)
		}
		if gate.Until-w.nodes[r].local() > GateWindow {
			t.Fatalf("gate at %s open beyond the gate window", r)
		}
	}
	w.nodes["d1"].freeze() // holder gone silent, sends nothing
	w.runUntil(w.now + GateWindow*10/9 + time.Second)
	for _, r := range w.relays {
		if gate := w.nodes[r].node.Gate(keyP1); gate.Open {
			t.Fatalf("gate at %s still open for a silent holder: %+v", r, gate)
		}
	}
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	for _, r := range w.relays {
		if gate := w.nodes[r].node.Gate(keyP1); !gate.Open || gate.Holder != "d2" {
			t.Fatalf("gate at %s did not move to the new holder: %+v", r, gate)
		}
	}
	w.requireClean(t)
}

// R9: replayed frames of an old ballot or incarnation cannot change newer
// state.
func TestR9ReplayedFramesCannotChangeNewerBallots(t *testing.T) {
	w := twoCandidateWorld(t, false)
	type sent struct {
		to    string
		batch *pb.LeaseBatch
	}
	var captured []sent
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		if from == "d1" {
			captured = append(captured, sent{to: to, batch: batch})
		}
	}
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 20*time.Second)
	w.record = nil
	w.nodes["d1"].crashHost()
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	promised := map[string]Ballot{}
	for _, id := range w.ids {
		if n := w.nodes[id].node; n != nil && n.acceptors[keyP1] != nil {
			promised[id] = n.acceptors[keyP1].promised()
		}
	}
	for _, message := range captured {
		// Replay with fresh message ids so deduplication does not hide them.
		replay := proto.Clone(message.batch).(*pb.LeaseBatch)
		replay.MessageId += "/replay"
		if n := w.nodes[message.to]; n.processUp() {
			n.node.receive(replay)
			n.after()
		}
	}
	w.runUntil(w.now + 30*time.Second)
	w.requireClean(t)
	if w.holder(keyP1) != "d2" || len(w.eventsOf("d2", EventFence)) != 0 {
		t.Fatalf("replayed frames disturbed the new holder: holder %q, d2 fences %+v\n%s", w.holder(keyP1), w.eventsOf("d2", EventFence), w.dumpTrace(60))
	}
	for id, before := range promised {
		if after := w.nodes[id].node.acceptors[keyP1].promised(); after.Less(before) {
			t.Fatalf("%s promised ballot went back from %s to %s", id, before, after)
		}
	}
	// Frames from an older incarnation are dropped outright.
	w.nodes["d1"].bootHost()
	w.runUntil(w.now + 5*time.Second)
	r1 := w.nodes["r1"].node
	before := r1.acceptors[keyP1].promised()
	old := proto.Clone(captured[0].batch).(*pb.LeaseBatch)
	old.DestinationId, old.MessageId = "r1", "old-incarnation"
	old.Items = []*pb.LeaseItem{{Body: &pb.LeaseItem_Prepare{Prepare: &pb.LeasePrepare{
		Key: keyP1.proto(), Ballot: (&Ballot{Round: before.Round + 100, Incarnation: 1, Proposer: "d1"}).proto(),
		Epoch: 1, ManifestVersion: 1,
	}}}}
	r1.receive(old)
	if after := r1.acceptors[keyP1].promised(); after != before {
		t.Fatalf("frame from an old incarnation changed the promise: %s -> %s", before, after)
	}
}
