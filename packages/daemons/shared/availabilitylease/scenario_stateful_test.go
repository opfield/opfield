package availabilitylease

import (
	"fmt"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// Scripted scenarios of the plan risk review (B1, B2, joint consensus) for
// stateful policies. The database model is driven by the test: setSync
// certifies a sync set, promotions are confirmed by the model.

func daemonVoters(ids ...string) []nodeSpec {
	var out []nodeSpec
	for _, id := range ids {
		out = append(out, nodeSpec{id: id, voter: true})
	}
	return out
}

// statefulScenario starts a stateful world bootstrapped by the first
// candidate and waits for it to hold.
func statefulScenario(t *testing.T, relays, daemons []nodeSpec, candidates ...string) *simWorld {
	t.Helper()
	w := newScenario(t, scenarioSpec{relays: relays, daemons: daemons, candidates: candidates, bootstrap: candidates[0], stateful: true})
	w.startAll()
	w.waitHolderIs(t, keyP1, candidates[0], 60*time.Second)
	return w
}

// setSync certifies a new sync set on the holder id and waits for the QC.
func setSync(t *testing.T, w *simWorld, id string, sync ...string) {
	t.Helper()
	n := w.nodes[id]
	committed, ok := n.node.CommittedState(keyP1)
	if !ok {
		t.Fatalf("%s has no certified state", id)
	}
	w.state.seq++
	transition := Transition{ID: fmt.Sprintf("test-%d", w.state.seq), Value: w.state.newValue(decodeSimValue(committed.State.Value).id, sync, false)}
	if err := n.node.ProposeTransition(keyP1, transition); err != nil {
		t.Fatalf("propose sync %v on %s: %v", sync, id, err)
	}
	if !w.waitFor(20*time.Second, func() bool {
		outcome, _ := n.node.TransitionStatus(keyP1, transition.ID)
		return outcome == TransitionCertified
	}) {
		w.requireClean(t)
		outcome, reason := n.node.TransitionStatus(keyP1, transition.ID)
		t.Fatalf("sync %v on %s not certified: %d %s\n%s", sync, id, outcome, reason, w.dumpTrace(80))
	}
}

func between(a, b string) func(from, to string, _ *pb.LeaseBatch) bool {
	return func(from, to string, _ *pb.LeaseBatch) bool {
		return (from == a && to == b) || (from == b && to == a)
	}
}

// requireNoAcquisition runs for d and fails if id acquires the key.
func requireNoAcquisition(t *testing.T, w *simWorld, id string, d time.Duration) {
	t.Helper()
	before := len(w.eventsOf(id, EventAcquired))
	w.runUntil(w.now + d)
	w.requireClean(t)
	if len(w.eventsOf(id, EventAcquired)) != before || w.nodes[id].node.HolderStatus(keyP1).Holding {
		t.Fatalf("%s acquired the key\n%s", id, w.dumpTrace(120))
	}
}

// forceOn arms a forced acquisition on id over the latest commit it knows,
// retrying while fresh statuses do not show a voter majority yet.
func forceOn(t *testing.T, w *simWorld, id, operation string) {
	t.Helper()
	var err error
	w.waitFor(10*time.Second, func() bool {
		err = w.state.force(w.nodes[id], keyP1, operation)
		return err == nil
	})
	if err != nil {
		t.Fatalf("force on %s: %v", id, err)
	}
}

func requireForcedAcquisition(t *testing.T, w *simWorld, id, operation string) {
	t.Helper()
	w.waitHolderIs(t, keyP1, id, 90*time.Second)
	for _, event := range w.eventsOf(id, EventAcquired) {
		if event.event.Forced == operation {
			return
		}
	}
	t.Fatalf("%s holds without a forced acquisition %s", id, operation)
}

// acceptedStateOn decodes the state id last accepted as a voter.
func acceptedStateOn(w *simWorld, id string) HolderState {
	n := w.nodes[id]
	if n.node == nil {
		return HolderState{}
	}
	ak := n.node.acceptors[keyP1]
	if ak == nil || ak.rec.Accepted == nil {
		return HolderState{}
	}
	state, _ := decodeHolderState(ak.rec.Accepted.State)
	return state
}

// recordKnown reports the persisted KNOWN flag of id's record, which views
// hide while id is not a voter.
func recordKnown(w *simWorld, id string) bool {
	ak := w.nodes[id].node.acceptors[keyP1]
	return ak != nil && ak.rec.Known
}

func stateKnown(w *simWorld, id string) bool {
	view, ok := w.acceptorViewOn(id, keyP1)
	return ok && view.StateKnown
}

// B1: the A<->B link drops, A degrades with the witness W, W loses its
// relay.db and site A is lost. B still remembers the old sync set {B}, W
// reports UNKNOWN, so B has no KNOWN majority and never acquires; only an
// explicit forced acquisition (data loss accepted) makes it primary.
func TestStatefulB1WipedWitnessNeverMakesAStaleMemberEligible(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	w.drop = between("d1", "d2")
	setSync(t, w, "d1")
	restartProcess(w, w.nodes["r1"], true, time.Second)
	w.nodes["d1"].crashHost()
	w.drop = nil
	requireNoAcquisition(t, w, "d2", 120*time.Second)
	if stateKnown(w, "r1") {
		t.Fatal("the wiped witness reports KNOWN memory")
	}
	if _, approved := w.state.approvals["d2|"+keyP1.String()]; approved {
		t.Fatal("d2 was found eligible without a KNOWN majority")
	}
	forceOn(t, w, "d2", "cli-b1")
	requireForcedAcquisition(t, w, "d2", "cli-b1")
	if !w.waitFor(20*time.Second, func() bool { return stateKnown(w, "r1") }) {
		t.Fatal("the witness did not learn the forced state")
	}
	w.requireClean(t)
}

// B1 without the wipe: the witness remembers the degraded {} of A's later
// ballot, which is the highest KNOWN state, so B is not eligible.
func TestStatefulDegradedStateKeepsAStaleMemberIneligible(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	w.drop = between("d1", "d2")
	setSync(t, w, "d1")
	w.nodes["d1"].crashHost()
	w.drop = nil
	requireNoAcquisition(t, w, "d2", 90*time.Second)
	if w.state.ineligible == 0 {
		t.Fatal("d2 never evaluated its eligibility")
	}
}

// A live holder keeps its lease through a witness wipe (lease continuity) and
// the witness becomes KNOWN again from its renewals.
func TestStatefulHolderRestoresAWipedWitness(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	restartProcess(w, w.nodes["r1"], true, time.Second)
	w.runUntil(w.now + 5*time.Second)
	if stateKnown(w, "r1") {
		t.Fatal("the wiped witness reports KNOWN memory")
	}
	if !w.waitFor(60*time.Second, func() bool { return stateKnown(w, "r1") }) {
		t.Fatalf("the witness did not learn the state from renewals\n%s", w.dumpTrace(80))
	}
	if len(w.eventsOf("d1", EventFence)) > 0 || w.holder(keyP1) != "d1" {
		t.Fatal("the holder lost its lease")
	}
	w.requireClean(t)
}

// B2 scenario 1: a candidate's acquisition leaves its state (pending
// promotion, inherited sync set) at one acceptor and the candidate crashes.
// A sync member still adopts it, is eligible and takes over.
func TestStatefulFailedAcquisitionLeavesTheSyncMemberEligible(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), append(daemonVoters("d1", "d2"), nodeSpec{id: "d3"}), "d1", "d3", "d2")
	setSync(t, w, "d1", "d2", "d3")
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		if from != "d3" || to != "d2" {
			return false
		}
		for _, item := range batch.GetItems() {
			if item.GetPropose() != nil {
				return true
			}
		}
		return false
	}
	crashed := false
	w.observers = append(w.observers, func() {
		if view, ok := w.acceptorViewOn("r1", keyP1); !crashed && ok && view.AcceptedBallot.Proposer == "d3" {
			crashed = true
			w.nodes["d3"].crashHost()
		}
	})
	w.nodes["d1"].crashHost()
	w.waitHolderIs(t, keyP1, "d2", 120*time.Second)
	if !crashed {
		t.Fatal("d3's acquisition never reached the witness")
	}
	approval := w.state.approvals["d2|"+keyP1.String()]
	if approval.PreviousHolder != "d3" || !approval.Adopted.PendingPromotion {
		t.Fatalf("d2 did not adopt d3's failed acquisition: %+v", approval)
	}
	w.requireClean(t)
}

// B2 scenario 2: the holder's daemon restarts while a transition's round was
// possibly chosen (its accepts never reached the holder). The recovery adopts
// the accepted value and certifies the transition, from the store and the
// acceptors, never from the application's own configuration.
func TestStatefulRecoverResumesFromTheAdoptedValue(t *testing.T) {
	for _, wipe := range []bool{false, true} {
		t.Run(fmt.Sprintf("wipe=%v", wipe), func(t *testing.T) {
			w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
			setSync(t, w, "d1", "d2")
			d1 := w.nodes["d1"]
			w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
				for _, item := range batch.GetItems() {
					if to == "d1" && item.GetAccepted() != nil {
						return true
					}
				}
				return false
			}
			committed, _ := d1.node.CommittedState(keyP1)
			transition := Transition{ID: "degrade", Value: w.state.newValue(decodeSimValue(committed.State.Value).id, nil, false)}
			if err := d1.node.ProposeTransition(keyP1, transition); err != nil {
				t.Fatal(err)
			}
			if !w.waitFor(10*time.Second, func() bool { return acceptedStateOn(w, "r1").TransitionID == "degrade" }) {
				t.Fatal("the transition's round never reached the witness")
			}
			restartProcess(w, d1, wipe, time.Second)
			w.drop = nil
			w.runUntil(w.now + 1500*time.Millisecond)
			if !wipe {
				if restored, ok := d1.node.CommittedState(keyP1); !ok || !restored.Restored || restored.State.TransitionID == "degrade" {
					t.Fatalf("restart did not restore the certified state: %+v", restored)
				}
			}
			if !w.waitFor(30*time.Second, func() bool {
				current, ok := d1.node.CommittedState(keyP1)
				return ok && !current.Restored && current.State.TransitionID == "degrade"
			}) {
				t.Fatalf("recovery did not certify the possibly chosen transition\n%s", w.dumpTrace(100))
			}
			if w.holder(keyP1) != "d1" || len(w.eventsOf("d1", EventFence)) > 0 {
				t.Fatal("the recovering holder lost its lease")
			}
			w.requireClean(t)
		})
	}
}

// Joint consensus: eligibility needs a KNOWN majority of both quorum sets,
// and a stateful voter change stays joint until a live holder renewed under
// it (AS1).
func TestStatefulJointConsensusEligibility(t *testing.T) {
	relays := append(voterRelays(1, "r1"), nodeSpec{id: "r2"}, nodeSpec{id: "r3"})
	t.Run("new set without memory", func(t *testing.T) {
		w := statefulScenario(t, relays, daemonVoters("d1", "d2"), "d1", "d2")
		setSync(t, w, "d1", "d2")
		w.nodes["d1"].crashHost()
		w.gw.changeVoters("p1", []string{"d2", "r2", "r3"}, 1)
		requireNoAcquisition(t, w, "d2", 90*time.Second)
		if !w.gw.policies["p1"].joint {
			t.Fatal("a stateful voter change settled without a live holder")
		}
		forceOn(t, w, "d2", "api-joint")
		requireForcedAcquisition(t, w, "d2", "api-joint")
		if !w.waitFor(120*time.Second, func() bool { return !w.gw.policies["p1"].joint }) {
			t.Fatal("the voter change did not settle after the holder renewed under it")
		}
		w.requireClean(t)
	})
	t.Run("both sets remember", func(t *testing.T) {
		w := statefulScenario(t, relays, daemonVoters("d1", "d2"), "d1", "d2")
		setSync(t, w, "d1", "d2")
		w.gw.changeVoters("p1", []string{"d1", "d2", "r2"}, 1)
		if !w.waitFor(20*time.Second, func() bool { return stateKnown(w, "r2") }) {
			t.Fatal("the new voter did not learn the state from the holder's renewals")
		}
		w.nodes["d1"].crashHost()
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		w.requireClean(t)
	})
}

// A voter re-added after its removal has a record that predates quorums it
// never saw: it reports UNKNOWN until it accepts again (AS1).
func TestStatefulReaddedVoterForgetsItsRecord(t *testing.T) {
	relays := append(voterRelays(1, "r1"), nodeSpec{id: "r2"})
	w := statefulScenario(t, relays, daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	w.gw.changeVoters("p1", []string{"d1", "d2", "r2"}, 1)
	if !w.waitFor(120*time.Second, func() bool { return !w.gw.policies["p1"].joint }) {
		t.Fatal("first voter change did not settle")
	}
	if !recordKnown(w, "r1") || stateKnown(w, "r1") {
		t.Fatal("the removed voter should keep its record and report it to nobody")
	}
	var forgotten bool
	w.observers = append(w.observers, func() {
		if w.nodes["r1"].node.Epoch("p1") == w.gw.policies["p1"].epoch && w.gw.policies["p1"].joint && !recordKnown(w, "r1") {
			forgotten = true
		}
	})
	w.gw.changeVoters("p1", []string{"d1", "d2", "r1"}, 1)
	if !w.waitFor(60*time.Second, func() bool { return forgotten && stateKnown(w, "r1") }) {
		t.Fatalf("re-added voter: forgotten=%v known=%v", forgotten, stateKnown(w, "r1"))
	}
	w.requireClean(t)
}

// H4/AS6: a degraded primary that lost its lease (isolated, fenced by its
// timer) is not released and stays eligible as the previous holder, so it
// takes the key back once it reaches a majority again.
func TestStatefulFencedDegradedPrimaryTakesTheKeyBack(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1")
	w.isolate("d1", true)
	if !w.waitFor(30*time.Second, func() bool { return len(w.eventsOf("d1", EventFence)) > 0 }) {
		t.Fatal("the isolated holder did not fence")
	}
	w.runUntil(w.now + 15*time.Second)
	if len(w.eventsOf("d1", EventReleased)) > 0 {
		t.Fatal("a stateful key was released after a local fence")
	}
	w.isolate("d1", false)
	w.waitHolderIs(t, keyP1, "d1", 90*time.Second)
	if len(w.eventsOf("d2", EventAcquired)) > 0 {
		t.Fatal("d2 acquired while not in the sync set")
	}
	w.requireClean(t)
}

// M1: an acceptor persists the accepted state with the accept, before the
// reply leaves, so a restart right after it remembers the latest state.
func TestStatefulAcceptorPersistsTheAcceptedState(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	r1 := w.nodes["r1"]
	restarted := false
	w.observers = append(w.observers, func() {
		if !restarted && acceptedStateOn(w, "r1").TransitionID != "" {
			// Crash right after the accept, before any later write.
			restarted = true
			r1.stopProcess()
			r1.start()
			if got := acceptedStateOn(w, "r1"); got.TransitionID == "" || !recordKnown(w, "r1") {
				t.Errorf("restarted acceptor forgot the state it accepted (known %v)", recordKnown(w, "r1"))
			}
		}
	})
	setSync(t, w, "d1", "d2")
	if !restarted {
		t.Fatal("the witness never accepted the transition")
	}
	w.requireClean(t)
}
