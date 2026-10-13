package relaybridge

import (
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

// A relay that did not acknowledge a revoking policy in time may still admit
// the revoked routes; Opfield fences it per endpoint. The relay is trusted to
// name the route it admitted, only not to hold current policy.
const (
	RefusalRevokedRoute = "route was revoked and the relay has not acknowledged the revocation"
	RefusalUnnamedRoute = "relay missed a revocation for this endpoint and does not name the route of its tunnels"
)

// RevocationFences returns the fences for one endpoint through one relay.
func RevocationFences(bundle *pb.SyncRelayGrantsCommand, relayInstanceID, endpointID string) []*pb.RelayRevocationFence {
	if relayInstanceID == "" || endpointID == "" {
		return nil
	}
	var result []*pb.RelayRevocationFence
	for _, fence := range bundle.GetRevocationFences() {
		if fence.GetRelayInstanceId() == relayInstanceID && fence.GetEndpointId() == endpointID {
			result = append(result, fence)
		}
	}
	return result
}

// RevocationRefusal reports why an endpoint must refuse a tunnel the relay
// admitted for route, or "" to accept it. Without a fence for this relay and
// endpoint every tunnel is accepted, including from relays that name no route.
func RevocationRefusal(bundle *pb.SyncRelayGrantsCommand, relayInstanceID, endpointID string, route *relayv1.IncomingTunnelRoute) string {
	fences := RevocationFences(bundle, relayInstanceID, endpointID)
	if len(fences) == 0 {
		return ""
	}
	if route.GetRouteId() == "" {
		return RefusalUnnamedRoute
	}
	for _, fence := range fences {
		for _, revoked := range fence.GetRoutes() {
			if revoked.GetRouteId() != route.GetRouteId() {
				continue
			}
			// Generation 0: the route no longer targets this endpoint at all.
			if allowed := revoked.GetAllowedGeneration(); allowed == 0 || allowed != route.GetRouteGeneration() {
				return RefusalRevokedRoute
			}
		}
	}
	return ""
}
