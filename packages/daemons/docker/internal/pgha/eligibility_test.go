package pgha

import (
	"testing"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

func pgTestConfig() Config {
	config, err := ParseConfig(testConfig(testEngineConfig()))
	if err != nil {
		panic(err)
	}
	return config
}

func standbyView(timeline uint32, position LSN) viewData {
	return viewData{config: pgTestConfig(), inRecovery: true, timeline: timeline, position: position, replay: position, historyOK: true}
}

func input(value Value) memberha.EligibilityInput {
	data, err := value.Encode()
	if err != nil {
		panic(err)
	}
	return memberha.EligibilityInput{Key: Key{PolicyID: policyID}, Phase: availabilitylease.EligibilityPromise,
		Adopted: HolderState{Value: data, Holder: nodeB}, PreviousHolder: nodeB}
}

func expect(t *testing.T, view viewData, in memberha.EligibilityInput, want bool, reason string) {
	t.Helper()
	ok, got := view.evaluate(in)
	if ok != want || got != reason {
		t.Fatalf("eligible = %v (%s), want %v (%s)", ok, got, want, reason)
	}
}

// Synchronous durability: only a certified sync member whose flush is at or
// above the certified eligibility floor (AS4) takes over.
func TestEligibilitySynchronous(t *testing.T) {
	view := standbyView(1, MustLSN("0/5000000"))
	value := syncValue(1, selfMember)
	expect(t, view, input(value), true, ReasonEligibleSync)
	expect(t, view, input(syncValue(1, memberC)), false, ReasonNotInSyncSet)
	value.EligibilityFloor = MustLSN("0/6000000")
	expect(t, view, input(value), false, ReasonBelowFloor)
	value.EligibilityFloor = MustLSN("0/5000000")
	expect(t, view, input(value), true, ReasonEligibleSync)
}

// AS7/M2: asynchronous eligibility = received >= max(certified floor,
// in-memory progress) - maxLag/2; no floor evidence is not eligible.
func TestEligibilityAsynchronousProgressFloor(t *testing.T) {
	view := standbyView(1, MustLSN("0/5000000"))
	value := Value{Timeline: 1, Durability: DurabilityAsynchronous}
	expect(t, view, input(value), false, ReasonNoProgressEvidence)
	value.ProgressFloor = MustLSN("0/5080000") // maxLag/2 ahead: within the margin
	expect(t, view, input(value), true, ReasonEligibleAsync)
	value.ProgressFloor = MustLSN("0/5080001")
	expect(t, view, input(value), false, ReasonLagAboveBound)
	// The walreceiver saw the primary further ahead than the certified floor.
	value.ProgressFloor = MustLSN("0/5000000")
	view.progress = MustLSN("0/7000000")
	expect(t, view, input(value), false, ReasonLagAboveBound)
}

// M2: the review's case. A member exactly maxLag below the certified floor
// was eligible before; the primary could be up to one certification step
// past the floor, so the loss would have reached 1.5 x maxLag. Now the
// loss is at most maxLag/2 + maxLag/4 (+ one certification delay of WAL).
func TestEligibilityAsyncLossBound(t *testing.T) {
	maxLag := LSN(1 << 20)
	floor := MustLSN("0/6000000")
	view := standbyView(1, floor-maxLag)
	value := Value{Timeline: 1, Durability: DurabilityAsynchronous, ProgressFloor: floor}
	expect(t, view, input(value), false, ReasonLagAboveBound)
	// The primary's flush when the floor was last certified can be one
	// step (maxLag/4) ahead of it; the most WAL an eligible member loses:
	primaryFlush := floor + maxLag/4
	eligible := standbyView(1, floor-maxLag/2)
	expect(t, eligible, input(value), true, ReasonEligibleAsync)
	if loss := primaryFlush - eligible.position; loss >= maxLag {
		t.Fatalf("loss %d reaches maxLag %d", loss, maxLag)
	}
}

// AS6: the proposer of the highest KNOWN accepted ballot stays eligible
// unless it released it, or its data directory was replaced since.
func TestEligibilityPreviousHolder(t *testing.T) {
	view := standbyView(2, MustLSN("0/5000000"))
	view.history = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/4000000")}}
	value := Value{Timeline: 2, ParentTimeline: 1, SwitchLSN: MustLSN("0/4000000"), Durability: DurabilitySynchronous, Degraded: true}
	in := input(value)
	in.PreviousHolder = selfNode
	expect(t, view, in, true, ReasonEligiblePrevious)
	// Its Postgres may even still be a primary (never fenced, lease lapsed).
	primary := view
	primary.inRecovery = false
	expect(t, primary, in, true, ReasonEligiblePrevious)
	released := in
	released.PreviousReleased = true
	expect(t, view, released, false, ReasonNotInSyncSet)
	rebuilt := view
	rebuilt.dataEpoch = 3
	rebuilt.heldDataEpoch = 2
	expect(t, rebuilt, in, false, ReasonPreviousDataReplace)
	// Another member is the previous holder: normal rules apply.
	other := in
	other.PreviousHolder = nodeB
	expect(t, view, other, false, ReasonNotInSyncSet)
}

// AS11: the designated successor takes over only once it is certified sync
// and replayed the final LSN of the stopped primary.
func TestEligibilityDesignatedSuccessor(t *testing.T) {
	view := standbyView(1, MustLSN("0/5000000"))
	value := syncValue(1, selfMember)
	value.Final = &Final{Successor: selfMember, LSN: MustLSN("0/5000000")}
	expect(t, view, input(value), true, ReasonEligibleDesignated)
	value.Final.LSN = MustLSN("0/5000001")
	expect(t, view, input(value), false, ReasonFinalNotReplayed)
	notSync := syncValue(1, memberC)
	notSync.Final = &Final{Successor: selfMember, LSN: MustLSN("0/4000000")}
	expect(t, view, input(notSync), false, ReasonFinalNotReplayed)
	async := Value{Timeline: 1, Durability: DurabilityAsynchronous, Final: &Final{Successor: selfMember, LSN: MustLSN("0/4000000")}}
	expect(t, view, input(async), true, ReasonEligibleDesignated)
	// A final for another member leaves the normal rules to everyone else.
	forOther := syncValue(1, selfMember)
	forOther.Final = &Final{Successor: memberC, LSN: MustLSN("0/9000000")}
	expect(t, view, input(forOther), true, ReasonEligibleSync)
}

// M3: timeline history rules.
func TestEligibilityTimelineHistory(t *testing.T) {
	certified := Value{Timeline: 3, ParentTimeline: 2, SwitchLSN: MustLSN("0/4000000"), Durability: DurabilitySynchronous, SyncSet: []string{selfMember}}

	same := standbyView(3, MustLSN("0/5000000"))
	same.history = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/1000000")}, {Timeline: 2, SwitchLSN: MustLSN("0/4000000")}}
	expect(t, same, input(certified), true, ReasonEligibleSync)

	// Same number, another branch (the parent ended elsewhere).
	fork := same
	fork.history = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/1000000")}, {Timeline: 2, SwitchLSN: MustLSN("0/4800000")}}
	expect(t, fork, input(certified), false, ReasonTimeline)

	// On the parent, stopped before the fork point: can follow.
	parent := standbyView(2, MustLSN("0/4000000"))
	expect(t, parent, input(certified), true, ReasonEligibleSync)
	// On the parent past the fork point: diverged.
	past := standbyView(2, MustLSN("0/4000001"))
	expect(t, past, input(certified), false, ReasonTimeline)
	// Two timelines behind: not provable.
	old := standbyView(1, MustLSN("0/1000000"))
	expect(t, old, input(certified), false, ReasonTimeline)

	// Ahead: a standby already followed the acquirer's new timeline 4 before
	// it was certified; its history contains 3 on the certified branch.
	ahead := standbyView(4, MustLSN("0/6000000"))
	ahead.history = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/1000000")}, {Timeline: 2, SwitchLSN: MustLSN("0/4000000")}, {Timeline: 3, SwitchLSN: MustLSN("0/5800000")}}
	expect(t, ahead, input(certified), true, ReasonEligibleSync)
	aheadOther := ahead
	aheadOther.history = []TimelineEntry{{Timeline: 1, SwitchLSN: MustLSN("0/1000000")}, {Timeline: 2, SwitchLSN: MustLSN("0/4000000")}}
	expect(t, aheadOther, input(certified), false, ReasonTimeline)
	unreadable := ahead
	unreadable.historyOK = false
	expect(t, unreadable, input(certified), false, ReasonTimeline)
}

func TestEligibilityPreconditions(t *testing.T) {
	value := syncValue(1, selfMember)
	base := standbyView(1, MustLSN("0/5000000"))
	notStandby := base
	notStandby.inRecovery = false
	expect(t, notStandby, input(value), false, ReasonNotStandby)
	rebuild := base
	rebuild.needsRebuild = true
	expect(t, rebuild, input(value), false, ReasonRebuildNeeded)
	bad := input(value)
	bad.Adopted.Value = []byte("{")
	expect(t, base, bad, false, ReasonUndecodable)
}

// The runtime's shared checks come first: a member whose rejoin runs, or
// that is being removed, is not eligible whatever its data (memberha).
func TestEligibilityThroughTheRuntimeNeedsAFreshAnsweringCopy(t *testing.T) {
	h := newHarness(t)
	h.settle()
	h.lease.mu.Lock()
	handler := h.lease.handler
	h.lease.mu.Unlock()
	ok, reason := handler.Eligible(input(syncValue(1, selfMember)))
	if !ok || reason != ReasonEligibleSync {
		t.Fatalf("a streaming sync member must be eligible: %v %s", ok, reason)
	}
	h.watchdog.gone = true
	h.run(3, 1e9)
	if ok, reason := handler.Eligible(input(syncValue(1, selfMember))); ok || reason != "watchdog_not_fresh" {
		t.Fatalf("without the watchdog a member must not be eligible: %v %s", ok, reason)
	}
}
