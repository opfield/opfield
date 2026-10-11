package daemon

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

var testResumeKey = bytes.Repeat([]byte{7}, relayresume.KeyLen)

const testResumeRoute = "route-resume"

// resumeTarget is one target daemon behind every test relay: a relayresume
// target table in front of an echo backend.
type resumeTarget struct {
	table    *relayresume.TargetTable
	backends atomic.Int64
	resumed  atomic.Int64
}

func newResumeTarget() *resumeTarget {
	return &resumeTarget{table: relayresume.NewTargetTable(nil)}
}

// resumeRelay admits every tunnel and hands it to the target, as a relay
// bridging to a resume-aware docker daemon.
type resumeRelay struct {
	relayv1.UnimplementedTunnelBrokerServer
	id     string
	target *resumeTarget
	opened atomic.Int64
}

func (r *resumeRelay) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	r.opened.Add(1)
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 16 * 1024}}}); err != nil {
		return err
	}
	done := make(chan struct{})
	var once sync.Once
	op := relayresume.OpenedPath{Stream: stream, Cancel: func() { once.Do(func() { close(done) }) }, RelayID: r.id, MaxFrame: 16 * 1024}
	go func() {
		decision := r.target.table.Accept(op, relayresume.AcceptRequest{
			RouteID: testResumeRoute, SourceKind: "daemon", SourceID: "node-nginx", RelayID: r.id,
			Keys: func(keyID string) []byte {
				if keyID == "v1" {
					return testResumeKey
				}
				return nil
			},
		})
		switch decision.Kind {
		case relayresume.AcceptHello:
			r.target.backends.Add(1)
			session, err := decision.Establish()
			if err != nil {
				op.Cancel()
				return
			}
			echoFrames(session)
		case relayresume.AcceptLegacy:
			r.target.backends.Add(1)
			echoFrames(decision.Stream)
			op.Cancel()
		default:
			if decision.Kind == relayresume.AcceptResumed {
				r.target.resumed.Add(1)
			}
			<-decision.PathDone
		}
	}()
	select {
	case <-done:
	case <-stream.Context().Done():
	}
	return nil
}

func echoFrames(stream relaybridge.FrameStream) {
	for {
		frame, err := stream.Recv()
		if err != nil {
			return
		}
		switch {
		case frame.GetData() != nil:
			data := append([]byte(nil), frame.GetData().GetData()...)
			if stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Data{Data: &relayv1.TunnelData{Data: data}}}) != nil {
				return
			}
		case frame.GetHalfClose() != nil:
			_ = stream.Send(frame)
		default:
			return
		}
	}
}

func startResumeRelay(t *testing.T, id string, target *resumeTarget) (*resumeRelay, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	relay := &resumeRelay{id: id, target: target}
	server := grpc.NewServer()
	relayv1.RegisterTunnelBrokerServer(server, relay)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	return relay, listener.Addr().String()
}

func resumeBundle(revision uint64, states map[string]string, resume bool) *pb.SyncRelayGrantsCommand {
	assignment := &pb.RelayGrantAssignment{
		Role: "connect", OwnerKind: proxySecureLinkOwnerKind, OwnerId: testSecureLinkID, SchemaVersion: 2, RouteId: testResumeRoute,
		Candidates: []*pb.RelayDataCandidate{
			poolCandidate("relay-near", relaybridge.RolePrimary), poolCandidate("relay-far", relaybridge.RoleStandby),
		},
	}
	for _, candidate := range assignment.Candidates {
		if state, ok := states[candidate.RelayInstanceId]; ok {
			candidate.AssignmentState = state
		}
	}
	if resume {
		assignment.StreamResume = &pb.RelayStreamResume{Version: relayresume.Version, KeyId: "v1", Key: testResumeKey}
	}
	return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, Grants: []*pb.RelayGrantAssignment{assignment}}
}

type resumeFixture struct {
	plugin    *NginxPlugin
	target    *resumeTarget
	near, far *resumeRelay
	nearPath  *relayPath
	nearLane  *grpc.ClientConn
}

func newResumeFixture(t *testing.T, resume bool) *resumeFixture {
	t.Helper()
	target := newResumeTarget()
	near, nearAddress := startResumeRelay(t, "relay-near", target)
	far, farAddress := startResumeRelay(t, "relay-far", target)
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plugin := &NginxPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store}
	plugin.relayStreams = newRelayStreamManager(plugin)
	if _, err := plugin.SyncRelayGrants(resumeBundle(1, nil, resume)); err != nil {
		t.Fatal(err)
	}
	path := newRelayPath(t, nearAddress)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	nearLane := dialTestLane(t, path.address())
	farLane := dialTestLane(t, farAddress)
	go plugin.RunRelayTargetTunnels(ctx, nearLane, "", "relay-near")
	go plugin.RunRelayTargetTunnels(ctx, farLane, "", "relay-far")
	waitForRelayLanes(t, plugin, 2)
	return &resumeFixture{plugin: plugin, target: target, near: near, far: far, nearPath: path, nearLane: nearLane}
}

// linkConnection is one connection nginx makes to the link's socket.
type linkConnection struct {
	t      *testing.T
	client net.Conn
	done   chan struct{}
}

func openLinkConnection(t *testing.T, plugin *NginxPlugin) *linkConnection {
	t.Helper()
	client, daemonSide := net.Pipe()
	connection := &linkConnection{t: t, client: client, done: make(chan struct{})}
	go func() {
		defer close(connection.done)
		plugin.openProxySecureLink(testSecureLinkID, daemonSide)
	}()
	_ = client.SetDeadline(time.Now().Add(20 * time.Second))
	t.Cleanup(func() {
		_ = client.Close()
		<-connection.done
	})
	return connection
}

// roundTrip writes size random bytes and reads them back.
func (c *linkConnection) roundTrip(size int) {
	c.t.Helper()
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	written := make(chan error, 1)
	go func() {
		_, err := c.client.Write(payload)
		written <- err
	}()
	reply := make([]byte, size)
	if _, err := io.ReadFull(c.client, reply); err != nil {
		c.t.Fatalf("no echo through the link: %v", err)
	}
	if err := <-written; err != nil {
		c.t.Fatal(err)
	}
	if !bytes.Equal(reply, payload) {
		c.t.Fatal("echo differs")
	}
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if condition() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func onlySession(t *testing.T, plugin *NginxPlugin) *relayresume.Session {
	t.Helper()
	var sessions []*relayresume.Session
	waitFor(t, "one resumable stream", func() bool {
		sessions = plugin.relayStreams.Sessions()
		return len(sessions) == 1
	})
	return sessions[0]
}

// The near relay becomes unreachable while a connection is open: the stream
// resumes through the far relay and the connection never notices; the
// target's backend is dialed once.
func TestSecureLinkStreamSurvivesRelayLoss(t *testing.T) {
	fixture := newResumeFixture(t, true)
	connection := openLinkConnection(t, fixture.plugin)
	connection.roundTrip(64 * 1024)
	session := onlySession(t, fixture.plugin)
	if session.RelayID() != "relay-near" {
		t.Fatalf("stream runs through %q", session.RelayID())
	}
	fixture.nearPath.block()
	connection.roundTrip(256 * 1024)
	waitFor(t, "the stream to run through the far relay", func() bool { return session.RelayID() == "relay-far" })
	connection.roundTrip(64 * 1024)
	if fixture.target.backends.Load() != 1 || fixture.target.resumed.Load() < 1 {
		t.Fatalf("backends %d, resumed %d: want one backend and a resume", fixture.target.backends.Load(), fixture.target.resumed.Load())
	}
	stats := fixture.plugin.relayStreams.Stats()
	if stats.Resumable != 1 || stats.MigrationsOK < 1 {
		t.Fatalf("stream stats = %+v", stats)
	}
}

// A pool lane leaving READY (GOAWAY from a stopping relay) moves the stream
// while the relay still carries it.
func TestSecureLinkStreamMovesWhenItsLaneLeavesReady(t *testing.T) {
	fixture := newResumeFixture(t, true)
	connection := openLinkConnection(t, fixture.plugin)
	connection.roundTrip(32 * 1024)
	session := onlySession(t, fixture.plugin)
	fixture.plugin.RelayLaneLeftReady("relay-near", fixture.nearLane)
	waitFor(t, "the stream to leave the stopping relay", func() bool { return session.RelayID() == "relay-far" })
	connection.roundTrip(128 * 1024)
	if fixture.target.backends.Load() != 1 || fixture.target.resumed.Load() != 1 {
		t.Fatalf("backends %d, resumed %d: want one backend and one planned resume", fixture.target.backends.Load(), fixture.target.resumed.Load())
	}
}

// The only active relay is lost while the other relay is still staging for
// the route: the stream resumes there instead of being cut after the
// suspend budget.
func TestSecureLinkStreamResumesOnAStagingRelay(t *testing.T) {
	fixture := newResumeFixture(t, true)
	if _, err := fixture.plugin.SyncRelayGrants(resumeBundle(2, map[string]string{"relay-far": "staging"}, true)); err != nil {
		t.Fatal(err)
	}
	connection := openLinkConnection(t, fixture.plugin)
	connection.roundTrip(32 * 1024)
	session := onlySession(t, fixture.plugin)
	if session.RelayID() != "relay-near" {
		t.Fatalf("stream runs through %q", session.RelayID())
	}
	fixture.nearPath.block()
	connection.roundTrip(64 * 1024)
	waitFor(t, "the stream to resume on the staging relay", func() bool { return session.RelayID() == "relay-far" })
	if fixture.target.backends.Load() != 1 {
		t.Fatalf("backends %d, want 1", fixture.target.backends.Load())
	}
}

// A drain notice in the grant bundle moves open streams off the draining
// relay while it still works.
func TestSecureLinkStreamMovesOffADrainingRelay(t *testing.T) {
	fixture := newResumeFixture(t, true)
	connection := openLinkConnection(t, fixture.plugin)
	connection.roundTrip(32 * 1024)
	session := onlySession(t, fixture.plugin)
	if _, err := fixture.plugin.SyncRelayGrants(resumeBundle(2, map[string]string{"relay-near": "draining"}, true)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the stream to leave the draining relay", func() bool { return session.RelayID() == "relay-far" })
	connection.roundTrip(128 * 1024)
	if fixture.far.opened.Load() != 1 {
		t.Fatalf("far relay opened %d tunnels, want the resume", fixture.far.opened.Load())
	}
}

// Without stream_resume the link's streams stay raw, byte for byte as before.
func TestSecureLinkStreamStaysRawWithoutResume(t *testing.T) {
	fixture := newResumeFixture(t, false)
	connection := openLinkConnection(t, fixture.plugin)
	// Raw frames are as large as nginx reads (up to 32 KiB) whatever the test relay's 16 KiB limit: keep them small.
	connection.roundTrip(8 * 1024)
	if sessions := fixture.plugin.relayStreams.Sessions(); len(sessions) != 0 {
		t.Fatalf("a raw link opened %d resumable streams", len(sessions))
	}
	if stats := fixture.plugin.relayStreams.Stats(); stats.Legacy != 1 {
		t.Fatalf("legacy streams = %d, want 1", stats.Legacy)
	}
}

// A target that is not resume-aware: the first stream is reset, the route
// latches to raw streams, and the next connection works as before.
func TestSecureLinkStreamFallsBackForALegacyTarget(t *testing.T) {
	near, nearAddress := startEchoRelay(t)
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plugin := &NginxPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store}
	plugin.relayStreams = newRelayStreamManager(plugin)
	bundle := resumeBundle(1, nil, true)
	bundle.Grants[0].Candidates = bundle.Grants[0].Candidates[:1]
	if _, err := plugin.SyncRelayGrants(bundle); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go plugin.RunRelayTargetTunnels(ctx, dialTestLane(t, nearAddress), "", "relay-near")
	waitForRelayLanes(t, plugin, 1)

	first := openLinkConnection(t, plugin)
	_, _ = first.client.Write([]byte("ping"))
	select {
	case <-first.done:
	case <-time.After(15 * time.Second):
		t.Fatal("the stream to a legacy target was not reset")
	}
	waitFor(t, "the legacy latch", func() bool { return plugin.relayStreams.Legacy(testResumeRoute) })
	echoThroughLink(t, plugin, testSecureLinkID)
	if near.opened.Load() != 2 {
		t.Fatalf("relay opened %d tunnels, want 2", near.opened.Load())
	}
	// The same key keeps the latch; Gateway turning the route on again with
	// a new key clears it.
	if _, err := plugin.SyncRelayGrants(resumeBundleWithKey(2, bundle, bundle.Grants[0].GetStreamResume().GetKeyId())); err != nil {
		t.Fatal(err)
	}
	if !plugin.relayStreams.Legacy(testResumeRoute) {
		t.Fatal("an unchanged key cleared the legacy latch")
	}
	if _, err := plugin.SyncRelayGrants(resumeBundleWithKey(3, bundle, "v-next")); err != nil {
		t.Fatal(err)
	}
	if plugin.relayStreams.Legacy(testResumeRoute) {
		t.Fatal("a route turned on again with a new key stayed latched")
	}
}

// resumeBundleWithKey is bundle at revision with the route's resume key id
// set to keyID.
func resumeBundleWithKey(revision uint64, bundle *pb.SyncRelayGrantsCommand, keyID string) *pb.SyncRelayGrantsCommand {
	next := proto.Clone(bundle).(*pb.SyncRelayGrantsCommand)
	next.PolicyRevision = revision
	next.Grants[0].StreamResume.KeyId = keyID
	return next
}

func TestNginxAdvertisesResumableStreams(t *testing.T) {
	plugin := &NginxPlugin{}
	plugin.relayStreams = newRelayStreamManager(plugin)
	found := false
	for _, capability := range plugin.capabilities() {
		found = found || capability == relayresume.Capability
	}
	if !found {
		t.Fatal("nginx does not advertise relay_stream_resume_v1")
	}
}

// generationBundle is resumeBundle with every relay in generation next active and generation next-1 draining.
func generationBundle(revision, next uint64) *pb.SyncRelayGrantsCommand {
	bundle := resumeBundle(revision, nil, true)
	assignment := bundle.Grants[0]
	var candidates []*pb.RelayDataCandidate
	for _, candidate := range assignment.Candidates {
		active := proto.Clone(candidate).(*pb.RelayDataCandidate)
		active.AssignmentGeneration = next
		draining := proto.Clone(candidate).(*pb.RelayDataCandidate)
		draining.AssignmentGeneration = next - 1
		draining.AssignmentState = "draining"
		candidates = append(candidates, active, draining)
	}
	assignment.Candidates = candidates
	return bundle
}

// A new assignment generation on the same relays keeps the stream on its relay and its path: the old generation
// drains (placement, no deadline), the relay keeps its tunnel, and bundles sent again move nothing (stand 2.12 N-2).
// Once the old generation is gone the stream re-paths onto the same relay under the new grant, never onto the other.
func TestSecureLinkStreamStaysOnItsRelayAcrossAGenerationChange(t *testing.T) {
	fixture := newResumeFixture(t, true)
	connection := openLinkConnection(t, fixture.plugin)
	connection.roundTrip(32 * 1024)
	session := onlySession(t, fixture.plugin)
	if relay, generation, _ := session.CurrentPath(); relay != "relay-near" || generation != 1 {
		t.Fatalf("stream runs through %s generation %d", relay, generation)
	}
	for revision := uint64(2); revision < 5; revision++ {
		if _, err := fixture.plugin.SyncRelayGrants(generationBundle(revision, 2)); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(time.Second)
	connection.roundTrip(64 * 1024)
	if relay, generation, _ := session.CurrentPath(); relay != "relay-near" || generation != 1 {
		t.Fatalf("stream moved to %s generation %d while its generation drains", relay, generation)
	}
	if got := fixture.plugin.relayStreams.Stats().MigrationsOK; got != 0 {
		t.Fatalf("%d moves for a generation change on the same relays", got)
	}

	// Generation 1 retired: only generation 2 is left.
	retired := generationBundle(5, 2)
	var active []*pb.RelayDataCandidate
	for _, candidate := range retired.Grants[0].Candidates {
		if candidate.GetAssignmentState() == "active" {
			active = append(active, candidate)
		}
	}
	retired.Grants[0].Candidates = active
	if _, err := fixture.plugin.SyncRelayGrants(retired); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the stream to re-path under the new grant", func() bool {
		relay, generation, _ := session.CurrentPath()
		return relay == "relay-near" && generation == 2
	})
	connection.roundTrip(64 * 1024)
	if relay, _, _ := session.CurrentPath(); relay != "relay-near" || fixture.far.opened.Load() != 0 {
		t.Fatalf("stream on %s, far relay opened %d tunnels", relay, fixture.far.opened.Load())
	}
	if got := fixture.plugin.relayStreams.Stats().MigrationsOK; got != 1 {
		t.Fatalf("%d moves, want one re-path once the generation is gone", got)
	}
}

// A planned move (ingress-1 logged its 1-ms regrants as retries for 20 minutes, rc.4 O-i) is not a retry.
func TestOnlyAPathFailureMoveCountsAsARetry(t *testing.T) {
	for _, trigger := range []relayresume.Trigger{
		relayresume.TriggerDrain, relayresume.TriggerGoAway, relayresume.TriggerTargetHint,
		relayresume.TriggerRegrant, relayresume.TriggerReturn,
	} {
		if relayStreamMoveUnplanned(trigger) {
			t.Fatalf("%s move counts as a retry", trigger)
		}
	}
	if !relayStreamMoveUnplanned(relayresume.TriggerPathFailure) {
		t.Fatal("path failure move does not count as a retry")
	}
}
