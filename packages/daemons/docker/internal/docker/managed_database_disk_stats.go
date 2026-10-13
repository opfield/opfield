package docker

import "golang.org/x/sys/unix"

// managedDatabaseDiskStatfs reads the filesystem of a managed database's data
// mount (tests replace it).
var managedDatabaseDiskStatfs = unix.Statfs

// managedDatabaseDiskUsage is how full the filesystem of a managed database's
// data image is, as df counts it: used blocks, and used plus the blocks
// available to the engine (the root reserve is neither). ok is false when the
// mount cannot be read (not mounted, no mount path).
func managedDatabaseDiskUsage(mountPath string) (used, total int64, ok bool) {
	if mountPath == "" {
		return 0, 0, false
	}
	var stat unix.Statfs_t
	if err := managedDatabaseDiskStatfs(mountPath, &stat); err != nil || stat.Blocks == 0 {
		return 0, 0, false
	}
	blockSize := int64(stat.Bsize)
	used = (int64(stat.Blocks) - int64(stat.Bfree)) * blockSize
	total = used + int64(stat.Bavail)*blockSize
	if used < 0 || total <= 0 {
		return 0, 0, false
	}
	return used, total, true
}
