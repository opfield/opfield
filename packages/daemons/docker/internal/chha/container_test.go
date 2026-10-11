//go:build chhacontainer

package chha

// Container test of the ClickHouse member engine (P2-T07): two real
// clickhouse-server members with embedded Keepers and a standalone Keeper
// witness, all addressed through the set's loopback endpoints and the
// forwarders in each container's network namespace, as in production (the
// member mesh is replaced by direct dials). Run as root on a host with a
// private Docker engine:
//
//	CHHA_DOCKER_HOST=unix:///run/hach/docker.sock CHHA_DOCKER=/root/hach/bin/docker \
//	  go test -tags chhacontainer -run TestContainerPairFailoverAndWitness -v ./internal/chha/
//
// It checks: config accepted by ClickHouse, Keeper quorum over loopback
// endpoints with the witness never leading, Replicated databases joined by
// the members, quorum-acknowledged inserts present after the holder is killed,
// standby at rest on a restart, the degraded fallback to quorum 1, and the
// witness re-placement order (start, reconfig add, reconfig remove).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	ctNetwork = "chha-test"
	ctSubnet  = "10.233.60.0/24"
	ctSetID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ctImage   = "docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf" // 25.8.28.1
	// ctKeeperImage is the pinned witness Keeper image (config/third-party-images.json).
	ctKeeperImage = "docker.io/clickhouse/clickhouse-keeper@sha256:79767b4b69aa0425057128c8f741dd31d8052ad5edab2f2839ebfa9c6d3ad3e6"
)

var ctIPs = map[string]string{"ch1": "10.233.60.11", "ch2": "10.233.60.12", "kw": "10.233.60.13", "kw2": "10.233.60.14"}

type ctHarness struct {
	t           *testing.T
	docker      string
	host        string
	image       string
	keeperImage string
	engines     map[string]*engine
	work        string
	logger      *slog.Logger

	mu      sync.Mutex
	configs map[string]memberha.Config
	targets map[string]string
}

func (h *ctHarness) run(args ...string) (string, error) {
	return h.runContext(context.Background(), args...)
}

func (h *ctHarness) runContext(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, h.docker, args...)
	cmd.Env = append(os.Environ(), "DOCKER_HOST="+h.host)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (h *ctHarness) must(args ...string) string {
	h.t.Helper()
	out, err := h.run(args...)
	if err != nil {
		h.t.Fatalf("docker %v: %v\n%s", args, err, out)
	}
	return out
}

func (h *ctHarness) cleanup() {
	for name := range ctIPs {
		_, _ = h.run("rm", "-f", name)
	}
	_, _ = h.run("network", "rm", ctNetwork)
}

// ctRuntime is Runtime over a test container.
type ctRuntime struct {
	h     *ctHarness
	name  string
	mount string
}

func (r *ctRuntime) Container(context.Context) (memberha.ContainerState, int, error) {
	out, err := r.h.run("inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.Pid}}", r.name)
	if err != nil {
		if strings.Contains(out, "No such") {
			return memberha.ContainerState{}, 0, nil
		}
		return memberha.ContainerState{}, 0, fmt.Errorf("%v: %s", err, out)
	}
	fields := strings.Fields(out)
	pid, _ := strconv.Atoi(fields[2])
	return memberha.ContainerState{Exists: true, ID: fields[0], Running: fields[1] == "true"}, pid, nil
}

func (r *ctRuntime) Address(context.Context) (string, error) { return ctIPs[r.name], nil }
func (r *ctRuntime) Start(context.Context) error             { _, err := r.h.run("start", r.name); return err }
func (r *ctRuntime) StopClean(_ context.Context, timeout time.Duration) error {
	_, err := r.h.run("stop", "-t", strconv.Itoa(int(timeout.Seconds())), r.name)
	return err
}
func (r *ctRuntime) Kill(context.Context) error {
	_, err := r.h.run("kill", r.name)
	return err
}
func (r *ctRuntime) CgroupEmpty(ctx context.Context) (bool, error) {
	state, _, err := r.Container(ctx)
	return !state.Running, err
}

func (r *ctRuntime) password() string {
	data, _ := os.ReadFile(filepath.Join(r.mount, "secret"))
	return strings.TrimSpace(string(data))
}

func (r *ctRuntime) Query(ctx context.Context, query string) (string, error) {
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+ctIPs[r.name]+":8123/", strings.NewReader(query))
	request.Header.Set("X-ClickHouse-User", InternalUser)
	request.Header.Set("X-ClickHouse-Key", r.password())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return string(body), nil
}

func (r *ctRuntime) KeeperClient(ctx context.Context, command string) (string, error) {
	out, err := r.h.runContext(ctx, append([]string{"exec", r.name}, KeeperClientCommand(command)...)...)
	if err == nil && KeeperClientFailed(out) {
		err = fmt.Errorf("%s", out)
	}
	return out, err
}

func (r *ctRuntime) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(r.mount, name))
}
func (r *ctRuntime) WriteFile(name string, data []byte) error {
	path := filepath.Join(r.mount, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}
func (r *ctRuntime) Exists(relative string) bool {
	_, err := os.Stat(filepath.Join(r.mount, relative))
	return err == nil
}
func (r *ctRuntime) MoveAside(relative string) error {
	// The data directory is the container's (uid 101): rename it as root.
	source := filepath.Join(r.mount, relative)
	return os.Rename(source, fmt.Sprintf("%s.wiped-%d", source, time.Now().UnixNano()))
}

func (r *ctRuntime) PeerEngineState(_ context.Context, memberID string) (map[string]string, bool) {
	r.h.mu.Lock()
	var peer *engine
	for name, e := range r.h.engines {
		if config, ok := r.h.configs[name]; ok && config.MemberID == memberID {
			peer = e
		}
	}
	r.h.mu.Unlock()
	if peer == nil {
		return nil, false
	}
	state, _, err := r.h.Container(peer)
	if err != nil || !state {
		return nil, false
	}
	return peer.PeerEngineState(), true
}

func (r *ctRuntime) InternalPasswordSHA256() (string, error) {
	digest := sha256.Sum256([]byte(r.password()))
	return hex.EncodeToString(digest[:]), nil
}
func (r *ctRuntime) Listen(pid int, address string) (net.Listener, error) {
	return ListenInNetns(pid, address)
}
func (r *ctRuntime) Bridge(connection net.Conn, alias string) error {
	return r.h.bridge(connection, alias)
}
func (r *ctRuntime) Probe(ctx context.Context, alias string) error {
	target, ok := r.h.target(alias)
	if !ok {
		return fmt.Errorf("unknown alias %s", alias)
	}
	conn, err := net.DialTimeout("tcp", target, 2*time.Second)
	if err == nil {
		_ = conn.Close()
	}
	return err
}
func (r *ctRuntime) Config() (memberha.Config, bool) {
	r.h.mu.Lock()
	defer r.h.mu.Unlock()
	config, ok := r.h.configs[r.name]
	return config, ok
}
func (r *ctRuntime) GatewayConnected() bool              { return true }
func (r *ctRuntime) Sign(string, []byte) ([]byte, error) { return []byte("test"), nil }
func (r *ctRuntime) Logger() *slog.Logger                { return r.h.logger.With("member", r.name) }

// Container reports whether an engine's container runs (a peer that does not
// run does not answer on member-control).
func (h *ctHarness) Container(e *engine) (bool, int, error) {
	state, pid, err := e.rt.Container(context.Background())
	return state.Running, pid, err
}

func (h *ctHarness) target(alias string) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	target, ok := h.targets[alias]
	return target, ok
}

// bridge stands in for the member mesh: it dials the alias's container.
func (h *ctHarness) bridge(connection net.Conn, alias string) error {
	defer connection.Close()
	target, ok := h.target(alias)
	if !ok {
		return fmt.Errorf("unknown alias %s", alias)
	}
	upstream, err := net.DialTimeout("tcp", target, 3*time.Second)
	if err != nil {
		return err
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, connection); done <- struct{}{} }()
	go func() { _, _ = io.Copy(connection, upstream); done <- struct{}{} }()
	<-done
	return nil
}

func ctEngineConfig(self uint32, witnesses []KeeperServer) EngineConfig {
	servers := []KeeperServer{
		{ID: 1, Port: 39501, MemberID: testMemberA, Role: RoleVoter},
		{ID: 2, Port: 39502, MemberID: testMemberB, Role: RoleVoter},
	}
	return EngineConfig{Version: 1, LoopbackHost: "127.48.54.1", KeeperServerID: self, KeeperServers: append(servers, witnesses...),
		Interserver: []InterserverPeer{{MemberID: testMemberA, Port: 39000}, {MemberID: testMemberB, Port: 39001}},
		Databases:   []string{"app"}}
}

func (h *ctHarness) setConfig(name string, ec EngineConfig, revision uint64) {
	h.setConfigMode(name, ec, revision, memberha.ModeAutomatic)
}

func (h *ctHarness) setConfigMode(name string, ec EngineConfig, revision uint64, mode string) {
	members := []string{testMemberA, testMemberB}
	if name == "ch2" {
		members = []string{testMemberB, testMemberA}
	}
	config := testConfig(mode, ec, members...)
	config.SetID, config.ConfigRevision = ctSetID, revision
	h.mu.Lock()
	h.configs[name] = config
	h.mu.Unlock()
}

// startWitness runs a Keeper witness the way a docker node does (decision 8):
// the clickhouse-keeper image as the clickhouse user with the config the
// daemon renders (RenderWitnessKeeperConfig), its client port below its raft
// port, the members' endpoints bound in its network namespace.
func (h *ctHarness) startWitness(name string, id, raftPort uint32) *forwarders {
	h.t.Helper()
	dir := filepath.Join(h.work, name)
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o777); err != nil {
		h.t.Fatal(err)
	}
	_ = os.Chmod(filepath.Join(dir, "data"), 0o777)
	config, err := RenderWitnessKeeperConfig(id, raftPort-1, raftPort, "127.48.54.1", []WitnessPeerEndpoint{
		{ID: 1, Host: "127.48.54.1", Port: 39501}, {ID: 2, Host: "127.48.54.1", Port: 39502}})
	if err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keeper.xml"), config, 0o644); err != nil {
		h.t.Fatal(err)
	}
	h.must("run", "-d", "--name", name, "--network", ctNetwork, "--ip", ctIPs[name], "--memory", "512m", "--user", "101:101",
		"-v", filepath.Join(dir, "data")+":"+WitnessKeeperDataPath, "-v", filepath.Join(dir, "keeper.xml")+":"+WitnessKeeperConfigPath+":ro",
		"--entrypoint", WitnessKeeperEntrypoint, h.keeperImage, "--config-file="+WitnessKeeperConfigPath)
	pid, _ := strconv.Atoi(h.must("inspect", "-f", "{{.State.Pid}}", name))
	fw := newForwarders(ListenInNetns, h.bridge, h.logger)
	failed := fw.ensure(name, pid, map[string]string{
		"127.48.54.1:39501": "member-" + testMemberA + "-ch-keeper",
		"127.48.54.1:39502": "member-" + testMemberB + "-ch-keeper",
	})
	if len(failed) > 0 {
		h.t.Fatalf("witness forwarders: %v", failed)
	}
	return fw
}

func (h *ctHarness) createMember(name string) *ctRuntime {
	h.t.Helper()
	mount := filepath.Join(h.work, name)
	if err := os.MkdirAll(mount, 0o777); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mount, "secret"), []byte(fmt.Sprintf("internal-secret-%s-0123456789abcdef", name)), 0o600); err != nil {
		h.t.Fatal(err)
	}
	return &ctRuntime{h: h, name: name, mount: mount}
}

func (h *ctHarness) createContainer(rt *ctRuntime) {
	h.t.Helper()
	h.must("create", "--name", rt.name, "--network", ctNetwork, "--ip", ctIPs[rt.name], "--memory", "2g",
		"--ulimit", "nofile=262144:262144", "-v", rt.mount+":/var/lib/clickhouse",
		"-v", filepath.Join(rt.mount, ServerConfigFile)+":"+ServerConfigTarget+":ro",
		"-v", filepath.Join(rt.mount, UsersConfigFile)+":"+UsersConfigTarget+":ro",
		"-v", filepath.Join(rt.mount, RoleConfigFile)+":"+RoleConfigTarget+":ro", h.image)
}

func waitFor(t *testing.T, what string, timeout time.Duration, check func() (bool, string)) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	last := ""
	for time.Now().Before(deadline) {
		ok, detail := check()
		if ok {
			t.Logf("%s %s (%s)", time.Now().UTC().Format("15:04:05"), what, detail)
			return
		}
		last = detail
		time.Sleep(500 * time.Millisecond)
	}
	if ctDiagnose != nil {
		ctDiagnose()
	}
	t.Fatalf("timed out waiting for %s: %s", what, last)
}

// ctDiagnose dumps the Keepers' views while the forwarders still run.
var ctDiagnose func()

func fourLetter(address, command string) string {
	conn, err := net.DialTimeout("tcp", address, 2*time.Second)
	if err != nil {
		return err.Error()
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = conn.Write([]byte(command))
	data, _ := io.ReadAll(conn)
	return string(data)
}

func status(t *testing.T, e *engine) memberha.EngineStatus {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := e.Status(ctx)
	if err != nil {
		return memberha.EngineStatus{Detail: err.Error()}
	}
	return s
}

func count(rt *ctRuntime) (int, error) {
	out, err := rt.Query(context.Background(), "SELECT count() FROM app.ledger")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(out))
}

func TestContainerPairFailoverAndWitness(t *testing.T) {
	host := os.Getenv("CHHA_DOCKER_HOST")
	if host == "" {
		t.Skip("CHHA_DOCKER_HOST is not set")
	}
	h := &ctHarness{t: t, docker: envOr("CHHA_DOCKER", "docker"), host: host, image: envOr("CHHA_IMAGE", ctImage),
		keeperImage: envOr("CHHA_KEEPER_IMAGE", ctKeeperImage), engines: map[string]*engine{},
		work: t.TempDir(), logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})),
		configs: map[string]memberha.Config{}, targets: map[string]string{
			"member-" + testMemberA + "-ch-keeper":      ctIPs["ch1"] + ":39501",
			"member-" + testMemberB + "-ch-keeper":      ctIPs["ch2"] + ":39502",
			"member-" + testMemberA + "-ch-interserver": ctIPs["ch1"] + ":39000",
			"member-" + testMemberB + "-ch-interserver": ctIPs["ch2"] + ":39001",
			"witness-" + testWitness + "-ch-keeper":     ctIPs["kw"] + ":39433",
			"witness-" + testStandby + "-ch-keeper":     ctIPs["kw2"] + ":39437",
		}}
	_ = os.Chmod(h.work, 0o777)
	ctDiagnose = func() {
		for _, name := range []string{"ch1", "ch2", "kw", "kw2"} {
			port := "9181"
			if strings.HasPrefix(name, "kw") {
				port = map[string]string{"kw": "39432", "kw2": "39436"}[name]
			}
			t.Logf("--- %s srvr:\n%s", name, fourLetter(ctIPs[name]+":"+port, "srvr"))
			t.Logf("--- %s mntr:\n%s", name, fourLetter(ctIPs[name]+":"+port, "mntr"))
		}
		for _, name := range []string{"ch1", "ch2"} {
			out, _ := h.run("exec", name, "bash", "-c", "grep -iE 'raft|keeper' /var/log/clickhouse-server/clickhouse-server.err.log | tail -20")
			t.Logf("--- %s keeper errors:\n%s", name, out)
		}
		out, _ := h.run("logs", "--tail", "30", "kw")
		t.Logf("--- kw log:\n%s", out)
	}
	defer func() { ctDiagnose = nil }()
	h.cleanup()
	t.Cleanup(func() {
		if t.Failed() {
			for _, name := range []string{"ch1", "ch2", "kw", "kw2"} {
				out, _ := h.run("logs", "--tail", "40", name)
				t.Logf("--- %s logs:\n%s", name, out)
			}
			if os.Getenv("CHHA_KEEP") != "" {
				return
			}
		}
		h.cleanup()
	})
	h.must("pull", "-q", h.image)
	h.must("pull", "-q", h.keeperImage)
	h.must("network", "create", "--subnet", ctSubnet, ctNetwork)
	ctx := context.Background()

	witness := []KeeperServer{{ID: 1001, Port: 39433, WitnessID: testWitness, Role: RoleVoter}}
	h.setConfig("ch1", ctEngineConfig(1, witness), 1)
	h.setConfig("ch2", ctEngineConfig(2, witness), 1)
	rt1, rt2 := h.createMember("ch1"), h.createMember("ch2")
	newEngine := func(rt *ctRuntime) *engine {
		config, _ := rt.Config()
		opened, err := New(config, rt)
		if err != nil {
			t.Fatal(err)
		}
		return opened.(*engine)
	}
	e1, e2 := newEngine(rt1), newEngine(rt2)
	t.Cleanup(func() {
		h.mu.Lock()
		h.configs = map[string]memberha.Config{}
		h.mu.Unlock()
	})
	for _, pair := range []struct {
		e  *engine
		rt *ctRuntime
	}{{e1, rt1}, {e2, rt2}} {
		if err := pair.e.PrepareStandby(ctx); err != nil {
			t.Fatal(err)
		}
		h.createContainer(pair.rt)
		if err := pair.e.Start(ctx); err != nil {
			t.Fatal(err)
		}
	}
	witnessForwarders := h.startWitness("kw", 1001, 39433)
	defer witnessForwarders.close()

	// 1. Keeper quorum over the loopback endpoints; a data member leads. The witness may win the first election
	// when it starts before the members' Keepers (timing); the holder then asks its Keeper to lead (rqld), as the
	// member runtime does in HolderWork.
	started := time.Now()
	waitFor(t, "Keeper quorum on both members", 90*time.Second, func() (bool, string) {
		s1, s2 := status(t, e1), status(t, e2)
		m1, m2 := s1.Position[posKeeper], s2.Position[posKeeper]
		if keeperServing(m1) && keeperServing(m2) && m1 != "leader" && m2 != "leader" {
			e1.requestLeadership(ctx, time.Minute+time.Since(started))
		}
		return keeperServing(m1) && keeperServing(m2) && (m1 == "leader" || m2 == "leader"), m1 + "/" + m2 + " " + s1.Detail + s2.Detail
	})
	waitFor(t, "the witness follows", 2*time.Minute, func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		mode, err := probeKeeper(ctx, ctIPs["kw"]+":39432")
		return mode == "follower", fmt.Sprint(mode, err)
	})
	if s := status(t, e1); s.Writable {
		t.Fatal("a member started writable (standby at rest)")
	}

	// 2. ch1 is promoted; both members join the Replicated database.
	healthy, _ := Value{Quorum: 2}.encode()
	if err := e1.Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "Replicated database app on both members", 2*time.Minute, func() (bool, string) {
		engines1, err1 := e1.databaseEngines(ctx)
		engines2, err2 := e2.databaseEngines(ctx)
		return err1 == nil && err2 == nil && engines1["app"] == "Replicated" && engines2["app"] == "Replicated", fmt.Sprint(engines1["app"], engines2["app"], err1, err2)
	})
	if _, err := rt1.Query(ctx, "CREATE TABLE app.ledger (id UInt64) ORDER BY id"); err != nil {
		t.Fatal(err)
	}
	if out, err := rt1.Query(ctx, "SELECT engine FROM system.tables WHERE database = 'app' AND name = 'ledger'"); err != nil || !strings.HasPrefix(strings.TrimSpace(out), "Replicated") {
		t.Fatalf("default table engine: %q %v", out, err)
	}
	acked := 0
	for i := 1; i <= 50; i++ {
		if _, err := rt1.Query(ctx, fmt.Sprintf("INSERT INTO app.ledger SELECT number + %d FROM numbers(100)", i*1000)); err != nil {
			t.Fatalf("quorum insert %d: %v", i, err)
		}
		acked += 100
	}
	before, _ := count(rt1)

	// 3. The copy is eligible; the holder is killed and the copy takes over
	// with every acknowledged row.
	if ok, reason := e2.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: healthy, Holder: "node-1"}}, status(t, e2)); !ok {
		t.Fatalf("copy not eligible: %s", reason)
	}
	if err := e1.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	killedAt := time.Now()
	if err := e2.Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "ch2 has every acknowledged row", time.Minute, func() (bool, string) {
		n, err := count(rt2)
		return err == nil && n >= before, fmt.Sprint(n, err)
	})
	waitFor(t, "ch2 tables writable without ch1", time.Minute, func() (bool, string) {
		s := status(t, e2)
		return s.Writable && s.Position[posReadonly] == "0" && keeperServing(s.Position[posKeeper]), fmt.Sprint(s.Position)
	})
	t.Logf("ch2 writable %.1fs after ch1 was killed", time.Since(killedAt).Seconds())

	// 4. Degraded: certified first, then the holder falls back to quorum 1.
	start := bootNow()
	var degraded []byte
	waitFor(t, "degraded certified after syncDegradeAfterSeconds", time.Minute, func() (bool, string) {
		s := status(t, e2)
		value, kind, changed, _ := e2.NextValue(healthy, s, bootNow())
		if changed && kind == "degraded" {
			degraded = value
			return true, kind
		}
		return false, fmt.Sprintf("%v after %s", s.Position[posMinActive], (bootNow() - start).String())
	})
	_, _, _, _ = e2.NextValue(degraded, status(t, e2), bootNow())
	waitFor(t, "holder runs quorum 1", time.Minute, func() (bool, string) {
		s := status(t, e2)
		return s.Position[posQuorum] == "1", s.Position[posQuorum]
	})
	if _, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 900000 FROM numbers(100)"); err != nil {
		t.Fatalf("degraded insert: %v", err)
	}

	// 5. ch1 comes back read-only and catches up.
	if err := e1.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e1.Start(ctx); err != nil {
		t.Fatal(err)
	}
	total, _ := count(rt2)
	waitFor(t, "ch1 back as a copy, caught up", 3*time.Minute, func() (bool, string) {
		s := status(t, e1)
		n, err := count(rt1)
		return !s.Writable && keeperServing(s.Position[posKeeper]) && err == nil && n == total, fmt.Sprint(s.Writable, n, total, err)
	})

	// 6. Witness re-placement: the new witness starts, the holder adds it at
	// once and removes the dead one after it settled.
	h.must("kill", "kw")
	witnessForwarders.close()
	standbyForwarders := h.startWitness("kw2", 1002, 39437)
	defer standbyForwarders.close()
	replaced := []KeeperServer{{ID: 1001, Port: 39433, WitnessID: testWitness, Role: RoleLeaving}, {ID: 1002, Port: 39437, WitnessID: testStandby, Role: RoleVoter}}
	h.setConfig("ch1", ctEngineConfig(1, replaced), 2)
	h.setConfig("ch2", ctEngineConfig(2, replaced), 2)
	waitFor(t, "Keeper voters 1,2,1002", 3*time.Minute, func() (bool, string) {
		current, err := e2.keeperConfig(ctx)
		if err != nil {
			return false, err.Error()
		}
		return voterList(current) == "1,2,1002", voterList(current)
	})
	// ch1 cut: ch2 and the new witness keep the quorum.
	if err := e1.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "insert with ch1 down after the re-placement", 2*time.Minute, func() (bool, string) {
		_, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 950000 FROM numbers(10)")
		return err == nil, fmt.Sprint(err)
	})
	_ = acked
	var logs bytes.Buffer
	for _, name := range []string{"ch2", "kw2"} {
		out, _ := h.run("logs", "--tail", "5", name)
		logs.WriteString(name + ": " + out + "\n")
	}
	t.Logf("tail of logs:\n%s", logs.String())
}

func manualConfig(self uint32, voter uint32) EngineConfig {
	role := func(id uint32) string {
		if id == voter {
			return RoleVoter
		}
		return RoleLearner
	}
	return EngineConfig{Version: 1, LoopbackHost: "127.48.54.1", KeeperServerID: self,
		KeeperServers: []KeeperServer{
			{ID: 1, Port: 39501, MemberID: testMemberA, Role: role(1)},
			{ID: 2, Port: 39502, MemberID: testMemberB, Role: role(2)},
		},
		Interserver: []InterserverPeer{{MemberID: testMemberA, Port: 39000}, {MemberID: testMemberB, Port: 39001}},
		Databases:   []string{"app"}}
}

// ctSupervisor stands in for the member runtime of a manual pair (memberha):
// it starts a stopped container through standby at rest, promotes the
// assigned primary, demotes any other writable member, and runs a copy's
// rejoin when the engine asks for one.
type ctSupervisor struct {
	mu      sync.Mutex
	primary string
	down    map[string]bool
	stop    chan struct{}
}

func (s *ctSupervisor) run(t *testing.T, name string, e *engine) {
	for {
		select {
		case <-s.stop:
			return
		case <-time.After(time.Second):
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		s.mu.Lock()
		primary, down := s.primary, s.down[name]
		s.mu.Unlock()
		state, _, err := e.rt.Container(ctx)
		switch {
		case err != nil || !state.Exists || down:
		case !state.Running:
			if e.PrepareStandby(ctx) == nil {
				_ = e.Start(ctx)
			}
		default:
			status, _ := e.Status(ctx)
			switch {
			case primary == name && status.Answering && !status.Writable:
				if err := e.Promote(ctx, nil); err != nil {
					t.Logf("%s promote: %v", name, err)
				}
			case primary != name && status.Writable:
				_ = e.Kill(ctx)
				if e.PrepareStandby(ctx) == nil {
					_ = e.Start(ctx)
				}
			case primary != name && status.NeedsRejoin:
				t.Logf("%s rejoins its Keeper: %s", name, status.Position[posRejoin])
				_ = e.Kill(ctx)
				if e.Rejoin(ctx) == nil && e.PrepareStandby(ctx) == nil {
					_ = e.Start(ctx)
				}
			}
		}
		cancel()
	}
}

// A manual pair (no witness): the primary's Keeper is the only voter and the
// copy's a learner. A planned switch moves the client role only; losing the
// voter makes the new primary recover its Keeper alone (two restarts); the
// old voter returns diverged, is refused by its peer's voters, wipes its
// Keeper state and joins as a learner.
func TestContainerManualPairSwitchAndRecovery(t *testing.T) {
	host := os.Getenv("CHHA_DOCKER_HOST")
	if host == "" {
		t.Skip("CHHA_DOCKER_HOST is not set")
	}
	h := &ctHarness{t: t, docker: envOr("CHHA_DOCKER", "docker"), host: host, image: envOr("CHHA_IMAGE", ctImage),
		keeperImage: envOr("CHHA_KEEPER_IMAGE", ctKeeperImage), engines: map[string]*engine{},
		work: t.TempDir(), logger: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})),
		configs: map[string]memberha.Config{}, targets: map[string]string{
			"member-" + testMemberA + "-ch-keeper":      ctIPs["ch1"] + ":39501",
			"member-" + testMemberB + "-ch-keeper":      ctIPs["ch2"] + ":39502",
			"member-" + testMemberA + "-ch-interserver": ctIPs["ch1"] + ":39000",
			"member-" + testMemberB + "-ch-interserver": ctIPs["ch2"] + ":39001",
		}}
	_ = os.Chmod(h.work, 0o777)
	h.cleanup()
	ctDiagnose = func() {
		for _, name := range []string{"ch1", "ch2"} {
			t.Logf("--- %s srvr:\n%s", name, fourLetter(ctIPs[name]+":9181", "srvr"))
			out, _ := h.run("exec", name, "bash", "-c", "tail -40 /var/log/clickhouse-server/clickhouse-server.err.log")
			t.Logf("--- %s err.log:\n%s", name, out)
		}
	}
	defer func() { ctDiagnose = nil }()
	t.Cleanup(func() {
		if t.Failed() {
			for _, name := range []string{"ch1", "ch2"} {
				out, _ := h.run("logs", "--tail", "30", name)
				t.Logf("--- %s logs:\n%s", name, out)
			}
			if os.Getenv("CHHA_KEEP") != "" {
				return
			}
		}
		h.cleanup()
	})
	h.must("pull", "-q", h.image)
	h.must("network", "create", "--subnet", ctSubnet, ctNetwork)
	ctx := context.Background()
	h.setConfigMode("ch1", manualConfig(1, 1), 1, memberha.ModeManual)
	h.setConfigMode("ch2", manualConfig(2, 1), 1, memberha.ModeManual)
	rt1, rt2 := h.createMember("ch1"), h.createMember("ch2")
	open := func(rt *ctRuntime) *engine {
		config, _ := rt.Config()
		opened, err := New(config, rt)
		if err != nil {
			t.Fatal(err)
		}
		e := opened.(*engine)
		h.mu.Lock()
		h.engines[rt.name] = e
		h.mu.Unlock()
		return e
	}
	e1, e2 := open(rt1), open(rt2)
	for _, pair := range []struct {
		e  *engine
		rt *ctRuntime
	}{{e1, rt1}, {e2, rt2}} {
		if err := pair.e.PrepareStandby(ctx); err != nil {
			t.Fatal(err)
		}
		h.createContainer(pair.rt)
	}
	sup := &ctSupervisor{primary: "ch1", down: map[string]bool{}, stop: make(chan struct{})}
	t.Cleanup(func() {
		close(sup.stop)
		h.mu.Lock()
		h.configs = map[string]memberha.Config{}
		h.mu.Unlock()
	})
	go sup.run(t, "ch1", e1)
	go sup.run(t, "ch2", e2)
	setPrimary := func(name string) { sup.mu.Lock(); sup.primary = name; sup.mu.Unlock() }
	setDown := func(name string, down bool) { sup.mu.Lock(); sup.down[name] = down; sup.mu.Unlock() }

	// 1. One voter, one learner; the primary takes inserts.
	waitFor(t, "manual Keeper: ch1 leads alone, ch2 learns", 3*time.Minute, func() (bool, string) {
		m1, m2 := status(t, e1).Position[posKeeper], status(t, e2).Position[posKeeper]
		return m1 == "leader" && keeperServing(m2) && m2 != "leader", m1 + "/" + m2
	})
	waitFor(t, "ch1 writable, app replicated on both", 2*time.Minute, func() (bool, string) {
		engines2, err := e2.databaseEngines(ctx)
		return status(t, e1).Writable && err == nil && engines2["app"] == "Replicated", fmt.Sprint(engines2["app"], err)
	})
	if _, err := rt1.Query(ctx, "CREATE TABLE app.ledger (id UInt64) ORDER BY id"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 20; i++ {
		if _, err := rt1.Query(ctx, fmt.Sprintf("INSERT INTO app.ledger SELECT number + %d FROM numbers(100)", i*1000)); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	// The copy (learner) is down: the primary keeps writing.
	setDown("ch2", true)
	_ = e2.Kill(ctx)
	if _, err := rt1.Query(ctx, "INSERT INTO app.ledger SELECT number + 50000 FROM numbers(100)"); err != nil {
		t.Fatalf("insert with the copy down: %v", err)
	}
	setDown("ch2", false)
	waitFor(t, "ch2 back as a copy, caught up", 3*time.Minute, func() (bool, string) {
		n1, _ := count(rt1)
		n2, err := count(rt2)
		return err == nil && n1 == n2 && !status(t, e2).Writable, fmt.Sprint(n1, n2, err)
	})

	// 2. Planned switch: the client role moves, the Keeper voter stays on ch1.
	setPrimary("ch2")
	waitFor(t, "ch2 primary, ch1 a copy", 2*time.Minute, func() (bool, string) {
		s1, s2 := status(t, e1), status(t, e2)
		return s2.Writable && !s1.Writable && keeperServing(s1.Position[posKeeper]), fmt.Sprint(s1.Writable, s2.Writable, s1.Position[posKeeper])
	})
	if _, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 60000 FROM numbers(100)"); err != nil {
		t.Fatalf("insert on the switched primary (learner Keeper): %v", err)
	}
	before, _ := count(rt2)

	// 3. The voter (ch1) is lost: ch2 recovers its Keeper alone and writes again.
	setDown("ch1", true)
	_ = e1.Kill(ctx)
	lost := time.Now()
	t.Logf("%s ch1 lost", lost.UTC().Format("15:04:05"))
	waitFor(t, "ch2 recovered as the only voter and writable", 4*time.Minute, func() (bool, string) {
		_, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 70000 FROM numbers(10)")
		s := status(t, e2)
		return err == nil && s.Position[posKeeperVoters] == "2", fmt.Sprint(s.Position[posKeeperVoters], s.Position[posRecovery], err)
	})
	t.Logf("ch2 writable again %.0fs after ch1 was lost", time.Since(lost).Seconds())
	after, _ := count(rt2)
	if after < before {
		t.Fatalf("rows lost on the recovered primary: %d < %d", after, before)
	}
	// Gateway adopts the recovery (ch2 voter, ch1 learner).
	h.setConfigMode("ch1", manualConfig(1, 2), 2, memberha.ModeManual)
	h.setConfigMode("ch2", manualConfig(2, 2), 2, memberha.ModeManual)

	// 4. The old voter returns diverged: it wipes its Keeper and joins as a learner.
	setDown("ch1", false)
	waitFor(t, "ch1 joined ch2's Keeper as a learner and caught up", 5*time.Minute, func() (bool, string) {
		current, err := e2.keeperConfig(ctx)
		if err != nil {
			return false, err.Error()
		}
		n1, _ := count(rt1)
		n2, _ := count(rt2)
		entry, ok := current[1]
		return ok && entry.learner && n1 == n2 && n2 > 0, fmt.Sprintf("config %v rows %d/%d", current, n1, n2)
	})
	if _, err := rt2.Query(ctx, "INSERT INTO app.ledger SELECT number + 80000 FROM numbers(10)"); err != nil {
		t.Fatalf("insert after the old voter rejoined: %v", err)
	}
	if out, _ := rt1.Query(ctx, "SELECT count() FROM system.detached_parts"); strings.TrimSpace(out) != "" {
		t.Logf("ch1 detached parts after its rejoin: %s", strings.TrimSpace(out))
	}
	moved, _ := filepath.Glob(filepath.Join(rt1.mount, "coordination.wiped-*"))
	if len(moved) == 0 {
		t.Fatal("ch1's diverged Keeper state was not kept aside")
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
