package relaybridge

import (
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func targetCandidate(relayID string) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{RelayInstanceId: relayID, AssignmentGeneration: 1, Addresses: []string{"192.0.2.1"},
		Port: 9443, CertificateIdentity: relayID + ".test", CertificateFingerprint: "sha256:" + relayID,
		AssignmentState: "active", Capabilities: []string{PoolCapability}, Grant: &pb.RelaySignedGrant{KeyId: "k"}}
}

func TestRequiredTargetsIncludesTheRelaysOfLeaseGroupRoutes(t *testing.T) {
	bundle := &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{{
		Role: "connect", OwnerKind: "managed_database_binding", OwnerId: "binding-1", SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{targetCandidate("relay-a")},
		LeaseGroup: []*pb.RelayLeaseGroupRoute{
			{RouteId: "r-a", SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{targetCandidate("relay-a")}},
			{RouteId: "r-b", SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{targetCandidate("relay-b")}},
		},
	}}}
	targets := RequiredTargets(bundle)
	if len(targets) != 2 || targets[0].ID != "relay-a" || targets[1].ID != "relay-b" {
		t.Fatalf("targets = %+v, want relay-a and relay-b", targets)
	}
}
