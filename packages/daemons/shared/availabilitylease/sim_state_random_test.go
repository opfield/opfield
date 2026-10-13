package availabilitylease

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestSimulationStatefulSeeds runs AVAILABILITY_LEASE_SIM_STATEFUL_SEEDS
// (default 500) seeded worlds whose p1 carries certified holder state, with
// I1–I4 plus I5 and I6 checked after every event, acceptor wipes at any
// step, voter changes while holder-less, forced acquisitions (single and
// racing) and a second stateless policy on the same nodes.
func TestSimulationStatefulSeeds(t *testing.T) {
	runSeeds(t, true, envInt("AVAILABILITY_LEASE_SIM_STATEFUL_SEEDS", 500), int64(envInt("AVAILABILITY_LEASE_SIM_SEED_START", 1)))
}

// TestSimulationStatefulWireSeeds runs stateful seeds through real ECDSA
// signatures, so accept v2 statements and state hashes are verified on the
// wire path.
func TestSimulationStatefulWireSeeds(t *testing.T) {
	for seed := int64(910001); seed < 910001+int64(envInt("AVAILABILITY_LEASE_SIM_WIRE_SEEDS", 4)); seed++ {
		w, result := runSeed(seed, false, true, true)
		if result.violation != "" {
			w, result = runSeed(seed, true, true, true)
			t.Fatalf("stateful wire seed %d: %s\n%s", seed, result.violation, w.dumpTrace(250))
		}
	}
}

// statefulFault replaces some faults in stateful worlds: operators force an
// acquisition (sometimes two at once, API and CLI), a planned handoff goes to
// a certified sync member only, a health release never releases to nobody
// (AS6), and a voter change sometimes happens while the key is holder-less.
func statefulFault(w *simWorld, topo simTopology, kind faultKind) bool {
	key := Key{PolicyID: "p1"}
	m := w.state
	switch kind {
	case faultClose:
		// A stateful policy is never reopened on the same policy id: the
		// Opfield closes it once and enables again with a fresh id (M10).
		return true
	case faultManifestBump:
		if w.rng.Intn(2) == 0 {
			return false
		}
		racers := 1 + w.rng.Intn(2)
		for i, index := range w.rng.Perm(len(topo.candidates))[:racers] {
			n := w.nodes[topo.candidates[index]]
			m.seq++
			operation := fmt.Sprintf("%s-%s-%d", []string{"api", "cli"}[i], n.id, m.seq)
			err := m.force(n, key, operation)
			w.tracef("operator force %s on %s: %v", operation, n.id, err)
		}
		return true
	case faultHandoff, faultHealthRelease:
		holder, sync, _ := m.holderSync(key)
		if holder == "" || len(sync) == 0 || (kind == faultHandoff && !w.gw.alive) {
			return true
		}
		if _, pending := w.nodes[holder].node.PendingState(key); pending {
			// The release rule looks at certified and pending state alike.
			return true
		}
		successor := ""
		if kind == faultHandoff {
			for _, i := range w.rng.Perm(len(sync)) {
				if n := w.nodes[sync[i]]; n != nil && n.processUp() {
					successor = sync[i]
					break
				}
			}
			if successor == "" {
				return true
			}
		}
		if w.nodes[holder].beginDrain(key, successor) {
			w.tracef("drain %s successor=%q", holder, successor)
		}
		return true
	case faultEpochChange:
		if w.rng.Intn(2) == 0 {
			return false
		}
		// Voter replacement while the key is holder-less (B1).
		if holder := w.holder(key); holder != "" {
			n := w.nodes[holder]
			n.crashHost()
			w.after(w.randDuration(5*time.Second, 40*time.Second), func() {
				if !n.hostUp && !w.chaosOver {
					n.bootHost()
				}
			})
		}
		policy := w.gw.policies["p1"]
		w.gw.changeVoters(policy.id, policyVoters(w, policy.candidates), 0.6)
		return true
	}
	return false
}

// checkStatefulFailover is I3 for a stateful policy: after the heal a holder
// exists (an operator forces one when no candidate is eligible or no KNOWN
// majority is left, the documented recovery), certifies every other
// candidate as a sync member, and a successor takes over within 45 s of its
// death.
func checkStatefulFailover(w *simWorld, topo simTopology, result *seedResult) {
	key := Key{PolicyID: "p1"}
	m := w.state
	m.syncAll = true
	defer func() { result.transitions, result.forces = m.transitions, m.forces }()
	if !w.waitFor(healTimeout, func() bool { return w.holder(key) != "" }) {
		if w.violation != "" {
			return
		}
		if !forceRecovery(w, topo, key) {
			if w.violation == "" && !bootstrapStuck(w, topo) && w.canLearnManifest("p1") {
				w.fail("liveness: no holder %s after heal, not even forced (%s)", healTimeout, w.describeCandidates(topo, key))
			}
			result.kind = "no-holder"
			return
		}
	}
	// Ready: a promoted holder that is not draining, with every other
	// candidate certified as a sync member, nothing pending, and every up
	// voter KNOWN, so any successor is eligible under a KNOWN majority.
	readyHolder := func() string {
		holder, sync, promoted := m.holderSync(key)
		if holder == "" || !promoted || strings.Join(sync, ",") != strings.Join(m.otherCandidates(key, holder), ",") {
			return ""
		}
		n := w.nodes[holder]
		if c := n.containers[key]; c == nil || c.draining {
			return ""
		}
		if _, pending := n.node.PendingState(key); pending || !w.votersKnown(key) {
			return ""
		}
		return holder
	}
	holder := ""
	for attempt := 0; attempt < 5 && holder == ""; attempt++ {
		// The holder can be lost after the heal with no KNOWN majority left
		// (two voters wiped while Opfield is gone): after 30 s without
		// one the operator forces again, the documented recovery as above.
		var lostSince time.Duration = -1
		if !w.waitFor(90*time.Second, func() bool {
			if readyHolder() != "" {
				return true
			}
			switch {
			case w.holder(key) != "":
				lostSince = -1
			case lostSince < 0:
				lostSince = w.now
			case w.now-lostSince >= 30*time.Second:
				lostSince = -1
				forceRecovery(w, topo, key)
			}
			return false
		}) {
			if w.violation == "" {
				w.fail("liveness: the holder never certified every candidate as a sync member (%s)", w.describeCandidates(topo, key))
			}
			return
		}
		candidate := readyHolder()
		w.waitFor(30*time.Second, func() bool { return w.successorsInformed(topo, candidate) })
		w.runUntil(w.now + time.Duration(w.rng.Int63n(int64(5*time.Second))))
		if readyHolder() == candidate && w.successorsInformed(topo, candidate) {
			holder = candidate
		}
	}
	if w.violation != "" || holder == "" {
		result.kind = "holder-moved"
		return
	}
	w.tracef("stateful failover check: killing holder %s", holder)
	w.nodes[holder].crashHost()
	killedAt := w.now
	w.acquired = nil
	ok := w.waitFor(failoverBudget+10*time.Second, func() bool {
		for _, acquired := range w.acquired {
			if acquired.key == key && acquired.node != holder {
				result.failover = acquired.at - killedAt
				return true
			}
		}
		return false
	})
	if w.violation != "" {
		return
	}
	if !ok || result.failover > failoverBudget {
		w.fail("I3 violated: no eligible successor for %s within %s of killing %s (took %s)", key, failoverBudget, holder, result.failover)
	}
	result.kind = "failover"
}

// forceRecovery plays the operator: force an acquisition on the first up
// candidate over the latest commit it knows, retrying while no strict voter
// majority answers yet.
func forceRecovery(w *simWorld, topo simTopology, key Key) bool {
	end := w.now + 90*time.Second
	for w.violation == "" && w.now < end {
		if w.holder(key) != "" {
			return true
		}
		for _, id := range topo.candidates {
			n := w.nodes[id]
			if !n.processUp() || n.node == nil || n.node.ForceStatus(key).Outcome == ForcePending {
				continue
			}
			w.state.seq++
			err := w.state.force(n, key, fmt.Sprintf("recovery-%s-%d", id, w.state.seq))
			w.tracef("operator recovery force on %s: %v", id, err)
			if err == nil {
				break
			}
		}
		w.runUntil(w.now + 2*time.Second)
	}
	return w.holder(key) != ""
}

// votersKnown reports whether every up voter of p1 remembers the key.
func (w *simWorld) votersKnown(key Key) bool {
	for _, set := range w.gw.policies[key.PolicyID].sets {
		for _, id := range set {
			n := w.nodes[id]
			if !n.processUp() || n.node == nil {
				continue
			}
			view, ok := w.acceptorViewOn(id, key)
			if !ok || !view.StateKnown {
				return false
			}
		}
	}
	return true
}
