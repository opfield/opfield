//go:build swhacontainer

package docker

// Container test of SeaweedFS availability members (P2-T05): two members on
// one Docker host, each on its own network with the daemon's container
// commands, staged configuration and hosts file; the test process plays the
// member mesh (it listens on each network's gateway and carries connections
// to the other member's engine, as the relays do, the primary alias through
// the primary's gated DialPeer). It drives the swha engines the way the member
// runtime does. Run on a build host with a Docker engine:
//
//	DOCKER_HOST=unix:///run/dbha/docker.sock go test -tags swhacontainer -run TestSeaweedFSSetContainers -v ./internal/docker/
//
// It needs the pinned seaweedfs-gateway image (pulled when missing).

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/swha"
)

const (
	ctSet     = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ctStorage = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	ctA       = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	ctB       = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	ctAccess  = "gwctroot"
	ctSecret  = "gwctsecret0123456789"
	ctBucket  = "bkt"
)

// ctMesh carries mesh connections between the two members.
type ctMesh struct {
	mu      sync.Mutex
	hosts   map[string]*ctHost
	primary string
}

func (m *ctMesh) setPrimary(id string) { m.mu.Lock(); m.primary = id; m.mu.Unlock() }

// dial carries a connection from member "from" to alias.
func (m *ctMesh) dial(ctx context.Context, from, alias string) (net.Conn, error) {
	m.mu.Lock()
	primary := m.primary
	source := m.hosts[from]
	m.mu.Unlock()
	if rest, ok := strings.CutPrefix(alias, "primary-"); ok {
		if source.local != nil {
			if conn, ok := source.local(ctx, rest); ok {
				return conn, nil
			}
		}
		target := m.hosts[primary]
		if target == nil || target.down() {
			return nil, errors.New("no primary admitted")
		}
		return target.engine.DialPeer(ctx, rest)
	}
	for id, target := range m.hosts {
		if rest, ok := strings.CutPrefix(alias, "member-"+id+"-"); ok {
			if target.down() {
				return nil, errors.New("member unreachable")
			}
			return target.engine.DialPeer(ctx, rest)
		}
	}
	return nil, fmt.Errorf("no route for %s", alias)
}

// ctHost is one member's swha.Host on the test Docker host.
type ctHost struct {
	t        *testing.T
	mesh     *ctMesh
	cfg      memberha.Config
	index    uint32
	network  string
	gateway  netip.Addr
	dir      string
	key      string
	local    func(ctx context.Context, port string) (net.Conn, bool)
	engine   *swha.Engine
	isolated bool
	mu       sync.Mutex
}

func (h *ctHost) name(role swha.Role) string { return fmt.Sprintf("ct-sw-%d-%s", h.index, role) }
func (h *ctHost) down() bool                 { h.mu.Lock(); defer h.mu.Unlock(); return h.isolated }
func (h *ctHost) Config() memberha.Config    { return h.cfg }

func (h *ctHost) inspect(role swha.Role) (map[string]any, error) {
	out, err := dockerCLI("inspect", h.name(role))
	if err != nil {
		if strings.Contains(out, "No such") {
			return nil, nil
		}
		return nil, fmt.Errorf("%v: %s", err, out)
	}
	var parsed []map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || len(parsed) == 0 {
		return nil, fmt.Errorf("decode inspect: %v", err)
	}
	return parsed[0], nil
}

func (h *ctHost) Container(_ context.Context, role swha.Role) (swha.ContainerInfo, error) {
	data, err := h.inspect(role)
	if err != nil || data == nil {
		return swha.ContainerInfo{}, err
	}
	state := data["State"].(map[string]any)
	started, _ := time.Parse(time.RFC3339Nano, state["StartedAt"].(string))
	return swha.ContainerInfo{Exists: true, Running: state["Running"].(bool), ID: data["Id"].(string), StartedAt: started}, nil
}

func (h *ctHost) Start(_ context.Context, role swha.Role) error {
	_, err := dockerCLI("start", h.name(role))
	return err
}

func (h *ctHost) Stop(_ context.Context, role swha.Role, timeout time.Duration) error {
	_, err := dockerCLI("stop", "-t", strconv.Itoa(max(1, int(timeout.Seconds()))), h.name(role))
	return err
}

func (h *ctHost) Kill(_ context.Context, role swha.Role) error {
	out, err := dockerCLI("kill", h.name(role))
	if err != nil && strings.Contains(out, "is not running") {
		return nil
	}
	return err
}

func (h *ctHost) CgroupEmpty(ctx context.Context, role swha.Role) (bool, error) {
	info, err := h.Container(ctx, role)
	return !info.Running, err
}

func (h *ctHost) EnsureNoRestart(context.Context, swha.Role) error { return nil }

func (h *ctHost) DialContainer(ctx context.Context, role swha.Role, port uint16) (net.Conn, error) {
	data, err := h.inspect(role)
	if err != nil || data == nil {
		return nil, errors.New("no container")
	}
	networks := data["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
	endpoint, ok := networks[h.network].(map[string]any)
	if !ok || endpoint["IPAddress"] == "" {
		return nil, errors.New("not on the network")
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(endpoint["IPAddress"].(string), strconv.Itoa(int(port))))
}

func (h *ctHost) Exec(ctx context.Context, role swha.Role, command []string, stdin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", append([]string{"exec", "-i", h.name(role)}, command...)...)
	cmd.Stdin = strings.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("%v: %s", err, stderr.String())
	}
	return out, nil
}

func (h *ctHost) DialAlias(ctx context.Context, alias string) (net.Conn, error) {
	return h.mesh.dial(ctx, h.cfg.MemberID, alias)
}

func (h *ctHost) Expose([]swha.Exposure) {}
func (h *ctHost) SetLocalPrimary(dial func(ctx context.Context, port string) (net.Conn, bool)) {
	h.local = dial
}
func (h *ctHost) FilerToken() (string, error) {
	return swha.SignFilerToken([]byte(h.key), time.Now().Add(time.Minute))
}
func (h *ctHost) DiskFree() (uint64, bool, bool) { return 0, false, false }
func (h *ctHost) StateDir() string               { return filepath.Join(h.dir, "engine") }
func (h *ctHost) Serve()                         {}
func (h *ctHost) Logger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// listen serves the mesh listeners of this member on its network's gateway.
func (h *ctHost) listen(t *testing.T) {
	for _, exposure := range swha.Exposures(h.cfg.MemberID, setMemberRefs(ctMembers())) {
		listener, err := net.Listen("tcp", net.JoinHostPort(h.gateway.String(), strconv.Itoa(int(exposure.Port))))
		if err != nil {
			t.Fatalf("mesh listener %s: %v", exposure.Alias, err)
		}
		t.Cleanup(func() { _ = listener.Close() })
		alias := exposure.Alias
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					upstream, err := h.mesh.dial(ctx, h.cfg.MemberID, alias)
					cancel()
					if err != nil || h.down() {
						_ = conn.Close()
						return
					}
					pipeConns(conn, upstream)
				}()
			}
		}()
	}
}

func ctMembers() []managedStorageSetMember {
	return []managedStorageSetMember{{MemberID: ctA, MemberIndex: 0}, {MemberID: ctB, MemberIndex: 1}}
}

func ctImage(t *testing.T) string {
	t.Helper()
	if _, err := dockerCLI("image", "inspect", seaweedfsImage); err != nil {
		mustDocker(t, "pull", seaweedfsImage)
	}
	return seaweedfsImage
}

// startMember creates one member's network, staged files and containers.
func startMember(t *testing.T, root string, mesh *ctMesh, memberID string, index uint32, subnet string) *ctHost {
	t.Helper()
	network := fmt.Sprintf("ct-sw-net-%d", index)
	_, _ = dockerCLI("network", "rm", network)
	prefix := netip.MustParsePrefix(subnet)
	gateway := prefix.Addr().Next()
	mustDocker(t, "network", "create", "--internal", "--subnet", subnet, "--gateway", gateway.String(), network)
	t.Cleanup(func() { _, _ = dockerCLI("network", "rm", network) })
	dir := filepath.Join(root, fmt.Sprintf("member-%d", index))
	for _, sub := range []string{"data", "config", "engine"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	keyBytes := make([]byte, 32)
	_, _ = rand.Read(keyBytes)
	key := hex.EncodeToString(keyBytes)
	identities, _ := seaweedfsIdentityFile(managedStorageRootCreds{AccessKey: ctAccess, SecretKey: ctSecret})
	snowflake, _ := swha.SnowflakeID(index)
	files := map[string]string{
		"config/s3.json":       string(identities),
		"config/security.toml": "[jwt.filer_signing]\nkey = \"" + key + "\"\n",
		"config/master.toml":   seaweedfsMasterConfig + fmt.Sprintf("\n[master.sequencer]\ntype = \"snowflake\"\nsequencer_snowflake_id = %d\n", snowflake),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manager := &managedStorageManager{root: root}
	exposures := swha.Exposures(memberID, setMemberRefs(ctMembers()))
	hostsPath, err := manager.writeSetHosts(ctStorage, index, gateway, exposures)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("chown", "-R", "1000:1000", filepath.Join(dir, "data")).CombinedOutput(); err != nil {
		t.Fatalf("chown: %v %s", err, out)
	}
	record := managedStorageRecord{ID: ctStorage, MemberIndex: int(index), StorageBytes: 4 << 30, MemoryBytes: 1 << 30,
		Set: &managedStorageSetRecord{SetID: ctSet, MemberID: memberID, MemberIndex: index}}
	image := ctImage(t)
	for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler, swha.RoleMaster} {
		name := fmt.Sprintf("ct-sw-%d-%s", index, role)
		_, _ = dockerCLI("rm", "-f", name)
		args := []string{"create", "--name", name, "--network", network, "--user", "1000:1000",
			"-v", filepath.Join(dir, "config") + ":" + seaweedfsContainerRoot + "/config:ro",
			"-v", hostsPath + ":/etc/hosts:ro", "--entrypoint", "/usr/bin/weed"}
		var cmd []string
		switch role {
		case swha.RoleVolume:
			args = append(args, "--network-alias", swha.VolumeHost(memberID), "-v", filepath.Join(dir, "data")+":/data")
			cmd = seaweedfsSetVolumeCommand(record, *record.Set)
		case swha.RoleFiler:
			args = append(args, "--network-alias", swha.FilerHost(memberID), "-v", filepath.Join(dir, "data")+":/data")
			cmd = seaweedfsSetFilerCommand(record, *record.Set)
		case swha.RoleMaster:
			// The product's tmpfs (owned by the runtime user), not one of the test's own.
			args = append(args, "--tmpfs", seaweedfsSetMasterDataDir+":"+seaweedfsSetMasterTmpfs()[seaweedfsSetMasterDataDir])
			cmd = seaweedfsSetMasterCommand(record)
		}
		args = append(args, image)
		args = append(args, cmd...)
		mustDocker(t, args...)
		t.Cleanup(func() { _, _ = dockerCLI("rm", "-f", name) })
		if role != swha.RoleMaster {
			mustDocker(t, "start", name)
		}
	}
	host := &ctHost{t: t, mesh: mesh,
		cfg: memberha.Config{SetID: ctSet, MemberID: memberID, NodeID: "node-" + memberID[:4], Engine: "seaweedfs",
			OwnerKind: "managed_storage", OwnerID: ctStorage, Mode: memberha.ModeAutomatic,
			LeasePolicyID: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			Members:       []memberha.Peer{{MemberID: ctA, NodeID: "node-cccc", MemberIndex: 0}, {MemberID: ctB, NodeID: "node-dddd", MemberIndex: 1}}},
		index: index, network: network, gateway: gateway, dir: dir, key: key}
	engine, err := swha.New(host)
	if err != nil {
		t.Fatal(err)
	}
	host.engine = engine
	mesh.mu.Lock()
	mesh.hosts[memberID] = host
	mesh.mu.Unlock()
	host.listen(t)
	return host
}

func (h *ctHost) containerIP(role swha.Role) string {
	data, _ := h.inspect(role)
	networks := data["NetworkSettings"].(map[string]any)["Networks"].(map[string]any)
	return networks[h.network].(map[string]any)["IPAddress"].(string)
}

// ctS3 is a minimal signed S3 client (path style).
type ctS3 struct{ endpoint string }

func (h *ctHost) s3(t *testing.T) *ctS3 {
	t.Helper()
	return &ctS3{endpoint: "http://" + h.containerIP(swha.RoleFiler) + ":" + strconv.Itoa(swha.S3Port)}
}

func (c *ctS3) do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.ContentLength = int64(len(body))
	hash := sigV4Hash(body)
	req.Header.Set("X-Amz-Content-Sha256", hash)
	signSigV4(req, hash, ctAccess, ctSecret, "us-east-1", "s3", time.Now())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%s %s: HTTP %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func (c *ctS3) MakeBucket(ctx context.Context, bucket string) error {
	_, err := c.do(ctx, http.MethodPut, "/"+bucket, nil)
	return err
}

func (c *ctS3) PutObject(ctx context.Context, bucket, key string, body []byte) error {
	_, err := c.do(ctx, http.MethodPut, "/"+bucket+"/"+key, body)
	return err
}

func (c *ctS3) GetObject(ctx context.Context, bucket, key string) ([]byte, error) {
	return c.do(ctx, http.MethodGet, "/"+bucket+"/"+key, nil)
}

// drive samples both engines every second, like the member runtime.
func drive(ctx context.Context, hosts ...*ctHost) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		for _, h := range hosts {
			if !h.down() {
				sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				_, _ = h.engine.Status(sctx)
				cancel()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func topologyOf(t *testing.T, h *ctHost) swha.Topology {
	t.Helper()
	conn, err := h.DialContainer(context.Background(), swha.RoleMaster, swha.MasterHTTPPort)
	if err != nil {
		return swha.Topology{}
	}
	_ = conn.Close()
	resp, err := http.Get("http://" + h.containerIP(swha.RoleMaster) + ":" + strconv.Itoa(swha.MasterHTTPPort) + "/dir/status")
	if err != nil {
		return swha.Topology{}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	topology, _ := swha.ParseTopology(raw)
	return topology
}

func ctWaitUntil(t *testing.T, what string, timeout time.Duration, cond func() bool) time.Duration {
	t.Helper()
	start := time.Now()
	for !cond() {
		if time.Since(start) > timeout {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return time.Since(start)
}

type ctObject struct{ key, sum string }

// putLoop writes objects until stop, through whichever member target names.
var ctLastPutError error

func putLoop(ctx context.Context, target func() *ctS3, prefix string, acked *[]ctObject, errs *int, mu *sync.Mutex) {
	for i := 0; ctx.Err() == nil; i++ {
		body := make([]byte, 4096+i%8192)
		_, _ = rand.Read(body)
		sum := sha256.Sum256(body)
		key := fmt.Sprintf("%s-%06d", prefix, i)
		client := target()
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := client.PutObject(pctx, ctBucket, key, body)
		cancel()
		mu.Lock()
		if err == nil {
			*acked = append(*acked, ctObject{key: key, sum: hex.EncodeToString(sum[:])})
		} else {
			*errs++
			ctLastPutError = err
		}
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
}

func verifyObjects(t *testing.T, client *ctS3, objects []ctObject) int {
	t.Helper()
	bad := 0
	for _, object := range objects {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		data, err := client.GetObject(ctx, ctBucket, object.key)
		if err == nil {
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) != object.sum {
				err = errors.New("checksum differs")
			}
		}
		cancel()
		if err != nil {
			bad++
			if bad <= 5 {
				t.Logf("object %s: %v", object.key, err)
			}
		}
	}
	return bad
}

// fileIDs lists every chunk file id the filer holds for the bucket.
func fileIDs(t *testing.T, h *ctHost) []string {
	t.Helper()
	port, _ := swha.FilerPorts(h.index)
	var ids []string
	last := ""
	for {
		url := fmt.Sprintf("http://%s:%d/buckets/%s/?limit=1000&lastFileName=%s", h.containerIP(swha.RoleFiler), port, ctBucket, last)
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Accept", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var listing struct {
			Entries []struct {
				FullPath string `json:"FullPath"`
				Chunks   []struct {
					FileID string `json:"file_id"`
				} `json:"chunks"`
			} `json:"Entries"`
			LastFileName          string `json:"LastFileName"`
			ShouldDisplayLoadMore bool   `json:"ShouldDisplayLoadMore"`
		}
		err = json.NewDecoder(resp.Body).Decode(&listing)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range listing.Entries {
			for _, chunk := range entry.Chunks {
				ids = append(ids, chunk.FileID)
			}
		}
		if !listing.ShouldDisplayLoadMore || listing.LastFileName == "" {
			return ids
		}
		last = listing.LastFileName
	}
}

func TestSeaweedFSSetContainers(t *testing.T) {
	if os.Getenv("DOCKER_HOST") == "" {
		t.Skip("set DOCKER_HOST to a Docker engine")
	}
	root := t.TempDir()
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	mesh := &ctMesh{hosts: map[string]*ctHost{}}
	a := startMember(t, root, mesh, ctA, 0, "10.231.40.0/26")
	b := startMember(t, root, mesh, ctB, 1, "10.231.40.64/26")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go drive(ctx, a, b)

	// 1. A becomes the primary (bootstrap): both volume servers register.
	start := time.Now()
	if err := a.engine.Promote(ctx, mustValue(t, swha.Value{V: 1})); err != nil {
		t.Fatal(err)
	}
	mesh.setPrimary(ctA)
	ctWaitUntil(t, "both volume servers registered", 90*time.Second, func() bool {
		topology := topologyOf(t, a)
		return topology.Registered(swha.VolumeURL(ctA, 0)) && topology.Registered(swha.VolumeURL(ctB, 1))
	})
	t.Logf("A promoted and both volume servers registered in %s", time.Since(start))
	aS3 := a.s3(t)
	ctWaitUntil(t, "S3 on A", 60*time.Second, func() bool {
		return aS3.MakeBucket(ctx, ctBucket) == nil
	})

	var mu sync.Mutex
	var acked []ctObject
	errs := 0
	current := aS3
	target := func() *ctS3 { mu.Lock(); defer mu.Unlock(); return current }
	loopCtx, stopLoop := context.WithCancel(ctx)
	loopDone := make(chan struct{})
	go func() { putLoop(loopCtx, target, "obj", &acked, &errs, &mu); close(loopDone) }()
	time.Sleep(8 * time.Second)
	mu.Lock()
	t.Logf("before failover: %d acknowledged, %d errors (last: %v)", len(acked), errs, ctLastPutError)
	initial := len(acked)
	mu.Unlock()
	if initial == 0 {
		dumpLogs(t, a, b)
		t.Fatal("no write was acknowledged by the first primary")
	}

	// Metadata reaches B through filer peer sync; B is eligible under the
	// certified state A would have certified.
	var certifiedA []byte
	ctWaitUntil(t, "B eligible", 30*time.Second, func() bool {
		value, _, ok, _ := a.engine.NextValue(mustValue(t, swha.Value{V: 1}), memberha.EngineStatus{}, time.Hour)
		if !ok {
			return false
		}
		certifiedA = value
		eligible, reason := b.engine.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: value}}, memberha.EngineStatus{})
		if !eligible {
			t.Logf("B not eligible yet: %s", reason)
		}
		return eligible
	})

	// 2. A is lost (all of it): B takes over with a raised volume-id target.
	before := len(acked)
	a.mu.Lock()
	a.isolated = true
	a.mu.Unlock()
	lost := time.Now()
	for _, role := range []swha.Role{swha.RoleMaster, swha.RoleVolume, swha.RoleFiler} {
		_, _ = dockerCLI("kill", a.name(role))
	}
	mesh.setPrimary("")
	value, _ := decodeCT(certifiedA)
	base := value.MaxVolumeID
	value.MaxVolumeID = base + 5 // exercise the gate's grow + delete
	if err := b.engine.Promote(ctx, mustValue(t, value)); err != nil {
		t.Fatalf("B promotion: %v", err)
	}
	mesh.setPrimary(ctB)
	mu.Lock()
	current = b.s3(t)
	mu.Unlock()
	t.Logf("B promoted %s after A was lost", time.Since(lost))
	gwbump := 0
	for _, ids := range topologyOf(t, b).Nodes {
		for _, id := range ids {
			if id > base && id <= value.MaxVolumeID {
				gwbump++
			}
		}
	}
	if gwbump != 0 {
		t.Fatalf("throw-away volumes are left in the topology")
	}
	// B degrades after the grace (A silent), asks for a master restart: the
	// runtime promotes again.
	ctWaitUntil(t, "B degraded", 60*time.Second, func() bool {
		status, _ := b.engine.Status(ctx)
		return status.Position["degradedSince"] != "" && !status.Writable
	})
	if err := b.engine.Promote(ctx, mustValue(t, swha.Value{V: 1, MaxVolumeID: value.MaxVolumeID, DegradedSince: 1})); err != nil {
		t.Fatalf("B second promotion: %v", err)
	}
	time.Sleep(10 * time.Second)
	mu.Lock()
	afterFailover := len(acked) - before
	mu.Unlock()
	if afterFailover == 0 {
		t.Logf("last error: %v", ctLastPutError)
		dumpLogs(t, b)
		t.Fatal("no write was acknowledged after the failover")
	}
	t.Logf("writes after failover: %d (errors so far %d)", afterFailover, errs)
	for _, ids := range topologyOf(t, b).Nodes {
		for _, id := range ids {
			if id > base && id <= value.MaxVolumeID {
				out, _ := dockerCLI("logs", b.name(swha.RoleMaster))
				for _, line := range strings.Split(out, "\n") {
					if strings.Contains(line, "olume") && !strings.Contains(line, "heartbeat") {
						t.Log(line)
					}
				}
				t.Fatalf("volume id %d inside the raised range was handed out", id)
			}
		}
	}

	// 3. A returns as a copy (no master): B repairs the replication.
	a.mu.Lock()
	a.isolated = false
	a.mu.Unlock()
	for _, role := range []swha.Role{swha.RoleVolume, swha.RoleFiler} {
		mustDocker(t, "start", a.name(role))
	}
	repairTook := ctWaitUntil(t, "replication repaired", 5*time.Minute, func() bool {
		status, _ := b.engine.Status(ctx)
		return status.Position["degradedSince"] == "" && status.Writable
	})
	t.Logf("repair finished %s after A returned", repairTook)
	stopLoop()
	<-loopDone

	// 4. Every acknowledged object is readable from both members, no file id
	// was handed out twice.
	mu.Lock()
	objects := append([]ctObject(nil), acked...)
	mu.Unlock()
	time.Sleep(3 * time.Second)
	if bad := verifyObjects(t, b.s3(t), objects); bad != 0 {
		t.Fatalf("%d of %d acknowledged objects unreadable on B", bad, len(objects))
	}
	if bad := verifyObjects(t, a.s3(t), objects); bad != 0 {
		t.Fatalf("%d of %d acknowledged objects unreadable on A", bad, len(objects))
	}
	ids := fileIDs(t, b)
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			t.Fatalf("file id %s used twice", id)
		}
		seen[id] = true
	}
	t.Logf("%d objects verified on both members, %d unique file ids, %d write errors", len(objects), len(ids), errs)

	// 5. Planned switchover B -> A.
	if err := b.engine.Switchover(ctx, ctA); err != nil {
		t.Fatal(err)
	}
	if err := b.engine.StopClean(ctx, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	mesh.setPrimary("")
	if err := a.engine.Promote(ctx, mustValue(t, swha.Value{V: 1, MaxVolumeID: topologyOf(t, a).MaxVolumeID})); err != nil {
		t.Fatalf("switchover promotion: %v", err)
	}
	mesh.setPrimary(ctA)
	aS3 = a.s3(t)
	ctWaitUntil(t, "write after switchover", 60*time.Second, func() bool {
		return aS3.PutObject(ctx, ctBucket, "after-switch", []byte("x")) == nil
	})
	ctWaitUntil(t, "B registered with A", 60*time.Second, func() bool {
		return topologyOf(t, a).Registered(swha.VolumeURL(ctB, 1))
	})
}

func mustValue(t *testing.T, value swha.Value) []byte {
	t.Helper()
	value.V = 1
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func decodeCT(raw []byte) (swha.Value, error) {
	var value swha.Value
	err := json.Unmarshal(raw, &value)
	return value, err
}

func dumpLogs(t *testing.T, hosts ...*ctHost) {
	for _, h := range hosts {
		for _, role := range []swha.Role{swha.RoleMaster, swha.RoleVolume, swha.RoleFiler} {
			out, _ := dockerCLI("logs", "--tail", "25", h.name(role))
			t.Logf("--- %s logs:\n%s", h.name(role), out)
		}
	}
}
