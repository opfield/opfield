package pgha

import (
	"errors"
	"testing"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

// AS10: a forced promotion only skips the eligibility callback: it goes
// through the lease (ForceAcquire, bound to the commit the operator saw)
// with the forced record, timeline and fork LSN in the value; the promotion
// then certifies the timeline it promoted to.
func TestForcedPromotionThroughTheLease(t *testing.T) {
	h := newHarness(t)
	h.settle()
	over := Ballot{Round: 7, Incarnation: 1, Proposer: nodeB}
	result, err := h.manager.ForcePromote(setID, "op-force", over)
	if err != nil || result.Outcome != "armed" {
		t.Fatalf("force = %+v %v", result, err)
	}
	h.requireOrder("lease:force:op-force:over=" + over.String() + ":tl=1:forced=true")
	if len(h.events(memberha.EventForceArmed)) != 1 {
		t.Fatal("expected a forced_promotion_armed event")
	}
	// The library acquires with the forced value.
	value := Value{Timeline: 1, Durability: DurabilitySynchronous, Degraded: true,
		Forced: &Forced{Operation: "op-force", Timeline: 1, ForkLSN: MustLSN("0/3000000")}}
	h.lease.hold(value, true)
	h.settle()
	h.requireOrder("pg:promote:tl=2", "lease:propose:promoted:promoted=true:tl=2", "endpoints:true")
	certified := h.lease.value()
	if certified.Forced == nil || !certified.Forced.Promoted || certified.Forced.Timeline != 2 || certified.Forced.ForkLSN != MustLSN("0/3000000") {
		t.Fatalf("certified forced record = %+v", certified.Forced)
	}
	h.pg.requireNoViolations(t)
}

// AS10: without a strict majority the library refuses; nothing promotes.
func TestForcedPromotionRefusedWithoutMajority(t *testing.T) {
	h := newHarness(t)
	h.settle()
	h.lease.forceErr = availabilitylease.ErrNoQuorum
	if _, err := h.manager.ForcePromote(setID, "op-force", Ballot{Round: 7, Incarnation: 1, Proposer: nodeB}); !errors.Is(err, memberha.ErrForceRefused) {
		t.Fatalf("expected a refusal, got %v", err)
	}
	h.settle()
	h.requireNo("pg:promote")
}

func TestForcedPromotionPreconditions(t *testing.T) {
	h := newHarness(t)
	steadyHolder(t, h, Value{Durability: DurabilitySynchronous, Degraded: true})
	h.settle()
	if _, err := h.manager.ForcePromote(setID, "op", Ballot{Round: 1, Proposer: nodeB}); !errors.Is(err, memberha.ErrForceRefused) {
		t.Fatalf("the holder must not be force promoted: %v", err)
	}
	r := newHarness(t)
	r.settle()
	if err := r.pgStore.Save(setID, State{NeedsRebuild: true}); err != nil {
		t.Fatal(err)
	}
	r.engine.mu.Lock()
	r.engine.state.NeedsRebuild = true
	r.engine.mu.Unlock()
	if _, err := r.manager.ForcePromote(setID, "op", Ballot{Round: 1, Proposer: nodeB}); !errors.Is(err, memberha.ErrForceRefused) {
		t.Fatalf("a copy that must be rebuilt must not be force promoted: %v", err)
	}
	if status, err := h.manager.ForceStatusOf(setID); err != nil || status.Outcome != "none" {
		t.Fatalf("force status = %+v %v", status, err)
	}
}
