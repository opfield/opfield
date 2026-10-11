package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	mobyclient "github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

// SeaweedFS keeps the space of a deleted object in its volume files until the
// volume is compacted ("vacuumed"). Its master compacts on its own only about
// every 15 minutes (fixed in 4.47) and that sweep skips read-only volumes; a
// volume server whose disk is below -volume.minFreeSpace reports every volume
// read-only. A storage that filled up with deleted objects therefore stayed
// full ("No writable volumes") until someone compacted it volume by volume.
//
// The daemon gives that space back itself: every reclaim interval it reads the
// volumes from the master and compacts the ones with enough garbage through
// `weed shell volume.vacuum -volumeId`, which, unlike the master's sweep,
// also compacts read-only volumes. A compaction writes a copy of the volume's
// live part next to it and needs room for the whole volume, which the sizing
// keeps: the free-space guard is at least twice the volume size limit (see
// seaweedfsSizingFor), so a disk SeaweedFS stopped writing to at the guard
// can still be compacted. Existing storages need nothing recreated.
const (
	seaweedfsReclaimInterval = 30 * time.Second
	// The share of a volume that is deleted objects before it is compacted;
	// SeaweedFS's own default. With little space left nearly every deleted
	// byte is given back.
	seaweedfsReclaimThreshold         = 0.3
	seaweedfsPressureReclaimThreshold = 0.02
	// Volumes with less garbage than this are not rewritten for it.
	seaweedfsReclaimMinimumBytes = mebibyte
	// One .idx entry (needle id, offset, size).
	seaweedfsIndexEntryBytes = 16

	seaweedfsVolumeStatusTimeout = 30 * time.Second
	seaweedfsVacuumTimeout       = 10 * time.Minute
	seaweedfsEngineOutputLimit   = 16 * mebibyte
)

var (
	seaweedfsVolumeStatusCommand = []string{"curl", "-fsS", "--max-time", "20", "http://127.0.0.1:9333/vol/status"}
	seaweedfsShellCommand        = []string{"/usr/bin/weed", "-config_dir=" + seaweedfsContainerRoot + "/config", "shell", "-master=127.0.0.1:9333"}
)

// seaweedfsVolume is one volume of the master's /vol/status answer.
type seaweedfsVolume struct {
	ID               uint32 `json:"Id"`
	Collection       string `json:"Collection"`
	Size             uint64 `json:"Size"`
	DeletedByteCount uint64 `json:"DeletedByteCount"`
	FileCount        uint64 `json:"FileCount"`
	DeleteCount      uint64 `json:"DeleteCount"`
	ReadOnly         bool   `json:"ReadOnly"`
}

// garbage is the share of the volume file that is deleted objects.
func (v seaweedfsVolume) garbage() float64 {
	if v.Size == 0 {
		return 0
	}
	return float64(v.DeletedByteCount) / float64(v.Size)
}

// compactionSpace is the free space SeaweedFS requires before it compacts the
// volume: the volume file and its index (see ensureCompactVolumeSpace), with a
// margin for the new index.
func (v seaweedfsVolume) compactionSpace() int64 {
	return int64(v.Size) + int64((v.FileCount+v.DeleteCount)*seaweedfsIndexEntryBytes) + mebibyte
}

// parseSeaweedFSVolumeStatus reads the volumes of every data node from the
// master's /vol/status answer.
func parseSeaweedFSVolumeStatus(raw []byte) ([]seaweedfsVolume, error) {
	var status struct {
		Volumes struct {
			DataCenters map[string]map[string]map[string][]seaweedfsVolume `json:"DataCenters"`
		} `json:"Volumes"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return nil, fmt.Errorf("decode SeaweedFS volume status: %w", err)
	}
	seen := map[uint32]bool{}
	var volumes []seaweedfsVolume
	for _, racks := range status.Volumes.DataCenters {
		for _, nodes := range racks {
			for _, list := range nodes {
				for _, volume := range list {
					if seen[volume.ID] {
						continue
					}
					seen[volume.ID] = true
					volumes = append(volumes, volume)
				}
			}
		}
	}
	return volumes, nil
}

// storageSpace is a storage disk's capacity as an unprivileged writer sees it
// (SeaweedFS counts available blocks, like statfs f_bavail).
type storageSpace struct {
	Free  int64
	Total int64
}

func (m *managedStorageManager) storageSpace(record managedStorageRecord) (storageSpace, error) {
	var stat unix.Statfs_t
	if err := m.filesystemStats(record.MountPath, &stat); err != nil {
		return storageSpace{}, fmt.Errorf("stat managed storage disk: %w", err)
	}
	return storageSpace{Free: int64(stat.Bavail) * int64(stat.Bsize), Total: int64(stat.Blocks) * int64(stat.Bsize)}, nil
}

// seaweedfsFull reports a disk below the engine's free-space guard: SeaweedFS
// then takes no new writes ("No writable volumes") until space is freed.
func seaweedfsFull(space storageSpace, sizing seaweedfsSizing) bool {
	return space.Free < sizing.MinFreeSpaceMiB*mebibyte
}

// seaweedfsReclaim is one compaction pass: the volumes to compact, in order,
// and the garbage threshold the master checks each of them against again.
type seaweedfsReclaim struct {
	Threshold float64
	VolumeIDs []uint32
	Garbage   uint64
}

// planSeaweedFSReclaim picks the volumes worth compacting. Read-only volumes
// are compacted only while the disk is full (that is why they are read-only).
// Volumes with the most garbage go first; a volume is planned only when the
// space it needs is free by then, counting what the volumes before it give
// back.
func planSeaweedFSReclaim(volumes []seaweedfsVolume, space storageSpace, sizing seaweedfsSizing) seaweedfsReclaim {
	full := seaweedfsFull(space, sizing)
	plan := seaweedfsReclaim{Threshold: seaweedfsReclaimThreshold}
	if full || space.Free < space.Total/4 {
		plan.Threshold = seaweedfsPressureReclaimThreshold
	}
	candidates := make([]seaweedfsVolume, 0, len(volumes))
	for _, volume := range volumes {
		if volume.DeletedByteCount < seaweedfsReclaimMinimumBytes || volume.garbage() < plan.Threshold || (volume.ReadOnly && !full) {
			continue
		}
		candidates = append(candidates, volume)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].DeletedByteCount != candidates[j].DeletedByteCount {
			return candidates[i].DeletedByteCount > candidates[j].DeletedByteCount
		}
		return candidates[i].ID < candidates[j].ID
	})
	free := space.Free
	for _, volume := range candidates {
		if volume.compactionSpace() > free {
			continue
		}
		plan.VolumeIDs = append(plan.VolumeIDs, volume.ID)
		plan.Garbage += volume.DeletedByteCount
		free += int64(volume.DeletedByteCount)
	}
	return plan
}

// seaweedfsVacuumScript is the weed shell input for a plan. volume.vacuum
// takes the shell's cluster lock; the master compacts the volumes one by one.
func seaweedfsVacuumScript(plan seaweedfsReclaim) string {
	ids := make([]string, 0, len(plan.VolumeIDs))
	for _, id := range plan.VolumeIDs {
		ids = append(ids, strconv.FormatUint(uint64(id), 10))
	}
	return "lock\nvolume.vacuum -garbageThreshold=" + strconv.FormatFloat(plan.Threshold, 'f', -1, 64) +
		" -volumeId=" + strings.Join(ids, ",") + "\nunlock\n"
}

// runSpaceReclaim gives back the space of deleted objects of every SeaweedFS
// storage for the life of the process.
func (m *managedStorageManager) runSpaceReclaim(ctx context.Context) {
	ticker := time.NewTicker(seaweedfsReclaimInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reclaimSpace(ctx)
		}
	}
}

// reclaimSpace runs one pass over the storages. It does not hold the manager
// lock while an engine compacts: a command for the storage (a recreate, a
// stop) goes ahead and the pass's engine command then just fails.
func (m *managedStorageManager) reclaimSpace(ctx context.Context) {
	m.mu.Lock()
	records, _, err := m.records()
	m.mu.Unlock()
	if err != nil {
		m.logger.Debug("managed storage space reclaim skipped", "error", err)
		return
	}
	for _, record := range records {
		// A set member's master runs on its primary only (managed_storage_set.go).
		if record.engine() != managedStorageEngineSeaweedFS || record.Set != nil || record.Removed || !record.DesiredRunning || record.ContainerID == "" {
			continue
		}
		// A disk that no longer takes writes cannot be compacted; the disk
		// watch repairs it first.
		if m.repairs.running(record.ID) || record.DiskRepair.blocksEngine() {
			continue
		}
		if readOnly, _ := m.loopHost().readOnlyMount(record.MountPath); readOnly {
			continue
		}
		if err := m.reclaimSeaweedFSSpace(ctx, record); err != nil {
			m.logger.Debug("managed storage space of deleted objects not reclaimed in this pass", "id", record.ID, "error", err)
		}
	}
}

func (m *managedStorageManager) reclaimSeaweedFSSpace(ctx context.Context, record managedStorageRecord) error {
	space, err := m.storageSpace(record)
	if err != nil {
		return err
	}
	statusCtx, cancel := context.WithTimeout(ctx, seaweedfsVolumeStatusTimeout)
	raw, err := m.engineExec(statusCtx, record.ContainerID, seaweedfsVolumeStatusCommand, "")
	cancel()
	if err != nil {
		return fmt.Errorf("read volume status: %w", err)
	}
	volumes, err := parseSeaweedFSVolumeStatus(raw)
	if err != nil {
		return err
	}
	plan := planSeaweedFSReclaim(volumes, space, seaweedfsSizingFor(record.StorageBytes))
	if len(plan.VolumeIDs) == 0 {
		return nil
	}
	vacuumCtx, cancel := context.WithTimeout(ctx, seaweedfsVacuumTimeout)
	defer cancel()
	if _, err := m.engineExec(vacuumCtx, record.ContainerID, seaweedfsShellCommand, seaweedfsVacuumScript(plan)); err != nil {
		m.logger.Warn("managed storage could not give back the space of deleted objects", "id", record.ID,
			"volumes", len(plan.VolumeIDs), "error", err)
		return nil
	}
	after, err := m.storageSpace(record)
	if err != nil {
		return err
	}
	freed := after.Free - space.Free
	if freed <= 0 {
		// Nothing came free (new objects took the space, or the volumes'
		// garbage was already counted); not worth a line every pass.
		m.logger.Debug("managed storage compaction freed no space", "id", record.ID,
			"volumes", len(plan.VolumeIDs), "freedBytes", freed, "freeBytes", after.Free)
		return nil
	}
	m.logger.Info("managed storage gave back the space of deleted objects", "id", record.ID,
		"volumes", len(plan.VolumeIDs), "freedBytes", freed, "freeBytes", after.Free)
	// The compacted volume files are smaller now; the node's disk gets that
	// space back once the storage's filesystem discards it.
	trimInstanceDisk(m.loopHost(), m.logger, "managed storage", record.ID, record.MountPath)
	return nil
}

// seaweedfsStorageFull reports whether a running SeaweedFS storage's disk is
// full; ok is false when its disk cannot be read.
func (m *managedStorageManager) seaweedfsStorageFull(record managedStorageRecord) (full, ok bool) {
	space, err := m.storageSpace(record)
	if err != nil {
		return false, false
	}
	return seaweedfsFull(space, seaweedfsSizingFor(record.StorageBytes)), true
}

// engineExec runs a command in an engine container as its runtime user, with
// stdin when given, and returns what it printed to stdout. A command that
// exits non-zero fails with the end of what it printed to stderr.
func (m *managedStorageManager) engineExec(ctx context.Context, containerID string, command []string, stdin string) ([]byte, error) {
	if m.execEngine != nil {
		return m.execEngine(ctx, containerID, command, stdin)
	}
	created, err := m.client.cli.ExecCreate(ctx, containerID, mobyclient.ExecCreateOptions{
		Cmd: command, AttachStdin: stdin != "", AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return nil, fmt.Errorf("start engine command: %w", err)
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return nil, fmt.Errorf("attach engine command: %w", err)
	}
	defer attached.Close()
	// The attached stream does not follow the context on its own.
	stop := context.AfterFunc(ctx, func() { attached.Close() })
	defer stop()
	if stdin != "" {
		if _, err := io.WriteString(attached.Conn, stdin); err != nil {
			return nil, fmt.Errorf("send engine command input: %w", err)
		}
		if err := attached.CloseWrite(); err != nil {
			return nil, fmt.Errorf("close engine command input: %w", err)
		}
	}
	stdout := &engineOutput{limit: seaweedfsEngineOutputLimit}
	stderr := &engineOutput{limit: 64 * 1024, truncate: true}
	if _, err := stdcopy.StdCopy(stdout, stderr, attached.Reader); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("read engine command output: %w", err)
	}
	inspect, err := m.client.cli.ExecInspect(ctx, created.ID, mobyclient.ExecInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect engine command: %w", err)
	}
	if inspect.ExitCode != 0 {
		message := strings.TrimSpace(stderr.String())
		if len(message) > 512 {
			message = message[len(message)-512:]
		}
		return nil, fmt.Errorf("engine command exited with %d: %s", inspect.ExitCode, message)
	}
	return stdout.Bytes(), nil
}

// engineOutput collects command output up to a limit; past it, it either
// fails the copy or (truncate) drops the rest.
type engineOutput struct {
	bytes.Buffer
	limit    int
	truncate bool
}

func (o *engineOutput) Write(p []byte) (int, error) {
	if o.Len()+len(p) > o.limit {
		if !o.truncate {
			return 0, errors.New("engine command printed more than expected")
		}
		if room := o.limit - o.Len(); room > 0 {
			o.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return o.Buffer.Write(p)
}
