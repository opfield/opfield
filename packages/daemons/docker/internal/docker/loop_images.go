package docker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// errNoFreeLoopDevice replaces losetup's "cannot find an unused loop device".
// A node with a fixed loop-device pool (an LXC guest) runs out once every
// device backs an image.
var errNoFreeLoopDevice = errors.New("node has no free loop device; each managed instance, backup run or disk-image volume needs one")

const (
	// A delete waits up to about 20 seconds for a busy mount or a loop device
	// that is still open; the periodic repair only briefly.
	loopReleaseAttempts     = 8
	loopRepairAttempts      = 3
	loopReleaseFirstBackoff = 250 * time.Millisecond
	loopReleaseMaxBackoff   = 4 * time.Second
	loopImageRepairInterval = 10 * time.Minute
	loopImageRepairTimeout  = 5 * time.Minute
	loopDeletedSuffix       = " (deleted)"
	sysBlockRoot            = "/sys/block"
	selfMountInfoPath       = "/proc/self/mountinfo"
	// volumePlaceholderSource names the read-only empty tmpfs mounted at the
	// mount point of a disk-image volume whose image could not be mounted.
	volumePlaceholderSource = "gateway-volume-placeholder"
)

// loopDevice is one bound loop device as sysfs reports it.
type loopDevice struct {
	Path        string // /dev/loopN
	Number      string // major:minor of the loop device
	BackingFile string // as seen from this mount namespace, without the deleted suffix
	Deleted     bool   // the backing file was unlinked while still attached
}

// mountEntry is one line of /proc/self/mountinfo.
type mountEntry struct {
	MountPoint string
	Number     string // major:minor of the mounted device
	FSType     string
	Source     string
	// Options are the per-mount options ("rw,noatime"); SuperOptions those of
	// the filesystem ("rw,emergency_ro" for an ext4 that stopped writing).
	Options      string
	SuperOptions string
}

// loopHost is the kernel surface of loop-backed images (managed databases,
// managed storage, backup workspaces, disk-image volumes). Tests replace it.
type loopHost struct {
	loops  func() ([]loopDevice, error)
	mounts func() ([]mountEntry, error)
	// identity returns the device and inode of a loop device's backing file;
	// ok is false when this daemon cannot open the device node.
	identity func(device string) (dev, ino uint64, ok bool)
	unmount  func(ctx context.Context, path string) error
	detach   func(ctx context.Context, device string) error
	sleep    func(ctx context.Context, d time.Duration) error
	// attach binds a free loop device to an image; mount mounts a device.
	attach func(ctx context.Context, image string) (string, error)
	mount  func(ctx context.Context, device, path, options string) error
	// directIO switches a bound loop device to direct I/O; nil leaves devices
	// as they are.
	directIO func(ctx context.Context, device string) error
	// placeholder mounts the read-only empty placeholder at path.
	placeholder func(ctx context.Context, path string) error
	// autoclear makes a mounted loop device detach by itself once nothing
	// holds it (the last unmount, also of a daemon that died); nil leaves
	// devices as they are.
	autoclear func(device string) error
}

var systemLoopHost = &loopHost{
	loops:     func() ([]loopDevice, error) { return readLoopDevices(sysBlockRoot) },
	mounts:    readSelfMounts,
	identity:  loopBackingIdentity,
	autoclear: loopSetAutoclear,
	unmount: func(ctx context.Context, path string) error {
		return runLoopCommand(ctx, "umount", path)
	},
	detach: func(ctx context.Context, device string) error {
		return runLoopCommand(ctx, "losetup", "-d", device)
	},
	sleep: func(ctx context.Context, d time.Duration) error {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	},
	attach: attachDatabaseLoopDevice,
	mount: func(ctx context.Context, device, path, options string) error {
		return runLoopCommand(ctx, "mount", "-o", options, device, path)
	},
	directIO: setLoopDirectIO,
	placeholder: func(ctx context.Context, path string) error {
		return runLoopCommand(ctx, "mount", "-t", "tmpfs", "-o", "ro,nodev,nosuid,noexec,size=16k,mode=0555", volumePlaceholderSource, path)
	},
}

// setLoopDirectIO makes device read and write its backing file with direct
// I/O. A buffered loop device caches every block twice, once for the
// filesystem in the image and once for the image file, and both copies count
// against the memory limit of the container that reads it: on a busy instance
// the page cache then holds half as much, and reads go to the disk again and
// again.
func setLoopDirectIO(ctx context.Context, device string) error {
	state, err := os.ReadFile(filepath.Join(sysBlockRoot, filepath.Base(device), "loop", "dio"))
	if err == nil && strings.TrimSpace(string(state)) == "1" {
		return nil
	}
	return runLoopCommand(ctx, "losetup", "--direct-io=on", device)
}

// loopDirectIORefused remembers the images whose loop device refused direct
// I/O (a backing filesystem without O_DIRECT, or a block size mismatch), so
// the disk watch asks once per binding instead of every pass.
var loopDirectIORefused sync.Map

// ensureDirectIO switches the loop device mounted at mountPath to direct I/O.
// Devices bound by an older daemon are switched in place; the filesystem in
// the image keeps its own page cache. A device that refuses keeps buffered
// I/O, which works as before.
func (h *loopHost) ensureDirectIO(ctx context.Context, logger *slog.Logger, label, id, mountPath string) {
	if h.directIO == nil {
		return
	}
	device := h.mountedLoop(mountPath)
	if device == "" {
		return
	}
	key := device + "\x00" + canonicalLoopPath(mountPath)
	if _, refused := loopDirectIORefused.Load(key); refused {
		return
	}
	if err := h.directIO(ctx, device); err != nil {
		if ctx.Err() != nil {
			return
		}
		loopDirectIORefused.Store(key, struct{}{})
		if logger != nil {
			logger.Info(label+" disk keeps buffered I/O: its loop device refused direct I/O", "id", id, "device", device, "error", err)
		}
	}
}

func runLoopCommand(ctx context.Context, name string, args ...string) error {
	if output, err := exec.CommandContext(ctx, name, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func loopReleaseBackoff(attempt int) time.Duration {
	delay := loopReleaseFirstBackoff << attempt
	if delay <= 0 || delay > loopReleaseMaxBackoff {
		return loopReleaseMaxBackoff
	}
	return delay
}

// readLoopDevices lists bound loop devices. sysfs shows every loop device of
// the kernel, including ones an LXC guest cannot open; owns() filters those.
func readLoopDevices(root string) ([]loopDevice, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("list loop devices: %w", err)
	}
	var result []loopDevice
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "loop") {
			continue
		}
		// The loop/ attributes exist only while the device is bound.
		raw, err := os.ReadFile(filepath.Join(root, name, "loop", "backing_file"))
		if err != nil {
			continue
		}
		number, err := os.ReadFile(filepath.Join(root, name, "dev"))
		if err != nil {
			continue
		}
		backing := strings.TrimSuffix(string(raw), "\n")
		deleted := strings.HasSuffix(backing, loopDeletedSuffix)
		result = append(result, loopDevice{
			Path:        "/dev/" + name,
			Number:      strings.TrimSpace(string(number)),
			BackingFile: strings.TrimSuffix(backing, loopDeletedSuffix),
			Deleted:     deleted,
		})
	}
	return result, nil
}

func readSelfMounts() ([]mountEntry, error) {
	file, err := os.Open(selfMountInfoPath)
	if err != nil {
		return nil, fmt.Errorf("read mount table: %w", err)
	}
	defer file.Close()
	return parseMountInfo(file)
}

// parseMountInfo reads mountinfo lines: "id parent major:minor root
// mountpoint options ... - fstype source superoptions".
func parseMountInfo(r io.Reader) ([]mountEntry, error) {
	var result []mountEntry
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 {
			continue
		}
		entry := mountEntry{MountPoint: unescapeMountInfo(fields[4]), Number: fields[2]}
		if len(fields) > 5 {
			entry.Options = fields[5]
		}
		// Optional fields end at "-", followed by the type, the source and
		// the filesystem's options.
		if separator := slices.Index(fields[5:], "-"); separator >= 0 && 5+separator+2 < len(fields) {
			entry.FSType = fields[5+separator+1]
			entry.Source = unescapeMountInfo(fields[5+separator+2])
			if 5+separator+3 < len(fields) {
				entry.SuperOptions = fields[5+separator+3]
			}
		}
		result = append(result, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read mount table: %w", err)
	}
	return result, nil
}

// unescapeMountInfo decodes the octal escapes (\040 for a space and so on)
// the kernel writes into mountinfo paths.
func unescapeMountInfo(value string) string {
	if !strings.Contains(value, `\`) {
		return value
	}
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+3 < len(value) {
			if code, err := strconv.ParseUint(value[i+1:i+4], 8, 8); err == nil {
				out.WriteByte(byte(code))
				i += 3
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

// canonicalLoopPath resolves symlinks so a configured path compares equal to
// the path the kernel reports in sysfs and mountinfo (a storage root may be a
// symlink to an external mount).
func canonicalLoopPath(path string) string {
	path = filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	if dir, err := filepath.EvalSymlinks(filepath.Dir(path)); err == nil {
		return filepath.Join(dir, filepath.Base(path))
	}
	return path
}

func fileIdentity(path string) (uint64, uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, errors.New("file identity is unavailable")
	}
	return uint64(stat.Dev), uint64(stat.Ino), nil
}

// owns reports whether a loop device whose sysfs path names a file in this
// daemon's directories really is that file. sysfs prints paths relative to the
// reader's root, so another guest's identical path proves nothing; the device
// node must be ours to open and the inode must match (for an unlinked file,
// the filesystem of its directory).
func (h *loopHost) owns(loop loopDevice) bool {
	dev, ino, ok := h.identity(loop.Path)
	if !ok {
		return false
	}
	if loop.Deleted {
		dirDev, _, err := fileIdentity(filepath.Dir(loop.BackingFile))
		return err == nil && dirDev == dev
	}
	fileDev, fileIno, err := fileIdentity(loop.BackingFile)
	return err == nil && fileDev == dev && fileIno == ino
}

// imageLoops returns the loop devices bound to the image at imagePath,
// including ones left bound to an earlier, deleted file of that name.
func (h *loopHost) imageLoops(imagePath string) ([]loopDevice, error) {
	loops, err := h.loops()
	if err != nil {
		return nil, err
	}
	path := canonicalLoopPath(imagePath)
	imageDev, imageIno, identityErr := fileIdentity(path)
	var result []loopDevice
	for _, loop := range loops {
		if loop.BackingFile == path && h.owns(loop) {
			result = append(result, loop)
			continue
		}
		// The same image under another name (an older layout, another mount
		// view of the directory): the device node is ours and its backing
		// inode is the image's. Missing it left a loop bound to the deleted
		// image after a delete.
		if identityErr == nil {
			if dev, ino, ok := h.identity(loop.Path); ok && dev == imageDev && ino == imageIno {
				result = append(result, loop)
			}
		}
	}
	return result, nil
}

func (h *loopHost) isMounted(path string) (bool, error) {
	mounts, err := h.mounts()
	if err != nil {
		return false, err
	}
	for _, mount := range mounts {
		if mount.MountPoint == path {
			return true, nil
		}
	}
	return false, nil
}

// isPlaceholder reports whether the visible mount at path is the read-only
// placeholder of a volume image that could not be mounted.
func (h *loopHost) isPlaceholder(path string) (bool, error) {
	mounts, err := h.mounts()
	if err != nil {
		return false, err
	}
	placeholder := false
	for _, mount := range mounts {
		if mount.MountPoint == path {
			placeholder = mount.FSType == "tmpfs" && mount.Source == volumePlaceholderSource // the last one is visible
		}
	}
	return placeholder, nil
}

// mountedLoop returns the loop device mounted at mountPath, or "". The
// persisted device name of a record goes stale after a reboot or a reattach.
func (h *loopHost) mountedLoop(mountPath string) string {
	path := canonicalLoopPath(mountPath)
	mounts, err := h.mounts()
	if err != nil {
		return ""
	}
	number := ""
	for _, mount := range mounts {
		if mount.MountPoint == path {
			number = mount.Number // the last entry is the visible one
		}
	}
	if number == "" {
		return ""
	}
	loops, err := h.loops()
	if err != nil {
		return ""
	}
	for _, loop := range loops {
		if loop.Number == number {
			return loop.Path
		}
	}
	return ""
}

// mountImage mounts imagePath at mountPath unless something is mounted there
// already, and returns the loop device mounted at mountPath.
func (h *loopHost) mountImage(ctx context.Context, imagePath, mountPath, options string) (string, error) {
	if mounted, err := h.isMounted(canonicalLoopPath(mountPath)); err != nil {
		return "", err
	} else if mounted {
		return h.mountedLoop(mountPath), nil
	}
	if err := os.MkdirAll(mountPath, 0o700); err != nil {
		return "", fmt.Errorf("create mount point: %w", err)
	}
	device, err := h.attach(ctx, imagePath)
	if err != nil {
		return "", err
	}
	if h.directIO != nil {
		// Best effort: a refusal leaves buffered I/O, and the disk watch
		// reports it.
		_ = h.directIO(ctx, device)
	}
	if err := h.mount(ctx, device, mountPath, options); err != nil {
		// Nothing holds the fresh device yet, so the detach is immediate.
		_ = h.detach(context.Background(), device)
		return "", fmt.Errorf("mount storage image: %w", err)
	}
	if h.autoclear != nil {
		// Best effort: the mount holds the device; once it is gone the kernel
		// detaches it, so a missed release never leaks the device.
		_ = h.autoclear(device)
	}
	return device, nil
}

// unmountAll removes every mount at path, stacked ones included, and retries a
// busy mount with backoff.
func (h *loopHost) unmountAll(ctx context.Context, path string, attempts int) error {
	failures := 0
	for range 64 {
		mounted, err := h.isMounted(path)
		if err != nil {
			return err
		}
		if !mounted {
			return nil
		}
		err = h.unmount(ctx, path)
		if err == nil {
			continue
		}
		failures++
		if failures >= attempts {
			return fmt.Errorf("unmount %s: %w", path, err)
		}
		if err := h.sleep(ctx, loopReleaseBackoff(failures-1)); err != nil {
			return fmt.Errorf("unmount %s: %w", path, err)
		}
	}
	return fmt.Errorf("unmount %s: still mounted", path)
}

// bound reports whether loop is still bound to the same backing file.
func (h *loopHost) bound(loop loopDevice) (bool, error) {
	loops, err := h.loops()
	if err != nil {
		return false, err
	}
	for _, current := range loops {
		if current.Path == loop.Path && current.BackingFile == loop.BackingFile {
			return true, nil
		}
	}
	return false, nil
}

// detachOne detaches loop and waits until the kernel has released it. For a
// device that is still open (a mount in another mount namespace, a process)
// losetup -d only sets autoclear and succeeds; that is reported as an error
// instead of being taken for a detach.
func (h *loopHost) detachOne(ctx context.Context, loop loopDevice, attempts int) error {
	mounts, err := h.mounts()
	if err != nil {
		return err
	}
	for _, mount := range mounts {
		if mount.Number == loop.Number {
			return fmt.Errorf("loop device %s for %s is still mounted at %s", loop.Path, loop.BackingFile, mount.MountPoint)
		}
	}
	var detachErr error
	for attempt := 0; ; attempt++ {
		bound, err := h.bound(loop)
		if err != nil {
			return err
		}
		if !bound {
			return nil
		}
		if attempt == attempts {
			break
		}
		detachErr = h.detach(ctx, loop.Path)
		if err := h.sleep(ctx, loopReleaseBackoff(attempt)); err != nil {
			return fmt.Errorf("detach loop device %s for %s: %w", loop.Path, loop.BackingFile, err)
		}
	}
	if detachErr != nil {
		return fmt.Errorf("detach loop device %s for %s: %w", loop.Path, loop.BackingFile, detachErr)
	}
	return fmt.Errorf("loop device %s for %s is still in use", loop.Path, loop.BackingFile)
}

// release unmounts mountPath, detaches every loop device bound to imagePath
// and waits until the kernel has let go of them, in that order. Only then may
// the caller remove the image: removing it first leaves a loop device bound to
// a deleted file, which on a fixed loop pool blocks every later create.
func (h *loopHost) release(ctx context.Context, imagePath, mountPath string) error {
	if mountPath != "" {
		if err := h.unmountAll(ctx, canonicalLoopPath(mountPath), loopReleaseAttempts); err != nil {
			return err
		}
	}
	loops, err := h.imageLoops(imagePath)
	if err != nil {
		return err
	}
	for _, loop := range loops {
		if err := h.detachOne(ctx, loop, loopReleaseAttempts); err != nil {
			return err
		}
	}
	return nil
}

// removeMountPoint deletes an instance's mount point once released. Anything
// inside was written while the image was not mounted (an engine started
// without its storage) and belongs to the deleted instance; a path that is
// still a mount point is refused, since its contents are the image's.
func (h *loopHost) removeMountPoint(path string) error {
	if mounted, err := h.isMounted(canonicalLoopPath(path)); err != nil {
		return err
	} else if mounted || differentFilesystem(path) {
		return fmt.Errorf("%s is still a mount point", path)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove mount point %s: %w", path, err)
	}
	return nil
}

// differentFilesystem is a second check for a mount point, independent of the
// mount table: a mounted image has its own device.
func differentFilesystem(path string) bool {
	dev, _, err := fileIdentity(path)
	if err != nil {
		return false
	}
	parent, _, err := fileIdentity(filepath.Dir(path))
	return err == nil && dev != parent
}

// unreadableRecord is an instance record file that cannot be read (a damaged
// file). Its id is taken from the file name; the repair leaves everything
// named after that id alone and never deletes the file.
type unreadableRecord struct {
	ID   string
	Path string
	Err  error
}

// loopImageDomain is one image directory a manager owns. Predicates take base
// names inside imageDir and mountDir.
type loopImageDomain struct {
	label    string
	imageDir string
	// mountDir holds one mount point per instance; empty when instance mounts
	// live elsewhere.
	mountDir string
	// mountRoot bounds where the mounts of an orphaned loop device may be
	// removed.
	mountRoot string
	// imageInUse reports an image whose instance keeps its loop and mount.
	imageInUse func(name string, deleted bool) bool
	// imageKept reports an image file that must stay on disk.
	imageKept func(name string) bool
	// mountInUse reports a mount point an instance keeps.
	mountInUse func(name string) bool
	// orphanImage reports a file this manager creates, so that it may be
	// removed when no instance keeps it; nil keeps every file.
	orphanImage func(name string) bool
}

// repair releases what interrupted operations and earlier releases left in a
// domain: mounts no instance owns, loop devices bound to images no instance
// uses (deleted files included) and image files no instance keeps. Nothing
// outside the domain's directories, no device this daemon cannot open and
// nothing an instance uses is touched. Failures are logged and retried on the
// next pass. The caller holds the manager lock, so no create is in flight.
func (h *loopHost) repair(ctx context.Context, d loopImageDomain, logger *slog.Logger) {
	imageDir := canonicalLoopPath(d.imageDir)
	mountRoot := canonicalLoopPath(d.mountRoot)
	mountDir := ""
	if d.mountDir != "" {
		mountDir = canonicalLoopPath(d.mountDir)
	}
	if mountDir != "" {
		mounts, err := h.mounts()
		if err != nil {
			logger.Warn("loop image repair could not read the mount table", "domain", d.label, "error", err)
			return
		}
		seen := map[string]bool{}
		for _, mount := range mounts {
			if filepath.Dir(mount.MountPoint) != mountDir || seen[mount.MountPoint] || d.mountInUse(filepath.Base(mount.MountPoint)) {
				continue
			}
			seen[mount.MountPoint] = true
			if err := h.unmountAll(ctx, mount.MountPoint, loopRepairAttempts); err != nil {
				logger.Warn("orphaned "+d.label+" mount could not be removed", "mount", mount.MountPoint, "error", err)
				continue
			}
			logger.Info("repaired orphaned "+d.label+" mount", "mount", mount.MountPoint)
		}
	}
	loops, err := h.loops()
	if err != nil {
		logger.Warn("loop image repair could not list loop devices", "domain", d.label, "error", err)
		return
	}
	for _, loop := range loops {
		if filepath.Dir(loop.BackingFile) != imageDir || d.imageInUse(filepath.Base(loop.BackingFile), loop.Deleted) || !h.owns(loop) {
			continue
		}
		if err := h.releaseOrphanLoop(ctx, loop, d, mountDir, mountRoot); err != nil {
			logger.Warn("orphaned "+d.label+" loop device could not be detached", "device", loop.Path, "image", loop.BackingFile, "error", err)
			continue
		}
		logger.Info("repaired orphaned "+d.label+" loop device", "device", loop.Path, "image", loop.BackingFile, "imageDeleted", loop.Deleted)
	}
	if mountDir != "" {
		h.removeOrphanMountPoints(d, mountDir, logger)
	}
	if d.orphanImage == nil {
		return
	}
	entries, err := os.ReadDir(imageDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			logger.Warn("loop image repair could not list images", "domain", d.label, "error", err)
		}
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || d.imageKept(name) || !d.orphanImage(name) {
			continue
		}
		path := filepath.Join(imageDir, name)
		if attached, err := h.imageLoops(path); err != nil || len(attached) > 0 {
			continue // still bound; the next pass retries after the detach above
		}
		if err := os.Remove(path); err != nil {
			logger.Warn("orphaned "+d.label+" image could not be removed", "image", path, "error", err)
			continue
		}
		logger.Info("removed orphaned "+d.label+" image", "image", path)
	}
}

// removeOrphanMountPoints deletes mount point directories no instance owns,
// such as those an earlier release left after a delete.
func (h *loopHost) removeOrphanMountPoints(d loopImageDomain, mountDir string, logger *slog.Logger) {
	entries, err := os.ReadDir(mountDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || d.mountInUse(entry.Name()) {
			continue
		}
		path := filepath.Join(mountDir, entry.Name())
		if err := h.removeMountPoint(path); err != nil {
			logger.Warn("orphaned "+d.label+" mount point could not be removed", "mount", path, "error", err)
			continue
		}
		logger.Info("removed orphaned "+d.label+" mount point", "mount", path)
	}
}

func (h *loopHost) releaseOrphanLoop(ctx context.Context, loop loopDevice, d loopImageDomain, mountDir, mountRoot string) error {
	mounts, err := h.mounts()
	if err != nil {
		return err
	}
	var points []string
	for _, mount := range mounts {
		if mount.Number != loop.Number {
			continue
		}
		inUse := mountDir != "" && filepath.Dir(mount.MountPoint) == mountDir && d.mountInUse(filepath.Base(mount.MountPoint))
		if inUse || !pathWithin(mountRoot, mount.MountPoint) {
			return fmt.Errorf("left in place: mounted at %s", mount.MountPoint)
		}
		points = append(points, mount.MountPoint)
	}
	for _, point := range points {
		if err := h.unmountAll(ctx, point, loopRepairAttempts); err != nil {
			return err
		}
	}
	return h.detachOne(ctx, loop, loopRepairAttempts)
}

// runLoopImageRepair repeats the start-up repair of loop-backed images for the
// life of the process, so a leak from an older release or an interrupted
// operation never needs a restart or manual cleanup.
func (p *DockerPlugin) runLoopImageRepair(ctx context.Context) {
	ticker := time.NewTicker(loopImageRepairInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.repairLoopImages(ctx)
		}
	}
}

func (p *DockerPlugin) repairLoopImages(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, loopImageRepairTimeout)
	defer cancel()
	if p.databaseManager != nil {
		p.databaseManager.repairLoopImages(ctx)
		if runtime, err := backupRuntimeFor(p); err == nil {
			runtime.reconcileWorkspaces()
		}
	}
	if p.storageManager != nil {
		p.storageManager.repairLoopImages(ctx)
	}
	if p.volumeImages != nil {
		p.volumeImages.repairLoopImages(ctx)
	}
}
