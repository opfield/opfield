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

// A demoted relay that is the last candidate of retrying opens is probed at a
// bounded rate for what it refused (stand 2.12 R-3: right after a policy
// snapshot the only other relay did not serve the endpoints yet, and every
// new connection's retries and every moving stream's attempts went back to
// the demoted relay, 905 refusals in 20 s). The opens held back count as its
// refusal without reaching it and change nothing; the database tunnels it
// still admits always go and do not end the demotion.
func TestDemotedRelayIsProbedAtABoundedRate(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	refusal := status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: database_reserve")
	penalties.Opened(nil, "relay-local", "proxy_host_secure_link/link-1", refusal)

	// 20 s of opens every 20 ms over eight proxy routes, the relay refusing each that reaches it.
	reached := 0
	for step := range 1000 {
		route := fmt.Sprintf("proxy_host_secure_link/link-%d", step%8+1)
		if err := penalties.HoldDemoted("relay-local", route); err != nil {
			if _, ok := admissionPressureState(err); !ok || status.Code(err) != codes.ResourceExhausted {
				t.Fatalf("held open answered %v, not the relay's admission refusal", err)
			}
			penalties.Opened(nil, "relay-local", route, err)
		} else {
			reached++
			penalties.Opened(nil, "relay-local", route, refusal)
		}
		now = now.Add(20 * time.Millisecond)
	}
	// Each route reaches it once before its class is known, then one probe a second.
	if reached > 7+21 {
		t.Fatalf("the demoted relay took %d of 1000 opens", reached)
	}
	if reached < 20 {
		t.Fatalf("the demoted relay was probed only %d times in 20 s", reached)
	}
	if !penalties.Demoted("relay-local") {
		t.Fatal("the demotion ran out early")
	}

	// A database tunnel, which the relay still admits, always goes and keeps the demotion.
	for range 50 {
		if err := penalties.HoldDemoted("relay-local", "container_link/db-1"); err != nil {
			t.Fatalf("a database open was held back: %v", err)
		}
		penalties.Opened(nil, "relay-local", "container_link/db-1", nil)
	}
	if !penalties.Demoted("relay-local") {
		t.Fatal("a database tunnel ended the demotion for proxy tunnels")
	}
	// A route the relay refused, once a probe gets through, ends it.
	now = now.Add(demotedProbeInterval)
	if err := penalties.HoldDemoted("relay-local", "proxy_host_secure_link/link-3"); err != nil {
		t.Fatalf("no probe after %s: %v", demotedProbeInterval, err)
	}
	penalties.Opened(nil, "relay-local", "proxy_host_secure_link/link-3", nil)
	if penalties.Demoted("relay-local") {
		t.Fatal("an admitted probe did not end the demotion")
	}
	if err := penalties.HoldDemoted("relay-local", "proxy_host_secure_link/link-4"); err != nil {
		t.Fatalf("a relay that admits again still holds opens back: %v", err)
	}
}

// A fair-share refusal refuses some routes and admits others: only the routes
// it refused are paced, each on its own.
func TestFairShareDemotionPacesOnlyTheRefusedRoutes(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	penalties.Opened(nil, "relay-a", "route-1", pressureRefusal("fair_share"))
	if err := penalties.HoldDemoted("relay-a", "route-1"); err == nil {
		t.Fatal("a route refused for its fair share was sent again at once")
	}
	if err := penalties.HoldDemoted("relay-a", "route-2"); err != nil {
		t.Fatalf("a route the relay did not refuse was held back: %v", err)
	}
	penalties.Opened(nil, "relay-a", "route-2", pressureRefusal("fair_share"))
	now = now.Add(demotedProbeInterval)
	if err := penalties.HoldDemoted("relay-a", "route-1"); err != nil {
		t.Fatalf("route-1 got no probe after %s: %v", demotedProbeInterval, err)
	}
	if err := penalties.HoldDemoted("relay-a", "route-1"); err == nil {
		t.Fatal("two probes of one route in one interval")
	}
	if err := penalties.HoldDemoted("relay-a", "route-2"); err != nil {
		t.Fatalf("route-2 shared route-1's probe: %v", err)
	}
	// Once the demotion ran out nothing is held back.
	now = now.Add(demotionInitial)
	if err := penalties.HoldDemoted("relay-a", "route-1"); err != nil {
		t.Fatalf("held back after the demotion ran out: %v", err)
	}
}

// An open HoldDemoted held back, passed to Opened like the relay's answer,
// neither lengthens the demotion nor ends it.
func TestHeldOpensDoNotLengthenOrEndTheDemotion(t *testing.T) {
	now := time.Unix(1000, 0)
	penalties := &RelayPenalties{now: func() time.Time { return now }}
	penalties.Opened(nil, "relay-a", "route-1", pressureRefusal("hard_pressure"))
	held := penalties.HoldDemoted("relay-a", "route-1")
	if held == nil {
		t.Fatal("no open held back right after the refusal")
	}
	now = now.Add(demotionInitial - time.Second)
	penalties.Opened(nil, "relay-a", "route-1", held)
	now = now.Add(2 * time.Second)
	if penalties.Demoted("relay-a") {
		t.Fatal("a held-back open lengthened the demotion")
	}
	if err := penalties.HoldDemoted("relay-a", "route-1"); err != nil {
		t.Fatalf("held back after the demotion ran out: %v", err)
	}
}
