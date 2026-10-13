package availabilitylease

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
)

// addPolicy adds a strict failover policy with its own voters (A18).
func (w *simWorld) addPolicy(id string, candidates, voters []string) Key {
	policy := &simPolicy{id: id, slots: 1, candidates: candidates, bootstrap: map[uint32]string{}, epoch: 1, sets: [][]string{voters}}
	w.gw.policies[id] = policy
	w.strict[id] = true
	key := Key{PolicyID: id}
	w.keys = append(w.keys, key)
	w.gw.buildManifest(policy)
	return key
}

func (w *simWorld) killSite(ids ...string) {
	for _, id := range ids {
		w.nodes[id].crashHost()
	}
}

func (w *simWorld) bootSite(ids ...string) {
	for _, id := range ids {
		w.nodes[id].bootHost()
	}
}

func (w *simWorld) fencesSince(node string, key Key, since time.Duration) int {
	count := 0
	for _, event := range w.eventsOf(node, EventFence) {
		if event.event.Key == key && event.at >= since {
			count++
		}
	}
	return count
}

// The two-site layout (A18): two candidates on different sites and a witness
// relay on a third. Losing any one site keeps the policy running: the holder's
// site fails over within 45 s, the other sites' loss does not disturb it.
func TestA18TwoSiteLayoutSurvivesEachSiteLoss(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		// Sites: A = {d1, r1}, B = {d2, r2}, C = {w}. Only the witness relay
		// votes; r1 and r2 keep shadow accepts for their gates.
		relays:     []nodeSpec{{id: "r1"}, {id: "r2"}, {id: "w", voter: true}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}},
		candidates: []string{"d1", "d2"},
	})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 10*time.Second)

	w.killSite("d1", "r1")
	killed := w.now
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	if w.now-killed > failoverBudget {
		t.Fatalf("site A failover took %s", w.now-killed)
	}
	w.bootSite("d1", "r1")
	w.runUntil(w.now + 60*time.Second)

	since := w.now
	w.killSite("w")
	w.runUntil(w.now + 60*time.Second)
	if w.holder(keyP1) != "d2" || w.fencesSince("d2", keyP1, since) != 0 {
		t.Fatal("losing the witness site disturbed the holder")
	}
	w.bootSite("w")
	w.runUntil(w.now + 40*time.Second)

	since = w.now
	w.killSite("d1", "r1")
	w.runUntil(w.now + 60*time.Second)
	if w.holder(keyP1) != "d2" || w.fencesSince("d2", keyP1, since) != 0 {
		t.Fatal("losing the standby site disturbed the holder")
	}
	w.bootSite("d1", "r1")
	w.runUntil(w.now + 60*time.Second)

	w.killSite("d2", "r2")
	killed = w.now
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	if w.now-killed > failoverBudget {
		t.Fatalf("site B failover took %s", w.now-killed)
	}
	w.runUntil(w.now + 30*time.Second)
	w.requireClean(t)
}

// A18: unrelated policies have unrelated quorums. An outage that takes one
// policy's holder and witness down leaves another policy's holder alone, and
// a node voting for one policy does not count for the other.
func TestA18SiteOutageDoesNotAffectAnotherPolicy(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "r1"}, {id: "r2"}, {id: "w1", voter: true}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}, {id: "d3"}, {id: "d4"}, {id: "w2"}},
		candidates: []string{"d1", "d2"},
	})
	keyP2 := w.addPolicy("p2", []string{"d3", "d4"}, []string{"d3", "d4", "w2"})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.waitHolderIs(t, keyP2, "d3", 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	since := w.now
	w.killSite("d1", "w1") // p1 loses its holder and its witness
	w.runUntil(w.now + 90*time.Second)
	if w.holder(keyP2) != "d3" || w.fencesSince("d3", keyP2, since) != 0 {
		t.Fatal("p1's outage disturbed p2")
	}
	if copies := w.liveCopies(keyP1); len(copies) != 0 {
		t.Fatalf("p1 runs %v without a majority of its own voters", copies)
	}
	if w.nodes["d2"].node.voting("p2", w.nodes["d2"].local()) || !w.nodes["d2"].node.voting("p1", w.nodes["d2"].local()) {
		t.Fatal("d2 votes only for p1")
	}
	w.bootSite("d1", "w1")
	w.waitFor(90*time.Second, func() bool { return w.holder(keyP1) != "" })
	w.requireClean(t)
}

// A18: a witness change mid-lease goes through a joint epoch of the policy;
// the holder keeps its lease, and afterwards the old witness no longer counts.
func TestA18WitnessChangeMidLease(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "wold", voter: true}, {id: "wnew"}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}},
		candidates: []string{"d1", "d2"},
	})
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 10*time.Second)
	since := w.now
	w.gw.changeVoters("p1", []string{"d1", "d2", "wnew"}, 1)
	policy := w.gw.policies["p1"]
	if !w.waitFor(120*time.Second, func() bool { return !policy.joint }) {
		t.Fatal("voter change did not settle")
	}
	w.runUntil(w.now + 10*time.Second)
	if w.holder(keyP1) != "d1" || w.fencesSince("d1", keyP1, since) != 0 {
		t.Fatal("the witness change disturbed the holder")
	}
	for _, id := range w.ids {
		if got := w.nodes[id].node.Epoch("p1"); got != policy.epoch {
			t.Fatalf("%s at voter epoch %d, want %d", id, got, policy.epoch)
		}
	}
	w.killSite("wold")
	w.killSite("d1")
	killed := w.now
	w.waitHolderIs(t, keyP1, "d2", 60*time.Second)
	if w.now-killed > failoverBudget {
		t.Fatalf("failover through the new witness took %s", w.now-killed)
	}
	w.requireClean(t)
}

// A proposer stops originating rounds and queries for a slot the adopted
// manifest removed (scale-down, lowered surge).
func TestRemovedSlotStopsNewRounds(t *testing.T) {
	w := newScenario(t, scenarioSpec{
		relays:     voterRelays(1, "r1", "r2", "r3"),
		daemons:    []nodeSpec{{id: "d1"}, {id: "d2"}, {id: "d3"}},
		candidates: []string{"d1", "d2", "d3"},
		slots:      2,
	})
	slot1 := Key{PolicyID: "p1", Slot: 1}
	w.startAll()
	w.waitHolder(t, keyP1, 60*time.Second)
	w.waitHolder(t, slot1, 60*time.Second)
	policy := w.gw.policies["p1"]
	policy.slots = 1
	w.gw.deliver(w.gw.buildManifest(policy), 1)
	adopted := w.now
	var late []string
	w.record = func(from, to string, batch *pb.LeaseBatch) {
		if w.now < adopted+time.Second {
			return
		}
		for _, item := range batch.GetItems() {
			var key *pb.LeaseKey
			switch body := item.GetBody().(type) {
			case *pb.LeaseItem_Prepare:
				key = body.Prepare.GetKey()
			case *pb.LeaseItem_Propose:
				key = body.Propose.GetKey()
			case *pb.LeaseItem_Query:
				key = body.Query.GetKeys()[0]
			}
			if key != nil && key.GetSlot() == 1 {
				late = append(late, from+"->"+to)
			}
		}
	}
	w.runUntil(w.now + 60*time.Second)
	if len(late) > 0 {
		t.Fatalf("%d rounds or queries for the removed slot, first %v", len(late), late[0])
	}
	if w.holder(keyP1) == "" {
		t.Fatal("the remaining slot lost its holder")
	}
	w.requireClean(t)
}
