//go:build pghacontainer

package docker

// Container test of a rolling engine update of a manual Postgres pair driven
// by the real member runtime (memberha.Manager on each node, stepped like the
// daemon steps it): the copy's container is recreated on a newer minor image
// through the managed database update while the runtime runs, the runtime
// starts it again as a copy and it must stream from the primary again; then
// the primary steps down to the changed copy (planned manual switch: the new
// assignment reaches the old primary first, then the copy), the old primary
// is recreated on the new image as a copy and follows the new primary.
// Nothing acknowledged is lost.
//
// Run on a build host with a private Docker engine (root):
//
//	DOCKER_HOST=unix:///run/hapg2/docker.sock go test -tags pghacontainer -run TestPostgresRollingUpdate -v -timeout 20m ./internal/docker/
//
// PGHA_CT_IMAGE and PGHA_CT_IMAGE2 pick the curated images (same major); by
// default PostgreSQL 16.10 then 16.14. PGHA_RT_WAL_BURST=1: while the copy is
// away for its update the primary writes past max_slot_wal_keep_size, so the
// copy's slot is lost and the runtime rebuilds the copy before it streams.

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
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
	pgrtImage1610 = "docker.io/library/postgres@sha256:21f6013073bc6b92830a2129570e2f5ec42a6c734b5a985a41e83aa58f54c3c1"
	pgrtImage1614 = "docker.io/library/postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20"
)

// pgrtConfig is pgctConfig as a manual pair (no lease policy).
func pgrtConfig(memberID, dbID string) memberha.Config {
	config := pgctConfig(memberID, dbID)
	config.Mode, config.LeasePolicyID = memberha.ModeManual, ""
	return config
}

// pgrtRuntime gives a node the real member runtime: the Postgres engine of
// the daemon, Gateway always in contact, the peer's assignment over a direct
// call (the member-control port), every assignment accepted as signed.
func pgrtRuntime(t *testing.T, n *pgctNode, logger *slog.Logger, peer func() *memberha.Manager) *memberha.Manager {
	t.Helper()
	store, err := memberha.NewStore(filepath.Join(n.plugin.cfg.StateDir, "..", "members-rt"))
	if err != nil {
		t.Fatal(err)
	}
	clock := bootWallClock{}
	plugin := n.plugin
	manager, err := memberha.NewManager(memberha.Deps{
		Lease: pgNoLease{}, Watchdog: pgNoWatchdog{}, Endpoints: pgNoEndpoints{}, Clock: clock,
		Logger: logger.With("node", n.name, "runtime", true),
		Engine: func(config memberha.Config) (memberha.Engine, error) {
			return newPostgresSetMember(plugin, config)
		},
		GatewayContactAt: clock.Now,
		PeerState: func(_ context.Context, setID, peerMemberID string) (memberha.PeerState, bool) {
			other := peer()
			if other == nil {
				return memberha.PeerState{}, false
			}
			state, ok := other.PeerState(setID)
			return state, ok && state.MemberID == peerMemberID
		},
		VerifyAssignment: func(string, memberha.Assignment) error { return nil },
	}, store)
	if err != nil {
		t.Fatal(err)
	}
	plugin.setMembers = manager
	return manager
}

func pgrtAssignment(primary string, generation uint64) memberha.Assignment {
	return memberha.Assignment{PrimaryMemberID: primary, Generation: generation, SigningKeyID: "ct", Signature: []byte{1}}
}

// pgrtEngine is the node's Postgres member engine the runtime opened.
func pgrtEngine(t *testing.T, n *pgctNode) {
	t.Helper()
	value, ok := n.m.pgSets.engines.Load(pgctSet)
	if !ok {
		t.Fatalf("%s: the runtime opened no Postgres engine", n.name)
	}
	n.engine = value.(*pgSetMemberEngine)
}

func pgrtLogs(t *testing.T, n *pgctNode, lines int) string {
	t.Helper()
	out, _ := dockerCLI("logs", "--tail", strconv.Itoa(lines), n.containerID(t))
	return out
}

func pgrtImageOf(t *testing.T, n *pgctNode) string {
	t.Helper()
	out, _ := dockerCLI("inspect", "-f", "{{.Config.Image}}", n.containerID(t))
	return strings.TrimSpace(out)
}

func TestPostgresRollingUpdate(t *testing.T) {
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
	image2 := os.Getenv("PGHA_CT_IMAGE2")
	if os.Getenv("PGHA_CT_IMAGE") == "" {
		if err := os.Setenv("PGHA_CT_IMAGE", pgrtImage1610); err != nil {
			t.Fatal(err)
		}
		if image2 == "" {
			image2 = pgrtImage1614
		}
	}
	if image2 == "" {
		t.Skip("set PGHA_CT_IMAGE2 to a newer curated image of PGHA_CT_IMAGE's major")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	root := t.TempDir()
	client, err := NewClient(host, filepath.Join(root, "client"), logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	image := pgctImage(t)
	if _, err := dockerCLI("image", "inspect", image2); err != nil {
		mustDocker(t, "pull", image2)
	}
	t.Logf("image %s, update to %s", image, image2)

	a := newPGCTNode(t, root, "a", pgctA, pgctDBA, client, logger, nil)
	mesh := a.plugin.setMesh()
	router := &pgctRouter{isolated: map[*pgctNode]bool{}, conns: map[net.Conn]*pgctNode{}}
	mesh.bridge = router.bridge
	b := newPGCTNode(t, root, "b", pgctB, pgctDBB, client, logger, mesh)
	cleanupPGCT(t, a, b)
	t.Cleanup(func() { cleanupPGCT(t, a, b); mesh.Release(context.Background(), pgctSet) })
	var am, bm *memberha.Manager
	am = pgrtRuntime(t, a, logger, func() *memberha.Manager { return bm })
	bm = pgrtRuntime(t, b, logger, func() *memberha.Manager { return am })

	caPEM, certPEM, keyPEM := pgctTLS(t)
	input := managedDatabaseCommand{Type: "postgres", Image: image, StorageSizeBytes: 256 << 20, MemoryBytes: 512 << 20,
		OperationID: "op-create-a", OwnerUsername: pgctOwner, OwnerPassword: pgctOwnerPass, DatabaseName: "app",
		TLSEnabled: true, TLSCertificatePEM: certPEM, TLSPrivateKeyPEM: keyPEM, TLSCACertificatePEM: caPEM, TLSCertificateID: "ct-leaf-1"}

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

	// Gateway's order: configure the members (the runtime opens the engines),
	// ensure them, then name the primary.
	if err := am.Configure(pgrtConfig(pgctA, pgctDBA)); err != nil {
		t.Fatal(err)
	}
	if err := bm.Configure(pgrtConfig(pgctB, pgctDBB)); err != nil {
		t.Fatal(err)
	}
	pgrtEngine(t, a)
	pgrtEngine(t, b)
	t.Logf("origin: %s", a.ensure(t, ctx, "origin", input))
	t.Logf("copy: %s", b.ensure(t, ctx, "copy", input))
	for _, m := range []*memberha.Manager{am, bm} {
		if err := m.AssignPrimary(pgctSet, pgrtAssignment(pgctA, 1)); err != nil {
			t.Fatal(err)
		}
	}
	router.setPrimary(a)

	stepCtx, stopStepping := context.WithCancel(ctx)
	var stepping sync.WaitGroup
	for _, m := range []*memberha.Manager{am, bm} {
		stepping.Add(1)
		go func(m *memberha.Manager) {
			defer stepping.Done()
			for stepCtx.Err() == nil {
				m.Step()
				select {
				case <-stepCtx.Done():
				case <-time.After(200 * time.Millisecond):
				}
			}
		}(m)
	}
	defer func() { stopStepping(); stepping.Wait() }()

	streams := func(n *pgctNode) bool { return n.status(t).Streaming }
	waitStreams := func(n *pgctNode, what string, timeout time.Duration) {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for !streams(n) {
			if time.Now().After(deadline) {
				receiver, _ := n.sql(t, "SELECT coalesce((SELECT status || ' ' || coalesce(sender_host, '') FROM pg_stat_wal_receiver), 'no walreceiver')")
				t.Fatalf("timed out waiting for %s (walreceiver: %s); %s log:\n%s", what, strings.TrimSpace(receiver), n.name, pgrtLogs(t, n, 80))
			}
			time.Sleep(500 * time.Millisecond)
		}
	}

	// The runtime seeds the copy (base backup through the mesh), starts it
	// and it streams; the primary makes it synchronous.
	waitStreams(b, "the copy is seeded and streams from A", 6*time.Minute)
	if out, err := a.sql(t, "INSERT INTO ct_rows (kind) VALUES ('sync1')"); err != nil {
		t.Fatalf("write on A: %v %s", err, out)
	}
	pgctWait(t, "B replays A's write", time.Minute, func() bool { return b.count(t, "sync1") == 1 })

	// Rolling update, copy first: Gateway sends the update with the new image
	// while the runtime runs; the daemon holds the member, recreates its
	// container on the same data and hands it back; the runtime starts it as a
	// copy and it streams from the primary again. The primary keeps taking
	// writes while the copy is away (an image pull on a node takes a while):
	// with PGHA_RT_WAL_BURST it writes more WAL than the copy's slot may keep
	// (max_slot_wal_keep_size), so the slot is invalidated.
	update := input
	update.OperationID = "op-roll-b"
	update.Image = image2
	before := b.containerID(t)
	body, _ := json.Marshal(update)
	burst := os.Getenv("PGHA_RT_WAL_BURST") != ""
	if burst {
		router.isolate(a, true)
		pgctWait(t, "B lost its stream for the burst", time.Minute, func() bool { return !streams(b) })
	}
	updated := make(chan error, 1)
	go func() {
		_, err := b.m.handle(ctx, "update", pgctDBB, string(body))
		updated <- err
	}()
	if burst {
		if out, err := a.sql(t, "CREATE TABLE ct_bulk (id bigint, pad text)"); err != nil {
			t.Fatalf("bulk table: %v %s", err, out)
		}
		for round := 0; ; round++ {
			if out, err := a.sql(t, "SET synchronous_commit = local",
				"INSERT INTO ct_bulk SELECT g, repeat(md5(g::text), 60) FROM generate_series(1, 20000) g",
				"SELECT pg_switch_wal()", "CHECKPOINT"); err != nil {
				t.Fatalf("WAL burst: %v %s", err, out)
			}
			state, _ := a.sql(t, "SELECT slot_name || ' ' || coalesce(wal_status, '') || ' ' || coalesce(restart_lsn::text, '') FROM pg_replication_slots")
			t.Logf("burst round %d: slots %q", round, strings.TrimSpace(state))
			if strings.Contains(state, "lost") || round >= 30 {
				break
			}
		}
	}
	if err := <-updated; err != nil {
		t.Fatalf("update the copy: %v", err)
	}
	if burst {
		router.isolate(a, false)
	}
	if after := b.containerID(t); after == before || after == "" {
		t.Fatalf("the copy's container was not recreated (%s -> %s)", before, after)
	}
	if got := pgrtImageOf(t, b); managedDatabaseImageDigest(got) != managedDatabaseImageDigest(image2) {
		t.Fatalf("the recreated copy runs %s", got)
	}
	waitStreams(b, "the updated copy streams from A", 5*time.Minute)
	// It stays streaming (the stand saw the walreceiver end right after the
	// start and never come back).
	for range 20 {
		time.Sleep(time.Second)
		if !streams(b) {
			waitStreams(b, "the updated copy streams from A again", time.Minute)
		}
	}
	if out, err := a.sql(t, "INSERT INTO ct_rows (kind) VALUES ('after_copy_update')"); err != nil {
		t.Fatalf("write on A after the copy's update: %v %s", err, out)
	}
	pgctWait(t, "the updated copy replays A's write", time.Minute, func() bool { return b.count(t, "after_copy_update") == 1 })
	t.Logf("copy updated: %s -> %s", before[:12], b.containerID(t)[:12])

	// Planned manual switch to the changed copy: the old primary learns the
	// new assignment first and steps down (clean stop, back as a copy), then
	// the copy is assigned and promotes once A's stream ended.
	if out, err := a.sql(t, "INSERT INTO ct_rows (kind) VALUES ('before_switch')"); err != nil {
		t.Fatalf("write before the switch: %v %s", err, out)
	}
	pgctWait(t, "B replays the write before the switch", time.Minute, func() bool { return b.count(t, "before_switch") == 1 })
	router.setPrimary(nil)
	if err := am.AssignPrimary(pgctSet, pgrtAssignment(pgctB, 2)); err != nil {
		t.Fatal(err)
	}
	pgctWait(t, "A stepped down to a copy", 2*time.Minute, func() bool {
		status := a.status(t)
		return status.Answering && !status.Writable
	})
	if err := bm.AssignPrimary(pgctSet, pgrtAssignment(pgctB, 2)); err != nil {
		t.Fatal(err)
	}
	pgctWait(t, "B promoted", 2*time.Minute, func() bool { return b.status(t).Writable })
	router.setPrimary(b)
	if got := b.count(t, "before_switch"); got != 1 {
		t.Fatalf("B lost the write made before the switch (%d)", got)
	}
	waitStreams(a, "A follows B", 3*time.Minute)

	// The old primary, a copy now, gets the new image too.
	update.OperationID = "op-roll-a"
	before = a.containerID(t)
	body, _ = json.Marshal(update)
	if _, err := a.m.handle(ctx, "update", pgctDBA, string(body)); err != nil {
		t.Fatalf("update the old primary: %v", err)
	}
	if after := a.containerID(t); after == before || after == "" {
		t.Fatalf("the old primary's container was not recreated (%s -> %s)", before, after)
	}
	waitStreams(a, "the updated old primary streams from B", 3*time.Minute)
	if out, err := b.sql(t, "INSERT INTO ct_rows (kind) VALUES ('end')"); err != nil {
		t.Fatalf("B takes writes: %v %s", err, out)
	}
	pgctWait(t, "A replays B's write", time.Minute, func() bool { return a.count(t, "end") == 1 })
	for kind, want := range map[string]int{"before": 1, "sync1": 1, "after_copy_update": 1, "before_switch": 1, "end": 1} {
		if got := a.count(t, kind); got != want {
			t.Fatalf("A has %d %s rows at the end, want %d", got, kind, want)
		}
	}
	for _, n := range []*pgctNode{a, b} {
		if got := pgrtImageOf(t, n); managedDatabaseImageDigest(got) != managedDatabaseImageDigest(image2) {
			t.Fatalf("%s runs %s after the rolling update", n.name, got)
		}
	}
	t.Log("postgres rolling update container test passed")
}
