package docker

import (
	"log/slog"
	"net"
	"slices"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/securelink"
)

// addrConn is a tunnel's connection with the addresses of a real one.
type addrConn struct {
	nopConn
	local, remote net.Addr
}

func (c addrConn) LocalAddr() net.Addr  { return c.local }
func (c addrConn) RemoteAddr() net.Addr { return c.remote }

// holdTunnel keeps a tunnel this daemon dialed through a connector open, with the given connection addresses.
func holdTunnel(manager *dockerSecureLinkManager, connectorID, daemon, connector string) (session *drainConn, release func(), cut func() bool) {
	cancelled := make(chan struct{})
	local, _ := net.ResolveTCPAddr("tcp", daemon)
	remote, _ := net.ResolveTCPAddr("tcp", connector)
	session = newDrainConn(&connectorConn{Conn: addrConn{local: local, remote: remote}, connectorID: connectorID})
	untrack := manager.plugin.proxyTunnels.addHeld(session, func() { close(cancelled) })
	return session, untrack, func() bool {
		select {
		case <-cancelled:
			return true
		default:
			return false
		}
	}
}

func handoverTestManager(t *testing.T) (*dockerSecureLinkManager, *fakeConnectorEngine, *lockedBuffer) {
	t.Helper()
	engine := newFakeConnectorEngine(t)
	engine.handover = true
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	logs := &lockedBuffer{}
	plugin := &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewTextHandler(logs, nil))}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: secureLinkConnectorSocketPath(engine.controlDir, 0),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	return manager, engine, logs
}

func secureLinkConnectorSocketPath(directory string, slot int) string {
	return directory + "/" + secureLinkConnectorSlots[slot].socket
}

func setHandoverResult(engine *fakeConnectorEngine, slot int, result securelink.HandoverResult) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.containers[secureLinkConnectorSlots[slot].name].handoverResult = result
}

func handoverRequests(engine *fakeConnectorEngine, connector *fakeConnectorContainer) []securelink.SyncRequest {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return append([]securelink.SyncRequest(nil), connector.handovers...)
}

// stand rc.8 F-3: a Relay Pool update replaced the connector, and an hour later the replaced one was removed with every
// session it still carried (pgbench, LISTEN, the DB, storage and container link holders, WebSockets, SSE: 46, 52 and
// 12 sessions). A replaced connector of this release now hands its sessions to its replacement: the tunnels this daemon
// dialed into them count as the replacement's, nothing is closed or cut, and the replaced connector goes at once.
func TestReplacedConnectorHandsItsSessionsToItsReplacement(t *testing.T) {
	withRetireLimit(t, 300*time.Millisecond)
	manager, engine, logs := handoverTestManager(t)
	first := manager.currentView().connectorID
	firstContainer := engine.container(secureLinkConnectorSlots[0].name)
	idle, releaseIdle, idleCut := holdTunnel(manager, first, "10.99.0.1:40001", "10.99.0.11:20000")
	defer releaseIdle()
	busy, releaseBusy, busyCut := holdTunnel(manager, first, "10.99.0.1:40002", "10.99.0.11:20000")
	defer releaseBusy()
	busy.upgraded.Store(true)
	setHandoverResult(engine, 0, securelink.HandoverResult{HandedOver: 5, Peers: []securelink.HandoverPeer{
		{Daemon: "10.99.0.1:40001", Connector: "10.99.0.11:20000"},
		{Daemon: "10.99.0.1:40002", Connector: "10.99.0.11:20000"},
	}})

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	second := manager.currentView().connectorID
	if second == first || manager.slot != 1 {
		t.Fatalf("replacement %s in slot %d", second, manager.slot)
	}
	waitRemovedID(t, engine, first)
	requests := handoverRequests(engine, firstContainer)
	if len(requests) != 1 || requests[0].Handover == nil || requests[0].Handover.To != secureLinkConnectorSlots[1].socket {
		t.Fatalf("handover requests %+v, want one to %s", requests, secureLinkConnectorSlots[1].socket)
	}
	for _, tunnel := range []*drainConn{idle, busy} {
		if got := connectionConnector(tunnel); got != second {
			t.Fatalf("a handed over tunnel counts as connector %q, want %q", got, second)
		}
	}
	// Past the retire limit nothing it handed over is cut.
	time.Sleep(3 * secureLinkConnectorRetireLimit)
	if idleCut() || busyCut() {
		t.Fatalf("handed over tunnels cut: idle %v busy %v", idleCut(), busyCut())
	}
	if logs.count("sessions_cut") != 0 || logs.count("handed its sessions over to its replacement") != 1 {
		t.Fatalf("logs:\n%s", logs.String())
	}
	if _, retiring := manager.retiring.deadline(first); retiring {
		t.Fatal("the replaced connector is still recorded as retiring")
	}
}

// What a replaced connector cannot pass on (a session whose TLS it originates) it finishes itself, as before: it
// retires with it up to the limit, and the cut at the limit is logged and counted.
func TestHandoverLeftoversFinishOnTheReplacedConnector(t *testing.T) {
	withRetireLimit(t, 500*time.Millisecond)
	manager, engine, logs := handoverTestManager(t)
	first := manager.currentView().connectorID
	firstContainer := engine.container(secureLinkConnectorSlots[0].name)
	setHandoverResult(engine, 0, securelink.HandoverResult{HandedOver: 3, Left: map[string]int{securelink.HandoverLeftTLS: 1}})
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if slices.Contains(engine.removedIDs(), first) {
		t.Fatal("the replaced connector went while it still carried a session")
	}
	waitRemovedID(t, engine, first)
	if logs.count("sessions_cut=1") != 1 || logs.count(`left=map[tls:1]`) != 1 {
		t.Fatalf("logs:\n%s", logs.String())
	}
	// A TLS session never moves: one handover only.
	if requests := handoverRequests(engine, firstContainer); len(requests) != 1 {
		t.Fatalf("%d handover requests, want 1", len(requests))
	}
}

// A connector of an earlier release cannot hand over: it answers the request "unsupported", changes nothing, and is
// told to drain as before; its sessions finish on it.
func TestConnectorOfAnEarlierReleaseFinishesItsSessions(t *testing.T) {
	withRetireLimit(t, time.Minute)
	manager, engine := replaceTestManager(t)
	first := manager.currentView().connectorID
	firstContainer := engine.container(secureLinkConnectorSlots[0].name)
	tunnel, release, cut := holdTunnel(manager, first, "10.99.0.1:40001", "10.99.0.11:20000")
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !receivedDrain(engine, engine.container(secureLinkConnectorSlots[0].name)) {
		if time.Now().After(deadline) {
			t.Fatal("the connector of an earlier release was not told to drain")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if requests := handoverRequests(engine, firstContainer); len(requests) != 1 {
		t.Fatalf("%d handover requests, want 1 (answered unsupported)", len(requests))
	}
	time.Sleep(100 * time.Millisecond)
	if cut() || connectionConnector(tunnel) != first || slices.Contains(engine.removedIDs(), first) {
		t.Fatalf("cut %v, connector %q, removed %v", cut(), connectionConnector(tunnel), engine.removedIDs())
	}
	release()
	waitRemovedID(t, engine, first)
}

// The connector names a handed over session by the connection the daemon dialed, as it sees it (its remote and local
// address); the daemon finds its tunnel by the same connection from its side.
func TestHandoverMovesTheTunnelOfTheConnectionTheConnectorNames(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 2)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			accepted <- connection
		}
	}()
	var tunnels proxyTunnelSet
	var dialed []*drainConn
	for range 2 {
		connection, err := net.Dial("tcp4", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		tunnel := newDrainConn(&connectorConn{Conn: connection, connectorID: "old"})
		defer tunnels.add(tunnel, func() {})()
		dialed = append(dialed, tunnel)
	}
	// The connector hands over the session of the first connection only.
	first := <-accepted
	defer first.Close()
	second := <-accepted
	defer second.Close()
	named := first
	if first.RemoteAddr().String() != dialed[0].LocalAddr().String() {
		named = second
	}
	peer := securelink.HandoverPeer{Daemon: named.RemoteAddr().String(), Connector: named.LocalAddr().String()}
	if moved := tunnels.moveToConnector([]securelink.HandoverPeer{peer}, "new"); moved != 1 {
		t.Fatalf("moved %d tunnels, want 1", moved)
	}
	if connectionConnector(dialed[0]) != "new" || connectionConnector(dialed[1]) != "old" {
		t.Fatalf("connectors %q and %q, want new and old", connectionConnector(dialed[0]), connectionConnector(dialed[1]))
	}
}
