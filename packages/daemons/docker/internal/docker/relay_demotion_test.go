package docker

import (
	"testing"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// answerAt makes relay answer every source open with err at once (nil: serve them again).
func answerAt(relay *miniRelay, err error) {
	if err == nil {
		relay.hold.Store(nil)
		return
	}
	release := make(chan struct{})
	close(release)
	relay.hold.Store(&openHold{release: release, err: err})
}

// Stand 2.12 R-3: the local relay refuses new proxy tunnels for its pressure, and a policy snapshot retires the
// streams' generation while the only other relays do not serve the endpoint under the new one yet. The demotion
// survives the snapshot, and the streams re-pathing (onto their relay under the new grant, or to another) reach the
// demoted relay about once a second instead of on every attempt; once another relay serves, new connections go there,
// not to the demoted relay.
func TestSnapshotDuringDemotionKeepsItAndPacesTheDemotedRelay(t *testing.T) {
	pair := newPoolPair(t)
	_, sessions := pair.openStreams(6)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 6})

	answerAt(pair.relays[poolLocal], status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: database_reserve"))
	_, demoting := pair.open()
	if demoting.router.targetID != poolUK {
		t.Fatalf("the connection the local relay refused went to %s, want the near standby", demoting.router.targetID)
	}
	if !pair.source.relayPenalties.Demoted(poolLocal) {
		t.Fatal("the refusal did not demote the local relay")
	}

	notRegistered := status.Error(codes.Unavailable, "target endpoint is not registered")
	answerAt(pair.relays[poolUK], notRegistered)
	answerAt(pair.relays[poolNL], notRegistered)
	pair.relays[poolLocal].opens.Store(0)
	started := time.Now()
	pair.apply(2, generation(2, "active", poolLocal, poolUK, poolNL))
	time.Sleep(8 * time.Second)
	reached := pair.relays[poolLocal].opens.Load()
	// Unpaced, each of the seven streams tried the local relay on every attempt (backoff 250 ms doubling to 2 s):
	// about 35 opens in these 8 s. Paced: one per second, plus slack for a slow host.
	if limit := int64(time.Since(started)/time.Second) + 3; reached > limit {
		t.Fatalf("the demoted relay took %d opens in %s, want at most %d", reached, time.Since(started).Round(time.Second), limit)
	}
	if reached == 0 {
		t.Fatal("the demoted relay was never probed")
	}
	if !pair.source.relayPenalties.Demoted(poolLocal) {
		t.Fatal("the snapshot ended the demotion")
	}

	answerAt(pair.relays[poolUK], nil)
	_, next := pair.open()
	if next.router.targetID != poolUK {
		t.Fatalf("a new connection went to %s while the local relay is demoted, want the near standby", next.router.targetID)
	}
}

// Stand 2.12 N-1: a staged generation probes every source on every relay of it. A source probe the local relay
// refused for its pressure was retried every 100 ms for 10 s (two probes per daemon at a time): most of the 1,170
// refusals in 21 s. The refusal comes after the grant, route, endpoint and registration checks, so it proves what
// the probe verifies: one open, and the probe is done.
func TestSourceProbeOfARelayUnderPressureOpensOnce(t *testing.T) {
	pair := newPoolPair(t)
	answerAt(pair.relays[poolLocal], status.Error(codes.ResourceExhausted, "relay adaptive admission rejected proxy tunnel: database_reserve"))
	pair.relays[poolLocal].opens.Store(0)
	var local *pb.RelayDataCandidate
	for _, candidate := range pair.source.relayGrants.lookup("connect", pair.kinds.connect, testLinkID).GetCandidates() {
		if candidate.GetRelayInstanceId() == poolLocal {
			local = candidate
		}
	}
	if local == nil {
		t.Fatal("no local relay candidate")
	}
	started := time.Now()
	if _, err := pair.source.ProbeRelayCandidate(&pb.ProbeRelayCandidateCommand{ProbeId: "probe-1", Role: "source",
		RouteId: testRouteID, AssignmentGeneration: local.GetAssignmentGeneration(), Candidate: local}); err != nil {
		t.Fatalf("probe of a relay under pressure failed: %v", err)
	}
	if opens := pair.relays[poolLocal].opens.Load(); opens != 1 || time.Since(started) > 2*time.Second {
		t.Fatalf("probe opened %d tunnels in %s, want one at once", opens, time.Since(started).Round(time.Millisecond))
	}
	// A refusal that proves nothing still fails the probe.
	answerAt(pair.relays[poolLocal], status.Error(codes.PermissionDenied, "connect grant route was revoked"))
	if _, err := pair.source.ProbeRelayCandidate(&pb.ProbeRelayCandidateCommand{ProbeId: "probe-2", Role: "source",
		RouteId: testRouteID, AssignmentGeneration: local.GetAssignmentGeneration(), Candidate: local}); err == nil {
		t.Fatal("a probe the relay refused for its grant passed")
	}
}
