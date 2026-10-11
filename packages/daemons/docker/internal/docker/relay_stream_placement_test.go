package docker

import (
	"context"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
)

// A pool like the one of the relay-placement incident: a local relay next to
// the nodes (0.7 ms), a near remote relay (62 ms) and a far one (298 ms) that
// carries nearly nothing.
const (
	poolLocal = "relay-local"
	poolUK    = "relay-uk"
	poolNL    = "relay-nl"
)

var poolDistance = map[string]time.Duration{poolLocal: 700 * time.Microsecond, poolUK: 62 * time.Millisecond, poolNL: 298 * time.Millisecond}

// poolCandidate is one relay of one assignment generation in a test bundle.
type poolCandidate struct {
	relay      string
	generation uint64
	state      string
}

func poolRole(relay string) string {
	if relay == poolLocal {
		return relaybridge.RolePrimary
	}
	return relaybridge.RoleStandby
}

// poolBundles builds the source and target bundles of the test route from candidates, each with Gateway's role and
// the relay's round trip to the endpoint.
func poolBundles(revision uint64, candidates ...poolCandidate) (*pb.SyncRelayGrantsCommand, *pb.SyncRelayGrantsCommand) {
	var connectCandidates, endpointCandidates []*pb.RelayDataCandidate
	for _, spec := range candidates {
		build := func(grantKey string) *pb.RelayDataCandidate {
			candidate := candidateFor(spec.relay, spec.state, 0, grantKey)
			candidate.AssignmentGeneration = spec.generation
			candidate.Topology = &pb.RelayCandidateTopology{Role: poolRole(spec.relay), EndpointRttMicros: uint32(poolDistance[spec.relay].Microseconds())}
			return candidate
		}
		connectCandidates = append(connectCandidates, build("route:"+testRouteID))
		endpointCandidates = append(endpointCandidates, build(testEndpointID))
	}
	connect := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: containerLinkRoute.connect, OwnerId: testLinkID, RouteId: testRouteID,
		TargetEndpointId: testEndpointID, SchemaVersion: 2, Candidates: connectCandidates,
		Grant:        &pb.RelaySignedGrant{KeyId: "route:" + testRouteID, Payload: []byte("{}"), Signature: []byte("s")},
		StreamResume: &pb.RelayStreamResume{Version: 1, KeyId: "v1", Key: testResumeKey}}
	endpoint := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: containerLinkRoute.endpoint, OwnerId: testLinkID, EndpointId: testEndpointID,
		SchemaVersion: 2, Candidates: endpointCandidates, Grant: &pb.RelaySignedGrant{KeyId: testEndpointID, Payload: []byte("{}"), Signature: []byte("s")},
		ResumeRoutes: []*pb.RelayRouteResume{{RouteId: testRouteID, Version: 1, KeyId: "v1", Key: testResumeKey}}}
	now := time.Now().UnixMilli()
	return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, GeneratedAtUnixMs: now, Grants: []*pb.RelayGrantAssignment{connect}},
		&pb.SyncRelayGrantsCommand{PolicyRevision: revision, GeneratedAtUnixMs: now, Grants: []*pb.RelayGrantAssignment{endpoint}}
}

// generation is every relay of relays in one generation and state.
func generation(number uint64, state string, relays ...string) []poolCandidate {
	result := make([]poolCandidate, 0, len(relays))
	for _, relay := range relays {
		result = append(result, poolCandidate{relay: relay, generation: number, state: state})
	}
	return result
}

func candidates(generations ...[]poolCandidate) []poolCandidate {
	var result []poolCandidate
	for _, g := range generations {
		result = append(result, g...)
	}
	return result
}

// newPoolPair is a source and a target daemon joined by the three relays; the source measured them as poolDistance.
func newPoolPair(t *testing.T) *streamPair {
	t.Helper()
	previous := relayStreamReturnInterval
	// The tests drive their own return passes.
	relayStreamReturnInterval = time.Hour
	t.Cleanup(func() { relayStreamReturnInterval = previous })
	pair := &streamPair{t: t, kinds: containerLinkRoute, relays: map[string]*miniRelay{}, cancels: map[*DockerPlugin]map[string]context.CancelFunc{}}
	routes := map[string]string{testRouteID: testEndpointID}
	for _, id := range []string{poolLocal, poolUK, poolNL} {
		pair.relays[id] = startMiniRelay(t, id, routes)
	}
	backend := listenBackend(t)
	pair.backend = backend
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buffer := make([]byte, 32*1024)
				for {
					n, err := conn.Read(buffer)
					if n > 0 {
						if _, werr := conn.Write(buffer[:n]); werr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	source, target := poolBundles(1, generation(1, "active", poolLocal, poolUK, poolNL)...)
	pair.source = pair.newDaemon(source)
	pair.source.relayRTT = func(relay string) (time.Duration, bool) {
		distance, ok := poolDistance[relay]
		return distance, ok
	}
	pair.target = pair.newDaemon(target)
	pair.target.endpointDialer = func(ctx context.Context, _ *pb.RelayGrantAssignment) (dialedEndpoint, error) {
		pair.dials.Add(1)
		conn, err := dialBackend(ctx, backend)
		return dialedEndpoint{conn: conn}, err
	}
	for id := range pair.relays {
		pair.connect(pair.target, id)
		pair.connect(pair.source, id)
	}
	waitFor(t, "the pool to come up", func() bool {
		for id, relay := range pair.relays {
			relay.mu.Lock()
			_, registered := relay.targets[testEndpointID]
			relay.mu.Unlock()
			router := pair.source.relayRouter(id)
			if !registered || router == nil || !router.connected() {
				return false
			}
		}
		return true
	})
	return pair
}

// apply delivers one revision of the placement to both daemons, the target first as Gateway's grant sync does.
func (pair *streamPair) apply(revision uint64, placement ...[]poolCandidate) {
	pair.t.Helper()
	source, target := poolBundles(revision, candidates(placement...)...)
	if _, err := pair.target.SyncRelayGrants(target); err != nil {
		pair.t.Fatal(err)
	}
	if _, err := pair.source.SyncRelayGrants(source); err != nil {
		pair.t.Fatal(err)
	}
}

// openStreams opens count resumable streams and checks each echoes.
func (pair *streamPair) openStreams(count int) ([]net.Conn, []*relayresume.Session) {
	pair.t.Helper()
	var apps []net.Conn
	var sessions []*relayresume.Session
	for range count {
		app, tunnel := pair.open()
		if tunnel.session == nil {
			pair.t.Fatal("stream is not resumable")
		}
		waitFor(pair.t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
		echoOnce(pair.t, app)
		apps = append(apps, app)
		sessions = append(sessions, tunnel.session)
	}
	return apps, sessions
}

// echoOnce sends a short message and reads it back.
func echoOnce(t *testing.T, app net.Conn) {
	t.Helper()
	message := []byte("ping")
	if _, err := app.Write(message); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, len(message))
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadFull(app, reply); err != nil || string(reply) != string(message) {
		t.Fatalf("echo %q: %v", reply, err)
	}
	_ = app.SetReadDeadline(time.Time{})
}

// placement counts the streams per relay and generation.
func placement(sessions []*relayresume.Session) map[string]int {
	result := map[string]int{}
	for _, session := range sessions {
		relay, generation, ok := session.CurrentPath()
		if !ok {
			result["suspended"]++
			continue
		}
		result[fmt.Sprintf("%s/%d", relay, generation)]++
	}
	return result
}

func waitPlacement(t *testing.T, sessions []*relayresume.Session, want map[string]int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		got := placement(sessions)
		if fmt.Sprint(got) == fmt.Sprint(want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("streams on %v, want %v", placement(sessions), want)
}

// The incident: a rebalance stages a new generation on the same three relays. Every stream on the local relay, which
// stays the nearest primary, stays there under the new grant; none goes to the empty far relay, the old generation's
// tunnels end, and a bundle sent again moves nothing more.
func TestGenerationChangeKeepsStreamsOnTheNearestRelay(t *testing.T) {
	pair := newPoolPair(t)
	apps, sessions := pair.openStreams(4)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 4})

	// Staging changes nothing; activation drains generation 1 on every relay while all three stay.
	pair.apply(2, generation(1, "active", poolLocal, poolUK, poolNL), generation(2, "staging", poolLocal, poolUK, poolNL))
	time.Sleep(200 * time.Millisecond)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 4})
	pair.apply(3, generation(2, "active", poolLocal, poolUK, poolNL), generation(1, "draining", poolLocal, poolUK, poolNL))
	waitPlacement(t, sessions, map[string]int{poolLocal + "/2": 4})
	waitFor(t, "the old generation's tunnels to end", func() bool { return pair.relays[poolLocal].activeTunnels() == 4 })
	if pair.relays[poolUK].activeTunnels() != 0 || pair.relays[poolNL].activeTunnels() != 0 {
		t.Fatalf("tunnels on the remote relays: UK %d, NL %d", pair.relays[poolUK].activeTunnels(), pair.relays[poolNL].activeTunnels())
	}
	moves := pair.source.relayStreamStats().GetMigrationsOkTotal()
	if moves != 4 {
		t.Fatalf("%d moves, want one re-path per stream", moves)
	}
	// Gateway sends bundles again while generation 1 drains: nothing moves.
	pair.apply(4, generation(2, "active", poolLocal, poolUK, poolNL), generation(1, "draining", poolLocal, poolUK, poolNL))
	pair.apply(5, generation(2, "active", poolLocal, poolUK, poolNL), generation(1, "draining", poolLocal, poolUK, poolNL))
	time.Sleep(time.Second)
	if got := pair.source.relayStreamStats().GetMigrationsOkTotal(); got != moves {
		t.Fatalf("bundles sent again moved streams: %d moves after %d", got, moves)
	}
	for _, app := range apps {
		echoOnce(t, app)
	}
	if pair.dials.Load() != 4 {
		t.Fatalf("backend dialed %d times for 4 streams", pair.dials.Load())
	}
}

// The far relay's control stream flaps, an operator drains it and resumes it: each step is a new generation, and
// every stream ends on the local relay.
func TestFarRelayDrainAndResumeLeaveStreamsOnTheLocalRelay(t *testing.T) {
	pair := newPoolPair(t)
	apps, sessions := pair.openStreams(4)
	steps := []struct {
		name      string
		placement [][]poolCandidate
	}{
		// The far relay left placement (its control stream ended) and came back: two generations.
		{"far relay gone", [][]poolCandidate{generation(2, "active", poolLocal, poolUK), generation(1, "draining", poolLocal, poolUK, poolNL)}},
		{"far relay back", [][]poolCandidate{generation(3, "active", poolLocal, poolUK, poolNL), generation(2, "draining", poolLocal, poolUK)}},
		// Drained by the operator: every candidate of it drains, the evacuation's generation leaves it out.
		{"drain staged", [][]poolCandidate{generation(3, "draining", poolNL), generation(3, "active", poolLocal, poolUK), generation(4, "staging", poolLocal, poolUK)}},
		{"drained", [][]poolCandidate{generation(4, "active", poolLocal, poolUK), generation(3, "draining", poolLocal, poolUK, poolNL)}},
		{"resumed", [][]poolCandidate{generation(5, "active", poolLocal, poolUK, poolNL), generation(4, "draining", poolLocal, poolUK)}},
	}
	want := uint64(1)
	for index, step := range steps {
		pair.apply(uint64(index+2), step.placement...)
		for _, g := range step.placement {
			for _, candidate := range g {
				if candidate.relay == poolLocal && candidate.state == "active" {
					want = candidate.generation
				}
			}
		}
		waitPlacement(t, sessions, map[string]int{fmt.Sprintf("%s/%d", poolLocal, want): 4})
		if pair.relays[poolNL].activeTunnels() != 0 || pair.relays[poolUK].activeTunnels() != 0 {
			t.Fatalf("%s: tunnels on UK %d, NL %d", step.name, pair.relays[poolUK].activeTunnels(), pair.relays[poolNL].activeTunnels())
		}
	}
	for _, app := range apps {
		echoOnce(t, app)
	}
}

// Streams that left the local relay (it failed their tunnels) go to the near standby, not the empty far one, and
// come back to the local relay once it has been stable for a while: a bounded number per pass, through planned
// moves, without a new backend dial.
func TestStreamsReturnToTheNearestRelayOnceItIsStable(t *testing.T) {
	previousStable := relaybridge.ReturnStableFor
	relaybridge.ReturnStableFor = 300 * time.Millisecond
	t.Cleanup(func() { relaybridge.ReturnStableFor = previousStable })
	pair := newPoolPair(t)
	apps, sessions := pair.openStreams(5)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 5})

	local := pair.relays[poolLocal]
	local.forceDisconnect()
	waitPlacement(t, sessions, map[string]int{poolUK + "/1": 5})
	if pair.relays[poolNL].activeTunnels() != 0 {
		t.Fatal("a stream went to the empty far relay")
	}

	// The local relay serves again; the route's penalty for it runs out.
	local.draining.Store(false)
	pair.source.relayPenalties.Succeeded(poolLocal, relayRouteKey(containerLinkRoute.connect, testLinkID))
	returner := &relayresume.Returner{Manager: pair.source.relayStreams().sources, Interval: 100 * time.Millisecond, Batch: 2,
		Cooldown: time.Millisecond, Nearer: pair.source.relayStreamNearer, Prepare: pair.source.observeRelayStability}
	// Its transport stayed up through the failure, but a lane drop restarts its streak.
	pair.source.relayStability.Broke(poolLocal)
	if moved := returner.Pass(); moved != 0 {
		t.Fatalf("%d streams moved to a relay that was not stable yet", moved)
	}
	time.Sleep(relaybridge.ReturnStableFor + 50*time.Millisecond)
	if moved := returner.Pass(); moved != 2 {
		t.Fatalf("a pass moved %d streams, want the batch of 2", moved)
	}
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 2, poolUK + "/1": 3})
	deadline := time.Now().Add(15 * time.Second)
	for placement(sessions)[poolLocal+"/1"] < 5 && time.Now().Before(deadline) {
		if moved := returner.Pass(); moved > 2 {
			t.Fatalf("a pass moved %d streams", moved)
		}
		time.Sleep(150 * time.Millisecond)
	}
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 5})
	// On the nearest relay nothing moves any more.
	if moved := returner.Pass(); moved != 0 {
		t.Fatalf("a pass moved %d streams off the nearest relay", moved)
	}
	for _, app := range apps {
		echoOnce(t, app)
	}
	if pair.dials.Load() != 5 {
		t.Fatalf("backend dialed %d times for 5 streams", pair.dials.Load())
	}
}

// A target that still sends drain hints for a relay that stays in the assignment (a daemon before this fix) does
// not push the stream off it: the source moves to the best path of its own assignment, which is where it is.
func TestDrainHintForARelayThatStaysMovesNothing(t *testing.T) {
	pair := newPoolPair(t)
	apps, sessions := pair.openStreams(2)
	pair.target.relayStreams().targets.RequestMigrate(poolLocal, relayresume.MigrateDrain)
	time.Sleep(time.Second)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 2})
	if got := pair.source.relayStreamStats().GetMigrationsOkTotal(); got != 0 {
		t.Fatalf("%d streams moved on a drain hint for a relay that stays", got)
	}
	for _, app := range apps {
		echoOnce(t, app)
	}
}

// Stand 2.12 R-5: draining and resuming a relay that carries none of the streams moves none of them. Gateway keeps the
// drained relay in the active generation, draining there, instead of placing every workload on a new generation
// without it (and on another one with it once resumed), which re-pathed every stream onto a new grant twice.
func TestDrainAndResumeOfAnEmptyRelayMoveNothing(t *testing.T) {
	pair := newPoolPair(t)
	apps, sessions := pair.openStreams(4)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 4})

	// NL drains: its candidates drain within generation 1.
	pair.apply(2, generation(1, "active", poolLocal, poolUK), generation(1, "draining", poolNL))
	time.Sleep(time.Second)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 4})
	// NL is resumed: generation 1 as before.
	pair.apply(3, generation(1, "active", poolLocal, poolUK, poolNL))
	time.Sleep(time.Second)
	waitPlacement(t, sessions, map[string]int{poolLocal + "/1": 4})
	if got := pair.source.relayStreamStats().GetMigrationsOkTotal(); got != 0 {
		t.Fatalf("%d streams moved for the drain and resume of a relay that carried none", got)
	}
	for _, app := range apps {
		echoOnce(t, app)
	}
	if pair.dials.Load() != 4 {
		t.Fatalf("backend dialed %d times for 4 streams", pair.dials.Load())
	}
}
