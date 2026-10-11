package pgha

import (
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// switchoverHolder is a serving primary with C as its certified sync member
// and B streaming too.
func switchoverHolder(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, SyncSet: []string{memberC}})
	h.pg.setPeers(streamingPeer(memberC, roleC, MustLSN("0/5000000")))
	h.settle()
	h.pg.setPeers(streamingPeer(memberC, roleC, MustLSN("0/5000000")), streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.resetLog()
	return h
}

// AS11: the successor is made the certified sync member first (names FIRST 2,
// barrier, catch-up, certify, FIRST 1), then serving closes, clients end, the
// final LSN is measured after a checkpoint, the successor replayed it,
// Postgres stops cleanly, standby at rest, the record goes, and the release
// names the successor.
func TestSwitchoverOrder(t *testing.T) {
	h := switchoverHolder(t)
	if err := h.manager.Switchover(setID, memberB, "op-sw"); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.requireOrder(
		names(memberB, memberC), "pg:checkpoint", "pg:flush_sample",
		"lease:propose:sync_add:promoted=false:tl=2:sync="+memberB, "lease:certified:sync_add", names(memberB),
		"endpoints:false", "pg:terminate_clients", "pg:checkpoint", "pg:flush_sample:0/5000000",
		"pg:stop_clean", "pg:prepare_standby", "watchdog:delete", "lease:release:"+nodeB,
	)
	if len(h.events(memberha.EventSwitchover)) != 1 {
		t.Fatalf("expected a switchover event")
	}
	h.pg.requireNoViolations(t)
}

// Asynchronous durability needs no sync change: the handoff starts at once.
func TestAsyncSwitchoverStartsAtOnce(t *testing.T) {
	h := newHarness(t, func(h *harness) { h.config.Durability = DurabilityAsynchronous })
	steadyHolder(t, h, Value{Durability: DurabilityAsynchronous, ProgressFloor: MustLSN("0/5000000")})
	h.pg.setPeers(streamingPeer(memberB, roleB, MustLSN("0/5000000")))
	h.settle()
	h.resetLog()
	if err := h.manager.Switchover(setID, memberB, "op-sw"); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.requireNo("pg:names:")
	h.requireOrder("endpoints:false", "pg:terminate_clients", "pg:stop_clean", "lease:release:"+nodeB)
}

// AS11: the stop waits until the successor replayed the final LSN.
func TestSwitchoverWaitsForSuccessorReplay(t *testing.T) {
	h := switchoverHolder(t)
	h.settle()
	reads := 0
	h.pg.set(func(p *fakePG) {
		p.onReplication = func(p *fakePG) {
			if p.terminated == 0 {
				return
			}
			reads++
			lagging := streamingPeer(memberB, roleB, MustLSN("0/5000000"))
			if reads < 4 {
				lagging.ReplayLSN = MustLSN("0/4FFFFFF")
			}
			p.peers = []ReplicationPeer{streamingPeer(memberC, roleC, MustLSN("0/5000000")), lagging}
		}
	})
	previous := switchoverPoll
	switchoverPoll = time.Millisecond
	defer func() { switchoverPoll = previous }()
	if err := h.manager.Switchover(setID, memberB, "op-sw"); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if reads < 4 {
		t.Fatalf("the switchover did not wait for the successor's replay (%d reads)", reads)
	}
	h.requireOrder("pg:terminate_clients", "pg:stop_clean", "lease:release:"+nodeB)
}

// AS11 rollback before the stop: clients come back, nothing is released.
func TestSwitchoverTimeoutBeforeStopReopens(t *testing.T) {
	h := switchoverHolder(t)
	h.settle()
	h.pg.set(func(p *fakePG) {
		p.onReplication = func(p *fakePG) {
			if p.terminated == 0 {
				return
			}
			lagging := streamingPeer(memberB, roleB, MustLSN("0/4000000"))
			p.peers = []ReplicationPeer{streamingPeer(memberC, roleC, MustLSN("0/5000000")), lagging}
		}
	})
	previous, previousTimeout := switchoverPoll, switchoverCatchupTimeout
	switchoverPoll, switchoverCatchupTimeout = time.Millisecond, 20*time.Millisecond
	defer func() { switchoverPoll, switchoverCatchupTimeout = previous, previousTimeout }()
	if err := h.manager.Switchover(setID, memberB, "op-sw"); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.requireNo("pg:stop_clean")
	h.requireNo("lease:release")
	if len(h.events(memberha.EventSwitchoverFail)) != 1 {
		t.Fatal("the failed switchover must be an event")
	}
	if !h.serving() {
		t.Fatal("the primary must serve again after a switchover that did not stop it")
	}
}

func TestSwitchoverRefusals(t *testing.T) {
	h := switchoverHolder(t)
	if err := h.manager.Switchover(setID, selfMember, "op"); err == nil {
		t.Fatal("a switchover to itself must be refused")
	}
	if err := h.manager.Switchover(setID, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "op"); err == nil {
		t.Fatal("a switchover to a non-member must be refused")
	}
	copyMember := newHarness(t)
	copyMember.settle()
	if err := copyMember.manager.Switchover(setID, memberB, "op"); err == nil {
		t.Fatal("only the holder runs a switchover")
	}
}
