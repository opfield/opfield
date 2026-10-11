package pgha

import (
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

func names(members ...string) string { return "pg:names:" + syncNames(members) }

// Acquisition (M4, M3, AS2): the deadline record is armed first, the
// synchronous names are cleared (the inherited set is only this member),
// pg_promote, standby.signal again at once, slots reset, and the new timeline
// is certified before any client is admitted.
func TestAcquisitionPromotesInOrderAndOpensOnlyAfterCertification(t *testing.T) {
	h := newHarness(t)
	h.settle()
	h.lease.hold(syncValue(1, selfMember), true)
	h.settle()
	h.requireOrder(
		"watchdog:write",
		"pg:names:",
		"pg:promote:tl=2",
		"pg:mark_at_rest",
		"pg:slots:",
		"lease:propose:promoted:promoted=true:tl=2:sync=",
		"lease:certified:promoted",
		"endpoints:true",
	)
	if i, j := h.index("endpoints:true", 0), h.index("lease:certified:promoted", 0); i < j {
		t.Fatalf("endpoints opened before the promotion was certified")
	}
	value := h.lease.value()
	if value.Timeline != 2 || value.ParentTimeline != 1 || value.SwitchLSN != MustLSN("0/3000000") {
		t.Fatalf("certified timeline = %+v, want tl 2 branching off tl 1 at 0/3000000", value)
	}
	if len(value.SyncSet) != 0 || !value.Degraded {
		t.Fatalf("after an acquisition the holder's set is empty and degraded, got %+v", value)
	}
	if len(h.events(memberha.EventPromoted)) != 1 {
		t.Fatalf("expected one promotion event, got %v", h.events(memberha.EventPromoted))
	}
	if h.engine.State().HeldDataEpoch != h.engine.State().DataEpoch {
		t.Fatal("the holder must record the data epoch it holds (AS6)")
	}
	h.pg.requireNoViolations(t)
}

// M4: before pg_promote the names are exactly what the certified state
// requires without this member: an inherited set {self, C} keeps C.
func TestPromotionKeepsInheritedSyncMembersInNames(t *testing.T) {
	h := newHarness(t)
	h.settle()
	h.resetLog()
	h.lease.hold(syncValue(1, selfMember, memberC), true)
	h.run(4, time.Second)
	h.requireOrder(names(memberC), "pg:promote")
	if first := h.logSnapshot()[h.index("pg:names:", 0)]; first != names(memberC) {
		t.Fatalf("names before promote = %q", first)
	}
}

// M4 with a pending transition: names cover certified ∪ pending before the
// promotion.
func TestPromotionCoversThePendingTransition(t *testing.T) {
	h := newHarness(t)
	h.autoCertify = false
	h.settle()
	h.resetLog()
	h.lease.hold(syncValue(1, selfMember), true)
	pending, _ := syncValue(1, selfMember, memberB).Encode()
	h.lease.pending = &PendingTransition{Transition: Transition{ID: "restored-1", Value: pending}, Sent: true}
	h.lease.outcomes["restored-1"] = 2
	h.run(4, time.Second)
	h.requireOrder(names(memberB), "pg:promote")
}

// No promotion without a watchdog heartbeat (A12.1).
func TestNoPromotionWithoutWatchdogHeartbeat(t *testing.T) {
	h := newHarness(t)
	h.watchdog.gone = true
	h.lease.hold(syncValue(1, selfMember), true)
	h.run(6, time.Second)
	h.requireNo("pg:promote")
}

// M2/M3: a holder whose Postgres came back in recovery (container restart)
// promotes again while it holds, keeps the certified sync names, and closes
// clients until the new timeline is certified.
func TestHolderRepromotesAfterRestartInRecoveryKeepingSyncNames(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.inRecovery, p.timeline, p.signal = false, 2, true
		p.history[2] = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/2000000")}}
		p.flush = MustLSN("0/3000000")
		p.peers = []ReplicationPeer{streamingPeer(memberB, roleB, MustLSN("0/3000000"))}
	})
	h.lease.hold(Value{Timeline: 2, ParentTimeline: 1, SwitchLSN: MustLSN("0/2000000"), Durability: DurabilitySynchronous, SyncSet: []string{memberB}}, false)
	h.settle()
	if !h.ends.isServing() {
		t.Fatalf("holder never served:\n%s", strings.Join(h.logSnapshot(), "\n"))
	}
	h.resetLog()
	// Postgres restarts inside the container: standby.signal is on disk, so
	// it comes back in recovery.
	h.pg.set(func(p *fakePG) { p.inRecovery, p.replay, p.receive, p.receiver = true, p.flush, p.flush, "" })
	h.settle()
	h.requireOrder("endpoints:false", names(memberB), "pg:promote:tl=3", "pg:mark_at_rest", "lease:propose:promoted:promoted=true:tl=3:sync="+memberB, "lease:certified", "endpoints:true")
	h.pg.requireNoViolations(t)
}

// Bootstrap (M10): the origin runs as the single-node primary; after the
// bootstrap commit it serves without a promotion.
func TestBootstrapHolderServesWithoutPromotion(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) { p.inRecovery, p.flush = false, MustLSN("0/5000000") })
	h.lease.bootstrapPending = true
	h.run(4, time.Second)
	h.requireNo("pg:kill")
	h.lease.mu.Lock()
	handler := h.lease.handler
	h.lease.mu.Unlock()
	data, err := handler.BootstrapValue(Key{PolicyID: policyID})
	if err != nil {
		t.Fatal(err)
	}
	value, err := DecodeValue(data)
	if err != nil || value.Timeline != 1 || !value.Degraded {
		t.Fatalf("bootstrap value = %+v %v", value, err)
	}
	h.lease.bootstrapPending = false
	h.lease.hold(value, false)
	h.settle()
	h.requireNo("pg:promote")
	if !h.ends.isServing() {
		t.Fatalf("bootstrap holder does not serve")
	}
}

// A rejected promotion certification is recomputed and proposed again;
// clients stay out meanwhile.
func TestRejectedPromotionTransitionIsRetried(t *testing.T) {
	h := newHarness(t)
	h.lease.rejectNext = true
	h.lease.hold(syncValue(1, selfMember), true)
	h.settle()
	h.requireOrder("lease:propose:promoted", "lease:rejected", "lease:propose:promoted", "lease:certified:promoted", "endpoints:true")
}

// A promotion that happened in a crashed incarnation (Postgres primary, the
// pending promotion certified nowhere) is certified without promoting again.
func TestPromotedPrimaryWithPendingPromotionIsCertified(t *testing.T) {
	h := newHarness(t)
	h.pg.set(func(p *fakePG) {
		p.inRecovery, p.timeline, p.signal, p.flush = false, 2, false, MustLSN("0/3000000")
		p.history[2] = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/3000000")}}
	})
	h.lease.hold(syncValue(1, selfMember), true)
	h.settle()
	h.requireNo("pg:promote")
	h.requireOrder("lease:propose:promoted:promoted=true:tl=2", "endpoints:true")
}

// The holder converges the replication principals once per promotion and
// again when they change.
func TestTheHolderConvergesThePrincipals(t *testing.T) {
	h := newHarness(t)
	h.reconfigure(func(_ *memberha.Config, engine *EngineConfig) {
		engine.Identities = &Identities{Replication: map[string]string{roleA: "a", roleB: "b", roleC: "c"}, RewindRole: "gw_rewind_x"}
	})
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	h.requireOrder("pg:identities:3")
	h.resetLog()
	h.settle()
	h.requireNo("pg:identities")
	h.reconfigure(func(_ *memberha.Config, engine *EngineConfig) {
		engine.Identities.RemoveRoles = []string{"gw_repl_old"}
	})
	h.settle()
	h.requireOrder("pg:identities:3")
}
