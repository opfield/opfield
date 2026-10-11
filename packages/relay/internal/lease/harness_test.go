package lease

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"io"
	"log/slog"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/protobuf/proto"
)

const (
	relayID   = "relay-1"
	policyID  = "policy-1"
	policyKey = "policy-key-1"
)

var testKey = availabilitylease.Key{PolicyID: policyID}

type fakeClock struct {
	mu  sync.Mutex
	now time.Duration
}

func (c *fakeClock) Now() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	c.mu.Unlock()
}

// laggedClock is the relay host's lease clock: the shared clock minus the
// time the relay VM spent frozen (its clocks stood still meanwhile).
type laggedClock struct {
	base *fakeClock
	mu   sync.Mutex
	lag  time.Duration
	// boot changes the clock origin, like a host reboot.
	boot uint64
}

func (c *laggedClock) Now() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.base.Now() - c.lag
}

func (c *laggedClock) Origin() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return 0x5eed + c.boot
}

// harness wires one relay Coordinator with T1 daemon nodes over the relay's
// routing (daemon -> relay -> daemon), deterministically on a fake clock.
type harness struct {
	t          *testing.T
	clock      *fakeClock
	relayClock *laggedClock
	// relayFrozen: the relay VM is paused; it neither ticks nor routes.
	relayFrozen bool
	wallBase    time.Time
	wallSkew    time.Duration
	policyPub   ed25519.PublicKey
	policyKey   ed25519.PrivateKey
	keys        map[string]*ecdsa.PrivateKey
	dir         string
	store       *policy.Store
	relay       *Coordinator
	daemons     map[string]*availabilitylease.Node
	streams     map[string]*memberStream
	down        map[string]bool
	voters      []string
	relayVote   bool
	fresh       bool
	// previousRelayKey and renewedAt model a relay certificate renewal.
	previousRelayKey *ecdsa.PrivateKey
	renewedAt        time.Time
	// manifests holds the latest signed manifest per policy; each carries
	// the policy's own voters (A18).
	manifests map[string]*relayv1.LeaseSignedBlock
	versions  map[string]uint64
	// retained names retained holders in the next closed manifest.
	retained []*relayv1.LeaseRetainedSlot
	// stateful policies carry certified holder state (v3) and are
	// bootstrapped by bootstrap[policy].
	stateful  map[string]bool
	bootstrap map[string]string

	mu  sync.Mutex
	out []*relayv1.CoordinationFrame
	// relayFrames records every frame the relay itself sent, by destination.
	relayFrames map[string][]*relayv1.CoordinationFrame
}

type harnessTransport struct {
	h  *harness
	id string
}

func (t harnessTransport) Send(frame *relayv1.CoordinationFrame) {
	t.h.mu.Lock()
	defer t.h.mu.Unlock()
	t.h.out = append(t.h.out, frame)
}

// newHarness starts a relay and daemons v1, v2, v3 (acceptors) and d1, d2
// (candidates of policy-1). relayVotes makes the relay policy-1's witness
// with v1 and v2; otherwise policy-1's voters are v1, v2, v3 and the relay is
// a non-voting member that only shadow-accepts.
func newHarness(t *testing.T, relayVotes bool) *harness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t: t, clock: &fakeClock{}, wallBase: time.Unix(1_800_000_000, 0), policyPub: pub, policyKey: priv,
		keys: map[string]*ecdsa.PrivateKey{}, dir: t.TempDir(), daemons: map[string]*availabilitylease.Node{},
		streams: map[string]*memberStream{}, down: map[string]bool{}, relayVote: relayVotes,
		relayFrames: map[string][]*relayv1.CoordinationFrame{},
		manifests:   map[string]*relayv1.LeaseSignedBlock{}, versions: map[string]uint64{},
		stateful: map[string]bool{}, bootstrap: map[string]string{},
	}
	h.relayClock = &laggedClock{base: h.clock}
	h.voters = []string{relayID, "v1", "v2"}
	if !relayVotes {
		h.voters = []string{"v1", "v2", "v3"}
	}
	daemons := []string{"v1", "v2", "v3", "d1", "d2"}
	for _, id := range append([]string{relayID}, daemons...) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		h.keys[id] = key
	}
	h.signManifest([]string{"d1", "d2"}, false)
	h.openRelay()
	for _, id := range daemons {
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: id, Clock: h.clock, Store: availabilitylease.NewMemoryStore(), Transport: harnessTransport{h: h, id: id},
			Signer: availabilitylease.ECDSASigner{Key: h.keys[id]},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := node.TrustPolicyKey(policyKey, pub); err != nil {
			t.Fatal(err)
		}
		for _, id := range sortedIDs(h.manifests) {
			if _, err := node.AdoptManifest(h.manifests[id]); err != nil {
				t.Fatal(err)
			}
		}
		h.daemons[id] = node
		h.connect(id)
	}
	return h
}

func (h *harness) wall() time.Time { return h.wallBase.Add(h.clock.Now() + h.wallSkew) }

// openRelay (re)starts the relay coordinator on relay.db in h.dir.
func (h *harness) openRelay() {
	h.t.Helper()
	store, err := policy.Open(h.dir)
	if err != nil {
		h.t.Fatal(err)
	}
	state, fresh, err := store.LeaseState()
	if err != nil {
		h.t.Fatal(err)
	}
	coordinator, err := New(Config{
		ID: relayID, Store: state, Keys: harnessKeys{h: h},
		TrustedKeys: func() []policy.TrustedPolicyKey {
			return []policy.TrustedPolicyKey{{KeyID: policyKey, PublicKey: h.policyPub}}
		},
		Clock: h.relayClock, Wall: h.wall, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Suspends: noSuspends(),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.store, h.relay, h.fresh = store, coordinator, fresh
	h.relay.ApplyPolicy(h.snapshot())
	h.streams = map[string]*memberStream{}
	for id := range h.daemons {
		h.connect(id)
	}
	h.t.Cleanup(func() { _ = store.Close() })
}

// restartRelay closes relay.db and opens it again; wipe renames it first,
// like the documented relay.db recovery.
func (h *harness) restartRelay(wipe bool) {
	h.t.Helper()
	if err := h.store.Close(); err != nil {
		h.t.Fatal(err)
	}
	if wipe {
		h.dir = h.t.TempDir()
	}
	h.openRelay()
}

// harnessKeys serves the relay identity keys; renewRelayKey swaps them.
type harnessKeys struct{ h *harness }

func (k harnessKeys) Keys() (crypto.Signer, crypto.Signer, time.Time) {
	var previous crypto.Signer
	if k.h.previousRelayKey != nil {
		previous = k.h.previousRelayKey
	}
	return k.h.keys[relayID], previous, k.h.renewedAt
}

// renewRelayKey installs a new relay identity key and keeps the old one as
// the previous key, like a certificate renewal with the rollover files.
func (h *harness) renewRelayKey() {
	h.t.Helper()
	next, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		h.t.Fatal(err)
	}
	h.previousRelayKey, h.keys[relayID], h.renewedAt = h.keys[relayID], next, h.wall()
}

func (h *harness) connect(id string) {
	stream := &memberStream{id: id, out: make(chan *relayv1.CoordinationFrame, streamBuffer), revoked: make(chan struct{})}
	h.relay.register(stream)
	h.streams[id] = stream
}

func (h *harness) publicKey(id string) []byte {
	encoded, err := x509.MarshalPKIXPublicKey(&h.keys[id].PublicKey)
	if err != nil {
		h.t.Fatal(err)
	}
	return encoded
}

// snapshot is the relay policy snapshot carrying every current manifest.
func (h *harness) snapshot() *policy.Snapshot {
	snapshot := &policy.Snapshot{}
	for _, id := range sortedIDs(h.manifests) {
		snapshot.LeaseBlocks = append(snapshot.LeaseBlocks, h.manifests[id])
	}
	return snapshot
}

// signManifest signs the next policy-1 manifest with the harness voters.
func (h *harness) signManifest(candidates []string, closed bool) *relayv1.LeaseSignedBlock {
	return h.signPolicy(policyID, candidates, h.voters, closed)
}

// signPolicy signs the next manifest of a policy. Its members are the relay
// (a RELAY member, voting only when it is in voters), the voters and the
// candidates (A18).
func (h *harness) signPolicy(id string, candidates, voters []string, closed bool) *relayv1.LeaseSignedBlock {
	h.versions[id]++
	value := &relayv1.LeaseManifest{
		SchemaVersion: 1, PolicyId: id, ManifestVersion: h.versions[id], Slots: 1, VoterEpoch: 1, Closed: closed,
		Mode: relayv1.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: relayv1.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		LeaseTermMs: 30000, QuorumSets: []*relayv1.LeaseQuorumSet{{VoterIds: voters}}, Stateful: h.stateful[id],
	}
	if holder := h.bootstrap[id]; holder != "" {
		value.BootstrapId = 1
		value.Bootstrap = []*relayv1.LeaseBootstrapSlot{{Slot: 0, HolderId: holder}}
	}
	if closed {
		value.Retained = h.retained
	}
	members := map[string]bool{relayID: true}
	for _, member := range append(append([]string(nil), voters...), candidates...) {
		members[member] = true
	}
	for _, member := range append(append([]string(nil), candidates...), sortedIDs(members)...) {
		if h.keys[member] == nil {
			key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			h.keys[member] = key
		}
	}
	for _, candidate := range candidates {
		value.Candidates = append(value.Candidates, &relayv1.LeaseCandidate{Id: candidate, PublicKey: h.publicKey(candidate)})
	}
	for _, member := range sortedIDs(members) {
		role := relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON
		if member == relayID {
			role = relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
		}
		value.Members = append(value.Members, &relayv1.LeaseMember{Id: member, PublicKey: h.publicKey(member), Role: role})
	}
	payload, _ := proto.Marshal(value)
	block := availabilitylease.SignPolicyBlock(policyKey, h.policyKey, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
	h.manifests[id] = block
	return block
}

// addPolicy publishes a new policy to every daemon and the relay.
func (h *harness) addPolicy(id string, candidates, voters []string) {
	h.t.Helper()
	block := h.signPolicy(id, candidates, voters, false)
	for _, node := range h.daemons {
		if _, err := node.AdoptManifest(block); err != nil {
			h.t.Fatal(err)
		}
	}
	h.relay.ApplyPolicy(h.snapshot())
	for _, candidate := range candidates {
		h.daemons[candidate].SetCandidateReady(id, true)
	}
}

func (h *harness) ready(ids ...string) {
	for _, id := range ids {
		h.daemons[id].SetCandidateReady(policyID, true)
	}
}

// pump delivers queued frames until the network is quiet: daemon frames go
// through the relay's ingest and routing, relay stream frames to daemons.
func (h *harness) pump() {
	for round := 0; round < 1000; round++ {
		h.mu.Lock()
		out := h.out
		h.out = nil
		h.mu.Unlock()
		progressed := len(out) > 0
		for _, frame := range out {
			if h.down[frame.GetSenderId()] || h.relayFrozen {
				continue
			}
			h.relay.ingestFrame(frame)
			if !h.relay.view.authorized(frame.GetSenderId()) {
				h.t.Fatalf("daemon %s is not authorized by the relay view", frame.GetSenderId())
			}
			h.relay.deliver(frame)
		}
		for _, id := range sortedIDs(h.streams) {
			stream := h.streams[id]
			for drained := false; !drained; {
				select {
				case frame := <-stream.out:
					progressed = true
					if frame.GetSenderId() == relayID {
						h.relayFrames[id] = append(h.relayFrames[id], frame)
					}
					if !h.down[id] {
						_ = h.daemons[id].ReceiveFrame(frame)
					}
				default:
					drained = true
				}
			}
		}
		if !progressed {
			return
		}
	}
	h.t.Fatal("network did not settle")
}

// step advances time in 100 ms increments, ticking every live node. Daemons
// beacon the relay every second like the docker daemon runtime (D4).
func (h *harness) step(total time.Duration) {
	for elapsed := time.Duration(0); elapsed < total; elapsed += 100 * time.Millisecond {
		h.clock.advance(100 * time.Millisecond)
		beacon := h.clock.Now()%time.Second == 0
		for _, id := range sortedIDs(h.daemons) {
			if !h.down[id] {
				h.daemons[id].Tick()
				if beacon {
					h.daemons[id].BeaconRelays()
				}
			}
		}
		if !h.relayFrozen {
			h.relay.observeSuspend()
			h.relay.checkIdentityKey()
			h.relay.node.Tick()
			h.relay.beacon(false)
		}
		h.pump()
	}
}

// freezeRelay pauses the relay VM for d: it neither ticks nor routes, and its
// lease clock stands still while the daemons' clocks move on.
func (h *harness) freezeRelay(d time.Duration) {
	h.relayFrozen = true
	h.step(d)
	h.relayClock.mu.Lock()
	h.relayClock.lag += d
	h.relayClock.mu.Unlock()
	h.relayFrozen = false
}

func noSuspends() *availabilitylease.SuspendWatch {
	return availabilitylease.NewSuspendWatchFrom(func() (time.Duration, bool) { return 0, false })
}

// stepUntil steps until cond holds or the timeout passes.
func (h *harness) stepUntil(timeout time.Duration, cond func() bool) bool {
	for elapsed := time.Duration(0); elapsed < timeout; elapsed += 100 * time.Millisecond {
		if cond() {
			return true
		}
		h.step(100 * time.Millisecond)
	}
	return cond()
}

func (h *harness) holding(id string) bool { return h.daemons[id].HolderStatus(testKey).Holding }

func sortedIDs[V any](values map[string]V) []string {
	ids := make([]string, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
