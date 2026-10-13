package availabilitylease

import (
	"testing"
	"time"
)

// N-5: every acceptor reports when it first stored a commit of the current
// holder, on its own clock. Renewals keep it; a takeover moves it to the new
// holder's first commit. Opfield records that as the takeover time instead of
// the moment it heard of the change (stand run rc20: 70 s late after a
// failover while it was down).
func TestAcceptorReportsWhenItFirstSawTheCommitHolder(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     voterRelays(1, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}},
		candidates: []string{"d1", "d2"},
	})
	w.startAll()
	if holder := w.waitHolder(t, keyP1, 60*time.Second); holder != "d1" {
		t.Fatalf("holder %s, want d1", holder)
	}
	first, ok := w.acceptorViewOn("r1", keyP1)
	if !ok || first.CommitBallot.Proposer != "d1" || first.CommitSince <= 0 || first.CommitSince > w.nodes["r1"].local() {
		t.Fatalf("view after the first commit %+v ok=%v", first, ok)
	}
	w.runUntil(w.now + 20*time.Second)
	renewed, _ := w.acceptorViewOn("r1", keyP1)
	if renewed.CommitBallot == first.CommitBallot {
		t.Fatalf("no renewal commit was stored in 20 s")
	}
	if renewed.CommitSince != first.CommitSince {
		t.Fatalf("a renewal moved the holder's since from %s to %s", first.CommitSince, renewed.CommitSince)
	}

	isolatedAt := w.nodes["r1"].local()
	w.isolate("d1", true)
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.runUntil(w.now + time.Second)
	takeover, _ := w.acceptorViewOn("r1", keyP1)
	if takeover.CommitBallot.Proposer != "d2" {
		t.Fatalf("commit holder %s, want d2", takeover.CommitBallot.Proposer)
	}
	if takeover.CommitSince <= isolatedAt || takeover.CommitSince > w.nodes["r1"].local() {
		t.Fatalf("takeover since %s outside (%s, %s]", takeover.CommitSince, isolatedAt, w.nodes["r1"].local())
	}
	w.requireClean(t)
}
