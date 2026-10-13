package lease

import (
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
)

// Report is the lease part of the daemon health report. Field for field it
// maps onto T3's opfield.v1 AvailabilityLeaseReport (see the T4 report for
// the wiring).
type Report struct {
	MemberID            string
	Incarnation         uint64
	TrustedPolicyKeyIDs []string
	Manifests           []ManifestAck
	Held                []Held
	// Acceptor lists keys of the policies whose manifest names this node a
	// voter (A18); shadow state kept for other policies is not reported.
	Acceptor           []AcceptorView
	AcceptorAbstaining bool
	WatchdogReady      bool
	Events             []ReportEvent
	LeaseRevision      uint64
	// ReportedAtUnixMs is the wall clock the report's times were converted
	// with; Opfield measures this daemon's clock offset from it (N-15).
	ReportedAtUnixMs int64
}

type ManifestAck struct {
	PolicyID string
	Version  uint64
	// VoterEpoch is the policy's persisted voter epoch (A4 ack per policy).
	VoterEpoch uint64
	Closed     bool
}

// AcceptorView is one key this node votes on, with its policy's voter epoch
// and manifest version.
type AcceptorView struct {
	availabilitylease.KeyView
	VoterEpoch      uint64
	ManifestVersion uint64
	// HolderSinceUnixMs is CommitSince on the wall clock: when this node
	// first stored a commit of the committed holder (N-5); zero when unknown.
	HolderSinceUnixMs int64
}

// Held is one key this node proposes for, with the D12 mapping of the lease
// ballot to this node's placement and generation.
type Held struct {
	Key  availabilitylease.Key
	Role string
	// Retained: graceful close confirmed; the copy runs without a lease.
	Retained            bool
	Ballot              availabilitylease.Ballot
	Epoch               uint64
	ManifestVersion     uint64
	PlacementID         string
	PlacementGeneration uint64
	// SinceUnixMs is when this node acquired the key for its current holding,
	// on its wall clock; zero when unknown (a key recovered after a restart).
	// It is exact and survives reports lost while Opfield was away, unlike the
	// drained acquired event: the takeover time Opfield audits (N-5, B-14).
	SinceUnixMs int64
}

// EventRecovered is the report event of a key renewed by a copy that kept
// running through a daemon restart: the same holding, not a new acquisition.
const EventRecovered = "recovered"

// markRecoveringLocked notes a key recovered after a daemon start.
func (r *Runtime) markRecoveringLocked(key availabilitylease.Key) {
	if r.recovering == nil {
		r.recovering = map[availabilitylease.Key]bool{}
	}
	r.recovering[key] = true
}

type ReportEvent struct {
	Kind      string
	Key       availabilitylease.Key
	Ballot    availabilitylease.Ballot
	Successor string
	Reason    string
	AtUnixMs  int64
	// at is the transition on the lease clock; the report converts it with the
	// same wall clock as ReportedAtUnixMs, so Opfield's offset applies to it.
	at time.Duration
}

// Report returns the current lease state and drains the events collected
// since the previous report.
func (r *Runtime) Report() Report {
	report := Report{
		MemberID: r.opts.NodeID, Incarnation: r.node.Incarnation(),
		WatchdogReady: HeartbeatAlive(r.opts.Fence, r.opts.Clock.Now()),
	}
	voting := map[string]availabilitylease.ManifestInfo{}
	for _, manifest := range r.node.Manifests() {
		report.Manifests = append(report.Manifests, ManifestAck{PolicyID: manifest.PolicyID, Version: manifest.Version, VoterEpoch: manifest.Epoch, Closed: manifest.Closed})
		if manifest.IsVoter(r.opts.NodeID) {
			voting[manifest.PolicyID] = manifest
		}
	}
	now, wall := r.opts.Clock.Now(), r.opts.Wall()
	report.ReportedAtUnixMs = wall.UnixMilli()
	r.mu.Lock()
	heldSince := make(map[availabilitylease.Key]time.Duration, len(r.heldSince))
	for key, at := range r.heldSince {
		heldSince[key] = at
	}
	r.mu.Unlock()
	for _, status := range r.node.Holders() {
		held := Held{Key: status.Key, Role: status.Role.String(), Ballot: status.Ballot, Retained: status.Retained}
		held.Epoch, held.ManifestVersion, _ = r.node.HeldCommit(status.Key)
		if placement, ok := r.opts.Placements.Local(status.Key.PolicyID); ok {
			held.PlacementID, held.PlacementGeneration = placement.PlacementID, placement.Generation
		}
		if at, ok := heldSince[status.Key]; ok && at <= now {
			held.SinceUnixMs = wall.Add(-(now - at)).UnixMilli()
		}
		report.Held = append(report.Held, held)
	}
	for _, view := range r.node.AcceptorView() {
		manifest, votes := voting[view.Key.PolicyID]
		if !votes {
			continue
		}
		entry := AcceptorView{KeyView: view, VoterEpoch: manifest.Epoch, ManifestVersion: manifest.Version}
		if view.CommitSince > 0 && view.CommitSince <= now {
			entry.HolderSinceUnixMs = wall.Add(-(now - view.CommitSince)).UnixMilli()
		}
		report.Acceptor = append(report.Acceptor, entry)
		report.AcceptorAbstaining = report.AcceptorAbstaining || view.Abstaining
	}
	report.TrustedPolicyKeyIDs = r.node.TrustedPolicyKeyIDs()
	r.mu.Lock()
	report.Events = r.events
	r.events = nil
	for i := range report.Events {
		if at := report.Events[i].at; at > 0 && at <= now {
			report.Events[i].AtUnixMs = wall.Add(-(now - at)).UnixMilli()
		}
	}
	report.LeaseRevision = r.revision
	r.mu.Unlock()
	return report
}

// collectEventsLocked moves protocol transitions into the report buffer and
// logs them: the audit trail of autonomous transitions (D9).
func (r *Runtime) collectEventsLocked() {
	events := r.node.DrainEvents()
	if len(events) == 0 {
		return
	}
	now, wall := r.opts.Clock.Now(), r.opts.Wall()
	if r.heldSince == nil {
		r.heldSince = map[availabilitylease.Key]time.Duration{}
	}
	for _, event := range events {
		kind := string(event.Kind)
		// The current holding starts with its acquired transition and ends with
		// a fence, release or handoff; renewals do not move it.
		switch event.Kind {
		case availabilitylease.EventAcquired:
			if r.recovering[event.Key] {
				// The copy kept running through the restart: the same holding
				// goes on (M-5), reported as recovered and without a start time.
				delete(r.recovering, event.Key)
				kind = EventRecovered
				break
			}
			r.heldSince[event.Key] = event.At
		case availabilitylease.EventFence, availabilitylease.EventReleased, availabilitylease.EventHandoff:
			delete(r.heldSince, event.Key)
			delete(r.recovering, event.Key)
		}
		at := wall.Add(-(now - event.At))
		r.logger.Info("availability lease transition", "kind", kind, "policy_id", event.Key.PolicyID, "slot", event.Key.Slot,
			"ballot", event.Ballot.String(), "successor_id", event.Successor, "reason", event.Reason, "at", at.Format(time.RFC3339Nano))
		r.events = append(r.events, ReportEvent{
			Kind: kind, Key: event.Key, Ballot: event.Ballot, Successor: event.Successor,
			Reason: string(event.Reason), AtUnixMs: at.UnixMilli(), at: event.At,
		})
	}
	if len(r.events) > maxPendingEvents {
		r.events = r.events[len(r.events)-maxPendingEvents:]
	}
}
