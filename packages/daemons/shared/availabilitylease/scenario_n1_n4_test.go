package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

func fiveVoterWorld(t *testing.T) *simWorld {
	return newScenario(t, scenarioSpec{
		relays: voterRelays(1, "r1", "r2"),
		daemons: []nodeSpec{{id: "d1"}, {id: "d2"},
			{id: "d3", voter: true}, {id: "d4", voter: true}, {id: "d5", voter: true}},
		candidates: []string{"d1", "d2"},
	})
}

// N1: a resumed holder that can reach only a relay that missed the failover
// is not readmitted by that relay's gate, even though the relay accepts its
// fresh (never committed) ballot. A restarted relay reopens its gate within
// one renewal thanks to shadow accepts.
func TestN1ResumedHolderReachingOnlyStaleRelayIsRefused(t *testing.T) {
	w := fiveVoterWorld(t)
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	d1, r2 := w.nodes["d1"], w.nodes["r2"]
	d1.freeze()
	w.isolate("r2", true) // r2 misses the failover
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	// d1 resumes and reaches r2 only.
	w.link("d1", "r1").up = false
	w.link("d1", "r2").up = true
	resumed := w.now
	d1.resume()
	acceptedAtR2 := false
	w.observers = append(w.observers, func() {
		if lease := r2.node.acceptors[keyP1].lease; lease.holder == "d1" && lease.ballot.Incarnation != 0 && w.now > resumed && lease.openAt(r2.local()) {
			acceptedAtR2 = true
		}
		if gate := r2.node.Gate(keyP1); gate.Open && gate.Holder == "d1" {
			t.Errorf("stale relay readmitted the resumed holder at %s: %+v", w.now, gate)
		}
	})
	w.runUntil(w.now + 10*time.Second)
	if promised := r2.node.acceptors[keyP1].promised(); promised.Proposer != "d1" || !(w.now > resumed) {
		t.Fatalf("the stale relay did not see the resumed holder's fresh ballot: %s", promised)
	}
	// A single accept at the stale relay (the N1 trace: r2 promises and
	// accepts a fresh ballot that can never reach a quorum) must not open
	// the gate either. The resumed proposer cannot send a propose without a
	// quorum of promises, so inject one.
	fresh := Ballot{Round: 5000, Incarnation: d1.node.Incarnation(), Proposer: "d1"}
	epoch, version := r2.node.Epoch("p1"), r2.node.ManifestVersion("p1")
	w.injectFrom("d1", "r2", &pb.LeaseItem{Body: &pb.LeaseItem_Prepare{Prepare: &pb.LeasePrepare{
		Key: keyP1.proto(), Ballot: fresh.proto(), Epoch: epoch, ManifestVersion: version}}})
	w.runUntil(w.now + time.Second)
	var echo uint64
	for _, record := range r2.node.acceptors[keyP1].echoes {
		if record.ballot == fresh {
			echo = record.echo
		}
	}
	w.injectFrom("d1", "r2", &pb.LeaseItem{Body: &pb.LeaseItem_Propose{Propose: &pb.LeasePropose{
		Key: keyP1.proto(), Ballot: fresh.proto(), Epoch: epoch, ManifestVersion: version, Echo: echo}}})
	w.runUntil(w.now + 30*time.Second)
	w.requireClean(t)
	if !acceptedAtR2 {
		t.Fatal("scenario did not exercise a fresh accept of the resumed holder at the stale relay")
	}
	if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d2" {
		t.Fatalf("copies %v, want d2 only", copies)
	}

	t.Run("restarted relay reopens its gate from shadow accepts", func(t *testing.T) {
		w := fiveVoterWorld(t)
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		w.runUntil(w.now + 6*time.Second)
		r1 := w.nodes["r1"]
		restartProcess(w, r1, true, time.Second)
		w.runUntil(w.now + time.Second + time.Millisecond)
		if !w.waitFor(2*RenewInterval, func() bool { return r1.node.Gate(keyP1).Open }) {
			t.Fatalf("gate at the restarted relay closed for more than two renewals: %+v", r1.node.Gate(keyP1))
		}
		if r1.node.voting("p1", r1.local()) {
			t.Fatal("restarted relay should still abstain")
		}
		w.requireClean(t)
	})
}

// N2: the watchdog deadline exists before any start is allowed, and a start
// that completes after the deadline is killed.
func TestN2DeadlineRecordPrecedesEveryStart(t *testing.T) {
	for seed := int64(700); seed < 740; seed++ {
		w, topo := buildRandomWorld(seed, false)
		w.observers = append(w.observers, func() {
			for _, id := range w.daemons {
				n := w.nodes[id]
				if !n.processUp() || n.frozen {
					continue
				}
				for _, key := range w.keys {
					if st := n.node.HolderStatus(key); st.MayStart && st.Deadline <= n.local() {
						t.Errorf("seed %d: %s may start %s without a future deadline", seed, id, key)
					}
				}
			}
		})
		startWorld(w, 1)
		scheduleChaos(w, topo)
		w.runUntil(chaosEnd)
		if w.violation != "" {
			t.Fatalf("seed %d: %s", seed, w.violation)
		}
	}
	t.Run("late start after the deadline is killed", func(t *testing.T) {
		w := twoCandidateWorld(t, false)
		w.nodes["d1"].hangUntil = 90 * time.Second // dockerd stuck during the first start
		w.startAll()
		if !w.waitFor(60*time.Second, func() bool { return w.nodes["d1"].node.HolderStatus(keyP1).Holding }) {
			t.Fatal("d1 never acquired")
		}
		w.isolate("d1", true)
		w.runUntil(100 * time.Second)
		if c := w.nodes["d1"].containers[keyP1]; c != nil && c.live {
			t.Fatal("a start that completed after the deadline kept running")
		}
		w.requireClean(t)
	})
}

// N3: a bare higher-ballot NACK makes the holder retry with a higher ballot;
// only a commit for another holder (or a lease-closed manifest) fences at once.
func TestN3HigherBallotNackRetriesInsteadOfFencing(t *testing.T) {
	w := twoCandidateWorld(t, false)
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	dropping := true
	w.drop = func(from, to string, _ *pb.LeaseBatch) bool { return dropping && from == "d1" && to == "r3" }
	w.runUntil(w.now + 40*time.Second) // d1's lease at r3 lapses; d1 keeps a majority
	r3 := w.nodes["r3"].node
	high := Ballot{Round: 1000, Incarnation: w.nodes["d2"].node.Incarnation(), Proposer: "d2"}
	w.injectFrom("d2", "r3", &pb.LeaseItem{Body: &pb.LeaseItem_Prepare{Prepare: &pb.LeasePrepare{
		Key: keyP1.proto(), Ballot: high.proto(), Epoch: r3.Epoch("p1"), ManifestVersion: r3.ManifestVersion("p1"),
	}}})
	w.runUntil(w.now + time.Second)
	if r3.acceptors[keyP1].promised() != high {
		t.Fatal("r3 did not promise the higher ballot")
	}
	dropping = false
	w.runUntil(w.now + 20*time.Second)
	w.requireClean(t)
	if len(w.eventsOf("d1", EventFence)) != 0 || w.holder(keyP1) != "d1" {
		t.Fatal("holder fenced on a bare higher ballot")
	}
	if issued := w.nodes["d1"].node.proposers[keyP1].lastIssued; issued.Round <= high.Round {
		t.Fatalf("holder did not retry above the higher ballot: %s", issued)
	}
	if lease := r3.acceptors[keyP1].lease; lease.holder != "d1" {
		t.Fatal("r3 did not accept the holder again")
	}

	t.Run("commit for another holder fences at once", func(t *testing.T) {
		w := twoCandidateWorld(t, false)
		// Peer-time freeze detection would fence the resumed holder first
		// (host_frozen); switch it off to check the A13 path on its own.
		w.freezeBudget = time.Hour
		w.startAll()
		w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
		d1 := w.nodes["d1"]
		d1.freeze()
		w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
		d1.resume()
		w.runUntil(w.now + RenewInterval + time.Second)
		fences := w.eventsOf("d1", EventFence)
		if len(fences) == 0 || fences[0].event.Reason != FenceOtherHolder {
			t.Fatalf("resumed holder did not fence on the other holder's commit: %+v", fences)
		}
		w.requireClean(t)
	})
}

// N4: a policy key rotation does not stop failover when the Gateway dies
// before every voter learned the new key: the chain travels with the block.
func TestN4PolicyKeyRotationSurvivesOpfieldLoss(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     voterRelays(1, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}},
		candidates: []string{"d1", "d2"},
	})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	g := w.gw
	previous := g.keys[0]
	next := g.newKey(2)
	link := SignPolicyKeyRotation(previous.id, previous.priv, next.id, next.pub)
	g.links = append(g.links, link)
	g.keys = append(g.keys, next)
	for _, id := range []string{"r1", "r2"} { // a majority of the voters acked
		if err := w.nodes[id].node.AdoptKeyRotation(link); err != nil {
			t.Fatal(err)
		}
	}
	g.signIdx = 1
	v2 := g.buildManifest(g.policies["p1"])
	g.adopt(w.nodes["d2"], v2)
	g.alive = false
	if w.nodes["r3"].node.TrustsPolicyKey(next.id) {
		t.Fatal("r3 must not know the new key yet")
	}
	w.nodes["d1"].crashHost()
	killed := w.now
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	if w.now-killed > failoverBudget+2*time.Second {
		t.Fatalf("failover took %s", w.now-killed)
	}
	r3 := w.nodes["r3"].node
	if !r3.TrustsPolicyKey(next.id) || r3.ManifestVersion("p1") != 2 {
		t.Fatal("r3 did not adopt the rotated key and manifest from forwarded frames")
	}
	w.requireClean(t)
}
