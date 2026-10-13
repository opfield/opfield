package docker

import (
	"encoding/json"
	"strings"

	"github.com/opfield/opfield/daemon-shared/availabilitylease"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/lease"
)

const errLeaseRuntimeUnavailable = "availability lease runtime is not running on this node"

// handleAvailabilityLeaseSync adopts T3's lease distribution: policy keys
// delivered over this authenticated stream are trusted directly, rotation
// links and signed blocks are verified by the protocol node (A4, A14). The
// applied revision and the persisted acks travel in the next heartbeat.
func (p *DockerPlugin) handleAvailabilityLeaseSync(cmd *pb.SyncAvailabilityLeaseCommand, result *pb.CommandResult) {
	if p.lease == nil || p.lease.runtime == nil {
		result.Success, result.Error = false, errLeaseRuntimeUnavailable
		return
	}
	keys := make([]lease.PolicyKey, 0, len(cmd.GetPolicyKeys()))
	for _, key := range cmd.GetPolicyKeys() {
		keys = append(keys, lease.PolicyKey{ID: key.GetKeyId(), PublicKey: key.GetPublicKey()})
	}
	// voter_config is obsolete: every manifest carries its policy's voters
	// (A18). A non-empty value from an older Opfield is ignored.
	update, err := lease.DecodeBlockUpdate(cmd.GetRevision(), cmd.GetMemberId(), keys, cmd.GetKeyRotations(), cmd.GetManifests())
	if err == nil {
		err = p.lease.runtime.ApplyLeaseBlocks(update)
	}
	if err != nil {
		result.Success, result.Error = false, err.Error()
		return
	}
	// Policies may have entered or left lease mode: re-gate endpoints.
	p.reconcileRelayRegistrations()
	detail, _ := json.Marshal(map[string]uint64{"leaseRevision": cmd.GetRevision()})
	result.Detail = string(detail)
}

// handleAvailabilityLeaseHandoff starts a planned handoff on the holder (D9,
// A6). The outcome is reported as a handoff or fence event.
func (p *DockerPlugin) handleAvailabilityLeaseHandoff(cmd *pb.AvailabilityLeaseHandoffCommand, result *pb.CommandResult) {
	if p.lease == nil || p.lease.runtime == nil {
		result.Success, result.Error = false, errLeaseRuntimeUnavailable
		return
	}
	err := p.lease.runtime.Handoff(lease.Handoff{
		PolicyID: cmd.GetPolicyId(), Slot: cmd.GetSlot(), SuccessorID: cmd.GetSuccessorId(), OperationID: cmd.GetOperationId(),
		SuccessorGeneration: cmd.GetSuccessorGeneration(), ManifestVersion: cmd.GetManifestVersion(),
	})
	if err != nil {
		result.Success, result.Error = false, err.Error()
		return
	}
	detail, _ := json.Marshal(map[string]any{"accepted": true, "policyId": cmd.GetPolicyId(), "slot": cmd.GetSlot()})
	result.Detail = string(detail)
}

// availabilityLeaseReport fills HealthReport.availability_lease. Events are
// drained, so it is called once per health report.
func (p *DockerPlugin) availabilityLeaseReport() *pb.AvailabilityLeaseReport {
	if p.lease == nil || p.lease.runtime == nil {
		return nil
	}
	var identity []byte
	if p.lease.identity != nil {
		identity = p.lease.identity()
	}
	return leaseReportProto(p.lease.runtime.Report(), identity)
}

func leaseReportProto(report lease.Report, identity []byte) *pb.AvailabilityLeaseReport {
	out := &pb.AvailabilityLeaseReport{
		// The top-level epoch is not used with per-policy voters (A18):
		// each manifest ack and acceptor view carries its policy's epoch.
		MemberId: report.MemberID, IdentityPublicKey: identity, Incarnation: report.Incarnation,
		TrustedPolicyKeyIds: report.TrustedPolicyKeyIDs, AcceptorAbstaining: report.AcceptorAbstaining,
		WatchdogReady: report.WatchdogReady, LeaseRevision: report.LeaseRevision,
		ReportedAtUnixMs: report.ReportedAtUnixMs,
	}
	for _, manifest := range report.Manifests {
		out.Manifests = append(out.Manifests, &pb.AvailabilityLeaseManifestAck{PolicyId: manifest.PolicyID, ManifestVersion: manifest.Version, Closed: manifest.Closed})
	}
	for _, held := range report.Held {
		out.Held = append(out.Held, &pb.AvailabilityLeaseHeld{
			PolicyId: held.Key.PolicyID, Slot: held.Key.Slot, Role: held.Role, Ballot: leaseBallotProto(held.Ballot),
			Epoch: held.Epoch, ManifestVersion: held.ManifestVersion,
			PlacementId: held.PlacementID, PlacementGeneration: held.PlacementGeneration, Retained: held.Retained,
			HeldSinceUnixMs: held.SinceUnixMs,
		})
	}
	for _, view := range report.Acceptor {
		out.Acceptor = append(out.Acceptor, &pb.AvailabilityLeaseKeyView{
			PolicyId: view.Key.PolicyID, Slot: view.Key.Slot,
			State:    strings.ToLower(strings.TrimPrefix(view.State.String(), "LEASE_KEY_STATE_")),
			HolderId: view.Holder, ReservedFor: view.ReservedFor,
			Promised: leaseBallotProto(view.Promised), Committed: leaseBallotProto(view.CommitBallot),
			Epoch: view.VoterEpoch, ManifestVersion: view.ManifestVersion, HolderSinceUnixMs: view.HolderSinceUnixMs,
		})
	}
	for _, event := range report.Events {
		out.Events = append(out.Events, &pb.AvailabilityLeaseEvent{
			Kind: event.Kind, PolicyId: event.Key.PolicyID, Slot: event.Key.Slot, Ballot: leaseBallotProto(event.Ballot),
			SuccessorId: event.Successor, Reason: event.Reason, AtUnixMs: event.AtUnixMs,
		})
	}
	return out
}

func leaseBallotProto(ballot availabilitylease.Ballot) *pb.AvailabilityLeaseBallot {
	if ballot.IsZero() {
		return nil
	}
	return &pb.AvailabilityLeaseBallot{Round: ballot.Round, Incarnation: ballot.Incarnation, ProposerId: ballot.Proposer}
}
