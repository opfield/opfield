package chha

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// manualEngineConfig: a manual pair, A voter (primary at bootstrap), B learner.
func manualEngineConfig(self uint32) EngineConfig {
	return EngineConfig{Version: 1, LoopbackHost: "127.12.34.1", KeeperServerID: self,
		KeeperServers: []KeeperServer{
			{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleVoter},
			{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleLearner},
		},
		Interserver: []InterserverPeer{{MemberID: testMemberA, Port: 39000}, {MemberID: testMemberB, Port: 39001}}}
}

func TestRenderLearnersAndRecovery(t *testing.T) {
	ec := manualEngineConfig(2)
	config := testConfig(memberha.ModeManual, ec, testMemberB, testMemberA)
	normal := string(RenderServerConfig(config, ec, true))
	if !strings.Contains(normal, "<server><id>2</id><hostname>127.12.34.1</hostname><port>39502</port><can_become_leader>false</can_become_leader></server>") ||
		!strings.Contains(normal, "<server><id>1</id><hostname>127.12.34.1</hostname><port>39501</port><priority>3</priority></server>") {
		t.Fatalf("learner rendering:\n%s", normal)
	}
	recovery := string(RenderServerConfigMode(config, ec, false, RenderRecovery))
	if strings.Count(recovery, "<server>") != 1 || !strings.Contains(recovery, "<force_recovery>true</force_recovery>") ||
		!strings.Contains(recovery, "<enable_reconfiguration>false</enable_reconfiguration>") ||
		!strings.Contains(recovery, "<id>2</id><hostname>127.12.34.1</hostname><port>39502</port><priority>3</priority>") {
		t.Fatalf("recovery rendering:\n%s", recovery)
	}
	sole := string(RenderServerConfigMode(config, ec, false, RenderSoleVoter))
	if strings.Count(sole, "<server>") != 1 || strings.Contains(sole, "force_recovery") || !strings.Contains(sole, "<enable_reconfiguration>true</enable_reconfiguration>") {
		t.Fatalf("sole voter rendering:\n%s", sole)
	}
	if got := ec.ReconfigEntry(ec.KeeperServers[1]); got != "server.2=127.12.34.1:39502;learner;1" {
		t.Fatalf("learner reconfig entry %q", got)
	}
	bad := manualEngineConfig(1)
	bad.KeeperServers = append(bad.KeeperServers, KeeperServer{ID: 1001, Port: 39433, WitnessID: testWitness, Role: RoleLearner})
	if err := bad.Validate(testConfig(memberha.ModeManual, bad, testMemberA, testMemberB)); err == nil {
		t.Fatal("a witness learner was accepted")
	}
}

func TestEffectiveRolesAfterRecovery(t *testing.T) {
	ec := manualEngineConfig(2)
	config := testConfig(memberha.ModeManual, ec, testMemberB, testMemberA)
	voters, learners := effectiveRoles(config, ec, nil, &recovery{Phase: phaseSoleVoter})
	if len(voters) != 1 || voters[0].ID != 2 || len(learners) != 1 || learners[0].ID != 1 || learners[0].Role != RoleLearner {
		t.Fatalf("after recovery: voters %+v learners %+v", voters, learners)
	}
	adopted := ec
	adopted.KeeperServers = []KeeperServer{
		{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleLearner},
		{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleVoter},
	}
	if !recoveryAdopted(adopted) || recoveryAdopted(ec) {
		t.Fatal("recovery adoption")
	}
	voters, learners = effectiveRoles(config, ec, nil, nil)
	if len(voters) != 1 || voters[0].ID != 1 || len(learners) != 1 || learners[0].ID != 2 {
		t.Fatalf("Gateway's roles: %+v %+v", voters, learners)
	}
}

func TestCopyRejoinReasons(t *testing.T) {
	ec := manualEngineConfig(1)
	adopted := ec
	adopted.KeeperServers = []KeeperServer{
		{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleLearner},
		{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleVoter},
	}
	divergedView := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}
	if got := copyRejoinReason(1, divergedView, false, 0, adopted.Voters(), adopted.Learners(), true); got != "diverged" {
		t.Fatalf("returning old voter: %q", got)
	}
	// Planned switch: the copy stays the voter Opfield names; nothing to do.
	if got := copyRejoinReason(1, divergedView, false, 0, ec.Voters(), ec.Learners(), true); got != "" {
		t.Fatalf("voter copy: %q", got)
	}
	// Automatic sets never diverge this way.
	if got := copyRejoinReason(1, divergedView, false, 0, adopted.Voters(), adopted.Learners(), false); got != "" {
		t.Fatalf("automatic: %q", got)
	}
	promoted := ec
	promoted.KeeperServers[1].Role = RoleVoter
	learnerView := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}
	if got := copyRejoinReason(2, learnerView, true, 0, promoted.Voters(), promoted.Learners(), false); got != "promoted" {
		t.Fatalf("learner to promote: %q", got)
	}
	if got := copyRejoinReason(2, nil, true, learnerOutOfStep, promoted.Voters(), promoted.Learners(), false); got != "learner_out_of_step" {
		t.Fatalf("removed learner: %q", got)
	}
	if got := copyRejoinReason(2, nil, false, time.Hour, promoted.Voters(), promoted.Learners(), false); got != "" {
		t.Fatalf("a voter that does not serve (partition) must never wipe: %q", got)
	}
}

// Rejoin moves the Keeper state aside, marks the member joining (peers add it)
// and opens its Keeper path.
func TestRejoinWipesAndJoins(t *testing.T) {
	ec := manualEngineConfig(1)
	rt := newFakeRuntime(testConfig(memberha.ModeManual, ec, testMemberA, testMemberB))
	rt.exists["coordination"] = true
	rt.exists["coordination/log"] = true
	e := newTestEngine(t, rt)
	if e.keeperGate.Load() {
		t.Fatal("a manual member with a Keeper log must check its peer first")
	}
	e.mu.Lock()
	e.rejoinReason = "diverged"
	e.mu.Unlock()
	row, _ := parseStatusRow(statusRow("1", 0, 0, 1))
	_ = row
	if err := e.Rejoin(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rt.moved) != 1 || rt.moved[0] != "coordination" || !e.joining.Load() || !e.keeperGate.Load() {
		t.Fatalf("rejoin: moved %v joining %v gate %v", rt.moved, e.joining.Load(), e.keeperGate.Load())
	}
	if state := e.PeerEngineState(); state[peerKeeperJoining] != "true" {
		t.Fatalf("peer state %v", state)
	}
}

// The gate: a diverged voter copy is told by its peer's voters; a learner or a
// listed voter opens its path.
func TestKeeperGate(t *testing.T) {
	ec := manualEngineConfig(1)
	rt := newFakeRuntime(testConfig(memberha.ModeManual, ec, testMemberA, testMemberB))
	rt.exists["coordination/log"] = true
	rt.peers = map[string]map[string]string{testMemberB: {peerKeeperVoters: "2"}}
	e := newTestEngine(t, rt)
	snap := e.snapshot.Load()
	view := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}
	e.checkKeeperGate(context.Background(), snap, view, false, time.Second)
	if e.keeperGate.Load() || e.rejoinReason != "diverged" {
		t.Fatalf("diverged voter: gate %v reason %q", e.keeperGate.Load(), e.rejoinReason)
	}
	rt.peers[testMemberB][peerKeeperVoters] = "1"
	e.rejoinReason = ""
	e.checkKeeperGate(context.Background(), snap, view, false, 2*time.Second)
	if !e.keeperGate.Load() {
		t.Fatal("a voter its peer lists may reach it")
	}
	if fw := desiredForwardsGated(testMemberA, ec, false); len(fw) != 1 {
		t.Fatalf("closed gate keeps only interserver forwards: %v", fw)
	}
}

// The gate across restarts: an empty Keeper state opens it, a persisted
// learner role keeps it open (a learner needs its peer to serve at all), and
// every start of a voter closes it until its peer answers; a peer that does
// not answer never opens a voter's gate.
func TestKeeperGateAcrossRestarts(t *testing.T) {
	ctx := context.Background()
	ec := manualEngineConfig(1)
	rt := newFakeRuntime(testConfig(memberha.ModeManual, ec, testMemberA, testMemberB))
	rt.files[joiningMarker] = nil // a cleared marker is not a joining Keeper
	e := newTestEngine(t, rt)
	if e.joining.Load() || e.keeperGate.Load() {
		t.Fatalf("cleared marker: joining %v gate %v", e.joining.Load(), e.keeperGate.Load())
	}
	// Fresh Keeper (no log): joining, and its path opens before it starts.
	if err := e.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if !e.joining.Load() || !e.keeperGate.Load() {
		t.Fatalf("fresh Keeper: joining %v gate %v", e.joining.Load(), e.keeperGate.Load())
	}
	if err := e.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !e.keeperGate.Load() {
		t.Fatal("a joining Keeper's start closed its path")
	}

	// It joined as a voter; it stops and starts again: its path closes.
	e.joining.Store(false)
	e.setRole(RoleVoter)
	if rt.file(keeperRoleFile) != RoleVoter {
		t.Fatalf("role file %q", rt.file(keeperRoleFile))
	}
	_ = e.Kill(ctx)
	if err := e.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if e.keeperGate.Load() {
		t.Fatal("a voter's start must check its peer again")
	}
	snap := e.snapshot.Load()
	view := map[uint32]keeperEntry{1: {endpoint: "a"}, 2: {endpoint: "b", learner: true}}
	e.checkKeeperGate(ctx, snap, view, false, time.Second)
	e.checkKeeperGate(ctx, snap, view, false, time.Minute)
	if e.keeperGate.Load() {
		t.Fatal("a voter's path opened while its peer does not answer")
	}
	rt.peers = map[string]map[string]string{testMemberB: {peerKeeperRole: RoleLearner}}
	e.checkKeeperGate(ctx, snap, view, false, time.Minute)
	if !e.keeperGate.Load() || e.rejoinReason != "" {
		t.Fatalf("a learner peer without a session: gate %v reason %q", e.keeperGate.Load(), e.rejoinReason)
	}
	_ = e.Kill(ctx)
	_ = e.Start(ctx)
	rt.peers = map[string]map[string]string{testMemberB: {peerKeeperJoining: "true", peerKeeperVoters: "2"}}
	e.checkKeeperGate(ctx, snap, view, true, time.Minute)
	if !e.keeperGate.Load() {
		t.Fatal("a joining peer (wiped Keeper) may be reached")
	}

	// A learner's start keeps its path open, and the role survives a daemon restart.
	e.setRole(RoleLearner)
	_ = e.Kill(ctx)
	_ = e.Start(ctx)
	if !e.keeperGate.Load() {
		t.Fatal("a learner's start closed its path")
	}
	again := newTestEngine(t, rt)
	if !again.keeperGate.Load() || !again.wasLearner || again.PeerEngineState()[peerKeeperRole] != RoleLearner {
		t.Fatalf("restored learner: gate %v wasLearner %v state %v", again.keeperGate.Load(), again.wasLearner, again.PeerEngineState())
	}
}
