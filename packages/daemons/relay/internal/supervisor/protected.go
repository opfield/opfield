package supervisor

import (
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// RelayProtectedWitnessAllowedCapability tells Gateway that the owner of a
// protected relay allows database availability witness processes on it
// (protected.allow_database_witness). A protected relay without it must not
// get one.
const RelayProtectedWitnessAllowedCapability = "relay_protected_witness_allowed_v1"

// localServiceSubjectKind is the policy endpoint kind of a built-in local
// service (the internal registry next to the Gateway). Only the local relay
// serves one; a remote relay would dial its fixed name on its own host's
// network.
const localServiceSubjectKind = "local_service"

const protectedLocalServiceRefusal = "refused: this relay runs in protected mode and does not serve built-in local services, which only the local relay serves"

// ProtectedMode reports whether the relay's owner turned protected mode on in
// the local config (lifecycle.ProtectedModePlugin).
func (p *Plugin) ProtectedMode() bool { return p.cfg.Protected.Enabled }

// ProtectedCommandAllowed lists the relay commands a protected relay runs:
// its signed policy, drain, signed worker update, identity renewal and its
// own route counters. Each of them is relay operation, none reaches the host.
func (p *Plugin) ProtectedCommandAllowed(cmd *pb.GatewayCommand) bool {
	switch cmd.GetPayload().(type) {
	case *pb.GatewayCommand_SyncRelayPolicy,
		*pb.GatewayCommand_SetRelayDrain,
		*pb.GatewayCommand_UpdateRelayWorker,
		*pb.GatewayCommand_RenewRelayIdentity,
		*pb.GatewayCommand_GetRelayRouteRuntime:
		return true
	}
	return false
}

// protectedCapabilities are the markers the relay adds to its registration
// and runtime status in protected mode (the shared lifecycle adds
// lifecycle.NodeProtectedCapability to the registration itself).
func (p *Plugin) protectedCapabilities() []string {
	if !p.cfg.Protected.Enabled {
		return nil
	}
	values := []string{lifecycle.NodeProtectedCapability}
	if p.cfg.Protected.AllowDatabaseWitness {
		values = append(values, RelayProtectedWitnessAllowedCapability)
	}
	return values
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
