package broker

import (
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// DialRoute opens a tunnel with this relay itself as the origin, for the
// witness processes its supervisor runs (decision 10 of the availability set
// design). The caller is authenticated by the admin service. There is no
// grant: the signed policy's route, whose source is this relay instance, is
// the authorization, and the target endpoint's lease gate, session limits and
// admission apply as for any tunnel. The first frame names the route; data
// follows once the relay answers ready.
func (b *Broker) DialRoute(stream relayv1.RelayAdmin_DialRouteServer) error {
	first, err := recvFirst(stream.Context(), stream.Recv)
	if err != nil {
		return err
	}
	dial := first.GetDial()
	if dial == nil || dial.GetRouteId() == "" {
		return status.Error(codes.InvalidArgument, "first frame must name the route to dial")
	}
	return b.serveTunnel(stream, tunnelRequest{
		routeID: dial.GetRouteId(), assignmentGeneration: dial.GetAssignmentGeneration(), relayOrigin: true,
		policy: func() (*policy.Snapshot, error) {
			// Like a grant, a route is good only under a current policy.
			if err := b.store.AdmissionError(time.Now()); err != nil {
				return nil, status.Error(codes.Unavailable, err.Error())
			}
			return b.store.Current(), nil
		},
	})
}

// latestRouteAssignment is the highest assignment generation of routeID in a
// relay-scoped policy (schema 2), or 0 when the policy has no such
// assignment (a route without assignment scope is looked up by id alone).
func latestRouteAssignment(snapshot *policy.Snapshot, routeID string) uint64 {
	var latest uint64
	for _, route := range snapshot.RouteAssignments {
		if route.GetRouteId() == routeID && route.GetAssignmentGeneration() > latest {
			latest = route.GetAssignmentGeneration()
		}
	}
	return latest
}
