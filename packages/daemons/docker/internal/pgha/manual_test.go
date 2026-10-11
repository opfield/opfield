package pgha

import (
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

func manualHarness(t *testing.T) *harness {
	t.Helper()
	return newHarness(t, func(h *harness) {
		h.config.Mode, h.config.LeasePolicyID = memberha.ModeManual, ""
		h.config.Members = h.config.Members[:2]
	})
}

// A manual pair's assigned copy waits until the old primary's stream ended
// (it stopped cleanly and sent its last WAL), then promotes with empty names.
func TestManualPromotionWaitsForTheOldPrimaryStreamToEnd(t *testing.T) {
	h := manualHarness(t)
	previous, previousPoll := manualPromoteWait, manualPoll
	manualPromoteWait, manualPoll = 50*time.Millisecond, time.Millisecond
	defer func() { manualPromoteWait, manualPoll = previous, previousPoll }()
	h.settle()
	h.resetLog()
	if err := h.manager.AssignPrimary(setID, memberha.Assignment{PrimaryMemberID: selfMember, Generation: 2, Signature: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	h.pg.set(func(p *fakePG) { p.receiver = "" })
	h.settle()
	h.requireOrder("pg:names:", "pg:promote:tl=2", "pg:mark_at_rest", "endpoints:true")
	h.pg.requireNoViolations(t)
}

// The manual primary keeps its synchronous names on the streaming peer, and
// relaxes them when the peer stalls commits so writes continue.
func TestManualPrimaryKeepsAndRelaxesSyncNames(t *testing.T) {
	h := manualHarness(t)
	h.pg.set(func(p *fakePG) {
		p.inRecovery, p.timeline, p.flush = false, 2, MustLSN("0/5000000")
		p.peers = []ReplicationPeer{streamingPeer(memberB, roleB, MustLSN("0/5000000"))}
	})
	if err := h.manager.AssignPrimary(setID, memberha.Assignment{PrimaryMemberID: selfMember, Generation: 1, Signature: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	h.requireOrder("endpoints:true", names(memberB))
	h.resetLog()
	h.pg.set(func(p *fakePG) { p.peers = nil; p.waiters = SyncWaiters{Count: 2, OldestAge: 11 * time.Second} })
	h.settle()
	h.requireOrder("pg:names:")
	if got := h.logSnapshot()[h.index("pg:names:", 0)]; got != "pg:names:" {
		t.Fatalf("a stalled peer must release the names: %q", got)
	}
}
