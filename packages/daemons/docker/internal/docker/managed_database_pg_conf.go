package docker

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/pgha"
)

// Settings the daemon owns in postgresql.auto.conf of a Postgres set member.
// They are rewritten before every start and after every rewind or base
// backup (M4), which also drops what a base backup or rewind copied from the
// primary. synchronous_standby_names is managed at run time with ALTER SYSTEM
// on the primary; a start always begins with it empty (the holder path sets
// it before any promotion).
var pgMemberAutoConfKeys = []string{
	"primary_conninfo", "primary_slot_name", "recovery_target_timeline", "synchronous_standby_names",
	"restart_after_crash", "hot_standby", "hot_standby_feedback", "wal_level", "wal_log_hints",
	"max_wal_senders", "max_replication_slots", "max_slot_wal_keep_size", "max_connections",
	"max_worker_processes", "max_prepared_transactions", "max_locks_per_transaction",
}

// pgMemberOnlyAutoConfKeys are the settings a lifted member drops (close or
// detach): what makes it a standby or a set primary. Member-equal sizing
// stays.
var pgMemberOnlyAutoConfKeys = []string{"primary_conninfo", "primary_slot_name", "recovery_target_timeline", "synchronous_standby_names", "restart_after_crash"}

const (
	// pgReplicationHost is the member mesh alias of the set's primary
	// replication port on the set's private bridge.
	pgReplicationHost   = "primary-" + pgha.ReplicationPort
	pgReplicationPort   = 5432
	pgMemberDirName     = "gateway-ha"
	pgdataDirName       = "pgdata"
	pgRebuildDirName    = "pgdata.rebuild"
	pgPreviousDirName   = "pgdata.previous"
	pgContainerDataDir  = "/var/lib/postgresql/data"
	pgContainerTLSDir   = "/run/gateway-tls"
	pgContainerHAConf   = pgContainerDataDir + "/" + pgMemberDirName
	pgContainerPassfile = pgContainerHAConf + "/pgpass"
	pgMinSlotWALKeep    = 32 << 20
	pgPostgresUID       = 999
	pgPostgresGID       = 999
	// pgLocalRole is the superuser the daemon uses through the container's
	// unix socket only (pg_hba rejects it on every TCP line).
	pgLocalRole = "gw_ha_local"
	// pgMemberLabel marks a Postgres set member's container.
	pgMemberLabel = "wiolett.gateway.availability.member"
)

// pgReplicationConnInfo is the libpq conninfo of the member's walreceiver and
// helpers: the primary through the member mesh, the member's own role and
// name, TLS with the member certificate (pg_hba requires it for the roles).
func pgReplicationConnInfo(user, applicationName, database string) string {
	parts := []string{
		"host=" + pgReplicationHost, "port=" + strconv.Itoa(pgReplicationPort), "user=" + user,
		"application_name=" + applicationName, "passfile=" + pgContainerPassfile,
		"sslmode=verify-ca", "sslrootcert=" + pgContainerTLSDir + "/ca.pem",
		"sslcert=" + pgContainerTLSDir + "/cert.pem", "sslkey=" + pgContainerTLSDir + "/key.pem",
		"connect_timeout=5", "keepalives=1", "keepalives_idle=5", "keepalives_interval=2", "keepalives_count=3",
	}
	if database != "" {
		parts = append(parts, "dbname="+database)
	}
	return strings.Join(parts, " ")
}

// pgMemberAutoConf returns the daemon's settings for a start.
func pgMemberAutoConf(config pgha.StandbyConfig, storageBytes int64) map[string]string {
	values := map[string]string{
		"primary_conninfo":          pgReplicationConnInfo(config.ReplicationRole, config.MemberID, ""),
		"primary_slot_name":         config.SlotName,
		"recovery_target_timeline":  "latest",
		"synchronous_standby_names": "",
		"restart_after_crash":       "off",
		"hot_standby":               "on",
		"hot_standby_feedback":      "on",
		"wal_level":                 "replica",
		"wal_log_hints":             "on",
	}
	p := config.Parameters
	set := func(key string, value int) {
		if value > 0 {
			values[key] = strconv.Itoa(value)
		}
	}
	set("max_connections", p.MaxConnections)
	set("max_wal_senders", p.MaxWalSenders)
	set("max_replication_slots", p.MaxReplicationSlots)
	set("max_worker_processes", p.MaxWorkerProcesses)
	set("max_prepared_transactions", p.MaxPreparedTransactions)
	set("max_locks_per_transaction", p.MaxLocksPerTransaction)
	keep := p.MaxSlotWalKeepSizeMB << 20
	if keep <= 0 {
		// Bounded by the volume: a quarter of it, at least 32 MiB and never
		// more than half.
		keep = max(storageBytes/4, pgMinSlotWALKeep)
		if storageBytes > 0 {
			keep = min(keep, storageBytes/2)
		}
	}
	values["max_slot_wal_keep_size"] = strconv.FormatInt(max(keep>>20, 1), 10) + "MB"
	return values
}

// pgUpdateAutoConf rewrites postgresql.auto.conf with the drop keys removed
// and the managed ones applied; foreign entries are kept; file and directory
// are fsynced.
func pgUpdateAutoConf(pgdata string, drop []string, managed map[string]string) error {
	path := filepath.Join(pgdata, "postgresql.auto.conf")
	existing, err := pgReadAutoConf(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, key := range drop {
		delete(existing, key)
	}
	for key, value := range managed {
		existing[key] = value
	}
	keys := make([]string, 0, len(existing))
	for key := range existing {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString("# Do not edit this file manually!\n# It will be overwritten by the ALTER SYSTEM command.\n")
	for _, key := range keys {
		fmt.Fprintf(&b, "%s = '%s'\n", key, strings.ReplaceAll(existing[key], "'", "''"))
	}
	return writeFileAtomically(path, []byte(b.String()), 0o600, func(p string) error {
		return managedDatabaseChown(p, pgPostgresUID, pgPostgresGID)
	})
}

// pgReadAutoConf parses postgresql.auto.conf lines "key = 'value'".
func pgReadAutoConf(path string) (map[string]string, error) {
	out := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
			value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
		out[key] = value
	}
	return out, scanner.Err()
}

// pgMemberHBA is the member's pg_hba (same on every member, outside PGDATA):
// the set roles authenticate only over TLS with a certificate issued by the
// database CA, which only member containers hold (M6: replication goes only
// through the member mesh; every connection reaches Postgres from the
// daemon's bridge address, so the certificate binds the roles, not the
// address).
func pgMemberHBA(replicationRoles []string, rewindRole string) string {
	quoted := func(names []string) string {
		out := make([]string, len(names))
		for i, name := range names {
			out[i] = `"` + name + `"`
		}
		return strings.Join(out, ",")
	}
	roles := append([]string(nil), replicationRoles...)
	sort.Strings(roles)
	restricted := append(append([]string(nil), roles...), rewindRole, pgLocalRole)
	var b strings.Builder
	b.WriteString("# Managed by Gateway: availability set member. Direct TCP clients must negotiate TLS.\n")
	b.WriteString("local all all trust\n")
	if len(roles) > 0 {
		fmt.Fprintf(&b, "hostssl replication %s all scram-sha-256 clientcert=verify-ca\n", quoted(roles))
	}
	fmt.Fprintf(&b, "hostssl postgres %s all scram-sha-256 clientcert=verify-ca\n", quoted([]string{rewindRole}))
	fmt.Fprintf(&b, "host all %s all reject\n", quoted(restricted))
	b.WriteString("host replication all all reject\n")
	b.WriteString("hostssl all all 0.0.0.0/0 scram-sha-256\n")
	b.WriteString("hostssl all all ::0/0 scram-sha-256\n")
	return b.String()
}

// pgMemberPassfile is the member's libpq password file: its own replication
// role and the rewind role, so it streams, rewinds and rebuilds while Gateway
// is down.
func pgMemberPassfile(replicationRole, replicationPassword, rewindRole, rewindPassword string) string {
	escape := func(value string) string { return strings.NewReplacer(`\`, `\\`, `:`, `\:`).Replace(value) }
	var b strings.Builder
	fmt.Fprintf(&b, "*:*:*:%s:%s\n", escape(replicationRole), escape(replicationPassword))
	if rewindRole != "" && rewindPassword != "" {
		fmt.Fprintf(&b, "*:*:*:%s:%s\n", escape(rewindRole), escape(rewindPassword))
	}
	return b.String()
}

// pgMemberHBAPath is the member's pg_hba inside the data volume (a directory
// bind mount, so a rewrite is visible to the running server at its next
// reload; a single-file bind mount would keep the old inode).
func pgMemberHBAPath(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, pgMemberDirName, "pg_hba.conf")
}

const pgContainerHBAPath = pgContainerHAConf + "/pg_hba.conf"

// writePGMemberFiles writes the member's pg_hba and passfile onto its data
// image (from its engine configuration).
func writePGMemberFiles(record managedDatabaseRecord, config pgha.Config) error {
	dir := filepath.Join(record.MountPath, pgMemberDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create the member's directory: %w", err)
	}
	if err := managedDatabaseChown(dir, pgPostgresUID, pgPostgresGID); err != nil {
		return err
	}
	roles := make([]string, 0, len(config.Members))
	for _, peer := range config.Members {
		roles = append(roles, peer.ReplicationRole)
	}
	if err := writeFileAtomically(pgMemberHBAPath(record), []byte(pgMemberHBA(roles, config.Engine.RewindRole)), 0o644, nil); err != nil {
		return fmt.Errorf("write the member's pg_hba: %w", err)
	}
	if config.Engine.ReplicationPassword == "" {
		// Keep the stored secrets (a configuration without them).
		if _, err := os.Stat(filepath.Join(dir, "pgpass")); err == nil {
			return nil
		}
		return errors.New("the member's replication password is required")
	}
	self := config.Self()
	return writeFileAtomically(filepath.Join(dir, "pgpass"),
		[]byte(pgMemberPassfile(self.ReplicationRole, config.Engine.ReplicationPassword, config.Engine.RewindRole, config.Engine.RewindPassword)), 0o600,
		func(path string) error { return managedDatabaseChown(path, pgPostgresUID, pgPostgresGID) })
}
