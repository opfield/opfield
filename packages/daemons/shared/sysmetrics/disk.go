package sysmetrics

import (
	"bufio"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"syscall"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"golang.org/x/sys/unix"
)

// DiskIOState holds delta-based disk I/O metric state.
type DiskIOState struct {
	PrevDiskRead  uint64
	PrevDiskWrite uint64
}

// GetDiskFree returns available bytes for the given path.
func GetDiskFree(path string) int64 {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0
	}
	return int64(stat.Bavail) * int64(stat.Bsize)
}

// virtualFilesystems is the set of filesystem types to skip when enumerating mounts.
var virtualFilesystems = map[string]bool{
	"proc":        true,
	"sysfs":       true,
	"devtmpfs":    true,
	"devpts":      true,
	"tmpfs":       true,
	"cgroup":      true,
	"cgroup2":     true,
	"securityfs":  true,
	"pstore":      true,
	"debugfs":     true,
	"tracefs":     true,
	"hugetlbfs":   true,
	"mqueue":      true,
	"overlay":     true,
	"autofs":      true,
	"binfmt_misc": true,
	"fakeowner":   true,
	"fuse":        true,
	"fusectl":     true,
	"nsfs":        true,
	"squashfs":    true,
	"efivarfs":    true,
	"configfs":    true,
	"rpc_pipefs":  true,
	"nfsd":        true,
}

// mountTablePath is the mount table GetDiskMounts reads: the mounts this
// daemon sees, one per line, "device mountpoint fstype options 0 0".
const mountTablePath = "/proc/self/mounts"

// statfsAttempts bounds the retries of a statfs that a signal interrupted.
// x/sys/unix does not retry EINTR (os.Stat does), and a mount whose statfs
// failed once must not drop out of the report.
const statfsAttempts = 5

// GetDiskMounts reads the mount table, filters virtual filesystems, and
// returns the size and use of every disk mount, with its disk id (see
// DiskID).
func GetDiskMounts() []*pb.DiskMount {
	data, err := os.ReadFile(mountTablePath)
	if err != nil {
		return nil
	}
	return diskMountsFromTable(string(data), hostMountProbe())
}

// mountProbe measures the mounts of a mount table (replaceable in tests).
type mountProbe struct {
	statfs func(path string, stat *unix.Statfs_t) error
	// stat reports whether path is a directory and the device it is on.
	stat      func(path string) (isDir bool, dev uint64, err error)
	machineID string
}

func hostMountProbe() mountProbe {
	return mountProbe{statfs: unix.Statfs, stat: statPath, machineID: hostMachineID()}
}

func statPath(path string) (bool, uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, 0, err
	}
	var dev uint64
	if sys, ok := info.Sys().(*syscall.Stat_t); ok {
		dev = uint64(sys.Dev)
	}
	return info.IsDir(), dev, nil
}

// mountTableEntry is one line of the mount table, its octal escapes decoded.
type mountTableEntry struct {
	device, mountPoint, fsType string
}

// parseMountTable splits the mount table into entries. It has no line length
// limit: a bufio.Scanner stops at its first line over 64 KiB (an overlay
// mount with many layers) and silently loses every mount listed after it.
func parseMountTable(table string) []mountTableEntry {
	var entries []mountTableEntry
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		entries = append(entries, mountTableEntry{
			device:     unescapeMountField(fields[0]),
			mountPoint: unescapeMountField(fields[1]),
			fsType:     fields[2],
		})
	}
	return entries
}

// unescapeMountField decodes the octal escapes the kernel writes into the
// mount table (\040 for a space, \011, \012, \134). An escaped mount point
// would otherwise fail its statfs and drop out of the report.
func unescapeMountField(value string) string {
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

func diskMountsFromTable(table string, probe mountProbe) []*pb.DiskMount {
	entries := parseMountTable(table)
	// A mount point mounted over again shows its last mount: that one is
	// what statfs measures and what the path holds.
	visible := make(map[string]int, len(entries))
	var order []string
	for i, entry := range entries {
		if _, ok := visible[entry.mountPoint]; !ok {
			order = append(order, entry.mountPoint)
		}
		visible[entry.mountPoint] = i
	}

	var mounts []*pb.DiskMount
	for _, mountPoint := range order {
		entry := entries[visible[mountPoint]]
		if !includeDiskMount(entry.device, mountPoint, entry.fsType) {
			continue
		}
		isDir, dev, statErr := probe.stat(mountPoint)
		// Skip individual file bind-mounts (e.g., /etc/resolv.conf)
		if statErr == nil && !isDir {
			continue
		}
		var stat unix.Statfs_t
		if err := statfsRetrying(probe.statfs, mountPoint, &stat); err != nil {
			continue
		}
		mount := diskMountFromStatfs(mountPoint, entry.fsType, entry.device, &stat)
		if statErr == nil {
			mount.DiskId = DiskID(probe.machineID, stat.Fsid, dev)
		}
		mounts = append(mounts, mount)
	}
	return mounts
}

// statfsRetrying is statfs, tried again while a signal interrupts it.
func statfsRetrying(statfs func(string, *unix.Statfs_t) error, path string, stat *unix.Statfs_t) error {
	var err error
	for attempt := 0; attempt < statfsAttempts; attempt++ {
		if err = statfs(path, stat); !errors.Is(err, unix.EINTR) {
			return err
		}
	}
	return err
}

func diskMountFromStatfs(mountPoint, fsType, device string, stat *unix.Statfs_t) *pb.DiskMount {
	totalBytes := int64(stat.Blocks) * int64(stat.Bsize)
	freeBytes := int64(stat.Bavail) * int64(stat.Bsize)
	usedBytes := totalBytes - freeBytes
	return &pb.DiskMount{
		MountPoint:   mountPoint,
		Filesystem:   fsType,
		Device:       device,
		TotalBytes:   totalBytes,
		UsedBytes:    usedBytes,
		FreeBytes:    freeBytes,
		UsagePercent: diskUsagePercent(usedBytes, totalBytes),
	}
}

// DiskMountAt measures the mount at mountPoint as GetDiskMounts does, for a
// mount a daemon knows it made (a managed disk image): its size and use and
// its disk id. ok is false when the mount point cannot be measured.
func DiskMountAt(mountPoint, fsType, device string) (*pb.DiskMount, bool) {
	probe := hostMountProbe()
	isDir, dev, statErr := probe.stat(mountPoint)
	if statErr != nil || !isDir {
		return nil, false
	}
	var stat unix.Statfs_t
	if err := statfsRetrying(probe.statfs, mountPoint, &stat); err != nil {
		return nil, false
	}
	mount := diskMountFromStatfs(mountPoint, fsType, device, &stat)
	mount.DiskId = DiskID(probe.machineID, stat.Fsid, dev)
	return mount, true
}

// diskUsagePercent is used of total in percent, to one decimal.
func diskUsagePercent(usedBytes, totalBytes int64) float64 {
	if totalBytes <= 0 {
		return 0
	}
	return math.Round(float64(usedBytes)/float64(totalBytes)*1000) / 10
}

func includeDiskMount(device, mountPoint, filesystem string) bool {
	if virtualFilesystems[filesystem] && !(filesystem == "overlay" && mountPoint == "/") {
		return false
	}
	realFilesystem := map[string]bool{
		"ext2": true, "ext3": true, "ext4": true, "xfs": true,
		"btrfs": true, "zfs": true, "ntfs": true, "vfat": true,
		"overlay": true, // root overlay represents the container's disk
	}
	return strings.HasPrefix(device, "/dev/") || realFilesystem[filesystem]
}

// GetDiskIO reads /proc/diskstats, sums sectors read/written (*512 for bytes),
// and returns delta-based read/write bytes.
// The caller must ensure concurrent access to DiskIOState is synchronized.
func GetDiskIO(state *DiskIOState) (int64, int64) {
	data, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return 0, 0
	}

	var totalRead, totalWrite uint64

	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// /proc/diskstats has 14+ fields: major minor name rd_ios rd_merges rd_sectors ...
		if len(fields) < 10 {
			continue
		}
		deviceName := fields[2]

		// Skip loop and ram devices
		if strings.HasPrefix(deviceName, "loop") || strings.HasPrefix(deviceName, "ram") {
			continue
		}

		// Field index 5 = sectors read, field index 9 = sectors written
		sectorsRead, _ := strconv.ParseUint(fields[5], 10, 64)
		sectorsWritten, _ := strconv.ParseUint(fields[9], 10, 64)

		totalRead += sectorsRead * 512
		totalWrite += sectorsWritten * 512
	}

	readDelta := totalRead - state.PrevDiskRead
	writeDelta := totalWrite - state.PrevDiskWrite
	state.PrevDiskRead = totalRead
	state.PrevDiskWrite = totalWrite

	return int64(readDelta), int64(writeDelta)
}
