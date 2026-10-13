package docker

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// connectKeeper makes this test process a daemon process started by a launcher whose keeper is store, having
// inherited the listeners in inherited (keeper name -> descriptor).
func connectKeeper(t *testing.T, store *listenerkeep.Store, inherited map[string]*os.File) {
	t.Helper()
	files, _, release := store.ChildFiles(3)
	release()
	channel, err := syscall.Dup(int(files[0].Fd()))
	if err != nil {
		t.Fatal(err)
	}
	type kept struct {
		Name string `json:"name"`
		FD   int    `json:"fd"`
	}
	descriptors := []kept{}
	for name, file := range inherited {
		// The next process owns its inherited descriptors alone, as one the launcher started does: a second owner (this
		// test's *os.File) would close the descriptor when the garbage collector finalizes it, under the process, and
		// later a descriptor that reused the number (seen as listeners not kept or not adopted under load).
		fd, err := syscall.Dup(int(file.Fd()))
		if err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
		descriptors = append(descriptors, kept{Name: name, FD: fd})
	}
	encoded, _ := json.Marshal(descriptors)
	t.Setenv("GATEWAY_DAEMON_LAUNCHER_MANAGED", "1")
	t.Setenv(listenerkeep.ChannelFDEnv, strconv.Itoa(channel))
	t.Setenv(listenerkeep.KeptEnv, string(encoded))
	listenerkeep.ReinitForTest()
	t.Cleanup(func() {
		_ = os.Unsetenv("GATEWAY_DAEMON_LAUNCHER_MANAGED")
		listenerkeep.ReinitForTest()
	})
}

// inheritedFrom hands the listeners store keeps to the next process, the way the launcher starts it.
func inheritedFrom(t *testing.T, store *listenerkeep.Store) map[string]*os.File {
	t.Helper()
	store.Settle(keeperSettleWait)
	names := store.Names()
	files, _, _ := store.ChildFiles(3)
	inherited := map[string]*os.File{}
	for index, name := range names {
		inherited[name] = files[1+index]
	}
	return inherited
}

// A restart of the daemon refused every new database link connection until the next process listened. The
// host listener goes to the next process: a connection made while no process serves waits in the backlog and is
// served by the next one, and the connection the stopping process serves stays until its drain.
func TestRestartHandsDatabaseLinkListenersToTheNextProcess(t *testing.T) {
	store, err := listenerkeep.OpenStore(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connectKeeper(t, store, nil)

	first := newListenerHarness(t)
	assignment := first.assignment(testListenerBindingA, 3, 64)
	if status := first.reconcile(assignment)[testListenerBindingA]; status.State != "ready" {
		t.Fatalf("listener status %+v", status)
	}
	store.Settle(keeperSettleWait)
	name := hostListenerKeepName(netip.MustParseAddr("127.0.0.1"), first.port)
	if kept := store.Names(); len(kept) != 1 || kept[0] != name {
		t.Fatalf("kept %v, want %s", kept, name)
	}
	held := first.dial()
	first.waitOpened(1)

	// The daemon is asked to stop.
	if handed := first.manager.suspendForHandover(); handed != 1 {
		t.Fatalf("handed over %d listeners", handed)
	}
	// A sync that still arrives changes nothing.
	first.reconcile(first.assignment(testListenerBindingA, 4, 64))
	waiting := first.dial()
	if _, err := waiting.Write([]byte("startup")); err != nil {
		t.Fatal(err)
	}
	requireOpen(t, held)

	// The next process starts with the kept listener.
	connectKeeper(t, store, inheritedFrom(t, store))
	second := newListenerHarness(t)
	second.port = first.port
	second.manager.adoptKeptListeners(nil)
	if status := second.reconcile(assignment)[testListenerBindingA]; status.State != "ready" {
		t.Fatalf("next process listener status %+v", status)
	}
	second.waitOpened(1)
	second.manager.releaseAdopted(nil)
	if len(first.openedBindings()) != 1 {
		t.Fatal("the stopping process served a connection made after it handed over")
	}
	requireOpen(t, held)
}

// Restarting, the daemon lets the link connections in the middle of a request finish and closes idle ones at once.
func TestLinkFlowDrainClosesIdleConnectionsAndWaitsForRequests(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	pair := func() (client net.Conn, server net.Conn) {
		client, err := net.Dial("tcp4", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		server, err = listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { client.Close(); server.Close() })
		return client, server
	}
	var flows linkFlowSet
	busyClient, busyServer := pair()
	idleClient, idleServer := pair()
	busy, _ := flows.track(busyServer)
	idle, _ := flows.track(idleServer)
	buffer := make([]byte, 16)
	for _, exchange := range []struct {
		client net.Conn
		server *linkFlowConn
		answer bool
	}{{busyClient, busy, false}, {idleClient, idle, true}} {
		_, _ = exchange.client.Write([]byte("query"))
		if _, err := exchange.server.Read(buffer); err != nil {
			t.Fatal(err)
		}
		if exchange.answer {
			_, _ = exchange.server.Write([]byte("rows"))
			_, _ = exchange.client.Read(buffer)
		}
	}

	result := make(chan int, 1)
	go func() { result <- flows.drain(2 * time.Second) }()
	requireClosed(t, idleClient)
	requireOpen(t, busyClient)
	_, _ = busy.Write([]byte("rows"))
	select {
	case remaining := <-result:
		if remaining != 0 {
			t.Fatalf("%d connections left busy", remaining)
		}
	case <-time.After(time.Second):
		t.Fatal("drain did not end once the request was answered")
	}
	if _, err := busyClient.Read(buffer); err != nil {
		t.Fatalf("answered request lost: %v", err)
	}
}

// Right after a start, a link connection that finds no relay lane waits for one instead of being refused at once;
// later it waits only the short transient hold (a relay restarting), not the start's wait.
func TestRelaySourceWaitsForLanesOnlyAfterTheStart(t *testing.T) {
	previous := relaySourceTransientWait
	relaySourceTransientWait = 400 * time.Millisecond
	t.Cleanup(func() { relaySourceTransientWait = previous })
	assignment := &pb.RelayGrantAssignment{Role: "connect", OwnerKind: linkKindManagedDatabaseBinding, OwnerId: testListenerBindingA,
		Grant: &pb.RelaySignedGrant{KeyId: "key-1", Payload: []byte(`{}`)}}
	plugin := &DockerPlugin{startedAt: time.Now().Add(-relayLaneStartupWait + 300*time.Millisecond)}
	started := time.Now()
	if _, err := plugin.openRelaySource(assignment); !errors.Is(err, errRelayLaneUnavailable) {
		t.Fatalf("open without lanes: %v", err)
	}
	if waited := time.Since(started); waited < 200*time.Millisecond {
		t.Fatalf("waited %v for lanes right after the start", waited)
	}
	plugin.startedAt = time.Now().Add(-relayLaneStartupWait)
	started = time.Now()
	if _, err := plugin.openRelaySource(assignment); !errors.Is(err, errRelayLaneUnavailable) {
		t.Fatalf("open without lanes long after the start: %v", err)
	}
	if waited := time.Since(started); waited < 200*time.Millisecond || waited > 2*time.Second {
		t.Fatalf("waited %v for lanes long after the start, want the transient hold", waited)
	}
}

// After a restart it announced to the relays, the next process registers its endpoints at once; otherwise it waits
// for Opfield's first bundle.
func TestAnnouncedRestartSkipsTheRegistrationHold(t *testing.T) {
	stateDir := t.TempDir()
	if err := relayGrantStateFile(stateDir).Write(&pb.SyncRelayGrantsCommand{PolicyRevision: 1}); err != nil {
		t.Fatal(err)
	}
	if err := writeRestartMarker(stateDir, time.Now()); err != nil {
		t.Fatal(err)
	}
	store, err := newRelayGrantStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if hold := store.registrationHold(time.Now()); hold != 0 {
		t.Fatalf("hold after an announced restart %v", hold)
	}
	if _, err := os.Stat(restartMarkerPath(stateDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("restart marker not consumed")
	}
	if store, _ = newRelayGrantStore(stateDir); store.registrationHold(time.Now()) == 0 {
		t.Fatal("a start without an announced restart registered before Gateway's bundle")
	}
	_ = writeRestartMarker(stateDir, time.Now().Add(-restartMarkerValid))
	if store, _ = newRelayGrantStore(stateDir); store.registrationHold(time.Now()) == 0 {
		t.Fatal("an old restart announcement skipped the hold")
	}
}

// PAAS-06: the boot step opens the listeners the daemon held last before Docker starts the workloads; a connection
// made before the daemon runs waits in the backlog and is served once the daemon took the socket over.
func TestBootHeldListenerServesAConnectionMadeBeforeTheDaemon(t *testing.T) {
	stateDir := sockettest.Dir(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := newListenerHarness(t)
	h.manager.stateDir = stateDir
	assignment := h.assignment(testListenerBindingA, 3, 64)
	h.reconcile(assignment)
	set, err := os.ReadFile(linkListenerBootPath(stateDir, linkListenerSetFile))
	if err != nil || string(set) != `{"listeners":[{"address":"127.0.0.1","port":`+strconv.Itoa(int(h.port))+`}]}` {
		t.Fatalf("recorded listeners %s %v", set, err)
	}
	// Only addresses a binding network's gateway can have are opened at boot.
	if valid, _ := readLinkListenerSet(stateDir); len(valid) != 0 {
		t.Fatalf("loopback opened at boot: %v", valid)
	}
	h.manager.mu.Lock()
	h.manager.listeners[testListenerBindingA].close()
	delete(h.manager.listeners, testListenerBindingA)
	h.manager.mu.Unlock()

	// The address of a bridge Docker has not created yet binds (IP_FREEBIND).
	if file, err := bindFreeListener(netip.MustParseAddr("10.255.254.1"), h.port); err != nil {
		t.Fatalf("bind before the bridge exists: %v", err)
	} else {
		file.Close()
	}

	file, err := bindFreeListener(netip.MustParseAddr("127.0.0.1"), h.port)
	if err != nil {
		t.Fatal(err)
	}
	name := hostListenerKeepName(netip.MustParseAddr("127.0.0.1"), h.port)
	ready := make(chan struct{})
	held := make(chan error, 1)
	go func() {
		held <- holdLinkListeners(stateDir, []string{name}, []*os.File{file}, 10*time.Second, func() { close(ready) }, logger)
	}()
	// The holder fails before it is ready when it cannot listen (a socket path past the 108-byte limit): fail, not hang.
	select {
	case <-ready:
	case err := <-held:
		t.Fatalf("the holder ended before it was ready: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the holder never got ready")
	}
	early := h.dial()
	if _, err := early.Write([]byte("startup")); err != nil {
		t.Fatal(err)
	}

	boot := takeBootHeldListeners(stateDir, logger)
	if len(boot) != 1 || boot[name] == nil {
		t.Fatalf("handed over %v", boot)
	}
	select {
	case err := <-held:
		if err != nil {
			t.Fatalf("holder: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the holder did not end after the handover")
	}
	h.manager.adoptKeptListeners(boot)
	if status := h.reconcile(assignment)[testListenerBindingA]; status.State != "ready" {
		t.Fatalf("listener status %+v", status)
	}
	h.waitOpened(1)
	if takeBootHeldListeners(stateDir, logger) != nil {
		t.Fatal("the holder handed its listeners over twice")
	}
}
