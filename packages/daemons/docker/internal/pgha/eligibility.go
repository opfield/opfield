package pgha

import (
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

// Eligibility reasons (reported per member). The runtime checks first what
// every engine shares (a fresh sample of an answering engine, the watchdog,
// no rejoin running, not being removed).
const (
	ReasonEligiblePrevious   = "previous_holder"
	ReasonEligibleDesignated = "designated_successor"
	ReasonEligibleSync       = "sync_member"
	ReasonEligibleAsync      = "async_within_bound"

	ReasonUndecodable         = "state_undecodable"
	ReasonNotStandby          = "not_a_standby"
	ReasonTimeline            = "timeline_diverged"
	ReasonFinalNotReplayed    = "final_lsn_not_replayed"
	ReasonNotInSyncSet        = "not_in_sync_set"
	ReasonBelowFloor          = "below_eligibility_floor"
	ReasonNoProgressEvidence  = "no_progress_evidence"
	ReasonLagAboveBound       = "lag_above_bound"
	ReasonPreviousDataReplace = "previous_holder_data_replaced"
	ReasonRebuildNeeded       = "rebuild_needed"
)

// viewData is one snapshot of the member for the eligibility callback.
type viewData struct {
	config        Config
	inRecovery    bool
	timeline      uint32
	position      LSN
	replay        LSN
	flush         LSN
	progress      LSN
	history       []TimelineEntry
	historyOK     bool
	dataEpoch     uint64
	heldDataEpoch uint64
	needsRebuild  bool
}

func (e *Engine) viewLocked() viewData {
	st := e.obs.status
	return viewData{
		config: e.cfg, inRecovery: st.InRecovery, timeline: st.Timeline, position: st.Position(), replay: st.ReplayLSN,
		flush: st.FlushLSN, progress: e.standby.progress, history: append([]TimelineEntry(nil), e.obs.history...),
		historyOK: e.obs.historyOK, dataEpoch: e.state.DataEpoch, heldDataEpoch: e.state.HeldDataEpoch,
		needsRebuild: e.state.NeedsRebuild,
	}
}

// Eligible is the lease eligibility callback (AS4, AS6, AS7, AS11, M3); it
// reads only the last sample (it runs under the protocol node's lock).
func (e *Engine) Eligible(in memberha.EligibilityInput, _ memberha.EngineStatus) (bool, string) {
	e.mu.Lock()
	view := e.viewLocked()
	e.mu.Unlock()
	return view.evaluate(in)
}

func (v viewData) evaluate(in memberha.EligibilityInput) (bool, string) {
	if v.needsRebuild {
		return false, ReasonRebuildNeeded
	}
	value, err := DecodeValue(in.Adopted.Value)
	if err != nil {
		return false, ReasonUndecodable
	}
	memberID := v.config.MemberID
	previousReason := ""
	if in.PreviousHolder == v.config.NodeID && !in.PreviousReleased {
		// AS6: the proposer of the highest KNOWN accepted ballot holds every
		// commit it acknowledged, unless its data directory was replaced
		// since (rewind, rebuild) or it moved off the certified history.
		if v.dataEpoch == v.heldDataEpoch && v.timelineCompatible(value) {
			return true, ReasonEligiblePrevious
		}
		previousReason = ReasonPreviousDataReplace
	}
	if !v.inRecovery {
		return false, ReasonNotStandby
	}
	if !v.timelineCompatible(value) {
		return false, ReasonTimeline
	}
	if value.Final != nil && value.Final.Successor == memberID {
		// AS11: a designated successor certified sync (synchronous durability)
		// that replayed the final LSN of the stopped primary.
		if v.replay >= value.Final.LSN && (!value.Synchronous() || value.InSyncSet(memberID)) {
			return true, ReasonEligibleDesignated
		}
		return false, ReasonFinalNotReplayed
	}
	if value.Synchronous() {
		if !value.InSyncSet(memberID) {
			return false, firstReason(previousReason, ReasonNotInSyncSet)
		}
		if v.position < value.EligibilityFloor {
			return false, ReasonBelowFloor
		}
		return true, ReasonEligibleSync
	}
	reference := maxLSN(value.ProgressFloor, v.progress)
	if reference == 0 {
		return false, firstReason(previousReason, ReasonNoProgressEvidence)
	}
	// M2: the primary may have flushed up to one certification step (plus the
	// WAL of one certification delay) past the certified floor, so only half
	// the bound is granted against the floor.
	if v.position+asyncMargin(v.config) < reference {
		return false, firstReason(previousReason, ReasonLagAboveBound)
	}
	return true, ReasonEligibleAsync
}

// asyncMargin is how far below the progress reference an asynchronous member
// may be and still take over: maxLag/2 (see the loss bound in doc.go).
func asyncMargin(config Config) LSN { return config.MaxLag() / 2 }

// asyncFloorStep is how far the primary's flush must advance before the
// progress floor is certified again (at most once per floorInterval).
func asyncFloorStep(config Config) LSN { return max(config.MaxLag()/4, 1) }

// timelineCompatible implements M3: the member follows the certified
// timeline, or its history descends from it on the same branch, or it
// stopped on the certified timeline's parent before the switch point.
func (v viewData) timelineCompatible(value Value) bool {
	certified := value.Timeline
	if certified == 0 || v.timeline == 0 {
		return certified == 0
	}
	branchKnown := value.ParentTimeline != 0 && value.SwitchLSN != 0
	if v.timeline < certified {
		return branchKnown && v.timeline == value.ParentTimeline && v.position <= value.SwitchLSN
	}
	if v.timeline > certified {
		if !v.historyOK || !historyHas(v.history, certified) {
			return false
		}
	}
	if !branchKnown {
		return true
	}
	if !v.historyOK {
		return false
	}
	// Same branch: the member's history says the parent ended exactly at the
	// certified switch point (timeline numbers alone repeat across forks).
	for _, entry := range v.history {
		if entry.Timeline == value.ParentTimeline {
			return entry.SwitchLSN == value.SwitchLSN
		}
	}
	return false
}

func historyHas(history []TimelineEntry, timeline uint32) bool {
	for _, entry := range history {
		if entry.Timeline == timeline {
			return true
		}
	}
	return false
}

// parentOf returns the parent timeline and switch point of the member's
// current timeline from its history (the last entry).
func parentOf(history []TimelineEntry) (uint32, LSN) {
	if len(history) == 0 {
		return 0, 0
	}
	last := history[len(history)-1]
	return last.Timeline, last.SwitchLSN
}
