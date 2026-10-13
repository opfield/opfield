//go:build linux

package daemon

import (
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/handover/handovertest"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/relayresume"
)

// freeLoopbackAddress is a free port on a 127.64.x.y address, like the ones Gateway allocates.
func freeLoopbackAddress(t *testing.T, host string) string {
	t.Helper()
	listener, err := net.Listen("tcp4", host+":0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

func loopbackCommand(address string) *pb.SyncProxySecureLinksCommand {
	command := sourceCommand(0, 1)
	command.Bindings[0].SocketOnly = true
	command.Bindings[0].LoopbackAddress = address
	return command
}

// dialAndSend connects to the endpoint and sends the first bytes of a request, which the daemon waits for.
func dialAndSend(t *testing.T, network, address string) net.Conn {
	t.Helper()
	connection, err := net.DialTimeout(network, address, time.Second)
	if err != nil {
		t.Fatalf("connect to %s: %v", address, err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := connection.Write([]byte("GET")); err != nil {
		t.Fatal(err)
	}
	return connection
}

// The loopback endpoint serves the managed nginx workers' uid only: any local process can connect to a loopback
// port. The link's Unix socket keeps serving next to it (configs rendered before the update, a rollback).
func TestLoopbackEndpointServesOnlyTheNginxWorkerUID(t *testing.T) {
	opened := make(chan net.Conn, 4)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		opened <- connection
		_ = connection.Close()
	})
	authority := newNginxPeerAuthority("", nil)
	manager.authorizeUnixPeer = authority.authorize
	address := freeLoopbackAddress(t, "127.64.0.1")
	statuses, err := manager.sync(loopbackCommand(address))
	if err != nil || len(statuses) != 1 || statuses[0].LoopbackAddress != address {
		t.Fatalf("sync: %#v %v", statuses, err)
	}

	// The nginx workers run as this test's user (no master: the daemon's own uid).
	dialAndSend(t, "tcp4", address)
	select {
	case connection := <-opened:
		if tracked, ok := connection.(*trackedConn); !ok || !tracked.loopback.Load() {
			t.Fatalf("served connection %T is not a loopback connection", connection)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the nginx worker's connection was not served")
	}
	dialAndSend(t, "unix", statuses[0].SocketPath)
	select {
	case <-opened:
	case <-time.After(2 * time.Second):
		t.Fatal("the Unix socket no longer serves next to the loopback endpoint")
	}

	// nginx runs its workers as another user: this process is any other local process now.
	authority.masterPID = func() (int, error) { return 1, nil }
	authority.workerUID = func(int, string) (int, error) { return os.Getuid() + 1, nil }
	// The refusal resets the connection at once, so on a fast loopback the reset can already reach the dial.
	refused, err := net.DialTimeout("tcp4", address, time.Second)
	if err == nil {
		t.Cleanup(func() { _ = refused.Close() })
		_ = refused.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = refused.Write([]byte("GET"))
	}
	select {
	case <-opened:
		t.Fatal("a process of another user reached the relay opener")
	case <-time.After(300 * time.Millisecond):
	}
	if err == nil {
		if _, err := refused.Read(make([]byte, 1)); err == nil {
			t.Fatal("the refused connection stays open")
		}
	}
}

func TestLoopbackPeerUIDIsThePeerSocketOwner(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.64.0.9:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	uid, err := secureLinkLoopbackPeerUID(server)
	if err != nil || uid != os.Getuid() {
		t.Fatalf("peer uid = %d, %v; want %d", uid, err, os.Getuid())
	}
}

// A stream that is really cut reaches nginx as a reset, after the bytes sent before it: never a clean end, which
// would complete a response without Content-Length or chunked framing. A normal end stays a normal close.
func TestLoopbackCutResetsAndNormalEndCloses(t *testing.T) {
	const response = "HTTP/1.0 200 OK\r\n\r\npartial body"
	ends := make(chan string, 1)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		_, _ = io.ReadFull(connection, make([]byte, 3))
		_, _ = connection.Write([]byte(response))
		switch <-ends {
		case "end":
			// The target finished its response: the relay's half close.
			_ = connection.(interface{ CloseWrite() error }).CloseWrite()
			_ = connection.Close()
		case "cut":
			// The relay stream failed.
			_ = connection.Close()
		case "eof":
			// nginx ended its side (it gave up on the response): the bridge reads that end, then closes.
			_, _ = io.Copy(io.Discard, connection)
			_ = connection.Close()
		case "crash":
			// The daemon process dies: the kernel closes the socket, no code of ours runs.
			_ = connection.(*trackedConn).Conn.Close()
		}
	})
	address := freeLoopbackAddress(t, "127.64.0.2")
	if _, err := manager.sync(loopbackCommand(address)); err != nil {
		t.Fatal(err)
	}
	for _, end := range []string{"end", "cut", "crash"} {
		connection := dialAndSend(t, "tcp4", address)
		ends <- end
		body, err := io.ReadAll(connection)
		switch end {
		case "end":
			if err != nil || string(body) != response {
				t.Fatalf("normal end: %q %v, want the whole response and a clean end", body, err)
			}
		default:
			if !errors.Is(err, syscall.ECONNRESET) {
				t.Fatalf("%s: read %q then %v, want a reset", end, body, err)
			}
			if !strings.HasPrefix(response, string(body)) {
				t.Fatalf("%s: read %q", end, body)
			}
		}
	}
	// nginx ends its side first (it gave up on the response): a normal close, no reset needed.
	connection := dialAndSend(t, "tcp4", address)
	_ = connection.(*net.TCPConn).CloseWrite()
	ends <- "eof"
	if body, err := io.ReadAll(connection); err != nil || string(body) != response {
		t.Fatalf("after nginx's end: %q %v", body, err)
	}
}

func TestLoopbackAddressesAreValidatedAndNeverShared(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	for _, address := range []string{"127.0.0.1:17613", "10.0.0.1:17613", "127.64.0.1:0", "localhost:1", "[::1]:17613"} {
		if _, err := manager.sync(loopbackCommand(address)); err == nil {
			t.Fatalf("loopback address %q accepted", address)
		}
	}
	command := plainAndMemberCommand()
	command.Bindings[0].LoopbackAddress = "127.64.0.3:17613"
	command.Bindings[1].LoopbackAddress = "127.64.0.3:17613"
	if _, err := manager.sync(command); err == nil || !strings.Contains(err.Error(), "share loopback address") {
		t.Fatalf("two links on one endpoint: %v", err)
	}
}

// A member the lease gate closes refuses on its loopback endpoint as on its socket (nginx moves to the next member
// before sending a byte), whatever the keeper holds, and serves again once its candidate holds the lease.
func TestLoopbackEndpointFollowsTheLeaseGate(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	command := availabilityMemberCommand("policy-1", "node-a")
	address := freeLoopbackAddress(t, "127.64.0.4")
	command.Bindings[0].LoopbackAddress = address
	if _, err := manager.sync(command); err != nil {
		t.Fatal(err)
	}
	for cycle := 0; cycle < 20; cycle++ {
		if _, err := net.DialTimeout("tcp4", address, time.Second); !errors.Is(err, syscall.ECONNREFUSED) {
			t.Fatalf("closed member endpoint: %v, want ECONNREFUSED", err)
		}
		if err := manager.setLeaseOpen(testSecureLinkID, true); err != nil {
			t.Fatal(err)
		}
		connection, err := net.DialTimeout("tcp4", address, time.Second)
		if err != nil {
			t.Fatalf("open member endpoint refused: %v", err)
		}
		_ = connection.Close()
		if err := manager.setLeaseOpen(testSecureLinkID, false); err != nil {
			t.Fatal(err)
		}
	}
}

// A restart hands the loopback endpoint to the next process like the socket: connections made while no process
// serves it wait in its backlog and are served by the next one.
func TestRestartHandsLoopbackEndpointsToTheNextProcess(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)
	address := freeLoopbackAddress(t, "127.64.0.5")
	first := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	if _, err := first.sync(loopbackCommand(address)); err != nil {
		t.Fatal(err)
	}
	store.Settle(time.Second)
	if kept := store.Names(); len(kept) != 2 {
		t.Fatalf("kept = %v, want the socket and the loopback endpoint", kept)
	}
	if handed := first.suspendForHandover(); handed != 2 {
		t.Fatalf("handed over %d listeners", handed)
	}
	waiting := dialAndSend(t, "tcp4", address)

	connectKeeper(t, store, inheritedFrom(t, store))
	served := make(chan struct{}, 1)
	second := testSourceLinkManager(t, func(_ string, connection net.Conn) {
		served <- struct{}{}
		_ = connection.Close()
	})
	second.socketDir = first.socketDir
	statuses, err := second.sync(loopbackCommand(address))
	if err != nil || statuses[0].LoopbackAddress != address {
		t.Fatalf("sync: %#v %v", statuses, err)
	}
	select {
	case <-served:
	case <-time.After(2 * time.Second):
		t.Fatal("a connection made during the restart was not served by the next process")
	}
	_ = waiting
	if released := listenerkeep.ReleaseUnclaimed(first.socketDir + "/"); len(released) != 0 {
		t.Fatalf("listeners left unclaimed: %v", released)
	}
}

// A rotation keeps the loopback endpoint listening: the successor binding takes the socket over.
func TestRotationKeepsTheLoopbackEndpoint(t *testing.T) {
	manager := testSourceLinkManager(t, func(_ string, connection net.Conn) { _ = connection.Close() })
	address := freeLoopbackAddress(t, "127.64.0.6")
	if _, err := manager.sync(loopbackCommand(address)); err != nil {
		t.Fatal(err)
	}
	rotate := loopbackCommand(address)
	rotate.Bindings[0].Generation = 2
	rotate.Bindings[0].RotateListener = true
	statuses, err := manager.sync(rotate)
	if err != nil || statuses[0].LoopbackAddress != address {
		t.Fatalf("rotation: %#v %v", statuses, err)
	}
	dialAndSend(t, "tcp4", address)
	manager.mu.Lock()
	binding := manager.bindings[testSecureLinkID]
	manager.mu.Unlock()
	waitFor(t, "the rotated binding to serve the endpoint", func() bool {
		binding.leaseMu.Lock()
		defer binding.leaseMu.Unlock()
		return binding.loop != nil
	})
}

// A live update hands an in-flight loopback connection to the next process byte-exact, and it keeps its reset on
// a cut there: SO_LINGER belongs to the socket, and the next process resets what it cuts.
func TestLiveHandoverKeepsLoopbackConnectionAndItsResetOnCut(t *testing.T) {
	keeper := handovertest.NewKeeper()
	previousKeeper, previousExit := handoverKeeper, exitingForUpdate
	handoverKeeper, exitingForUpdate = keeper, func() bool { return true }
	t.Cleanup(func() { handoverKeeper, exitingForUpdate = previousKeeper, previousExit })

	target := newResumeTarget()
	_, near := startResumeRelay(t, "relay-near", target)
	_, far := startResumeRelay(t, "relay-far", target)
	old := handoverPlugin(t)
	stopOld := startHandoverLanes(t, old, near, far)

	address := freeLoopbackAddress(t, "127.64.0.7")
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	old.secureLinks.bindings[testSecureLinkID].loopAddr = address
	client, err := net.Dial("tcp4", address)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	daemonSide, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	// As serve does for a loopback endpoint.
	tracked := newTrackedConn(daemonSide).(*trackedConn)
	_ = setSocketLinger(daemonSide, 0)
	tracked.loopback.Store(true)
	go old.openProxySecureLink(testSecureLinkID, tracked)
	_ = client.SetDeadline(time.Now().Add(20 * time.Second))
	connection := &linkConnection{t: t, client: client, done: make(chan struct{})}
	connection.roundTrip(64 * 1024)
	session := onlySession(t, old)
	waitFor(t, "the stream to open", func() bool { return session.State() == relayresume.StateOpen })

	result := old.handOverConnections()
	if !result.Committed || result.HandedOver != 1 || len(result.Cut) > 0 {
		t.Fatalf("handover: %+v", result)
	}
	stopOld()
	if err := keeper.Restart(); err != nil {
		t.Fatal(err)
	}
	next := handoverPlugin(t)
	next.secureLinks.bindings[testSecureLinkID].loopAddr = address
	next.restoreHandover()
	startHandoverLanes(t, next, near, far)
	connection.roundTrip(256 * 1024)

	binding := next.secureLinks.bindings[testSecureLinkID]
	binding.activeMu.Lock()
	var restored *trackedConn
	for active, authorized := range binding.active {
		if !authorized {
			t.Fatal("the restored loopback connection counts as a legacy one")
		}
		restored = active.(*trackedConn)
	}
	binding.activeMu.Unlock()
	if restored == nil || !restored.loopback.Load() {
		t.Fatal("the restored connection is not a loopback connection")
	}
	// The next process cuts it (its link went away): nginx sees a reset, not the end of the response.
	next.secureLinks.closeActive(testSecureLinkID)
	if _, err := io.ReadAll(client); !errors.Is(err, syscall.ECONNRESET) {
		t.Fatalf("cut after the handover: %v, want a reset", err)
	}
}
