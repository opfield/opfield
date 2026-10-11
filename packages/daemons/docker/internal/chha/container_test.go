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
)

var ctIPs = map[string]string{"ch1": "10.233.60.11", "ch2": "10.233.60.12", "kw": "10.233.60.13", "kw2": "10.233.60.14"}

type ctHarness struct {
	t      *testing.T
	docker string
	host   string
	image  string
	work   string
	logger *slog.Logger

	mu      sync.Mutex
	configs map[string]memberha.Config
	targets map[string]string
}

func (h *ctHarness) run(args ...string) (string, error) {
	cmd := exec.Command(h.docker, args...)
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

func (r *ctRuntime) KeeperClient(_ context.Context, command string) (string, error) {
	out, err := r.h.run("exec", r.name, "clickhouse", "keeper-client", "--host", "127.0.0.1", "--port", "9181", "--query", command)
	if err == nil && (strings.Contains(out, "Exception") || strings.Contains(out, "Syntax error")) {
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
	members := []string{testMemberA, testMemberB}
	if name == "ch2" {
		members = []string{testMemberB, testMemberA}
	}
	config := testConfig(memberha.ModeAutomatic, ec, members...)
	config.SetID, config.ConfigRevision = ctSetID, revision
	h.mu.Lock()
	h.configs[name] = config
	h.mu.Unlock()
}

// witnessXML is the witness Keeper's config as the relay supervisor renders
// it (raft entry on the set's loopback host), listening on all addresses of
// its container instead of the relay's 127.0.0.1.
func witnessXML(id uint32, raftPort uint32) string {
	return fmt.Sprintf(`<clickhouse><logger><level>information</level><console>1</console></logger><listen_host>0.0.0.0</listen_host><path>/var/lib/clickhouse/</path>
<keeper_server><tcp_port>9181</tcp_port><server_id>%d</server_id>
<log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path><snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
<enable_reconfiguration>true</enable_reconfiguration><four_letter_word_white_list>ruok,srvr,mntr,conf,isro</four_letter_word_white_list>
<coordination_settings><operation_timeout_ms>10000</operation_timeout_ms><session_timeout_ms>30000</session_timeout_ms><raft_logs_level>warning</raft_logs_level></coordination_settings>
<raft_configuration><server><id>%d</id><hostname>127.48.54.1</hostname><port>%d</port><priority>1</priority></server>
<server><id>1</id><hostname>127.48.54.1</hostname><port>39501</port><priority>3</priority></server><server><id>2</id><hostname>127.48.54.1</hostname><port>39502</port><priority>3</priority></server></raft_configuration>
</keeper_server></clickhouse>`, id, id, raftPort)
}

func (h *ctHarness) startWitness(name string, id, raftPort uint32) *forwarders {
	h.t.Helper()
	dir := filepath.Join(h.work, name)
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o777); err != nil {
		h.t.Fatal(err)
	}
	_ = os.Chmod(filepath.Join(dir, "data"), 0o777)
	if err := os.WriteFile(filepath.Join(dir, "keeper.xml"), []byte(witnessXML(id, raftPort)), 0o644); err != nil {
		h.t.Fatal(err)
	}
	h.must("run", "-d", "--name", name, "--network", ctNetwork, "--ip", ctIPs[name], "--memory", "512m",
		"-v", filepath.Join(dir, "data")+":/var/lib/clickhouse", "-v", filepath.Join(dir, "keeper.xml")+":/etc/kw/keeper.xml:ro",
		"--entrypoint", "/usr/bin/clickhouse", h.image, "keeper", "--config-file=/etc/kw/keeper.xml")
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
			t.Logf("%s (%s)", what, detail)
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
			t.Logf("--- %s srvr:\n%s", name, fourLetter(ctIPs[name]+":9181", "srvr"))
			t.Logf("--- %s mntr:\n%s", name, fourLetter(ctIPs[name]+":9181", "mntr"))
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

	// 1. Keeper quorum over the loopback endpoints; a data member leads.
	waitFor(t, "Keeper quorum on both members", 90*time.Second, func() (bool, string) {
		s1, s2 := status(t, e1), status(t, e2)
		m1, m2 := s1.Position[posKeeper], s2.Position[posKeeper]
		return keeperServing(m1) && keeperServing(m2) && (m1 == "leader" || m2 == "leader"), m1 + "/" + m2 + " " + s1.Detail + s2.Detail
	})
	waitFor(t, "the witness follows", 2*time.Minute, func() (bool, string) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		mode, err := probeKeeper(ctx, ctIPs["kw"]+":9181")
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

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
