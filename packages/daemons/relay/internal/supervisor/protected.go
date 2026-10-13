package supervisor

import (
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaylocal"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// RelayProtectedWitnessAllowedCapability tells Opfield that the owner of a
// protected relay allows database availability witness processes on it
// (protected.allow_database_witness). A protected relay without it must not
// get one.
const RelayProtectedWitnessAllowedCapability = "relay_protected_witness_allowed_v1"

// localServiceSubjectKind is the policy endpoint kind of a built-in local
// service (the internal registry next to Opfield). Only the local relay
// serves one; a remote relay would dial its fixed name on its own host's
// network.
const localServiceSubjectKind = "local_service"

const protectedRelayLocalRefusal = "refused: this relay runs in protected mode without the owner's database witness opt-in and does not serve relay-local endpoints"

const protectedLocalServiceRefusal = "refused: this relay runs in protected mode and does not serve built-in local services, which only the local relay serves"

// ProtectedMode reports whether the relay's owner turned protected mode on in
// the local config (lifecycle.ProtectedModePlugin).
func (p *Plugin) ProtectedMode() bool { return p.cfg.Protected.Enabled }

// ProtectedCommandAllowed lists the relay commands a protected relay runs:
// its signed policy, drain, signed worker update, identity renewal and its
// own route counters. Each of them is relay operation, none reaches the host.
func (p *Plugin) ProtectedCommandAllowed(cmd *pb.OpfieldCommand) bool {
	switch cmd.GetPayload().(type) {
	case *pb.OpfieldCommand_SyncRelayPolicy,
		*pb.OpfieldCommand_SetRelayDrain,
		*pb.OpfieldCommand_UpdateRelayWorker,
		*pb.OpfieldCommand_RenewRelayIdentity,
		*pb.OpfieldCommand_GetRelayRouteRuntime:
		return true
	case *pb.OpfieldCommand_ApplyWitnesses:
		// Witness processes only with the owner's opt-in.
		return p.cfg.Protected.AllowDatabaseWitness
	}
	return false
}

// protectedCapabilities are the markers the relay adds to its runtime status
// in protected mode.
func (p *Plugin) protectedCapabilities() []string {
	if !p.cfg.Protected.Enabled {
		return nil
	}
	return append([]string{lifecycle.NodeProtectedCapability}, p.protectedRegistrationCapabilities()...)
}

// protectedRegistrationCapabilities are the markers the relay adds to its
// registration in protected mode. The shared lifecycle adds
// lifecycle.NodeProtectedCapability (and the disabled host access markers) to
// every registration of a protected node itself, so the relay does not list
// it again.
func (p *Plugin) protectedRegistrationCapabilities() []string {
	if !p.cfg.Protected.Enabled || !p.cfg.Protected.AllowDatabaseWitness {
		return nil
	}
	return []string{RelayProtectedWitnessAllowedCapability}
}

// protectedPolicyRefusal returns why a protected relay refuses a policy, or
// "". A policy naming a built-in local service is refused: the worker would
// dial that service's fixed name on the host's network.
func (p *Plugin) protectedPolicyRefusal(encoded []byte) string {
	if !p.cfg.Protected.Enabled {
		return ""
	}
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(encoded, request); err != nil {
		// The worker reports the decode failure.
		return ""
	}
	endpoints := request.GetEndpoints()
	if envelope := request.GetSignedEnvelope(); envelope != nil {
		payload := &relayv1.PolicyEnvelopePayload{}
		if err := proto.Unmarshal(envelope.GetPayload(), payload); err != nil {
			return ""
		}
		endpoints = append(endpoints, payload.GetEndpoints()...)
	}
	for _, endpoint := range endpoints {
		if endpoint.GetSubjectKind() == localServiceSubjectKind {
			return protectedLocalServiceRefusal
		}
		if endpoint.GetSubjectKind() == relaylocal.SubjectKind && !p.cfg.Protected.AllowDatabaseWitness {
			// A relay-local endpoint reaches a witness on this host.
			return protectedRelayLocalRefusal
		}
	}
	return ""
}

// protectedWorkerUpdateRefusal returns why a protected relay refuses a worker
// update to target, or "". The worker accepts only the same or a newer
// release than it runs; a worker whose version is not known (it does not
// answer) may get any signed release, which is how a broken worker recovers.
func (p *Plugin) protectedWorkerUpdateRefusal(target string) string {
	if !p.cfg.Protected.Enabled {
		return ""
	}
	p.mu.RLock()
	running := ""
	if p.last != nil {
		running = p.last.GetBuildVersion()
	}
	p.mu.RUnlock()
	if running == "" {
		return lifecycle.ProtectedUpdateRefusal(target, target)
	}
	return lifecycle.ProtectedUpdateRefusal(running, target)
}
