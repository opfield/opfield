package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
	"golang.org/x/sys/unix"

	"github.com/opfield/opfield/daemon-shared/atomicfile"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
)

const (
	managedVolumeStorageKindLabel = "net.opfield.managed-volume-storage-kind"
	managedVolumeCapacityLabel    = "net.opfield.managed-volume-capacity-bytes"
	volumeStorageKindRegular      = "regular"
	volumeStorageKindDiskImage    = "disk-image"
	minimumVolumeImageBytes       = int64(256 * 1024 * 1024)
	volumeImageReserveBytes       = int64(1024 * 1024 * 1024)
	volumeImageFstabPath          = "/etc/fstab"
)

type volumeImageRecord struct {
	Name          string `json:"name"`
	ImagePath     string `json:"imagePath"`
	MountPath     string `json:"mountPath"`
	LoopDevice    string `json:"loopDevice,omitempty"`
	CapacityBytes int64  `json:"capacityBytes"`
	// Deleting is set once the Docker volume is gone. Such an image is never
	// mounted again; the repair pass finishes a deletion that failed part-way.
	Deleting bool `json:"deleting,omitempty"`
}

type volumeMetrics struct {
	StorageKind            string `json:"storageKind"`
	UsedBytes              *int64 `json:"usedBytes"`
	CapacityBytes          *int64 `json:"capacityBytes"`
	AvailableBytes         *int64 `json:"availableBytes"`
	UsedInodes             *int64 `json:"usedInodes"`
	TotalInodes            *int64 `json:"totalInodes"`
	RunningAttachmentCount int64  `json:"runningAttachmentCount"`
	CollectedAt            string `json:"collectedAt"`
}

type volumeImageManager struct {
	client    *Client
	logger    *slog.Logger
	root      string
	supported bool
	mu        sync.Mutex
	// loops overrides the kernel loop-device surface (tests).
	loops *loopHost
}

func (m *volumeImageManager) loopHost() *loopHost {
	if m.loops != nil {
		return m.loops
	}
	return systemLoopHost
}

func newVolumeImageManager(stateDir string, dockerClient *Client, logger *slog.Logger) (*volumeImageManager, error) {
	root := filepath.Clean(filepath.Join(stateDir, "volume-images"))
	manager := &volumeImageManager{client: dockerClient, logger: logger, root: root}
	if !filepath.IsAbs(root) || root == "/" {
		return nil, errors.New("volume image root must be an absolute non-root path")
	}
	for _, dir := range []string{"images", "mounts", "records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, fmt.Errorf("create volume image directory: %w", err)
		}
	}
	manager.supported = manager.preflight()
	if manager.supported {
		manager.ensureVolumeImageBootUnit(stateDir)
		// Once the start is confirmed the pre-Opfield boot unit and fstab
		// entries are replaced (renamed_boot_units.go).
		lifecycle.OnStartConfirmed(func() {
			manager.ensureVolumeImageBootUnit(stateDir)
			manager.rewriteFstabEntries()
		})
		// Before remounting: leaked devices could leave none for live volumes.
		manager.repairLoopImages(context.Background())
		if err := manager.reconcile(context.Background()); err != nil {
			manager.supported = false
			logger.Warn("disk-image volume support disabled after reconciliation failure", "error", err)
		}
	}
	return manager, nil
}

func (m *volumeImageManager) preflight() bool {
	if runsWithoutRoot() {
		m.logger.Info("disk-image volume support unavailable: it needs docker-daemon to run as root", "user", runUserName())
		return false
	}
	for _, binary := range []string{"fallocate", "findmnt", "mkfs.ext4", "losetup", "mount", "umount", "mountpoint", "resize2fs"} {
		if _, err := exec.LookPath(binary); err != nil {
			m.logger.Warn("disk-image volume support unavailable", "missing", binary)
			return false
		}
	}
	if _, err := os.Stat("/dev/loop-control"); err != nil {
		m.logger.Warn("disk-image volume support unavailable", "error", err)
		return false
	}
	fstab, err := os.OpenFile(volumeImageFstabPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstab", err)
		return false
	}
	_ = fstab.Close()
	probePath := filepath.Join(filepath.Dir(volumeImageFstabPath), fmt.Sprintf(".opfield-volume-images-probe-%d", os.Getpid()))
	probe, err := os.OpenFile(probePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstabDirectory", err)
		return false
	}
	_ = probe.Close()
	if err := os.Remove(probePath); err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstabDirectory", err)
		return false
	}
	return true
}

func (m *volumeImageManager) recordKey(name string) string {
	sum := sha256.Sum256([]byte(name))
	return hex.EncodeToString(sum[:])
}

func (m *volumeImageManager) recordPath(name string) string {
	return filepath.Join(m.root, "records", m.recordKey(name)+".json")
}

func (m *volumeImageManager) newRecord(name string, capacity int64) volumeImageRecord {
	key := m.recordKey(name)
	return volumeImageRecord{
		Name:          name,
		ImagePath:     filepath.Join(m.root, "images", key+".img"),
		MountPath:     filepath.Join(m.root, "mounts", key),
		CapacityBytes: capacity,
	}
}

func (m *volumeImageManager) saveRecord(record volumeImageRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(m.recordPath(record.Name), data, 0600)
}

func (m *volumeImageManager) loadRecord(name string) (volumeImageRecord, error) {
	data, err := os.ReadFile(m.recordPath(name))
	if err != nil {
		return volumeImageRecord{}, err
	}
	var record volumeImageRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return volumeImageRecord{}, fmt.Errorf("parse volume image record: %w", err)
	}
	if record.Name != name || !pathWithin(m.root, record.ImagePath) || !pathWithin(m.root, record.MountPath) {
		return volumeImageRecord{}, errors.New("invalid volume image record")
	}
	return record, nil
}

// matchesVolumeRecord accepts only the bind definition owned by this manager.
// Labels alone cannot establish that an arbitrary host path is safe to attach.
func (m *volumeImageManager) matchesVolumeRecord(v volume.Volume) bool {
	if m == nil || v.Driver != "local" || v.Scope != "local" ||
		v.Labels[managedVolumeLabel] != "true" ||
		v.Labels[managedVolumeStorageKindLabel] != volumeStorageKindDiskImage {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(v.Name)
	return err == nil && len(v.Options) == 3 && v.Options["type"] == "none" &&
		v.Options["o"] == "bind" && v.Options["device"] == record.MountPath && volumeImageMounted(record)
}

func volumeImageMounted(record volumeImageRecord) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// --mountpoint requires this exact mount, unlike --target which can return
	// the parent host filesystem when the image has not been mounted.
	output, err := exec.CommandContext(ctx, "findmnt", "-n", "-o", "SOURCE", "--types", "ext4", "--mountpoint", record.MountPath).Output()
	if err != nil {
		return false
	}
	device := strings.TrimSpace(string(output))
	index, ok := strings.CutPrefix(device, "/dev/loop")
	if !ok || index == "" {
		return false
	}
	if _, err := strconv.ParseUint(index, 10, 32); err != nil {
		return false
	}
	// Resolve the live backing-file association; a persisted loop number can
	// belong to another image after reboot or detach/reattach.
	output, err = exec.CommandContext(ctx, "losetup", "--list", "--noheadings", "--output", "NAME", "--associated", record.ImagePath).Output()
	if err != nil {
		return false
	}
	for _, associated := range strings.Fields(string(output)) {
		if associated == device {
			return true
		}
	}
	return false
}

func pathWithin(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func (m *volumeImageManager) ensureCapacity(bytes int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(m.root, &stat); err != nil {
		return fmt.Errorf("stat volume image storage: %w", err)
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	if free < bytes || free-bytes < volumeImageReserveBytes {
		return errors.New("insufficient node storage capacity after reserve")
	}
	return nil
}

func (m *volumeImageManager) create(ctx context.Context, name string, capacity int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.supported {
		return errors.New("disk-image volumes are not supported on this node")
	}
	if capacity < minimumVolumeImageBytes {
		return fmt.Errorf("disk-image volume capacity must be at least %d bytes", minimumVolumeImageBytes)
	}
	if existing, err := m.loadRecord(name); err == nil {
		if !existing.Deleting {
			return fmt.Errorf("volume %q already exists", name)
		}
		// A deletion of this name that failed part-way: finish it first.
		if err := m.cleanupStorage(ctx, &existing, true); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("volume %q already exists", name)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check existing volume %q: %w", name, err)
	}
	if err := m.ensureCapacity(capacity); err != nil {
		return err
	}
	record := m.newRecord(name, capacity)
	// A renamed volume keeps the image and mount point named after its first
	// name, so a new volume of that name must not touch them.
	records, err := m.records()
	if err != nil {
		return err
	}
	for _, other := range records {
		if other.ImagePath == record.ImagePath || other.MountPath == record.MountPath {
			return fmt.Errorf("volume %q cannot be created while volume %q, first created under this name, exists", name, other.Name)
		}
	}
	// No record owns these paths, so anything there is left from a create
	// that failed before (or from an older release).
	if err := m.loopHost().release(ctx, record.ImagePath, record.MountPath); err != nil {
		return err
	}
	if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(record.MountPath, 0700); err != nil {
		return err
	}
	if err := createVolumeImage(ctx, record); err != nil {
		_ = m.loopHost().removeMountPoint(record.MountPath)
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			if err := m.cleanupStorage(cleanupCtx, &record, true); err != nil {
				m.logger.Warn("failed disk-image volume create left storage behind; the repair pass releases it", "volume", name, "error", err)
			}
		}
	}()
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save volume image record: %w", err)
	}
	if err := m.ensureFstabEntry(record); err != nil {
		return fmt.Errorf("persist volume image mount: %w", err)
	}
	if _, err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	// The application UID is unknown at creation time. Initialize only the new
	// filesystem root; remounts must preserve permissions chosen by its owner.
	if err := os.Chmod(record.MountPath, 0777); err != nil {
		return fmt.Errorf("initialize volume image root permissions: %w", err)
	}
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save mounted volume image record: %w", err)
	}
	labels := volumeImageLabels(capacity)
	created, err := m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name:       name,
		Driver:     "local",
		Labels:     labels,
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	})
	if err != nil {
		return fmt.Errorf("create disk-image Docker volume: %w", err)
	}
	if created.Volume.Labels[managedVolumeStorageKindLabel] != volumeStorageKindDiskImage {
		return fmt.Errorf("volume %q appeared concurrently and was left unchanged", name)
	}
	cleanup = false
	return nil
}

func volumeImageLabels(capacity int64) map[string]string {
	return map[string]string{
		managedVolumeLabel:            "true",
		managedVolumeOriginLabel:      "created",
		managedVolumeStorageKindLabel: volumeStorageKindDiskImage,
		managedVolumeCapacityLabel:    fmt.Sprintf("%d", capacity),
	}
}

// createVolumeImage removes its own partial image on failure, and only that.
func createVolumeImage(ctx context.Context, record volumeImageRecord) (err error) {
	file, err := os.OpenFile(record.ImagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("create volume storage image: %w", err)
	}
	_ = file.Close()
	defer func() {
		if err != nil {
			_ = os.Remove(record.ImagePath)
		}
	}()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", record.CapacityBytes), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("preallocate volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("format volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// ensureMounted mounts the record's image, replacing the read-only placeholder
// the boot step leaves at the mount point of an image it could not mount. It
// reports whether the image was not mounted before: the volume's running
// containers then sit on the placeholder or on the bare mount point.
func (m *volumeImageManager) ensureMounted(ctx context.Context, record *volumeImageRecord) (bool, error) {
	if record.Deleting {
		return false, errors.New("disk-image volume is being deleted")
	}
	h := m.loopHost()
	path := canonicalLoopPath(record.MountPath)
	placeholder, err := h.isPlaceholder(path)
	if err != nil {
		return false, err
	}
	if placeholder {
		if err := h.unmountAll(ctx, path, loopReleaseAttempts); err != nil {
			return false, fmt.Errorf("remove the read-only placeholder of %s: %w", record.MountPath, err)
		}
	}
	mounted, err := h.isMounted(path)
	if err != nil {
		return false, err
	}
	loopDevice, err := h.mountImage(ctx, record.ImagePath, record.MountPath, volumeImageMountOptions)
	if err == nil && loopDevice == "" {
		err = fmt.Errorf("%s is mounted, but not from a loop device", record.MountPath)
	}
	if err != nil {
		if placeholder {
			// Keep containers off the bare mount point until the next attempt.
			if guardErr := h.placeholder(ctx, record.MountPath); guardErr != nil {
				m.logger.Error("read-only placeholder of a disk-image volume could not be put back", "volume", record.Name, "error", guardErr)
			}
		}
		return false, fmt.Errorf("mount volume storage image: %w", err)
	}
	record.LoopDevice = loopDevice
	return !mounted, nil
}

// mountVolume makes a live volume's image mounted. When that replaces the
// placeholder or the bare mount point, the volume's running containers are
// restarted onto the image. An image that cannot be mounted gets the
// read-only placeholder, and the next repair pass tries again.
func (m *volumeImageManager) mountVolume(ctx context.Context, record *volumeImageRecord) {
	previous := record.LoopDevice
	late, err := m.ensureMounted(ctx, record)
	if err != nil {
		m.logger.Warn("disk-image volume image could not be mounted; its mount point stays read-only", "volume", record.Name, "error", err)
		path := canonicalLoopPath(record.MountPath)
		if mounted, mountErr := m.loopHost().isMounted(path); mountErr == nil && !mounted {
			if guardErr := m.guardMountPoint(ctx, record.MountPath); guardErr != nil {
				m.logger.Error("read-only placeholder of a disk-image volume could not be mounted", "volume", record.Name, "error", guardErr)
			}
		}
		return
	}
	if late {
		m.logger.Warn("disk-image volume image was not mounted at boot; mounted it now", "volume", record.Name)
		m.restartVolumeUsers(ctx, record.Name)
	}
	if late || record.LoopDevice != previous {
		if err := m.saveRecord(*record); err != nil {
			m.logger.Warn("disk-image volume record could not be saved", "volume", record.Name, "error", err)
		}
	}
}

func (m *volumeImageManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.root, "records", entry.Name()))
		if err != nil {
			return err
		}
		var record volumeImageRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return err
		}
		if entry.Name() != filepath.Base(m.recordPath(record.Name)) ||
			!pathWithin(m.root, record.ImagePath) ||
			!pathWithin(m.root, record.MountPath) {
			return fmt.Errorf("invalid disk-image volume record %q", entry.Name())
		}
		if record.Deleting {
			continue
		}
		if err := m.ensureFstabEntry(record); err != nil {
			return fmt.Errorf("persist disk-image volume %q mount: %w", record.Name, err)
		}
		// One volume that cannot be mounted keeps its placeholder; it does not
		// take the others down.
		m.mountVolume(ctx, &record)
	}
	return nil
}

// restartVolumeUsers moves the running containers of a volume whose image was
// mounted late onto the image. Docker binds a local volume once for all its
// containers and keeps that bind (of the placeholder or the bare directory)
// while any of them runs, so all of them stop before any starts again.
func (m *volumeImageManager) restartVolumeUsers(ctx context.Context, name string) {
	containers, err := m.client.cli.ContainerList(ctx, client.ContainerListOptions{Filters: client.Filters{}.Add("volume", name)})
	if err != nil {
		m.logger.Warn("containers of a disk-image volume mounted late could not be listed", "volume", name, "error", err)
		return
	}
	var stopped []string
	for _, item := range containers.Items {
		if err := m.client.StopContainer(ctx, item.ID, 30); err != nil {
			m.logger.Warn("container of a disk-image volume mounted late could not be stopped", "volume", name, "container", item.ID, "error", err)
			continue
		}
		stopped = append(stopped, item.ID)
	}
	for _, id := range stopped {
		m.logger.Warn("restarting a container that ran before its disk-image volume was mounted", "volume", name, "container", id)
		if err := m.client.StartContainer(ctx, id); err != nil {
			m.logger.Warn("container of a disk-image volume mounted late could not be started", "volume", name, "container", id, "error", err)
		}
	}
}

func (m *volumeImageManager) resize(ctx context.Context, name string, target int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return fmt.Errorf("load disk-image volume: %w", err)
	}
	if target <= record.CapacityBytes {
		return errors.New("disk-image volume capacity can only be increased")
	}
	if err := m.ensureCapacity(target - record.CapacityBytes); err != nil {
		return err
	}
	if _, err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", target), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("grow volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := refreshDatabaseLoopDeviceCapacity(ctx, record.LoopDevice); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "resize2fs", record.LoopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("grow volume filesystem: %w: %s", err, strings.TrimSpace(string(output)))
	}
	record.CapacityBytes = target
	if err := m.saveRecord(record); err != nil {
		return err
	}
	return nil
}

func (m *volumeImageManager) recreateDefinition(ctx context.Context, record volumeImageRecord, labels map[string]string) error {
	inspected, err := m.client.cli.VolumeInspect(ctx, record.Name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect disk-image volume: %w", err)
	}
	originalLabels := maps.Clone(inspected.Volume.Labels)
	if labels == nil {
		labels = maps.Clone(originalLabels)
	}
	labels[managedVolumeLabel] = "true"
	labels[managedVolumeOriginLabel] = "created"
	labels[managedVolumeStorageKindLabel] = volumeStorageKindDiskImage
	labels[managedVolumeCapacityLabel] = fmt.Sprintf("%d", record.CapacityBytes)
	if _, err := m.client.cli.VolumeRemove(ctx, record.Name, client.VolumeRemoveOptions{}); err != nil {
		return fmt.Errorf("remove disk-image volume definition: %w", err)
	}
	_, err = m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name: record.Name, Driver: "local", Labels: labels,
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	})
	if err != nil {
		_, restoreErr := m.client.cli.VolumeCreate(context.Background(), client.VolumeCreateOptions{
			Name: record.Name, Driver: "local", Labels: originalLabels,
			DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
		})
		if restoreErr != nil {
			return fmt.Errorf("update disk-image volume definition: %w; restore failed: %v", err, restoreErr)
		}
		return fmt.Errorf("update disk-image volume definition: %w", err)
	}
	return nil
}

func (m *volumeImageManager) rename(ctx context.Context, name string, newName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if used, err := m.client.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot be renamed", name)
	}
	if _, err := m.client.cli.VolumeInspect(ctx, newName, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("target volume %q already exists", newName)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check target volume %q: %w", newName, err)
	}
	source, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect disk-image volume: %w", err)
	}
	if _, err := m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name: newName, Driver: "local", Labels: maps.Clone(source.Volume.Labels),
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	}); err != nil {
		return fmt.Errorf("create renamed disk-image volume: %w", err)
	}
	if _, err := m.client.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil {
		_, _ = m.client.cli.VolumeRemove(context.Background(), newName, client.VolumeRemoveOptions{Force: true})
		return fmt.Errorf("remove old disk-image volume definition: %w", err)
	}
	oldRecordPath := m.recordPath(name)
	record.Name = newName
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save renamed disk-image volume record: %w", err)
	}
	if err := os.Remove(oldRecordPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (m *volumeImageManager) updateLabels(ctx context.Context, name string, labels map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if used, err := m.client.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot update labels", name)
	}
	current, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return err
	}
	next := maps.Clone(labels)
	if next == nil {
		next = map[string]string{}
	}
	for _, key := range []string{managedVolumeLabel, managedVolumeOriginLabel, managedVolumeStorageKindLabel, managedVolumeCapacityLabel} {
		if supplied, ok := next[key]; ok && supplied != current.Volume.Labels[key] {
			return fmt.Errorf("label %q is reserved for Opfield-managed volumes", key)
		}
		next[key] = current.Volume.Labels[key]
	}
	return m.recreateDefinition(ctx, record, next)
}

func (m *volumeImageManager) remove(ctx context.Context, name string, force bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if _, err := m.client.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: force}); err != nil && !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("volume remove: %w", err)
	}
	return m.cleanupStorage(ctx, &record, true)
}

// cleanupStorage releases a volume image in a fixed order: mount, then loop
// device (waiting until the kernel has let go of it), then, with removeImage,
// the image and record. A removal is marked Deleting and its fstab entry goes
// first, so a failure part-way never brings the image back at the next boot
// or start and the repair pass completes it.
func (m *volumeImageManager) cleanupStorage(ctx context.Context, record *volumeImageRecord, removeImage bool) error {
	if removeImage {
		if !record.Deleting {
			record.Deleting = true
			// Best effort: a create that failed before its first save has no
			// record, and its leftovers are orphans for the repair pass anyway.
			_ = m.saveRecord(*record)
		}
		if err := m.removeFstabEntry(*record); err != nil {
			return fmt.Errorf("remove volume image mount persistence: %w", err)
		}
	}
	if err := m.loopHost().release(ctx, record.ImagePath, record.MountPath); err != nil {
		return fmt.Errorf("release volume storage image: %w", err)
	}
	record.LoopDevice = ""
	if removeImage {
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := m.loopHost().removeMountPoint(record.MountPath); err != nil {
			return err
		}
		if err := os.Remove(m.recordPath(record.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// repairLoopImages finishes deletions that could not complete and releases
// mounts, loop devices and image files no disk-image volume owns. It runs at
// start and periodically; see loopHost.repair for what is never touched.
func (m *volumeImageManager) repairLoopImages(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.supported {
		return
	}
	records, err := m.records()
	if err != nil {
		m.logger.Warn("disk-image volume storage repair skipped", "error", err)
		return
	}
	imageDir, mountDir := filepath.Join(m.root, "images"), filepath.Join(m.root, "mounts")
	images, mounts := map[string]bool{}, map[string]bool{}
	for _, record := range records {
		if filepath.Dir(record.ImagePath) != imageDir || filepath.Dir(record.MountPath) != mountDir {
			m.logger.Warn("disk-image volume storage repair skipped: a record names storage outside its directories", "volume", record.Name)
			return
		}
	}
	for _, record := range records {
		if record.Deleting {
			if err := m.cleanupStorage(ctx, &record, true); err != nil {
				m.logger.Warn("disk-image volume deletion could not be finished yet", "volume", record.Name, "error", err)
			} else {
				m.logger.Info("finished interrupted disk-image volume deletion", "volume", record.Name)
				continue
			}
		}
		// A renamed volume keeps the image named after its first name.
		images[filepath.Base(record.ImagePath)] = true
		mounts[filepath.Base(record.MountPath)] = true
	}
	m.loopHost().repair(ctx, loopImageDomain{
		label:      "disk-image volume",
		imageDir:   imageDir,
		mountDir:   mountDir,
		mountRoot:  mountDir,
		imageInUse: func(name string, _ bool) bool { return images[name] },
		imageKept:  func(name string) bool { return images[name] },
		mountInUse: func(name string) bool { return mounts[name] },
		orphanImage: func(name string) bool {
			key, ok := strings.CutSuffix(name, ".img")
			if !ok || len(key) != sha256.Size*2 {
				return false
			}
			_, err := hex.DecodeString(key)
			return err == nil
		},
	}, m.logger)
	// A volume whose image could not be mounted at boot (or since) gets it as
	// soon as it can be mounted.
	for _, record := range records {
		if !record.Deleting && images[filepath.Base(record.ImagePath)] {
			m.mountVolume(ctx, &record)
		}
	}
}

// records reads every volume image record; any unreadable record fails the
// whole read, so that no storage is repaired without knowing every owner.
func (m *volumeImageManager) records() ([]volumeImageRecord, error) {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if err != nil {
		return nil, err
	}
	var records []volumeImageRecord
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.root, "records", entry.Name()))
		if err != nil {
			return nil, err
		}
		var record volumeImageRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, fmt.Errorf("parse volume image record %q: %w", entry.Name(), err)
		}
		if entry.Name() != filepath.Base(m.recordPath(record.Name)) {
			return nil, fmt.Errorf("invalid disk-image volume record %q", entry.Name())
		}
		records = append(records, record)
	}
	return records, nil
}

func volumeImageFstabMarker(record volumeImageRecord) string {
	return "# opfield-volume-image " + filepath.Base(record.ImagePath)
}

// legacyVolumeImageFstabMarker marks the entries pre-Opfield daemons wrote.
// Until this start is confirmed such an entry is kept as it is (a daemon the
// launcher rolls back to knows only it); afterwards it is rewritten.
// legacy-name: legacy volume image fstab entries — remove once every node reports none
func legacyVolumeImageFstabMarker(record volumeImageRecord) string {
	return "# gateway-volume-image " + filepath.Base(record.ImagePath)
}

func legacyVolumeImageFstabEntryLine(record volumeImageRecord) string {
	return strings.Replace(volumeImageFstabEntryLine(record), "x-systemd.before="+volumeImageBootService+".service",
		"x-systemd.before="+legacyVolumeImageBootService+".service", 1)
}

func escapeFstabPath(value string) string {
	replacer := strings.NewReplacer("\\", `\134`, " ", `\040`, "\t", `\011`, "\n", `\012`)
	return replacer.Replace(value)
}

// volumeImageFstabEntryLine mounts the image at boot before Docker starts:
// nofail keeps a failed mount from blocking the boot but also drops the
// implicit ordering before local-fs.target, so the ordering is explicit. The
// boot step (see MountVolumeImagesAtBoot) runs after these mounts and guards
// the mount point of any that failed.
func volumeImageFstabEntryLine(record volumeImageRecord) string {
	return fmt.Sprintf(
		"%s %s ext4 loop,noatime,nodev,nosuid,nofail,x-systemd.before="+volumeImageBootService+".service,x-systemd.before=docker.service 0 0",
		escapeFstabPath(record.ImagePath),
		escapeFstabPath(record.MountPath),
	)
}

// withoutFstabEntry drops a record's entry, in the current or an older format.
func withoutFstabEntry(data string, record volumeImageRecord) string {
	marker, legacy := volumeImageFstabMarker(record), legacyVolumeImageFstabMarker(record)
	image := escapeFstabPath(record.ImagePath) + " "
	lines := strings.Split(data, "\n")
	filtered := make([]string, 0, len(lines))
	for index := 0; index < len(lines); index++ {
		if lines[index] == marker || lines[index] == legacy {
			if index+1 < len(lines) && strings.HasPrefix(lines[index+1], image) {
				index++
			}
			continue
		}
		filtered = append(filtered, lines[index])
	}
	return strings.Join(filtered, "\n")
}

// withFstabEntry returns data with exactly one, current entry for record.
// keepLegacy accepts the entry of a pre-Opfield daemon as current.
func withFstabEntry(data string, record volumeImageRecord, keepLegacy bool) string {
	marker := volumeImageFstabMarker(record)
	entry := marker + "\n" + volumeImageFstabEntryLine(record) + "\n"
	legacyMarker := legacyVolumeImageFstabMarker(record)
	if strings.Count(data, marker+"\n")+strings.Count(data, legacyMarker+"\n") == 1 {
		if strings.Contains(data, entry) {
			return data
		}
		if keepLegacy && strings.Contains(data, legacyMarker+"\n"+legacyVolumeImageFstabEntryLine(record)+"\n") {
			return data
		}
	}
	next := withoutFstabEntry(data, record)
	if next != "" && !strings.HasSuffix(next, "\n") {
		next += "\n"
	}
	return next + entry
}

// ensureFstabEntry also rewrites an entry an older release wrote.
func (m *volumeImageManager) ensureFstabEntry(record volumeImageRecord) error {
	data, err := os.ReadFile(volumeImageFstabPath)
	if err != nil {
		return err
	}
	next := withFstabEntry(string(data), record, !lifecycle.StartConfirmed())
	if next == string(data) {
		return nil
	}
	return replaceFstab([]byte(next))
}

// rewriteFstabEntries turns the fstab entries of pre-Opfield daemons into
// current ones (on a confirmed start).
func (m *volumeImageManager) rewriteFstabEntries() {
	m.mu.Lock()
	defer m.mu.Unlock()
	records, err := m.records()
	if err != nil {
		m.logger.Warn("disk-image volume fstab entries keep their pre-Opfield form", "error", err)
		return
	}
	for _, record := range records {
		if record.Deleting {
			continue
		}
		if err := m.ensureFstabEntry(record); err != nil {
			m.logger.Warn("disk-image volume fstab entry keeps its pre-Opfield form", "volume", record.Name, "error", err)
		}
	}
}

// legacyFstabEntries counts the fstab entries still in their pre-Opfield form.
func (m *volumeImageManager) legacyFstabEntries() uint32 {
	data, err := os.ReadFile(volumeImageFstabPath)
	if err != nil {
		return 0
	}
	var count uint32
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "# gateway-volume-image ") {
			count++
		}
	}
	return count
}

func (m *volumeImageManager) removeFstabEntry(record volumeImageRecord) error {
	data, err := os.ReadFile(volumeImageFstabPath)
	if err != nil {
		return err
	}
	return replaceFstab([]byte(withoutFstabEntry(string(data), record)))
}

func replaceFstab(data []byte) error {
	info, err := os.Stat(volumeImageFstabPath)
	if err != nil {
		return err
	}
	// The host's fstab: a partial file after a crash would break the next boot.
	return atomicfile.WriteFile(volumeImageFstabPath, data, info.Mode().Perm())
}

func (m *volumeImageManager) metrics(ctx context.Context, name string) (volumeMetrics, error) {
	attachments, err := m.client.runningVolumeAttachments(ctx, name)
	if err != nil {
		return volumeMetrics{}, err
	}
	result := volumeMetrics{StorageKind: volumeStorageKindRegular, RunningAttachmentCount: attachments, CollectedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	record, err := m.loadRecord(name)
	if errors.Is(err, os.ErrNotExist) {
		used, usageErr := m.client.volumeDiskUsage(ctx, name)
		if usageErr == nil && used >= 0 {
			result.UsedBytes = &used
		}
		return result, nil
	}
	if err != nil {
		return volumeMetrics{}, err
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(record.MountPath, &stat); err != nil {
		return volumeMetrics{}, fmt.Errorf("stat disk-image volume: %w", err)
	}
	capacity := int64(stat.Blocks) * int64(stat.Bsize)
	available := int64(stat.Bavail) * int64(stat.Bsize)
	used := capacity - int64(stat.Bfree)*int64(stat.Bsize)
	totalInodes := int64(stat.Files)
	usedInodes := totalInodes - int64(stat.Ffree)
	result.StorageKind = volumeStorageKindDiskImage
	result.UsedBytes = &used
	result.CapacityBytes = &capacity
	result.AvailableBytes = &available
	result.UsedInodes = &usedInodes
	result.TotalInodes = &totalInodes
	return result, nil
}
