package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/atomicfile"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"golang.org/x/sys/unix"
)

const managedStorageRootFilesystem = "gateway-managed-storage-root"

type managedStorageManager struct {
	client *Client
	// plugin reaches the availability member runtime and mesh of SeaweedFS
	// set members (managed_storage_set.go); nil in tests.
	plugin *DockerPlugin
	// setImages are the images the SeaweedFS set members' containers run
	// (their member report's imageMove).
	setImages seaweedfsSetImages
	// dialTargets answers relay dials while dockerd does not (B-26).
	dialTargets    dialTargetLookups
	logger         *slog.Logger
	root           string
	reserve        int64
	statFilesystem func(string, *unix.Statfs_t) error
	// chown overrides runtime-user ownership changes (tests run unprivileged).
	chown func(string, int, int) error
	// probeServed overrides the served-certificate probe (tests).
	probeServed func(ctx context.Context, address, protocol string) (servedCertificate, error)
	mu          sync.Mutex
	// generations and tlsReloads let a certificate reload wait without mu
	// (see handleTLSReload); generations is guarded by mu.
	generations lifecycleGenerations
	tlsReloads  resourceLocks
	// loops overrides the kernel loop-device surface (tests).
	loops *loopHost
	// engineRuns holds what the daemon saw of each engine container since it
	// last started it (see engineRun): an engine an operator stopped is
	// starting while the supervisor brings it back, and one that keeps
	// crashing is down, although its container runs most of the time.
	engineRunsMu sync.Mutex
	engineRuns   map[string]engineRun
	// probeReady overrides the engine readiness check (tests).
	probeReady func(ctx context.Context, record managedStorageRecord) error
	// runHostCommand overrides the host tools a disk grow runs (tests).
	runHostCommand func(ctx context.Context, name string, args ...string) ([]byte, error)
	// execEngine overrides commands run in an engine container (tests).
	execEngine func(ctx context.Context, containerID string, command []string, stdin string) ([]byte, error)
	// runFsck overrides e2fsck (tests).
	runFsck func(ctx context.Context, image string) (int, string, error)
	// repairs are the disk repairs running now; incidents the engine stops
	// nobody asked for.
	repairs   diskRepairs
	incidents *engineIncidents
	// oomRecreated holds the engine containers the supervisor tried to
	// recreate once after an out-of-memory kill.
	oomRecreated sync.Map
	// capacity is whether each SeaweedFS storage takes writes
	// (managed_storage_capacity.go).
	capacity seaweedfsCapacityTracker
}

func (m *managedStorageManager) loopHost() *loopHost {
	if m.loops != nil {
		return m.loops
	}
	return systemLoopHost
}

// stageTLS writes the legacy MinIO certs directory. Every file is replaced
// through a temporary file and a rename: MinIO rereads the directory on
// SIGHUP, and an in-place truncate could expose a half-written key.
func (m *managedStorageManager) stageTLS(record managedStorageRecord, tlsConfig managedStorageTLS) (string, error) {
	directory := filepath.Join(m.root, "storage", "tls", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex))
	if err := os.MkdirAll(filepath.Join(directory, "CAs"), 0700); err != nil {
		return "", err
	}
	for _, file := range []struct{ name, content string }{
		{"CAs/gateway-ca.crt", tlsConfig.CAPEM},
		{"private.key", tlsConfig.KeyPEM},
		{"public.crt", tlsConfig.CertPEM},
	} {
		if err := writeFileAtomically(filepath.Join(directory, file.name), []byte(file.content), 0600, nil); err != nil {
			return "", fmt.Errorf("stage managed storage TLS %s: %w", file.name, err)
		}
	}
	return directory, nil
}

func (m *managedStorageManager) stageSFTPHostKey(record managedStorageRecord, hostKeyPEM string) (string, error) {
	directory := filepath.Join(m.root, "storage", "sftp", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "host-key")
	if err := atomicfile.WriteFile(path, []byte(hostKeyPEM), 0600); err != nil {
		return "", fmt.Errorf("stage managed storage SFTP host key: %w", err)
	}
	return path, nil
}

// reserveCapacity holds bytes more of the node's disk for a create or a grow
// of a storage image, counted against the full sizes of every image already
// there (see managedDiskReservations); release once the image has its size.
func (m *managedStorageManager) reserveCapacity(bytes int64) (func(), error) {
	return managedDiskCapacity.reserve(m.root, bytes, m.reserve, m.statFilesystem, "insufficient managed storage capacity after reserve")
}

func (m *managedStorageManager) filesystemStats(path string, stat *unix.Statfs_t) error {
	if m.statFilesystem != nil {
		return m.statFilesystem(path, stat)
	}
	return unix.Statfs(path, stat)
}

func (m *managedStorageManager) storageRootHealthMount() (*pb.DiskMount, error) {
	usage, err := managedDiskCapacity.usage(m.root, m.statFilesystem)
	if err != nil {
		return nil, fmt.Errorf("stat managed storage root for health: %w", err)
	}
	total := usage.Total
	// The wizard must not advertise bytes reserved for recovery and other
	// storage-manager work, nor space the existing images may still take as
	// they fill up. This marker is explicitly allocatable capacity; managed
	// workload mounts below remain raw ext4 filesystem metrics.
	allocatable := max(int64(0), usage.Available(m.reserve))
	used := total - allocatable
	usagePercent := 0.0
	if total > 0 {
		usagePercent = float64(used) / float64(total) * 100
	}
	return &pb.DiskMount{
		MountPoint:   m.root,
		Filesystem:   managedStorageRootFilesystem,
		TotalBytes:   total,
		UsedBytes:    used,
		FreeBytes:    allocatable,
		UsagePercent: usagePercent,
	}, nil
}

// createImage removes its own partial image on failure; a leftover would make
// every retry of the create fail on the existing file.
func (m *managedStorageManager) createImage(ctx context.Context, record managedStorageRecord) (err error) {
	file, err := os.OpenFile(record.ImagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("create managed storage image: %w", err)
	}
	defer file.Close()
	defer func() {
		if err != nil {
			_ = os.Remove(record.ImagePath)
		}
	}()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", record.StorageBytes), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("preallocate managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync managed storage image: %w", err)
	}
	args := []string{"-q", "-F"}
	if record.engine() == managedStorageEngineSeaweedFS {
		// SeaweedFS runs unprivileged, so root-reserved blocks would only be
		// unusable space; its own minFreeSpace guard keeps metadata headroom.
		args = append(args, "-m", "0")
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", append(args, record.ImagePath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("format managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *managedStorageManager) ensureMounted(ctx context.Context, record *managedStorageRecord) error {
	if record.Removed {
		return errors.New("managed storage was removed")
	}
	loop, err := m.loopHost().mountImage(ctx, record.ImagePath, record.MountPath, "noatime")
	if err != nil {
		return fmt.Errorf("mount managed storage image: %w", err)
	}
	if loop != "" {
		record.LoopDevice = loop
	}
	return nil
}

// ensureStorageSize grows the image, the loop device and the filesystem to
// target. The record keeps the size last applied in full (the caller stores
// target only after this succeeds), so a grow that failed after the image was
// extended is finished by the next grow to at least that size.
func (m *managedStorageManager) ensureStorageSize(ctx context.Context, record *managedStorageRecord, target int64) error {
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	info, err := os.Stat(record.ImagePath)
	if err != nil {
		return err
	}
	if target < info.Size() {
		if info.Size() > record.StorageBytes {
			return fmt.Errorf("managed storage cannot be reduced: an earlier grow that did not finish left its disk image at %d bytes; grow it to at least that size", info.Size())
		}
		return errors.New("managed storage cannot be reduced")
	}
	if target == info.Size() && target <= record.StorageBytes {
		return nil
	}
	if target > info.Size() {
		release, err := m.reserveCapacity(target - info.Size())
		if err != nil {
			return err
		}
		defer release()
		if output, err := m.hostCommand(ctx, "fallocate", "-l", fmt.Sprintf("%d", target), record.ImagePath); err != nil {
			return fmt.Errorf("grow managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if output, err := m.hostCommand(ctx, "losetup", "-c", record.LoopDevice); err != nil {
		return fmt.Errorf("refresh managed storage loop device: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := m.hostCommand(ctx, "resize2fs", record.LoopDevice); err != nil {
		return fmt.Errorf("resize managed storage filesystem: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// hostCommand runs a host tool (fallocate, losetup, resize2fs) and returns
// what it printed.
func (m *managedStorageManager) hostCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	if m.runHostCommand != nil {
		return m.runHostCommand(ctx, name, args...)
	}
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (m *managedStorageManager) startContainer(ctx context.Context, id string) error {
	// An engine started on purpose is starting, whatever it did before.
	m.forgetEngineRun(id)
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return err
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		return nil
	}
	if _, err := m.client.cli.ContainerStart(ctx, id, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed storage container: %w", err)
	}
	return nil
}

func (m *managedStorageManager) createNetwork(ctx context.Context, record managedStorageRecord) error {
	_, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	if err == nil {
		return nil
	}
	_, err = m.client.cli.NetworkCreate(ctx, record.NetworkName, mobyclient.NetworkCreateOptions{Driver: "bridge", Internal: !record.PublishS3 && record.PeerBindAddress == "", Labels: map[string]string{managedStorageLabel: record.ID}})
	if err != nil {
		return fmt.Errorf("create managed storage network: %w", err)
	}
	return nil
}

// remove takes a member down in a fixed order and answers only once the
// storage is released: container, then mount, then loop device (waiting until
// the kernel has let go of it), then, with deleteData, the image and record.
// The record is marked first, so a removal that fails part-way is never
// mounted again and is completed by a repeated command or the repair pass.
func (m *managedStorageManager) remove(ctx context.Context, record *managedStorageRecord, deleteData bool) error {
	record.DesiredRunning = false
	record.Removed = true
	record.DeleteData = record.DeleteData || deleteData
	if err := m.saveRecord(*record); err != nil {
		return err
	}
	if record.ContainerID != "" {
		if err := m.client.RemoveContainer(ctx, record.ContainerID, true); err != nil && !isNotFoundErr(err) {
			return err
		}
		// A recreation the daemon could not finish (it restarted while the
		// new container was starting) leaves a second container of the member.
		if err := m.removeMemberContainers(ctx, *record); err != nil {
			return err
		}
	}
	if record.NetworkName != "" {
		_, _ = m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{})
	}
	record.ContainerID = ""
	// A removed workload cannot be started again, so staged secrets (root
	// identity, TLS keys, SFTP host key) have no further use.
	if record.engine() == managedStorageEngineSeaweedFS {
		if err := m.removeSeaweedFSStaging(*record); err != nil {
			return err
		}
	}
	if record.DeleteData {
		for _, directory := range []string{"tls", "sftp"} {
			_ = os.RemoveAll(filepath.Join(m.root, "storage", directory, fmt.Sprintf("%s-%d", record.ID, record.MemberIndex)))
		}
		return m.cleanupStorage(ctx, record, true)
	}
	// The data stays on disk; the mount and loop device of a removed workload
	// would only hold a device from the node's pool.
	if err := m.cleanupStorage(ctx, record, false); err != nil {
		return err
	}
	if err := m.loopHost().removeMountPoint(record.MountPath); err != nil {
		return err
	}
	return m.saveRecord(*record)
}

func (m *managedStorageManager) cleanupStorage(ctx context.Context, record *managedStorageRecord, removeImage bool) error {
	if err := m.loopHost().release(ctx, record.ImagePath, record.MountPath); err != nil {
		return fmt.Errorf("release managed storage image: %w", err)
	}
	record.LoopDevice = ""
	if removeImage {
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := m.loopHost().removeMountPoint(record.MountPath); err != nil {
			return err
		}
		if err := os.Remove(m.recordPath(record.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// repairLoopImages finishes removals that could not complete and releases
// mounts, loop devices and image files no managed storage member owns; a
// removed member keeps its image but not its mount or loop device. It runs at
// start and periodically; see loopHost.repair for what is never touched. A
// record that cannot be read keeps everything named after its id (images,
// mount points, loop devices, container) and is reported; the rest is
// repaired as usual.
func (m *managedStorageManager) repairLoopImages(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	records, unreadable, err := m.records()
	if err != nil {
		m.logger.Warn("managed storage repair skipped", "error", err)
		return
	}
	for _, record := range records {
		if !record.Removed || !record.DeleteData {
			continue
		}
		if err := m.remove(ctx, &record, true); err != nil {
			m.logger.Warn("managed storage deletion could not be finished yet", "id", record.ID, "error", err)
			continue
		}
		m.logger.Info("finished interrupted managed storage deletion", "id", record.ID)
	}
	for _, bad := range unreadable {
		m.logger.Warn("managed storage record cannot be read; its storage and container are left alone until it is repaired or removed by hand",
			"id", bad.ID, "path", bad.Path, "error", bad.Err)
	}
	if records, unreadable, err = m.records(); err != nil {
		return
	}
	imageDir := filepath.Join(m.root, "storage", "images")
	mountDir := filepath.Join(m.root, "storage", "mounts")
	inUseImages, keptImages, inUseMounts := map[string]bool{}, map[string]bool{}, map[string]bool{}
	protected := map[string]bool{}
	for _, bad := range unreadable {
		protected[bad.ID] = true
	}
	// A member whose container outlived its record keeps its image: the image
	// holds the data a retried create takes over (see adoptLostRecord).
	labelled, err := m.labelledStorageIDs(ctx)
	if err != nil {
		m.logger.Warn("managed storage repair skipped: its containers could not be listed", "error", err)
		return
	}
	for id := range labelled {
		protected[id] = true
	}
	for _, record := range records {
		if filepath.Dir(record.ImagePath) != imageDir || filepath.Dir(record.MountPath) != mountDir {
			m.logger.Warn("managed storage record names storage outside its directories; everything of its id is left alone", "id", record.ID)
			protected[record.ID] = true
			continue
		}
		keptImages[filepath.Base(record.ImagePath)] = true
		if !record.Removed {
			inUseImages[filepath.Base(record.ImagePath)] = true
			inUseMounts[filepath.Base(record.MountPath)] = true
		}
	}
	// Member images and mount points are named <id>-<member index>.
	ofProtected := func(name string) bool {
		id, _, ok := cutStorageMemberName(strings.TrimSuffix(name, ".img"))
		return ok && protected[id]
	}
	m.loopHost().repair(ctx, loopImageDomain{
		label:      "managed storage",
		imageDir:   imageDir,
		mountDir:   mountDir,
		mountRoot:  mountDir,
		imageInUse: func(name string, _ bool) bool { return inUseImages[name] || ofProtected(name) },
		imageKept:  func(name string) bool { return keptImages[name] || ofProtected(name) },
		mountInUse: func(name string) bool { return inUseMounts[name] || ofProtected(name) },
		orphanImage: func(name string) bool {
			base, ok := strings.CutSuffix(name, ".img")
			id, _, member := cutStorageMemberName(base)
			return ok && member && managedStorageIDPattern.MatchString(id)
		},
	}, m.logger)
}

// cutStorageMemberName splits "<id>-<member index>".
func cutStorageMemberName(name string) (string, uint64, bool) {
	index := strings.LastIndex(name, "-")
	if index < 0 {
		return "", 0, false
	}
	member, err := strconv.ParseUint(name[index+1:], 10, 16)
	return name[:index], member, err == nil
}

// records reads every managed storage record and lists the record files that
// cannot be read.
func (m *managedStorageManager) records() (records []managedStorageRecord, unreadable []unreadableRecord, err error) {
	dir := filepath.Join(m.root, "storage", "records")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		record, err := m.loadRecord(id)
		if err != nil {
			unreadable = append(unreadable, unreadableRecord{ID: id, Path: filepath.Join(dir, entry.Name()), Err: err})
			continue
		}
		records = append(records, record)
	}
	return records, unreadable, nil
}

// reconcile runs in every new daemon process (a cold start and the process an
// update hands over to alike) before it serves Gateway. The SeaweedFS
// storages it brings up are then moved to the image this daemon pins, in the
// background (see moveStoragesToPinnedImage).
func (m *managedStorageManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "storage", "records"))
	if err != nil {
		return err
	}
	var started []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		// One broken storage (container removed, volume missing, unreadable record) must not keep the whole node
		// offline: the node comes up with the others, and Gateway sees this one as not running and can repair it.
		record, err := m.loadRecord(id)
		if err != nil {
			m.logger.Warn("managed storage record could not be read at startup", "id", id, "path", m.recordPath(id), "error", err)
			continue
		}
		if record.ContainerID != "" {
			if err := ensureEngineRestartPolicy(ctx, m.client, record.ContainerID); err != nil {
				m.logger.Warn("managed storage engine keeps Docker's restart policy", "id", id, "error", err)
			}
		}
		if record.Removed || !record.DesiredRunning {
			continue
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			m.logger.Warn("managed storage could not be mounted at startup", "id", id, "error", err)
			continue
		}
		if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
			m.logger.Warn("managed storage is not started at startup", "id", id, "error", runtimeFilesMissingError("managed storage", missing))
			if err := m.saveRecord(record); err != nil {
				return err
			}
			continue
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			m.logger.Warn("managed storage could not be started at startup", "id", id, "error", err)
			continue
		}
		if err := m.saveRecord(record); err != nil {
			return err
		}
		if record.engine() == managedStorageEngineSeaweedFS {
			started = append(started, id)
		}
	}
	if len(started) > 0 {
		go m.moveStoragesToPinnedImage(context.WithoutCancel(ctx), started)
	}
	return nil
}

func (m *managedStorageManager) recordPath(id string) string {
	return filepath.Join(m.root, "storage", "records", id+".json")
}
func (m *managedStorageManager) loadRecord(id string) (managedStorageRecord, error) {
	raw, err := os.ReadFile(m.recordPath(id))
	if err != nil {
		return managedStorageRecord{}, err
	}
	var record managedStorageRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return managedStorageRecord{}, fmt.Errorf("decode managed storage record: %w", err)
	}
	if record.ID != id || !managedStorageIDPattern.MatchString(record.ID) {
		return managedStorageRecord{}, errors.New("managed storage record identity is invalid")
	}
	return record, nil
}
func (m *managedStorageManager) saveRecord(record managedStorageRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(m.recordPath(record.ID), raw, 0600)
}
func (m *managedStorageManager) storageStatus(ctx context.Context, record managedStorageRecord) string {
	if record.Removed {
		return "deleted"
	}
	// An engine whose disk is being repaired, or failed its repair, is down.
	if m.repairs.running(record.ID) || record.DiskRepair.blocksEngine() {
		return "stopped"
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil {
		return "stopped"
	}
	if !inspect.Container.State.Running {
		if m.engineRestarting(record, inspect.Container.State) {
			return "starting"
		}
		return "stopped"
	}
	if err := m.checkReady(ctx, record); err != nil {
		if m.engineKeepsExiting(record) || m.engineDidNotComeBack(record) {
			return "stopped"
		}
		return "starting"
	}
	m.engineServed(record.ContainerID)
	return "ready"
}

func managedStorageReadyTimeout(record managedStorageRecord) time.Duration {
	if record.engine() == managedStorageEngineSeaweedFS {
		return seaweedfsReadyTimeout
	}
	return 90 * time.Second
}

func (m *managedStorageManager) waitForReady(ctx context.Context, record managedStorageRecord) error {
	deadline := time.NewTimer(managedStorageReadyTimeout(record))
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		if err := m.checkReady(ctx, record); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("managed storage readiness check timed out: %w", lastErr)
		case <-ticker.C:
		}
	}
}

func managedStorageHealthPath(record managedStorageRecord) string {
	if record.engine() == managedStorageEngineSeaweedFS {
		return "/healthz"
	}
	if record.MemberCount > 1 {
		return "/minio/health/cluster"
	}
	return "/minio/health/ready"
}

func (m *managedStorageManager) checkReady(ctx context.Context, record managedStorageRecord) error {
	if m.probeReady != nil {
		return m.probeReady(ctx, record)
	}
	if record.engine() == managedStorageEngineSeaweedFS {
		return m.checkSeaweedFSReady(ctx, record)
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return err
	}
	scheme := "http"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if record.TLSEnabled {
		caPEM, err := os.ReadFile(filepath.Join(m.root, "storage", "tls", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex), "CAs", "gateway-ca.crt"))
		if err != nil {
			return fmt.Errorf("read managed storage health CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return errors.New("managed storage health CA is invalid")
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: record.TLSServerName}
		scheme = "https"
	}
	return probeManagedStorageHealth(ctx, transport, scheme+"://"+endpoint+managedStorageHealthPath(record))
}

// checkSeaweedFSReady requires the in-container healthcheck (master leader,
// filer store, volume server, S3 listener) to report healthy and the S3
// listener to answer over the private network with the expected TLS identity.
func (m *managedStorageManager) checkSeaweedFSReady(ctx context.Context, record managedStorageRecord) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed storage container is not running")
	}
	if inspect.Container.State.Health == nil || inspect.Container.State.Health.Status != container.Healthy {
		status := "unknown"
		if inspect.Container.State.Health != nil {
			status = string(inspect.Container.State.Health.Status)
		}
		return fmt.Errorf("managed storage container health is %s", status)
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return err
	}
	transport, scheme, err := m.seaweedfsTransport(record)
	if err != nil {
		return err
	}
	return probeManagedStorageHealth(ctx, transport, scheme+"://"+endpoint+managedStorageHealthPath(record))
}

func probeManagedStorageHealth(ctx context.Context, transport *http.Transport, target string) error {
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("managed storage health returned HTTP %d", response.StatusCode)
	}
	return nil
}
func (m *managedStorageManager) marshalManagedStorageDetail(ctx context.Context, record managedStorageRecord, status string) (string, error) {
	privateEndpoint := ""
	if !record.Removed && record.ContainerID != "" {
		if endpoint, err := m.privateEndpoint(ctx, record); err == nil {
			privateEndpoint = endpoint
		}
	}
	detail := map[string]any{
		"status": status, "id": record.ID, "operationId": record.OperationID,
		"engine": record.engine(), "image": record.Image,
		"containerName": record.ContainerName, "memberIndex": record.MemberIndex,
		"privateEndpoint": privateEndpoint, "publishS3": record.PublishS3,
		"peerPublished": record.PeerBindAddress != "", "peerBindAddress": record.PeerBindAddress,
		"publishedPort": record.PublishedPort, "storageBytes": record.StorageBytes,
		"nanoCPUs": record.NanoCPUs, "memoryBytes": record.MemoryBytes,
		"memorySwapBytes": record.MemorySwapBytes, "ftpPort": record.FTPPort,
		"ftpPassivePortStart": record.FTPPassiveStart, "ftpPassivePortCount": record.FTPPassiveCount,
		"sftpPort": record.SFTPPort,
	}
	if !record.Removed {
		if missing := m.missingRuntimeFiles(record); len(missing) > 0 {
			detail["runtimeMissing"] = missing
		}
		if status == "stopped" && m.engineKeepsExiting(record) {
			detail["engineExited"] = true
		}
		// A serving SeaweedFS storage that takes no new objects (its disk is
		// full, or its master can create no volume) is shown degraded until it
		// has room again; storageFull is what Gateways before 2.12.1 read.
		if status == "ready" && record.engine() == managedStorageEngineSeaweedFS {
			if capacity, ok := m.seaweedfsCapacity(record); ok {
				detail["storageWritable"] = capacity.Writable
				if !capacity.Writable {
					detail["storageFull"] = true
					detail["storageFullReason"] = capacity.Reason
				}
				if capacity.NearlyFull {
					detail["storageNearlyFull"] = true
				}
			}
		}
		if repair := diskRepairDetail(record.DiskRepair, m.repairs.running(record.ID)); repair != nil {
			detail["diskRepair"] = repair
		}
		if incidents := m.incidents.detail(record.ID); incidents != nil {
			detail["engineIncidents"] = incidents
		}
		if oversubscribed := managedDiskOversubscription(m.root, m.reserve, m.statFilesystem); oversubscribed != nil {
			detail["nodeDiskOversubscribed"] = oversubscribed
		}
	}
	return jsonString(detail)
}
func jsonString(value any) (string, error) { raw, err := json.Marshal(value); return string(raw), err }

// removeMemberContainers removes every container labelled as this storage
// member, whatever its name.
func (m *managedStorageManager) removeMemberContainers(ctx context.Context, record managedStorageRecord) error {
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All: true,
		Filters: mobyclient.Filters{}.
			Add("label", managedStorageLabel+"="+record.ID).
			Add("label", managedStorageMemberLabel+"="+strconv.Itoa(record.MemberIndex)),
	})
	if err != nil {
		return fmt.Errorf("list managed storage containers: %w", err)
	}
	for _, item := range listed.Items {
		if err := m.client.RemoveContainer(ctx, item.ID, true); err != nil && !isNotFoundErr(err) {
			return fmt.Errorf("remove managed storage container: %w", err)
		}
		m.logger.Info("removed a leftover container of a removed managed storage member", "id", record.ID, "container", item.Names)
	}
	return nil
}
