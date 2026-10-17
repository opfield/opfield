package lease

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/daemon-shared/leasefence"
	pb "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

const (
	testPolicy = "p1"
	worldTick  = 50 * time.Millisecond
)

type fakeClock struct{ now time.Duration }

func (c *fakeClock) Now() time.Duration { return c.now }

type relayHost struct {
	id   string
	key  *ecdsa.PrivateKey
	node *availabilitylease.Node
	down bool
}

type daemonHost struct {
	id        string
	key       *ecdsa.PrivateKey
	store     availabilitylease.Store
	engine    *fakeEngine
	fence     *fakeFence
	endpoints *fakeEndpoints
	runtime   *Runtime
	ops       []func()
	down      bool // the whole host is dead
	cut       bool // the host is partitioned from everyone
	// daemonOff: the docker daemon process is gone (or a pre-lease
	// version); the host, Docker and the watchdog keep running.
	daemonOff bool
	// frozen: the VM is paused (every process and clock of the host stands
	// still); lag is the local time it lost to past freezes.
	frozen bool
	lag    time.Duration
	// residualUntil exempts the host from the single-copy check right after
	// a resume, until the first frame could reach it (A2.5 residual).
	residualUntil time.Duration
	// fences collects the reasons of the fence events fenceLog drained.
	fences []string
	// controller, when set, owns policies of this daemon's runtime.
	controller Controller
}

// hostClock is a daemon host's BOOTTIME: the world clock minus the time the
// host spent frozen.
type hostClock struct {
	w *world
	h *daemonHost
}

func (c hostClock) Now() time.Duration { return c.w.hostNow(c.h) }

func (c hostClock) Origin() uint64 { return uint64(len(c.h.id))<<40 | 0xb007 }

func (w *world) hostNow(h *daemonHost) time.Duration { return w.clock.now - h.lag }

// world is a lossless, deterministic cluster: relays and daemons run real
// availabilitylease nodes; Docker, the watchdog and endpoints are fakes.
type world struct {
	t          *testing.T
	clock      *fakeClock
	wallJump   time.Duration
	policyID   string
	policyPriv ed25519.PrivateKey
	relays     []*relayHost
	daemons    []*daemonHost
	byID       map[string]any
	queue      []*pb.CoordinationFrame
	seq        int
	log        []string
	violations []string
	manifest   *pb.LeaseSignedBlock
	manifestV  uint64
	candidates []string
	voters     []string
	bootstrap  string
	closed     bool
	available  bool
	slots      uint32
	watchdogOn bool
	logger     *slog.Logger
	// Graceful close and re-entry: retained holders of a closed manifest,
	// and per-slot bootstrap holders with their bootstrap id.
	retained       map[uint32]availabilitylease.RetainedHolder
	bootstrapSlots map[uint32]string
	bootstrapID    uint64
	// blocked cuts single links, in both directions.
	blocked map[string]bool
}

type worldSpec struct {
	relays     []string
	daemons    []string
	candidates []string
	// voters defaults to the relays.
	voters    []string
	bootstrap string
	available bool
	slots     uint32
}

func newWorld(t *testing.T, spec worldSpec) *world {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	w := &world{
		t: t, clock: &fakeClock{now: time.Hour}, policyID: testPolicy, policyPriv: priv, byID: map[string]any{},
		candidates: spec.candidates, voters: spec.voters, bootstrap: spec.bootstrap, available: spec.available, slots: max(spec.slots, 1), watchdogOn: true,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), blocked: map[string]bool{},
	}
	if len(w.voters) == 0 {
		w.voters = spec.relays
	}
	for _, id := range spec.relays {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		w.relays = append(w.relays, &relayHost{id: id, key: key})
	}
	for _, id := range spec.daemons {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		h := &daemonHost{id: id, key: key, store: availabilitylease.NewMemoryStore()}
		h.engine = &fakeEngine{w: w, host: h, containers: map[string]*Container{}}
		h.fence = &fakeFence{w: w, records: map[string]leasefence.Record{}, heartbeat: true}
		h.endpoints = &fakeEndpoints{w: w, host: id, serving: map[string]bool{}}
		w.daemons = append(w.daemons, h)
	}
	w.buildManifest()
	for _, relay := range w.relays {
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: relay.id, Clock: w.clock, Store: availabilitylease.NewMemoryStore(), Transport: w,
			Signer: availabilitylease.ECDSASigner{Key: relay.key}, IncarnationFloor: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		relay.node = node
		w.byID[relay.id] = relay
		if err := node.TrustPolicyKey("k1", priv.Public().(ed25519.PublicKey)); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptManifest(w.manifest); err != nil {
			t.Fatal(err)
		}
	}
	for _, h := range w.daemons {
		w.byID[h.id] = h
		w.startDaemon(h)
		w.deliverBlocks(h)
	}
	return w
}

func publicKeyDER(key *ecdsa.PrivateKey) []byte {
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return der
}

func (w *world) keyOf(id string) *ecdsa.PrivateKey {
	switch host := w.byID[id].(type) {
	case *relayHost:
		return host.key
	case *daemonHost:
		return host.key
	}
	for _, relay := range w.relays {
		if relay.id == id {
			return relay.key
		}
	}
	for _, h := range w.daemons {
		if h.id == id {
			return h.key
		}
	}
	w.t.Fatalf("unknown id %s", id)
	return nil
}

func (w *world) buildManifest() {
	w.manifestV++
	manifest := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: w.policyID, ManifestVersion: w.manifestV, Slots: w.slots, VoterEpoch: 1, Closed: w.closed,
		Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		LeaseTermMs: 30000,
	}
	for _, id := range w.candidates {
		manifest.Candidates = append(manifest.Candidates, &pb.LeaseCandidate{Id: id, PublicKey: publicKeyDER(w.keyOf(id))})
	}
	if w.slots > 1 {
		manifest.Mode = pb.LeasePolicyMode_LEASE_POLICY_MODE_REPLICATED
	}
	if w.available {
		manifest.PartitionMode = pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE
	}
	// Per-policy voters (A18): every relay is a member (shadow accepts for
	// its gate); the voters form the policy's single quorum set.
	members := map[string]bool{}
	for _, relay := range w.relays {
		members[relay.id] = true
		manifest.Members = append(manifest.Members, &pb.LeaseMember{Id: relay.id, PublicKey: publicKeyDER(relay.key), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
	}
	for _, id := range w.voters {
		if !members[id] {
			manifest.Members = append(manifest.Members, &pb.LeaseMember{Id: id, PublicKey: publicKeyDER(w.keyOf(id)), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
		}
	}
	manifest.QuorumSets = []*pb.LeaseQuorumSet{{VoterIds: append([]string(nil), w.voters...)}}
	if w.bootstrap != "" {
		manifest.BootstrapId = 1
		manifest.Bootstrap = []*pb.LeaseBootstrapSlot{{Slot: 0, HolderId: w.bootstrap}}
	}
	if len(w.bootstrapSlots) > 0 {
		manifest.BootstrapId = w.bootstrapID
		manifest.Bootstrap = nil
		for slot := uint32(0); slot < w.slots; slot++ {
			if holder := w.bootstrapSlots[slot]; holder != "" {
				manifest.Bootstrap = append(manifest.Bootstrap, &pb.LeaseBootstrapSlot{Slot: slot, HolderId: holder})
			}
		}
	}
	if w.closed {
		for slot := uint32(0); slot < w.slots; slot++ {
			if retained, ok := w.retained[slot]; ok {
				manifest.Retained = append(manifest.Retained, &pb.LeaseRetainedSlot{Slot: slot, HolderId: retained.Holder,
					Ballot: &pb.LeaseBallot{Round: retained.Ballot.Round, Incarnation: retained.Ballot.Incarnation, ProposerId: retained.Ballot.Proposer}})
			}
		}
	}
	payload, _ := proto.Marshal(manifest)
	w.manifest = availabilitylease.SignPolicyBlock("k1", w.policyPriv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

// setSlots publishes a manifest with another slot count (scale or surge).
func (w *world) setSlots(slots uint32) {
	w.slots = slots
	w.publishManifest()
}

// closeLease publishes a lease-closed manifest (A5) to every host.
func (w *world) closeLease() {
	w.closed = true
	w.publishManifest()
}

// closeGracefully publishes a closed manifest that names the committed holder
// of every slot retained, as Opfield does (graceful close).
func (w *world) closeGracefully() {
	w.retained = map[uint32]availabilitylease.RetainedHolder{}
	for _, h := range w.daemons {
		if h.down || h.daemonOff {
			continue
		}
		for _, status := range h.runtime.Node().Holders() {
			if status.Role == availabilitylease.RoleHolding {
				w.retained[status.Key.Slot] = availabilitylease.RetainedHolder{Holder: h.id, Ballot: status.Ballot}
			}
		}
	}
	w.logf("opfield closes gracefully, retained %v", w.retained)
	w.closeLease()
}

// reopen enters lease mode again naming a bootstrap holder per slot (D1).
func (w *world) reopen(bootstrap map[uint32]string) {
	w.closed, w.retained = false, nil
	w.bootstrapID = max(w.bootstrapID, 1) + 1
	w.bootstrapSlots = bootstrap
	w.logf("opfield reopens, bootstrap %v", bootstrap)
	w.publishManifest()
}

func (w *world) publishManifest() {
	w.buildManifest()
	for _, relay := range w.relays {
		_, _ = relay.node.AdoptManifest(w.manifest)
	}
	for _, h := range w.daemons {
		w.deliverBlocks(h)
	}
}

func (w *world) deliverBlocks(h *daemonHost) {
	err := h.runtime.ApplyLeaseBlocks(BlockUpdate{
		Revision: w.manifestV, MemberID: h.id, PolicyKeys: []PolicyKey{{ID: "k1", PublicKey: w.policyPriv.Public().(ed25519.PublicKey)}},
		Manifests: []*pb.LeaseSignedBlock{w.manifest},
	})
	if err != nil {
		w.t.Fatalf("apply blocks on %s: %v", h.id, err)
	}
}

// startDaemon (re)starts a daemon process on the same host: same store,
// same Docker, same watchdog directory, fresh runtime.
func (w *world) startDaemon(h *daemonHost) {
	runtime, err := New(Options{
		NodeID: h.id, Clock: hostClock{w: w, h: h}, Wall: w.wall, Signer: availabilitylease.ECDSASigner{Key: h.key},
		Suspends: availabilitylease.NewSuspendWatchFrom(func() (time.Duration, bool) { return 0, false }),
		Engine:   h.engine, Fence: h.fence, Endpoints: h.endpoints, Placements: fakePlacements{host: h.id, w: w},
		Logger: w.logger, Store: h.store, Transport: w,
		Async:      func(fn func()) { h.ops = append(h.ops, fn) },
		Controller: h.controller,
	})
	if err != nil {
		w.t.Fatal(err)
	}
	h.runtime, h.ops, h.down = runtime, nil, false
}

func (w *world) wall() time.Time {
	return time.Unix(1_800_000_000, 0).Add(w.clock.now + w.wallJump)
}

// Send is the network: frames are queued and delivered after each tick.
func (w *world) Send(frame *pb.CoordinationFrame) { w.queue = append(w.queue, frame) }

func (w *world) reachable(id string) bool {
	switch host := w.byID[id].(type) {
	case *relayHost:
		return !host.down
	case *daemonHost:
		return !host.down && !host.cut && !host.daemonOff && !host.frozen
	}
	return false
}

func linkKey(a, b string) string {
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

// block cuts (or restores) the link between two hosts.
func (w *world) block(a, b string, cut bool) { w.blocked[linkKey(a, b)] = cut }

// freeze pauses a daemon's VM for d: nothing on it runs, its clocks stand
// still, frames to it are lost. On resume it lost d of local time.
func (w *world) freeze(h *daemonHost, d time.Duration) {
	h.frozen = true
	w.logf("%s frozen", h.id)
	w.run(d)
	h.lag += d
	h.frozen = false
	h.residualUntil = w.clock.now + 1500*time.Millisecond
	w.logf("%s resumed", h.id)
}

func (w *world) deliver() {
	for guard := 0; len(w.queue) > 0 && guard < 100000; guard++ {
		frame := w.queue[0]
		w.queue = w.queue[1:]
		if !w.reachable(frame.GetSenderId()) || !w.reachable(frame.GetDestinationId()) ||
			w.blocked[linkKey(frame.GetSenderId(), frame.GetDestinationId())] {
			continue
		}
		switch host := w.byID[frame.GetDestinationId()].(type) {
		case *relayHost:
			_ = host.node.ReceiveFrame(frame)
		case *daemonHost:
			_ = host.runtime.Node().ReceiveFrame(frame)
		}
	}
}

func (w *world) logf(format string, args ...any) {
	w.seq++
	w.log = append(w.log, fmt.Sprintf("%06d %8.3fs ", w.seq, (w.clock.now-time.Hour).Seconds())+fmt.Sprintf(format, args...))
}

// run advances simulated time, stepping every live host each tick.
func (w *world) run(d time.Duration) {
	w.t.Helper()
	for end := w.clock.now + d; w.clock.now < end; {
		w.clock.now += worldTick
		beacon := w.clock.now%availabilitylease.BeaconInterval == 0
		for _, relay := range w.relays {
			if !relay.down {
				relay.node.Tick()
				if beacon {
					// The relay coordinator beacons its members (D4).
					for _, h := range w.daemons {
						relay.node.Beacon(h.id)
					}
				}
			}
		}
		for _, h := range w.daemons {
			if h.down || h.daemonOff || h.frozen {
				continue
			}
			h.runtime.Step()
			for guard := 0; len(h.ops) > 0 && guard < 16; guard++ {
				ops := h.ops
				h.ops = nil
				for _, op := range ops {
					op()
				}
			}
		}
		w.deliver()
		w.runWatchdogs()
		w.checkSingleCopy()
	}
}

// runWatchdogs emulates the independent watchdog: it kills a running
// container whose record is stale, with dockerd or without it.
func (w *world) runWatchdogs() {
	if !w.watchdogOn {
		return
	}
	for _, h := range w.daemons {
		if h.frozen {
			continue
		}
		for id, record := range h.fence.records {
			if c := h.engine.containers[id]; c != nil && c.Running && record.Stale(w.hostNow(h)) && !h.down {
				c.Running = false
				w.logf("%s watchdog killed %s", h.id, shortID(id))
			}
		}
	}
}

func (w *world) checkSingleCopy() {
	if w.available {
		return
	}
	// Copies are counted per host: containers of one holder (a rollout's
	// second slot) are one copy bound to one lease.
	var running []string
	for _, h := range w.daemons {
		// A frozen VM runs nothing; right after its resume the A2.5
		// residual lasts until the first frame reaches it.
		if h.down || h.frozen || w.clock.now < h.residualUntil {
			continue
		}
		for _, c := range h.engine.containers {
			if c.Running && c.PolicyID == w.policyID {
				running = append(running, h.id)
				break
			}
		}
	}
	if len(running) > int(w.slots) {
		w.violations = append(w.violations, fmt.Sprintf("t=%.3fs two copies running on %v", (w.clock.now-time.Hour).Seconds(), running))
	}
}

func (w *world) requireClean() {
	w.t.Helper()
	if len(w.violations) > 0 {
		w.t.Fatalf("invariant violated: %s\n%s", w.violations[0], w.dump())
	}
}

func (w *world) dump() string {
	start := 0
	if len(w.log) > 80 {
		start = len(w.log) - 80
	}
	return strings.Join(w.log[start:], "\n")
}

func (w *world) daemon(id string) *daemonHost {
	for _, h := range w.daemons {
		if h.id == id {
			return h
		}
	}
	w.t.Fatalf("unknown daemon %s", id)
	return nil
}

// runUntil advances until cond holds or the timeout passes.
func (w *world) runUntil(timeout time.Duration, cond func() bool) bool {
	for end := w.clock.now + timeout; w.clock.now < end; {
		if cond() {
			return true
		}
		w.run(worldTick)
	}
	return cond()
}

func (w *world) holderOf() string {
	for _, h := range w.daemons {
		if h.down || h.frozen {
			continue
		}
		status := h.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: w.policyID})
		if status.Role == availabilitylease.RoleHolding && status.MayStart {
			return h.id
		}
	}
	return ""
}

func (w *world) waitServing(id string, timeout time.Duration) {
	w.t.Helper()
	h := w.daemon(id)
	if !w.runUntil(timeout, func() bool { return h.engine.running() && h.endpoints.serving[w.policyID] }) {
		w.t.Fatalf("%s did not serve within %s (holder %q)\n%s", id, timeout, w.holderOf(), w.dump())
	}
}

func (w *world) indexOf(pattern string) int {
	for i, line := range w.log {
		if strings.Contains(line, pattern) {
			return i
		}
	}
	return -1
}

func (w *world) lastIndexOf(pattern string) int {
	for i := len(w.log) - 1; i >= 0; i-- {
		if strings.Contains(w.log[i], pattern) {
			return i
		}
	}
	return -1
}

// fenceLog drains a daemon's reported events and returns the reasons of every
// fence event seen so far.
func (w *world) fenceLog(id string) []string {
	h := w.daemon(id)
	for _, event := range h.runtime.Report().Events {
		if event.Kind == string(availabilitylease.EventFence) {
			h.fences = append(h.fences, event.Reason)
		}
	}
	return h.fences
}
