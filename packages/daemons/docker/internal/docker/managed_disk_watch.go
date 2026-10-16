package docker

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

// trimMount discards the free blocks of a mounted filesystem (tests replace it).
var trimMount = trimFilesystem

// diskTrims spaces the trims of each instance's disk.
type diskTrims struct {
	mu   sync.Mutex
	last map[string]time.Time
	now  func() time.Time
}

func newDiskTrims() *diskTrims {
	return &diskTrims{last: map[string]time.Time{}, now: time.Now}
}

// due reports whether the disk under key was not trimmed for an interval
// (any time when urgent) and takes the slot.
func (t *diskTrims) due(key string, urgent bool) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if last, ok := t.last[key]; ok && !urgent && now.Sub(last) < diskTrimInterval {
		return false
	}
	t.last[key] = now
	return true
}

// nodeDiskTight reports a node disk with less free space than its reserve:
// the instances' disks then give back what their engines freed (SeaweedFS's
// own compaction, deleted rows) at every watch instead of every interval.
func nodeDiskTight(root string, reserve int64, statfs func(string, *unix.Statfs_t) error) bool {
	if statfs == nil {
		statfs = unix.Statfs
	}
	var stat unix.Statfs_t
	if err := statfs(root, &stat); err != nil {
		return false
	}
	return int64(stat.Bavail)*int64(stat.Bsize) < reserve
}

// trim gives the space of deleted data on the filesystem at mountPath back to
// the node's disk. A disk that is not mounted or no longer writable is left
// alone.
func trimInstanceDisk(loops *loopHost, logger *slog.Logger, label, id, mountPath string) {
	if mounted, err := loops.isMounted(canonicalLoopPath(mountPath)); err != nil || !mounted {
		return
	}
	if readOnly, _ := loops.readOnlyMount(mountPath); readOnly {
		return
	}
	trimmed, err := trimMount(mountPath)
	if err != nil {
		logger.Debug(label+" disk was not trimmed", "id", id, "error", err)
		return
	}
	logger.Debug(label+" disk gave the space of deleted data back to the node", "id", id, "trimmedBytes", trimmed)
}

// runManagedDiskWatch looks at the disks of the managed instances for the life
// of the process: a disk that went read-only is repaired, a repair that had
// to wait is resumed, and every disk gives the space of deleted data back to
// the node once an hour.
func (p *DockerPlugin) runManagedDiskWatch(ctx context.Context) {
	trims := newDiskTrims()
	ticker := time.NewTicker(diskWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if p.databaseManager != nil {
				p.databaseManager.watchDisks(ctx, trims)
			}
			if p.storageManager != nil {
				p.storageManager.watchDisks(ctx, trims)
			}
		}
	}
}

func (m *managedDatabaseManager) watchDisks(ctx context.Context, trims *diskTrims) {
	m.mu.Lock()
	records, _, err := m.records()
	m.mu.Unlock()
	if err != nil {
		return
	}
	urgent := nodeDiskTight(m.root, m.reserve, m.statFilesystem)
	for _, record := range records {
		if ctx.Err() != nil {
			return
		}
		if record.Deleting || record.ContainerID == "" || m.repairs.running(record.ID) || record.DiskRepair.failed() {
			continue
		}
		if record.DiskRepair.pending() {
			if record.DesiredRunning {
				m.repairDisk(ctx, record.ID, record.DiskRepair.Reason)
			}
			continue
		}
		if readOnly, reason := m.loopHost().readOnlyMount(record.MountPath); readOnly {
			if record.DesiredRunning {
				m.repairDisk(ctx, record.ID, reason)
			}
			continue
		}
		m.loopHost().ensureDirectIO(ctx, m.logger, "managed database", record.ID, record.MountPath)
		if trims.due("database/"+record.ID, urgent) {
			trimInstanceDisk(m.loopHost(), m.logger, "managed database", record.ID, record.MountPath)
		}
		if record.Type == "redis" && trims.due("redis-upkeep/"+record.ID, false) {
			if repaired, err := repairRedisAOFRewrite(record); err != nil {
				m.logger.Warn("could not repair the key-value store's AOF rewrite setting", "id", record.ID, "error", err)
			} else if repaired {
				m.logger.Info("the key-value store's automatic AOF rewrite is on again from its next start", "id", record.ID)
			}
		}
		if record.Type == "postgres" && trims.due("postgres-upkeep/"+record.ID, false) {
			// Running databases heal too, not only at their next start.
			m.prunePGMemberLeftovers(record)
			m.ensurePGCronPurge(ctx, record)
		}
	}
}

func (m *managedStorageManager) watchDisks(ctx context.Context, trims *diskTrims) {
	m.mu.Lock()
	records, _, err := m.records()
	m.mu.Unlock()
	if err != nil {
		return
	}
	urgent := nodeDiskTight(m.root, m.reserve, m.statFilesystem)
	for _, record := range records {
		if ctx.Err() != nil {
			return
		}
		if record.Removed || record.ContainerID == "" || m.repairs.running(record.ID) || record.DiskRepair.failed() {
			continue
		}
		if record.DiskRepair.pending() {
			if record.DesiredRunning {
				m.repairDisk(ctx, record.ID, record.DiskRepair.Reason)
			}
			continue
		}
		if readOnly, reason := m.loopHost().readOnlyMount(record.MountPath); readOnly {
			if record.DesiredRunning {
				m.repairDisk(ctx, record.ID, reason)
			}
			continue
		}
		m.loopHost().ensureDirectIO(ctx, m.logger, "managed storage", record.ID, record.MountPath)
		if trims.due("storage/"+record.ID, urgent) {
			trimInstanceDisk(m.loopHost(), m.logger, "managed storage", record.ID, record.MountPath)
		}
	}
}

func (m *managedDatabaseManager) fsck() func(context.Context, string) (int, string, error) {
	if m.runFsck != nil {
		return m.runFsck
	}
	return runE2fsck
}

func (m *managedStorageManager) fsck() func(context.Context, string) (int, string, error) {
	if m.runFsck != nil {
		return m.runFsck
	}
	return runE2fsck
}

// repairDisk repairs a managed database's read-only disk (see diskRepairJob).
func (m *managedDatabaseManager) repairDisk(ctx context.Context, id, reason string) {
	if !m.repairs.begin(id) {
		return
	}
	defer m.repairs.end(id)
	diskRepairJob{
		label: "managed database", id: id, reason: reason, lock: &m.mu, loops: m.loopHost(), root: m.root,
		statfs: m.statFilesystem, fsck: m.fsck(), logger: m.logger,
		load: func() (diskRepairTarget, bool, error) {
			record, err := m.loadRecord(id)
			if err != nil {
				return diskRepairTarget{}, false, err
			}
			return diskRepairTarget{ImagePath: record.ImagePath, MountPath: record.MountPath, ContainerID: record.ContainerID, Repair: record.DiskRepair},
				!record.Deleting && record.DesiredRunning, nil
		},
		persist: func(repair managedDiskRepair) error {
			record, err := m.loadRecord(id)
			if err != nil {
				return err
			}
			record.DiskRepair = &repair
			return m.saveRecord(record)
		},
		stop: m.stopContainer,
		start: func(ctx context.Context) error {
			record, err := m.loadRecord(id)
			if err != nil {
				return err
			}
			if err := m.ensureMounted(ctx, &record); err != nil {
				return err
			}
			if readOnly, why := m.loopHost().readOnlyMount(record.MountPath); readOnly {
				return fmt.Errorf("the filesystem is still read-only (%s)", why)
			}
			if err := m.saveRecord(record); err != nil {
				return err
			}
			if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
				return runtimeFilesMissingError("managed database", missing)
			}
			if _, err := m.client.cli.ContainerStart(ctx, record.ContainerID, mobyclient.ContainerStartOptions{}); err != nil {
				return fmt.Errorf("start managed database container: %w", err)
			}
			m.incidents.forget(id)
			return nil
		},
	}.run(ctx)
}

// repairDisk repairs a managed storage member's read-only disk.
func (m *managedStorageManager) repairDisk(ctx context.Context, id, reason string) {
	if !m.repairs.begin(id) {
		return
	}
	defer m.repairs.end(id)
	diskRepairJob{
		label: "managed storage", id: id, reason: reason, lock: &m.mu, loops: m.loopHost(), root: m.root,
		statfs: m.statFilesystem, fsck: m.fsck(), logger: m.logger,
		load: func() (diskRepairTarget, bool, error) {
			record, err := m.loadRecord(id)
			if err != nil {
				return diskRepairTarget{}, false, err
			}
			return diskRepairTarget{ImagePath: record.ImagePath, MountPath: record.MountPath, ContainerID: record.ContainerID, Repair: record.DiskRepair},
				!record.Removed && record.DesiredRunning, nil
		},
		persist: func(repair managedDiskRepair) error {
			record, err := m.loadRecord(id)
			if err != nil {
				return err
			}
			record.DiskRepair = &repair
			return m.saveRecord(record)
		},
		stop: func(ctx context.Context, containerID string) error {
			return m.client.StopContainer(ctx, containerID, 20)
		},
		start: func(ctx context.Context) error {
			record, err := m.loadRecord(id)
			if err != nil {
				return err
			}
			if err := m.ensureMounted(ctx, &record); err != nil {
				return err
			}
			if readOnly, why := m.loopHost().readOnlyMount(record.MountPath); readOnly {
				return fmt.Errorf("the filesystem is still read-only (%s)", why)
			}
			if err := m.saveRecord(record); err != nil {
				return err
			}
			if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
				return runtimeFilesMissingError("managed storage", missing)
			}
			if err := m.startContainer(ctx, record.ContainerID); err != nil {
				return err
			}
			m.incidents.forget(id)
			return nil
		},
	}.run(ctx)
}

// diskBlocksCommand refuses a command that needs the engine or its disk
// while the disk is being repaired, failed its repair, or went read-only. A
// start or restart (starting) retries a failed repair; any of them begins
// the repair of a disk found read-only. Called under the manager lock.
func (m *managedDatabaseManager) diskBlocksCommand(record *managedDatabaseRecord, starting bool) error {
	if m.repairs.running(record.ID) {
		return errDiskBeingRepaired("managed database")
	}
	reason := ""
	switch {
	case record.DiskRepair.pending():
		reason = record.DiskRepair.Reason
	case record.DiskRepair.failed():
		if !starting {
			return fmt.Errorf("the managed database disk could not be repaired (%s); restart the database to try the repair again", record.DiskRepair.Detail)
		}
		reason = record.DiskRepair.Reason
	default:
		readOnly, why := m.loopHost().readOnlyMount(record.MountPath)
		if !readOnly {
			return nil
		}
		reason = why
	}
	if starting {
		record.DesiredRunning = true
	}
	record.DiskRepair = &managedDiskRepair{State: diskRepairRepairing, Reason: reason, At: time.Now().UTC()}
	if err := m.saveRecord(*record); err != nil {
		return err
	}
	if record.DesiredRunning {
		go m.repairDisk(context.Background(), record.ID, reason)
	}
	return errDiskBeingRepaired("managed database")
}

// diskBlocksCommand is the managed storage variant.
func (m *managedStorageManager) diskBlocksCommand(record *managedStorageRecord, starting bool) error {
	if m.repairs.running(record.ID) {
		return errDiskBeingRepaired("managed storage")
	}
	reason := ""
	switch {
	case record.DiskRepair.pending():
		reason = record.DiskRepair.Reason
	case record.DiskRepair.failed():
		if !starting {
			return fmt.Errorf("the managed storage disk could not be repaired (%s); restart the storage to try the repair again", record.DiskRepair.Detail)
		}
		reason = record.DiskRepair.Reason
	default:
		readOnly, why := m.loopHost().readOnlyMount(record.MountPath)
		if !readOnly {
			return nil
		}
		reason = why
	}
	if starting {
		record.DesiredRunning = true
	}
	record.DiskRepair = &managedDiskRepair{State: diskRepairRepairing, Reason: reason, At: time.Now().UTC()}
	if err := m.saveRecord(*record); err != nil {
		return err
	}
	if record.DesiredRunning {
		go m.repairDisk(context.Background(), record.ID, reason)
	}
	return errDiskBeingRepaired("managed storage")
}
