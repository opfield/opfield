package pgha

import (
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// AS5: adding a sync member sets the names, then the CHECKPOINT barrier,
// samples the flush LSN L and certifies only once the member flushed L. The
// best member (priority) is preferred.
func TestSyncAddUsesBarrierAndCatchUp(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.pg.setPeers(streamingPeer(memberC, roleC, MustLSN("0/5000000")), streamingPeer(memberB, roleB, MustLSN("0/4000000")))
	h.run(12, time.Second)
	h.requireOrder(names(memberB), "pg:checkpoint", "pg:flush_sample:0/5000000")
	if h.proposals("sync_add") != 0 {
		t.Fatalf("certified a member that had not flushed the barrier LSN")
	}
	h.pg.setPeers(streamingPeer(memberC, roleC, MustLSN("0/5000000")), streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.requireOrder("pg:flush_sample:0/5000000", "lease:propose:sync_add:promoted=false:tl=2:sync="+memberB, "lease:certified:sync_add")
	if value := h.lease.value(); value.Degraded || strings.Join(value.SyncSet, ",") != memberB {
		t.Fatalf("certified %+v, want sync member-b, not degraded", value)
	}
	if len(h.events(EventSyncRestored)) != 1 {
		t.Fatalf("expected a sync_restored event")
	}
}

// L2: the barrier LSN is sampled only after Postgres reports the member sync,
// i.e. its walsender loaded the names that include it.
func TestSyncBarrierWaitsForLoadedNames(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.namesLoadedLag = 1 << 30 })
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.run(15, time.Second)
	h.requireOrder(names(memberB))
	h.requireNo("pg:checkpoint")
	h.requireNo("pg:flush_sample")
	h.pg.set(func(p *fakePG) { p.namesLoadedLag = 0 })
	h.settle()
	h.requireOrder(names(memberB), "pg:checkpoint", "pg:flush_sample:", "lease:certified:sync_add")
}

// M6: a row counts only when application_name AND usename match the member.
func TestSyncMemberMatchedByApplicationNameAndRole(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.pg.setPeers(streamingPeer(memberB, roleC, MustLSN("0/5000000")))
	h.run(15, time.Second)
	h.requireNo(names(memberB))
	if h.proposals("sync_add") != 0 {
		t.Fatalf("a row with a foreign replication role was taken for the member")
	}
}

// AS5: switching C->B (B wanted, e.g. a switchover successor) runs names
// FIRST 2 (B, C), barrier and catch-up for B, certifies {B}, and only then
// names FIRST 1 (B).
func TestSyncSwitchKeepsBothUntilCertified(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberC}})
	h.pg.setPeers(streamingPeer(memberC, roleC, MustLSN("0/5000000")), streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.engine.PrepareSwitchover(memberB)
	h.settle()
	h.requireOrder(names(memberC), names(memberB, memberC), "pg:checkpoint", "pg:flush_sample",
		"lease:propose:sync_add:promoted=false:tl=2:sync="+memberB, "lease:certified:sync_add", names(memberB))
	if !h.engine.SwitchoverReady(h.lease.committed.State.Value, memberB) {
		t.Fatal("the switchover must be ready once the successor is the only certified sync member")
	}
}

// AS5 drop: a stall certifies the reduced set first; the names keep the
// stalled member (commits keep waiting) until the reduction is certified.
// M5: the stall is the oldest SyncRep waiter's age.
func TestSyncDropCertifiesBeforeRelaxingNames(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.autoCertify = false
	h.resetLog()
	h.pg.set(func(p *fakePG) { p.peers = nil; p.waiters = SyncWaiters{Count: 3, OldestAge: 11 * time.Second} })
	h.run(4, time.Second)
	h.requireOrder("lease:propose:sync_drop:promoted=false:tl=2:sync=")
	h.requireNo("pg:names:")
	h.lease.certifyPending()
	h.autoCertify = true
	h.run(3, time.Second)
	h.requireOrder("lease:certified:sync_drop", "pg:names:")
	if got := h.logSnapshot()[h.index("pg:names:", 0)]; got != "pg:names:" {
		t.Fatalf("names after the certified drop = %q", got)
	}
	if value := h.lease.value(); !value.Degraded || len(value.SyncSet) != 0 {
		t.Fatalf("certified %+v, want an empty degraded set", value)
	}
	h.settle()
	if len(h.events(EventSyncDegraded)) != 1 {
		t.Fatalf("expected a sync_degraded event")
	}
}

// M5: connectivity alone is no stall; nothing waits, nothing is dropped.
func TestSyncNoDropWithoutWaiters(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers()
	h.run(40, time.Second)
	if h.proposals("sync_drop") != 0 {
		t.Fatalf("dropped a sync member without a waiting commit")
	}
}

// M5: a member whose flush does not advance while its sent position does is a
// stall once commits wait.
func TestSyncStallByFlushNotAdvancing(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	sent := MustLSN("0/5000000")
	for i := 0; i < 14; i++ {
		sent += 0x1000
		row := streamingPeer(memberB, roleB, MustLSN("0/5000000"))
		row.SentLSN = sent
		h.pg.set(func(p *fakePG) {
			p.peers = []ReplicationPeer{row}
			p.waiters = SyncWaiters{Count: 1, OldestAge: time.Second}
		})
		h.tick(time.Second)
	}
	if h.proposals("sync_drop") != 1 {
		t.Fatalf("a member with a stuck flush was not dropped")
	}
}

// AS4: a cancelled or terminated synchronous wait certifies the eligibility
// floor = the current flush LSN, with an event.
func TestCancelledWaitCertifiesEligibilityFloor(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.pg.set(func(p *fakePG) { p.flush = MustLSN("0/5100000") })
	h.pg.logLine("WARNING:  canceling wait for synchronous replication due to user request")
	h.settle()
	if value := h.lease.value(); value.EligibilityFloor != MustLSN("0/5100000") {
		t.Fatalf("eligibility floor = %s", value.EligibilityFloor)
	}
	if len(h.events(EventCancelledWait)) != 1 {
		t.Fatalf("expected a cancelled_wait event")
	}
}

// AS4 from the waiters: a SyncRep wait that ends while the named member has
// not flushed its commit was cancelled; one that ends because the member
// flushed it was acknowledged.
func TestWaiterEndingWithoutFlushRaisesFloor(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.pg.set(func(p *fakePG) {
		p.flush = MustLSN("0/5100000")
		p.waiters = SyncWaiters{Count: 1, Keys: []string{"1|a"}}
	})
	h.run(2, time.Second)
	h.pg.set(func(p *fakePG) {
		p.waiters = SyncWaiters{}
		p.peers = []ReplicationPeer{streamingPeer(memberB, roleB, MustLSN("0/5100000"))}
	})
	h.settle()
	if h.proposals("floor") != 0 {
		t.Fatalf("an acknowledged wait raised the floor")
	}
	h.pg.set(func(p *fakePG) {
		p.flush = MustLSN("0/5200000")
		p.waiters = SyncWaiters{Count: 1, Keys: []string{"2|b"}}
	})
	h.run(2, time.Second)
	h.pg.set(func(p *fakePG) { p.waiters = SyncWaiters{} })
	h.settle()
	if value := h.lease.value(); value.EligibilityFloor != MustLSN("0/5200000") {
		t.Fatalf("eligibility floor = %s", value.EligibilityFloor)
	}
}

// AS2: a daemon restart between "names include B" and "B caught up" never
// certifies B from the Postgres configuration: the names are reset to what
// the certified state requires and the addition starts over with a barrier.
func TestRestartResumesFromCertifiedStateNotPostgres(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.pg.set(func(p *fakePG) { p.names = syncNames([]string{memberB}) })
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/4000000")))
	h.watchdog.records[containerA] = recordFor(h, 20*time.Second)
	h.lease.setRole(2, "")
	h.manager = h.newManager()
	h.run(3, time.Second)
	h.requireOrder("lease:recover")
	h.lease.setRole(5, "")
	h.run(12, time.Second)
	if h.proposals("sync_add") != 0 {
		t.Fatalf("certified B without a catch-up after a restart")
	}
	h.requireOrder(names(memberB), "pg:checkpoint", "pg:flush_sample")
}

// AS5: a proposed-but-unresolved state (restored by the library after a
// restart) is part of the names; nothing new is proposed until it resolves.
func TestPendingStateJoinsTheNames(t *testing.T) {
	h := newHarness(t)
	h.autoCertify = false
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	pendingValue := h.lease.value().WithSyncSet([]string{memberB, memberC})
	data, _ := pendingValue.Encode()
	h.lease.pending = &PendingTransition{Transition: Transition{ID: "restored-1", Value: data}, Sent: true}
	h.lease.outcomes["restored-1"] = 2
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.run(8, time.Second)
	h.requireOrder(names(memberB, memberC))
	if strings.Contains(strings.Join(h.logSnapshot(), "\n"), "lease:propose:") {
		t.Fatalf("proposed while a restored transition was unresolved")
	}
}

// Switching to asynchronous certifies the new durability first; the names
// keep the sync member until then.
func TestDurabilityChangeToAsynchronous(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.resetLog()
	h.reconfigure(func(config *memberha.Config, _ *EngineConfig) { config.Durability = DurabilityAsynchronous })
	h.settle()
	h.requireOrder("lease:propose:durability", "lease:certified:durability", "pg:names:")
	value := h.lease.value()
	if value.Durability != DurabilityAsynchronous || len(value.SyncSet) != 0 || value.ProgressFloor != MustLSN("0/5000000") {
		t.Fatalf("certified %+v", value)
	}
}

// AS7/M2: the progress floor follows the flush in steps of maxLag/4, at most
// once a second.
func TestAsyncProgressFloor(t *testing.T) {
	h := newHarness(t, func(h *harness) { h.config.Durability = DurabilityAsynchronous })
	steadyHolder(t, h, Value{Durability: DurabilityAsynchronous, ProgressFloor: MustLSN("0/5000000")})
	h.settle()
	if h.proposals("progress") != 0 {
		t.Fatalf("floor moved without progress")
	}
	h.pg.set(func(p *fakePG) { p.flush = MustLSN("0/5040000") }) // exactly maxLag/4
	h.settle()
	if value := h.lease.value(); value.ProgressFloor != MustLSN("0/5040000") {
		t.Fatalf("progress floor = %s", value.ProgressFloor)
	}
	h.pg.set(func(p *fakePG) { p.flush = MustLSN("0/507FFFF") })
	h.settle()
	if h.proposals("progress") != 1 {
		t.Fatalf("floor moved by less than maxLag/4")
	}
	h.pg.set(func(p *fakePG) { p.flush = MustLSN("0/5080000") })
	h.settle()
	if h.proposals("progress") != 2 {
		t.Fatalf("floor did not follow a maxLag/4 step")
	}
}

// A member being removed leaves the certified SyncSet first.
func TestARemovedMemberLeavesTheSyncSet(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberB}})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.resetLog()
	h.reconfigure(func(config *memberha.Config, _ *EngineConfig) { config.Members[1].Removing = true })
	h.settle()
	h.requireOrder("lease:propose:sync_remove", "lease:certified:sync_remove", "pg:names:")
	if value := h.lease.value(); len(value.SyncSet) != 0 {
		t.Fatalf("the removed member stayed certified: %+v", value)
	}
}
