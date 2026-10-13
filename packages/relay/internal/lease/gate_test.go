package lease

import (
	"strings"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

func acquire(t *testing.T, h *harness, id string) { acquirePolicy(t, h, policyID, id) }

func acquirePolicy(t *testing.T, h *harness, policy, id string) {
	t.Helper()
	key := availabilitylease.Key{PolicyID: policy}
	if !h.stepUntil(90*time.Second, func() bool { return h.daemons[id].HolderStatus(key).Holding && h.relay.Admit(policy, id).Open }) {
		t.Fatalf("%s did not acquire %s with an open relay gate (admission %+v)", id, policy, h.relay.Admit(policy, id))
	}
}

func TestGateOpensOnlyForCommittedHolderAndClosesWhenStale(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if other := h.relay.Admit(policyID, "d2"); !other.LeaseMode || other.Open {
		t.Fatalf("non-holder admission = %+v", other)
	}
	report := h.relay.Report()
	if len(report.GetAcceptor()) != 1 || !report.GetAcceptor()[0].GetGateOpen() || report.GetAcceptor()[0].GetGateHolderId() != "d1" || report.GetAcceptor()[0].GetHolderId() != "d1" {
		t.Fatalf("acceptor view = %v", report.GetAcceptor())
	}
	acks := report.GetManifests()
	if len(acks) != 1 || !acks[0].GetVoter() || !acks[0].GetMember() || acks[0].GetVoterEpoch() != 1 || len(report.GetTrustedPolicyKeyIds()) != 1 {
		t.Fatalf("report = %v", report)
	}

	// The holder goes silent: the gate closes by itself GateWindow after the
	// relay's last promise, without any message.
	h.down["d1"] = true
	remaining := h.relay.Admit(policyID, "d1").Remaining
	if remaining <= 0 || remaining > availabilitylease.GateWindow {
		t.Fatalf("remaining gate time = %s", remaining)
	}
	h.step(remaining - 200*time.Millisecond)
	if !h.relay.Admit(policyID, "d1").Open {
		t.Fatal("gate closed before its window ended")
	}
	h.step(300 * time.Millisecond)
	if admission := h.relay.Admit(policyID, "d1"); admission.Open || !admission.LeaseMode {
		t.Fatalf("stale gate admission = %+v", admission)
	}
	acquire(t, h, "d2")
	if h.relay.Admit(policyID, "d1").Open {
		t.Fatal("old holder admitted after the takeover")
	}
}

func TestGateMovesOnHandoffAndCloseForSupersededHolder(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if err := h.daemons["d1"].Release(testKey, "d2"); err != nil {
		t.Fatal(err)
	}
	h.step(100 * time.Millisecond)
	if admission := h.relay.Admit(policyID, "d1"); admission.Open {
		t.Fatalf("relinquished holder still admitted: %+v", admission)
	}
	acquire(t, h, "d2")
	if admission := h.relay.Admit(policyID, "d1"); admission.Open {
		t.Fatalf("superseded holder admitted: %+v", admission)
	}
}

func TestWallClockStepNeverClosesGates(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	for _, step := range []time.Duration{100 * time.Second, -100 * time.Second, 10 * time.Minute} {
		// NTP steps the wall clock; the lease clock is untouched (D4).
		h.wallSkew += step
		h.step(time.Second)
		if admission := h.relay.Admit(policyID, "d1"); !admission.Open {
			t.Fatalf("a wall-clock step of %s closed the gate: %+v", step, admission)
		}
	}
	if report := h.relay.Report(); report.GetLastSuspendDurationMs() != 0 {
		t.Fatalf("a wall-clock step was reported as a suspend: %v", report)
	}
}

func TestRelayFreezeClosesGatesUntilFreshPromise(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	// The relay learns every member's clock first.
	h.step(3 * time.Second)
	h.freezeRelay(8 * time.Second)
	// Before any member frame arrives the relay cannot know; the first one
	// (a beacon within a second) shows the freeze.
	if !h.stepUntil(1500*time.Millisecond, func() bool { return !h.relay.Admit(policyID, "d1").Open }) {
		t.Fatalf("gate stayed open after the relay resumed from a freeze: %+v", h.relay.Admit(policyID, "d1"))
	}
	if admission := h.relay.Admit(policyID, "d1"); !strings.Contains(admission.Reason, "freeze") {
		t.Fatalf("admission after the freeze = %+v", admission)
	}
	report := h.relay.Report()
	if ms := report.GetLastSuspendDurationMs(); ms < 5_000 || ms > 9_000 {
		t.Fatalf("report after the freeze = %d ms, want about 8 s", ms)
	}
	if !h.stepUntil(availabilitylease.RenewInterval+2*time.Second, func() bool { return h.relay.Admit(policyID, "d1").Open }) {
		t.Fatalf("gate did not reopen on a fresh promise: %+v", h.relay.Admit(policyID, "d1"))
	}
	if !h.holding("d1") {
		t.Fatal("an 8 s relay freeze must not cost the holder its lease")
	}
}

func TestNonVotingRelayGatesFromShadowAccepts(t *testing.T) {
	h := newHarness(t, false)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	if acks := h.relay.Report().GetManifests(); len(acks) != 1 || acks[0].GetVoter() || !acks[0].GetMember() {
		t.Fatalf("non-voting member view = %v", acks)
	}
	promises := relayPromises(t, h.relayFrames["d1"])
	if len(promises) == 0 {
		t.Fatal("relay sent no promises")
	}
	for _, promise := range promises {
		if !promise.GetShadow() {
			t.Fatal("non-voting relay sent a counted promise")
		}
	}
}

func TestClosedManifestUsesLegacyAdmissionAndUnknownPolicyStaysClosed(t *testing.T) {
	h := newHarness(t, true)
	if admission := h.relay.Admit("unknown-policy", "d1"); !admission.LeaseMode || admission.Open {
		t.Fatalf("unknown policy admission = %+v", admission)
	}
	h.signManifest([]string{"d1", "d2"}, true)
	h.relay.ApplyPolicy(h.snapshot())
	if admission := h.relay.Admit(policyID, "d2"); admission.LeaseMode {
		t.Fatalf("lease-closed policy admission = %+v", admission)
	}
	if acks := h.relay.Report().GetManifests(); len(acks) != 1 || !acks[0].GetClosed() || acks[0].GetManifestVersion() != 2 {
		t.Fatalf("manifest acks = %v", acks)
	}
}

// Graceful close: the relay confirms the close to the named holder, which
// keeps its copy; the relay keeps admitting it (legacy admission of a closed
// policy) and its gate view names it retained, so nginx keeps its socket open.
func TestGracefulCloseRetainsTheHolderAndKeepsItAdmitted(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	d1 := h.daemons["d1"]
	ballot := d1.HolderStatus(testKey).Ballot
	h.retained = []*relayv1.LeaseRetainedSlot{{Slot: 0, HolderId: "d1", Ballot: &relayv1.LeaseBallot{Round: ballot.Round, Incarnation: ballot.Incarnation, ProposerId: ballot.Proposer}}}
	block := h.signManifest([]string{"d1", "d2"}, true)
	h.relay.ApplyPolicy(h.snapshot())
	if _, err := d1.AdoptManifest(block); err != nil {
		t.Fatal(err)
	}
	for elapsed := time.Duration(0); elapsed < 2*time.Minute; elapsed += 100 * time.Millisecond {
		h.step(100 * time.Millisecond)
		if admission := h.relay.Admit(policyID, "d1"); admission.LeaseMode && !admission.Open {
			t.Fatalf("retained holder refused at %s: %+v", elapsed, admission)
		}
	}
	if st := d1.HolderStatus(testKey); !st.Retained {
		t.Fatalf("holder not retained through the relay and voters: %+v", st)
	}
	views := h.relay.gateViews(nil)
	if len(views) != 1 || views[0].GetLeaseMode() || views[0].GetHolderId() != "d1" || !strings.Contains(views[0].GetReason(), "retained") {
		t.Fatalf("gate view after the close = %v", views)
	}
	if st := h.daemons["d2"].HolderStatus(testKey); st.Holding || st.Retained {
		t.Fatalf("d2 after the close: %+v", st)
	}
}

func relayPromises(t *testing.T, frames []*relayv1.CoordinationFrame) []*relayv1.LeasePromise {
	t.Helper()
	var promises []*relayv1.LeasePromise
	for _, frame := range frames {
		batch := &relayv1.LeaseBatch{}
		if err := proto.Unmarshal(frame.GetPayload(), batch); err != nil {
			t.Fatal(err)
		}
		for _, item := range batch.GetItems() {
			if promise := item.GetPromise(); promise != nil {
				promises = append(promises, promise)
			}
		}
	}
	return promises
}

// A18: the relay votes only for the policy whose manifest makes it the
// witness; for another policy it is a non-voting member whose shadow accepts
// still open its gate, and its promises there never count.
func TestRelayVotesOnlyWhereItIsThePolicyWitness(t *testing.T) {
	h := newHarness(t, true)
	h.addPolicy("policy-2", []string{"d2", "d1"}, []string{"v1", "v2", "v3"})
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	acquirePolicy(t, h, "policy-2", "d2")
	if admission := h.relay.Admit("policy-2", "d1"); admission.Open {
		t.Fatalf("policy-2 admitted its non-holder: %+v", admission)
	}
	shadow := map[string]map[bool]bool{}
	for _, promise := range relayPromises(t, append(h.relayFrames["d1"], h.relayFrames["d2"]...)) {
		policy := promise.GetKey().GetPolicyId()
		if shadow[policy] == nil {
			shadow[policy] = map[bool]bool{}
		}
		shadow[policy][promise.GetShadow()] = true
	}
	if !shadow[policyID][false] || shadow[policyID][true] {
		t.Fatalf("policy-1 promises (witness) = %v", shadow[policyID])
	}
	if !shadow["policy-2"][true] || shadow["policy-2"][false] {
		t.Fatalf("policy-2 promises (non-voting member) = %v", shadow["policy-2"])
	}
	acks := map[string]*relayv1.AvailabilityLeaseManifestAck{}
	for _, ack := range h.relay.Report().GetManifests() {
		acks[ack.GetPolicyId()] = ack
	}
	if !acks[policyID].GetVoter() || acks["policy-2"].GetVoter() || !acks["policy-2"].GetMember() {
		t.Fatalf("per-policy report = %v", acks)
	}
}

// D6: gate views carry whether the open gate's holder serves through this
// relay, from the broker's registrations; a closed gate carries nothing.
func TestGateViewReportsHolderEndpointReadiness(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	readiness := relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY
	var asked []string
	h.relay.SetHolderEndpoints(func(policy, holder string) relayv1.LeaseHolderEndpoint {
		asked = append(asked, policy+"/"+holder)
		return readiness
	})
	acquire(t, h, "d1")
	view := h.relay.gateView(testKey)
	if !view.GetOpen() || view.GetHolderEndpoint() != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY {
		t.Fatalf("view of a holder that is not ready = %v", view)
	}
	readiness = relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY
	if view := h.relay.gateView(testKey); view.GetHolderEndpoint() != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY {
		t.Fatalf("view of a ready holder = %v", view)
	}
	if len(asked) == 0 || asked[len(asked)-1] != policyID+"/d1" {
		t.Fatalf("readiness asked for %v", asked)
	}
	asked = nil
	if view := h.relay.gateView(availabilitylease.Key{PolicyID: "unknown-policy"}); view.GetOpen() || view.GetHolderEndpoint() != relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN || len(asked) != 0 {
		t.Fatalf("closed gate view = %v (asked %v)", view, asked)
	}
}

// N-5: the relay reports when it first saw the committed holder, on its wall
// clock, so Gateway records the takeover time of a failover it learns about
// later (stand run rc20: the audit carried the time Gateway came back).
func TestReportCarriesWhenTheRelaySawTheHolderTakeOver(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	started := h.wall().UnixMilli()
	acquire(t, h, "d1")
	first := h.relay.Report().GetAcceptor()[0]
	if first.GetCommitted().GetProposerId() != "d1" || first.GetHolderSinceUnixMs() < started || first.GetHolderSinceUnixMs() > h.wall().UnixMilli() {
		t.Fatalf("holder since %d outside [%d, %d] for %v", first.GetHolderSinceUnixMs(), started, h.wall().UnixMilli(), first)
	}
	h.step(12 * time.Second)
	if renewed := h.relay.Report().GetAcceptor()[0]; renewed.GetHolderSinceUnixMs() != first.GetHolderSinceUnixMs() {
		t.Fatalf("renewals moved holder since from %d to %d", first.GetHolderSinceUnixMs(), renewed.GetHolderSinceUnixMs())
	}
	h.down["d1"] = true
	downAt := h.wall().UnixMilli()
	acquire(t, h, "d2")
	takeover := h.relay.Report().GetAcceptor()[0]
	if takeover.GetCommitted().GetProposerId() != "d2" || takeover.GetHolderSinceUnixMs() <= downAt || takeover.GetHolderSinceUnixMs() > h.wall().UnixMilli() {
		t.Fatalf("takeover since %d outside (%d, %d] for %v", takeover.GetHolderSinceUnixMs(), downAt, h.wall().UnixMilli(), takeover)
	}
}
