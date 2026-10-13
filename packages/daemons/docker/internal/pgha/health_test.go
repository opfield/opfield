package pgha

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// Fence: endpoints dormant before the kill, cgroup confirmed empty, standby at
// rest written, record deleted, fence completed, then a read-only start.
func TestFenceOrder(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	h.resetLog()
	h.lease.setRole(availabilitylease.RoleFencing, availabilitylease.FenceReason("renewal_timeout"))
	h.settle()
	h.requireOrder("endpoints:false", "pg:kill", "pg:prepare_standby", "watchdog:delete", "lease:fence_complete", "pg:prepare_standby", "pg:start:recovery=true")
	h.pg.requireNoViolations(t)
}

// A Postgres that runs as a primary without the lease (a returning old
// primary) is killed and restarted as a standby.
func TestUnownedPrimaryIsFencedAndRestartedAsStandby(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.inRecovery, p.flush, p.timeline = false, MustLSN("0/5000000"), 2 })
	h.lease.observed = &CertifiedState{State: HolderState{Holder: nodeB}}
	h.settle()
	h.requireOrder("pg:kill", "pg:prepare_standby", "pg:start:recovery=true")
	h.requireNo("endpoints:true")
	if len(h.events(memberha.EventUnownedPrimary)) != 1 {
		t.Fatal("expected an unowned_primary_stopped event")
	}
}

// Before the set's lease bootstraps, the origin keeps serving as the
// single-node primary it still is.
func TestLegacyOriginIsNotFenced(t *testing.T) {
	h := newHarness(t)
	h.lease.manifest = nil
	h.pg.set(func(p *fakePG) { p.inRecovery, p.flush = false, MustLSN("0/5000000") })
	h.run(10, time.Second)
	h.requireNo("pg:kill")
	if !h.serving() {
		t.Fatal("the origin must keep serving before the bootstrap")
	}
}

// Health release (decision 17): the holder's Postgres stopped; a certified
// sync member streamed in the last sample: release to it in the A6 order.
func TestHealthReleaseToEligibleSuccessor(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.resetLog()
	h.pg.set(func(p *fakePG) { p.answering = false })
	h.run(15, time.Second)
	h.requireOrder("endpoints:false", "pg:kill", "pg:prepare_standby", "watchdog:delete", "lease:release:"+nodeB)
}

// Never release to nobody: without an eligible member the holder restarts
// locally and promotes again.
func TestHealthNeverReleasesToNobody(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	h.resetLog()
	h.pg.set(func(p *fakePG) { p.running = false })
	h.run(20, time.Second)
	h.requireNo("lease:release")
	h.requireOrder("pg:prepare_standby", "pg:start:recovery=true", "pg:promote")
	if len(h.events(memberha.EventHealthRestart)) == 0 {
		t.Fatal("expected a health_restart event")
	}
	h.pg.requireNoViolations(t)
}

// A full disk is never a release reason (it would repeat on the successor).
func TestDiskFullDoesNotRelease(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.pg.logLine("PANIC:  could not write to file \"pg_wal/xlogtemp.1\": No space left on device")
	h.run(2, time.Second)
	h.pg.set(func(p *fakePG) { p.answering = false })
	h.run(20, time.Second)
	h.requireNo("lease:release")
	if len(h.events(memberha.EventDiskAlert)) == 0 && len(h.events(memberha.EventHealthRestart)) == 0 {
		t.Fatal("expected a disk alert or a local restart")
	}
}

// Daemon start: a running container with a live record recovers the key with
// the recorded deadline; nothing opens until a renewal.
func TestStartupRecoversLiveRecord(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.inRecovery, p.flush, p.timeline = false, MustLSN("0/5000000"), 2 })
	h.watchdog.records[containerA] = recordFor(h, 20*time.Second)
	h.manager = h.newManager()
	h.run(3, time.Second)
	h.requireOrder("lease:recover")
	h.requireNo("pg:kill")
	h.requireNo("endpoints:true")
}

// A stopped member starts only after standby at rest was written, and a
// leftover record of its stopped container is removed first.
func TestStoppedMemberStartsAsStandby(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.running = false; p.signal = false })
	h.watchdog.records[containerA] = recordFor(h, 20*time.Second)
	h.settle()
	h.requireOrder("watchdog:delete", "pg:prepare_standby", "pg:start:recovery=true")
	h.pg.requireNoViolations(t)
}

// Graceful close (AS9, B1): while the closed manifest is confirmed by the
// voters (retaining) the holder serves on its lease; once retained it serves
// without a lease; a retained copy that restarted comes back read-only and is
// never promoted by the runtime (only the daemon's lift does).
func TestCloseRetainedHolderKeepsServingAndIsNeverPromotedAgain(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	h.lease.retaining = true
	h.run(3, time.Second)
	if !h.serving() {
		t.Fatal("a retaining holder serves within its lease")
	}
	h.resetLog()
	h.lease.setRole(availabilitylease.RoleRetained, "")
	h.settle()
	h.requireNo("pg:kill")
	if !h.serving() {
		t.Fatal("the retained primary keeps serving")
	}
	if primary, err := h.manager.LiftCheck(setID, selfMember); err != nil || !primary {
		t.Fatalf("the retained primary may be lifted: %v %v", primary, err)
	}
	h.pg.set(func(p *fakePG) { p.inRecovery = true; p.signal = true })
	h.settle()
	h.requireNo("pg:promote")
	if h.serving() {
		t.Fatal("a retained copy that came back read-only must not serve")
	}
}

// B1: a holder whose close no majority confirmed before its soft fence point
// is fenced by the library (lease_closed); the runtime kills it in order and
// it cannot be lifted.
func TestCloseUnconfirmedHolderFences(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	h.lease.retaining = true
	h.run(2, time.Second)
	h.resetLog()
	h.lease.setRole(availabilitylease.RoleFencing, availabilitylease.FenceReason("lease_closed"))
	h.settle()
	h.requireOrder("endpoints:false", "pg:kill", "pg:prepare_standby", "watchdog:delete", "lease:fence_complete")
	if _, err := h.manager.LiftCheck(setID, selfMember); err == nil {
		t.Fatal("a fenced holder must not be lifted")
	}
	h.pg.requireNoViolations(t)
}
