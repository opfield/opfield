package swha

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

func newTestEngine(t *testing.T, cluster *fakeCluster) (*Engine, *fakeHost) {
	t.Helper()
	host := newFakeHost(cluster, t.TempDir(), testSelf, testMembers())
	engine, err := New(host)
	if err != nil {
		t.Fatal(err)
	}
	return engine, host
}

func certified(t *testing.T, value Value) []byte {
	t.Helper()
	raw, err := value.encode()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPortsAreDistinctPerMemberAndRole(t *testing.T) {
	seen := map[uint16]string{MasterHTTPPort: "master", MasterGRPCPort: "master-grpc", S3Port: "s3"}
	for index := uint32(0); index <= MaxMemberIndex; index++ {
		vh, vg := VolumePorts(index)
		fh, fg := FilerPorts(index)
		for _, port := range []uint16{vh, vg, fh, fg} {
			if other, dup := seen[port]; dup {
				t.Fatalf("port %d of member %d collides with %s", port, index, other)
			}
			seen[port] = "member"
		}
	}
	if _, err := SnowflakeID(MaxMemberIndex + 1); err == nil {
		t.Fatal("a member index past the snowflake range must be refused")
	}
	if id, _ := SnowflakeID(0); id != 1 {
		t.Fatalf("snowflake id of member 0 = %d, want 1 (0 lets SeaweedFS derive one)", id)
	}
}

func TestExposuresCoverThePrimaryAndOtherMembersOnly(t *testing.T) {
	exposures := Exposures(testSelf, []MemberRef{{ID: testSelf, Index: 0}, {ID: testPeer, Index: 1}})
	aliases := map[string]bool{}
	for _, exposure := range exposures {
		aliases[exposure.Alias] = true
		if strings.Contains(exposure.Alias, testSelf) {
			t.Fatalf("the member's own components are reached directly, not through the mesh: %+v", exposure)
		}
	}
	for _, want := range []string{"primary-sw-master", "primary-sw-master-grpc", "member-" + testPeer + "-sw-volume",
		"member-" + testPeer + "-sw-volume-grpc", "member-" + testPeer + "-sw-filer", "member-" + testPeer + "-sw-filer-grpc"} {
		if !aliases[want] {
			t.Fatalf("missing exposure %s in %+v", want, exposures)
		}
	}
}

func TestParseTopologyReadsRangesAndNodes(t *testing.T) {
	raw := []byte(`{"Topology":{"DataCenters":[{"Racks":[{"DataNodes":[{"Url":"a:1","VolumeIds":" 1 3-5 "},{"Url":"b:2","VolumeIds":"7,9"}]}]}]}}`)
	topology, err := ParseTopology(raw)
	if err != nil {
		t.Fatal(err)
	}
	if topology.MaxVolumeID != 9 || len(topology.Nodes["a:1"]) != 4 || !topology.Registered("b:2") || topology.Registered("c:3") {
		t.Fatalf("unexpected topology %+v", topology)
	}
	if _, err := parseVolumeIDs("5-3"); err == nil {
		t.Fatal("a descending range must be refused")
	}
}

func TestSingleCopyVolumesReadsEveryPlacementEncoding(t *testing.T) {
	raw := []byte(`{"Volumes":{"DataCenters":{"dc":{"rack":{"a:1":[
		{"Id":1,"Collection":"","ReplicaPlacement":{}},
		{"Id":2,"Collection":"b","ReplicaPlacement":{"node":1}},
		{"Id":3,"Collection":"b","ReplicaPlacement":"000"},
		{"Id":4,"Collection":"b","ReplicaPlacement":"001"},
		{"Id":5,"Collection":"gwbump","ReplicaPlacement":{}},
		{"Id":6,"Collection":"b","ReplicaPlacement":{"SameRackCount":1}}]}}}}}`)
	ids, err := singleCopyVolumes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != 1 || ids[1] != 3 {
		t.Fatalf("single-copy volumes = %v, want [1 3]", ids)
	}
}

func TestPromoteRaisesVolumeIDsBeforeOtherMembersRegister(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	// This member holds volumes 1..10; the lost primary also held 11..35.
	for id := uint32(1); id <= 10; id++ {
		cluster.addVolume(host.selfURL, id, "b", "001")
	}
	peerURL := VolumeURL(testPeer, 1)
	for id := uint32(11); id <= 35; id++ {
		cluster.addVolume(peerURL, id, "b", "000")
	}
	if _, err := engine.DialPeer(context.Background(), PortMaster); err == nil {
		t.Fatal("a copy's master port must refuse other members")
	}
	if err := engine.Promote(context.Background(), certified(t, Value{MaxVolumeID: 35})); err != nil {
		t.Fatal(err)
	}
	cluster.mu.Lock()
	counter, grows := cluster.counter, cluster.growCalls
	var bump []uint32
	for id, collection := range cluster.volumes[host.selfURL] {
		if collection == bumpCollection {
			bump = append(bump, id)
		}
	}
	cluster.mu.Unlock()
	if counter < 35 || grows == 0 {
		t.Fatalf("master id counter %d after %d grows, want >= 35", counter, grows)
	}
	if len(bump) != 0 {
		t.Fatalf("throw-away volumes %v must be deleted before the master opens", bump)
	}
	if host.stops[RoleVolume] == 0 || host.stops[RoleFiler] == 0 {
		t.Fatal("the new primary restarts its own volume server and filer")
	}
	if host.containers[RoleMaster].restartPolicy != "no" {
		t.Fatal("the master must never start on its own")
	}
	conn, err := engine.DialPeer(context.Background(), PortMasterGRPC)
	if err != nil {
		t.Fatalf("the master opens to the other members after the gate: %v", err)
	}
	_ = conn.Close()
	// The peer returns: its ids are below the counter, nothing collides.
	cluster.mu.Lock()
	cluster.registered[peerURL] = true
	cluster.mu.Unlock()
	if err := growVolumes(context.Background(), host.master.dial, host.selfURL, 1); err != nil {
		t.Fatal(err)
	}
	cluster.mu.Lock()
	defer cluster.mu.Unlock()
	for id := range cluster.volumes[host.selfURL] {
		if _, dup := cluster.volumes[peerURL][id]; dup {
			t.Fatalf("volume id %d is used on both members", id)
		}
	}
}

// A planned switchover of a healthy pair: the successor holds every volume, so
// the gate has nothing to raise and its filer keeps serving S3 while the
// master moves (stand rc.8: a 9 s S3 outage with refused requests).
func TestPromoteOfAHealthyPairKeepsTheFilerServing(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	for id := uint32(1); id <= 12; id++ {
		cluster.addVolume(host.selfURL, id, "b", "001")
	}
	if err := host.Start(context.Background(), RoleFiler); err != nil {
		t.Fatal(err)
	}
	if err := engine.Promote(context.Background(), certified(t, Value{MaxVolumeID: 12})); err != nil {
		t.Fatal(err)
	}
	if host.stops[RoleFiler] != 0 {
		t.Fatalf("the filer was stopped %d times during a promotion with nothing to raise", host.stops[RoleFiler])
	}
	if !host.containers[RoleFiler].running {
		t.Fatal("the promoted member's filer serves")
	}
}

func TestPromoteAddsAMarginWhileDegraded(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	cluster.addVolume(host.selfURL, 1, "b", "001")
	if err := engine.Promote(context.Background(), certified(t, Value{MaxVolumeID: 20, DegradedSince: 1})); err != nil {
		t.Fatal(err)
	}
	if cluster.counter < 20+degradedBumpMargin {
		t.Fatalf("counter %d, want >= %d", cluster.counter, 20+degradedBumpMargin)
	}
}

func TestStatusWritableOnlyForThePromotedMasterStart(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	cluster.addVolume(host.selfURL, 1, "b", "001")
	ctx := context.Background()
	status, err := engine.Status(ctx)
	if err != nil || !status.Answering || status.Writable {
		t.Fatalf("a copy answers read-only: %+v %v", status, err)
	}
	if err := engine.Promote(ctx, certified(t, Value{MaxVolumeID: 1})); err != nil {
		t.Fatal(err)
	}
	status, _ = engine.Status(ctx)
	if !status.Writable {
		t.Fatalf("the promoted master is writable: %+v", status)
	}
	engine.stopWorker()
	// The master restarted on its own (a crash): not writable until promoted again.
	_ = host.Stop(ctx, RoleMaster, 0)
	_ = host.Start(ctx, RoleMaster)
	status, _ = engine.Status(ctx)
	if status.Writable {
		t.Fatal("a master that started without the gate must not be writable")
	}
	// Standby at rest: no master means a copy.
	_ = engine.Kill(ctx)
	status, _ = engine.Status(ctx)
	if !status.Answering || status.Writable {
		t.Fatalf("after the kill the member is a running copy: %+v", status)
	}
	state, _ := engine.Container(ctx)
	if !state.Running || state.ID != strings.Repeat("m", 64) {
		t.Fatalf("the engine container is the master, the member runs while volume and filer do: %+v", state)
	}
}

func TestEligibility(t *testing.T) {
	cluster := newFakeCluster()
	engine, _ := newTestEngine(t, cluster)
	input := func(value Value) memberha.EligibilityInput {
		return memberha.EligibilityInput{Adopted: memberha.HolderState{Value: certified(t, value)}}
	}
	if ok, reason := engine.Eligible(memberha.EligibilityInput{}, memberha.EngineStatus{}); ok || reason != "no_certified_state" {
		t.Fatalf("no state: %v %s", ok, reason)
	}
	if ok, reason := engine.Eligible(input(Value{}), memberha.EngineStatus{}); ok || reason != "volume_not_registered" {
		t.Fatalf("never registered: %v %s", ok, reason)
	}
	now := time.Now().UnixNano()
	engine.mu.Lock()
	engine.registeredAt = time.Now()
	engine.meta = now - int64(500*time.Millisecond)
	engine.mu.Unlock()
	if ok, reason := engine.Eligible(input(Value{MetaProgressNs: now}), memberha.EngineStatus{}); !ok {
		t.Fatalf("500 ms behind is eligible: %s", reason)
	}
	if ok, reason := engine.Eligible(input(Value{MetaProgressNs: now + int64(time.Second)}), memberha.EngineStatus{}); ok || reason != "metadata_behind" {
		t.Fatalf("1.5 s behind: %v %s", ok, reason)
	}
	engine.mu.Lock()
	engine.registeredAt = time.Now().Add(-registeredFor - time.Second)
	engine.mu.Unlock()
	if ok, reason := engine.Eligible(input(Value{}), memberha.EngineStatus{}); ok || reason != "volume_not_registered" {
		t.Fatalf("registration too old: %v %s", ok, reason)
	}
}

func TestNextValueCertifiesVolumesDegradedAndMetadataAtMostOncePerSecond(t *testing.T) {
	cluster := newFakeCluster()
	engine, _ := newTestEngine(t, cluster)
	base := Value{MaxVolumeID: 5, MetaProgressNs: 1_000}
	engine.mu.Lock()
	engine.topologyMax, engine.heartbeat = 5, 1_000+int64(500*time.Millisecond)
	engine.mu.Unlock()
	if _, _, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second); ok {
		t.Fatal("nothing changed enough to certify")
	}
	engine.mu.Lock()
	engine.topologyMax = 6
	engine.mu.Unlock()
	raw, kind, ok, err := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 10*time.Second)
	if err != nil || !ok || kind != "volumes" {
		t.Fatalf("a grown volume id is certified: %s %v %v", kind, ok, err)
	}
	next, _ := decodeValue(raw)
	if next.MaxVolumeID != 6 {
		t.Fatalf("certified %+v", next)
	}
	engine.mu.Lock()
	engine.topologyMax, engine.heartbeat = 5, 1_000+int64(2*time.Second)
	engine.mu.Unlock()
	if _, kind, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 20*time.Second); !ok || kind != "metadata" {
		t.Fatalf("metadata progress is certified: %s %v", kind, ok)
	}
	if _, _, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 20*time.Second+500*time.Millisecond); ok {
		t.Fatal("metadata progress at most once a second")
	}
	engine.mu.Lock()
	engine.st.DegradedSince = 42
	engine.mu.Unlock()
	if _, kind, ok, _ := engine.NextValue(certified(t, base), memberha.EngineStatus{}, 20*time.Second+600*time.Millisecond); !ok || kind != "degraded" {
		t.Fatalf("a degraded change is certified at once: %s %v", kind, ok)
	}
}

func TestStopCleanStopsTheMasterOrTheCopy(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	ctx := context.Background()
	host.setRunning(RoleMaster, true)
	if err := engine.StopClean(ctx, time.Second); err != nil {
		t.Fatal(err)
	}
	if host.containers[RoleMaster].running || !host.containers[RoleVolume].running || !host.containers[RoleFiler].running {
		t.Fatal("a release stops only the master")
	}
	if err := engine.StopClean(ctx, time.Second); err != nil {
		t.Fatal(err)
	}
	if host.containers[RoleVolume].running || host.containers[RoleFiler].running {
		t.Fatal("a removed copy stops its volume server and filer")
	}
	if err := engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if host.containers[RoleMaster].running || !host.containers[RoleVolume].running {
		t.Fatal("a start never starts the master")
	}
}

func setWorkerTimings(t *testing.T) {
	t.Helper()
	tick, probe, lost, grace, after, retry := workerTick, peerProbeEvery, peerLostAfter, workerGrace, repairAfter, repairRetry
	workerTick, peerProbeEvery, peerLostAfter, workerGrace, repairAfter, repairRetry =
		20*time.Millisecond, 20*time.Millisecond, 150*time.Millisecond, 150*time.Millisecond, 100*time.Millisecond, time.Second
	t.Cleanup(func() {
		workerTick, peerProbeEvery, peerLostAfter, workerGrace, repairAfter, repairRetry = tick, probe, lost, grace, after, retry
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A failover: the old primary's volume server never registered with the
// promoted master, so degrading keeps the master (and S3) running.
func TestWorkerDegradesWithoutARestartForAPeerThatNeverRegistered(t *testing.T) {
	setWorkerTimings(t)
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	peer := newFakeHost(cluster, t.TempDir(), testPeer, testMembers())
	host.peers[testPeer] = peer
	peer.setRunning(RoleVolume, false)
	cluster.addVolume(host.selfURL, 1, "b", "001")
	ctx := context.Background()
	if err := engine.Promote(ctx, certified(t, Value{MaxVolumeID: 1})); err != nil {
		t.Fatal(err)
	}
	if status, _ := engine.Status(ctx); !status.Writable {
		t.Fatal("promoted")
	}
	defer engine.stopWorker()
	waitFor(t, "degraded", func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return engine.st.DegradedSince != 0
	})
	engine.mu.Lock()
	restart := engine.restartWanted
	engine.mu.Unlock()
	if restart {
		t.Fatal("no master restart for a volume server that never registered with it")
	}
	if status, _ := engine.Status(ctx); !status.Writable {
		t.Fatal("the promoted member keeps serving while degraded")
	}
}

func TestWorkerDegradesWhenThePeerIsLostAndRepairsWhenItReturns(t *testing.T) {
	setWorkerTimings(t)
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	peer := newFakeHost(cluster, t.TempDir(), testPeer, testMembers())
	host.peers[testPeer] = peer
	cluster.addVolume(host.selfURL, 1, "b", "001")
	ctx := context.Background()
	if err := engine.Promote(ctx, certified(t, Value{MaxVolumeID: 1})); err != nil {
		t.Fatal(err)
	}
	peerURL := VolumeURL(testPeer, 1)
	cluster.mu.Lock()
	cluster.registered[peerURL] = true
	cluster.mu.Unlock()
	if status, _ := engine.Status(ctx); !status.Writable {
		t.Fatal("promoted")
	}
	defer engine.stopWorker()
	waitFor(t, "heartbeats", func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return engine.heartbeat > 0
	})
	if target, ok := engine.ReleaseTarget(nil); !ok || target != testPeer {
		waitFor(t, "peer answering", func() bool { target, ok := engine.ReleaseTarget(nil); return ok && target == testPeer })
	}
	// The peer's volume server goes silent.
	peer.setRunning(RoleVolume, false)
	waitFor(t, "degraded", func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return engine.st.DegradedSince != 0 && engine.restartWanted
	})
	cluster.mu.Lock()
	switched := len(cluster.scripts) > 0 && strings.Contains(cluster.scripts[len(cluster.scripts)-1], "-replication=000")
	cluster.mu.Unlock()
	if !switched {
		t.Fatal("with one volume server left new objects get one copy")
	}
	if status, _ := engine.Status(ctx); status.Writable {
		t.Fatal("the master restarts (a new promotion) to drop the silent volume server")
	}
	if _, ok := engine.ReleaseTarget(nil); ok {
		t.Fatal("no release while objects have one copy")
	}
	if err := engine.Switchover(ctx, testPeer); err == nil {
		t.Fatal("no planned switch while objects have one copy")
	}
	cluster.addVolume(host.selfURL, 2, "b", "000")
	if err := engine.Promote(ctx, certified(t, Value{MaxVolumeID: 1, DegradedSince: 1})); err != nil {
		t.Fatal(err)
	}
	if status, _ := engine.Status(ctx); !status.Writable {
		t.Fatal("promoted again")
	}
	// The peer returns and registers.
	peer.setRunning(RoleVolume, true)
	cluster.mu.Lock()
	cluster.registered[peerURL] = true
	cluster.mu.Unlock()
	waitFor(t, "repaired", func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return engine.st.DegradedSince == 0
	})
	cluster.mu.Lock()
	last := cluster.scripts[len(cluster.scripts)-1]
	cluster.mu.Unlock()
	for _, want := range []string{"volume.configure.replication -volumeId=2 -replication=001", "volume.fix.replication -apply",
		"fs.configure -locationPrefix=/buckets/ -delete -apply", "lock\n", "unlock"} {
		if !strings.Contains(last, want) {
			t.Fatalf("repair script lacks %q:\n%s", want, last)
		}
	}
}

func TestSwitchoverWaitsForTheSuccessorsFiler(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	peer := newFakeHost(cluster, t.TempDir(), testPeer, testMembers())
	host.peers[testPeer] = peer
	done := make(chan error, 1)
	go func() { done <- engine.Switchover(context.Background(), testPeer) }()
	time.Sleep(300 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("returned before the successor caught up: %v", err)
	default:
	}
	cluster.syncFiler(testSelf, testPeer)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestShellErrorDetection(t *testing.T) {
	if shellError("lock\nok\nunlock\n") != "" {
		t.Fatal("clean output")
	}
	if shellError("> error: volume 3 not found\n") == "" && shellError("error: volume 3 not found") == "" {
		t.Fatal("error lines are failures")
	}
	if shellError("unknown command: fs.configur") == "" {
		t.Fatal("unknown commands are failures")
	}
}

func TestHeartbeatsLeaveOneEntryAndCopiesReadTheNewest(t *testing.T) {
	cluster := newFakeCluster()
	engine, host := newTestEngine(t, cluster)
	cluster.heartbeats[testSelf] = map[int64]bool{5: true, 7: true}
	ctx := context.Background()
	first, err := engine.writeHeartbeat(ctx, host.filer.dial)
	if err != nil {
		t.Fatal(err)
	}
	second, err := engine.writeHeartbeat(ctx, host.filer.dial)
	if err != nil || second <= first {
		t.Fatalf("heartbeats grow: %d %d %v", first, second, err)
	}
	if len(cluster.heartbeats[testSelf]) != 1 || !cluster.heartbeats[testSelf][second] {
		t.Fatalf("one heartbeat entry stays: %v", cluster.heartbeats[testSelf])
	}
	got, err := readHeartbeat(ctx, host.filer.dial)
	if err != nil || got != second {
		t.Fatalf("read %d %v, want %d", got, err, second)
	}
}

func TestMarkPrimaryMakesTheConvertedMasterWritableAndDegraded(t *testing.T) {
	cluster := newFakeCluster()
	host := newFakeHost(cluster, t.TempDir(), testSelf, testMembers())
	cluster.addVolume(host.selfURL, 1, "b", "000")
	host.setRunning(RoleMaster, true)
	host.containers[RoleMaster].started = time.Unix(100, 0)
	host.register()
	if err := MarkPrimary(host.dir, time.Unix(100, 0), 1, true); err != nil {
		t.Fatal(err)
	}
	engine, err := New(host)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.stopWorker()
	status, err := engine.Status(context.Background())
	if err != nil || !status.Writable || status.Position["degradedSince"] == "" {
		t.Fatalf("converted origin serves, degraded until repaired: %+v %v", status, err)
	}
	value, err := engine.BootstrapValue(status)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _ := decodeValue(value)
	if decoded.MaxVolumeID != 1 || decoded.DegradedSince == 0 {
		t.Fatalf("bootstrap value %+v", decoded)
	}
}

// No primary runs (the old one fenced, stand rc.13): nobody can register with
// a master, so the registration evidence is measured against the last time a
// master answered. The copy registered until then stays eligible, and so does
// the fenced previous holder; neither waits for a registration only a primary
// could give.
func TestEligibilityDoesNotWaitForARegistrationWithoutAPrimary(t *testing.T) {
	cluster := newFakeCluster()
	engine, _ := newTestEngine(t, cluster)
	value := memberha.EligibilityInput{Adopted: memberha.HolderState{Value: certified(t, Value{MaxVolumeID: 3})}}
	engine.mu.Lock()
	lost := time.Now().Add(-10 * registeredFor)
	engine.registeredAt, engine.masterSeenAt = lost.Add(-time.Second), lost
	engine.mu.Unlock()
	if ok, reason := engine.Eligible(value, memberha.EngineStatus{}); !ok {
		t.Fatalf("a copy registered until the primary went away must stay eligible: %s", reason)
	}
	// A master answers again without this member's registration: the evidence expires.
	engine.mu.Lock()
	engine.masterSeenAt = time.Now()
	engine.mu.Unlock()
	if ok, _ := engine.Eligible(value, memberha.EngineStatus{}); ok {
		t.Fatal("a copy a live master does not list is not eligible")
	}
	cfg, _ := engine.self()
	previous := value
	previous.PreviousHolder = cfg.NodeID
	if ok, reason := engine.Eligible(previous, memberha.EngineStatus{}); !ok || reason != "previous_holder" {
		t.Fatalf("the fenced previous holder holds every acknowledged object: %v %s", ok, reason)
	}
	previous.PreviousReleased = true
	if ok, _ := engine.Eligible(previous, memberha.EngineStatus{}); ok {
		t.Fatal("a holder that released is judged like any copy")
	}
}
