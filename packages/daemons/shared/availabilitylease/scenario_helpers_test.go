package availabilitylease

import (
	"sort"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// nodeSpec describes one host in a scripted scenario.
type nodeSpec struct {
	id    string
	rate  float64
	voter bool
}

type scenarioSpec struct {
	relays     []nodeSpec
	daemons    []nodeSpec
	candidates []string
	available  bool
	slots      uint32
	bootstrap  string
	seed       int64
	wire       bool
	// stateful: p1 carries certified holder state with the database model
	// driven by the test (manual sync-set changes).
	stateful bool
}

// newScenario builds a lossless, deterministic world from spec and starts
// every node with the config and manifest delivered.
func newScenario(t *testing.T, spec scenarioSpec) *simWorld {
	t.Helper()
	seed := spec.seed
	if seed == 0 {
		seed = 42
	}
	w := newSimWorld(seed)
	w.wire = spec.wire
	var voters []string
	for _, n := range spec.relays {
		w.newNode(n.id, true, rateOr(n.rate))
		if n.voter {
			voters = append(voters, n.id)
		}
	}
	for _, n := range spec.daemons {
		w.newNode(n.id, false, rateOr(n.rate))
		if n.voter {
			voters = append(voters, n.id)
		}
	}
	sort.Strings(voters)
	w.gw = newSimGateway(w)
	slots := spec.slots
	if slots == 0 {
		slots = 1
	}
	policy := &simPolicy{id: "p1", slots: slots, available: spec.available, candidates: spec.candidates, bootstrap: map[uint32]string{}}
	if spec.bootstrap != "" {
		policy.bootstrapID = 1
		policy.bootstrap[0] = spec.bootstrap
		w.nodes[spec.bootstrap].containers[Key{PolicyID: "p1"}] = &simContainer{live: true, legacy: true}
	}
	if spec.stateful {
		policy.stateful = true
		w.state = newSimStateModel(w)
		w.state.manual = true
	}
	w.gw.policies["p1"] = policy
	w.strict["p1"] = !spec.available
	for slot := uint32(0); slot < slots; slot++ {
		w.keys = append(w.keys, Key{PolicyID: "p1", Slot: slot})
	}
	policy.epoch, policy.sets = 1, [][]string{voters}
	w.gw.buildManifest(policy)
	if testing.Verbose() {
		w.traceOn = true
	}
	return w
}

func rateOr(rate float64) float64 {
	if rate == 0 {
		return 1
	}
	return rate
}

func (w *simWorld) startAll() {
	for _, id := range w.ids {
		w.nodes[id].start()
	}
}

// requireClean fails the test on any invariant violation, with the trace.
func (w *simWorld) requireClean(t *testing.T) {
	t.Helper()
	if w.violation != "" {
		t.Fatalf("%s\n%s", w.violation, w.dumpTrace(200))
	}
}

// waitHolder runs until key has a unique holder with a live container.
func (w *simWorld) waitHolder(t *testing.T, key Key, timeout time.Duration) string {
	t.Helper()
	var holder string
	if !w.waitFor(timeout, func() bool { holder = w.holder(key); return holder != "" }) {
		w.requireClean(t)
		t.Fatalf("no holder for %s within %s\n%s", key, timeout, w.dumpTrace(120))
	}
	return holder
}

// waitHolderIs runs until id is the unique holder of key.
func (w *simWorld) waitHolderIs(t *testing.T, key Key, id string, timeout time.Duration) {
	t.Helper()
	if !w.waitFor(timeout, func() bool { return w.holder(key) == id }) {
		w.requireClean(t)
		t.Fatalf("%s did not become the holder of %s within %s (holder %q)\n%s", id, key, timeout, w.holder(key), w.dumpTrace(120))
	}
}

// isolate takes every link of id down (or up again).
func (w *simWorld) isolate(id string, down bool) {
	n := w.nodes[id]
	for _, other := range w.ids {
		o := w.nodes[other]
		if other == id || o.relay == n.relay {
			continue
		}
		w.link(id, other).up = !down
	}
}

// containerLog records when containers become live or die.
type containerEvent struct {
	node string
	key  Key
	live bool
	at   time.Duration
}

// watchContainers samples container liveness after every event.
func (w *simWorld) watchContainers() *[]containerEvent {
	log := &[]containerEvent{}
	state := map[string]bool{}
	w.observers = append(w.observers, func() {
		for _, id := range w.daemons {
			n := w.nodes[id]
			for _, key := range w.keys {
				c := n.containers[key]
				live := n.hostUp && c != nil && c.live
				name := id + "|" + key.String()
				if state[name] != live {
					state[name] = live
					*log = append(*log, containerEvent{node: id, key: key, live: live, at: w.now})
				}
			}
		}
	})
	return log
}

func lastChange(log []containerEvent, node string, live bool) (time.Duration, bool) {
	for i := len(log) - 1; i >= 0; i-- {
		if log[i].node == node && log[i].live == live {
			return log[i].at, true
		}
	}
	return 0, false
}

func firstChange(log []containerEvent, node string, live bool, after time.Duration) (time.Duration, bool) {
	for _, event := range log {
		if event.node == node && event.live == live && event.at >= after {
			return event.at, true
		}
	}
	return 0, false
}

// injectFrom sends a batch as if node from had produced it.
func (w *simWorld) injectFrom(from, to string, items ...*pb.LeaseItem) {
	n := w.nodes[from]
	n.node.mu.Lock()
	n.node.messageSeq++
	batch := &pb.LeaseBatch{
		MessageId: from + "/inject/" + time.Duration(n.node.messageSeq).String(),
		SenderId:  from, SenderIncarnation: n.node.incarnation, DestinationId: to, Items: items,
	}
	n.node.mu.Unlock()
	w.send(from, to, batch)
}

func (w *simWorld) eventsOf(node string, kind EventKind) []simEvent2 {
	var out []simEvent2
	for _, event := range w.events2 {
		if event.node == node && event.event.Kind == kind {
			out = append(out, event)
		}
	}
	return out
}

type simEvent2 struct {
	node  string
	event Event
	at    time.Duration
}

// acceptorViewOn returns the acceptor view of key on node id.
func (w *simWorld) acceptorViewOn(id string, key Key) (KeyView, bool) {
	for _, view := range w.nodes[id].node.AcceptorView() {
		if view.Key == key {
			return view, true
		}
	}
	return KeyView{}, false
}
