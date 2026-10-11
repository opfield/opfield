package lease

import (
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const statefulPolicy = "policy-db"

var statefulKey = availabilitylease.Key{PolicyID: statefulPolicy}

// addStatefulPolicy publishes a stateful policy the relay witnesses with v1
// and v2, bootstrapped by d1, with every candidate eligible.
func addStatefulPolicy(h *harness) {
	h.t.Helper()
	h.stateful[statefulPolicy], h.bootstrap[statefulPolicy] = true, "d1"
	for _, id := range []string{"d1", "d2"} {
		h.daemons[id].SetStateHandler(statefulPolicy, &availabilitylease.StateHandler{
			Eligible:       func(availabilitylease.EligibilityInput) (bool, string) { return true, "" },
			BootstrapValue: func(availabilitylease.Key) ([]byte, error) { return []byte("bootstrap"), nil },
		})
	}
	h.addPolicy(statefulPolicy, []string{"d1", "d2"}, []string{relayID, "v1", "v2"})
}

func statefulEntry(t *testing.T, report *relayv1.AvailabilityLeaseReport) *relayv1.AvailabilityLeaseKeyView {
	t.Helper()
	for _, entry := range report.GetAcceptor() {
		if entry.GetPolicyId() == statefulPolicy {
			return entry
		}
	}
	return nil
}

// The relay acceptor of a stateful policy reports its memory (KNOWN, the
// accepted ballot, state hashes; never the state), admits the committed
// holder like any lease, and after relay.db is renamed reports UNKNOWN, never
// an empty state, until it accepts a round again (AS1, M1).
func TestStatefulPolicyViewAndRenamedRelayDB(t *testing.T) {
	h := newHarness(t, true)
	addStatefulPolicy(h)
	acquirePolicy(t, h, statefulPolicy, "d1")
	h.step(availabilitylease.RenewInterval + time.Second)
	entry := statefulEntry(t, h.relay.Report())
	if entry == nil || !entry.GetStateful() || !entry.GetStateKnown() || entry.GetAccepted().GetProposerId() != "d1" ||
		!strings.HasPrefix(entry.GetStateHash(), "sha256:") || !strings.HasPrefix(entry.GetCommittedStateHash(), "sha256:") {
		t.Fatalf("stateful view %v", entry)
	}
	committed, ok := h.daemons["d1"].CommittedState(statefulKey)
	if !ok || entry.GetCommittedStateHash() != availabilitylease.StateHashString(committed.Hash) {
		t.Fatalf("committed hash %q, holder certified %v", entry.GetCommittedStateHash(), committed)
	}
	if plain := statefulEntryOf(h.relay.Report(), policyID); plain != nil && (plain.GetStateful() || plain.GetStateHash() != "") {
		t.Fatalf("stateless policy view carries state fields: %v", plain)
	}

	h.restartRelay(true)
	if created := h.relay.node.StoreCreatedIncarnation(); created != h.relay.node.Incarnation() {
		t.Fatalf("renamed relay.db: store created at %d, incarnation %d", created, h.relay.node.Incarnation())
	}
	h.step(availabilitylease.RenewInterval + time.Second)
	entry = statefulEntry(t, h.relay.Report())
	if entry == nil || !entry.GetStateful() || entry.GetStateKnown() || entry.GetStateHash() != "" {
		t.Fatalf("after the rename the relay must report UNKNOWN: %v", entry)
	}
	if !h.stepUntil(availabilitylease.AbstainAfterStart+2*availabilitylease.RenewInterval, func() bool {
		entry := statefulEntry(t, h.relay.Report())
		return entry != nil && entry.GetStateKnown()
	}) {
		t.Fatal("the relay did not learn the state again from the holder's renewals")
	}
	if !h.daemons["d1"].HolderStatus(statefulKey).Holding || !h.relay.Admit(statefulPolicy, "d1").Open {
		t.Fatal("the holder lost the stateful key across the relay.db rename")
	}
}

func statefulEntryOf(report *relayv1.AvailabilityLeaseReport, policy string) *relayv1.AvailabilityLeaseKeyView {
	for _, entry := range report.GetAcceptor() {
		if entry.GetPolicyId() == policy {
			return entry
		}
	}
	return nil
}

// A relay.db written by a relay before lease v3 (no store marker, stateless
// records only) upgrades in place: the bucket is not recreated, the promise
// of the stateless key survives with its holder, and a stateful policy
// published after the upgrade is bootstrapped and certified normally.
func TestRelayDBFromBeforeV3UpgradesInPlace(t *testing.T) {
	h := newHarness(t, true)
	h.ready("d1", "d2")
	acquire(t, h, "d1")
	promised := h.relay.Report().GetAcceptor()[0].GetPromised()
	state, _, err := h.store.LeaseState()
	if err != nil {
		t.Fatal(err)
	}
	// Older relays never write the store marker; everything else they write
	// is byte-identical (availabilitylease golden test).
	if err := state.Apply(nil, []string{"storeinfo"}); err != nil {
		t.Fatal(err)
	}
	h.restartRelay(false)
	if h.fresh {
		t.Fatal("the lease bucket of an older relay.db was recreated")
	}
	// The first v3 start marks the store; it holds no KNOWN stateful memory.
	if created := h.relay.node.StoreCreatedIncarnation(); created != h.relay.node.Incarnation() {
		t.Fatalf("store marker %d, want the upgrading incarnation %d", created, h.relay.node.Incarnation())
	}
	restored := statefulEntryOf(h.relay.Report(), policyID)
	if restored == nil || restored.GetStateful() || restored.GetPromised().GetProposerId() != "d1" || restored.GetPromised().GetRound() < promised.GetRound() {
		t.Fatalf("stateless promise after the upgrade = %v, before %v", restored, promised)
	}
	h.step(availabilitylease.RenewInterval + time.Second)
	if !h.relay.Admit(policyID, "d1").Open || !h.daemons["d1"].HolderStatus(availabilitylease.Key{PolicyID: policyID}).Holding {
		t.Fatal("the holder lost the stateless key across the upgrade")
	}

	addStatefulPolicy(h)
	acquirePolicy(t, h, statefulPolicy, "d1")
	if !h.stepUntil(availabilitylease.AbstainAfterStart+2*availabilitylease.RenewInterval, func() bool {
		entry := statefulEntry(t, h.relay.Report())
		return entry != nil && entry.GetStateKnown()
	}) {
		t.Fatal("the upgraded relay never learned the stateful key")
	}
}
