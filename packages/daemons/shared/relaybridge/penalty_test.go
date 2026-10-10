package relaybridge

import (
	"fmt"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A relay that failed a route is tried after the other relay of its role until
// the penalty runs out or it succeeds; another route is not affected.
func TestPenalizedRelayComesAfterTheOthersOfItsRole(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	candidates := []*pb.RelayDataCandidate{{RelayInstanceId: "relay-a"}, {RelayInstanceId: "relay-b"}}
	order := func(route string) string {
		transports := map[string]TransportLoad{}
		for _, candidate := range candidates {
			id := candidate.GetRelayInstanceId()
			transports[id] = TransportLoad{Available: true, Penalized: penalties.Penalized(id, route)}
		}
		return OrderCandidates(candidates, transports, 0, nil)[0].GetRelayInstanceId()
	}
	if first := order("route-1"); first != "relay-a" {
		t.Fatalf("first relay %s before any failure", first)
	}
	penalties.Failed("relay-a", "route-1")
	if first := order("route-1"); first != "relay-b" {
		t.Fatalf("penalized relay still first: %s", first)
	}
	if first := order("route-2"); first != "relay-a" {
		t.Fatalf("another route followed the penalty: %s", first)
	}
	now = now.Add(penaltyInitial + time.Second)
	if first := order("route-1"); first != "relay-a" {
		t.Fatalf("penalty did not run out: %s", first)
	}
	// A failure right after the penalty ran out doubles it.
	penalties.Failed("relay-a", "route-1")
	now = now.Add(penaltyInitial + time.Second)
	if !penalties.Penalized("relay-a", "route-1") {
		t.Fatal("a repeated failure was not penalized longer")
	}
	penalties.Succeeded("relay-a", "route-1")
	if penalties.Penalized("relay-a", "route-1") {
		t.Fatal("a success did not clear the penalty")
	}
}

func pressureRefusal(state string) error {
	return status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: "+state)
}

// A relay that refused a tunnel for its admission pressure comes after every
// other connected relay for every route (a standby too) for 30 s; a refusal on
// the first open after that doubles it up to 5 min, and its first successful
// open forgets it. A demoted relay that is the only candidate, or a stream's
// own relay on a planned move, is still used.
func TestAdmissionRefusalDemotesTheRelayForNewTunnels(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	candidates := []*pb.RelayDataCandidate{
		{RelayInstanceId: "relay-a"},
		{RelayInstanceId: "relay-b", Topology: &pb.RelayCandidateTopology{Role: RoleStandby}},
	}
	order := func(route string, candidates []*pb.RelayDataCandidate, staying string) string {
		transports := map[string]TransportLoad{}
		for _, candidate := range candidates {
			id := candidate.GetRelayInstanceId()
			transports[id] = TransportLoad{Available: true, Penalized: penalties.Penalized(id, route), Demoted: penalties.Demoted(id)}
		}
		return OrderCandidates(candidates, KeepStaying(transports, staying), 0, nil)[0].GetRelayInstanceId()
	}
	if first := order("route-1", candidates, ""); first != "relay-a" {
		t.Fatalf("first relay %s before any refusal", first)
	}

	penalties.Opened(nil, "relay-a", "route-1", pressureRefusal("database_reserve"))
	for _, route := range []string{"route-1", "route-2"} {
		if first := order(route, candidates, ""); first != "relay-b" {
			t.Fatalf("%s: demoted relay still first: %s", route, first)
		}
	}
	if penalties.Penalized("relay-a", "route-1") {
		t.Fatal("an admission refusal penalized the route instead of demoting the relay")
	}
	if first := order("route-1", candidates[:1], ""); first != "relay-a" {
		t.Fatalf("the only candidate was not used: %s", first)
	}
	if first := order("route-1", candidates, "relay-a"); first != "relay-a" {
		t.Fatalf("a stream's planned move did not keep its own demoted relay first: %s", first)
	}
	// Refusals while demoted (opens in flight) do not lengthen it.
	now = now.Add(20 * time.Second)
	penalties.Opened(nil, "relay-a", "route-2", pressureRefusal("fair_share"))
	now = now.Add(11 * time.Second)
	if penalties.Demoted("relay-a") {
		t.Fatal("the demotion did not run out after 30 s")
	}
	if first := order("route-1", candidates, ""); first != "relay-a" {
		t.Fatalf("the relay did not recover after the demotion: %s", first)
	}

	// Each refusal on the first open after the demotion ran out doubles it, up to 5 min.
	for _, want := range []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute} {
		penalties.Opened(nil, "relay-a", "route-1", pressureRefusal("hard_pressure"))
		now = now.Add(want - time.Second)
		if !penalties.Demoted("relay-a") {
			t.Fatalf("demotion shorter than %s", want)
		}
		now = now.Add(2 * time.Second)
		if penalties.Demoted("relay-a") {
			t.Fatalf("demotion longer than %s", want)
		}
	}

	// A successful open (any route) forgets it: the next refusal demotes for 30 s again.
	penalties.Opened(nil, "relay-a", "route-2", nil)
	penalties.Opened(nil, "relay-a", "route-1", pressureRefusal("fair_share"))
	now = now.Add(demotionInitial + time.Second)
	if penalties.Demoted("relay-a") {
		t.Fatal("a success did not reset the demotion")
	}
}

// A session-cap refusal (the route's or endpoint's limit, the same on every
// relay) and other capacity errors neither demote the relay nor penalize the route.
func TestSessionCapRefusalDoesNotDemoteTheRelay(t *testing.T) {
	penalties := &RelayPenalties{}
	for _, err := range []error{
		status.Error(codes.ResourceExhausted, "relay route session capacity reached"),
		status.Error(codes.ResourceExhausted, "relay endpoint session capacity reached"),
		status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: unknown_traffic_class"),
		status.Error(codes.ResourceExhausted, "grpc: received message larger than max"),
		status.Error(codes.PermissionDenied, "relay adaptive admission rejected proxy tunnel: hard_pressure"),
	} {
		penalties.Opened(nil, "relay-a", "route-1", err)
		if penalties.Demoted("relay-a") {
			t.Fatalf("%v demoted the relay", err)
		}
		if status.Code(err) == codes.ResourceExhausted && penalties.Penalized("relay-a", "route-1") {
			t.Fatalf("%v penalized the route", err)
		}
	}
	wrapped := fmt.Errorf("open source tunnel: %w", pressureRefusal("hard_pressure"))
	if _, ok := admissionPressureState(wrapped); !ok {
		t.Fatal("a wrapped admission refusal was not recognized")
	}
}
