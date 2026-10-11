package leasegate

import (
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

func TestLeaseGateTrackerOpensOnlyForTheReportedHolder(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, now)

	if !tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("gate should be open for the reported holder")
	}
	if tracker.OpenFor("policy-1", "node-b", now) {
		t.Fatal("gate must not open for a different candidate")
	}
	if tracker.OpenFor("policy-2", "node-a", now) {
		t.Fatal("gate must not open for a different policy")
	}
}

// TestLeaseGateTrackerLeaseModeFalseOpensForEveryCandidate covers the B2
// fix: a policy that is not lease-bound (legacy, or after its lease closed)
// admits every member once a relay reports lease_mode=false, regardless of
// holder_id. Without this, a lease-bound member loses ingress permanently
// the moment its policy leaves lease mode.
func TestLeaseGateTrackerLeaseModeFalseOpensForEveryCandidate(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		{PolicyId: "policy-1", Slot: 0, LeaseMode: false, Open: false, HolderId: ""},
	}}, now)
	if !tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("a fresh lease_mode=false view must open every candidate's socket (legacy admission, B2)")
	}
	if !tracker.OpenFor("policy-1", "node-b", now) {
		t.Fatal("legacy admission must not depend on which candidate is asking")
	}
}

func TestLeaseGateTrackerClosesOnAClosedLeaseModeGate(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		{PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: false, HolderId: "node-a", Reason: "expired"},
	}}, now)
	if tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("a closed lease-mode gate must not open a socket")
	}
}

func TestLeaseGateTrackerViewGoesStaleWithoutABroadcast(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 1000,
	}}}, now)
	if !tracker.OpenFor("policy-1", "node-a", now.Add(500*time.Millisecond)) {
		t.Fatal("gate should still be open within its reported TTL")
	}
	if tracker.OpenFor("policy-1", "node-a", now.Add(1500*time.Millisecond)) {
		t.Fatal("gate must close once its TTL elapses, even with no new broadcast")
	}
}

func TestLeaseGateTrackerCapsTTLAtTheLeaseTerm(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	// A relay that misreports an implausibly long remaining_ms must not keep
	// a socket open past the protocol's own lease term (D8, A8).
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a",
		RemainingMs: uint64(2 * MaxTTL / time.Millisecond),
	}}}, now)
	if tracker.OpenFor("policy-1", "node-a", now.Add(MaxTTL+time.Second)) {
		t.Fatal("a view must never be trusted past the lease term regardless of what the relay reports")
	}
}

func TestLeaseGateTrackerSecondRelayReopensAfterFirstGoesStale(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 100,
	}}}, now)
	tracker.Apply("relay-2", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, now)
	later := now.Add(500 * time.Millisecond)
	if !tracker.OpenFor("policy-1", "node-a", later) {
		t.Fatal("some relay's still-fresh view should keep the socket open even after another relay's view expired")
	}
}

// D6: a holder whose workload is not ready yet registers dormant on the relays
// that carry its endpoint; its socket stays closed until one relay says it
// serves, so nginx refuses the member before sending a byte (B-5).
func TestLeaseGateTrackerWaitsForTheHoldersEndpoint(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	view := func(readiness relayv1.LeaseHolderEndpoint) *relayv1.LeaseGateSnapshot {
		return &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
			PolicyId: "policy-1", Slot: 1, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 20000, HolderEndpoint: readiness,
		}}}
	}
	tracker.Apply("relay-1", view(relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY), now)
	tracker.Apply("relay-2", view(relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY), now)
	if tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("a holder that is not ready yet must keep its socket closed")
	}
	// A relay that does not report readiness (older, or not carrying the
	// endpoint) does not open it while another relay says it is not ready.
	tracker.Apply("relay-old", view(relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN), now)
	if tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("an unknown readiness overrode a relay that says the holder is not ready")
	}
	tracker.Apply("relay-2", view(relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY), now)
	if !tracker.OpenFor("policy-1", "node-a", now) {
		t.Fatal("a holder one relay reports ready must open")
	}

	// Only relays without the readiness: the gate alone decides, as before.
	legacy := NewTracker()
	legacy.Apply("relay-old", view(relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN), now)
	if !legacy.OpenFor("policy-1", "node-a", now) {
		t.Fatal("views from relays without readiness must open on the gate")
	}
}

// Graceful close: across the switch from the holder's open lease gate to the
// closed policy's view (lease_mode=false, naming the retained holder) the
// retained holder's socket never closes, on any relay's order of updates.
func TestLeaseGateTrackerKeepsTheRetainedHolderOpenAcrossAClose(t *testing.T) {
	tracker := NewTracker()
	now := time.Now()
	open := &relayv1.LeaseGateView{PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a",
		RemainingMs: 24000, HolderEndpoint: relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY}
	closed := &relayv1.LeaseGateView{PolicyId: "policy-1", Slot: 0, LeaseMode: false, HolderId: "node-a", Reason: "lease closed: retained holder"}
	tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{open}}, now)
	tracker.Apply("relay-2", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{open}}, now)
	steps := []struct {
		relay string
		view  *relayv1.LeaseGateView
	}{{"relay-1", closed}, {"relay-2", closed}}
	for i, step := range steps {
		now = now.Add(time.Second)
		tracker.Apply(step.relay, &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{step.view}}, now)
		if !tracker.OpenFor("policy-1", "node-a", now) {
			t.Fatalf("retained holder's socket closed after step %d", i)
		}
	}
	// The relays keep broadcasting the closed view; the holder never stops
	// being admitted, long after its last lease gate would have expired.
	for elapsed := time.Duration(0); elapsed < 2*time.Minute; elapsed += time.Second {
		now = now.Add(time.Second)
		tracker.Apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{closed}}, now)
		if !tracker.OpenFor("policy-1", "node-a", now) {
			t.Fatalf("retained holder's socket closed %s after the close", elapsed)
		}
	}
}

// B-13: a holder whose daemon restarts gracefully keeps its socket open (nginx holds its connections) unless another
// member of the policy serves; RESTARTING wins over a relay that only lost the registration (NOT_READY).
func TestRestartingHolderStaysOpenUnlessAnotherMemberServes(t *testing.T) {
	now := time.Now()
	view := func(slot uint32, holder string, endpoint relayv1.LeaseHolderEndpoint) *relayv1.LeaseGateSnapshot {
		return &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
			PolicyId: "policy-1", Slot: slot, LeaseMode: true, Open: true, HolderId: holder, RemainingMs: 20000, HolderEndpoint: endpoint,
		}}}
	}
	restarting := relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_RESTARTING

	failover := NewTracker()
	failover.Apply("relay-1", view(0, "node-a", restarting), now)
	failover.Apply("relay-old", view(0, "node-a", relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY), now)
	if !failover.OpenFor("policy-1", "node-a", now) {
		t.Fatal("the only member, restarting, was closed")
	}
	if failover.OtherMemberServes("policy-1", "node-a", now) {
		t.Fatal("no other member serves")
	}

	replicated := NewTracker()
	replicated.Apply("relay-1", view(1, "node-a", restarting), now)
	replicated.Apply("relay-2", view(0, "node-b", relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY), now)
	if replicated.OpenFor("policy-1", "node-a", now) {
		t.Fatal("a restarting replica stayed open while another replica serves")
	}
	if !replicated.OpenFor("policy-1", "node-b", now) {
		t.Fatal("the serving replica was closed")
	}
	if !replicated.OtherMemberServes("policy-1", "node-a", now) {
		t.Fatal("the serving replica was not seen")
	}
}
