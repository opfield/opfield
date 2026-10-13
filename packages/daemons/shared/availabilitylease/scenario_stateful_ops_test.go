package availabilitylease

import (
	"strings"
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// degradedHolderLost leaves p1 with no eligible member: the holder d1
// certified an empty sync set and died.
func degradedHolderLost(t *testing.T) *simWorld {
	t.Helper()
	w := statefulScenario(t, []nodeSpec{{id: "r1"}}, daemonVoters("d1", "d2", "d3"), "d1", "d2", "d3")
	setSync(t, w, "d1")
	w.nodes["d1"].crashHost()
	requireNoAcquisition(t, w, "d2", 45*time.Second)
	requireNoAcquisition(t, w, "d3", time.Second)
	return w
}

// AS10: two operators force at once (the API on d2, the node-local CLI on
// d3) over the same commit. One acquires; the other's override ends as soon
// as it sees that newer commit. Arming is single-flight per node and bound
// to the commit the operator saw.
func TestStatefulForcedAcquisitionRace(t *testing.T) {
	w := degradedHolderLost(t)
	d2, d3 := w.nodes["d2"], w.nodes["d3"]
	observed, _ := d2.node.ObservedCommit(keyP1)
	value := w.state.newValue(0, nil, true)
	d2.node.SetCandidateReady("p1", false)
	if err := d2.node.ForceAcquire(keyP1, ForceRequest{OperationID: "not-ready", Over: observed.Ballot, Value: value}); err != ErrNotReady {
		t.Fatalf("forcing on a node that is not ready: %v", err)
	}
	d2.node.SetCandidateReady("p1", true)
	forceOn(t, w, "d2", "api-1")
	if err := d2.node.ForceAcquire(keyP1, ForceRequest{OperationID: "api-2", Over: observed.Ballot, Value: value}); err != ErrForceArmed {
		t.Fatalf("second operation on the same node: %v", err)
	}
	forceOn(t, w, "d3", "cli-1")
	w.runUntil(w.now + 60*time.Second)
	w.requireClean(t)
	winner, loser := "d2", d3
	if w.holder(keyP1) == "d3" {
		winner, loser = "d3", d2
	}
	if w.holder(keyP1) != winner {
		t.Fatalf("no forced holder: %q", w.holder(keyP1))
	}
	if status := w.nodes[winner].node.ForceStatus(keyP1); status.Outcome != ForceAcquired {
		t.Fatalf("winner force status %+v", status)
	}
	if status := loser.node.ForceStatus(keyP1); status.Outcome != ForceSuperseded {
		t.Fatalf("loser force status %+v", status)
	}
	if err := loser.node.ForceAcquire(keyP1, ForceRequest{OperationID: "late", Over: observed.Ballot, Value: value}); err != ErrForceStale {
		t.Fatalf("forcing over an old commit: %v", err)
	}
	committed, _ := w.nodes[winner].node.CommittedState(keyP1)
	if forced := len(w.eventsOf(winner, EventAcquired)); forced != 1 || committed.State.PromotedHolder != winner {
		t.Fatalf("winner acquisitions %d, state %+v", forced, committed.State)
	}
}

// AS10: an override armed while a holder lives is superseded by the holder's
// next renewal; one that cannot acquire expires after ForceWindow.
func TestStatefulForcedAcquisitionSupersededAndExpired(t *testing.T) {
	w := statefulScenario(t, []nodeSpec{{id: "r1"}}, daemonVoters("d1", "d2", "d3"), "d1", "d2", "d3")
	forceOn(t, w, "d2", "api-live-holder")
	w.runUntil(w.now + 2*RenewInterval)
	if status := w.nodes["d2"].node.ForceStatus(keyP1); status.Outcome != ForceSuperseded || w.holder(keyP1) != "d1" {
		t.Fatalf("override over a live holder: %+v, holder %s", status, w.holder(keyP1))
	}

	w = degradedHolderLost(t)
	forceOn(t, w, "d2", "api-blocked")
	w.drop = func(from, _ string, batch *pb.LeaseBatch) bool {
		for _, item := range batch.GetItems() {
			if from == "d2" && item.GetPropose() != nil {
				return true
			}
		}
		return false
	}
	w.runUntil(w.now + ForceWindow + 10*time.Second)
	w.requireClean(t)
	if status := w.nodes["d2"].node.ForceStatus(keyP1); status.Outcome != ForceExpired || w.holder(keyP1) != "" {
		t.Fatalf("blocked override: %+v, holder %q", status, w.holder(keyP1))
	}
}

// The relay gate of a stateful policy never opens for an acquisition that is
// accepted but not committed (pending promotion); it opens on the commit.
func TestStatefulGateOpensOnlyOnTheCommit(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		for _, item := range batch.GetItems() {
			if from == "d2" && to == "r1" && item.GetCommit() != nil {
				return true
			}
		}
		return false
	}
	w.observers = append(w.observers, func() {
		if gate := w.nodes["r1"].node.Gate(keyP1); gate.Open && gate.Holder == "d2" && w.drop != nil {
			t.Errorf("gate opened for d2 before its commit reached the relay")
		}
	})
	w.nodes["d1"].crashHost()
	if !w.waitFor(60*time.Second, func() bool {
		committed, ok := w.nodes["d2"].node.CommittedState(keyP1)
		return ok && committed.State.Holder == "d2"
	}) {
		t.Fatal("d2 never acquired")
	}
	w.runUntil(w.now + 3*time.Second)
	w.drop = nil
	if !w.waitFor(10*time.Second, func() bool { return w.nodes["r1"].node.Gate(keyP1).Open }) {
		t.Fatal("gate did not open on d2's commit")
	}
	w.requireClean(t)
}

// Transitions: one at a time, only on the holder, certified by a QC; a
// transition the holder cannot certify before losing its lease is rejected.
func TestStatefulTransitionLifecycle(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	d1, d2 := w.nodes["d1"].node, w.nodes["d2"].node
	if err := d2.ProposeTransition(keyP1, Transition{ID: "x", Value: []byte("v")}); err != ErrNotHolding {
		t.Fatalf("transition on a non-holder: %v", err)
	}
	if err := d1.ProposeTransition(keyP1, Transition{ID: "big", Value: make([]byte, MaxStateValueBytes+1)}); err != ErrStateTooLarge {
		t.Fatalf("oversized transition: %v", err)
	}
	if err := d1.ProposeTransition(keyP1, Transition{Value: []byte("v")}); err != ErrInvalidTransition {
		t.Fatalf("transition without an id: %v", err)
	}
	base, _ := d1.CommittedState(keyP1)
	valueA := w.state.newValue(decodeSimValue(base.State.Value).id, []string{"d2"}, false)
	if err := d1.ProposeTransition(keyP1, Transition{ID: "a", Value: valueA}); err != nil {
		t.Fatal(err)
	}
	if err := d1.ProposeTransition(keyP1, Transition{ID: "b", Value: []byte("b")}); err != ErrTransitionPending {
		t.Fatalf("second pending transition: %v", err)
	}
	if pending, ok := d1.PendingState(keyP1); !ok || pending.ID != "a" {
		t.Fatalf("pending %+v", pending)
	}
	if !w.waitFor(10*time.Second, func() bool { outcome, _ := d1.TransitionStatus(keyP1, "a"); return outcome == TransitionCertified }) {
		t.Fatal("transition a not certified")
	}
	committed, _ := d1.CommittedState(keyP1)
	if string(committed.State.Value) != string(valueA) || committed.State.TransitionID != "a" || committed.Restored {
		t.Fatalf("certified %+v", committed)
	}
	if observed, ok := d2.ObservedCommit(keyP1); !ok || observed.Hash != committed.Hash {
		t.Fatalf("d2 observed %+v", observed)
	}
	w.isolate("d1", true)
	if err := d1.ProposeTransition(keyP1, Transition{ID: "lost", Value: w.state.newValue(decodeSimValue(valueA).id, nil, false)}); err != nil {
		t.Fatal(err)
	}
	w.runUntil(w.now + SoftFenceAfter + 2*time.Second)
	if outcome, reason := d1.TransitionStatus(keyP1, "lost"); outcome != TransitionRejected || !strings.Contains(reason, "lease was lost") {
		t.Fatalf("transition of a fenced holder: %d %q", outcome, reason)
	}
}

// M1/AS2: the holder persists its certified state and pending transition
// before acting; a restart restores them (marked restored) until a round of
// the new incarnation certifies again.
func TestStatefulHolderRecordPersists(t *testing.T) {
	w := statefulScenario(t, voterRelays(1, "r1"), daemonVoters("d1", "d2"), "d1", "d2")
	setSync(t, w, "d1", "d2")
	d1 := w.nodes["d1"]
	records, _ := d1.store.Load()
	if len(records[holderRecordName(keyP1)]) == 0 || len(records[recordStoreInfo]) == 0 {
		t.Fatalf("holder record or store marker missing: %v", sortedKeys(records))
	}
	before, _ := d1.node.CommittedState(keyP1)
	restartProcess(w, d1, false, time.Second)
	w.runUntil(w.now + 1500*time.Millisecond)
	restored, ok := d1.node.CommittedState(keyP1)
	if !ok || !restored.Restored || restored.Hash != before.Hash {
		t.Fatalf("restored %+v", restored)
	}
	if !w.waitFor(10*time.Second, func() bool { c, _ := d1.node.CommittedState(keyP1); return !c.Restored }) {
		t.Fatal("recovery did not certify again")
	}
	w.requireClean(t)
}

// AS1 at the acceptor: a fresh store reports UNKNOWN, a propose that echoes
// no promise of the current incarnation is refused with NO_PROMISE, and a
// state that does not name the proposer with STATE_INVALID.
func TestStatefulAcceptorMemory(t *testing.T) {
	w := newScenario(t, scenarioSpec{relays: voterRelays(1, "r1"), daemons: daemonVoters("d1", "d2"), candidates: []string{"d1", "d2"}, bootstrap: "d1", stateful: true})
	nacks := map[pb.LeaseNackReason]int{}
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		for _, item := range batch.GetItems() {
			if nack := item.GetNack(); nack != nil && from == "r1" {
				nacks[nack.GetReason()]++
			}
		}
	}
	w.startAll()
	w.runUntil(w.now + 100*time.Millisecond)
	if stateKnown(w, "r1") {
		t.Fatal("fresh store reports KNOWN")
	}
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	if !stateKnown(w, "r1") || !stateKnown(w, "d2") {
		t.Fatal("voters did not learn the bootstrap state")
	}
	d1 := w.nodes["d1"].node
	committed, _ := d1.CommittedState(keyP1)
	ballot := Ballot{Round: 900, Incarnation: d1.Incarnation(), Proposer: "d1"}
	epoch, version := d1.Epoch("p1"), d1.ManifestVersion("p1")
	propose := func(echo uint64, state []byte) *pb.LeaseItem {
		return &pb.LeaseItem{Body: &pb.LeaseItem_Propose{Propose: &pb.LeasePropose{
			Key: keyP1.proto(), Ballot: ballot.proto(), Epoch: epoch, ManifestVersion: version, Echo: echo, State: state,
		}}}
	}
	w.injectFrom("d1", "r1", propose(12345, encodeHolderState(committed.State)))
	foreign := committed.State
	foreign.Holder = "d2"
	w.injectFrom("d1", "r1", propose(12345, encodeHolderState(foreign)))
	w.injectFrom("d1", "r1", propose(0, encodeHolderState(committed.State)))
	w.runUntil(w.now + time.Second)
	if nacks[pb.LeaseNackReason_LEASE_NACK_REASON_NO_PROMISE] != 2 || nacks[pb.LeaseNackReason_LEASE_NACK_REASON_STATE_INVALID] != 1 {
		t.Fatalf("nacks %v", nacks)
	}
	// A commit whose state differs from the hash its accepts signed is no
	// certificate.
	commit := proto.Clone(w.nodes["d1"].node.proposers[keyP1].commit).(*pb.LeaseCommit)
	forged := committed.State
	forged.Value = w.state.newValue(0, []string{"d2"}, false)
	commit.State = encodeHolderState(forged)
	if _, err := d1.commitQuorum(commit, d1.manifests["p1"]); err == nil {
		t.Fatal("a commit with a substituted state verified")
	}
	restartProcess(w, w.nodes["r1"], true, time.Second)
	w.runUntil(w.now + 2*time.Second)
	if stateKnown(w, "r1") || recordKnown(w, "r1") {
		t.Fatal("renamed store reports KNOWN")
	}
	if created := w.nodes["r1"].node.StoreCreatedIncarnation(); created != w.nodes["r1"].node.Incarnation() {
		t.Fatalf("store created at %d, incarnation %d", created, w.nodes["r1"].node.Incarnation())
	}
	w.requireClean(t)
}

// AS8 and M10: a stateful manifest must be strict, and a policy cannot turn
// stateful or stateless (a new policy id is used instead).
func TestStatefulManifestRules(t *testing.T) {
	w := newScenario(t, scenarioSpec{relays: voterRelays(1, "r1"), daemons: daemonVoters("d1", "d2"), candidates: []string{"d1", "d2"}, stateful: true})
	policy := w.gw.policies["p1"]
	policy.available = true
	block := w.gw.buildManifest(policy)
	if _, err := parseManifest(block); err == nil || !strings.Contains(err.Error(), "strict") {
		t.Fatalf("stateful available manifest: %v", err)
	}
	policy.available = false
	w.gw.buildManifest(policy)
	w.startAll()
	policy.stateful = false
	if _, err := w.nodes["d1"].node.AdoptManifest(w.gw.buildManifest(policy)); err == nil {
		t.Fatal("a policy turned stateless")
	}
}

// Stateless policies keep the v2 wire: no state fields, v1 accept statements.
func TestStatelessPolicyKeepsTheV2Wire(t *testing.T) {
	w := newScenario(t, scenarioSpec{relays: voterRelays(1, "r1"), daemons: daemonVoters("d1", "d2"), candidates: []string{"d1", "d2"}})
	var checked int
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		for _, item := range batch.GetItems() {
			switch body := item.GetBody().(type) {
			case *pb.LeaseItem_Promise:
				checked++
				if body.Promise.GetAccepted() != nil {
					t.Errorf("stateless promise carries acceptor memory")
				}
			case *pb.LeaseItem_Accepted:
				checked++
				key, _ := keyFromProto(body.Accepted.GetKey())
				statement := acceptStatement(key, ballotFromProto(body.Accepted.GetBallot()), body.Accepted.GetEpoch(),
					body.Accepted.GetManifestVersion(), body.Accepted.GetAcceptorId(), body.Accepted.GetAcceptorIncarnation())
				if len(body.Accepted.GetStateHash()) > 0 || !strings.HasPrefix(string(statement), domainAccept+"\x00") {
					t.Errorf("stateless accept carries a state hash")
				}
			}
			if commit := item.GetCommit(); commit != nil && len(commit.GetState()) > 0 {
				t.Errorf("stateless commit carries state")
			}
			if propose := item.GetPropose(); propose != nil && len(propose.GetState()) > 0 {
				t.Errorf("stateless propose carries state")
			}
			if status := item.GetStatus(); status != nil && status.GetAccepted() != nil {
				t.Errorf("stateless status carries acceptor memory")
			}
		}
	}
	w.startAll()
	w.waitHolder(t, keyP1, 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	if checked == 0 {
		t.Fatal("no lease items observed")
	}
	w.requireClean(t)
}
