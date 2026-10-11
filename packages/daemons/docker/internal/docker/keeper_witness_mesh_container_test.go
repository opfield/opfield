//go:build chhacontainer

package docker

// Container test of a ClickHouse pair whose Keeper witness runs on a docker
// node (decision 8), every Keeper and replication connection carried over the
// member mesh as production wires it:
//
//   - three daemons (DockerPlugin): member nodes A and B (storage profile)
//     and witness node W (a plain docker node), each with the relay grant
//     bundle Gateway sends (P1-T05 shapes: peer endpoints
//     managed_availability_peer "<member>:<port>", peer routes
//     managed_member_peer "<src>><dst>:<port>", the witness endpoint
//     managed_availability_witness and the witness routes managed_witness_peer
//     "<member>><witness>" and "<witness>><member>");
//   - members: the real ClickHouse engine (chha.New) over real
//     clickhouse-server containers, each on its own Docker network; their
//     forwarders, bridges and probes are the daemon's own
//     (clickHouseMemberRuntime.Listen/Bridge/Probe → BridgeSetPeer →
//     openSetRoutes → relay source tunnels), and incoming peer tunnels reach
//     the engine through the relay router's dialSetEndpoint;
//   - the witness: the node's Keeper witness runtime (handleApplyKeeperWitnesses,
//     reconcile: pinned clickhouse-keeper container, forwarders in its network
//     namespace bridged over its witness routes, dialWitness for its endpoint)
//     with the spec Gateway's NodeKeeperWitnessService plans.
//
// Faked: the relay itself (miniRelay: an in-process TunnelBroker with the
// relay's frame semantics, no signed grants or policy checks), Gateway (the
// bundles and the witness spec are built here), the member runtime
// (memberha.Manager: the test samples status, starts, kills and promotes
// members; its SetMemberRuntime adapter is a test adapter over the engine's
// DialPeer; PeerEngineState is read from the peer engine directly instead of
// its member-control port) and the managed database manager (member
// containers are created with the docker CLI, as the chha container tests do).
//
// It checks: the witness follows a member leader over the mesh, the Keeper
// configuration lists the witness at its loopback endpoint, the witness routes
// carry tunnels in both directions (every direction is also probed from inside
// the containers' network namespaces), replication runs over the interserver
// routes, the pair keeps its Keeper quorum with a member down through the
// witness only (losing the witness as well loses it), a witness container the
// node started again (a new network namespace) serves its routes again, and
// the copy takes over when the holder is lost with the witness's vote. Run as root against a
// private Docker engine:
//
//	DOCKER_HOST=unix:///run/x/docker.sock go test -tags chhacontainer -run '^TestNodeKeeperWitnessMeshContainer$' -v ./internal/docker/

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/chha"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
)

const (
	mwSetID     = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"
	mwMemberA   = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
	mwMemberB   = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"
	mwWitness   = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3"
	mwPolicy    = "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4"
	mwDatabase  = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5"
	mwImage     = "docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf" // 25.8.28.1
	mwWitnessID = 1001
	// The witness's relay-local port pair (allocateWitnessPorts: client 39400 + 2·pair, raft client + 1).
	mwWitnessClient = 39432
	mwWitnessRaft   = 39433
)

// mwLoopbackHost is Gateway's keeperLoopbackHost.
func mwLoopbackHost(setID string) string {
	digest := sha256.Sum256([]byte(setID))
	a, b := digest[0], digest[1]
	if a == 0 && b == 0 {
		b = 1
	}
	return fmt.Sprintf("127.%d.%d.1", a, b)
}

type mwMemberSpec struct {
	id, name, network, subnet, ip string
	index                         int
}

var mwMembers = []mwMemberSpec{
	{id: mwMemberA, name: "mw-ch-a", network: "mw-net-a", index: 0},
	{id: mwMemberB, name: "mw-ch-b", network: "mw-net-b", index: 1},
}

func mwPeerEndpointID(member, port string) string { return "ep-" + member[:8] + "-" + port }
func mwPeerRouteID(src, dst, port string) string  { return "rt-" + src[:8] + ">" + dst[:8] + "-" + port }
func mwWitnessRouteID(src, dst string) string     { return "rt-" + src[:8] + ">" + dst[:8] + "-ch-keeper" }

const mwWitnessEndpointID = "ep-witness"

func mwGrant(key string) *pb.RelaySignedGrant {
	return &pb.RelaySignedGrant{KeyId: key, Payload: []byte("{}"), Signature: []byte("s")}
}

func mwEndpoint(kind, owner, endpointID string, target *pb.RelayLeaseTarget) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: kind, OwnerId: owner, EndpointId: endpointID, SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{candidateFor("relay-a", "active", 0, endpointID)}, Grant: mwGrant(endpointID), LeaseTarget: target}
}

func mwRoute(kind, owner, routeID, endpointID string, target *pb.RelayLeaseTarget) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{Role: "connect", OwnerKind: kind, OwnerId: owner, RouteId: routeID, TargetEndpointId: endpointID,
		SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidateFor("relay-a", "active", 0, "route:"+routeID)},
		Grant: mwGrant("route:" + routeID), LeaseTarget: target}
}

func mwTarget(memberID, port, witnessID string) *pb.RelayLeaseTarget {
	return &pb.RelayLeaseTarget{SetId: mwSetID, MemberId: memberID, LeasePolicyId: mwPolicy, OwnerKind: "managed_database",
		OwnerId: mwDatabase, PortName: port, WitnessId: witnessID}
}

// mwBundles are the relay grant bundles of the member nodes and the witness
// node, and the relay's route table.
func mwBundles() (map[string][]*pb.RelayGrantAssignment, []*pb.RelayGrantAssignment, map[string]string) {
	routes := map[string]string{}
	members := map[string][]*pb.RelayGrantAssignment{}
	ports := []string{"ch-keeper", "ch-interserver"}
	for _, self := range mwMembers {
		var grants []*pb.RelayGrantAssignment
		for _, port := range ports {
			grants = append(grants, mwEndpoint(setPeerEndpointKind, self.id+":"+port, mwPeerEndpointID(self.id, port), mwTarget(self.id, port, "")))
		}
		for _, other := range mwMembers {
			if other.id == self.id {
				continue
			}
			for _, port := range ports {
				route := mwPeerRouteID(self.id, other.id, port)
				routes[route] = mwPeerEndpointID(other.id, port)
				grants = append(grants, mwRoute(setPeerRouteKind, self.id+">"+other.id+":"+port, route, routes[route], mwTarget(other.id, port, "")))
			}
		}
		route := mwWitnessRouteID(self.id, mwWitness)
		routes[route] = mwWitnessEndpointID
		grants = append(grants, mwRoute(setWitnessRouteKind, self.id+">"+mwWitness, route, mwWitnessEndpointID, mwTarget("", "ch-keeper", mwWitness)))
		members[self.id] = grants
	}
	witness := []*pb.RelayGrantAssignment{mwEndpoint(setWitnessEndpointKind, mwWitness, mwWitnessEndpointID, mwTarget("", "", mwWitness))}
	for _, member := range mwMembers {
		route := mwWitnessRouteID(mwWitness, member.id)
		routes[route] = mwPeerEndpointID(member.id, "ch-keeper")
		witness = append(witness, mwRoute(setWitnessRouteKind, mwWitness+">"+member.id, route, routes[route], mwTarget(member.id, "ch-keeper", mwWitness)))
	}
	return members, witness, routes
}

// mwEngineConfig is the pair's engine configuration Gateway computes: two
// voting members and the node witness at its relay-local raft port.
func mwEngineConfig(self int) chha.EngineConfig {
	ec := chha.EngineConfig{Version: 1, LoopbackHost: mwLoopbackHost(mwSetID), KeeperServerID: uint32(self + 1), Databases: []string{"app"}}
	for _, member := range mwMembers {
		ec.KeeperServers = append(ec.KeeperServers, chha.KeeperServer{ID: uint32(member.index + 1), Port: 39501 + uint32(member.index),
			MemberID: member.id, Role: chha.RoleVoter})
		ec.Interserver = append(ec.Interserver, chha.InterserverPeer{MemberID: member.id, Port: 39000 + uint32(member.index)})
	}
	ec.KeeperServers = append(ec.KeeperServers, chha.KeeperServer{ID: mwWitnessID, Port: mwWitnessRaft, WitnessID: mwWitness, Role: chha.RoleVoter})
	return ec
}

func mwMemberConfig(self int) memberha.Config {
	data, _ := json.Marshal(mwEngineConfig(self))
	config := memberha.Config{SetID: mwSetID, MemberID: mwMembers[self].id, NodeID: "node-" + mwMembers[self].id[:4], Engine: chha.Engine,
		OwnerKind: "managed_database", OwnerID: mwDatabase, Mode: memberha.ModeAutomatic, LeasePolicyID: mwPolicy,
		Durability: "synchronous", SyncDegradeAfterSeconds: 10, ConfigRevision: 1, EngineConfig: data}
	for _, member := range mwMembers {
		config.Members = append(config.Members, memberha.Peer{MemberID: member.id, NodeID: "node-" + member.id[:4], MemberIndex: uint32(member.index)})
	}
	return config
}

// mwWitnessSpec is what NodeKeeperWitnessService plans for the witness node.
func mwWitnessSpec() *pb.WitnessSpec {
	host := mwLoopbackHost(mwSetID)
	spec := &pb.WitnessSpec{Id: mwWitness, SetId: mwSetID, Kind: "clickhouse_keeper", Role: "active",
		Artifact: &pb.WitnessArtifact{Version: defaultKeeperWitnessVersion, Component: "witness-clickhouse-keeper-image"},
		ServerId: mwWitnessID, ClientPort: mwWitnessClient, RaftPort: mwWitnessRaft, RaftHost: host}
	for _, member := range mwMembers {
		spec.Peers = append(spec.Peers, &pb.WitnessPeer{ServerId: uint32(member.index + 1), Host: host, Port: 39501 + uint32(member.index),
			RouteId: mwWitnessRouteID(mwWitness, member.id)})
	}
	return spec
}

type mwHarness struct {
	t      *testing.T
	docker string
	host   string
	root   string
	logger *slog.Logger
	relay  *miniRelay

	mu      sync.Mutex
	members []*mwMember
}

func (h *mwHarness) run(args ...string) (string, error) {
	cmd := exec.Command(h.docker, args...)
	cmd.Env = append(os.Environ(), "DOCKER_HOST="+h.host)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (h *mwHarness) must(args ...string) string {
	h.t.Helper()
	out, err := h.run(args...)
	if err != nil {
		h.t.Fatalf("docker %v: %v\n%s", args, err, out)
	}
	return out
}

// node starts one daemon with its bundle and its tunnels to the relay.
func (h *mwHarness) node(name, mode string, grants []*pb.RelayGrantAssignment) *DockerPlugin {
	h.t.Helper()
	cfg := &config.Config{}
	cfg.StateDir = filepath.Join(h.root, name)
	cfg.Docker.Mode = mode
	if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
		h.t.Fatal(err)
	}
	plugin := NewDockerPlugin(cfg)
	plugin.logger = h.logger.With("node", name)
	store, err := newRelayGrantStore(cfg.StateDir)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: time.Now().UnixMilli(), Grants: grants}); err != nil {
		h.t.Fatal(err)
	}
	plugin.relayGrants = store
	conn, err := grpc.NewClient("unix://"+h.relay.listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		h.t.Fatal(err)
	}
	conn.Connect()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		plugin.RunRelayTargetTunnels(ctx, conn, "", "relay-a")
	}()
	h.t.Cleanup(func() {
		cancel()
		<-done
		conn.Close()
	})
	return plugin
}

func (h *mwHarness) routeOpens(route string) int {
	h.relay.mu.Lock()
	defer h.relay.mu.Unlock()
	return h.relay.routeOpens[route]
}

func (h *mwHarness) logRoutes(when string) {
	h.relay.mu.Lock()
	defer h.relay.mu.Unlock()
	routes := make([]string, 0, len(h.relay.routeOpens))
	for route, opens := range h.relay.routeOpens {
		routes = append(routes, fmt.Sprintf("%s=%d", route, opens))
	}
	sort.Strings(routes)
	h.t.Logf("tunnels per route %s: %s", when, strings.Join(routes, " "))
}

// dialInNetns connects to address from inside the network namespace of
// process pid (a container), on a locked OS thread as chha.ListenInNetns
// listens there.
func dialInNetns(pid int, address string) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		origin, err := os.Open(fmt.Sprintf("/proc/self/task/%d/ns/net", unix.Gettid()))
		if err != nil {
			runtime.UnlockOSThread()
			done <- result{err: err}
			return
		}
		defer origin.Close()
		target, err := os.Open(fmt.Sprintf("/proc/%d/ns/net", pid))
		if err != nil {
			runtime.UnlockOSThread()
			done <- result{err: err}
			return
		}
		defer target.Close()
		if err := unix.Setns(int(target.Fd()), unix.CLONE_NEWNET); err != nil {
			runtime.UnlockOSThread()
			done <- result{err: err}
			return
		}
		conn, dialErr := net.DialTimeout("tcp4", address, 3*time.Second)
		if err := unix.Setns(int(origin.Fd()), unix.CLONE_NEWNET); err != nil {
			// Stay locked: the thread dies with this goroutine.
			if conn != nil {
				_ = conn.Close()
			}
			done <- result{err: err}
			return
		}
		runtime.UnlockOSThread()
		done <- result{conn: conn, err: dialErr}
	}()
	r := <-done
	return r.conn, r.err
}

// mwMember is chha.Runtime over a test container whose member mesh is the
// daemon's (clickHouseMemberRuntime's Listen, Bridge and Probe).
type mwMember struct {
	h      *mwHarness
	spec   mwMemberSpec
	mount  string
	plugin *DockerPlugin
	mesh   *clickHouseMemberRuntime
	engine memberha.Engine

	mu     sync.Mutex
	config memberha.Config
	known  bool
}

func (m *mwMember) Container(ctx context.Context) (memberha.ContainerState, int, error) {
	out, err := m.h.run("inspect", "-f", "{{.Id}} {{.State.Running}} {{.State.Pid}}", m.spec.name)
	if err != nil {
		if strings.Contains(strings.ToLower(out), "no such") {
			return memberha.ContainerState{}, 0, nil
		}
		return memberha.ContainerState{}, 0, fmt.Errorf("%v: %s", err, out)
	}
	fields := strings.Fields(out)
	pid, _ := strconv.Atoi(fields[2])
	return memberha.ContainerState{Exists: true, ID: fields[0], Running: fields[1] == "true"}, pid, nil
}

func (m *mwMember) Address(context.Context) (string, error) { return m.spec.ip, nil }
func (m *mwMember) Start(context.Context) error {
	_, err := m.h.run("start", m.spec.name)
	return err
}
func (m *mwMember) StopClean(_ context.Context, timeout time.Duration) error {
	_, err := m.h.run("stop", "-t", strconv.Itoa(int(timeout.Seconds())), m.spec.name)
	return err
}
func (m *mwMember) Kill(context.Context) error {
	_, err := m.h.run("kill", m.spec.name)
	return err
}
func (m *mwMember) CgroupEmpty(ctx context.Context) (bool, error) {
	state, _, err := m.Container(ctx)
	return !state.Running, err
}

func (m *mwMember) password() string {
	data, _ := os.ReadFile(filepath.Join(m.mount, "secret"))
	return strings.TrimSpace(string(data))
}

func (m *mwMember) Query(ctx context.Context, query string) (string, error) {
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+m.spec.ip+":8123/", strings.NewReader(query))
	request.Header.Set("X-ClickHouse-User", chha.InternalUser)
	request.Header.Set("X-ClickHouse-Key", m.password())
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

func (m *mwMember) KeeperClient(ctx context.Context, command string) (string, error) {
	cmd := exec.CommandContext(ctx, m.h.docker, append([]string{"exec", m.spec.name}, chha.KeeperClientCommand(command)...)...)
	cmd.Env = append(os.Environ(), "DOCKER_HOST="+m.h.host)
	data, err := cmd.CombinedOutput()
	out := string(data)
	if err == nil && chha.KeeperClientFailed(out) {
		err = fmt.Errorf("%s", out)
	}
	return out, err
}

func (m *mwMember) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(m.mount, name))
}
func (m *mwMember) WriteFile(name string, data []byte) error {
	path := filepath.Join(m.mount, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	return os.Chmod(path, 0o644)
}
func (m *mwMember) Exists(relative string) bool {
	_, err := os.Stat(filepath.Join(m.mount, relative))
	return err == nil
}
func (m *mwMember) MoveAside(relative string) error {
	source := filepath.Join(m.mount, relative)
	return os.Rename(source, fmt.Sprintf("%s.wiped-%d", source, time.Now().UnixNano()))
}

// PeerEngineState reads the peer engine directly (production: its member-control port over the mesh).
func (m *mwMember) PeerEngineState(_ context.Context, memberID string) (map[string]string, bool) {
	m.h.mu.Lock()
	var peer *mwMember
	for _, other := range m.h.members {
		if other.spec.id == memberID {
			peer = other
		}
	}
	m.h.mu.Unlock()
	if peer == nil || peer.engine == nil {
		return nil, false
	}
	if state, _, err := peer.Container(context.Background()); err != nil || !state.Running {
		return nil, false
	}
	stater, ok := peer.engine.(interface{ PeerEngineState() map[string]string })
	if !ok {
		return nil, false
	}
	return stater.PeerEngineState(), true
}

func (m *mwMember) InternalPasswordSHA256() (string, error) {
	digest := sha256.Sum256([]byte(m.password()))
	return hex.EncodeToString(digest[:]), nil
}

// The member mesh: the daemon's own.
func (m *mwMember) Listen(pid int, address string) (net.Listener, error) {
	return m.mesh.Listen(pid, address)
}
func (m *mwMember) Bridge(connection net.Conn, alias string) error {
	return m.mesh.Bridge(connection, alias)
}
func (m *mwMember) Probe(ctx context.Context, alias string) error { return m.mesh.Probe(ctx, alias) }

func (m *mwMember) Config() (memberha.Config, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.config, m.known
}
func (m *mwMember) forget() {
	m.mu.Lock()
	m.known = false
	m.mu.Unlock()
}
func (m *mwMember) GatewayConnected() bool              { return true }
func (m *mwMember) Sign(string, []byte) ([]byte, error) { return []byte("test"), nil }
func (m *mwMember) Logger() *slog.Logger                { return m.h.logger.With("member", m.spec.name) }

// mwSetRuntime stands in for memberha.Manager as the relay side's
// SetMemberRuntime: peer ports are served while the member's container runs,
// by the engine's DialPeer.
type mwSetRuntime struct{ m *mwMember }

func (a mwSetRuntime) MemberServing(setID, memberID string) (bool, bool) {
	return false, setID == mwSetID && memberID == a.m.spec.id
}

func (a mwSetRuntime) PeerServing(setID, memberID, port string) bool {
	if setID != mwSetID || memberID != a.m.spec.id || (port != "ch-keeper" && port != "ch-interserver") {
		return false
	}
	state, _, err := a.m.Container(context.Background())
	return err == nil && state.Running
}

func (a mwSetRuntime) DialPeer(ctx context.Context, setID, memberID, port string) (net.Conn, error) {
	if setID != mwSetID || memberID != a.m.spec.id {
		return nil, errSetMemberNotServing
	}
	return a.m.engine.DialPeer(ctx, port)
}

func mwFourLetter(address, command string) string {
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

func mwKeeperMode(address string) string {
	answer := mwFourLetter(address, "srvr")
	scanner := bufio.NewScanner(strings.NewReader(answer))
	for scanner.Scan() {
		if key, value, ok := strings.Cut(scanner.Text(), ":"); ok && strings.TrimSpace(key) == "Mode" {
			return strings.TrimSpace(value)
		}
	}
	if strings.Contains(answer, "not currently serving") {
		return "not_serving"
	}
	return strings.TrimSpace(answer)
}

func mwServing(mode string) bool {
	return mode == "leader" || mode == "follower" || mode == "standalone"
}

func mwWaitFor(t *testing.T, what string, timeout time.Duration, check func() (bool, string)) {
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
	t.Fatalf("timed out waiting for %s: %s", what, last)
}

func TestNodeKeeperWitnessMeshContainer(t *testing.T) {
	host := os.Getenv("DOCKER_HOST")
	if host == "" {
		t.Skip("DOCKER_HOST is not set")
	}
	if os.Geteuid() != 0 {
		t.Skip("the forwarders bind in the containers' network namespaces: run as root")
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	root := t.TempDir()
	for _, path := range []string{filepath.Dir(root), root} {
		_ = os.Chmod(path, 0o755)
	}
	h := &mwHarness{t: t, docker: os.Getenv("CHHA_DOCKER"), host: host, root: root, logger: logger}
	if h.docker == "" {
		h.docker = "docker"
	}
	subnets := []string{os.Getenv("MW_SUBNET_A"), os.Getenv("MW_SUBNET_B")}
	for i := range mwMembers {
		if subnets[i] == "" {
			subnets[i] = fmt.Sprintf("10.233.%d.0/24", 71+i)
		}
		mwMembers[i].subnet = subnets[i]
		mwMembers[i].ip = strings.TrimSuffix(subnets[i], "0/24") + "11"
	}
	cleanup := func() {
		for _, member := range mwMembers {
			_, _ = h.run("rm", "-f", member.name)
			_, _ = h.run("network", "rm", member.network)
		}
	}
	cleanup()
	image := os.Getenv("CHHA_IMAGE")
	if image == "" {
		image = mwImage
	}
	h.must("pull", "-q", image)

	memberGrants, witnessGrants, routes := mwBundles()
	h.relay = startMiniRelay(t, "relay-a", routes)
	nodes := map[string]*DockerPlugin{}
	for _, member := range mwMembers {
		nodes[member.id] = h.node("node-"+member.id[:4], "storage", memberGrants[member.id])
	}
	witnessNode := h.node("node-witness", "", witnessGrants)

	// The witness node's Keeper witness runtime.
	client, err := NewClient(host, filepath.Join(root, "witness-client"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	witnessNode.client = client
	w := &nodeKeeperWitnesses{p: witnessNode, dir: filepath.Join(witnessNode.cfg.StateDir, "keeper-witnesses"), logger: logger.With("node", "witness"),
		desired: map[string]*pb.WitnessSpec{}, forwarders: map[string]*chha.Forwarders{}, containers: map[string]string{},
		wake: make(chan struct{}, 1)}
	witnessNode.keeperWitnesses = w
	stopWitness := make(chan struct{})
	witnessLoop := sync.WaitGroup{}
	var witnessHeld atomic.Bool
	t.Cleanup(func() {
		select {
		case <-stopWitness:
		default:
			close(stopWitness)
		}
		witnessLoop.Wait()
		w.remove(context.Background(), mwWitness, keeperWitnessName(mwWitness))
	})

	// Members: storage-profile nodes with their member runtime.
	t.Cleanup(func() {
		h.mu.Lock()
		members := append([]*mwMember(nil), h.members...)
		h.mu.Unlock()
		for _, m := range members {
			m.forget()
		}
		if t.Failed() {
			for _, member := range mwMembers {
				out, _ := h.run("logs", "--tail", "40", member.name)
				t.Logf("--- %s logs:\n%s", member.name, out)
				out, _ = h.run("exec", member.name, "bash", "-c", "grep -iE 'raft|keeper' /var/log/clickhouse-server/clickhouse-server.err.log | tail -20")
				t.Logf("--- %s keeper errors:\n%s", member.name, out)
			}
			out, _ := h.run("logs", "--tail", "40", keeperWitnessName(mwWitness))
			t.Logf("--- witness logs:\n%s", out)
			if os.Getenv("CHHA_KEEP") != "" {
				return
			}
		}
		cleanup()
	})
	ctx := context.Background()
	members := make([]*mwMember, len(mwMembers))
	for i, spec := range mwMembers {
		h.must("network", "create", "--subnet", spec.subnet, spec.network)
		mount := filepath.Join(root, spec.name)
		if err := os.MkdirAll(mount, 0o777); err != nil {
			t.Fatal(err)
		}
		_ = os.Chmod(mount, 0o777)
		if err := os.WriteFile(filepath.Join(mount, "secret"), []byte("internal-secret-"+spec.name+"-0123456789abcdef"), 0o600); err != nil {
			t.Fatal(err)
		}
		m := &mwMember{h: h, spec: spec, mount: mount, plugin: nodes[spec.id], config: mwMemberConfig(i), known: true,
			mesh: &clickHouseMemberRuntime{plugin: nodes[spec.id], setID: mwSetID}}
		engine, err := chha.New(m.config, m)
		if err != nil {
			t.Fatal(err)
		}
		m.engine = engine
		nodes[spec.id].SetSetMemberRuntime(mwSetRuntime{m: m})
		h.mu.Lock()
		h.members = append(h.members, m)
		h.mu.Unlock()
		members[i] = m
	}
	// Every endpoint is registered on the relay and every daemon has its lane.
	mwWaitFor(t, "relay registrations", 30*time.Second, func() (bool, string) {
		h.relay.mu.Lock()
		defer h.relay.mu.Unlock()
		missing := []string{}
		for _, endpoint := range routes {
			if _, ok := h.relay.targets[endpoint]; !ok {
				missing = append(missing, endpoint)
			}
		}
		return len(missing) == 0, strings.Join(missing, ",")
	})

	// The witness: ApplyWitnesses as Gateway sends it, then the node's reconcile pass every 5 s (keeperWitnessTick).
	result := &pb.CommandResult{}
	witnessNode.handleApplyKeeperWitnesses(&pb.ApplyWitnessesCommand{Revision: 1, Witnesses: []*pb.WitnessSpec{mwWitnessSpec()}}, result)
	if !result.Success {
		t.Fatalf("apply the witness: %s", result.Error)
	}
	witnessLoop.Add(1)
	go func() {
		defer witnessLoop.Done()
		for {
			if !witnessHeld.Load() {
				pass, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
				w.reconcile(pass)
				cancel()
			}
			select {
			case <-stopWitness:
				return
			case <-time.After(keeperWitnessTick):
			case <-w.wake:
			}
		}
	}()
	witnessAddress := func() string {
		address, _, err := w.target(mwWitness)
		if err != nil {
			return ""
		}
		return net.JoinHostPort(address, strconv.Itoa(mwWitnessClient))
	}
	mwWaitFor(t, "witness container running", 5*time.Minute, func() (bool, string) {
		address := witnessAddress()
		return address != "", address
	})

	// The members start as copies (standby at rest); the member runtime's status sampling runs for each.
	for _, m := range members {
		if err := m.engine.PrepareStandby(ctx); err != nil {
			t.Fatal(err)
		}
		h.must("create", "--name", m.spec.name, "--network", m.spec.network, "--ip", m.spec.ip, "--memory", "1500m",
			"--ulimit", "nofile=262144:262144", "-v", m.mount+":/var/lib/clickhouse",
			"-v", filepath.Join(m.mount, chha.ServerConfigFile)+":"+chha.ServerConfigTarget+":ro",
			"-v", filepath.Join(m.mount, chha.UsersConfigFile)+":"+chha.UsersConfigTarget+":ro",
			"-v", filepath.Join(m.mount, chha.RoleConfigFile)+":"+chha.RoleConfigTarget+":ro", image)
		if err := m.engine.Start(ctx); err != nil {
			t.Fatal(err)
		}
	}
	stopSampling := make(chan struct{})
	sampling := sync.WaitGroup{}
	for _, m := range members {
		sampling.Add(1)
		go func(m *mwMember) {
			defer sampling.Done()
			for {
				select {
				case <-stopSampling:
					return
				case <-time.After(2 * time.Second):
				}
				if state, _, err := m.Container(context.Background()); err == nil && state.Running {
					sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					_, _ = m.engine.Status(sctx)
					cancel()
				}
			}
		}(m)
	}
	t.Cleanup(func() {
		close(stopSampling)
		sampling.Wait()
	})
	mode := func(m *mwMember) string { return mwKeeperMode(m.spec.ip + ":9181") }
	status := func(m *mwMember) memberha.EngineStatus {
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s, err := m.engine.Status(sctx)
		if err != nil {
			return memberha.EngineStatus{Detail: err.Error()}
		}
		return s
	}
	a, b := members[0], members[1]

	// 1. Keeper quorum over the mesh: the members serve, the witness takes part.
	mwWaitFor(t, "Keeper quorum on both members and the witness", 3*time.Minute, func() (bool, string) {
		ma, mb, mw := mode(a), mode(b), mwKeeperMode(witnessAddress())
		return mwServing(ma) && mwServing(mb) && mwServing(mw), ma + "/" + mb + "/witness " + mw
	})

	// 2. a is the holder: it asks its Keeper to lead when it follows (HolderWork's rqld), the witness follows.
	healthy := []byte(`{"v":1,"quorum":2,"degraded":false}`)
	if err := a.engine.Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	mwWaitFor(t, "a member leads, the witness follows", 3*time.Minute, func() (bool, string) {
		ma, mb, mw := mode(a), mode(b), mwKeeperMode(witnessAddress())
		return (ma == "leader" || mb == "leader") && mw == "follower", ma + "/" + mb + "/witness " + mw
	})
	keeperConfig, err := a.KeeperClient(ctx, "get '/keeper/config'")
	if err != nil {
		t.Fatal(err)
	}
	loopback := mwLoopbackHost(mwSetID)
	for _, want := range []string{
		fmt.Sprintf("server.1=%s:39501;participant", loopback), fmt.Sprintf("server.2=%s:39502;participant", loopback),
		fmt.Sprintf("server.%d=%s:%d;participant", mwWitnessID, loopback, mwWitnessRaft),
	} {
		if !strings.Contains(keeperConfig, want) {
			t.Fatalf("the holder's Keeper configuration lacks %q:\n%s", want, keeperConfig)
		}
	}
	t.Logf("Keeper configuration:\n%s", strings.TrimSpace(keeperConfig))
	// The Keepers' own traffic: the leader's connections to its followers.
	h.logRoutes("after the first election")
	if h.routeOpens(mwWitnessRouteID(mwMemberA, mwWitness))+h.routeOpens(mwWitnessRouteID(mwMemberB, mwWitness))+
		h.routeOpens(mwWitnessRouteID(mwWitness, mwMemberA))+h.routeOpens(mwWitnessRouteID(mwWitness, mwMemberB)) == 0 {
		t.Fatal("the witness and the members exchanged no tunnel over the witness routes")
	}
	// Every direction of the mesh, probed from inside each container's network namespace: a connection to a
	// server's loopback endpoint there is carried over the route Gateway named for it.
	pidOf := func(name string) int {
		out, _ := h.run("inspect", "-f", "{{.State.Pid}}", name)
		pid, _ := strconv.Atoi(out)
		return pid
	}
	witnessPid := func() int { return pidOf(keeperWitnessName(mwWitness)) }
	probeRoute := func(from string, pid int, port int, route string) {
		t.Helper()
		before := h.routeOpens(route)
		conn, err := dialInNetns(pid, net.JoinHostPort(loopback, strconv.Itoa(port)))
		if err != nil {
			t.Fatalf("%s: dial %s:%d in its namespace: %v", from, loopback, port, err)
		}
		defer conn.Close()
		mwWaitFor(t, fmt.Sprintf("%s reaches port %d over route %s", from, port, route), 30*time.Second, func() (bool, string) {
			opens := h.routeOpens(route)
			return opens > before, fmt.Sprint(opens)
		})
	}
	probeRoute("a", pidOf(a.spec.name), mwWitnessRaft, mwWitnessRouteID(mwMemberA, mwWitness))
	probeRoute("b", pidOf(b.spec.name), mwWitnessRaft, mwWitnessRouteID(mwMemberB, mwWitness))
	probeRoute("the witness", witnessPid(), 39501, mwWitnessRouteID(mwWitness, mwMemberA))
	probeRoute("the witness", witnessPid(), 39502, mwWitnessRouteID(mwWitness, mwMemberB))
	probeRoute("a", pidOf(a.spec.name), 39502, mwPeerRouteID(mwMemberA, mwMemberB, "ch-keeper"))
	probeRoute("b", pidOf(b.spec.name), 39501, mwPeerRouteID(mwMemberB, mwMemberA, "ch-keeper"))
	// Each member's endpoint is bound in the witness's network namespace (the witness reaches the members only there).
	for _, member := range mwMembers {
		endpoint := net.JoinHostPort(loopback, strconv.Itoa(39501+member.index))
		if !listeningInNetns(t, witnessPid(), endpoint) {
			t.Fatalf("member endpoint %s is not bound in the witness's namespace", endpoint)
		}
	}

	// 3. Replication over the interserver routes.
	mwWaitFor(t, "Replicated database app on both members", 2*time.Minute, func() (bool, string) {
		ea, _ := a.Query(ctx, "SELECT engine FROM system.databases WHERE name = 'app'")
		eb, _ := b.Query(ctx, "SELECT engine FROM system.databases WHERE name = 'app'")
		return strings.TrimSpace(ea) == "Replicated" && strings.TrimSpace(eb) == "Replicated", strings.TrimSpace(ea) + "/" + strings.TrimSpace(eb)
	})
	if _, err := a.Query(ctx, "CREATE TABLE app.ledger (id UInt64) ORDER BY id"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 10; i++ {
		if _, err := a.Query(ctx, fmt.Sprintf("INSERT INTO app.ledger SELECT number + %d FROM numbers(100)", i*1000)); err != nil {
			t.Fatalf("quorum insert %d: %v", i, err)
		}
	}
	rows := func(m *mwMember) int {
		out, err := m.Query(ctx, "SELECT count() FROM app.ledger")
		if err != nil {
			return -1
		}
		n, _ := strconv.Atoi(strings.TrimSpace(out))
		return n
	}
	mwWaitFor(t, "b has every row", time.Minute, func() (bool, string) {
		return rows(b) == rows(a), fmt.Sprint(rows(a), "/", rows(b))
	})
	if h.routeOpens(mwPeerRouteID(mwMemberB, mwMemberA, "ch-interserver")) == 0 {
		t.Fatal("b fetched no part over its interserver route")
	}

	// 4. b is lost: a and the witness keep the Keeper quorum (a's writes need no copy: quorum 1 for this insert).
	if err := b.engine.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	quorumInsert := func(m *mwMember, base int) error {
		qctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		_, err := m.Query(qctx, fmt.Sprintf("INSERT INTO app.ledger SETTINGS insert_quorum = 1 SELECT number + %d FROM numbers(10)", base))
		return err
	}
	mwWaitFor(t, "a writes with b down (Keeper quorum with the witness)", 2*time.Minute, func() (bool, string) {
		err := quorumInsert(a, 500000)
		return err == nil, fmt.Sprint(mode(a), " ", err)
	})
	// Losing the witness as well loses the quorum: the witness's vote is what kept it. The witness container stops
	// while the node's reconcile pass is held; the next pass starts it again, in a new network namespace.
	before := witnessPid()
	witnessHeld.Store(true)
	h.must("stop", "-t", "2", keeperWitnessName(mwWitness))
	mwWaitFor(t, "a cannot write while b and the witness are down", 2*time.Minute, func() (bool, string) {
		err := quorumInsert(a, 550000)
		return err != nil, fmt.Sprint(mode(a), " ", err)
	})
	witnessHeld.Store(false)
	select {
	case w.wake <- struct{}{}:
	default:
	}
	mwWaitFor(t, "witness restarted", 2*time.Minute, func() (bool, string) {
		pid := witnessPid()
		return pid != 0 && pid != before, fmt.Sprint(pid)
	})
	mwWaitFor(t, "member endpoints bound in the restarted witness's namespace", 30*time.Second, func() (bool, string) {
		pid := witnessPid()
		bound := []string{}
		for _, member := range mwMembers {
			endpoint := net.JoinHostPort(loopback, strconv.Itoa(39501+member.index))
			if listeningInNetns(t, pid, endpoint) {
				bound = append(bound, endpoint)
			}
		}
		return len(bound) == len(mwMembers), strings.Join(bound, ",")
	})
	probeRoute("the restarted witness", witnessPid(), 39501, mwWitnessRouteID(mwWitness, mwMemberA))
	mwWaitFor(t, "a writes again with the restarted witness", 2*time.Minute, func() (bool, string) {
		err := quorumInsert(a, 600000)
		return err == nil, fmt.Sprint(mode(a), " witness ", mwKeeperMode(witnessAddress()), " ", err)
	})

	// 5. b returns and catches up.
	if err := b.engine.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	mwWaitFor(t, "b back and caught up", 3*time.Minute, func() (bool, string) {
		return rows(a) == rows(b) && mwServing(mode(b)), fmt.Sprint(rows(a), "/", rows(b), " ", mode(b))
	})

	// 6. The holder a is lost: b and the witness keep the quorum; b is eligible and takes over.
	total := rows(a)
	if err := a.engine.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	lost := time.Now()
	mwWaitFor(t, "b eligible without a", 2*time.Minute, func() (bool, string) {
		s := status(b)
		ok, reason := b.engine.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: healthy, Holder: "node-" + mwMemberA[:4]}}, s)
		return ok, reason + " " + s.Position["keeperMode"] + " witness " + mwKeeperMode(witnessAddress())
	})
	if err := b.engine.Promote(ctx, healthy); err != nil {
		t.Fatal(err)
	}
	mwWaitFor(t, "b writes without a", 2*time.Minute, func() (bool, string) {
		err := quorumInsert(b, 700000)
		return err == nil, fmt.Sprint(mode(b), " ", err)
	})
	t.Logf("b writable %.1fs after a was lost", time.Since(lost).Seconds())
	h.logRoutes("at the end")
	if got := rows(b); got < total+10 {
		t.Fatalf("rows on b after the takeover: %d, want at least %d", got, total+10)
	}
}
