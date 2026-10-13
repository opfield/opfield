package sysmetrics

import (
	"bufio"
	"math"
	"os"
	"strconv"
	"strings"

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

// GetDiskMounts reads /proc/mounts, filters virtual filesystems, and returns disk usage info.
func GetDiskMounts() []*pb.DiskMount {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	var mounts []*pb.DiskMount

	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device := fields[0]
		mountPoint := fields[1]
		fsType := fields[2]

		if !includeDiskMount(device, mountPoint, fsType) {
			continue
		}

		// Skip individual file bind-mounts (e.g., /etc/resolv.conf)
		if fi, err := os.Stat(mountPoint); err == nil && !fi.IsDir() {
			continue
		}

		// Deduplicate by mount point
		if seen[mountPoint] {
			continue
		}
		seen[mountPoint] = true

		var stat unix.Statfs_t
		if err := unix.Statfs(mountPoint, &stat); err != nil {
			continue
		}

		totalBytes := int64(stat.Blocks) * int64(stat.Bsize)
		freeBytes := int64(stat.Bavail) * int64(stat.Bsize)
		usedBytes := totalBytes - freeBytes

		var usagePercent float64
		if totalBytes > 0 {
			usagePercent = math.Round(float64(usedBytes)/float64(totalBytes)*1000) / 10
		}

		mounts = append(mounts, &pb.DiskMount{
			MountPoint:   mountPoint,
			Filesystem:   fsType,
			Device:       device,
			TotalBytes:   totalBytes,
			UsedBytes:    usedBytes,
			FreeBytes:    freeBytes,
			UsagePercent: usagePercent,
		})
	}

	return mounts
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
