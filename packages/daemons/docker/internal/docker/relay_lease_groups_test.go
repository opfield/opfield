package docker

import (
	"context"
	"errors"
	"net"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const (
	testSetID    = "11111111-1111-4111-8111-111111111111"
	testMemberA  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	testMemberB  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	testDatabase = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

type fakeSetRuntime struct {
	known   bool
	serving map[string]bool
	peers   map[string]bool
	dialed  []string
}

func (f *fakeSetRuntime) MemberServing(setID, memberID string) (bool, bool) {
	return f.serving[setID+"/"+memberID], f.known
}

func (f *fakeSetRuntime) PeerServing(setID, memberID, port string) bool {
	return f.peers[setID+"/"+memberID+"/"+port]
}

func (f *fakeSetRuntime) DialPeer(_ context.Context, setID, memberID, port string) (net.Conn, error) {
	f.dialed = append(f.dialed, setID+"/"+memberID+"/"+port)
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

func setTarget(memberID, candidate string, rank uint32, port string, primary bool) *pb.RelayLeaseTarget {
	return &pb.RelayLeaseTarget{SetId: testSetID, MemberId: memberID, CandidateId: candidate, LeasePolicyId: "lease-1",
		Rank: rank, OwnerKind: "managed_database", OwnerId: testDatabase, PortName: port, PrimaryPort: primary}
}

func TestOrderSetRoutesPutsTheHolderFirstThenRank(t *testing.T) {
	routes := []*pb.RelayGrantAssignment{
		{RouteId: "r-a", LeaseTarget: setTarget(testMemberA, "node-a", 0, "", false)},
		{RouteId: "r-b", LeaseTarget: setTarget(testMemberB, "node-b", 1, "", false)},
	}
	if got := orderSetRoutes(routes, "node-b"); got[0].GetRouteId() != "r-b" || got[1].GetRouteId() != "r-a" {
		t.Fatalf("holder first: got %s, %s", got[0].GetRouteId(), got[1].GetRouteId())
	}
	if got := orderSetRoutes(routes, ""); got[0].GetRouteId() != "r-a" {
		t.Fatalf("rank order without a holder: got %s first", got[0].GetRouteId())
	}
}

func TestLeaseGroupMemberAssignmentKeepsTheGroupOwner(t *testing.T) {
	group := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: "managed_database_binding", OwnerId: "binding-1"}
	member := &pb.RelayLeaseGroupRoute{RouteId: "r-b", TargetEndpointId: "e-b", SchemaVersion: 2,
		Target: setTarget(testMemberB, "node-b", 1, "", false)}
	assignment := leaseGroupMemberAssignment(group, member)
	if assignment.GetOwnerKind() != "managed_database_binding" || assignment.GetOwnerId() != "binding-1" ||
		assignment.GetRouteId() != "r-b" || assignment.GetTargetEndpointId() != "e-b" || assignment.GetSchemaVersion() != 2 ||
		assignment.GetLeaseTarget().GetMemberId() != testMemberB {
		t.Fatalf("member assignment = %+v", assignment)
	}
}

func TestParseSetPeerAlias(t *testing.T) {
	if alias, ok := parseSetPeerAlias("primary-pg-repl"); !ok || !alias.primary || alias.memberID != "" || alias.port != "pg-repl" {
		t.Fatalf("primary alias: %+v %v", alias, ok)
	}
	if alias, ok := parseSetPeerAlias("member-" + testMemberB + "-ch-keeper"); !ok || alias.primary ||
		alias.memberID != testMemberB || alias.port != "ch-keeper" {
		t.Fatalf("member alias: %+v %v", alias, ok)
	}
	if alias, ok := parseSetPeerAlias("witness-" + testMemberA + "-ch-keeper"); !ok || alias.witnessID != testMemberA ||
		alias.memberID != "" || alias.port != "ch-keeper" {
		t.Fatalf("witness alias: %+v %v", alias, ok)
	}
	for _, value := range []string{"", "primary-", "member-short-ch-keeper", "member-" + testMemberB, "member-" + testMemberB + "-", "replica-pg-repl"} {
		if _, ok := parseSetPeerAlias(value); ok {
			t.Fatalf("alias %q must not parse", value)
		}
	}
}

func TestSetPeerRoutesSelectsByAlias(t *testing.T) {
	plugin := &DockerPlugin{relayGrants: &relayGrantStore{current: &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{
		{Role: "connect", OwnerKind: setPeerRouteKind, OwnerId: "a>b:pg-repl", LeaseTarget: setTarget(testMemberB, "node-b", 1, "pg-repl", true)},
		{Role: "connect", OwnerKind: setPeerRouteKind, OwnerId: "a>b:ch-keeper", LeaseTarget: setTarget(testMemberB, "node-b", 1, "ch-keeper", false)},
		{Role: "connect", OwnerKind: setWitnessRouteKind, OwnerId: "a>w", LeaseTarget: &pb.RelayLeaseTarget{SetId: testSetID, PortName: "ch-keeper", WitnessId: testMemberA}},
		{Role: "connect", OwnerKind: "managed_database_binding", OwnerId: "binding-1"},
	}}}}
	if routes := plugin.setPeerRoutes(testSetID, "witness-"+testMemberA+"-ch-keeper"); len(routes) != 1 || routes[0].GetOwnerId() != "a>w" {
		t.Fatalf("witness alias routes = %v", routes)
	}
	if routes := plugin.setPeerRoutes(testSetID, "primary-pg-repl"); len(routes) != 1 || routes[0].GetOwnerId() != "a>b:pg-repl" {
		t.Fatalf("primary-pg-repl routes = %v", routes)
	}
	if routes := plugin.setPeerRoutes(testSetID, "member-"+testMemberB+"-ch-keeper"); len(routes) != 1 || routes[0].GetOwnerId() != "a>b:ch-keeper" {
		t.Fatalf("member alias routes = %v", routes)
	}
	if routes := plugin.setPeerRoutes(testSetID, "primary-ch-keeper"); len(routes) != 0 {
		t.Fatalf("a non-primary port has no primary alias, got %v", routes)
	}
	if routes := plugin.setPeerRoutes("other-set", "primary-pg-repl"); len(routes) != 0 {
		t.Fatalf("another set's routes must not match, got %v", routes)
	}
}

func TestSetEndpointStateFollowsTheMemberRuntime(t *testing.T) {
	plugin := &DockerPlugin{}
	resource := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: "managed_database", OwnerId: testDatabase,
		LeaseTarget: setTarget(testMemberA, "node-a", 0, "", false)}
	member := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: setClientEndpointKind, OwnerId: testMemberA,
		LeaseTarget: setTarget(testMemberA, "node-a", 0, "", false)}
	peer := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: setPeerEndpointKind, OwnerId: testMemberA + ":pg-repl",
		LeaseTarget: setTarget(testMemberA, "node-a", 0, "pg-repl", true)}
	plain := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: "managed_database", OwnerId: testDatabase}
	// No member runtime: the resource endpoint serves as a single-node one, a member's own endpoint does not.
	unspecified := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
	dormant := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
	serving := relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
	if got := plugin.setEndpointState(plain); got != unspecified {
		t.Fatalf("plain endpoint = %v", got)
	}
	if got := plugin.setEndpointState(resource); got != unspecified {
		t.Fatalf("resource endpoint without runtime = %v", got)
	}
	if got := plugin.setEndpointState(member); got != dormant {
		t.Fatalf("member endpoint without runtime = %v", got)
	}
	if got := plugin.setEndpointState(peer); got != dormant {
		t.Fatalf("peer endpoint without runtime = %v", got)
	}
	runtime := &fakeSetRuntime{known: true, serving: map[string]bool{}, peers: map[string]bool{testSetID + "/" + testMemberA + "/pg-repl": true}}
	plugin.SetSetMemberRuntime(runtime)
	if got := plugin.setEndpointState(resource); got != dormant {
		t.Fatalf("a copy's resource endpoint = %v", got)
	}
	runtime.serving[testSetID+"/"+testMemberA] = true
	if got := plugin.setEndpointState(resource); got != serving {
		t.Fatalf("the serving member's resource endpoint = %v", got)
	}
	if got := plugin.setEndpointState(member); got != serving {
		t.Fatalf("the serving member's endpoint = %v", got)
	}
	if got := plugin.setEndpointState(peer); got != serving {
		t.Fatalf("a peer port that takes traffic = %v", got)
	}
}

func TestDialSetEndpointRefusesAMemberThatDoesNotServe(t *testing.T) {
	runtime := &fakeSetRuntime{known: true, serving: map[string]bool{}, peers: map[string]bool{}}
	plugin := &DockerPlugin{}
	plugin.SetSetMemberRuntime(runtime)
	router := &relayTunnelRouter{plugin: plugin}
	member := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: setClientEndpointKind, OwnerId: testMemberA,
		LeaseTarget: setTarget(testMemberA, "node-a", 0, "", false)}
	if _, err := router.dialSetEndpoint(context.Background(), member); !errors.Is(err, errSetMemberNotServing) {
		t.Fatalf("dial of a copy = %v", err)
	}
	peer := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: setPeerEndpointKind, OwnerId: testMemberA + ":ch-keeper",
		LeaseTarget: setTarget(testMemberA, "node-a", 0, "ch-keeper", false)}
	if _, err := router.dialSetEndpoint(context.Background(), peer); !errors.Is(err, errSetMemberNotServing) {
		t.Fatalf("dial of a closed peer port = %v", err)
	}
	runtime.peers[testSetID+"/"+testMemberA+"/ch-keeper"] = true
	dialed, err := router.dialSetEndpoint(context.Background(), peer)
	if err != nil {
		t.Fatalf("dial of an open peer port: %v", err)
	}
	_ = dialed.conn.Close()
	if len(runtime.dialed) != 1 || runtime.dialed[0] != testSetID+"/"+testMemberA+"/ch-keeper" {
		t.Fatalf("dialed = %v", runtime.dialed)
	}
}
