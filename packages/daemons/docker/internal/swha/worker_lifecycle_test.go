package swha

import (
	"context"
	"errors"
	"testing"
	"time"
)

func (c *fakeCluster) scriptCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.scripts)
}

func (e *Engine) workerRunning() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.workerStop != nil
}

// promotedWithLostPeer is a promoted member whose only peer's volume server
// never answers, with every weed shell script failing: the worker keeps
// trying to switch new objects to one copy.
func promotedWithLostPeer(t *testing.T) (*Engine, *fakeHost, *fakeCluster) {
	t.Helper()
	setWorkerTimings(t)
	prevMin, prevMax := degradeRetryMin, degradeRetryMax
	degradeRetryMin, degradeRetryMax = 200*time.Millisecond, 400*time.Millisecond
	t.Cleanup(func() { degradeRetryMin, degradeRetryMax = prevMin, prevMax })
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
	cluster.mu.Lock()
	cluster.shellErr = errors.New("weed shell failed")
	cluster.mu.Unlock()
	if status, _ := engine.Status(ctx); !status.Writable {
		t.Fatal("promoted")
	}
	t.Cleanup(engine.stopWorker)
	return engine, host, cluster
}

// N-1: a failed switch to one copy is retried with a growing delay, never
// on every worker tick.
func TestWorkerBacksOffAFailedSwitchToOneCopy(t *testing.T) {
	_, _, cluster := promotedWithLostPeer(t)
	waitFor(t, "a first switch attempt", func() bool { return cluster.scriptCount() > 0 })
	first := cluster.scriptCount()
	// 20 worker ticks; the retries come 200 ms, then 400 ms apart.
	time.Sleep(400 * time.Millisecond)
	if retries := cluster.scriptCount() - first; retries > 2 {
		t.Fatalf("%d retries within 400 ms of 20 ms ticks: the failed switch must back off", retries)
	}
}

// N-1: the primary's worker ends once its master is gone (the member's
// containers removed: a lift, the set deleted), and no retry outlives it.
func TestWorkerEndsWhenTheMasterIsRemoved(t *testing.T) {
	engine, host, cluster := promotedWithLostPeer(t)
	waitFor(t, "a first switch attempt", func() bool { return cluster.scriptCount() > 0 })
	host.mu.Lock()
	host.containers[RoleMaster].exists, host.containers[RoleMaster].running = false, false
	host.mu.Unlock()
	waitFor(t, "the worker to end", func() bool { return !engine.workerRunning() })
	ended := cluster.scriptCount()
	time.Sleep(600 * time.Millisecond)
	if after := cluster.scriptCount(); after != ended {
		t.Fatalf("%d scripts ran after the worker ended", after-ended)
	}
}

// N-1: Close (the member runtime forgot the member) stops the worker, and a
// later status that finds the master writable does not start it again.
func TestCloseEndsTheWorkerForGood(t *testing.T) {
	engine, _, cluster := promotedWithLostPeer(t)
	waitFor(t, "a first switch attempt", func() bool { return cluster.scriptCount() > 0 })
	engine.Close()
	if engine.workerRunning() {
		t.Fatal("Close must stop the worker")
	}
	if _, err := engine.Status(context.Background()); err != nil {
		t.Fatal(err)
	}
	if engine.workerRunning() {
		t.Fatal("a closed engine must not start its worker again")
	}
	ended := cluster.scriptCount()
	time.Sleep(600 * time.Millisecond)
	if after := cluster.scriptCount(); after != ended {
		t.Fatalf("%d scripts ran after Close", after-ended)
	}
}
