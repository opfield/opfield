package availabilitylease

import (
	"container/heap"
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// simWorld is a deterministic discrete-event simulation of relays, daemon
// voters, candidates, Opfield, the network and host faults. Real time is
// w.now; every node has its own drifting, freezable clock.
type simWorld struct {
	seed    int64
	rng     *rand.Rand
	now     time.Duration
	seq     uint64
	events  eventHeap
	nodes   map[string]*simNode
	ids     []string
	relays  []string
	daemons []string
	links   map[string]*simLink
	net     simNetParams
	gw      *simOpfield
	// state models the application of stateful policies (v3); nil when the
	// world has none.
	state  *simStateModel
	keys   []Key
	strict map[string]bool
	wire   bool

	// freezeDrift is the nodes' FreezeDriftRate: drifting clocks need more
	// than the production default. noBeacons turns relay clock beacons off.
	freezeDrift  float64
	freezeBudget time.Duration
	noBeacons    bool

	violation string
	chaosOver bool
	checkI1   bool
	checkI2   bool
	traceOn   bool
	trace     []string
	onAcquire func(node string, key Key, at time.Duration)
	acquired  []simAcquire
	delivered int

	gateChecks, gateOpenChecks int

	// Scripted scenarios: observers run after every event, drop filters
	// frames, record sees every frame sent, events2 logs node events.
	observers []func()
	drop      func(from, to string, batch *pb.LeaseBatch) bool
	record    func(from, to string, batch *pb.LeaseBatch)
	events2   []simEvent2
}

type simAcquire struct {
	node string
	key  Key
	at   time.Duration
}

type simNetParams struct {
	minDelay, maxDelay time.Duration
	loss, dup          float64
}

type simLink struct {
	up                 bool
	downCount          int
	minDelay, maxDelay time.Duration
	loss               float64
}

type simEvent struct {
	at  time.Duration
	seq uint64
	fn  func()
}

type eventHeap []*simEvent

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].at != h[j].at {
		return h[i].at < h[j].at
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(*simEvent)) }
func (h *eventHeap) Pop() any {
	old := *h
	item := old[len(old)-1]
	*h = old[:len(old)-1]
	return item
}

// simFreezeDrift covers two clocks at the opposite ends of MaxClockDrift.
const simFreezeDrift = 2.5 * MaxClockDrift

func newSimWorld(seed int64) *simWorld {
	return &simWorld{
		seed: seed, rng: rand.New(rand.NewSource(seed)), nodes: map[string]*simNode{}, links: map[string]*simLink{},
		strict: map[string]bool{}, checkI1: true, checkI2: true,
		net: simNetParams{minDelay: 5 * time.Millisecond, maxDelay: 60 * time.Millisecond},
	}
}

func (w *simWorld) at(at time.Duration, fn func()) {
	if at < w.now {
		at = w.now
	}
	w.seq++
	heap.Push(&w.events, &simEvent{at: at, seq: w.seq, fn: fn})
}

func (w *simWorld) after(delay time.Duration, fn func()) { w.at(w.now+delay, fn) }

func (w *simWorld) tracef(format string, args ...any) {
	if w.traceOn {
		w.trace = append(w.trace, fmt.Sprintf("%9.3fs ", w.now.Seconds())+fmt.Sprintf(format, args...))
	}
}

func (w *simWorld) fail(format string, args ...any) {
	if w.violation == "" {
		w.violation = fmt.Sprintf("t=%.3fs ", w.now.Seconds()) + fmt.Sprintf(format, args...)
		w.tracef("VIOLATION %s", w.violation)
	}
}

// runUntil processes events up to end, checking invariants after each.
func (w *simWorld) runUntil(end time.Duration) {
	for w.violation == "" && w.events.Len() > 0 {
		next := w.events[0]
		if next.at > end {
			break
		}
		heap.Pop(&w.events)
		w.now = next.at
		next.fn()
		w.checkInvariants()
		for _, observe := range w.observers {
			observe()
		}
	}
	if w.now < end {
		w.now = end
	}
}

func (w *simWorld) randDuration(min, max time.Duration) time.Duration {
	if max <= min {
		return min
	}
	return min + time.Duration(w.rng.Int63n(int64(max-min)))
}

func linkName(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

func (w *simWorld) link(a, b string) *simLink {
	name := linkName(a, b)
	l := w.links[name]
	if l == nil {
		l = &simLink{up: true, minDelay: w.net.minDelay, maxDelay: w.net.maxDelay}
		w.links[name] = l
	}
	return l
}

func (w *simWorld) addNode(id string, relay bool, rate float64) *simNode {
	if rate != 1 {
		w.freezeDrift = simFreezeDrift
	}
	n := &simNode{
		id: id, relay: relay, w: w, rate: rate, hostUp: true, store: NewMemoryStore(),
		containers: map[Key]*simContainer{}, watchdog: map[Key]time.Duration{}, ready: true,
	}
	n.baseLocal = time.Duration(w.rng.Int63n(int64(1000 * time.Second)))
	w.nodes[id] = n
	w.ids = append(w.ids, id)
	sort.Strings(w.ids)
	if relay {
		w.relays = append(w.relays, id)
	} else {
		w.daemons = append(w.daemons, id)
	}
	return n
}

// send routes a batch: daemon<->relay directly, daemon->daemon via up to two
// relays, with per-hop loss, delay and duplication.
func (w *simWorld) send(from, to string, batch *pb.LeaseBatch) {
	var payload []byte
	if w.wire {
		payload = w.seal(w.nodes[from], batch)
	}
	w.sendPayload(from, to, batch, payload)
}

// sendPayload routes a batch; in wire mode payload is the encoded frame the
// sending node sealed, delivered to ReceiveFrame unchanged.
func (w *simWorld) sendPayload(from, to string, batch *pb.LeaseBatch, payload []byte) {
	src, dst := w.nodes[from], w.nodes[to]
	if src == nil || dst == nil || !src.hostUp {
		return
	}
	if w.record != nil {
		w.record(from, to, batch)
	}
	if w.drop != nil && w.drop(from, to, batch) {
		return
	}
	deliver := func(delay time.Duration, via *simNode, viaGen uint64) {
		w.after(delay, func() {
			if via != nil && (!via.processUp() || via.gen != viaGen) {
				return
			}
			dst.deliver(from, batch, payload)
		})
		if w.rng.Float64() < w.net.dup {
			w.after(delay+w.randDuration(0, 500*time.Millisecond), func() { dst.deliver(from, batch, payload) })
		}
	}
	if src.relay || dst.relay {
		l := w.link(from, to)
		if !l.up || w.rng.Float64() < l.loss+w.net.loss {
			return
		}
		deliver(w.randDuration(l.minDelay, l.maxDelay), nil, 0)
		return
	}
	paths := 0
	for _, i := range w.rng.Perm(len(w.relays)) {
		relay := w.nodes[w.relays[i]]
		l1, l2 := w.link(from, relay.id), w.link(relay.id, to)
		if !relay.processUp() || !l1.up || !l2.up {
			continue
		}
		paths++
		if w.rng.Float64() >= l1.loss+w.net.loss && w.rng.Float64() >= l2.loss+w.net.loss {
			deliver(w.randDuration(l1.minDelay, l1.maxDelay)+w.randDuration(l2.minDelay, l2.maxDelay), relay, relay.gen)
		}
		if paths == 2 {
			break
		}
	}
}

func (w *simWorld) seal(src *simNode, batch *pb.LeaseBatch) []byte {
	frame, err := SealFrame(batch, src.signer)
	if err != nil {
		w.fail("seal: %v", err)
		return nil
	}
	data, _ := proto.Marshal(frame)
	return data
}

func (w *simWorld) setPartition(isolated map[string]bool) {
	for _, d := range w.daemons {
		for _, r := range w.relays {
			w.link(d, r).up = isolated[d] == isolated[r]
		}
	}
}

func (w *simWorld) healAll() {
	for _, l := range w.links {
		l.up, l.loss = true, 0
		l.minDelay, l.maxDelay = w.net.minDelay, w.net.maxDelay
	}
}

func (w *simWorld) dumpTrace(limit int) string {
	lines := w.trace
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return strings.Join(lines, "\n")
}

func (w *simWorld) describeBatch(batch *pb.LeaseBatch) string {
	var parts []string
	for _, item := range batch.GetItems() {
		switch body := item.GetBody().(type) {
		case *pb.LeaseItem_Prepare:
			parts = append(parts, "prepare "+ballotFromProto(body.Prepare.GetBallot()).String())
		case *pb.LeaseItem_Promise:
			parts = append(parts, fmt.Sprintf("promise %s shadow=%v%s", ballotFromProto(body.Promise.GetBallot()), body.Promise.GetShadow(), describeAccepted(body.Promise.GetAccepted())))
		case *pb.LeaseItem_Propose:
			parts = append(parts, "propose "+ballotFromProto(body.Propose.GetBallot()).String())
		case *pb.LeaseItem_Accepted:
			parts = append(parts, "accepted "+ballotFromProto(body.Accepted.GetBallot()).String())
		case *pb.LeaseItem_Nack:
			parts = append(parts, fmt.Sprintf("nack %s %s holder=%s", ballotFromProto(body.Nack.GetBallot()), body.Nack.GetReason(), body.Nack.GetHolderId()))
		case *pb.LeaseItem_Commit:
			parts = append(parts, "commit "+ballotFromProto(body.Commit.GetBallot()).String())
		case *pb.LeaseItem_Release:
			parts = append(parts, fmt.Sprintf("release %s %s succ=%s", ballotFromProto(body.Release.GetBallot()), body.Release.GetPhase(), body.Release.GetSuccessorId()))
		case *pb.LeaseItem_ReleaseAck:
			parts = append(parts, "release-ack")
		case *pb.LeaseItem_Query:
			parts = append(parts, "query")
		case *pb.LeaseItem_Status:
			parts = append(parts, fmt.Sprintf("status %s holder=%s%s", body.Status.GetState(), body.Status.GetHolderId(), describeAccepted(body.Status.GetAccepted())))
		}
	}
	if len(batch.GetBlocks()) > 0 {
		parts = append(parts, fmt.Sprintf("+%d blocks", len(batch.GetBlocks())))
	}
	return strings.Join(parts, "; ")
}
