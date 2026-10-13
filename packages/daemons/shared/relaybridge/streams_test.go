package relaybridge

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// The pool of the incident this file guards against: a local relay next to
// the app nodes, a near remote one and a far one that is nearly empty.
const (
	relayLocal = "relay-local"
	relayUK    = "relay-uk"
	relayNL    = "relay-nl"
)

var poolRTT = map[string]time.Duration{relayLocal: 700 * time.Microsecond, relayUK: 62 * time.Millisecond, relayNL: 298 * time.Millisecond}

func ownRTT(rtts map[string]time.Duration) func(string) (time.Duration, bool) {
	return func(id string) (time.Duration, bool) {
		rtt, ok := rtts[id]
		return rtt, ok
	}
}

// placed is a candidate of generation with Opfield's role and its relay's round trip to the endpoint (0: unknown).
func placed(relayID string, generation uint64, state, role string, endpointRTT time.Duration) *pb.RelayDataCandidate {
	candidate := &pb.RelayDataCandidate{RelayInstanceId: relayID, AssignmentGeneration: generation, AssignmentState: state,
		Capabilities: []string{PoolCapability}, Grant: &pb.RelaySignedGrant{KeyId: "k"}}
	if role != "" {
		candidate.Topology = &pb.RelayCandidateTopology{Role: role, EndpointRttMicros: uint32(endpointRTT.Microseconds())}
	}
	return candidate
}

func ids(candidates []*pb.RelayDataCandidate) []string {
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate.GetRelayInstanceId())
	}
	return result
}

func loads(active map[string]int64) map[string]TransportLoad {
	result := map[string]TransportLoad{}
	for id, count := range active {
		result[id] = TransportLoad{Available: true, Active: count}
	}
	return result
}

// The incident's load: local carries most tunnels, NL nearly none.
var incidentLoad = map[string]int64{relayLocal: 56, relayUK: 11, relayNL: 0}

func TestEmptyFarRelayNeverBeatsMeasuredNearerRelay(t *testing.T) {
	cases := []struct {
		name       string
		candidates []*pb.RelayDataCandidate
	}{
		{"measured paths", []*pb.RelayDataCandidate{
			placed(relayNL, 1, "active", RoleStandby, 298*time.Millisecond),
			placed(relayUK, 1, "active", RoleStandby, 62*time.Millisecond),
			placed(relayLocal, 1, "active", RolePrimary, 700*time.Microsecond),
		}},
		// The far relay just came back: Opfield has no endpoint round trip for it yet.
		{"far relay unknown", []*pb.RelayDataCandidate{
			placed(relayNL, 1, "active", RoleStandby, 0),
			placed(relayUK, 1, "active", RoleStandby, 62*time.Millisecond),
			placed(relayLocal, 1, "active", RolePrimary, 700*time.Microsecond),
		}},
		// Opfield placed the endpoint without latency data: no endpoint side at all.
		{"no endpoint side", []*pb.RelayDataCandidate{
			placed(relayNL, 1, "active", RolePrimary, 0),
			placed(relayUK, 1, "active", RolePrimary, 0),
			placed(relayLocal, 1, "active", RolePrimary, 0),
		}},
		// An older Opfield sent no topology for such an endpoint.
		{"no topology", []*pb.RelayDataCandidate{
			placed(relayNL, 1, "active", "", 0),
			placed(relayUK, 1, "active", "", 0),
			placed(relayLocal, 1, "active", "", 0),
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for rotation := range uint64(3) {
				got := ids(OrderCandidates(tc.candidates, loads(incidentLoad), rotation, ownRTT(poolRTT)))
				if got[0] != relayLocal || got[1] != relayUK || got[2] != relayNL {
					t.Fatalf("rotation %d: order %v, want local, UK, then the empty far relay", rotation, got)
				}
			}
		})
	}
}

// A relay whose distance is unknown comes after every measured relay of its
// role, however empty it is.
func TestUnknownRelayComesAfterMeasuredRelays(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed(relayNL, 1, "active", RoleStandby, 0),
		placed(relayUK, 1, "active", RoleStandby, 62*time.Millisecond),
	}
	rtts := map[string]time.Duration{relayUK: 62 * time.Millisecond} // this node never measured NL either
	got := ids(OrderCandidates(candidates, loads(map[string]int64{relayUK: 40, relayNL: 0}), 0, ownRTT(rtts)))
	if got[0] != relayUK {
		t.Fatalf("order %v: the unmeasured empty relay beat the measured one", got)
	}
}

// Load only splits equally near relays: two relays in one data center share
// tunnels by their counts.
func TestActiveTunnelsBreakTiesOnlyWithinATier(t *testing.T) {
	candidates := []*pb.RelayDataCandidate{
		placed("relay-dc-1", 1, "active", RolePrimary, time.Millisecond),
		placed("relay-dc-2", 1, "active", RolePrimary, 1500*time.Microsecond),
		placed(relayNL, 1, "active", RolePrimary, 298*time.Millisecond),
	}
	rtts := map[string]time.Duration{"relay-dc-1": time.Millisecond, "relay-dc-2": time.Millisecond, relayNL: 298 * time.Millisecond}
	got := ids(OrderCandidates(candidates, loads(map[string]int64{"relay-dc-1": 30, "relay-dc-2": 5, relayNL: 0}), 0, ownRTT(rtts)))
	if got[0] != "relay-dc-2" || got[1] != "relay-dc-1" || got[2] != relayNL {
		t.Fatalf("order %v: want the emptier of the near pair, the other, then the far relay", got)
	}
}

func TestPlaceStreamKeepsAStreamOnARelayThatStays(t *testing.T) {
	deadline := time.Now().Add(time.Minute).UnixMilli()
	draining := func(relayID string, generation uint64) *pb.RelayDataCandidate {
		candidate := placed(relayID, generation, "draining", RolePrimary, time.Millisecond)
		candidate.DrainDeadlineUnixMs = deadline
		return candidate
	}
	// Generation 2 replaced generation 1; local and UK stay, NL left.
	assignment := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{
		placed(relayLocal, 2, "active", RolePrimary, time.Millisecond),
		placed(relayUK, 2, "active", RoleStandby, 62*time.Millisecond),
		draining(relayLocal, 1), draining(relayUK, 1), draining(relayNL, 1),
	}}
	cases := []struct {
		name       string
		relay      string
		generation uint64
		want       StreamAction
		deadline   bool
	}{
		{"on the new generation", relayLocal, 2, StreamStays, false},
		{"old generation of a relay that stays", relayLocal, 1, StreamRegrants, true},
		{"old generation of the standby that stays", relayUK, 1, StreamRegrants, true},
		{"relay that left", relayNL, 1, StreamLeaves, true},
		{"generation unknown on a relay that stays", relayLocal, 0, StreamStays, false},
		{"retired generation of a relay that stays", relayLocal, 7, StreamRegrants, false},
		{"relay not assigned at all", "relay-other", 1, StreamLeaves, false},
	}
	for _, tc := range cases {
		action, at := PlaceStream(assignment, tc.relay, tc.generation)
		if action != tc.want || at.IsZero() == tc.deadline {
			t.Errorf("%s: action %d deadline %v, want %d (deadline %v)", tc.name, action, at, tc.want, tc.deadline)
		}
	}
	// A staging generation leaves the active one in place.
	staging := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{
		placed(relayLocal, 1, "active", RolePrimary, time.Millisecond), placed(relayLocal, 2, "staging", RolePrimary, time.Millisecond),
	}}
	if action, _ := PlaceStream(staging, relayLocal, 1); action != StreamStays {
		t.Fatalf("a staging generation moved the stream: %d", action)
	}
	// A relay drained as a whole has only draining candidates: the stream leaves it.
	drained := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{
		draining(relayNL, 1), draining(relayNL, 2), placed(relayLocal, 2, "active", RolePrimary, time.Millisecond),
	}}
	if action, _ := PlaceStream(drained, relayNL, 2); action != StreamLeaves {
		t.Fatalf("a stream stayed on a drained relay: %d", action)
	}
	if !RelayStays(assignment, relayLocal) || RelayStays(assignment, relayNL) || RelayStays(drained, relayNL) {
		t.Fatal("RelayStays disagrees with PlaceStream")
	}
}

// Stand 2.12 N-2: placement replaced a drained relay (NL) by another (UK) in generation 2. Generation 1 drains
// without a deadline (only a relay's own drain has one): the streams on the relays that stay keep their paths, only
// the streams on the relay that left move, and a stream whose generation is gone re-paths.
func TestPlacementDrainedGenerationKeepsStreamsOnRelaysThatStay(t *testing.T) {
	drained := func(relayID string, generation uint64) *pb.RelayDataCandidate {
		return placed(relayID, generation, "draining", RoleStandby, time.Millisecond)
	}
	assignment := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{
		placed(relayLocal, 2, "active", RolePrimary, time.Millisecond),
		placed(relayUK, 2, "active", RoleStandby, 62*time.Millisecond),
		drained(relayLocal, 1), drained(relayNL, 1),
	}}
	for _, tc := range []struct {
		name       string
		relay      string
		generation uint64
		want       StreamAction
	}{
		{"old generation on a relay that stays", relayLocal, 1, StreamStays},
		{"new generation", relayLocal, 2, StreamStays},
		{"the relay that was replaced", relayNL, 1, StreamLeaves},
		{"a generation that is gone, on a relay that stays", relayLocal, 7, StreamRegrants},
	} {
		if action, _ := PlaceStream(assignment, tc.relay, tc.generation); action != tc.want {
			t.Errorf("%s: action %d, want %d", tc.name, action, tc.want)
		}
	}
}

func TestReturnTargetPrefersTheNearestStableRelayWithHysteresis(t *testing.T) {
	pool := []*pb.RelayDataCandidate{
		placed(relayLocal, 1, "active", RolePrimary, 700*time.Microsecond),
		placed(relayUK, 1, "active", RoleStandby, 62*time.Millisecond),
		placed(relayNL, 1, "active", RoleStandby, 298*time.Millisecond),
	}
	all := loads(map[string]int64{relayLocal: 1, relayUK: 1, relayNL: 1})
	for _, from := range []string{relayUK, relayNL} {
		if target, ok := ReturnTarget(pool, all, ownRTT(poolRTT), from); !ok || target != relayLocal {
			t.Fatalf("a stream on %s returns to %q (%v), want the local primary", from, target, ok)
		}
	}
	if _, ok := ReturnTarget(pool, all, ownRTT(poolRTT), relayLocal); ok {
		t.Fatal("a stream on the nearest relay was moved")
	}
	// The primary is not stable (or not connected): nothing returns to it, but
	// a stream on the far standby still comes back to the near one.
	unstable := loads(map[string]int64{relayUK: 1, relayNL: 1})
	unstable[relayLocal] = TransportLoad{}
	if target, ok := ReturnTarget(pool, unstable, ownRTT(poolRTT), relayNL); !ok || target != relayUK {
		t.Fatalf("a stream on the far standby returns to %q (%v), want the near standby", target, ok)
	}
	if _, ok := ReturnTarget(pool, unstable, ownRTT(poolRTT), relayUK); ok {
		t.Fatal("a stream returned to a relay that is not available")
	}
	// A penalized primary is not a target either.
	penalized := loads(map[string]int64{relayUK: 1, relayNL: 1})
	penalized[relayLocal] = TransportLoad{Available: true, Penalized: true}
	if target, ok := ReturnTarget(pool, penalized, ownRTT(poolRTT), relayNL); ok && target == relayLocal {
		t.Fatal("a stream returned to a relay that fails the route")
	}

	// Same role: the far relay is beyond the band of the near one.
	primaries := []*pb.RelayDataCandidate{
		placed("relay-a", 1, "active", RolePrimary, 10*time.Millisecond),
		placed("relay-b", 1, "active", RolePrimary, 14*time.Millisecond),
		placed("relay-c", 1, "active", RolePrimary, 40*time.Millisecond),
	}
	rtts := ownRTT(map[string]time.Duration{"relay-a": 10 * time.Millisecond, "relay-b": 10 * time.Millisecond, "relay-c": 10 * time.Millisecond})
	three := loads(map[string]int64{"relay-a": 1, "relay-b": 9, "relay-c": 1})
	if target, ok := ReturnTarget(primaries, three, rtts, "relay-c"); !ok || target != "relay-a" {
		t.Fatalf("far primary: %q %v", target, ok)
	}
	// 24 ms against 20 ms: within the return band (and new tunnels' band), the stream stays.
	if _, ok := ReturnTarget(primaries, three, rtts, "relay-b"); ok {
		t.Fatal("a stream moved between relays of one tier")
	}
	// The current relay's distance is unknown, a primary's is measured: return.
	unknown := []*pb.RelayDataCandidate{placed("relay-a", 1, "active", RolePrimary, 10*time.Millisecond), placed("relay-x", 1, "active", RolePrimary, 0)}
	if target, ok := ReturnTarget(unknown, loads(map[string]int64{"relay-a": 5, "relay-x": 0}), rtts, "relay-x"); !ok || target != "relay-a" {
		t.Fatalf("unknown current relay: %q %v", target, ok)
	}
}

func TestRelayStabilityNeedsAnUnbrokenStreak(t *testing.T) {
	now := time.Unix(1000, 0)
	stability := &RelayStability{now: func() time.Time { return now }}
	stability.Observe(relayLocal, true)
	if stability.Stable(relayLocal, time.Minute) {
		t.Fatal("stable at once")
	}
	now = now.Add(time.Minute)
	stability.Observe(relayLocal, true)
	if !stability.Stable(relayLocal, time.Minute) {
		t.Fatal("not stable after a minute")
	}
	stability.Broke(relayLocal)
	stability.Observe(relayLocal, true)
	now = now.Add(30 * time.Second)
	if stability.Stable(relayLocal, time.Minute) {
		t.Fatal("a lane drop did not restart the streak")
	}
	stability.Observe(relayLocal, false)
	now = now.Add(time.Hour)
	if stability.Stable(relayLocal, time.Minute) {
		t.Fatal("a relay that is not connected is stable")
	}
	transports := StableTransports(map[string]TransportLoad{relayLocal: {Available: true}, relayUK: {Available: true}}, stability, relayUK)
	if transports[relayLocal].Available || !transports[relayUK].Available {
		t.Fatalf("stable transports %+v: the unstable relay must not count, the stream's own relay must", transports)
	}
}

func TestLatencyTrackerReportsHowLongARelayFails(t *testing.T) {
	now := time.Unix(1000, 0)
	tracker := NewLatencyTracker(func() time.Time { return now })
	tracker.Observe(relayNL, 298*time.Millisecond)
	tracker.Fail(relayNL)
	now = now.Add(20 * time.Second)
	tracker.Fail(relayNL) // the failure keeps its start
	samples := tracker.Samples()
	if len(samples) != 1 || samples[0].GetFailingMs() != 20000 || samples[0].GetRttMicros() != 298000 {
		t.Fatalf("samples %v", samples)
	}
	if rtt, ok := tracker.RTT(relayNL); !ok || rtt != 298*time.Millisecond {
		t.Fatalf("the measured distance was lost: %v %v", rtt, ok)
	}
	tracker.Reached(relayNL)
	if samples := tracker.Samples(); samples[0].GetFailingMs() != 0 {
		t.Fatalf("a reconnected relay still fails: %v", samples)
	}
	tracker.Fail(relayNL)
	now = now.Add(time.Second)
	tracker.Observe(relayNL, 298*time.Millisecond)
	if samples := tracker.Samples(); samples[0].GetFailingMs() != 0 {
		t.Fatalf("a measured relay still fails: %v", samples)
	}
}

// The rc.3 stand (F-1): the daemons stopped reporting a relay whose relay port
// was dead 2.5-3 minutes into the failure, once its last round trip aged out,
// and Opfield placed it again. A relay the daemon keeps failing to reach stays
// in the report, its round trip unknown once stale, until the daemon stops
// trying it or reaches it again.
func TestLatencyTrackerKeepsReportingARelayItCannotReach(t *testing.T) {
	now := time.Unix(1000, 0)
	tracker := NewLatencyTracker(func() time.Time { return now })
	tracker.Observe(relayNL, 298*time.Millisecond)
	tracker.Fail(relayNL)
	for range 20 { // ten minutes of probes every 30 s
		now = now.Add(LatencySampleInterval)
		tracker.Fail(relayNL)
	}
	samples := tracker.Samples()
	if len(samples) != 1 || samples[0].GetFailingMs() != 600000 || samples[0].GetRttMicros() != 0 {
		t.Fatalf("a relay failing for 10 minutes is reported as %v", samples)
	}
	if _, ok := tracker.RTT(relayNL); ok {
		t.Fatal("a round trip measured 10 minutes ago is still used")
	}
	// Reached again: reported as reached, with its next round trip.
	tracker.Observe(relayNL, 297*time.Millisecond)
	if samples := tracker.Samples(); len(samples) != 1 || samples[0].GetFailingMs() != 0 || samples[0].GetRttMicros() != 297000 {
		t.Fatalf("a relay reached again is reported as %v", samples)
	}

	// A relay never measured is reported failing, without a round trip.
	tracker.Fail(relayUK)
	now = now.Add(20 * time.Second)
	tracker.Fail(relayUK)
	if samples := tracker.Samples(); len(samples) != 2 || samples[1].GetRelayInstanceId() != relayUK ||
		samples[1].GetFailingMs() != 20000 || samples[1].GetRttMicros() != 0 {
		t.Fatalf("an unreachable relay never measured is reported as %v", samples)
	}
	// No longer tried (it left the assignments and the pool): it ages out.
	now = now.Add(latencyMaxAge + time.Second)
	tracker.Observe(relayNL, 297*time.Millisecond)
	if samples := tracker.Samples(); len(samples) != 1 || samples[0].GetRelayInstanceId() != relayNL {
		t.Fatalf("a relay the daemon stopped trying is still reported: %v", samples)
	}
}

func TestRegrantAtSpreadsBeforeTheDeadline(t *testing.T) {
	for range 50 {
		if at := RegrantAt(time.Time{}); at.Before(time.Now().Add(-time.Second)) || at.After(time.Now().Add(RegrantSpread)) {
			t.Fatalf("regrant at %v", at)
		}
		deadline := time.Now().Add(2 * time.Second)
		if at := RegrantAt(deadline); !at.Before(deadline) {
			t.Fatalf("regrant at %v, after the deadline %v", at, deadline)
		}
	}
}

// Stand rc.7 (F-3): streams came back to the local relay 60-100 s after it
// served again, a minute of it waiting for the relay to prove itself. A relay
// connected without a break for 20 s takes its streams back.
func TestARelayBackForTwentySecondsTakesItsStreamsBack(t *testing.T) {
	now := time.Unix(1000, 0)
	stability := &RelayStability{now: func() time.Time { return now }}
	stability.Observe(relayLocal, true)
	now = now.Add(20 * time.Second)
	stability.Observe(relayLocal, true)
	loads := map[string]TransportLoad{relayLocal: {Available: true}, relayUK: {Available: true}}
	if !StableTransports(loads, stability, relayUK)[relayLocal].Available {
		t.Fatalf("a relay connected for 20 s does not count for a return (ReturnStableFor %s)", ReturnStableFor)
	}
	now = now.Add(-time.Second)
	if StableTransports(loads, stability, relayUK)[relayLocal].Available {
		t.Fatal("a relay connected for 19 s counts for a return")
	}
}
