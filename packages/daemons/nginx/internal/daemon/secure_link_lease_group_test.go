package daemon

import (
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relaybridge"
)

func leaseGroupTestCandidate(relay, route string) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{RelayInstanceId: relay, AssignmentGeneration: 1, AssignmentState: "active",
		Capabilities: []string{relaybridge.PoolCapability}, Grant: &pb.RelaySignedGrant{Payload: []byte(route)}}
}

func TestLeaseGroupCandidatesFollowTheMembersRank(t *testing.T) {
	assignment := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: "proxy_secure_link", OwnerId: "link", SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{leaseGroupTestCandidate("r1", "rank0-legacy")},
		LeaseGroup: []*pb.RelayLeaseGroupRoute{
			{RouteId: "b", SchemaVersion: 2, Target: &pb.RelayLeaseTarget{Rank: 1, MemberId: "m-b"},
				Candidates: []*pb.RelayDataCandidate{leaseGroupTestCandidate("r1", "b"), leaseGroupTestCandidate("r2", "b")}},
			{RouteId: "a", SchemaVersion: 2, Target: &pb.RelayLeaseTarget{Rank: 0, MemberId: "m-a"},
				Candidates: []*pb.RelayDataCandidate{leaseGroupTestCandidate("r1", "a")}},
		}}
	candidates := leaseGroupCandidates(assignment)
	if len(candidates) != 3 {
		t.Fatalf("every member route's candidates: got %d", len(candidates))
	}
	var routes []string
	for _, candidate := range candidates {
		routes = append(routes, string(candidate.GetGrant().GetPayload()))
	}
	if routes[0] != "a" || routes[1] != "b" || routes[2] != "b" {
		t.Fatalf("rank order with each route's own grant: %v", routes)
	}
	if leaseGroupCandidates(&pb.RelayGrantAssignment{SchemaVersion: 2}) != nil {
		t.Fatal("without a group the assignment's own route applies")
	}
}
