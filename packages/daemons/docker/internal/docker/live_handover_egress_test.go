//go:build linux

package docker

import (
	"io"
	"net"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover"
	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/securelink"
	"github.com/opfield/opfield/daemon-shared/sockettest"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// egressForwarder is the egress side of the shared connector as the connector runs it (secure-link-connector
// egress.go): one listener per egress the last sync named, each workload connection carried through the daemon's
// egress socket; a sync that no longer names a listener closes it with every connection it carries.
type egressForwarder struct {
	socketPath string
	// dir holds the listeners' Unix sockets (the connector's are TCP on the link network: see localStreamPair).
	dir string
	// dropAll makes every sync close the listeners, as the connector did on the egress-less syncs of a daemon start.
	dropAll   atomic.Bool
	mu        sync.Mutex
	listeners map[string]*forwardedEgress
	closed    atomic.Int64
}

type forwardedEgress struct {
	ownerKind string
	listener  net.Listener
	mu        sync.Mutex
	active    map[net.Conn]struct{}
	closed    bool
}

func newEgressForwarder(t *testing.T, socketPath string) *egressForwarder {
	forwarder := &egressForwarder{socketPath: socketPath, dir: sockettest.Dir(t), listeners: map[string]*forwardedEgress{}}
	t.Cleanup(func() {
		forwarder.mu.Lock()
		defer forwarder.mu.Unlock()
		for _, listener := range forwarder.listeners {
			listener.close()
		}
	})
	return forwarder
}

// sync applies a connector sync before the connector answers it.
func (f *egressForwarder) sync(_ *fakeConnectorContainer, request securelink.SyncRequest) {
	f.mu.Lock()
	defer f.mu.Unlock()
	desired := map[string]securelink.EgressConfig{}
	if !f.dropAll.Load() {
		for _, config := range request.Egress {
			desired[config.ID] = config
		}
	}
	for id, listener := range f.listeners {
		if _, keep := desired[id]; !keep {
			listener.close()
			delete(f.listeners, id)
			f.closed.Add(1)
		}
	}
	for id, config := range desired {
		if f.listeners[id] != nil {
			continue
		}
		listener, err := net.Listen("unix", filepath.Join(f.dir, id[:8]+".sock"))
		if err != nil {
			continue
		}
		forwarded := &forwardedEgress{ownerKind: config.OwnerKind, listener: listener, active: map[net.Conn]struct{}{}}
		f.listeners[id] = forwarded
		go forwarded.serve(f.socketPath, id)
	}
}

// address is where the workloads reach the listener of egress id ("" while there is none).
func (f *egressForwarder) address(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if listener := f.listeners[id]; listener != nil {
		return listener.listener.Addr().String()
	}
	return ""
}

func (l *forwardedEgress) serve(socketPath, id string) {
	for {
		local, err := l.listener.Accept()
		if err != nil {
			return
		}
		go l.carry(local, socketPath, id)
	}
}

func (l *forwardedEgress) carry(local net.Conn, socketPath, id string) {
	defer local.Close()
	if !l.track(local) {
		return
	}
	defer l.untrack(local)
	remote, err := net.Dial("unix", socketPath)
	if err != nil {
		return
	}
	defer remote.Close()
	if err := securelink.WriteJSON(remote, securelink.RelayRequest{Version: securelink.RelayProtocolVersion, OwnerKind: l.ownerKind, BindingID: id}); err != nil {
		return
	}
	var response securelink.RelayResponse
	if err := securelink.ReadJSON(remote, &response); err != nil || response.Error != "" {
		return
	}
	if !l.track(remote) {
		return
	}
	defer l.untrack(remote)
	forwardBoth(local, remote)
}

// forwardBoth is the connector's bridge (secure-link-connector manager.go): a direction that ends cleanly passes its
// half-close on; the daemon's side ending, or an error, closes both.
func forwardBoth(local, remote net.Conn) {
	type copied struct {
		fromRemote bool
		err        error
	}
	results := make(chan copied, 2)
	copyOne := func(destination, source net.Conn, fromRemote bool) {
		_, err := io.Copy(destination, source)
		if err == nil {
			if closer, ok := destination.(interface{ CloseWrite() error }); ok {
				_ = closer.CloseWrite()
			}
		}
		results <- copied{fromRemote: fromRemote, err: err}
	}
	go copyOne(local, remote, true)
	go copyOne(remote, local, false)
	for range 2 {
		if result := <-results; result.err != nil || result.fromRemote {
			_ = local.Close()
			_ = remote.Close()
		}
	}
}

func (l *forwardedEgress) track(connection net.Conn) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.active[connection] = struct{}{}
	return true
}

func (l *forwardedEgress) untrack(connection net.Conn) {
	l.mu.Lock()
	delete(l.active, connection)
	l.mu.Unlock()
}

func (l *forwardedEgress) close() {
	l.mu.Lock()
	l.closed = true
	active := make([]net.Conn, 0, len(l.active))
	for connection := range l.active {
		active = append(active, connection)
	}
	l.mu.Unlock()
	_ = l.listener.Close()
	for _, connection := range active {
		_ = connection.Close()
	}
}

// egressHandoverPair is a stream pair whose source daemon serves the link through the shared connector's egress:
// the workload's connection goes to the connector's listener, the connector carries it through the daemon's egress
// socket, and the daemon's source stream carries it to the target.
type egressHandoverPair struct {
	*streamPair
	keeper    *handovertest.Keeper
	engine    *egressFakeEngine
	forwarder *egressForwarder
	stateDir  string
	bundle    *pb.SyncRelayGrantsCommand
}

func newEgressHandoverPair(t *testing.T) *egressHandoverPair {
	t.Helper()
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := &egressHandoverPair{streamPair: newStreamPair(t, true, true), keeper: keeper, stateDir: sockettest.Dir(t)}
	pair.engine = &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	pair.engine.controlDir = filepath.Join(pair.stateDir, "secure-link-connector")
	pair.engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	// Never written: the daemons' watch for connector starts waits on it.
	events, _ := io.Pipe()
	pair.engine.events = events
	pair.forwarder = newEgressForwarder(t, secureLinkEgressSocketPath(pair.stateDir))
	pair.engine.onSync = pair.forwarder.sync

	// The container link's connect grant names its egress on the link network.
	pair.bundle, _ = testBundles(2, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	pair.bundle.Grants[0].SecureLinkEgress = &pb.SecureLinkEgress{NetworkName: egressTestNetwork, Alias: "app", ListenPort: 8080,
		RouteGeneration: 3, ConnectorImage: replaceTestNewImage}
	if err := pair.source.relayGrants.sync(pair.bundle); err != nil {
		t.Fatal(err)
	}
	source := pair.source
	source.cfg.StateDir = pair.stateDir
	source.client = pair.engine.client()
	if err := source.initProxySecureLinks(); err != nil {
		t.Fatalf("secure links of the source daemon: %v", err)
	}
	// The node also serves a Secure Link target through the connector: its next process restores that binding.
	if _, err := source.secureLinks.syncWithPersistence(replaceTestCommand(replaceTestNewImage), nil, source.secureLinkState.Commit); err != nil {
		t.Fatalf("ingress binding: %v", err)
	}
	waitFor(t, "the connector to listen for the link", func() bool { return pair.forwarder.address(testLinkID) != "" })
	return pair
}

// dial opens a workload connection to the link's egress listener.
func (pair *egressHandoverPair) dial() net.Conn {
	pair.t.Helper()
	app, err := net.Dial("unix", pair.forwarder.address(testLinkID))
	if err != nil {
		pair.t.Fatal(err)
	}
	pair.t.Cleanup(func() { app.Close() })
	return app
}

// update hands the source daemon's connections to its next process, which starts as Init runs it: it takes the
// connections over, then restores its Secure Links (the connector's ingress bindings and egress listeners).
func (pair *egressHandoverPair) update(fromVersion string) {
	t := pair.t
	old := pair.source
	previousVersion := lifecycle.Version
	lifecycle.Version = fromVersion
	result := old.handOverConnections()
	if result.Committed {
		old.recordUpdateConnections(result.StartedAt, result, old.updateCutsNow())
	}
	lifecycle.Version = previousVersion
	if !result.Committed || result.HandedOver == 0 || len(result.Cut) > 0 {
		t.Errorf("handover: %+v", result)
		return
	}
	for _, cancel := range pair.cancels[old] {
		cancel()
	}
	if err := pair.keeper.Restart(); err != nil {
		t.Error(err)
		return
	}
	next := pair.newDaemon(pair.bundle)
	next.cfg.StateDir = pair.stateDir
	next.cfg.Docker.Mode = old.cfg.Docker.Mode
	next.client = pair.engine.client()
	next.startedAt = time.Now()
	next.restoreHandover()
	if err := next.initProxySecureLinks(); err != nil {
		t.Errorf("secure links of the next process: %v", err)
	}
	for id := range pair.relays {
		pair.connect(next, id)
	}
	pair.source = next
}

// settled waits for the source daemon's report of its last update.
func (pair *egressHandoverPair) settled() *handover.Report {
	pair.t.Helper()
	var report *handover.Report
	waitFor(pair.t, "the update's report", func() bool {
		report = pair.source.handoverTracker.Last()
		return report != nil
	})
	return report
}

// An update of the docker daemon whose workload reaches its link through the shared connector keeps the workload's
// connection: the bytes in flight both ways arrive exactly once, the connector's listener is never closed, and the
// update reports the connection kept. Stand rc.7 F-1: the next process's first connector sync named no egress
// listener, the connector closed them with every connection they carried, and the update reported them kept.
func TestLiveHandoverKeepsConnectorEgressAcrossSourceUpdate(t *testing.T) {
	for _, from := range []struct{ name, version string }{
		{"same release", lifecycle.Version},
		{"from the previous release", "v2.11.4-rc.6"},
	} {
		t.Run(from.name, func(t *testing.T) {
			pair := newEgressHandoverPair(t)
			apps := []net.Conn{pair.dial(), pair.dial()}
			// An idle connection (a pool's, LISTEN) next to the busy one.
			if _, err := apps[1].Write([]byte("ping")); err != nil {
				t.Fatal(err)
			}
			if got := readExactly(t, apps[1], 4); string(got) != "ping" {
				t.Fatalf("idle connection echoed %q", got)
			}
			closedBefore := pair.forwarder.closed.Load()
			echoThrough(t, apps[0], 64<<20, func() { pair.update(from.version) })
			if closed := pair.forwarder.closed.Load() - closedBefore; closed != 0 {
				t.Fatalf("the connector closed %d egress listeners during the update", closed)
			}
			if _, err := apps[1].Write([]byte("pong")); err != nil {
				t.Fatal(err)
			}
			if got := readExactly(t, apps[1], 4); string(got) != "pong" {
				t.Fatalf("idle connection echoed %q after the update", got)
			}
			if pair.dials.Load() != 2 {
				t.Fatalf("backend dialed %d times, want once per connection", pair.dials.Load())
			}
			report := pair.settled()
			if report.FromVersion != from.version || report.HandedOver != 2 || report.Kept != 2 || len(report.Cut) != 0 {
				t.Fatalf("update report %+v", report)
			}
		})
	}
}

// A workload connection whose local side the update ends (here: a connector that closes its listeners at the next
// process's first sync, as before the fix) is never reported kept: its stream resumes, but what it carries is lost.
// Its local side ends with an end of stream before the stream resumes, as a client that closes by itself during the
// pause does, so it is not counted as cut either (P-1); a local connection that fails would be (CutLocalClosed).
func TestLiveHandoverReportsLocalConnectionsItLost(t *testing.T) {
	pair := newEgressHandoverPair(t)
	app := pair.dial()
	if _, err := app.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	if got := readExactly(t, app, 4); string(got) != "ping" {
		t.Fatalf("echoed %q", got)
	}
	pair.forwarder.dropAll.Store(true)
	pair.update(lifecycle.Version)
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := app.Read(make([]byte, 1)); err == nil {
		t.Fatalf("the connection the connector closed still reads (%d bytes)", n)
	}
	report := pair.settled()
	if report.HandedOver != 1 || report.Kept != 0 || len(report.Cut) != 0 {
		t.Fatalf("update report %+v, want the connection neither kept nor cut", report)
	}
}

// holdOpens keeps the source opens on both relays waiting until the returned func releases them with err (nil: they
// go on).
func (pair *egressHandoverPair) holdOpens() func(err error) {
	hold := &openHold{release: make(chan struct{})}
	for _, relay := range pair.relays {
		relay.hold.Store(hold)
	}
	return func(err error) {
		hold.err = err
		close(hold.release)
	}
}

// An update that begins while a workload connection's relay stream is still being opened (its target slow or
// restarting) waits for the open before it stops anything, and the connection goes along: the workload is served by
// the next process. Stand rc.13: such a connection was cut by the exit and counted nowhere.
func TestUpdateWaitsForARelayOpenInFlight(t *testing.T) {
	pair := newEgressHandoverPair(t)
	release := pair.holdOpens()
	app := pair.dial()
	// Sent before the stream is open: the connector holds it until the daemon answers.
	if _, err := app.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the open to be in flight", func() bool { return pair.source.handover.SettingUp() == 1 })
	go func() {
		time.Sleep(300 * time.Millisecond)
		release(nil)
	}()
	pair.update(lifecycle.Version)
	if got := readExactly(t, app, 4); string(got) != "ping" {
		t.Fatalf("echoed %q", got)
	}
	echoThrough(t, app, 4<<20, func() {})
	report := pair.settled()
	if report.HandedOver != 1 || report.Kept != 1 || len(report.Cut) != 0 {
		t.Fatalf("update report %+v, want the connection kept", report)
	}
}

// An open in flight that fails while the update waits for it (the target refused it) is the target's: the workload
// gets the refusal as without an update, and the update record counts no cut of this node.
func TestUpdateBooksNoCutForARelayOpenTheTargetRefused(t *testing.T) {
	pair := newEgressHandoverPair(t)
	release := pair.holdOpens()
	app := pair.dial()
	waitFor(t, "the open to be in flight", func() bool { return pair.source.handover.SettingUp() == 1 })
	go func() {
		time.Sleep(300 * time.Millisecond)
		release(status.Error(codes.PermissionDenied, "route is not authorized"))
	}()
	result := pair.source.handOverConnections()
	if result.SetupsAwaited != 1 || result.SetupsLeft != 0 || result.SetupWait < 200*time.Millisecond {
		t.Fatalf("handover %+v, want it to wait for the open", result)
	}
	if cuts := pair.source.updateCutsNow(); len(cuts) != 0 {
		t.Fatalf("cuts %v, want none of this node", cuts)
	}
	_ = app.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := app.Read(make([]byte, 1)); err == nil {
		t.Fatalf("the refused connection still reads (%d bytes)", n)
	}
}

func readExactly(t *testing.T, connection net.Conn, n int) []byte {
	t.Helper()
	buffer := make([]byte, n)
	_ = connection.SetReadDeadline(time.Now().Add(10 * time.Second))
	defer connection.SetReadDeadline(time.Time{})
	if _, err := io.ReadFull(connection, buffer); err != nil {
		t.Fatalf("read: %v", err)
	}
	return buffer
}
