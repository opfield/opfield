package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// gateFlapWorld has two voting relays, a third relay that only shadow-accepts
// (the stand's local relay), a voting holder candidate and a standby.
func gateFlapWorld(t *testing.T) *simWorld {
	return newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "r1", voter: true}, {id: "r2", voter: true}, {id: "r3"}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2"}},
		candidates: []string{"d1", "d2"},
	})
}

// watchGateCloses counts every transition of relay's gate for key from open
// to closed while holder stays the committed holder.
func watchGateCloses(w *simWorld, relay, holder string) *int {
	closes := 0
	open := false
	w.observers = append(w.observers, func() {
		gate := w.nodes[relay].node.Gate(keyP1)
		now := gate.Open && gate.Holder == holder
		if open && !now && gate.Holder == holder {
			closes++
		}
		open = now
	})
	return &closes
}

// Stand run ha18/a: a relay whose promise reached the holder after the round
// already had its quorum of accepts got no propose, so it stored the commit of
// that renewal without an own accept of it. Its gate closed until a later
// renewal where it was fast enough, and every close dropped the holder's
// endpoint registration and tunnels on that relay: bursts of 502 on a stable
// holder.
func TestSlowRelayKeepsItsGateOpenAcrossRenewals(t *testing.T) {
	w := gateFlapWorld(t)
	for _, id := range []string{"d1", "d2"} {
		link := w.link(id, "r3")
		link.minDelay, link.maxDelay = 250*time.Millisecond, 400*time.Millisecond
	}
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	if !w.waitFor(3*RenewInterval, func() bool { return w.nodes["r3"].node.Gate(keyP1).Open }) {
		t.Fatalf("the slow relay never admitted the holder: %+v", w.nodes["r3"].node.Gate(keyP1))
	}
	closes := watchGateCloses(w, "r3", "d1")
	w.runUntil(w.now + 12*RenewInterval)
	w.requireClean(t)
	if *closes != 0 {
		t.Fatalf("the slow relay's gate closed %d times on a stable holder", *closes)
	}
}

// A renewal whose propose never reaches a relay (a lost frame) leaves the relay
// with a commit newer than its own accept. The gate keeps running from the
// relay's latest own accept of the same holder, which closes it no later than
// the committed ballot's own accept would have. When the holder dies the
// successor is still admitted only after that window.
func TestMissedRenewalKeepsTheGateOpenFromTheEarlierOwnAccept(t *testing.T) {
	w := gateFlapWorld(t)
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	if !w.waitFor(3*RenewInterval, func() bool { return w.nodes["r3"].node.Gate(keyP1).Open }) {
		t.Fatalf("the relay never admitted the holder: %+v", w.nodes["r3"].node.Gate(keyP1))
	}
	dropped := 0
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		if from != "d1" || to != "r3" {
			return false
		}
		for _, item := range batch.GetItems() {
			if propose := item.GetPropose(); propose != nil && propose.GetBallot().GetRound()%2 == 0 {
				dropped++
				return true
			}
		}
		return false
	}
	closes := watchGateCloses(w, "r3", "d1")
	w.runUntil(w.now + 12*RenewInterval)
	w.requireClean(t)
	if dropped == 0 {
		t.Fatal("the scenario dropped no propose")
	}
	if *closes != 0 {
		t.Fatalf("the gate closed %d times although every other renewal reached the relay", *closes)
	}

	// Every propose to r3 is lost from now on and d1 dies: r3 admits nobody
	// but d1 until the successor commits, and never both (I2).
	w.drop = func(from, to string, batch *pb.LeaseBatch) bool {
		if to != "r3" {
			return false
		}
		for _, item := range batch.GetItems() {
			if item.GetPropose() != nil && from == "d1" {
				return true
			}
		}
		return false
	}
	w.runUntil(w.now + RenewInterval)
	w.nodes["d1"].freeze()
	w.waitHolderIs(t, keyP1, "d2", 90*time.Second)
	w.runUntil(w.now + 2*RenewInterval)
	w.requireClean(t)
	if gate := w.nodes["r3"].node.Gate(keyP1); gate.Holder == "d1" && gate.Open {
		t.Fatalf("the relay still admits the dead holder after the takeover: %+v", gate)
	}
}
