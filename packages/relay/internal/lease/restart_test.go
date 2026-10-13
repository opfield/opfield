package lease

import (
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// relayAbstains checks that the relay reports abstention and that every
// promise it sends while abstaining is a shadow promise that is never
// counted (A3, A11).
func relayAbstains(t *testing.T, h *harness) {
	t.Helper()
	report := h.relay.Report()
	if !report.GetAcceptorAbstaining() {
		t.Fatal("restarted relay does not report abstention")
	}
	h.relayFrames = map[string][]*relayv1.CoordinationFrame{}
	h.step(availabilitylease.RenewInterval + time.Second)
	promises := relayPromises(t, h.relayFrames["d1"])
	if len(promises) == 0 {
		t.Fatal("relay did not answer renewals after the restart")
	}
	for _, promise := range promises {
		if !promise.GetShadow() {
			t.Fatal("relay voted inside its restart abstention window")
		}
	}
	// Shadow accepts keep the data path open for the unchanged holder.
	if !h.relay.Admit(policyID, "d1").Open {
		t.Fatalf("gate did not reopen from shadow accepts: %+v", h.relay.Admit(policyID, "d1"))
	}
	for _, view := range h.relay.Report().GetAcceptor() {
		if view.GetState() != "abstaining" || !view.GetAbstaining() {
			t.Fatalf("acceptor view during abstention = %v", view)
		}
	}
	h.relayFrames = map[string][]*relayv1.CoordinationFrame{}
	h.step(availabilitylease.AbstainAfterStart)
	counted := false
	for _, promise := range relayPromises(t, h.relayFrames["d1"]) {
		counted = counted || !promise.GetShadow()
	}
	if !counted || h.relay.Report().GetAcceptorAbstaining() {
		t.Fatal("relay still abstains after the abstention window")
	}
}

func TestAcceptorStatePersistsAcrossRelayRestart(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	before := h.relay.Report()
	promised := before.GetAcceptor()[0].GetPromised()
	if promised == nil || promised.GetProposerId() != "d1" {
		t.Fatalf("promised ballot before restart = %v", promised)
	}

	h.restartRelay(false)
	if h.fresh {
		t.Fatal("lease bucket was recreated on a plain restart")
	}
	after := h.relay.Report()
	if after.GetIncarnation() <= before.GetIncarnation() {
		t.Fatalf("incarnation %d did not grow past %d", after.GetIncarnation(), before.GetIncarnation())
	}
	restored := after.GetAcceptor()
	if len(restored) != 1 || restored[0].GetPromised().GetRound() < promised.GetRound() || restored[0].GetPromised().GetProposerId() != "d1" {
		t.Fatalf("persisted promise was not restored: %v", restored)
	}
	// A restart within the same boot keeps voting (the relay.db boot stamp
	// proves it) and restores the hold of its last accept.
	if after.GetAcceptorAbstaining() {
		t.Fatal("relay restarted within the same boot abstains")
	}
	h.relayFrames = map[string][]*relayv1.CoordinationFrame{}
	h.step(availabilitylease.RenewInterval + time.Second)
	counted := false
	for _, promise := range relayPromises(t, h.relayFrames["d1"]) {
		counted = counted || !promise.GetShadow()
	}
	if !counted {
		t.Fatal("relay restarted within the same boot did not vote for the holder's renewal")
	}
	if !h.holding("d1") || h.holding("d2") {
		t.Fatal("holder changed across the relay restart")
	}
	// Restarted on another boot (host reboot): abstain for T x 1.1.
	h.relayClock.mu.Lock()
	h.relayClock.boot++
	h.relayClock.mu.Unlock()
	h.restartRelay(false)
	relayAbstains(t, h)
	if !h.holding("d1") || h.holding("d2") {
		t.Fatal("holder changed across the relay reboot")
	}
}

func TestFreshRelayStateAbstainsWithIncreasingIncarnation(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	before := h.relay.Report().GetIncarnation()

	// relay.db renamed: the bucket is created fresh and every record is gone.
	h.restartRelay(true)
	if !h.fresh {
		t.Fatal("renamed relay.db did not create a fresh lease bucket")
	}
	report := h.relay.Report()
	if report.GetIncarnation() <= before {
		t.Fatalf("fresh incarnation %d is not above %d", report.GetIncarnation(), before)
	}
	if acks := report.GetManifests(); len(acks) != 1 || acks[0].GetVoterEpoch() != 1 {
		t.Fatalf("fresh relay did not adopt the snapshot blocks: %v", report)
	}
	relayAbstains(t, h)
}
