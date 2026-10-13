//go:build kvhacontainer

package docker

// Container test of Valkey availability members (P2-T03): two members on one
// Docker host, each on its own network with the daemon's member files (ha.conf,
// replication user); the test process plays the member mesh (primary-kv-repl
// carried to the primary's gated DialPeer) and drives the kvha engines like
// the member runtime. Run on a build host with a Docker engine:
//
//	DOCKER_HOST=unix:///run/hasw-docker/docker.sock go test -tags kvhacontainer -run TestValkeySetContainers -v ./internal/docker/

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/kvha"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
)

const (
	kvSet       = "abababab-abab-4aba-8aba-abababababab"
	kvA         = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd"
	kvB         = "efefefef-efef-4efe-8efe-efefefefefef"
	kvOwnerPass = "owner-password-0123456789"
	kvReplPass  = "replication-password-0123456789"
	kvImage     = "docker.io/valkey/valkey-bundle@sha256:dd30c59c2b2a598e83308095220a31d6d93d64c40a839c702cb1e98c8e220660"
)

type kvMesh struct {
	mu      sync.Mutex
	hosts   map[string]*kvTestHost
	primary string
}

type kvTestHost struct {
	mesh     *kvMesh
	cfg      memberha.Config
	name     string
	network  string
	gateway  netip.Addr
	local    func(context.Context, string) (net.Conn, bool)
	engine   *kvha.Engine
	mu       sync.Mutex
	isolated bool
}

func (h *kvTestHost) down() bool              { h.mu.Lock(); defer h.mu.Unlock(); return h.isolated }
func (h *kvTestHost) Config() memberha.Config { return h.cfg }

func (h *kvTestHost) inspect() map[string]any {
	out, err := dockerCLI("inspect", h.name)
	if err != nil {
		return nil
	}
	var parsed []map[string]any
	_ = json.Unmarshal([]byte(out), &parsed)
	if len(parsed) == 0 {
		return nil
	}
	return parsed[0]
}

func (h *kvTestHost) Container(context.Context) (kvha.ContainerInfo, error) {
	data := h.inspect()
	if data == nil {
		return kvha.ContainerInfo{}, nil
	}
	state := data["State"].(map[string]any)
	started, _ := time.Parse(time.RFC3339Nano, state["StartedAt"].(string))
	return kvha.ContainerInfo{Exists: true, Running: state["Running"].(bool), ID: data["Id"].(string), StartedAt: started}, nil
}
func (h *kvTestHost) PrepareStandby(context.Context) error { return nil }
func (h *kvTestHost) Start(context.Context) error          { _, err := dockerCLI("start", h.name); return err }
func (h *kvTestHost) Stop(context.Context, time.Duration) error {
	_, err := dockerCLI("stop", "-t", "5", h.name)
	return err
}
func (h *kvTestHost) Kill(context.Context) error { _, _ = dockerCLI("kill", h.name); return nil }
func (h *kvTestHost) CgroupEmpty(ctx context.Context) (bool, error) {
	info, err := h.Container(ctx)
	return !info.Running, err
}
func (h *kvTestHost) ip() string {
	data := h.inspect()
	if data == nil {
		return ""
	}
	networks := data["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
	endpoint, _ := networks[h.network].(map[string]any)
	ip, _ := endpoint["IPAddress"].(string)
	return ip
}
func (h *kvTestHost) DialServer(ctx context.Context) (net.Conn, error) {
	ip := h.ip()
	if ip == "" {
		return nil, errors.New("not running")
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip, "6379"))
}
func (h *kvTestHost) DialAlias(ctx context.Context, alias string) (net.Conn, error) {
	return h.mesh.dial(ctx, h, alias)
}
func (h *kvTestHost) Expose([]kvha.Exposure) {}
func (h *kvTestHost) SetLocalPrimary(dial func(context.Context, string) (net.Conn, bool)) {
	h.local = dial
}
func (h *kvTestHost) DiskFree() (uint64, bool, bool) { return 0, false, false }
func (h *kvTestHost) Serve()                         {}
func (h *kvTestHost) Logger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (m *kvMesh) dial(ctx context.Context, from *kvTestHost, alias string) (net.Conn, error) {
	if alias != "primary-"+kvha.PortRepl {
		return nil, fmt.Errorf("no route for %s", alias)
	}
	if from.local != nil {
		if conn, ok := from.local(ctx, kvha.PortRepl); ok {
			return conn, nil
		}
	}
	m.mu.Lock()
	target := m.hosts[m.primary]
	m.mu.Unlock()
	if target == nil || target.down() || from.down() {
		return nil, errors.New("no primary admitted")
	}
	return target.engine.DialPeer(ctx, kvha.PortRepl)
}

func (m *kvMesh) setPrimary(id string) { m.mu.Lock(); m.primary = id; m.mu.Unlock() }

func kvConfig(member string) memberha.Config {
	return memberha.Config{SetID: kvSet, MemberID: member, NodeID: "node-" + member[:4], Engine: "valkey",
		OwnerKind: "managed_database", OwnerID: "11111111-2222-4333-8444-555555555555", Mode: memberha.ModeAutomatic,
		LeasePolicyID: "66666666-7777-4888-8999-aaaaaaaaaaaa", MaxLagBytes: 1 << 20, SyncDegradeAfterSeconds: 10,
		EngineConfig: []byte(`{"replicationPassword":"` + kvReplPass + `"}`),
		Members:      []memberha.Peer{{MemberID: kvA, NodeID: "node-cdcd", MemberIndex: 0}, {MemberID: kvB, NodeID: "node-efef", MemberIndex: 1}}}
}

func startKVMember(t *testing.T, root string, mesh *kvMesh, member string, index int, subnet string) *kvTestHost {
	t.Helper()
	network := fmt.Sprintf("kv-ct-net-%d", index)
	name := fmt.Sprintf("kv-ct-%d", index)
	_, _ = dockerCLI("rm", "-f", name)
	_, _ = dockerCLI("network", "rm", network)
	prefix := netip.MustParsePrefix(subnet)
	gateway := prefix.Addr().Next()
	mustDocker(t, "network", "create", "--internal", "--subnet", subnet, "--gateway", gateway.String(), network)
	t.Cleanup(func() { _, _ = dockerCLI("rm", "-f", name); _, _ = dockerCLI("network", "rm", network) })
	t.Cleanup(func() {
		if t.Failed() {
			out, _ := dockerCLI("logs", "--tail", "30", name)
			t.Logf("--- %s logs:\n%s", name, out)
			ping, err := valkeyCLI(&kvTestHost{name: name}, "PING")
			t.Logf("--- %s PING: %v %s", name, err, ping)
		}
	})
	mount := filepath.Join(root, fmt.Sprintf("member-%d", index))
	data := filepath.Join(mount, "valkey-data")
	if err := os.MkdirAll(data, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := ensureManagedRedisACLFile(data, kvOwnerPass); err != nil {
		t.Fatal(err)
	}
	cfg := kvConfig(member)
	if err := ensureKVReplicationUser(filepath.Join(data, "users.acl"), cfg); err != nil {
		t.Fatal(err)
	}
	memberArgs, err := kvMemberArgs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	conf := filepath.Join(mount, "redis.conf")
	if err := os.WriteFile(conf, []byte("aclfile /data/users.acl\nappendonly yes\n"+managedValkeyModuleConfig()), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("chown", "-R", "999:999", data).CombinedOutput(); err != nil {
		t.Fatalf("chown: %v %s", err, out)
	}
	if _, err := dockerCLI("image", "inspect", kvImage); err != nil {
		mustDocker(t, "pull", kvImage)
	}
	mustDocker(t, append([]string{"run", "-d", "--name", name, "--network", network, "--add-host", kvha.PrimaryHost + ":" + gateway.String(),
		"-v", data + ":/data", "-v", conf + ":/run/gateway-config/redis.conf:ro",
		kvImage, "valkey-server", "/run/gateway-config/redis.conf", "--dir", "/data"}, memberArgs...)...)
	host := &kvTestHost{mesh: mesh, cfg: cfg, name: name, network: network, gateway: gateway}
	engine, err := kvha.New(host)
	if err != nil {
		t.Fatal(err)
	}
	host.engine = engine
	mesh.mu.Lock()
	mesh.hosts[member] = host
	mesh.mu.Unlock()
	listener, err := net.Listen("tcp", net.JoinHostPort(gateway.String(), "6379"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				upstream, err := mesh.dial(ctx, host, "primary-"+kvha.PortRepl)
				cancel()
				if err != nil {
					_ = conn.Close()
					return
				}
				pipeConns(conn, upstream)
			}()
		}
	}()
	return host
}

// valkeyCLI runs a command as the owner (default user) in the member.
func valkeyCLI(h *kvTestHost, args ...string) (string, error) {
	cmd := exec.Command("docker", append([]string{"exec", "-e", "REDISCLI_AUTH=" + kvOwnerPass, h.name, "valkey-cli", "--no-auth-warning"}, args...)...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func kvInfo(t *testing.T, h *kvTestHost) map[string]string {
	out, _ := valkeyCLI(h, "INFO", "replication")
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		if key, value, ok := strings.Cut(strings.TrimSpace(scanner.Text()), ":"); ok {
			values[key] = value
		}
	}
	return values
}

func kvDrive(ctx context.Context, hosts ...*kvTestHost) {
	for ctx.Err() == nil {
		for _, h := range hosts {
			if !h.down() {
				sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				_, _ = h.engine.Status(sctx)
				cancel()
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func kvWait(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestValkeySetContainers(t *testing.T) {
	if os.Getenv("DOCKER_HOST") == "" {
		t.Skip("set DOCKER_HOST to a Docker engine")
	}
	root := t.TempDir()
	mesh := &kvMesh{hosts: map[string]*kvTestHost{}}
	a := startKVMember(t, root, mesh, kvA, 0, "10.231.50.0/26")
	b := startKVMember(t, root, mesh, kvB, 1, "10.231.50.64/26")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	kvWait(t, "both servers answer", 60*time.Second, func() bool {
		ra, _ := valkeyCLI(a, "PING")
		rb, _ := valkeyCLI(b, "PING")
		return ra == "PONG" && rb == "PONG"
	})
	go kvDrive(ctx, a, b)

	// Standby at rest: both came up as replicas. A becomes the primary.
	if role := kvInfo(t, a)["role"]; role != "slave" {
		t.Fatalf("a member starts as a replica, got %q", role)
	}
	if err := a.engine.Promote(ctx, nil); err != nil {
		t.Fatal(err)
	}
	mesh.setPrimary(kvA)
	kvWait(t, "B replicates A", 60*time.Second, func() bool { return kvInfo(t, b)["master_link_status"] == "up" })
	t.Logf("B linked to A")

	// ACL users replicate through the mirror.
	if out, err := valkeyCLI(a, "ACL", "SETUSER", "app", "on", ">app-password-0123", "~app:*", "+@all"); err != nil || out != "OK" {
		t.Fatalf("ACL SETUSER: %v %s", err, out)
	}
	kvWait(t, "B mirrors the ACL list", 30*time.Second, func() bool {
		out, _ := valkeyCLI(b, "ACL", "LIST")
		return strings.Contains(out, "user app ")
	})

	// Writes on A; B is eligible under what A certifies.
	acked := 0
	for i := range 2000 {
		if out, err := valkeyCLI(a, "SET", "key:"+strconv.Itoa(i), strconv.Itoa(i)); err == nil && out == "OK" {
			acked++
		}
		if i%500 == 0 {
			_, _ = valkeyCLI(a, "INCR", "counter")
		}
	}
	var certifiedValue []byte
	kvWait(t, "B eligible", 30*time.Second, func() bool {
		value, _, ok, _ := a.engine.NextValue(mustKVValue(t, kvha.Value{ReplID: "-"}), memberha.EngineStatus{}, time.Hour)
		if !ok {
			return false
		}
		certifiedValue = value
		eligible, reason := b.engine.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: value}}, memberha.EngineStatus{})
		if !eligible {
			t.Logf("B not eligible yet: %s", reason)
		}
		return eligible
	})
	if target, ok := a.engine.ReleaseTarget(certifiedValue); !ok || target != kvB {
		t.Fatalf("A releases to B: %q %v", target, ok)
	}

	// A is lost: B takes over with every acknowledged write.
	a.mu.Lock()
	a.isolated = true
	a.mu.Unlock()
	mustDocker(t, "kill", a.name)
	mesh.setPrimary("")
	start := time.Now()
	if err := b.engine.Promote(ctx, certifiedValue); err != nil {
		t.Fatal(err)
	}
	mesh.setPrimary(kvB)
	t.Logf("B promoted in %s", time.Since(start))
	size, _ := valkeyCLI(b, "DBSIZE")
	if n, _ := strconv.Atoi(size); n < acked {
		t.Fatalf("B has %d keys, %d writes were acknowledged", n, acked)
	}
	if out, err := valkeyCLI(b, "SET", "after", "1"); err != nil || out != "OK" {
		t.Fatalf("B takes writes: %v %s", err, out)
	}
	if out, _ := valkeyCLI(b, "--user", "app", "--pass", "app-password-0123", "SET", "app:x", "1"); out != "OK" {
		t.Fatalf("the mirrored ACL user works on the new primary: %s", out)
	}

	// A returns: it starts as a replica of B and resyncs (a killed primary has no
	// replication state on disk to continue from, so a full sync).
	a.mu.Lock()
	a.isolated = false
	a.mu.Unlock()
	mustDocker(t, "start", a.name)
	kvWait(t, "A replicates B", 60*time.Second, func() bool {
		info := kvInfo(t, a)
		return info["role"] == "slave" && info["master_link_status"] == "up"
	})
	stats, _ := valkeyCLI(b, "INFO", "stats")
	t.Logf("B sync stats: %s", grepLines(stats, "sync_"))
	kvWait(t, "A has B's write", 30*time.Second, func() bool {
		out, _ := valkeyCLI(a, "GET", "after")
		return out == "1"
	})
	if out, _ := valkeyCLI(a, "SET", "x", "1"); !strings.Contains(out, "READONLY") {
		t.Fatalf("the returning member is read-only: %s", out)
	}
}

func grepLines(text, prefix string) string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			out = append(out, strings.TrimSpace(line))
		}
	}
	return strings.Join(out, " ")
}

func mustKVValue(t *testing.T, value kvha.Value) []byte {
	t.Helper()
	value.V = 1
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
