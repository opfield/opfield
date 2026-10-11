package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// AS10 (risk review M1): a forced round that finds, in its own promise
// quorum, a ballot of another proposer accepted after the commit the operator
// forced over does not override it: the override ends as superseded and
// names that ballot. Only a new decision over that ballot forces.
func TestStatefulForceSupersededByANewerAcceptedBallot(t *testing.T) {
	w := statefulScenario(t, []nodeSpec{{id: "r1"}}, daemonVoters("d1", "d2", "d3"), "d1", "d2", "d3")
	setSync(t, w, "d1")
	d2 := w.nodes["d2"]
	over, ok := d2.node.ObservedCommit(keyP1)
	if !ok {
		t.Fatal("d2 knows no commit")
	}
	// d1's next rounds are accepted everywhere but never reach a QC, so
	// their ballot is newer than every commit d2 knows; then d1 dies.
	w.drop = func(_, to string, batch *pb.LeaseBatch) bool {
		for _, item := range batch.GetItems() {
			if to == "d1" && item.GetAccepted() != nil {
				return true
			}
		}
		return false
	}
	var newer Ballot
	w.observers = append(w.observers, func() {
		if !newer.IsZero() {
			return
		}
		if view, ok := w.acceptorViewOn("d3", keyP1); ok && view.AcceptedBallot.Proposer == "d1" && over.Ballot.Less(view.AcceptedBallot) {
			newer = view.AcceptedBallot
			w.nodes["d1"].crashHost()
			w.drop = nil
		}
	})
	if !w.waitFor(20*time.Second, func() bool { return !newer.IsZero() }) {
		t.Fatal("d1's newer ballot was never accepted")
	}
	if observed, _ := d2.node.ObservedCommit(keyP1); !observed.Ballot.Less(newer) {
		t.Fatalf("d2 learned a commit of the newer ballot %s: %s", newer, observed.Ballot)
	}
	arm := func(operation string, over Ballot) {
		t.Helper()
		var err error
		w.waitFor(10*time.Second, func() bool {
			err = d2.node.ForceAcquire(keyP1, ForceRequest{OperationID: operation, Over: over, Value: w.state.newValue(0, nil, true)})
			return err == nil
		})
		if err != nil {
			t.Fatalf("force %s: %v", operation, err)
		}
	}
	arm("api-stale", over.Ballot)
	if !w.waitFor(90*time.Second, func() bool { return d2.node.ForceStatus(keyP1).Outcome != ForcePending }) {
		t.Fatal("the override never resolved")
	}
	status := d2.node.ForceStatus(keyP1)
	if status.Outcome != ForceSuperseded || status.Newer != newer {
		t.Fatalf("override over %s: %+v, want superseded by %s", over.Ballot, status, newer)
	}
	if len(w.eventsOf("d2", EventAcquired)) > 0 {
		t.Fatal("the stale override acquired over a newer accepted ballot")
	}
	var marker *ForcedMarker
	w.observers = append(w.observers, func() {
		if committed, ok := d2.node.CommittedState(keyP1); ok && marker == nil && committed.State.Forced != nil {
			marker = committed.State.Forced
		}
	})
	arm("api-decided", status.Newer)
	requireForcedAcquisition(t, w, "d2", "api-decided")
	if marker == nil || marker.OperationID != "api-decided" || marker.Over != newer || marker.Base != newer {
		t.Fatalf("forced marker %+v, want over and base %s", marker, newer)
	}
	w.requireClean(t)
}
