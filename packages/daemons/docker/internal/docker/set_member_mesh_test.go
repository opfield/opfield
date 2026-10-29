package docker

import (
	"bufio"
	"context"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/api/types/network"
)

const meshTestSet = "11111111-1111-4111-8111-111111111111"

func newTestMesh(t *testing.T) (*setMesh, chan string) {
	t.Helper()
	bridged := make(chan string, 8)
	mesh := &setMesh{sets: map[string]*setMeshSet{}, wake: make(chan struct{}, 1)}
	mesh.inspect = func(context.Context, string) (netip.Addr, bool, error) {
		return netip.MustParseAddr("127.0.0.1"), true, nil
	}
	mesh.listen = func(string) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	mesh.bridge = func(conn net.Conn, setID, alias string) error {
		bridged <- setID + " " + alias
		_, _ = conn.Write([]byte("relay " + alias + "\n"))
		_ = conn.Close()
		return nil
	}
	return mesh, bridged
}

func meshListenerAddr(t *testing.T, mesh *setMesh, host string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mesh.mu.Lock()
		for _, l := range mesh.sets[meshTestSet].listeners {
			if l.spec.host == host {
				addr := l.listener.Addr().String()
				mesh.mu.Unlock()
				return addr
			}
		}
		mesh.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no listener for %s", host)
	return ""
}

func readLine(t *testing.T, addr string) string {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	line, _ := bufio.NewReader(conn).ReadString('\n')
	return strings.TrimSpace(line)
}

func TestSetMeshCarriesExposedHostsToTheirAliases(t *testing.T) {
	mesh, bridged := newTestMesh(t)
	peer := "member-33333333-3333-4333-8333-333333333333-sw-volume"
	mesh.Expose(meshTestSet, "member-33333333-3333-4333-8333-333333333333-sw-volume", 20002, peer)
	mesh.Expose(meshTestSet, "bad host", 1, "not-an-alias")
	if got := readLine(t, meshListenerAddr(t, mesh, "member-33333333-3333-4333-8333-333333333333-sw-volume")); got != "relay "+peer {
		t.Fatalf("got %q", got)
	}
	if got := <-bridged; got != meshTestSet+" "+peer {
		t.Fatalf("bridged %q", got)
	}
	hosts := mesh.ExtraHosts(meshTestSet)
	if len(hosts) != 1 || hosts[0] != "member-33333333-3333-4333-8333-333333333333-sw-volume:127.0.0.1" {
		t.Fatalf("extra hosts %v", hosts)
	}
}

func TestSetMeshDialsTheLocalPrimaryWhileItServes(t *testing.T) {
	mesh, bridged := newTestMesh(t)
	mesh.Expose(meshTestSet, "primary-sw-master", 9333, "primary-sw-master")
	var local atomic.Bool
	local.Store(true)
	mesh.SetLocalPrimary(meshTestSet, func(_ context.Context, port string) (net.Conn, bool) {
		if !local.Load() || port != "sw-master" {
			return nil, false
		}
		client, server := net.Pipe()
		go func() { _, _ = server.Write([]byte("local\n")); _ = server.Close() }()
		return client, true
	})
	addr := meshListenerAddr(t, mesh, "primary-sw-master")
	if got := readLine(t, addr); got != "local" {
		t.Fatalf("the primary's own components reach its master locally, got %q", got)
	}
	local.Store(false)
	if got := readLine(t, addr); got != "relay primary-sw-master" {
		t.Fatalf("a copy reaches the primary through the relays, got %q", got)
	}
	<-bridged
}

func TestSetMeshNetworkNameIsStable(t *testing.T) {
	name := setMeshNetworkName(meshTestSet)
	if name != setMeshNetworkName(strings.ToUpper(meshTestSet)) || !strings.HasPrefix(name, "opfield-set-") || len(name) != len("opfield-set-")+16 {
		t.Fatalf("network name %q", name)
	}
	// A set that joined the node before 2.12.1 keeps its network; a start the launcher may still roll back names a
	// new one the earlier way.
	names := setMeshNetworkNames(meshTestSet)
	if len(names) != 2 || names[0] != name || names[1] != legacycompat.SetNetworkPrefix+strings.TrimPrefix(name, "opfield-set-") {
		t.Fatalf("network names %v", names)
	}
	withOpfieldNamesActive(t, false)
	if got := setMeshNetworkName(meshTestSet); got != names[1] {
		t.Fatalf("network name before the confirmed start %q", got)
	}
}

// A member's set network created before 2.12.1 stays its network: the mesh binds on it and the member reaches the
// engine through it.
func TestSetMeshKeepsTheNetworkASetHasOnTheNode(t *testing.T) {
	mesh, _ := newTestMesh(t)
	legacy := setMeshNetworkNames(meshTestSet)[1]
	mesh.inspect = func(_ context.Context, name string) (netip.Addr, bool, error) {
		return netip.MustParseAddr("127.0.0.1"), name == legacy, nil
	}
	if got, err := mesh.NetworkName(context.Background(), meshTestSet); err != nil || got != legacy {
		t.Fatalf("network %q, %v", got, err)
	}
	if !mesh.refresh(meshTestSet) {
		t.Fatal("the set's earlier network was not found")
	}
	endpoint := &network.EndpointSettings{}
	if setMeshEndpoint(map[string]*network.EndpointSettings{legacy: endpoint}, meshTestSet) != endpoint {
		t.Fatal("a member on the earlier network has no endpoint")
	}
}

// A member connection the relays cannot carry shows in the node logs: the
// route's first failure as a warning, the next ones at info.
func TestSetMeshLogsAFailedRouteOpenOnceAsWarning(t *testing.T) {
	var logs strings.Builder
	mesh := &setMesh{plugin: &DockerPlugin{logger: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))}}
	mesh.logBridgeFailure(meshTestSet, "m-0.pg", errRelayLaneUnavailable)
	mesh.logBridgeFailure(meshTestSet, "m-0.pg", errRelayLaneUnavailable)
	mesh.logBridgeFailure(meshTestSet, "m-1.pg", errRelayLaneUnavailable)
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %q", logs.String())
	}
	for i, level := range []string{"level=WARN", "level=INFO", "level=WARN"} {
		if !strings.Contains(lines[i], level) || !strings.Contains(lines[i], "no relay transport") {
			t.Fatalf("line %d: want %s with the error, got %q", i, level, lines[i])
		}
	}
}

// A set's alias listeners never outlive it: when its network is gone (or the
// set is released) the address is free again, so the next set that gets the
// same subnet binds its listeners; a listener that cannot bind is reported.
func TestSetMeshFreesTheAddressesOfASetThatLeft(t *testing.T) {
	const nextSet = "22222222-2222-4222-8222-222222222222"
	mesh, _ := newTestMesh(t)
	mesh.listen = func(address string) (net.Listener, error) { return net.Listen("tcp", address) }
	var mu sync.Mutex
	networks := map[string]bool{setMeshNetworkName(meshTestSet): true, setMeshNetworkName(nextSet): true}
	mesh.inspect = func(_ context.Context, name string) (netip.Addr, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		return netip.MustParseAddr("127.0.0.1"), networks[name], nil
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := uint16(probe.Addr().(*net.TCPAddr).Port)
	address := probe.Addr().String()
	_ = probe.Close()

	mesh.Expose(meshTestSet, "primary-pg-repl", port, "primary-pg-repl")
	meshListenerAddr(t, mesh, "primary-pg-repl")
	if !mesh.boundIn(netip.MustParsePrefix("127.0.0.0/26")) {
		t.Fatal("the bound subnet must not be handed out")
	}
	// The set was deleted and its network removed: its listener goes too.
	mu.Lock()
	networks[setMeshNetworkName(meshTestSet)] = false
	mu.Unlock()
	mesh.reconcile()
	if conn, err := net.Dial("tcp", address); err == nil {
		conn.Close()
		t.Fatal("the listener of a set whose network is gone must be closed")
	}
	mesh.Release(context.Background(), meshTestSet)
	if mesh.boundIn(netip.MustParsePrefix("127.0.0.0/26")) {
		t.Fatal("a released set binds nothing")
	}
	// The next set on the same subnet binds the same address.
	mesh.Expose(nextSet, "primary-pg-repl", port, "primary-pg-repl")
	mesh.reconcile()
	if failed := mesh.BindError(nextSet); failed != "" {
		t.Fatalf("the next set must bind: %s", failed)
	}
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("the next set's listener: %v", err)
	}
	conn.Close()

	// Something else holds an alias address: the member says so.
	mesh.Release(context.Background(), nextSet)
	holder, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	mesh.Expose(nextSet, "primary-pg-repl", port, "primary-pg-repl")
	mesh.reconcile()
	if failed := mesh.BindError(nextSet); !strings.Contains(failed, "could not bind") {
		t.Fatalf("a bind failure must be reported, got %q", failed)
	}
}

// A single node that turns into a set's first member runs its master before
// any lease or member runtime names it the primary: its own volume server and
// filer reach that master through the origin dialer (stand rc.1: "the volume
// server has not registered"), and the member runtime takes over once it
// serves the alias itself.
func TestSetMeshServesTheOriginsOwnMasterUntilTheMemberRuntimeTakesOver(t *testing.T) {
	mesh, bridged := newTestMesh(t)
	mesh.Expose(meshTestSet, "primary-sw-master", 9333, "primary-sw-master")
	pipe := func(text string) (net.Conn, bool) {
		client, server := net.Pipe()
		go func() { _, _ = server.Write([]byte(text + "\n")); _ = server.Close() }()
		return client, true
	}
	var runtimeServes atomic.Bool
	mesh.SetLocalPrimary(meshTestSet, func(_ context.Context, port string) (net.Conn, bool) {
		if !runtimeServes.Load() {
			return nil, false
		}
		return pipe("runtime")
	})
	release := mesh.SetOriginPrimary(meshTestSet, func(_ context.Context, port string) (net.Conn, bool) {
		if port != "sw-master" {
			return nil, false
		}
		return pipe("origin")
	})
	addr := meshListenerAddr(t, mesh, "primary-sw-master")
	if got := readLine(t, addr); got != "origin" {
		t.Fatalf("the converting origin reaches its own master, got %q", got)
	}
	runtimeServes.Store(true)
	if got := readLine(t, addr); got != "runtime" {
		t.Fatalf("the member runtime serves the primary alias once it can, got %q", got)
	}
	runtimeServes.Store(false)
	if got := readLine(t, addr); got != "relay primary-sw-master" {
		t.Fatalf("the origin dialer is gone once the member runtime served the alias, got %q", got)
	}
	<-bridged
	release()
	mesh.SetOriginPrimary(meshTestSet, func(context.Context, string) (net.Conn, bool) { return pipe("origin") })()
	if got := readLine(t, addr); got != "relay primary-sw-master" {
		t.Fatalf("a released origin dialer serves nothing, got %q", got)
	}
	<-bridged
}
