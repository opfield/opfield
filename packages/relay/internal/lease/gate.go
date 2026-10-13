package lease

import (
	"strings"
	"time"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"github.com/opfield/opfield/relay/internal/broker"
)

// maxSlots bounds the slot scan when the member view lacks a manifest the
// node knows; manifests allow at most 32 slots.
const maxSlots = 32

// keyGate is the relay data-path gate for one key.
type keyGate struct {
	decision  availabilitylease.GateDecision
	open      bool
	remaining time.Duration
	reason    string
}

// gate evaluates the node's gate: a valid commit nothing known supersedes,
// plus this relay's own promise of that ballot within GateWindow (A11, A15),
// made after the last freeze of this host the node detected from its members'
// clocks (A17, D4).
func (c *Coordinator) gate(key availabilitylease.Key) keyGate {
	decision := c.node.Gate(key)
	result := keyGate{decision: decision, open: decision.LeaseMode && decision.Open, reason: decision.Reason}
	if !result.open {
		return result
	}
	result.remaining = decision.Until - c.clock.Now()
	if result.remaining <= 0 {
		result.open, result.reason = false, "expired"
	}
	return result
}

func (c *Coordinator) slots(policyID string) uint32 {
	if manifest, ok := c.view.manifest(policyID); ok && manifest.slots > 0 {
		return manifest.slots
	}
	return maxSlots
}

// Admit is the broker's data-path gate for a lease-bound placement: subjectID
// (a docker node id) must hold a committed slot of policyID and this relay's
// gate for that slot must be open. A policy whose manifest is lease-closed
// returns LeaseMode false, so the broker applies legacy admission; a policy
// without any manifest stays closed.
func (c *Coordinator) Admit(policyID, subjectID string) broker.LeaseAdmission {
	c.observeSuspend()
	if c.node.ManifestVersion(policyID) == 0 {
		return broker.LeaseAdmission{LeaseMode: true, Reason: "no lease manifest for the policy"}
	}
	if !c.node.LeaseMode(policyID) {
		return broker.LeaseAdmission{}
	}
	reason := ""
	slots := c.slots(policyID)
	for slot := uint32(0); slot < slots; slot++ {
		gate := c.gate(availabilitylease.Key{PolicyID: policyID, Slot: slot})
		if gate.decision.Holder != subjectID {
			continue
		}
		if gate.open {
			return broker.LeaseAdmission{LeaseMode: true, Open: true, Remaining: gate.remaining}
		}
		reason = gate.reason
	}
	if reason == "" {
		reason = subjectID + " holds no committed slot"
	}
	return broker.LeaseAdmission{LeaseMode: true, Reason: reason}
}

// gateViews lists the gate of every slot of the given policies (all known
// policies when empty), for WatchLeaseGates.
func (c *Coordinator) gateViews(policyIDs []string) []*relayv1.LeaseGateView {
	if len(policyIDs) == 0 {
		policyIDs = c.view.policyIDs()
	}
	views := []*relayv1.LeaseGateView{}
	for _, policyID := range policyIDs {
		manifest, ok := c.view.manifest(policyID)
		if !ok {
			continue
		}
		for slot := uint32(0); slot < manifest.slots; slot++ {
			views = append(views, c.gateView(availabilitylease.Key{PolicyID: policyID, Slot: slot}))
		}
	}
	return views
}

func (c *Coordinator) gateView(key availabilitylease.Key) *relayv1.LeaseGateView {
	gate := c.gate(key)
	view := &relayv1.LeaseGateView{
		PolicyId: key.PolicyID, Slot: key.Slot, LeaseMode: gate.decision.LeaseMode, Open: gate.open,
		HolderId: gate.decision.Holder, Reason: gate.reason,
	}
	if ballot := gate.decision.Ballot; !ballot.IsZero() {
		view.Ballot = &relayv1.LeaseBallot{Round: ballot.Round, Incarnation: ballot.Incarnation, ProposerId: ballot.Proposer}
	}
	if gate.open {
		view.RemainingMs = uint64(gate.remaining.Milliseconds())
		c.mu.Lock()
		holderEndpoint := c.holderEndpoint
		c.mu.Unlock()
		if holderEndpoint != nil {
			// Called without the coordinator lock: the broker takes its own
			// lock and consults the gate under it.
			view.HolderEndpoint = holderEndpoint(key.PolicyID, gate.decision.Holder)
		}
	}
	return view
}

// Report is the relay's lease view for GetHealth and the supervisor report,
// in the gateway.v1 AvailabilityLeaseReport shape.
func (c *Coordinator) Report() *relayv1.AvailabilityLeaseReport {
	c.observeSuspend()
	c.mu.Lock()
	identityKey := append([]byte(nil), c.identityKey...)
	c.mu.Unlock()
	report := &relayv1.AvailabilityLeaseReport{
		MemberId: c.id, IdentityPublicKey: identityKey, Incarnation: c.node.Incarnation(),
		AcceptorAbstaining: c.node.Abstaining(),
	}
	for _, id := range c.view.keyIDs() {
		if c.node.TrustsPolicyKey(id) {
			report.TrustedPolicyKeyIds = append(report.TrustedPolicyKeyIds, id)
		}
	}
	for _, policyID := range c.view.policyIDs() {
		// Voters are per policy (A18): the relay votes only where the manifest
		// makes it the witness and shadow-accepts wherever it is a member.
		if version := c.node.ManifestVersion(policyID); version > 0 {
			manifest, _ := c.view.manifest(policyID)
			report.Manifests = append(report.Manifests, &relayv1.AvailabilityLeaseManifestAck{
				PolicyId: policyID, ManifestVersion: version, Closed: !c.node.LeaseMode(policyID),
				VoterEpoch: c.node.Epoch(policyID), Voter: manifest.voters[c.id], Member: manifest.members[c.id] != nil,
			})
		}
	}
	now, wall := c.clock.Now(), c.wall()
	for _, view := range c.node.AcceptorView() {
		gate := c.gateView(view.Key)
		var gateBallot *relayv1.AvailabilityLeaseBallot
		if ballot := gate.GetBallot(); ballot != nil {
			gateBallot = &relayv1.AvailabilityLeaseBallot{Round: ballot.GetRound(), Incarnation: ballot.GetIncarnation(), ProposerId: ballot.GetProposerId()}
		}
		entry := &relayv1.AvailabilityLeaseKeyView{
			PolicyId: view.Key.PolicyID, Slot: view.Key.Slot,
			State:    strings.ToLower(strings.TrimPrefix(view.State.String(), "LEASE_KEY_STATE_")),
			HolderId: view.Holder, ReservedFor: view.ReservedFor, Epoch: c.node.Epoch(view.Key.PolicyID),
			ManifestVersion: c.node.ManifestVersion(view.Key.PolicyID),
			GateOpen:        gate.GetOpen(), GateHolderId: gate.GetHolderId(), GateBallot: gateBallot,
			GateReason: gate.GetReason(), GateRemainingMs: gate.GetRemainingMs(), Abstaining: view.Abstaining,
		}
		if !view.Promised.IsZero() {
			entry.Promised = leaseBallot(view.Promised)
		}
		if !view.CommitBallot.IsZero() {
			entry.Committed = leaseBallot(view.CommitBallot)
			if view.CommitSince > 0 && view.CommitSince <= now {
				// The takeover time of the committed holder, as this relay saw it (N-5).
				entry.HolderSinceUnixMs = wall.Add(-(now - view.CommitSince)).UnixMilli()
			}
		}
		statefulView(entry, view)
		report.Acceptor = append(report.Acceptor, entry)
	}
	c.mu.Lock()
	for id := range c.streams {
		report.ConnectedMemberIds = append(report.ConnectedMemberIds, id)
	}
	if !c.lastFreezeWall.IsZero() {
		report.LastSuspendUnixMs = c.lastFreezeWall.UnixMilli()
		report.LastSuspendDurationMs = uint64(c.lastFreeze.Milliseconds())
	}
	c.mu.Unlock()
	sortStrings(report.ConnectedMemberIds)
	return report
}

// statefulView adds the summary of a stateful key (availability_lease_v3):
// whether this relay's memory of it is KNOWN, the ballot it last accepted
// and hashes of that state and of the latest commit's. The state itself is
// never reported or logged.
func statefulView(entry *relayv1.AvailabilityLeaseKeyView, view availabilitylease.KeyView) {
	if !view.Stateful {
		return
	}
	entry.Stateful, entry.StateKnown = true, view.StateKnown
	if view.StateKnown {
		entry.StateHash = availabilitylease.StateHashString(view.StateHash)
		entry.Accepted = leaseBallot(view.AcceptedBallot)
	}
	if view.CommitStateHash != ([32]byte{}) {
		entry.CommittedStateHash = availabilitylease.StateHashString(view.CommitStateHash)
	}
}

func leaseBallot(ballot availabilitylease.Ballot) *relayv1.AvailabilityLeaseBallot {
	return &relayv1.AvailabilityLeaseBallot{Round: ballot.Round, Incarnation: ballot.Incarnation, ProposerId: ballot.Proposer}
}
