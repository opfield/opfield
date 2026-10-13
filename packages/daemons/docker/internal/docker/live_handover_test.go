//go:build linux

package docker

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relayresume"
	"github.com/opfield/opfield/docker-daemon/internal/config"
)

// useTestKeeper makes handovers of this test go through keeper, as updates.
func useTestKeeper(t *testing.T, keeper *handovertest.Keeper) {
	previousKeeper, previousExit := handoverKeeper, exitingForUpdate
	handoverKeeper, exitingForUpdate = keeper, func() bool { return true }
	t.Cleanup(func() { handoverKeeper, exitingForUpdate = previousKeeper, previousExit })
}

// update hands plugin's connections to a new daemon process of the same node:
// the old one hands over and stops (its relay registrations and lanes end),
// the new one takes the connections over in Init's order (before its relay
// lanes start) and connects to the relays.
func (pair *streamPair) update(t *testing.T, keeper *handovertest.Keeper, old *DockerPlugin, bundle *pb.SyncRelayGrantsCommand) *DockerPlugin {
	t.Helper()
	result := old.handOverConnections()
	if !result.Committed || result.HandedOver == 0 || len(result.Cut) > 0 {
		t.Fatalf("handover: %+v", result)
	}
	for _, cancel := range pair.cancels[old] {
		cancel()
	}
	if err := keeper.Restart(); err != nil {
		t.Fatal(err)
	}
	next := pair.newDaemon(bundle)
	next.cfg.StateDir = t.TempDir()
	next.cfg.Docker.Mode = old.cfg.Docker.Mode
	next.endpointDialer = func(ctx context.Context, _ *pb.RelayGrantAssignment) (dialedEndpoint, error) {
		pair.dials.Add(1)
		conn, err := dialBackend(ctx, pair.backend)
		return dialedEndpoint{conn: conn}, err
	}
	next.restoreHandover()
	if keeper.Kept() != 0 {
		t.Fatalf("the keeper still holds %d descriptors after the restore", keeper.Kept())
	}
	for id := range pair.relays {
		pair.connect(next, id)
	}
	return next
}

// An update of the target daemon (the endpoint of a container link) keeps the
// stream: the bytes in flight both ways arrive exactly once, without a second
// dial of the backend.
func TestLiveHandoverKeepsStreamAcrossTargetUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	_, targetBundle := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 8<<20, func() {
		pair.target = pair.update(t, keeper, pair.target, targetBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	if stats := pair.source.relayStreamStats(); stats.GetCutTotal() != 0 {
		t.Fatalf("source stats %+v", stats)
	}
}

// An update of the source daemon (the workload's side of the link) keeps the
// stream the same way.
func TestLiveHandoverKeepsStreamAcrossSourceUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	sourceBundle, _ := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 8<<20, func() {
		pair.source = pair.update(t, keeper, pair.source, sourceBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	report := pair.source.updateConnections()
	if !report.GetHandoverAvailable() {
		t.Fatalf("report %+v", report)
	}
}

// A database link served on a storage node: its endpoint (not a connector
// ingress) keeps the stream across an update too.
func TestLiveHandoverKeepsDatabaseLinkAcrossTargetUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	kinds := routeKinds{connect: linkKindManagedDatabaseBinding, endpoint: "managed_database"}
	pair := newStreamPairFor(t, kinds, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	_, targetBundle := testBundlesFor(kinds, 1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 4<<20, func() {
		pair.target = pair.update(t, keeper, pair.target, targetBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
}

// A restart that is no update (a stop, a launcher that crashed and the unit started again) leaves the relay stream cut
// total, the streams its exit cuts included, to the next process (stand rc.7 O-5: the counter started at zero again
// and the cut was recorded nowhere).
func TestRestartCarriesTheRelayStreamCutTotal(t *testing.T) {
	useTestKeeper(t, handovertest.NewKeeper())
	stateDir := t.TempDir()
	previous := NewDockerPlugin(&config.Config{})
	previous.cfg.StateDir = stateDir
	previous.relayStreams().sources.CarryCut(4)
	previous.beginStreamExit()
	previous.Shutdown()
	next := NewDockerPlugin(&config.Config{})
	next.cfg.StateDir = stateDir
	next.restoreHandover()
	if cut := next.relayStreamStats().GetCutTotal(); cut != 4 {
		t.Fatalf("cut total %d after the restart, want the previous process's 4", cut)
	}
	again := NewDockerPlugin(&config.Config{})
	again.cfg.StateDir = stateDir
	again.restoreHandover()
	if stats := again.relayStreamStats(); stats.GetCutTotal() != 0 {
		t.Fatalf("the totals were carried twice: %+v", stats)
	}
}

// noHandoverKeeper is a launcher that keeps nothing for the next process (one
// that predates the keeper, or a service restart that stops it too).
type noHandoverKeeper struct{ *handovertest.Keeper }

func (noHandoverKeeper) HandsOver() bool { return false }

// openLinkFlow opens a stream from the source daemon for a workload
// connection that came in at a link socket (tracked like one, so a restart's
// drain closes it when idle).
func (pair *streamPair) openLinkFlow() (net.Conn, *relaySourceTunnel) {
	assignment := pair.source.relayGrants.lookup("connect", pair.kinds.connect, testLinkID)
	tunnel, err := pair.source.openRelaySource(assignment)
	if err != nil {
		pair.t.Fatal(err)
	}
	local, app := localStreamPair(pair.t)
	flow, done := pair.source.linkFlows.track(local)
	go func() {
		defer done()
		tunnel.bridge(flow)
	}()
	return app, tunnel
}

// An update that hands nothing over cuts every connection of the daemon, the
// idle ones its drain closes included, and reports each of them (O-2: a
// service restart of 22 link connections reported one, the one still busy
// when the drain ended; the others had ended by then).
func TestUpdateWithoutHandoverReportsTheConnectionsTheDrainCloses(t *testing.T) {
	pair := newStreamPair(t, true, true)
	idle, idleTunnel := pair.openLinkFlow()
	busy, busyTunnel := pair.openLinkFlow()
	// Referenced to the end: a collected connection would close and end its stream.
	t.Cleanup(func() { _ = idle.Close(); _ = busy.Close() })
	waitFor(t, "the streams to open", func() bool {
		return idleTunnel.session.State() == relayresume.StateOpen && busyTunnel.session.State() == relayresume.StateOpen
	})
	buffer := make([]byte, 4)
	if _, err := idle.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	_ = idle.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(idle, buffer); err != nil {
		t.Fatal(err)
	}
	// The busy one keeps a request in flight for the whole drain.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		chunk := make([]byte, 512)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := busy.Write(chunk); err != nil {
				return
			}
			if _, err := io.ReadFull(busy, chunk); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	time.Sleep(linkFlowIdleQuiet + 100*time.Millisecond) // the first one is idle now: the drain closes it

	previousKeeper, previousExit := handoverKeeper, exitingForUpdate
	handoverKeeper, exitingForUpdate = noHandoverKeeper{handovertest.NewKeeper()}, func() bool { return true }
	t.Cleanup(func() { handoverKeeper, exitingForUpdate = previousKeeper, previousExit })
	source := pair.source
	source.cfg.StateDir = t.TempDir()
	source.AnnounceRestart()

	data, err := os.ReadFile(filepath.Join(source.cfg.StateDir, "update-connections.json"))
	if err != nil {
		t.Fatal(err)
	}
	var report handover.Report
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatal(err)
	}
	if report.Handover || !report.Counted || report.Cut[handover.CutNoHandover] != 2 || len(report.Cut) != 1 {
		t.Fatalf("report = %+v, want both connections cut as no_handover", report)
	}
}

// A rollback after a live handover (O-13): the candidate took the stream over
// and moved it to another relay, then its launcher stopped it on trial and
// restored the previous daemon. The candidate hands the stream back, and the
// restored process carries it on from where the candidate left it: every byte
// arrives exactly once and the backend is never dialed again (an exit without
// the handover cut it, and nothing the restored process started with could
// resume it).
func TestRollbackAfterHandoverKeepsTheMovedStream(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	t.Cleanup(func() { _ = app.Close() })
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	sourceBundle, _ := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	var restored *DockerPlugin
	echoThrough(t, app, 16<<20, func() {
		candidate := pair.update(t, keeper, pair.source, sourceBundle)
		// The candidate moves the stream: the lane of the relay it is on ends.
		var session *relayresume.Session
		waitFor(t, "the candidate to carry the stream", func() bool {
			sessions := candidate.relayStreams().sources.Sessions()
			if len(sessions) != 1 {
				return false
			}
			session = sessions[0]
			_, _, ok := session.CurrentPath()
			return ok
		})
		from, _, _ := session.CurrentPath()
		pair.cancels[candidate][from]()
		waitFor(t, "the candidate to move the stream", func() bool {
			relay, _, ok := session.CurrentPath()
			return ok && relay != from
		})
		// Stopped on trial: it hands the stream to the daemon its launcher restores.
		restored = pair.update(t, keeper, candidate, sourceBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	if report := restored.updateConnections(); !report.GetHandoverAvailable() {
		t.Fatalf("report %+v", report)
	}
}
