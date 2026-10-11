package docker

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/memberha"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/pgha"
	"golang.org/x/sys/unix"
)

// Postgres set members on a storage-profile daemon: the pgha engine runs on
// this pgha.Postgres, which reaches the member's managed database record and
// container: fixed psql statements through docker exec as the node-local
// role (unix socket), files of the stopped data directory written from the
// host with fsync, and helper containers of the database image for
// pg_basebackup, pg_rewind and pg_controldata that reach the primary through
// the member mesh (primary-pg-repl on the set's private bridge).

func init() {
	RegisterSetMemberEngine("postgres", newPostgresSetMember)
}

// newPostgresSetMember opens the Postgres engine of one member.
func newPostgresSetMember(p *DockerPlugin, config memberha.Config) (memberha.Engine, error) {
	if p.databaseManager == nil {
		return nil, errors.New("managed database storage is not initialized on this node")
	}
	store, err := pgha.NewStore(filepath.Join(p.cfg.StateDir, "availability-postgres"))
	if err != nil {
		return nil, err
	}
	member := &pgMember{
		m: p.databaseManager, id: config.OwnerID, setID: config.SetID, mesh: p.pgMesh(),
		cgroups: &leaseEngine{client: p.client, cgroupRoot: leasefence.DefaultCgroupRoot}, waiters: map[string]time.Time{},
	}
	engine, err := pgha.New(config, member, store, bootWallClock{}, p.logger)
	if err != nil {
		return nil, err
	}
	member.config = engine.Config
	if mesh := member.mesh; mesh != nil {
		// Copies and replication helpers reach the primary as primary-pg-repl.
		mesh.Expose(config.SetID, pgReplicationHost, pgReplicationPort, pgReplicationHost)
	}
	if record, err := p.databaseManager.loadRecord(config.OwnerID); err == nil {
		if err := writePGMemberFiles(record, engine.Config()); err != nil {
			p.logger.Warn("could not write the Postgres member's files", "set_id", config.SetID, "error", err)
		}
	}
	wrapped := &pgSetMemberEngine{Engine: engine, member: member}
	p.databaseManager.pgSets.engines.Store(config.SetID, wrapped)
	return wrapped, nil
}

// wirePGSetHooks connects the database manager to the member runtime and
// the member mesh (storage-profile daemons).
func (p *DockerPlugin) wirePGSetHooks() {
	if p.databaseManager == nil {
		return
	}
	p.databaseManager.pgSets.members = func() *memberha.Manager { return p.setMembers }
	p.databaseManager.pgSets.mesh = p.pgMesh
}

// pgSetMemberEngine writes the member's files on every reconfiguration.
type pgSetMemberEngine struct {
	*pgha.Engine
	member *pgMember
}

func (e *pgSetMemberEngine) Reconfigure(config memberha.Config) error {
	if err := e.Engine.Reconfigure(config); err != nil {
		return err
	}
	record, err := e.member.record()
	if err != nil {
		return err
	}
	if err := writePGMemberFiles(record, e.Engine.Config()); err != nil {
		return err
	}
	if running, _ := e.member.running(context.Background(), record); running {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := e.member.reloadConfig(ctx); err != nil {
			e.member.m.logger.Warn("could not reload a member's configuration", "id", e.member.id, "error", err)
		}
	}
	return nil
}

// pgMember is the Postgres of one member; it resolves the record on every
// call because a recreate changes the container.
type pgMember struct {
	m       *managedDatabaseManager
	id      string
	setID   string
	mesh    pgSetMesh
	cgroups *leaseEngine
	config  func() pgha.Config

	mu      sync.Mutex
	waiters map[string]time.Time
}

var _ pgha.Postgres = (*pgMember)(nil)

// record reads the member's record without the manager lock: lifecycle
// commands hold it for their whole run, and a fence must never wait behind
// them. Records are replaced atomically.
func (e *pgMember) record() (managedDatabaseRecord, error) { return e.m.loadRecord(e.id) }

func (e *pgMember) pgdata(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, pgdataDirName)
}

func (e *pgMember) Container(ctx context.Context) (memberha.ContainerState, error) {
	record, err := e.record()
	if err != nil {
		return memberha.ContainerState{}, err
	}
	if record.ContainerID == "" {
		return memberha.ContainerState{}, nil
	}
	c, found, err := e.cgroups.Inspect(ctx, record.ContainerID)
	if err != nil {
		return memberha.ContainerState{}, err
	}
	if !found {
		return memberha.ContainerState{ID: record.ContainerID}, nil
	}
	return memberha.ContainerState{Exists: true, Running: c.Running && !c.Paused, ID: c.ID, CgroupPath: c.CgroupPath, StartedAt: c.StartedAt}, nil
}

func (e *pgMember) running(ctx context.Context, record managedDatabaseRecord) (bool, error) {
	if record.ContainerID == "" {
		return false, nil
	}
	inspect, err := e.m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if isNotFoundErr(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return inspect.Container.State != nil && inspect.Container.State.Running, nil
}

// PrepareStandby writes standby at rest into the stopped data directory:
// standby.signal and the daemon's settings, each file and the directory
// fsynced.
func (e *pgMember) PrepareStandby(ctx context.Context, config pgha.StandbyConfig) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	if running, err := e.running(ctx, record); err != nil || running {
		if err == nil {
			err = errors.New("the member's container is running")
		}
		return fmt.Errorf("prepare standby: %w", err)
	}
	if e.config != nil {
		if err := writePGMemberFiles(record, e.config()); err != nil {
			return err
		}
	}
	return writePGStandbyAtRest(e.pgdata(record), record.StorageSize, config)
}

// writePGStandbyAtRest is PrepareStandby on a data directory path.
func writePGStandbyAtRest(pgdata string, storageBytes int64, config pgha.StandbyConfig) error {
	if _, err := os.Stat(filepath.Join(pgdata, "PG_VERSION")); err != nil {
		return fmt.Errorf("the data directory is not initialized: %w", err)
	}
	if err := pgUpdateAutoConf(pgdata, pgMemberAutoConfKeys, pgMemberAutoConf(config, storageBytes)); err != nil {
		return err
	}
	return writePGStandbySignal(pgdata)
}

func writePGStandbySignal(pgdata string) error {
	path := filepath.Join(pgdata, "standby.signal")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("write standby.signal: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := managedDatabaseChown(path, pgPostgresUID, pgPostgresGID); err != nil {
		return err
	}
	return pgFsyncDir(pgdata)
}

func pgFsyncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}

func (e *pgMember) MarkStandbyAtRest(context.Context) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	return writePGStandbySignal(e.pgdata(record))
}

func (e *pgMember) ClearStandbySignal(context.Context) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	pgdata := e.pgdata(record)
	if err := os.Remove(filepath.Join(pgdata, "standby.signal")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return pgFsyncDir(pgdata)
}

func (e *pgMember) Start(ctx context.Context) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	if err := e.m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if e.mesh != nil {
		if _, err := e.mesh.Ensure(ctx, e.setID); err != nil {
			return fmt.Errorf("the set's member mesh: %w", err)
		}
	}
	return e.m.startContainer(ctx, record.ContainerID)
}

func (e *pgMember) StopClean(ctx context.Context, timeout time.Duration) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	running, err := e.running(ctx, record)
	if err != nil || !running {
		return err
	}
	// The image's stop signal is SIGINT: a fast shutdown.
	return e.m.client.StopContainer(ctx, record.ContainerID, int(timeout.Seconds()))
}

func (e *pgMember) Kill(ctx context.Context) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	running, err := e.running(ctx, record)
	if err != nil || !running {
		return err
	}
	return e.m.client.KillContainer(ctx, record.ContainerID, "KILL")
}

func (e *pgMember) CgroupEmpty(ctx context.Context) (bool, error) {
	record, err := e.record()
	if err != nil {
		return false, err
	}
	if record.ContainerID == "" {
		return true, nil
	}
	c, found, err := e.cgroups.Inspect(ctx, record.ContainerID)
	if err != nil {
		return false, err
	}
	if !found {
		c = lease.Container{ID: record.ContainerID}
	}
	if c.Running {
		return false, nil
	}
	return e.cgroups.CgroupEmpty(ctx, c)
}

func (e *pgMember) DataInitialized() bool {
	record, err := e.record()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(e.pgdata(record), "PG_VERSION"))
	return err == nil
}

func (e *pgMember) DiskFree() uint64 {
	record, err := e.record()
	if err != nil {
		return 0
	}
	free := pgFreeBytes(record.MountPath)
	if free < 0 {
		return 0
	}
	return uint64(free)
}

func (e *pgMember) DialServer(ctx context.Context) (net.Conn, error) {
	connection, _, err := e.m.dialRecord(ctx, e.id)
	return connection, err
}

// TimelineHistory reads pg_wal/<timeline>.history of the member.
func (e *pgMember) TimelineHistory(_ context.Context, timeline uint32) ([]pgha.TimelineEntry, error) {
	if timeline <= 1 {
		return nil, nil
	}
	record, err := e.record()
	if err != nil {
		return nil, err
	}
	return readPGTimelineHistory(filepath.Join(e.pgdata(record), "pg_wal", fmt.Sprintf("%08X.history", timeline)))
}

func readPGTimelineHistory(path string) ([]pgha.TimelineEntry, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var out []pgha.TimelineEntry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return nil, fmt.Errorf("malformed timeline history line %q", line)
		}
		timeline, err := strconv.ParseUint(fields[0], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("malformed timeline history line %q", line)
		}
		lsn, err := pgha.ParseLSN(fields[1])
		if err != nil {
			return nil, err
		}
		out = append(out, pgha.TimelineEntry{Timeline: uint32(timeline), SwitchLSN: lsn})
	}
	return out, scanner.Err()
}

// LogSince returns the server log (the container's stderr) written after
// since.
func (e *pgMember) LogSince(ctx context.Context, since time.Time) ([]pgha.LogLine, error) {
	record, err := e.record()
	if err != nil {
		return nil, err
	}
	sinceText := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	if !since.IsZero() {
		sinceText = since.Add(time.Nanosecond).UTC().Format(time.RFC3339Nano)
	}
	lines, err := e.m.client.ContainerLogs(ctx, record.ContainerID, 2000, true, sinceText, "")
	if err != nil {
		return nil, err
	}
	out := make([]pgha.LogLine, 0, len(lines))
	for _, line := range lines {
		stamp, text, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			continue
		}
		out = append(out, pgha.LogLine{At: at, Text: text})
	}
	return out, nil
}

// ----- SQL ------------------------------------------------------------------

const maxPGExecOutput = 1 << 20

// pgExecOutput runs a fixed command in the container as postgres and returns
// its stdout.
func (m *managedDatabaseManager) pgExecOutput(ctx context.Context, containerID string, command []string, stdin string) (string, error) {
	created, err := m.client.cli.ExecCreate(ctx, containerID, mobyclient.ExecCreateOptions{
		Cmd: command, AttachStdin: stdin != "", AttachStdout: true, AttachStderr: true, User: "postgres",
	})
	if err != nil {
		return "", fmt.Errorf("managed database engine command could not start: %w", err)
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return "", fmt.Errorf("managed database engine command could not attach: %w", err)
	}
	defer attached.Close()
	if stdin != "" {
		if _, err := io.WriteString(attached.Conn, stdin); err != nil {
			return "", errors.New("managed database engine command could not receive input")
		}
		if err := attached.CloseWrite(); err != nil {
			return "", errors.New("managed database engine command could not close input")
		}
	}
	var stdout, stderr bytes.Buffer
	_, _ = stdcopy.StdCopy(&pgTruncatingBuffer{buf: &stdout, max: maxPGExecOutput}, &pgTruncatingBuffer{buf: &stderr, max: 64 << 10}, attached.Reader)
	inspect, err := m.client.cli.ExecInspect(ctx, created.ID, mobyclient.ExecInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("managed database engine command state unknown: %w", err)
	}
	if inspect.ExitCode != 0 {
		return "", fmt.Errorf("managed database engine command failed: %s", strings.TrimSpace(pgFirstLine(stderr.String())))
	}
	return stdout.String(), nil
}

type pgTruncatingBuffer struct {
	buf *bytes.Buffer
	max int
}

func (b *pgTruncatingBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.buf.Len(); room > 0 {
		if len(p) > room {
			b.buf.Write(p[:room])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func pgFirstLine(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	if len(line) > 300 {
		line = line[:300]
	}
	return line
}

// psql runs statements as the node-local role through the unix socket. Each
// statement is its own -c (ALTER SYSTEM refuses transaction blocks).
func (e *pgMember) psql(ctx context.Context, statements ...string) (string, error) {
	record, err := e.record()
	if err != nil {
		return "", err
	}
	command := []string{"psql", "-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-U", pgLocalRole, "-d", "postgres"}
	for _, statement := range statements {
		command = append(command, "-c", statement)
	}
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return e.m.pgExecOutput(callCtx, record.ContainerID, command, "")
}

const pgStatusSQL = `SELECT pg_is_in_recovery(),
  CASE WHEN pg_is_in_recovery()
    THEN coalesce((SELECT received_tli FROM pg_stat_wal_receiver), (SELECT timeline_id FROM pg_control_checkpoint()))
    ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int END,
  CASE WHEN pg_is_in_recovery() THEN '' ELSE pg_current_wal_flush_lsn()::text END,
  coalesce(pg_last_wal_receive_lsn()::text, ''), coalesce(pg_last_wal_replay_lsn()::text, ''),
  coalesce((SELECT status FROM pg_stat_wal_receiver), ''),
  coalesce((SELECT received_tli::text FROM pg_stat_wal_receiver), ''),
  coalesce((SELECT latest_end_lsn::text FROM pg_stat_wal_receiver), ''),
  current_setting('server_version_num')`

func (e *pgMember) Status(ctx context.Context) (pgha.ServerStatus, error) {
	output, err := e.psql(ctx, pgStatusSQL)
	if err != nil {
		// Not answering is a sample, not an error of the observation.
		return pgha.ServerStatus{}, nil
	}
	fields := strings.Split(strings.TrimSpace(output), "|")
	if len(fields) != 9 {
		return pgha.ServerStatus{}, fmt.Errorf("unexpected status row %q", strings.TrimSpace(output))
	}
	status := pgha.ServerStatus{Answering: true, InRecovery: fields[0] == "t", ReceiverStatus: fields[5]}
	timeline, _ := strconv.ParseUint(fields[1], 10, 32)
	status.Timeline = uint32(timeline)
	received, _ := strconv.ParseUint(fields[6], 10, 32)
	status.ReceiverTimeline = uint32(received)
	status.ServerVersion, _ = strconv.Atoi(fields[8])
	for i, target := range []*pgha.LSN{&status.FlushLSN, &status.ReceiveLSN, &status.ReplayLSN} {
		value, err := pgha.ParseLSN(fields[2+i])
		if err != nil {
			return pgha.ServerStatus{}, err
		}
		*target = value
	}
	if status.LatestEndLSN, err = pgha.ParseLSN(fields[7]); err != nil {
		return pgha.ServerStatus{}, err
	}
	return status, nil
}

func (e *pgMember) Replication(ctx context.Context) ([]pgha.ReplicationPeer, error) {
	output, err := e.psql(ctx, `SELECT coalesce(application_name, ''), coalesce(usename::text, ''), coalesce(state, ''), coalesce(sync_state, ''),
  coalesce(sent_lsn::text, ''), coalesce(write_lsn::text, ''), coalesce(flush_lsn::text, ''), coalesce(replay_lsn::text, ''),
  coalesce(round(extract(epoch FROM now() - reply_time) * 1000)::bigint, -1)
  FROM pg_stat_replication ORDER BY pid`)
	if err != nil {
		return nil, err
	}
	var peers []pgha.ReplicationPeer
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "|")
		if len(fields) != 9 {
			return nil, fmt.Errorf("unexpected replication row %q", line)
		}
		peer := pgha.ReplicationPeer{ApplicationName: fields[0], UseName: fields[1], State: fields[2], SyncState: fields[3], ReplyAge: -1}
		if ms, err := strconv.ParseInt(fields[8], 10, 64); err == nil && ms >= 0 {
			peer.ReplyAge = time.Duration(ms) * time.Millisecond
		}
		for i, target := range []*pgha.LSN{&peer.SentLSN, &peer.WriteLSN, &peer.FlushLSN, &peer.ReplayLSN} {
			if *target, err = pgha.ParseLSN(fields[4+i]); err != nil {
				return nil, err
			}
		}
		peers = append(peers, peer)
	}
	return peers, nil
}

// Waiters lists backends waiting for synchronous replication. Their age is
// measured from when this member first saw each wait (pid and statement
// start), since Postgres does not expose when a SyncRep wait began (M5).
func (e *pgMember) Waiters(ctx context.Context) (pgha.SyncWaiters, error) {
	output, err := e.psql(ctx, `SELECT pid, coalesce(extract(epoch FROM query_start)::text, '') FROM pg_stat_activity WHERE wait_event = 'SyncRep'`)
	if err != nil {
		return pgha.SyncWaiters{}, err
	}
	now := time.Now()
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := map[string]time.Time{}
	var result pgha.SyncWaiters
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		pidText, _, _ := strings.Cut(line, "|")
		pid, err := strconv.Atoi(pidText)
		if err != nil {
			continue
		}
		first, ok := e.waiters[line]
		if !ok {
			first = now
		}
		seen[line] = first
		result.Count++
		result.PIDs = append(result.PIDs, pid)
		result.Keys = append(result.Keys, line)
		if age := now.Sub(first); age > result.OldestAge {
			result.OldestAge = age
		}
	}
	e.waiters = seen
	return result, nil
}

func pgLiteral(value string) string    { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
func pgIdentifier(value string) string { return `"` + strings.ReplaceAll(value, `"`, `""`) + `"` }

func (e *pgMember) SetSyncNames(ctx context.Context, names string) error {
	_, err := e.psql(ctx, "ALTER SYSTEM SET synchronous_standby_names = "+pgLiteral(names), "SELECT pg_reload_conf()")
	return err
}

func (e *pgMember) Checkpoint(ctx context.Context) error {
	_, err := e.psql(ctx, "CHECKPOINT")
	return err
}

func (e *pgMember) CurrentFlushLSN(ctx context.Context) (pgha.LSN, error) {
	output, err := e.psql(ctx, "SELECT pg_current_wal_flush_lsn()")
	if err != nil {
		return 0, err
	}
	return pgha.ParseLSN(strings.TrimSpace(output))
}

func (e *pgMember) Promote(ctx context.Context) error {
	output, err := e.psql(ctx, "SELECT pg_promote(wait => true, wait_seconds => 60)")
	if err != nil {
		return err
	}
	if strings.TrimSpace(output) != "t" {
		return errors.New("pg_promote did not complete")
	}
	return nil
}

// SyncSlots keeps exactly the given member slots (M9): other member slots are
// dropped (their walsenders ended first), missing ones created reserving WAL
// at once; on a standby the kept slots follow the replay position.
func (e *pgMember) SyncSlots(ctx context.Context, keep []string) error {
	list := make([]string, len(keep))
	for i, name := range keep {
		list[i] = pgLiteral(name)
	}
	array := "ARRAY[" + strings.Join(list, ",") + "]::text[]"
	// Only the member slots (gw_ha_*); the temporary slots of a running
	// pg_basebackup belong to it and are never touched.
	stale := `slot_type = 'physical' AND NOT temporary AND slot_name LIKE 'gw\_ha\_%' AND NOT (slot_name = ANY(` + array + `))`
	statements := []string{
		`SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE active_pid IS NOT NULL AND ` + stale,
		`SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE NOT active AND ` + stale,
		`SELECT pg_create_physical_replication_slot(name, true) FROM unnest(` + array + `) AS name WHERE name NOT IN (SELECT slot_name FROM pg_replication_slots)`,
		`SELECT pg_replication_slot_advance(slot_name, pg_last_wal_replay_lsn()) FROM pg_replication_slots
		   WHERE pg_is_in_recovery() AND slot_name = ANY(` + array + `) AND NOT active AND pg_last_wal_replay_lsn() IS NOT NULL
		   AND (restart_lsn IS NULL OR restart_lsn < pg_last_wal_replay_lsn())`,
	}
	_, err := e.psql(ctx, statements...)
	return err
}

// EnsureIdentities converges the set principals on the primary (M6): one
// REPLICATION role per member, the rewind role with the documented function
// grants, and the node-local role; passwords travel on stdin.
func (e *pgMember) EnsureIdentities(ctx context.Context, identities pgha.Identities) error {
	record, err := e.record()
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err = e.m.pgExecOutput(callCtx, record.ContainerID,
		[]string{"psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "/var/run/postgresql", "-U", pgLocalRole, "-d", "postgres"},
		pgIdentitiesSQL(identities))
	return err
}

func pgIdentitiesSQL(identities pgha.Identities) string {
	var sql strings.Builder
	ensure := func(role, attributes string) {
		fmt.Fprintf(&sql, "DO $gw$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN CREATE ROLE %s; END IF; END $gw$;\n", pgLiteral(role), pgIdentifier(role))
		fmt.Fprintf(&sql, "ALTER ROLE %s WITH %s;\n", pgIdentifier(role), attributes)
	}
	ensure(pgLocalRole, "LOGIN SUPERUSER PASSWORD NULL")
	roles := make([]string, 0, len(identities.Replication))
	for role := range identities.Replication {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	for _, role := range roles {
		ensure(role, "LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 5 PASSWORD "+pgLiteral(identities.Replication[role]))
	}
	if identities.RewindRole != "" {
		attributes := "LOGIN NOREPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3"
		if identities.RewindPassword != "" {
			attributes += " PASSWORD " + pgLiteral(identities.RewindPassword)
		}
		ensure(identities.RewindRole, attributes)
		for _, function := range []string{"pg_ls_dir(text, boolean, boolean)", "pg_stat_file(text, boolean)", "pg_read_binary_file(text)", "pg_read_binary_file(text, bigint, bigint, boolean)"} {
			fmt.Fprintf(&sql, "GRANT EXECUTE ON FUNCTION pg_catalog.%s TO %s;\n", function, pgIdentifier(identities.RewindRole))
		}
	}
	for _, role := range identities.RemoveRoles {
		fmt.Fprintf(&sql, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s;\n", pgLiteral(role))
		fmt.Fprintf(&sql, "DROP ROLE IF EXISTS %s;\n", pgIdentifier(role))
	}
	return sql.String()
}

func (e *pgMember) TerminateClients(ctx context.Context) error {
	_, err := e.psql(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND usename IS DISTINCT FROM `+pgLiteral(pgLocalRole))
	return err
}

// reloadConfig asks the running server to reread pg_hba and settings.
func (e *pgMember) reloadConfig(ctx context.Context) error {
	_, err := e.psql(ctx, "SELECT pg_reload_conf()")
	return err
}

func pgFreeBytes(path string) int64 {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0
	}
	return int64(stat.Bavail) * int64(stat.Bsize)
}
