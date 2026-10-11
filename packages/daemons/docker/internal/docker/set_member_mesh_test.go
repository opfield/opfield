package docker

import (
	"bufio"
	"context"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"
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
	local := true
	mesh.SetLocalPrimary(meshTestSet, func(_ context.Context, port string) (net.Conn, bool) {
		if !local || port != "sw-master" {
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
	local = false
	if got := readLine(t, addr); got != "relay primary-sw-master" {
		t.Fatalf("a copy reaches the primary through the relays, got %q", got)
	}
	<-bridged
}

func TestSetMeshNetworkNameIsStable(t *testing.T) {
	name := setMeshNetworkName(meshTestSet)
	if name != setMeshNetworkName(strings.ToUpper(meshTestSet)) || !strings.HasPrefix(name, "gateway-set-") || len(name) != len("gateway-set-")+16 {
		t.Fatalf("network name %q", name)
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
