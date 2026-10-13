package relaybridge

import (
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

func fencedBundle() *pb.SyncRelayGrantsCommand {
	return &pb.SyncRelayGrantsCommand{RevocationFences: []*pb.RelayRevocationFence{{
		RelayInstanceId: "stale-relay",
		EndpointId:      "endpoint-1",
		Routes: []*pb.RelayRevokedRoute{
			{RouteId: "deleted-route", AllowedGeneration: 0},
			{RouteId: "narrowed-route", AllowedGeneration: 4},
		},
	}}}
}

func incomingRoute(id string, generation uint64) *relayv1.IncomingTunnelRoute {
	return &relayv1.IncomingTunnelRoute{RouteId: id, RouteGeneration: generation, SourceKind: "daemon", SourceId: "node"}
}

func TestRevocationRefusalAcceptsEverythingWithoutAFence(t *testing.T) {
	bundle := fencedBundle()
	cases := []struct {
		relay, endpoint string
		route           *relayv1.IncomingTunnelRoute
	}{
		// A relay that acknowledged in time carries no fence, even for revoked routes.
		{"current-relay", "endpoint-1", incomingRoute("deleted-route", 3)},
		// The fence belongs to one endpoint only.
		{"stale-relay", "endpoint-2", incomingRoute("deleted-route", 3)},
		// Relays built before IncomingTunnel named routes behave as before when not fenced.
		{"current-relay", "endpoint-1", nil},
	}
	for _, tc := range cases {
		if refusal := RevocationRefusal(bundle, tc.relay, tc.endpoint, tc.route); refusal != "" {
			t.Fatalf("%s/%s refused: %s", tc.relay, tc.endpoint, refusal)
		}
	}
	if refusal := RevocationRefusal(&pb.SyncRelayGrantsCommand{}, "stale-relay", "endpoint-1", nil); refusal != "" {
		t.Fatalf("unfenced bundle refused: %s", refusal)
	}
}

func TestRevocationRefusalRefusesOnlyRevokedRoutesThroughAStaleRelay(t *testing.T) {
	bundle := fencedBundle()
	if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-1", incomingRoute("deleted-route", 3)); refusal != RefusalRevokedRoute {
		t.Fatalf("deleted route refusal = %q", refusal)
	}
	// The route still exists at generation 4; the stale relay admitted the revoked generation 3.
	if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-1", incomingRoute("narrowed-route", 3)); refusal != RefusalRevokedRoute {
		t.Fatalf("revoked generation refusal = %q", refusal)
	}
	if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-1", incomingRoute("narrowed-route", 4)); refusal != "" {
		t.Fatalf("current generation refused: %s", refusal)
	}
	// Other routes through the same stale relay keep working.
	if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-1", incomingRoute("other-route", 1)); refusal != "" {
		t.Fatalf("unrevoked route refused: %s", refusal)
	}
}

func TestRevocationRefusalFailsClosedForAStaleRelayThatNamesNoRoute(t *testing.T) {
	bundle := fencedBundle()
	for _, route := range []*relayv1.IncomingTunnelRoute{nil, {}} {
		if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-1", route); refusal != RefusalUnnamedRoute {
			t.Fatalf("unnamed route refusal = %q", refusal)
		}
	}
	// Fail-closed is limited to the fenced endpoint.
	if refusal := RevocationRefusal(bundle, "stale-relay", "endpoint-2", nil); refusal != "" {
		t.Fatalf("unfenced endpoint refused: %s", refusal)
	}
}
