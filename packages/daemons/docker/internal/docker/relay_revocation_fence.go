package docker

import (
	"context"

	"github.com/opfield/opfield/daemon-shared/logepisode"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// acceptedRelayTunnel is one endpoint tunnel a relay delivered. It is tracked
// so a revocation fence that arrives later also closes it: a stale relay would
// otherwise keep a revoked route's long-lived stream open indefinitely.
type acceptedRelayTunnel struct {
	relayInstanceID string
	endpointID      string
	route           *relayv1.IncomingTunnelRoute
	cancel          context.CancelFunc
	// done closes once the tunnel ended and left the accepted set.
	done chan struct{}
}

// assignmentRelayInstanceID names the relay behind a projected endpoint
// registration. The legacy local router serves the local relay's candidate
// under its own target ID, so the candidate is authoritative when present.
func assignmentRelayInstanceID(assignment *pb.RelayGrantAssignment, targetID string) string {
	if candidates := assignment.GetCandidates(); len(candidates) == 1 && candidates[0].GetRelayInstanceId() != "" {
		return candidates[0].GetRelayInstanceId()
	}
	return targetID
}

// admitIncoming registers an incoming tunnel for fence enforcement and
// reports why it must be refused, if it must. Registering before checking
// closes the gap where a fence lands between the check and the registration.
func (r *relayTunnelRouter) admitIncoming(assignment *pb.RelayGrantAssignment, incoming *relayv1.IncomingTunnel, cancel context.CancelFunc) (release func(), refusal string) {
	tunnel := &acceptedRelayTunnel{
		relayInstanceID: assignmentRelayInstanceID(assignment, r.targetID),
		endpointID:      assignment.GetEndpointId(),
		route:           incoming.GetRoute(),
		cancel:          cancel,
		done:            make(chan struct{}),
	}
	r.mu.Lock()
	if r.accepted == nil {
		r.accepted = map[*acceptedRelayTunnel]struct{}{}
	}
	r.accepted[tunnel] = struct{}{}
	r.mu.Unlock()
	release = func() {
		r.mu.Lock()
		delete(r.accepted, tunnel)
		r.mu.Unlock()
		close(tunnel.done)
	}
	r.plugin.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		refusal = relaybridge.RevocationRefusal(bundle, tunnel.relayInstanceID, tunnel.endpointID, tunnel.route)
	})
	if refusal != "" {
		release()
		attrs := []any{"relay_instance_id", tunnel.relayInstanceID, "endpoint_id", tunnel.endpointID,
			"route_id", tunnel.route.GetRouteId(), "route_generation", tunnel.route.GetRouteGeneration(),
			"source_kind", tunnel.route.GetSourceKind(), "source_id", tunnel.route.GetSourceId(), "reason", refusal}
		// A source that keeps opening a revoked route is refused per request: reported per owner, apart from the
		// endpoint's other failures so a failing endpoint does not hide it, and summarised while it goes on (L-1).
		r.plugin.logger.Debug("relay endpoint tunnel refused", attrs...)
		r.plugin.relayTunnelOutcomes.Failed(r.plugin.logger,
			logepisode.Subject{Name: "relay endpoint tunnels on revoked routes", IDAttr: "owner_id", ID: assignment.GetOwnerId()}, attrs...)
		return nil, refusal
	}
	return release, ""
}

// enforceRevocationFences closes accepted tunnels the bundle now refuses.
func (r *relayTunnelRouter) enforceRevocationFences(bundle *pb.SyncRelayGrantsCommand) {
	if len(bundle.GetRevocationFences()) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for tunnel := range r.accepted {
		refusal := relaybridge.RevocationRefusal(bundle, tunnel.relayInstanceID, tunnel.endpointID, tunnel.route)
		if refusal == "" {
			continue
		}
		tunnel.cancel()
		r.plugin.logger.Warn("relay endpoint tunnel closed", "relay_instance_id", tunnel.relayInstanceID, "endpoint_id", tunnel.endpointID,
			"route_id", tunnel.route.GetRouteId(), "reason", refusal)
	}
}
