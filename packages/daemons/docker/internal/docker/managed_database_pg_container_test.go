//go:build pghacontainer

package docker

// Container test of Postgres availability members (P2-T01): two members on
// one Docker host, each with its own daemon state (node A and node B: their own
// managed database manager, records and storage), real postgres images and the
// daemon's own code paths. The origin is a single-node database created with
// the daemon's create, converted with availability_member_ensure (origin); the
// copy is prepared with availability_member_ensure (copy) and seeded with
// pg_basebackup through the generic member mesh (setMesh: the set's internal
// network, primary-pg-repl on its gateway). The test process plays the relays:
// the mesh's peer bridge carries primary-pg-repl to the current primary's
// DialPeer. It drives the pgha engines the way the member runtime does (status
// samples, holder work and certified values, copy work, eligibility,
// promotion, rejoin, staged switchover). Storage images are files (fallocate,
// mkfs) with the loop mount replaced by a plain directory.
//
// Run on a build host with a private Docker engine (root):
//
//	DOCKER_HOST=unix:///run/hapg2/docker.sock go test -tags pghacontainer -run TestPostgresSetContainers -v -timeout 20m ./internal/docker/
//
// PGHA_CT_IMAGE picks one of the curated postgres images (default: the first
// curated digest in sorted order); it is pulled when missing.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/opfield/opfield/docker-daemon/internal/config"
	"github.com/opfield/opfield/docker-daemon/internal/memberha"
	"github.com/opfield/opfield/docker-daemon/internal/pgha"
)

const (
	pgctSet        = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"
	pgctA          = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"
	pgctB          = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
	pgctDBA        = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"
	pgctDBB        = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5"
	pgctPolicy     = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6"
	pgctOwner      = "app_owner"
	pgctOwnerPass  = "owner-password-0123456789"
	pgctRoleA      = "gw_repl_ct_a"
	pgctRoleB      = "gw_repl_ct_b"
	pgctPassA      = "replication-a-0123456789"
	pgctPassB      = "replication-b-0123456789"
	pgctRewind     = "gw_rewind_ct"
	pgctRewindPass = "rewind-password-0123456789"
	pgctSyncRows   = 200
)

// pgctLoops replaces the loop devices: an image "mounts" as a plain directory.
type pgctLoops struct {
	mu      sync.Mutex
	mounted map[string]bool
}

func (l *pgctLoops) host() *loopHost {
	return &loopHost{
		loops: func() ([]loopDevice, error) { return nil, nil },
		mounts: func() ([]mountEntry, error) {
			l.mu.Lock()
			defer l.mu.Unlock()
			out := make([]mountEntry, 0, len(l.mounted))
			for path := range l.mounted {
				out = append(out, mountEntry{MountPoint: path})
			}
			return out, nil
		},
		identity: func(string) (uint64, uint64, bool) { return 0, 0, false },
		unmount: func(_ context.Context, path string) error {
			l.mu.Lock()
			defer l.mu.Unlock()
			delete(l.mounted, canonicalLoopPath(path))
			return nil
		},
		detach: func(context.Context, string) error { return nil },
		sleep:  func(context.Context, time.Duration) error { return nil },
		attach: func(context.Context, string) (string, error) { return "/dev/pgct-loop", nil },
		mount: func(_ context.Context, _, path, _ string) error {
			// A fresh ext4 root is 0755 root:root (the mount point the daemon
			// made is 0700 underneath).
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
			if err := os.Chmod(path, 0o755); err != nil {
				return err
			}
			l.mu.Lock()
			defer l.mu.Unlock()
			l.mounted[canonicalLoopPath(path)] = true
			return nil
		},
		placeholder: func(context.Context, string) error { return nil },
	}
}

// pgctNode is one member's node: its own daemon state on the shared engine.
type pgctNode struct {
	name     string
	memberID string
	dbID     string
	plugin   *DockerPlugin
	m        *managedDatabaseManager
	engine   *pgSetMemberEngine
}

func (n *pgctNode) containerID(t *testing.T) string {
	t.Helper()
	record, err := n.m.loadRecord(n.dbID)
	if err != nil {
		t.Fatalf("%s record: %v", n.name, err)
	}
	return record.ContainerID
}

// sql runs statements as the owner through the member's unix socket.
func (n *pgctNode) sql(t *testing.T, statements ...string) (string, error) {
	t.Helper()
	args := []string{"exec", "-u", "postgres", n.containerID(t), "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
		"-h", "/var/run/postgresql", "-U", pgctOwner, "-d", "app"}
	for _, statement := range statements {
		args = append(args, "-c", statement)
	}
	return dockerCLI(args...)
}

func (n *pgctNode) count(t *testing.T, kind string) int {
	t.Helper()
	out, err := n.sql(t, "SELECT count(*) FROM ct_rows WHERE kind = '"+kind+"'")
	if err != nil {
		return -1
	}
	value, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return -1
	}
	return value
}

func (n *pgctNode) status(t *testing.T) memberha.EngineStatus {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	status, err := n.engine.Status(ctx)
	if err != nil {
		t.Logf("%s status: %v", n.name, err)
	}
	return status
}

// pgctRouter plays the relays: the mesh's peer bridge carries primary-pg-repl
// to the current primary's gated DialPeer; an isolated node takes nothing.
type pgctRouter struct {
	mu       sync.Mutex
	primary  *pgctNode
	isolated map[*pgctNode]bool
	conns    map[net.Conn]*pgctNode
}

func (r *pgctRouter) setPrimary(n *pgctNode) { r.mu.Lock(); r.primary = n; r.mu.Unlock() }

func (r *pgctRouter) isolate(n *pgctNode, isolated bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.isolated[n] = isolated
	if !isolated {
		return
	}
	for conn, target := range r.conns {
		if target == n {
			_ = conn.Close()
		}
	}
}

func (r *pgctRouter) bridge(conn net.Conn, setID, alias string) error {
	r.mu.Lock()
	target := r.primary
	if target != nil && r.isolated[target] {
		target = nil
	}
	r.mu.Unlock()
	if setID != pgctSet || alias != pgReplicationHost || target == nil {
		_ = conn.Close()
		return errors.New("no primary admitted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	upstream, err := target.engine.DialPeer(ctx, pgha.ReplicationPort)
	cancel()
	if err != nil {
		_ = conn.Close()
		return err
	}
	r.mu.Lock()
	r.conns[conn], r.conns[upstream] = target, target
	r.mu.Unlock()
	pipeConns(conn, upstream)
	r.mu.Lock()
	delete(r.conns, conn)
	delete(r.conns, upstream)
	r.mu.Unlock()
	return nil
}

// pgctRun is the member runtime's part the test plays: one holder with its
// certified value (committed at once), status samples, holder and copy work.
type pgctRun struct {
	t      *testing.T
	router *pgctRouter
	nodes  []*pgctNode
	mu     sync.Mutex // a tick, or a role change of the test
	holder *pgctNode
	cert   []byte
}

func (r *pgctRun) value() pgha.Value {
	r.mu.Lock()
	defer r.mu.Unlock()
	value, err := pgha.DecodeValue(r.cert)
	if err != nil {
		r.t.Fatalf("certified value: %v", err)
	}
	return value
}

func (r *pgctRun) tick(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, n := range r.nodes {
		r.router.mu.Lock()
		isolated := r.router.isolated[n]
		r.router.mu.Unlock()
		if isolated || ctx.Err() != nil {
			continue
		}
		sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		status, err := n.engine.Status(sctx)
		cancel()
		if err != nil {
			continue
		}
		now := bootWallClock{}.Now()
		if n == r.holder && status.Writable {
			for range 8 {
				kind, work, ok := n.engine.HolderWork(memberha.HolderView{Certified: r.cert, Status: status, Now: now, Free: true})
				if !ok {
					break
				}
				wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				err := work(wctx)
				cancel()
				if err != nil {
					r.t.Logf("%s holder work %s: %v", n.name, kind, err)
					break
				}
			}
			next, kind, ok, err := n.engine.NextValue(r.cert, status, now)
			if err != nil {
				r.t.Logf("%s next value: %v", n.name, err)
			} else if ok {
				r.cert = next
				value, _ := pgha.DecodeValue(next)
				r.t.Logf("%s certified %s: sync set %v degraded %v floor %s", n.name, kind, value.SyncSet, value.Degraded, value.EligibilityFloor)
			}
			continue
		}
		if kind, work, ok := n.engine.CopyWork(status, now); ok {
			wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := work(wctx); err != nil {
				r.t.Logf("%s copy work %s: %v", n.name, kind, err)
			}
			cancel()
		}
	}
}

func (r *pgctRun) drive(ctx context.Context, done *sync.WaitGroup) {
	defer done.Done()
	for ctx.Err() == nil {
		r.tick(ctx)
		select {
		case <-ctx.Done():
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func pgctWait(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func pgctConfig(memberID, dbID string) memberha.Config {
	own := pgctPassA
	if memberID == pgctB {
		own = pgctPassB
	}
	engine := pgha.EngineConfig{
		ReplicationRoles:    map[string]string{pgctA: pgctRoleA, pgctB: pgctRoleB},
		RewindRole:          pgctRewind,
		ReplicationPassword: own, RewindPassword: pgctRewindPass,
		Identities: &pgha.Identities{
			Replication: map[string]string{pgctRoleA: pgctPassA, pgctRoleB: pgctPassB},
			RewindRole:  pgctRewind, RewindPassword: pgctRewindPass,
		},
	}
	data, _ := json.Marshal(engine)
	return memberha.Config{
		SetID: pgctSet, MemberID: memberID, NodeID: "node-" + memberID[:4], Engine: "postgres",
		OwnerKind: "managed_database", OwnerID: dbID, Mode: memberha.ModeAutomatic, LeasePolicyID: pgctPolicy,
		Durability: pgha.DurabilitySynchronous, MaxLagBytes: 1 << 20, SyncDegradeAfterSeconds: 10,
		Members: []memberha.Peer{
			{MemberID: pgctA, NodeID: "node-" + pgctA[:4], MemberIndex: 0, Priority: 2},
			{MemberID: pgctB, NodeID: "node-" + pgctB[:4], MemberIndex: 1, Priority: 1},
		},
		ConfigRevision: 1, EngineConfig: data,
	}
}

// pgctTLS is the database CA and the one leaf every member serves and
// presents to the set roles (server and client use), with the profile
// Gateway's Database CA issues set member leaves with (tls-server key usages,
// serverAuth and clientAuth: database-ca.service.ts). PGHA_CT_TLS_DIR runs
// the test with leaves Gateway issued instead (ca.pem, cert.pem, key.pem).
func pgctTLS(t *testing.T) (ca, cert, key string) {
	t.Helper()
	if dir := os.Getenv("PGHA_CT_TLS_DIR"); dir != "" {
		read := func(name string) string {
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			return string(data)
		}
		return read("ca.pem"), read("cert.pem"), read("key.pem")
	}
	encode := func(kind string, der []byte) string {
		return string(pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}))
	}
	caKey := mustECDSAKey(t)
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ct database ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "managed-db-ct"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), DNSNames: []string{"database"},
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	return encode("CERTIFICATE", caDER), encode("CERTIFICATE", leafDER), encode("EC PRIVATE KEY", keyDER)
}

func pgctImage(t *testing.T) string {
	t.Helper()
	image := os.Getenv("PGHA_CT_IMAGE")
	if image == "" {
		var images []string
		for candidate := range curatedManagedDatabaseImages["postgres"] {
			images = append(images, candidate)
		}
		sort.Strings(images)
		image = images[0]
	}
	if !isCuratedDigestImage("postgres", image) {
		t.Fatalf("%s is no curated postgres image", image)
	}
	if _, err := dockerCLI("image", "inspect", image); err != nil {
		mustDocker(t, "pull", image)
	}
	return image
}

func newPGCTNode(t *testing.T, root, name, memberID, dbID string, client *Client, logger *slog.Logger, mesh *setMesh) *pgctNode {
	t.Helper()
	dir := filepath.Join(root, name)
	cfg := &config.Config{}
	cfg.StateDir = filepath.Join(dir, "state")
	cfg.Docker.Database.StorageRoot = filepath.Join(dir, "storage")
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	manager, err := newManagedDatabaseManager(cfg, client, logger.With("node", name))
	if err != nil {
		t.Fatal(err)
	}
	manager.loops = (&pgctLoops{mounted: map[string]bool{}}).host()
	// The engine containers resolve their bind mounts through these
	// directories (t.TempDir makes them 0700; in a nested container root
	// does not pass them).
	for _, path := range []string{filepath.Dir(root), root, dir, cfg.Docker.Database.StorageRoot, filepath.Join(cfg.Docker.Database.StorageRoot, "mounts"),
		filepath.Join(cfg.Docker.Database.StorageRoot, "tls")} {
		if err := os.Chmod(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	plugin := &DockerPlugin{cfg: cfg, client: client, logger: logger.With("node", name), databaseManager: manager}
	if mesh != nil {
		// One Docker engine: both nodes share the set's network and its gateway
		// listeners, so node B uses node A's mesh.
		setMeshes.Store(plugin, mesh)
	}
	store, err := memberha.NewStore(filepath.Join(dir, "members"))
	if err != nil {
		t.Fatal(err)
	}
	members, err := memberha.NewManager(memberha.Deps{
		Lease: pgNoLease{}, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: bootWallClock{}, Logger: logger,
		// The test drives the engines; the runtime only holds members for
		// a recreate (it is never stepped).
		Engine: func(memberha.Config) (memberha.Engine, error) { return muEngine{}, nil },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	plugin.setMembers = members
	plugin.wirePGSetHooks()
	t.Cleanup(func() { setMeshes.Delete(plugin) })
	return &pgctNode{name: name, memberID: memberID, dbID: dbID, plugin: plugin, m: manager}
}

func (n *pgctNode) openEngine(t *testing.T) {
	t.Helper()
	engine, err := newPostgresSetMember(n.plugin, pgctConfig(n.memberID, n.dbID))
	if err != nil {
		t.Fatalf("%s engine: %v", n.name, err)
	}
	n.engine = engine.(*pgSetMemberEngine)
}

func (n *pgctNode) ensure(t *testing.T, ctx context.Context, role string, input managedDatabaseCommand) string {
	t.Helper()
	input.OperationID = "op-ensure-" + n.name
	command := pgEnsureCommand{OperationID: input.OperationID, SetID: pgctSet, MemberID: n.memberID, Role: role, Database: input}
	if role == "origin" {
		command.ControlUsername = pgctOwner
	}
	body, _ := json.Marshal(command)
	detail, err := n.m.pgSetAction(ctx, "availability_member_ensure", n.dbID, string(body))
	if err != nil {
		t.Fatalf("%s ensure %s: %v", n.name, role, err)
	}
	return detail
}

func cleanupPGCT(t *testing.T, nodes ...*pgctNode) {
	if t.Failed() && os.Getenv("PGHA_CT_KEEP") != "" {
		return
	}
	for _, n := range nodes {
		if t.Failed() {
			out, _ := dockerCLI("logs", "--tail", "60", "gwdb-"+n.dbID)
			t.Logf("--- %s logs:\n%s", n.name, out)
		}
		ids, _ := dockerCLI("ps", "-aq", "--filter", "label="+managedDatabaseLabel+"="+n.dbID)
		for _, id := range strings.Fields(ids) {
			_, _ = dockerCLI("rm", "-f", "-v", id)
		}
		_, _ = dockerCLI("network", "rm", "gwdb-"+n.dbID+"-net")
	}
	_, _ = dockerCLI("network", "rm", setMeshNetworkName(pgctSet))
}

func TestPostgresSetContainers(t *testing.T) {
	host := os.Getenv("DOCKER_HOST")
	if host == "" {
		t.Skip("set DOCKER_HOST to a Docker engine")
	}
	if os.Geteuid() != 0 {
		t.Skip("the member files are owned by the postgres account: run as root")
	}
	for _, tool := range []string{"fallocate", "mkfs.ext4"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is required", tool)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	root := t.TempDir()
	client, err := NewClient(host, filepath.Join(root, "client"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	image := pgctImage(t)
	t.Logf("image %s", image)

	a := newPGCTNode(t, root, "a", pgctA, pgctDBA, client, logger, nil)
	mesh := a.plugin.setMesh()
	router := &pgctRouter{isolated: map[*pgctNode]bool{}, conns: map[net.Conn]*pgctNode{}}
	mesh.bridge = router.bridge
	b := newPGCTNode(t, root, "b", pgctB, pgctDBB, client, logger, mesh)
	cleanupPGCT(t, a, b)
	t.Cleanup(func() { cleanupPGCT(t, a, b); mesh.Release(context.Background(), pgctSet) })

	caPEM, certPEM, keyPEM := pgctTLS(t)
	input := managedDatabaseCommand{Type: "postgres", Image: image, StorageSizeBytes: 256 << 20, MemoryBytes: 512 << 20,
		OperationID: "op-create-a", OwnerUsername: pgctOwner, OwnerPassword: pgctOwnerPass, DatabaseName: "app",
		TLSEnabled: true, TLSCertificatePEM: certPEM, TLSPrivateKeyPEM: keyPEM, TLSCACertificatePEM: caPEM, TLSCertificateID: "ct-leaf-1"}

	// A is an ordinary single-node database first (the daemon's create).
	record, err := a.m.create(ctx, pgctDBA, input)
	if err != nil {
		t.Fatalf("create the single-node database: %v", err)
	}
	if err := a.m.startContainer(ctx, record.ContainerID); err != nil {
		t.Fatal(err)
	}
	if err := a.m.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
		t.Fatal(err)
	}
	if _, err := a.sql(t, "CREATE TABLE ct_rows (id bigserial PRIMARY KEY, kind text NOT NULL, at timestamptz DEFAULT now())",
		"INSERT INTO ct_rows (kind) VALUES ('before')"); err != nil {
		t.Fatalf("seed the single-node database: %v", err)
	}

	// Both members: the engine (configure), then availability_member_ensure.
	a.openEngine(t)
	b.openEngine(t)
	t.Logf("origin: %s", a.ensure(t, ctx, "origin", input))
	t.Logf("copy: %s", b.ensure(t, ctx, "copy", input))
	if !b.engine.RejoinNeeded() {
		t.Fatalf("the copy starts unseeded")
	}
	pgctWait(t, "the mesh listener on the set's gateway", 60*time.Second, func() bool {
		mesh.mu.Lock()
		defer mesh.mu.Unlock()
		entry := mesh.sets[pgctSet]
		return entry != nil && len(entry.listeners) > 0
	})

	// The origin bootstraps the lease as the running primary.
	run := &pgctRun{t: t, router: router, nodes: []*pgctNode{a, b}}
	pgctWait(t, "A answers as the primary", 60*time.Second, func() bool { return a.status(t).Writable })
	bootstrap, err := a.engine.BootstrapValue(memberha.EngineStatus{})
	if err != nil {
		t.Fatal(err)
	}
	run.holder, run.cert = a, bootstrap
	router.setPrimary(a)
	driveCtx, stopDrive := context.WithCancel(ctx)
	var driving sync.WaitGroup
	driving.Add(1)
	go run.drive(driveCtx, &driving)
	defer func() { stopDrive(); driving.Wait() }()

	// B is seeded with pg_basebackup through primary-pg-repl, then starts as a
	// standby at rest and streams.
	pgctWait(t, "B is seeded", 5*time.Minute, func() bool {
		run.mu.Lock()
		defer run.mu.Unlock()
		if err := b.engine.Rejoin(ctx); err != nil {
			t.Logf("seed: %v", err)
			return false
		}
		return true
	})
	run.mu.Lock()
	if err := b.engine.PrepareStandby(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.engine.Start(ctx); err != nil {
		t.Fatal(err)
	}
	run.mu.Unlock()
	pgctWait(t, "B streams from A", 2*time.Minute, func() bool { return b.status(t).Streaming })

	// The holder makes B the certified synchronous member.
	pgctWait(t, "B certified synchronous", 2*time.Minute, func() bool { return run.value().InSyncSet(pgctB) })
	replication, _ := a.sql(t, "SELECT application_name || ':' || sync_state FROM pg_stat_replication")
	if !strings.Contains(replication, pgctB+":sync") {
		t.Fatalf("B is not a synchronous standby on A: %q", replication)
	}

	// Synchronous commits: each one is acknowledged once B flushed it.
	statements := make([]string, 0, pgctSyncRows)
	for range pgctSyncRows {
		statements = append(statements, "INSERT INTO ct_rows (kind) VALUES ('sync')")
	}
	if out, err := a.sql(t, statements...); err != nil {
		t.Fatalf("synchronous inserts: %v %s", err, out)
	}
	pgctWait(t, "B replays every acknowledged row", time.Minute, func() bool { return b.count(t, "sync") == pgctSyncRows })
	t.Logf("%d synchronous rows acknowledged and on B", pgctSyncRows)

	// A is lost: the mesh cuts it, then it writes rows nobody acknowledged
	// synchronously (they diverge its WAL from B's), then it is killed.
	router.isolate(a, true)
	pgctWait(t, "B lost its stream", time.Minute, func() bool { return !b.status(t).Streaming })
	local := make([]string, 0, 21)
	local = append(local, "SET synchronous_commit = local")
	for range 20 {
		local = append(local, "INSERT INTO ct_rows (kind) VALUES ('local')")
	}
	if out, err := a.sql(t, local...); err != nil {
		t.Fatalf("local inserts: %v %s", err, out)
	}
	if _, err := a.sql(t, "CHECKPOINT"); err != nil {
		t.Fatal(err)
	}
	if err := a.engine.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	router.setPrimary(nil)

	// B is eligible as the certified sync member and takes over with every
	// acknowledged row.
	start := time.Now()
	run.mu.Lock()
	run.holder = nil
	certified := run.cert
	run.mu.Unlock()
	pgctWait(t, "B eligible", time.Minute, func() bool {
		b.status(t)
		eligible, reason := b.engine.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: certified}}, memberha.EngineStatus{})
		if !eligible {
			t.Logf("B not eligible yet: %s", reason)
		}
		return eligible
	})
	run.mu.Lock()
	if err := b.engine.Promote(ctx, certified); err != nil {
		run.mu.Unlock()
		t.Fatalf("promote B: %v", err)
	}
	router.setPrimary(b)
	var promoted []byte
	for attempt := 0; attempt < 60 && promoted == nil; attempt++ {
		b.status(t)
		if value, err := b.engine.PromotedValue(certified, memberha.EngineStatus{}); err == nil {
			promoted = value
		} else {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if promoted == nil {
		run.mu.Unlock()
		t.Fatal("B's promotion was never certified")
	}
	run.holder, run.cert = b, promoted
	run.mu.Unlock()
	t.Logf("B promoted in %s: %+v", time.Since(start), run.value())
	if got := b.count(t, "sync"); got != pgctSyncRows {
		t.Fatalf("B has %d of %d acknowledged rows", got, pgctSyncRows)
	}
	if got := b.count(t, "local"); got != 0 {
		t.Fatalf("B has %d rows A never replicated", got)
	}
	if out, err := b.sql(t, "INSERT INTO ct_rows (kind) VALUES ('after'), ('after'), ('after')"); err != nil {
		t.Fatalf("B takes writes: %v %s", err, out)
	}

	// A returns: it starts as a standby, finds its history forked off B's, and
	// rejoins with pg_rewind (the rows only it had are gone).
	router.isolate(a, false)
	run.mu.Lock()
	if err := a.engine.PrepareStandby(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	if err := a.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	run.mu.Unlock()
	streamedSince := time.Time{}
	pgctWait(t, "A reports that it must rejoin", 3*time.Minute, func() bool {
		status := a.status(t)
		if status.Streaming {
			if streamedSince.IsZero() {
				streamedSince = time.Now()
				out, _ := dockerCLI("logs", "--tail", "40", a.containerID(t))
				t.Logf("A reports streaming (%v, local rows %d); its log:\n%s", status.Position, a.count(t, "local"), out)
			}
			if time.Since(streamedSince) > 30*time.Second {
				t.Fatalf("A streams from B without a rewind: its local rows would survive")
			}
		}
		return status.NeedsRejoin
	})
	run.mu.Lock()
	_ = a.engine.DrainEvents()
	if err := a.engine.Rejoin(ctx); err != nil {
		run.mu.Unlock()
		t.Fatalf("rejoin A: %v", err)
	}
	rewound := false
	for _, event := range a.engine.DrainEvents() {
		t.Logf("A event %s: %s %v", event.Kind, event.Reason, event.Detail)
		if event.Kind == pgha.EventRewound && event.Reason == "rewound" {
			rewound = true
		}
	}
	if !rewound {
		run.mu.Unlock()
		t.Fatal("A was not rewound")
	}
	if err := a.engine.PrepareStandby(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	if err := a.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	run.mu.Unlock()
	pgctWait(t, "A streams from B", 2*time.Minute, func() bool { return a.status(t).Streaming })
	pgctWait(t, "A has B's rows", time.Minute, func() bool { return a.count(t, "after") == 3 })
	if got := a.count(t, "local"); got != 0 {
		t.Fatalf("A kept %d rows the rewind must discard", got)
	}
	if got := a.count(t, "sync"); got != pgctSyncRows {
		t.Fatalf("A has %d of %d acknowledged rows", got, pgctSyncRows)
	}
	pgctWait(t, "A certified synchronous", 2*time.Minute, func() bool { return run.value().InSyncSet(pgctA) })

	// Planned switchover back to A (AS11): A becomes the only certified sync
	// member, B ends its clients, A replays B's final LSN, B stops cleanly and
	// is standby at rest, A takes over, B follows it.
	run.mu.Lock()
	b.engine.PrepareSwitchover(pgctA)
	run.mu.Unlock()
	pgctWait(t, "the switchover is ready", 2*time.Minute, func() bool {
		run.mu.Lock()
		defer run.mu.Unlock()
		return b.engine.SwitchoverReady(run.cert, pgctA)
	})
	if out, err := b.sql(t, "INSERT INTO ct_rows (kind) VALUES ('before_switch')"); err != nil {
		t.Fatalf("write before the switchover: %v %s", err, out)
	}
	start = time.Now()
	run.mu.Lock()
	if err := b.engine.Switchover(ctx, pgctA); err != nil {
		run.mu.Unlock()
		t.Fatalf("switchover: %v", err)
	}
	if err := b.engine.StopClean(ctx, 30*time.Second); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	if err := b.engine.PrepareStandby(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	router.setPrimary(nil)
	certified = run.cert
	run.holder = nil
	a.status(t)
	if eligible, reason := a.engine.Eligible(memberha.EligibilityInput{Adopted: memberha.HolderState{Value: certified}}, memberha.EngineStatus{}); !eligible {
		run.mu.Unlock()
		t.Fatalf("A is not eligible as the switchover's successor: %s", reason)
	}
	if err := a.engine.Promote(ctx, certified); err != nil {
		run.mu.Unlock()
		t.Fatalf("promote A: %v", err)
	}
	router.setPrimary(a)
	promoted = nil
	for attempt := 0; attempt < 60 && promoted == nil; attempt++ {
		a.status(t)
		if value, err := a.engine.PromotedValue(certified, memberha.EngineStatus{}); err == nil {
			promoted = value
		} else {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if promoted == nil {
		run.mu.Unlock()
		t.Fatal("A's promotion was never certified")
	}
	run.holder, run.cert = a, promoted
	if err := b.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	run.mu.Unlock()
	t.Logf("switched over to A in %s", time.Since(start))
	if got := a.count(t, "before_switch"); got != 1 {
		t.Fatalf("A lost the write made just before the switchover (%d)", got)
	}
	pgctWait(t, "B follows A", 2*time.Minute, func() bool {
		status := b.status(t)
		if status.NeedsRejoin {
			t.Fatalf("B diverged in a planned switchover: %s", status.Detail)
		}
		return status.Streaming
	})
	if out, err := a.sql(t, "INSERT INTO ct_rows (kind) VALUES ('end')"); err != nil {
		t.Fatalf("A takes writes: %v %s", err, out)
	}
	pgctWait(t, "B replays A's write", time.Minute, func() bool { return b.count(t, "end") == 1 })
	pgctWait(t, "B certified synchronous again", 2*time.Minute, func() bool { return run.value().InSyncSet(pgctB) })
	if got, want := a.count(t, "sync"), pgctSyncRows; got != want {
		t.Fatalf("A has %d of %d acknowledged rows at the end", got, want)
	}

	// Rolling update (P3-T07): the copy's container is recreated through the
	// managed database update (a setting fixed at creation, or the image of
	// PGHA_CT_IMAGE2, same major) under the member runtime's hold; it starts
	// as a copy again (the test plays the runtime) and follows A.
	if err := b.plugin.setMembers.Configure(pgctConfig(pgctB, pgctDBB)); err != nil {
		t.Fatal(err)
	}
	update := input
	update.OperationID = "op-recreate-b"
	update.PostgresConfig = &managedPostgresConfig{MaxConnections: 150}
	if image2 := os.Getenv("PGHA_CT_IMAGE2"); image2 != "" {
		if _, err := dockerCLI("image", "inspect", image2); err != nil {
			mustDocker(t, "pull", image2)
		}
		update.PostgresConfig, update.Image = nil, image2
	}
	before := b.containerID(t)
	run.mu.Lock()
	body, _ := json.Marshal(update)
	if _, err := b.m.handle(ctx, "update", pgctDBB, string(body)); err != nil {
		run.mu.Unlock()
		t.Fatalf("recreate the copy: %v", err)
	}
	after := b.containerID(t)
	if after == before || after == "" {
		run.mu.Unlock()
		t.Fatalf("the copy's container was not recreated (%s -> %s)", before, after)
	}
	if out, _ := dockerCLI("inspect", "-f", "{{.State.Running}} {{index .Config.Labels \"net.opfield.availability.member\"}}", after); strings.TrimSpace(out) != "false "+pgctB {
		run.mu.Unlock()
		t.Fatalf("the recreated copy is created, not started, with its member label: %q", out)
	}
	if err := b.engine.PrepareStandby(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	if err := b.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	run.mu.Unlock()
	pgctWait(t, "the recreated copy follows A", 2*time.Minute, func() bool { return b.status(t).Streaming })
	if got := b.count(t, "sync"); got != pgctSyncRows {
		t.Fatalf("the recreated copy has %d of %d acknowledged rows", got, pgctSyncRows)
	}
	pgctWait(t, "B certified synchronous after its recreate", 2*time.Minute, func() bool { return run.value().InSyncSet(pgctB) })
	t.Logf("copy recreated: %s -> %s", before[:12], after[:12])

	// The set is paused (AvailabilityMemberConfig.stopped): the copy stops
	// cleanly first, then the primary, which keeps its role (the test plays
	// the runtime: a clean stop and standby at rest each). The pause ends:
	// the primary starts first (standby at rest, promoted again, its new
	// timeline certified), then the copy, which follows it. Nothing is lost.
	run.mu.Lock()
	for _, n := range []*pgctNode{b, a} {
		if err := n.engine.StopClean(ctx, 30*time.Second); err != nil {
			run.mu.Unlock()
			t.Fatalf("stop %s for the pause: %v", n.name, err)
		}
		if err := n.engine.PrepareStandby(ctx); err != nil {
			run.mu.Unlock()
			t.Fatal(err)
		}
	}
	for _, n := range []*pgctNode{a, b} {
		if status := n.status(t); status.Answering {
			run.mu.Unlock()
			t.Fatalf("%s still answers while the set is paused", n.name)
		}
	}
	if err := a.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	pgctWaitLocked := func(what string, cond func() bool) {
		deadline := time.Now().Add(2 * time.Minute)
		for !cond() {
			if time.Now().After(deadline) {
				run.mu.Unlock()
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(300 * time.Millisecond)
		}
	}
	pgctWaitLocked("A answers after the pause", func() bool { return a.status(t).Answering })
	if a.status(t).Writable {
		run.mu.Unlock()
		t.Fatal("the primary must come back read-only (standby at rest) before its promotion")
	}
	certified = run.cert
	if err := a.engine.Promote(ctx, certified); err != nil {
		run.mu.Unlock()
		t.Fatalf("promote A again after the pause: %v", err)
	}
	promoted = nil
	for attempt := 0; attempt < 60 && promoted == nil; attempt++ {
		a.status(t)
		if value, err := a.engine.PromotedValue(certified, memberha.EngineStatus{}); err == nil {
			promoted = value
		} else {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if promoted == nil {
		run.mu.Unlock()
		t.Fatal("A's promotion after the pause was never certified")
	}
	run.cert = promoted
	if err := b.engine.Start(ctx); err != nil {
		run.mu.Unlock()
		t.Fatal(err)
	}
	run.mu.Unlock()
	pgctWait(t, "B follows A after the pause", 2*time.Minute, func() bool { return b.status(t).Streaming })
	for kind, want := range map[string]int{"sync": pgctSyncRows, "before_switch": 1, "end": 1, "after": 3} {
		if got := a.count(t, kind); got != want {
			t.Fatalf("A has %d %s rows after the pause, want %d", got, kind, want)
		}
	}
	if out, err := a.sql(t, "INSERT INTO ct_rows (kind) VALUES ('after_pause')"); err != nil {
		t.Fatalf("A takes writes after the pause: %v %s", err, out)
	}
	pgctWait(t, "B replays the write after the pause", time.Minute, func() bool { return b.count(t, "after_pause") == 1 })
	pgctWait(t, "B certified synchronous after the pause", 2*time.Minute, func() bool { return run.value().InSyncSet(pgctB) })
	fmt.Fprintln(os.Stderr, "postgres set container test passed")
}
