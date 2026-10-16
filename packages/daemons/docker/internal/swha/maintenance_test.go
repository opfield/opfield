package swha

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestVolumeDiskSpaceReadsTheVolumeServerStatus(t *testing.T) {
	raw := []byte(`{"Version":"30GB 4.47","DiskStatuses":[{"dir":"/data","all":8589934592,"used":8000000000,"free":589934592,"percent_free":6.8,"percent_used":93.2}],"Volumes":[]}`)
	disk, err := volumeDiskSpace(raw)
	if err != nil {
		t.Fatal(err)
	}
	if disk.Free != 589934592 || disk.Total != 8589934592 {
		t.Fatalf("disk %+v", disk)
	}
	for _, broken := range []string{`{}`, `{"DiskStatuses":[{"dir":"/data"}]}`, `<html>`} {
		if _, err := volumeDiskSpace([]byte(broken)); err == nil {
			t.Fatalf("%s parsed", broken)
		}
	}
}

func TestMaintenanceScripts(t *testing.T) {
	if got, want := vacuumScript(0.02, 7), "lock\nvolume.vacuum -garbageThreshold=0.02 -volumeId=7\nunlock\n"; got != want {
		t.Fatalf("vacuum script %q, want %q", got, want)
	}
	if got, want := housekeepScript(true), "s3.clean.uploads -timeAgo=168h\nfs.log.purge -daysAgo=7\n"; got != want {
		t.Fatalf("housekeeping script %q, want %q", got, want)
	}
	if got, want := housekeepScript(false), "s3.clean.uploads -timeAgo=168h\n"; got != want {
		t.Fatalf("housekeeping script without the log %q, want %q", got, want)
	}
}

func setMaintenanceTimings(t *testing.T) {
	t.Helper()
	setWorkerTimings(t)
	reclaim, housekeep, first := reclaimEvery, housekeepEvery, housekeepFirstAfter
	reclaimEvery, housekeepEvery, housekeepFirstAfter = 50*time.Millisecond, time.Hour, 50*time.Millisecond
	t.Cleanup(func() { reclaimEvery, housekeepEvery, housekeepFirstAfter = reclaim, housekeep, first })
}

// wholePair is a promoted primary whose peer runs and is registered.
func wholePair(t *testing.T, cluster *fakeCluster) (*Engine, *fakeHost, *fakeHost) {
	t.Helper()
	engine, host := newTestEngine(t, cluster)
	peer := newFakeHost(cluster, t.TempDir(), testPeer, testMembers())
	host.peers[testPeer] = peer
	cluster.addVolume(host.selfURL, 1, "b", "001")
	if err := engine.Promote(context.Background(), certified(t, Value{MaxVolumeID: 1})); err != nil {
		t.Fatal(err)
	}
	cluster.mu.Lock()
	cluster.registered[VolumeURL(testPeer, 1)] = true
	cluster.mu.Unlock()
	return engine, host, peer
}

func scriptsWith(cluster *fakeCluster, part string) []string {
	cluster.mu.Lock()
	defer cluster.mu.Unlock()
	var out []string
	for _, script := range cluster.scripts {
		if strings.Contains(script, part) {
			out = append(out, script)
		}
	}
	return out
}

// A whole set compacts the planned volumes one shell run (and one lock) at a
// time against the fullest member disk, and once a day removes abandoned
// uploads and, while the copy's filer is caught up, the old metadata log.
func TestPrimaryReclaimsAndHousekeepsAWholeSet(t *testing.T) {
	setMaintenanceTimings(t)
	cluster := newFakeCluster()
	engine, host, peer := wholePair(t, cluster)
	host.plan = ReclaimPlan{Threshold: 0.02, VolumeIDs: []uint32{7, 3}}
	peer.mu.Lock()
	peer.diskFree = 300 << 20
	peer.mu.Unlock()
	// The copy's filer follows the primary's metadata (peer sync).
	stopSync := make(chan struct{})
	defer close(stopSync)
	go func() {
		for {
			select {
			case <-stopSync:
				return
			case <-time.After(5 * time.Millisecond):
				cluster.syncFiler(testSelf, testPeer)
			}
		}
	}()
	if status, _ := engine.Status(context.Background()); !status.Writable {
		t.Fatal("promoted")
	}
	defer engine.stopWorker()
	waitFor(t, "both volumes compacted", func() bool {
		return len(scriptsWith(cluster, "volume.vacuum -garbageThreshold=0.02 -volumeId=7\n")) > 0 &&
			len(scriptsWith(cluster, "volume.vacuum -garbageThreshold=0.02 -volumeId=3\n")) > 0
	})
	for _, script := range scriptsWith(cluster, "volume.vacuum") {
		if strings.Count(script, "volume.vacuum") != 1 || !strings.HasPrefix(script, "lock\n") || !strings.HasSuffix(script, "unlock\n") {
			t.Fatalf("a compaction script %q, want one locked volume", script)
		}
	}
	host.mu.Lock()
	fullest := host.planned[0]
	host.mu.Unlock()
	if fullest.Free != 300<<20 {
		t.Fatalf("planned with %+v, want the peer's fuller disk", fullest)
	}
	waitFor(t, "housekeeping", func() bool { return len(scriptsWith(cluster, "s3.clean.uploads -timeAgo=168h")) > 0 })
	if got := scriptsWith(cluster, "s3.clean.uploads"); len(got) != 1 || !strings.Contains(got[0], "fs.log.purge -daysAgo=7") {
		t.Fatalf("housekeeping scripts %q, want one that also prunes the metadata log", got)
	}
}

// The metadata log stays while a copy's filer is behind: it catches up from
// its last offset.
func TestHousekeepingKeepsTheMetadataLogForACopyBehind(t *testing.T) {
	setMaintenanceTimings(t)
	cluster := newFakeCluster()
	engine, _, _ := wholePair(t, cluster)
	if status, _ := engine.Status(context.Background()); !status.Writable {
		t.Fatal("promoted")
	}
	defer engine.stopWorker()
	waitFor(t, "housekeeping", func() bool { return len(scriptsWith(cluster, "s3.clean.uploads")) > 0 })
	if got := scriptsWith(cluster, "fs.log.purge"); len(got) != 0 {
		t.Fatalf("metadata log pruned with a copy behind: %q", got)
	}
}

// A set that is not whole (here: the copy's volume server never answers, so
// the set degrades) compacts and housekeeps nothing.
func TestNoMaintenanceWhileTheSetIsNotWhole(t *testing.T) {
	setMaintenanceTimings(t)
	cluster := newFakeCluster()
	engine, host, peer := wholePair(t, cluster)
	host.plan = ReclaimPlan{Threshold: 0.3, VolumeIDs: []uint32{1}}
	peer.setRunning(RoleVolume, false)
	if status, _ := engine.Status(context.Background()); !status.Writable {
		t.Fatal("promoted")
	}
	defer engine.stopWorker()
	waitFor(t, "degraded", func() bool {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		return engine.st.DegradedSince != 0
	})
	time.Sleep(200 * time.Millisecond)
	if got := append(scriptsWith(cluster, "volume.vacuum"), scriptsWith(cluster, "s3.clean.uploads")...); len(got) != 0 {
		t.Fatalf("maintenance on a set that is not whole: %q", got)
	}
	host.mu.Lock()
	planned := len(host.planned)
	host.mu.Unlock()
	if planned != 0 {
		t.Fatal("a compaction was planned for a set that is not whole")
	}
}

// A member being removed stops maintenance too.
func TestSetWholeRefusesARemovingMember(t *testing.T) {
	setMaintenanceTimings(t)
	cluster := newFakeCluster()
	engine, host, _ := wholePair(t, cluster)
	topology := &Topology{Nodes: map[string][]uint32{host.selfURL: {1}, VolumeURL(testPeer, 1): {1}}}
	now := time.Now()
	engine.mu.Lock()
	engine.workerSince = now.Add(-time.Hour)
	engine.peersOK[testPeer] = now
	engine.mu.Unlock()
	if !engine.setWhole(topology, now) {
		t.Fatal("a whole pair is not whole")
	}
	members := testMembers()
	members[1].Removing = true
	host.mu.Lock()
	host.cfg.Members = members
	host.mu.Unlock()
	if engine.setWhole(topology, now) {
		t.Fatal("a pair with a member being removed is whole")
	}
	host.mu.Lock()
	host.cfg.Members = testMembers()
	host.mu.Unlock()
	delete(topology.Nodes, VolumeURL(testPeer, 1))
	if engine.setWhole(topology, now) {
		t.Fatal("a pair whose copy is not registered is whole")
	}
}
