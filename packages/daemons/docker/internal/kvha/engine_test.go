package kvha

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	testSet    = "11111111-1111-4111-8111-111111111111"
	testSelf   = "22222222-2222-4222-8222-222222222222"
	testPeer   = "33333333-3333-4333-8333-333333333333"
	testPolicy = "55555555-5555-4555-8555-555555555555"
)

type stubHost struct {
	cfg memberha.Config
}

func (h *stubHost) Config() memberha.Config                                        { return h.cfg }
func (h *stubHost) Container(context.Context) (ContainerInfo, error)               { return ContainerInfo{}, nil }
func (h *stubHost) PrepareStandby(context.Context) error                           { return nil }
func (h *stubHost) Start(context.Context) error                                    { return nil }
func (h *stubHost) Stop(context.Context, time.Duration) error                      { return nil }
func (h *stubHost) Kill(context.Context) error                                     { return nil }
func (h *stubHost) CgroupEmpty(context.Context) (bool, error)                      { return true, nil }
func (h *stubHost) DialServer(context.Context) (net.Conn, error)                   { return nil, net.ErrClosed }
func (h *stubHost) DialAlias(context.Context, string) (net.Conn, error)            { return nil, net.ErrClosed }
func (h *stubHost) Expose([]Exposure)                                              {}
func (h *stubHost) SetLocalPrimary(func(context.Context, string) (net.Conn, bool)) {}
func (h *stubHost) DiskFree() (uint64, bool, bool)                                 { return 0, false, false }
func (h *stubHost) Serve()                                                         {}
func (h *stubHost) Logger() *slog.Logger                                           { return slog.New(slog.DiscardHandler) }

func newTestEngine(t *testing.T) *Engine {
	t.Helper()
	engine, err := New(&stubHost{cfg: memberha.Config{SetID: testSet, MemberID: testSelf, NodeID: "node-a", Engine: "valkey",
		Mode: memberha.ModeAutomatic, LeasePolicyID: testPolicy, MaxLagBytes: 1000, SyncDegradeAfterSeconds: 10,
		EngineConfig: []byte(`{"replicationPassword":"0123456789abcdef0123"}`),
		Members:      []memberha.Peer{{MemberID: testSelf, NodeID: "node-a"}, {MemberID: testPeer, NodeID: "node-b", MemberIndex: 1}}}})
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func certified(t *testing.T, value Value) []byte {
	t.Helper()
	raw, err := value.encode()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEngineNeedsTheSetsReplicationPassword(t *testing.T) {
	if _, err := New(&stubHost{cfg: memberha.Config{EngineConfig: []byte(`{"replicationPassword":"short"}`)}}); err == nil {
		t.Fatal("a short replication password must be refused")
	}
	if _, err := ParseEngineConfig(nil); err == nil {
		t.Fatal("a member without engine configuration must be refused")
	}
}

func TestParseInfoAndReplicas(t *testing.T) {
	info := parseInfo("# Replication\r\nrole:master\r\nconnected_slaves:1\r\nslave0:ip=" + testPeer +
		",port=6379,state=online,offset=1234,lag=0\r\nmaster_replid:abc\r\nmaster_repl_offset:1300\r\n")
	if info["role"] != "master" || info["master_replid"] != "abc" {
		t.Fatalf("info %v", info)
	}
	replicas := parseReplicas(info)
	if len(replicas) != 1 || replicas[0].IP != testPeer || replicas[0].Offset != 1234 || replicas[0].State != "online" {
		t.Fatalf("replicas %+v", replicas)
	}
}

func TestEligibilityFollowsTheCertifiedHistoryAndFloor(t *testing.T) {
	engine := newTestEngine(t)
	input := func(value Value) memberha.EligibilityInput {
		return memberha.EligibilityInput{Adopted: memberha.HolderState{Value: certified(t, value)}}
	}
	engine.mu.Lock()
	engine.role, engine.replID, engine.replID2, engine.offset = "slave", "new", "old", 5000
	engine.mu.Unlock()
	if ok, reason := engine.Eligible(input(Value{ReplID: "new", OffsetFloor: 5500}), memberha.EngineStatus{}); ok || reason != "acl_not_mirrored" {
		t.Fatalf("a copy that never mirrored the ACL list: %v %s", ok, reason)
	}
	engine.mu.Lock()
	engine.aclSynced = time.Now()
	engine.mu.Unlock()
	if ok, reason := engine.Eligible(input(Value{ReplID: "new", OffsetFloor: 5500}), memberha.EngineStatus{}); !ok {
		t.Fatalf("within maxLag of the floor: %s", reason)
	}
	if ok, _ := engine.Eligible(input(Value{ReplID: "old", OffsetFloor: 5500}), memberha.EngineStatus{}); !ok {
		t.Fatal("replid2 keeps the history")
	}
	if ok, reason := engine.Eligible(input(Value{ReplID: "other", OffsetFloor: 0}), memberha.EngineStatus{}); ok || reason != "other_history" {
		t.Fatalf("another history: %v %s", ok, reason)
	}
	if ok, reason := engine.Eligible(input(Value{ReplID: "new", OffsetFloor: 6001}), memberha.EngineStatus{}); ok || reason != "behind" {
		t.Fatalf("more than maxLag behind: %v %s", ok, reason)
	}
}

func TestNextValueMovesTheFloorByHalfTheLagAtMostOncePerSecond(t *testing.T) {
	engine := newTestEngine(t)
	base := Value{ReplID: "r1", OffsetFloor: 1000}
	engine.mu.Lock()
	engine.role, engine.replID, engine.offset = "master", "r1", 1400
	engine.mu.Unlock()
	if _, _, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second); ok {
		t.Fatal("moved less than maxLag/2")
	}
	engine.mu.Lock()
	engine.offset = 1600
	engine.mu.Unlock()
	raw, kind, ok, err := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second)
	if err != nil || !ok || kind != "floor" {
		t.Fatalf("floor: %s %v %v", kind, ok, err)
	}
	next, _ := decodeValue(raw)
	if next.OffsetFloor != 1600 {
		t.Fatalf("floor %d", next.OffsetFloor)
	}
	if _, _, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second+500*time.Millisecond); ok {
		t.Fatal("at most once a second")
	}
	engine.mu.Lock()
	engine.replID = "r2"
	engine.mu.Unlock()
	raw, kind, ok, _ = engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second+600*time.Millisecond)
	next, _ = decodeValue(raw)
	if !ok || kind != "replid" || next.ReplID != "r2" {
		t.Fatalf("a new replication id is certified at once: %s %+v", kind, next)
	}
	engine.mu.Lock()
	engine.replID, engine.noCopiesSince = "r1", time.Now().Add(-11*time.Second)
	engine.mu.Unlock()
	raw, kind, ok, _ = engine.NextValue(certified(t, Value{ReplID: "r1", OffsetFloor: 1600}), memberha.EngineStatus{}, 20*time.Second)
	next, _ = decodeValue(raw)
	if !ok || kind != "degraded" || !next.Degraded {
		t.Fatalf("no copy for 10 s is degraded: %s %+v", kind, next)
	}
}

func TestReleaseTargetIsAnOnlineCopyWithinTheLag(t *testing.T) {
	engine := newTestEngine(t)
	engine.mu.Lock()
	engine.replicas = []replicaInfo{{IP: "unknown", State: "online", Offset: 5000}, {IP: testPeer, State: "online", Offset: 4500}}
	engine.mu.Unlock()
	if target, ok := engine.ReleaseTarget(certified(t, Value{OffsetFloor: 5000})); !ok || target != testPeer {
		t.Fatalf("release target %q %v", target, ok)
	}
	if _, ok := engine.ReleaseTarget(certified(t, Value{OffsetFloor: 9000})); ok {
		t.Fatal("a copy too far behind is no target")
	}
}

func TestACLMirrorPlan(t *testing.T) {
	want := []string{
		"user default on #aaa ~* &* +@all",
		"user app on #bbb ~app:* -@all +get",
		"user " + ReplicationUser + " on #ccc -@all +psync",
	}
	have := []string{
		"user default on #old ~* &* +@all",
		"user stale on #ddd -@all",
		"user " + ReplicationUser + " on #local -@all +psync",
	}
	plan := planACLMirror(want, have)
	var set []string
	for _, rules := range plan.set {
		set = append(set, strings.Join(rules, " "))
	}
	if len(set) != 2 || set[0] != "app reset on #bbb ~app:* -@all +get" || set[1] != "default reset on #aaa ~* &* +@all" {
		t.Fatalf("set %v", set)
	}
	if len(plan.remove) != 1 || plan.remove[0] != "stale" {
		t.Fatalf("remove %v", plan.remove)
	}
	if again := planACLMirror(want, want); len(again.set)+len(again.remove) != 0 {
		t.Fatalf("nothing to do when equal: %+v", again)
	}
}

func TestDialPeerOnlyWhileThePrimary(t *testing.T) {
	engine := newTestEngine(t)
	if _, err := engine.DialPeer(context.Background(), PortRepl); err == nil || !strings.Contains(err.Error(), "not the primary") {
		t.Fatalf("a copy refuses the replication port: %v", err)
	}
	if _, err := engine.DialPeer(context.Background(), "other"); err == nil {
		t.Fatal("unknown port")
	}
}
