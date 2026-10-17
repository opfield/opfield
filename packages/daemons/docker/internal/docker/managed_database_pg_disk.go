package docker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// What bounds a managed PostgreSQL on its own volume: WAL between
// checkpoints, temporary files, WAL kept for replication slots, the diverged
// WAL copies and the previous data directory of a set member's rejoin.

const (
	// pgDivergedDirName holds the diverged WAL copies of a set member under
	// its gateway-ha directory.
	pgDivergedDirName = "diverged"
	// pgDivergedCopiesKept is how many diverged WAL copies a member keeps.
	pgDivergedCopiesKept = 2
	// pgMinDiskReserve is the least a rejoin's copies leave free.
	pgMinDiskReserve = 64 << 20
	// pgFullCopyMinFree is the least a rebuild leaves free when it copies a
	// discarded data directory's whole pg_wal aside.
	pgFullCopyMinFree = 1 << 30
	// pgSlotWALKeepFloor is the least WAL a member slot keeps when free space
	// is short: a streaming copy that lags a little does not lose its slot.
	pgSlotWALKeepFloor = 64 << 20
	// pgManagedMarkerPrefix names the entry next to each disk setting Opfield
	// wrote into postgresql.auto.conf: a value that differs from it was set by
	// the user (ALTER SYSTEM) and is never overridden.
	pgManagedMarkerPrefix = "opfield.managed_"
	// pgIdleSlotReset: a member slot nobody streamed from this long is reset
	// on the primary (dropped and created again at the current position), so
	// it stops holding WAL and the oldest transaction id for VACUUM.
	pgIdleSlotReset = 24 * time.Hour
	// pgSlotKeepTolerance: the live slot limit is rewritten only when the
	// wanted value differs from the running one by more than this share.
	pgSlotKeepTolerance = 10
)

// pgDiskReserveFor is what a rejoin's copies leave free on a volume: 5% of
// it, at least 64 MiB.
func pgDiskReserveFor(volumeBytes int64) int64 {
	return max(int64(pgMinDiskReserve), volumeBytes/20)
}

// pgDivergedBudget is the most the diverged WAL copies of a member hold
// together: 5% of the volume.
func pgDivergedBudget(volumeBytes int64) int64 { return volumeBytes / 20 }

// pgVolumeBytes is the size of the filesystem at path (0 when unknown).
func pgVolumeBytes(path string) int64 {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0
	}
	return int64(stat.Blocks) * int64(stat.Bsize)
}

// prunePGDivergedCopies keeps the newest diverged WAL copies under dir: at
// most pgDivergedCopiesKept, together within 5% of the volume; older ones go
// first. It returns the copies removed.
func prunePGDivergedCopies(dir string, volumeBytes int64) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	// The names are UTC timestamps (20060102T150405Z): newest last.
	sort.Strings(names)
	budget := pgDivergedBudget(volumeBytes)
	var kept, total int64
	var removed []string
	for i := len(names) - 1; i >= 0; i-- {
		path := filepath.Join(dir, names[i])
		size := pgDirBytes(path)
		if kept < pgDivergedCopiesKept && (volumeBytes <= 0 || total+size <= budget) {
			kept++
			total += size
			continue
		}
		if err := os.RemoveAll(path); err == nil {
			removed = append(removed, path)
		}
	}
	return removed
}

// pgDiskSettings are the settings that bound PostgreSQL's own use of a
// volume of storageBytes: WAL between checkpoints a tenth of it (64 MB to the
// 1 GB default), temporary files of one session a quarter of it.
func pgDiskSettings(storageBytes int64) map[string]string {
	if storageBytes <= 0 {
		return map[string]string{}
	}
	maxWAL := min(max(storageBytes/10, int64(64<<20)), int64(1<<30))
	// min_wal_size must be at least two segments and never above max_wal_size.
	minWAL := max(int64(32<<20), min(int64(80<<20), maxWAL/2))
	return map[string]string{
		"max_wal_size":    pgMegabytes(maxWAL),
		"min_wal_size":    pgMegabytes(minWAL),
		"temp_file_limit": pgMegabytes(max(storageBytes/4, int64(1<<20))),
	}
}

// pgSlotWALKeepBytes is max_slot_wal_keep_size: the configured value or a
// quarter of the volume (at least 32 MiB, never above half), and never more
// than half the free space when it is applied (freeBytes < 0: unknown), with
// a floor that keeps a streaming copy's slot.
func pgSlotWALKeepBytes(configuredMB, storageBytes, freeBytes int64) int64 {
	keep := configuredMB << 20
	if keep <= 0 {
		keep = max(storageBytes/4, pgMinSlotWALKeep)
		if storageBytes > 0 {
			keep = min(keep, storageBytes/2)
		}
	}
	if freeBytes >= 0 {
		keep = min(keep, max(freeBytes/2, int64(pgSlotWALKeepFloor)))
	}
	return keep
}

func pgMegabytes(bytes int64) string { return strconv.FormatInt(max(bytes>>20, 1), 10) + "MB" }

// pgParseMegabytes reads a size setting as pg_settings shows it in MB ("-1"
// is unlimited).
func pgParseMegabytes(value string) (int64, bool) {
	value = strings.TrimSuffix(strings.TrimSpace(value), "MB")
	parsed, err := strconv.ParseInt(value, 10, 64)
	return parsed, err == nil
}

// pgApplyManagedSettings writes desired into postgresql.auto.conf of an
// initialized data directory, each with its marker. A setting present
// without a matching marker is the user's (ALTER SYSTEM) and stays; a reset
// one (absent) is Opfield's again. It reports whether the file changed.
func pgApplyManagedSettings(pgdata string, desired map[string]string) (bool, error) {
	if _, err := os.Stat(filepath.Join(pgdata, "PG_VERSION")); err != nil {
		// Not initialized: initdb needs an empty directory.
		return false, nil
	}
	existing, err := pgReadAutoConf(filepath.Join(pgdata, "postgresql.auto.conf"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	managed := map[string]string{}
	var drop []string
	for key, value := range desired {
		marker := pgManagedMarkerPrefix + key
		current, has := existing[key]
		mark, marked := existing[marker]
		if has && (!marked || mark != current) {
			// The user's value.
			if marked {
				drop = append(drop, marker)
			}
			continue
		}
		if has && current == value {
			continue
		}
		managed[key], managed[marker] = value, value
	}
	if len(managed) == 0 && len(drop) == 0 {
		return false, nil
	}
	return true, pgUpdateAutoConf(pgdata, drop, managed)
}

// pgStandaloneDiskSettings are the disk settings of a PostgreSQL that is not
// a set member: its slots keep at most what pgSlotWALKeepBytes allows.
func pgStandaloneDiskSettings(storageBytes, freeBytes int64) map[string]string {
	settings := pgDiskSettings(storageBytes)
	if storageBytes > 0 {
		settings["max_slot_wal_keep_size"] = pgMegabytes(pgSlotWALKeepBytes(0, storageBytes, freeBytes))
	}
	return settings
}

// refreshPostgresDiskSettings writes the disk settings of a PostgreSQL that
// is not a set member (its member runtime writes them before every start)
// into its data directory; reload asks the running server to apply them
// (every one of them is reloadable). A failure is logged: it never stops a
// start.
func (m *managedDatabaseManager) refreshPostgresDiskSettings(ctx context.Context, record managedDatabaseRecord, containerID string, reload bool) {
	if record.Type != "postgres" || record.AvailabilitySetID != "" || record.MountPath == "" {
		return
	}
	pgdata := filepath.Join(record.MountPath, pgdataDirName)
	changed, err := pgApplyManagedSettings(pgdata, pgStandaloneDiskSettings(record.StorageSize, pgFreeBytes(record.MountPath)))
	if err != nil {
		m.logger.Warn("could not write the PostgreSQL disk settings", "id", record.ID, "error", err)
		return
	}
	if !changed || !reload || containerID == "" {
		return
	}
	reloadCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if _, err := m.pgExecOutput(reloadCtx, containerID, []string{"pg_ctl", "reload", "-D", pgContainerDataDir + "/" + pgdataDirName}, ""); err != nil {
		m.logger.Warn("could not reload the PostgreSQL disk settings", "id", record.ID, "error", err)
	}
}

// prunePGMemberLeftovers bounds what a rejoin kept on a database's volume:
// the diverged WAL copies (any database: a lifted member keeps its
// HA directory).
func (m *managedDatabaseManager) prunePGMemberLeftovers(record managedDatabaseRecord) {
	if record.Type != "postgres" || record.MountPath == "" {
		return
	}
	dir := filepath.Join(record.MountPath, pgMemberDirName, pgDivergedDirName)
	if _, err := os.Stat(dir); err != nil {
		return
	}
	for _, path := range prunePGDivergedCopies(dir, pgVolumeBytes(record.MountPath)) {
		m.logger.Info("removed an old diverged WAL copy", "id", record.ID, "path", path)
	}
}
