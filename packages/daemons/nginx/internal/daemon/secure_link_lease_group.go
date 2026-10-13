package daemon

import (
	"sort"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
)

// managedAvailabilityRoutesCapability: this daemon opens the lease groups of
// database and storage availability sets. A link to a set's resource (a
// managed storage published through a proxy host) has one route per member;
// Opfield sends them as the assignment's lease group. While the set's lease
// runs the relays admit only the primary's route, so the others are refused
// in one round trip; a manual pair's group has only its primary's route.
const managedAvailabilityRoutesCapability = "managed_availability_routes_v1"

// leaseGroupCandidates are the relay candidates of every member route of the
// assignment's lease group, in the members' rank order (nil without a group:
// the assignment's own route applies). Each candidate carries the grant of its
// own route.
func leaseGroupCandidates(assignment *pb.RelayGrantAssignment) []*pb.RelayDataCandidate {
	group := append([]*pb.RelayLeaseGroupRoute(nil), assignment.GetLeaseGroup()...)
	if len(group) == 0 {
		return nil
	}
	sort.SliceStable(group, func(i, j int) bool {
		left, right := group[i].GetTarget(), group[j].GetTarget()
		if left.GetRank() != right.GetRank() {
			return left.GetRank() < right.GetRank()
		}
		return left.GetMemberId() < right.GetMemberId()
	})
	var result []*pb.RelayDataCandidate
	for _, member := range group {
		result = append(result, relaybridge.PoolCandidates(&pb.RelayGrantAssignment{
			Role: assignment.GetRole(), OwnerKind: assignment.GetOwnerKind(), OwnerId: assignment.GetOwnerId(),
			RouteId: member.GetRouteId(), TargetEndpointId: member.GetTargetEndpointId(), Grant: member.GetGrant(),
			Candidates: member.GetCandidates(), SchemaVersion: member.GetSchemaVersion(),
		}, false)...)
	}
	return result
}
