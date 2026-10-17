package memberha

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

const (
	testSet     = "11111111-1111-4111-8111-111111111111"
	testMemberA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testMemberB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testPolicy  = "22222222-2222-4222-8222-222222222222"
	testNodeA   = "node-a"
	testNodeB   = "node-b"
	testCID     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

// calls is an ordered log shared by the fakes, so tests assert orderings.
type calls struct {
	mu  sync.Mutex
	log []string
}

func (c *calls) add(format string, args ...any) {
	c.mu.Lock()
	c.log = append(c.log, fmt.Sprintf(format, args...))
	c.mu.Unlock()
}

func (c *calls) take() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.log
	c.log = nil
	return out
}

// indexOf is the position of the first entry with prefix, -1 when absent.
func indexOf(log []string, prefix string) int {
	for i, entry := range log {
		if strings.HasPrefix(entry, prefix) {
			return i
		}
	}
	return -1
}

type fakeClock struct{ now time.Duration }

func (c *fakeClock) Now() time.Duration { return c.now }
func (c *fakeClock) Wall() time.Time    { return time.Unix(1_800_000_000, 0).Add(c.now) }

type fakeWatchdog struct {
	calls   *calls
	age     time.Duration
	present bool
	records map[string]leasefence.Record
}

func (w *fakeWatchdog) HeartbeatAge(time.Duration) (time.Duration, bool) { return w.age, w.present }
func (w *fakeWatchdog) Records() (map[string]leasefence.Record, error) {
	out := map[string]leasefence.Record{}
	for k, v := range w.records {
		out[k] = v
	}
	return out, nil
}
func (w *fakeWatchdog) WriteRecord(record leasefence.Record) error {
	w.calls.add("record.write %d", record.DeadlineNs)
	w.records[record.ContainerID] = record
	return nil
}
func (w *fakeWatchdog) DeleteRecord(containerID string) error {
	w.calls.add("record.delete")
	delete(w.records, containerID)
	return nil
}

type fakeEndpoints struct {
	calls   *calls
	serving bool
}

func (e *fakeEndpoints) SetServing(_, _ string, serving bool) {
	e.calls.add("endpoints %v", serving)
	e.serving = serving
}

type fakeLease struct {
	calls       *calls
	status      HolderStatus
	manifest    ManifestInfo
	hasManifest bool
	committed   *CertifiedState
	observed    *CertifiedState
	ready       bool
	handler     *StateHandler
	outcome     TransitionOutcome
	proposed    []Transition
	bootstrap   bool
}

func (l *fakeLease) HolderStatus(Key) HolderStatus { return l.status }
func (l *fakeLease) ManifestInfo(string) (ManifestInfo, bool) {
	return l.manifest, l.hasManifest
}
func (l *fakeLease) BootstrapPending(Key) bool { return l.bootstrap }
func (l *fakeLease) SetCandidateReady(_ string, ready bool) {
	l.ready = ready
}
func (l *fakeLease) SetStateHandler(_ string, handler *StateHandler) { l.handler = handler }
func (l *fakeLease) ProposeTransition(_ Key, transition Transition) error {
	l.calls.add("propose %s promoted=%v", string(transition.Value), transition.Promoted)
	l.proposed = append(l.proposed, transition)
	return nil
}
func (l *fakeLease) TransitionStatus(Key, string) (TransitionOutcome, string) { return l.outcome, "" }
func (l *fakeLease) CommittedState(Key) (CertifiedState, bool) {
	if l.committed == nil {
		return CertifiedState{}, false
	}
	return *l.committed, true
}
func (l *fakeLease) ObservedCommit(Key) (CertifiedState, bool) {
	if l.observed == nil {
		return CertifiedState{}, false
	}
	return *l.observed, true
}
func (l *fakeLease) Recover(_ Key, deadline time.Duration) { l.calls.add("lease.recover %d", deadline) }
func (l *fakeLease) Release(_ Key, successor string) error {
	l.calls.add("lease.release %s", successor)
	return nil
}
func (l *fakeLease) FenceComplete(Key) { l.calls.add("lease.fence_complete") }
func (l *fakeLease) Abandon(Key)       { l.calls.add("lease.abandon") }

type fakeEngine struct {
	calls         *calls
	container     ContainerState
	status        EngineStatus
	failKill      bool
	releaseTarget string
	nextValue     []byte
}

func (e *fakeEngine) Container(context.Context) (ContainerState, error) { return e.container, nil }
func (e *fakeEngine) Status(context.Context) (EngineStatus, error)      { return e.status, nil }
func (e *fakeEngine) PrepareStandby(context.Context) error {
	e.calls.add("engine.prepare_standby")
	return nil
}
func (e *fakeEngine) Start(context.Context) error {
	e.calls.add("engine.start")
	e.container.Running = true
	e.status = EngineStatus{Answering: true, Writable: false}
	return nil
}
func (e *fakeEngine) StopClean(context.Context, time.Duration) error {
	e.calls.add("engine.stop_clean")
	e.container.Running = false
	return nil
}
func (e *fakeEngine) Kill(context.Context) error {
	e.calls.add("engine.kill")
	if e.failKill {
		return errors.New("kill failed")
	}
	e.container.Running = false
	e.status = EngineStatus{}
	return nil
}
func (e *fakeEngine) CgroupEmpty(context.Context) (bool, error) { return !e.container.Running, nil }
func (e *fakeEngine) Promote(context.Context, []byte) error {
	e.calls.add("engine.promote")
	e.status.Writable = true
	return nil
}
func (e *fakeEngine) Rejoin(context.Context) error {
	e.calls.add("engine.rejoin")
	e.status.NeedsRejoin = false
	return nil
}
func (e *fakeEngine) Switchover(context.Context, string) error {
	e.calls.add("engine.switchover")
	return nil
}
func (e *fakeEngine) Eligible(EligibilityInput, EngineStatus) (bool, string) { return true, "" }

// CertifiedSyncState: a certified value "sync-set" names this member in the
// synchronous set.
func (e *fakeEngine) CertifiedSyncState(value []byte) (string, bool) {
	if string(value) == "sync-set" {
		return "sync", true
	}
	return "async", true
}
func (e *fakeEngine) BootstrapValue(EngineStatus) ([]byte, error) { return []byte("bootstrap"), nil }
func (e *fakeEngine) PromotedValue([]byte, EngineStatus) ([]byte, error) {
	return []byte("promoted"), nil
}
func (e *fakeEngine) NextValue([]byte, EngineStatus, time.Duration) ([]byte, string, bool, error) {
	if e.nextValue == nil {
		return nil, "", false, nil
	}
	value := e.nextValue
	e.nextValue = nil
	return value, "floor", true, nil
}
func (e *fakeEngine) ReleaseTarget([]byte) (string, bool) {
	return e.releaseTarget, e.releaseTarget != ""
}
func (e *fakeEngine) DialPeer(context.Context, string) (net.Conn, error) {
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

type fakeGates struct{ open bool }

func (g *fakeGates) OpenFor(string, string, time.Time) bool { return g.open }

// harness runs the Manager deterministically: Async queues, and step runs the
// queue after each Step (outside the manager's lock), so one Step launches an
// operation and the next applies its result.
type harness struct {
	pending  []func()
	t        *testing.T
	calls    *calls
	clock    *fakeClock
	watchdog *fakeWatchdog
	ends     *fakeEndpoints
	lease    *fakeLease
	engine   *fakeEngine
	gates    *fakeGates
	manager  *Manager
	opfield  bool
	peer     *PeerState
}

func newHarness(t *testing.T, mode string) *harness {
	t.Helper()
	c := &calls{}
	h := &harness{t: t, calls: c, clock: &fakeClock{now: 100 * time.Second},
		watchdog: &fakeWatchdog{calls: c, present: true, records: map[string]leasefence.Record{}},
		ends:     &fakeEndpoints{calls: c},
		lease:    &fakeLease{calls: c, hasManifest: true, manifest: ManifestInfo{PolicyID: testPolicy}},
		engine:   &fakeEngine{calls: c, container: ContainerState{Exists: true, ID: testCID}},
		gates:    &fakeGates{open: true}, opfield: true}
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(Deps{
		Lease: h.lease, Watchdog: h.watchdog, Endpoints: h.ends, Gates: h.gates, Clock: h.clock,
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Engine:           func(Config) (Engine, error) { return h.engine, nil },
		Async:            func(fn func()) { h.pending = append(h.pending, fn) },
		OpfieldConnected: func() bool { return h.opfield },
		VerifyAssignment: func(setID string, assignment Assignment) error {
			if setID != testSet || string(assignment.Signature) != testSignature(assignment) {
				return errors.New("bad assignment signature")
			}
			return nil
		},
		PeerState: func(context.Context, string, string) (PeerState, bool) {
			if h.peer == nil {
				return PeerState{}, false
			}
			return *h.peer, true
		},
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	manager.confirmWait = time.Millisecond
	h.manager = manager
	config := Config{SetID: testSet, MemberID: testMemberA, NodeID: testNodeA, Engine: "fake", OwnerKind: "managed_database",
		OwnerID: "33333333-3333-4333-8333-333333333333", Mode: mode,
		Members:        []Peer{{MemberID: testMemberA, NodeID: testNodeA}, {MemberID: testMemberB, NodeID: testNodeB, MemberIndex: 1}},
		ConfigRevision: 1}
	if mode == ModeAutomatic {
		config.LeasePolicyID = testPolicy
	}
	if err := manager.Configure(config); err != nil {
		t.Fatal(err)
	}
	h.drain()
	return h
}

// drain runs the queued background work (it may queue more).
func (h *harness) drain() {
	for len(h.pending) > 0 {
		fn := h.pending[0]
		h.pending = h.pending[1:]
		fn()
	}
}

// step advances the clock and runs n Steps.
func (h *harness) step(n int, by time.Duration) {
	for range n {
		h.clock.now += by
		h.manager.Step()
		h.drain()
	}
}

func (h *harness) holding(deadline time.Duration) {
	h.lease.status = HolderStatus{Key: Key{PolicyID: testPolicy}, Role: RoleHolding, Holding: true, MayStart: true,
		Deadline: deadline}
}

func (h *harness) events() []string {
	h.manager.mu.Lock()
	defer h.manager.mu.Unlock()
	var out []string
	for _, event := range h.manager.members[testSet].state.Events {
		out = append(out, event.Kind)
	}
	return out
}

// testSignature stands in for Opfield's signature in tests.
func testSignature(assignment Assignment) string {
	return fmt.Sprintf("signed:%s:%d", assignment.PrimaryMemberID, assignment.Generation)
}

// signed is an assignment the test verifier accepts.
func signed(primary string, generation uint64) Assignment {
	assignment := Assignment{PrimaryMemberID: primary, Generation: generation, SigningKeyID: "test-key"}
	assignment.Signature = []byte(testSignature(assignment))
	return assignment
}

// peerWith is member B answering on member-control with a signed assignment.
func peerWith(assignment Assignment) *PeerState {
	return &PeerState{MemberID: testMemberB, Generation: assignment.Generation, Primary: assignment.PrimaryMemberID, Assignment: &assignment}
}
