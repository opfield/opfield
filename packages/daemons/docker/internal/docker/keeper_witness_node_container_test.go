//go:build chhacontainer

package docker

// Smoke test of a Keeper witness container on a docker node (decision 8):
// ApplyWitnesses persists the set, the reconcile pass pulls the pinned
// clickhouse-keeper image, runs it on its own network with the daemon-rendered
// config, binds the members' endpoints in its network namespace, serves its
// raft port through the witness endpoint target, and removes it once it left
// the set. Run as root against a private Docker engine:
//
//	DOCKER_HOST=unix:///run/x/docker.sock go test -tags chhacontainer -run TestNodeKeeperWitnessContainer ./internal/docker/

import (
	"context"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	mobyclient "github.com/moby/moby/client"

	"github.com/opfield/opfield/daemon-shared/handover"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/docker-daemon/internal/chha"
	"github.com/opfield/opfield/docker-daemon/internal/config"
)

func TestNodeKeeperWitnessContainer(t *testing.T) {
	host := os.Getenv("DOCKER_HOST")
	if host == "" {
		t.Skip("DOCKER_HOST is not set")
	}
	if os.Geteuid() != 0 {
		t.Skip("the witness forwarders bind in the container's network namespace: run as root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	root := t.TempDir()
	for _, path := range []string{filepath.Dir(root), root} {
		_ = os.Chmod(path, 0o755)
	}
	client, err := NewClient(host, filepath.Join(root, "client"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	cfg := &config.Config{}
	cfg.StateDir = filepath.Join(root, "state")
	if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{cfg: cfg, client: client, logger: logger, handover: handover.NewRegistry(),
		relayGrants: &relayGrantStore{current: &pb.SyncRelayGrantsCommand{}, changed: make(chan struct{}, 1)}}
	w := &nodeKeeperWitnesses{p: plugin, dir: filepath.Join(cfg.StateDir, "keeper-witnesses"), logger: logger,
		desired: map[string]*pb.WitnessSpec{}, forwarders: map[string]*chha.Forwarders{}, containers: map[string]string{},
		wake: make(chan struct{}, 1)}
	plugin.keeperWitnesses = w

	const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	name := keeperWitnessName(id)
	t.Cleanup(func() {
		w.remove(context.Background(), id, name)
	})
	spec := &pb.WitnessSpec{Id: id, SetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Kind: "clickhouse_keeper", Role: "active",
		Artifact: &pb.WitnessArtifact{Version: defaultKeeperWitnessVersion}, ServerId: 1001, ClientPort: 39432, RaftPort: 39433,
		RaftHost: "127.48.54.1", Peers: []*pb.WitnessPeer{
			{ServerId: 1, Host: "127.48.54.1", Port: 39501, RouteId: "route-a"},
			{ServerId: 2, Host: "127.48.54.1", Port: 39502, RouteId: "route-b"},
		}}
	result := &pb.CommandResult{}
	plugin.handleApplyKeeperWitnesses(&pb.ApplyWitnessesCommand{Revision: 1, Witnesses: []*pb.WitnessSpec{spec}}, result)
	if !result.Success {
		t.Fatalf("apply: %s", result.Error)
	}
	if _, err := os.Stat(w.desiredPath()); err != nil {
		t.Fatalf("the desired set was not persisted: %v", err)
	}
	w.reconcile(ctx)

	inspect, err := client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if err != nil {
		t.Fatalf("witness container: %v", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		t.Fatalf("witness container is not running: %+v", inspect.Container.State)
	}
	if user := inspect.Container.Config.User; user != strconv.Itoa(clickHouseUID)+":"+strconv.Itoa(clickHouseUID) {
		t.Fatalf("witness runs as %q", user)
	}
	address, port, err := w.target(id)
	if err != nil {
		t.Fatal(err)
	}
	// The raft port serves through the witness endpoint target. (The client
	// port opens only once the Keeper has a quorum: its members do not exist
	// here.) The Keeper keeps running and is not restarted.
	raft := net.JoinHostPort(address, strconv.FormatUint(uint64(port), 10))
	served := false
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) && !served {
		if conn, err := net.DialTimeout("tcp", raft, 2*time.Second); err == nil {
			_ = conn.Close()
			served = true
			break
		}
		time.Sleep(time.Second)
	}
	time.Sleep(5 * time.Second)
	later, err := client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if !served || err != nil || later.Container.State == nil || !later.Container.State.Running || later.Container.RestartCount != 0 {
		out, _ := client.cli.ContainerLogs(ctx, name, mobyclient.ContainerLogsOptions{ShowStdout: true, ShowStderr: true, Tail: "40"})
		var logs []byte
		if out != nil {
			logs, _ = io.ReadAll(out)
			_ = out.Close()
		}
		t.Fatalf("the witness Keeper does not serve its raft port %s (served %v, inspect err %v)\n%s", raft, served, err, logs)
	}
	conn, err := plugin.dialWitness(ctx, &pb.RelayGrantAssignment{OwnerId: id})
	if err != nil {
		t.Fatalf("witness endpoint dial: %v", err)
	}
	_ = conn.Close()
	w.mu.Lock()
	fw := w.forwarders[id]
	w.mu.Unlock()
	if fw == nil {
		t.Fatal("no forwarders for the witness")
	}
	// Each member endpoint is bound in the witness's network namespace (the
	// connection reaches the forwarder; the route itself does not exist here).
	pid := inspect.Container.State.Pid
	for _, endpoint := range []string{"127.48.54.1:39501", "127.48.54.1:39502"} {
		if !listeningInNetns(t, pid, endpoint) {
			t.Fatalf("member endpoint %s is not bound in the witness namespace", endpoint)
		}
	}

	// A second pass changes nothing; leaving the set removes container, network and data.
	w.reconcile(ctx)
	again, err := client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{})
	if err != nil || again.Container.ID != inspect.Container.ID {
		t.Fatalf("a second pass recreated the witness: %v", err)
	}
	result = &pb.CommandResult{}
	plugin.handleApplyKeeperWitnesses(&pb.ApplyWitnessesCommand{Revision: 2}, result)
	if !result.Success {
		t.Fatalf("apply empty: %s", result.Error)
	}
	w.reconcile(ctx)
	if _, err := client.cli.ContainerInspect(ctx, name, mobyclient.ContainerInspectOptions{}); err == nil || !isNotFoundErr(err) {
		t.Fatalf("the witness container is still there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(w.dir, id)); !os.IsNotExist(err) {
		t.Fatalf("the witness data was kept: %v", err)
	}
}

// listeningInNetns reads the TCP listeners of the namespace of pid.
func listeningInNetns(t *testing.T, pid int, endpoint string) bool {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "net", "tcp"))
	if err != nil {
		t.Fatal(err)
	}
	hostPart, portPart, _ := net.SplitHostPort(endpoint)
	ip := net.ParseIP(hostPart).To4()
	port, _ := strconv.Atoi(portPart)
	// /proc/net/tcp: little-endian hex address, big-endian hex port, state 0A = LISTEN.
	want := strings.ToUpper(hexByte(ip[3]) + hexByte(ip[2]) + hexByte(ip[1]) + hexByte(ip[0]) + ":" + hex16(port))
	for _, line := range strings.Split(string(data), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) > 3 && fields[1] == want && fields[3] == "0A" {
			return true
		}
	}
	return false
}

func hexByte(b byte) string { return strings.ToUpper(strconv.FormatUint(uint64(b)|0x100, 16)[1:]) }

func hex16(v int) string { return strings.ToUpper(strconv.FormatUint(uint64(v)|0x10000, 16)[1:]) }
