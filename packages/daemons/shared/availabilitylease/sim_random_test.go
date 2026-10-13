package availabilitylease

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	defaultSimSeeds = 2000
	chaosEnd        = 150 * time.Second
	healTimeout     = 120 * time.Second
	failoverBudget  = 45 * time.Second
	convergeBudget  = 60 * time.Second
)

type simTopology struct {
	relays, daemons int
	candidates      []string
	voters          []string
	replicated      bool
	available       bool
	bootstrap       bool
	adversarial     bool
	// stateful: p1 carries certified holder state (v3) with the database
	// model of sim_state_test.go.
	stateful bool
}

type seedResult struct {
	violation string
	kind      string
	failover  time.Duration
	delivered int
	gateOpen  float64
	// Stateful worlds: certified application transitions and forced
	// acquisitions, for coverage.
	transitions, forces int
}

// buildRandomWorld creates a seeded topology, clocks, network and Gateway.
func buildRandomWorld(seed int64, wire bool) (*simWorld, simTopology) {
	return buildWorld(seed, wire, false)
}

// buildWorld creates the seeded world; stateful makes p1 a strict failover
// policy with holder state, bootstrapped by its first candidate. The draws of
// the random stream stay those of the stateless world.
func buildWorld(seed int64, wire, stateful bool) (*simWorld, simTopology) {
	w := newSimWorld(seed)
	w.wire = wire
	rng := w.rng
	topo := simTopology{relays: 1 + rng.Intn(3), daemons: 4 + rng.Intn(3)}
	topo.adversarial = rng.Float64() < 0.35
	topo.available = rng.Float64() < 0.15
	topo.replicated = !topo.available && rng.Float64() < 0.2
	topo.bootstrap = rng.Float64() < 0.3
	if stateful {
		topo.stateful, topo.available, topo.replicated, topo.bootstrap = true, false, false, true
		w.state = newSimStateModel(w)
	}
	w.net.loss = rng.Float64() * 0.05
	w.net.dup = rng.Float64() * 0.03
	rate := func(fast bool) float64 {
		if topo.adversarial {
			if fast {
				return 1 + MaxClockDrift
			}
			return 1 - MaxClockDrift
		}
		return 1 - MaxClockDrift + rng.Float64()*2*MaxClockDrift
	}
	for i := 1; i <= topo.relays; i++ {
		w.newNode(fmt.Sprintf("r%d", i), true, rate(true))
	}
	candidates := 2 + rng.Intn(2)
	if topo.replicated {
		candidates = 3 + rng.Intn(2)
	}
	for i := 1; i <= topo.daemons; i++ {
		id := fmt.Sprintf("d%d", i)
		if i <= candidates {
			topo.candidates = append(topo.candidates, id)
		}
		w.newNode(id, false, rate(i > candidates))
	}
	w.gw = newSimOpfield(w)
	policy := &simPolicy{id: "p1", slots: 1, available: topo.available, stateful: topo.stateful, candidates: topo.candidates, bootstrap: map[uint32]string{}}
	if topo.replicated {
		policy.slots = 2
	}
	if topo.bootstrap {
		policy.bootstrapID = 1
		policy.bootstrap[0] = topo.candidates[0]
		w.nodes[topo.candidates[0]].containers[Key{PolicyID: "p1"}] = &simContainer{live: true, legacy: true}
	}
	w.gw.policies["p1"] = policy
	w.strict["p1"] = !topo.available
	for slot := uint32(0); slot < policy.slots; slot++ {
		w.keys = append(w.keys, Key{PolicyID: "p1", Slot: slot})
	}
	policy.epoch, policy.sets = 1, [][]string{policyVoters(w, policy.candidates)}
	w.gw.buildManifest(policy)
	if rng.Float64() < 0.35 {
		// A second strict failover policy with its own candidates (sharing
		// some hosts) and its own voters, so holders batch renewals of several
		// keys and one policy's outage must not disturb the other (A18).
		second := &simPolicy{id: "p2", slots: 1, bootstrap: map[uint32]string{}}
		for _, i := range rng.Perm(len(w.daemons))[:2+rng.Intn(2)] {
			second.candidates = append(second.candidates, w.daemons[i])
		}
		second.epoch, second.sets = 1, [][]string{policyVoters(w, second.candidates)}
		w.gw.policies["p2"] = second
		w.strict["p2"] = true
		w.keys = append(w.keys, Key{PolicyID: "p2"})
		w.gw.buildManifest(second)
	}
	return w, topo
}

// policyVoters picks a policy's voters per A18: its candidates in rank
// order (at most 7), then witnesses from the other relays and daemons until
// the count is odd and at least three; sometimes two more witnesses.
func policyVoters(w *simWorld, candidates []string) []string {
	var voters []string
	for _, id := range candidates {
		if len(voters) < maxVoters {
			voters = append(voters, id)
		}
	}
	target := max(3, len(voters))
	if target%2 == 0 {
		target++
	}
	if target+2 <= maxVoters && w.rng.Float64() < 0.3 {
		target += 2
	}
	isCandidate := map[string]bool{}
	for _, id := range candidates {
		isCandidate[id] = true
	}
	var pool []string
	for _, id := range w.ids {
		if !isCandidate[id] {
			pool = append(pool, id)
		}
	}
	w.rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	for len(voters) < target && len(pool) > 0 {
		voters = append(voters, pool[0])
		pool = pool[1:]
	}
	if len(voters)%2 == 0 {
		voters = voters[:len(voters)-1]
	}
	sort.Strings(voters)
	return voters
}

func startWorld(w *simWorld, deliverP float64) {
	w.gw.deliverP = deliverP
	for _, id := range w.ids {
		w.nodes[id].start()
	}
	w.gw.deliverP = 1
}

// runRandomSeed runs one seeded scenario: chaos, heal, then I3 (strict:
// kill the holder, a successor must commit within 45 s) or I4 (available:
// one copy after the heal).
func runRandomSeed(seed int64, trace, wire bool) (*simWorld, seedResult) {
	return runSeed(seed, trace, wire, false)
}

func runSeed(seed int64, trace, wire, stateful bool) (*simWorld, seedResult) {
	w, topo := buildWorld(seed, wire, stateful)
	w.traceOn = trace
	startWorld(w, 0.85)
	scheduleChaos(w, topo)
	w.runUntil(chaosEnd)
	result := seedResult{}
	if w.violation == "" {
		quiet(w, topo)
		if w.gw.policies["p1"].closed {
			// Closed with the Gateway gone: nothing can fail over; the
			// invariants still ran through the whole quiet phase.
			w.runUntil(w.now + healTimeout)
			result.kind = "closed"
		} else if topo.stateful {
			checkStatefulFailover(w, topo, &result)
		} else if topo.available {
			checkConvergence(w, topo, &result)
		} else {
			checkFailover(w, topo, &result)
		}
	}
	result.delivered = w.delivered
	if w.gateChecks > 0 {
		result.gateOpen = float64(w.gateOpenChecks) / float64(w.gateChecks)
	}
	if w.violation != "" {
		result.violation = w.violation
	}
	return w, result
}

func checkFailover(w *simWorld, topo simTopology, result *seedResult) {
	key := Key{PolicyID: "p1"}
	if !w.waitFor(healTimeout, func() bool { return w.holder(key) != "" }) {
		if w.violation == "" && !bootstrapStuck(w, topo) && w.canLearnManifest("p1") {
			w.fail("liveness: no holder %s after heal (live copies %v; %s)", healTimeout, w.liveCopies(key), w.describeCandidates(topo, key))
		}
		result.kind = "no-holder"
		return
	}
	// Let a candidate that restarted without state learn the blocks from
	// the holder's frames (A4 forwarding) before the kill.
	w.waitFor(30*time.Second, func() bool { return w.successorsInformed(topo, w.holder(key)) })
	w.runUntil(w.now + time.Duration(w.rng.Int63n(int64(5*time.Second))))
	holder := w.holder(key)
	if holder == "" {
		result.kind = "holder-moved"
		return
	}
	if !w.successorsInformed(topo, holder) {
		result.kind = "no-informed-successor"
		return
	}
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
		w.fail("I3 violated: no successor for %s within %s of killing %s (took %s)", key, failoverBudget, holder, result.failover)
	}
	result.kind = "failover"
}

// successorsInformed reports whether every up candidate other than holder
// has the holder's manifest version and epoch.
func (w *simWorld) successorsInformed(topo simTopology, holder string) bool {
	if holder == "" {
		return false
	}
	h := w.nodes[holder].node
	for _, id := range topo.candidates {
		n := w.nodes[id]
		if id == holder || !n.processUp() {
			continue
		}
		if n.node.ManifestVersion("p1") < h.ManifestVersion("p1") || n.node.Epoch("p1") < h.Epoch("p1") {
			return false
		}
	}
	return true
}

// canLearnManifest is false when no ready candidate holds a lease-mode
// manifest and config and no Gateway is left to deliver them: a daemon that
// lost its state, or only holds a closed manifest, while the Gateway is down
// waits for the Gateway (documented limit).
func (w *simWorld) canLearnManifest(policyID string) bool {
	if w.gw.alive {
		return true
	}
	for _, id := range w.gw.policies[policyID].candidates {
		n := w.nodes[id]
		// A candidate that only holds a closed manifest does not talk to the
		// members, so it never learns a reopening manifest the Gateway sent
		// to others before it died: it waits for the Gateway (documented).
		if n.processUp() && n.node.LeaseMode(policyID) && n.node.Epoch(policyID) > 0 {
			return true
		}
	}
	return false
}

func (w *simWorld) describeCandidates(topo simTopology, key Key) string {
	var parts []string
	for _, id := range topo.candidates {
		n := w.nodes[id]
		if !n.processUp() {
			parts = append(parts, id+":down")
			continue
		}
		st := n.node.HolderStatus(key)
		parts = append(parts, fmt.Sprintf("%s:%s v%d e%d", id, st.Role, n.node.ManifestVersion("p1"), n.node.Epoch("p1")))
	}
	return strings.Join(parts, " ")
}

// bootstrapStuck reports the designed outcome where the named bootstrap
// holder died before acquiring and no Gateway is left to reissue (A5).
func bootstrapStuck(w *simWorld, topo simTopology) bool {
	return topo.bootstrap && !w.gw.alive && w.gw.policies["p1"].bootstrap[0] != ""
}

// checkConvergence: I4, within convergeBudget of the heal every key runs
// exactly one copy, and keeps running exactly one for another 30 s.
func checkConvergence(w *simWorld, topo simTopology, result *seedResult) {
	result.kind = "converge"
	w.runUntil(w.now + convergeBudget)
	end := w.now + 30*time.Second
	for w.violation == "" && w.now < end {
		for _, key := range w.keys {
			if copies := w.liveCopies(key); len(copies) != 1 {
				if len(copies) == 0 && (!w.canLearnManifest(key.PolicyID) || (key.PolicyID == "p1" && bootstrapStuck(w, topo))) {
					result.kind = "no-manifest"
					return
				}
				w.fail("I4 violated: key %s runs %v copies %s after the heal (%s)", key, copies, convergeBudget, w.describeCandidates(topo, key))
			}
		}
		w.runUntil(w.now + 250*time.Millisecond)
	}
}

func envInt(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value > 0 {
		return value
	}
	return fallback
}

// TestSimulationRandomSeeds runs AVAILABILITY_LEASE_SIM_SEEDS seeded worlds
// (default 2000) starting at AVAILABILITY_LEASE_SIM_SEED_START. For a long
// soak set AVAILABILITY_LEASE_SIM_SEEDS=200000.
func TestSimulationRandomSeeds(t *testing.T) {
	runSeeds(t, false, envInt("AVAILABILITY_LEASE_SIM_SEEDS", defaultSimSeeds), int64(envInt("AVAILABILITY_LEASE_SIM_SEED_START", 1)))
}

// runSeeds runs seeds seeded worlds from first on a few workers and fails
// with the trace of the first violating seed.
func runSeeds(t *testing.T, stateful bool, seeds int, first int64) {
	var next atomic.Int64
	next.Store(first)
	var mu sync.Mutex
	var failures []int64
	kinds := map[string]int{}
	examples := map[string][]int64{}
	var worst time.Duration
	var gateOpen float64
	var transitions, forces int
	var wg sync.WaitGroup
	// At most AVAILABILITY_LEASE_SIM_WORKERS (default 3) workers, never more
	// than GOMAXPROCS, so a run does not take over a developer machine.
	workers := min(envInt("AVAILABILITY_LEASE_SIM_WORKERS", 3), runtime.GOMAXPROCS(0))
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				seed := next.Add(1) - 1
				if seed >= first+int64(seeds) {
					return
				}
				_, result := runSeed(seed, false, false, stateful)
				mu.Lock()
				kinds[result.kind]++
				if result.kind != "failover" && result.kind != "converge" && len(examples[result.kind]) < 5 {
					examples[result.kind] = append(examples[result.kind], seed)
				}
				gateOpen += result.gateOpen
				transitions, forces = transitions+result.transitions, forces+result.forces
				if result.failover > worst {
					worst = result.failover
				}
				if result.violation != "" {
					failures = append(failures, seed)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	t.Logf("seeds=%d outcomes=%v worst failover=%s mean gate-open share=%.1f%%", seeds, kinds, worst, 100*gateOpen/float64(seeds))
	if len(examples) > 0 {
		t.Logf("example seeds of other outcomes: %v", examples)
	}
	if stateful {
		t.Logf("stateful: certified transitions=%d forced acquisitions=%d", transitions, forces)
	}
	if len(failures) > 0 {
		sort.Slice(failures, func(i, j int) bool { return failures[i] < failures[j] })
		for i, seed := range failures {
			if i == 12 {
				break
			}
			_, result := runSeed(seed, false, false, stateful)
			t.Logf("seed %d: %s", seed, result.violation)
		}
		w, result := runSeed(failures[0], true, false, stateful)
		t.Fatalf("%d/%d seeds violated invariants; first seed %d: %s\ntrace tail:\n%s",
			len(failures), seeds, failures[0], result.violation, w.dumpTrace(250))
	}
}

// TestSimulationWireSeeds runs seeds through real ECDSA frame sealing and
// verification and protobuf encoding.
func TestSimulationWireSeeds(t *testing.T) {
	for seed := int64(900001); seed < 900001+int64(envInt("AVAILABILITY_LEASE_SIM_WIRE_SEEDS", 6)); seed++ {
		w, result := runRandomSeed(seed, false, true)
		if result.violation != "" {
			w, result = runRandomSeed(seed, true, true)
			t.Fatalf("wire seed %d: %s\n%s", seed, result.violation, w.dumpTrace(250))
		}
	}
}

// TestSimulationTraceSeed writes the full trace of AVAILABILITY_LEASE_SIM_TRACE_SEED
// to AVAILABILITY_LEASE_SIM_TRACE_FILE, for debugging a failing seed.
func TestSimulationTraceSeed(t *testing.T) {
	seed := envInt("AVAILABILITY_LEASE_SIM_TRACE_SEED", 0)
	path := os.Getenv("AVAILABILITY_LEASE_SIM_TRACE_FILE")
	if seed == 0 || path == "" {
		t.Skip("set AVAILABILITY_LEASE_SIM_TRACE_SEED and AVAILABILITY_LEASE_SIM_TRACE_FILE")
	}
	w, result := runSeed(int64(seed), true, os.Getenv("AVAILABILITY_LEASE_SIM_WIRE") != "", os.Getenv("AVAILABILITY_LEASE_SIM_STATEFUL") != "")
	if err := os.WriteFile(path, []byte(w.dumpTrace(len(w.trace))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("seed %d: kind=%s failover=%s delivered=%d violation=%q", seed, result.kind, result.failover, result.delivered, result.violation)
}
