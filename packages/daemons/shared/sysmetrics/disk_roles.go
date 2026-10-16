package sysmetrics

import (
	"path/filepath"
	"strings"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"golang.org/x/sys/unix"
)

// Roles of a disk mount in the health report (DiskMount.role). Opfield's
// built-in disk alert watches every mount except managed_image: the disk
// images of managed databases, storage and volumes are sized on purpose and
// have their own metrics.
const (
	DiskRoleRoot         = "root"
	DiskRoleDockerRoot   = "docker_root"
	DiskRoleOpfieldState = "opfield_state"
	DiskRoleManagedImage = "managed_image"
	DiskRoleData         = "data"
)

// DiskRolePaths names the directories whose mounts get a role.
type DiskRolePaths struct {
	// DockerRoot is Docker's data root (docker info DockerRootDir): the mount
	// holding it is docker_root.
	DockerRoot string
	// StateDirs are the daemon's own data directories (its state directory,
	// the managed storage root): the mounts holding them are opfield_state.
	StateDirs []string
	// ManagedImageDirs hold Opfield's disk images: a mount strictly below one
	// of them is managed_image.
	ManagedImageDirs []string
}

// AssignDiskRoles sets the role of every mount. A loop device or a mount
// below a managed image directory is always managed_image; otherwise the most
// specific role wins: docker_root, then opfield_state, then root, then data.
func AssignDiskRoles(mounts []*pb.DiskMount, paths DiskRolePaths) {
	dockerRoot := ""
	if paths.DockerRoot != "" {
		dockerRoot = holdingMount(mounts, resolveDir(paths.DockerRoot))
	}
	state := map[string]bool{}
	for _, dir := range paths.StateDirs {
		if dir == "" {
			continue
		}
		if holder := holdingMount(mounts, resolveDir(dir)); holder != "" {
			state[holder] = true
		}
	}
	imageDirs := make([]string, 0, len(paths.ManagedImageDirs))
	for _, dir := range paths.ManagedImageDirs {
		if dir != "" {
			imageDirs = append(imageDirs, resolveDir(dir))
		}
	}
	for _, mount := range mounts {
		if mount == nil {
			continue
		}
		mountPoint := filepath.Clean(mount.MountPoint)
		switch {
		case isManagedImageMount(mount.Device, mountPoint, imageDirs):
			mount.Role = DiskRoleManagedImage
		case dockerRoot != "" && mountPoint == dockerRoot:
			mount.Role = DiskRoleDockerRoot
		case state[mountPoint]:
			mount.Role = DiskRoleOpfieldState
		case mountPoint == "/":
			mount.Role = DiskRoleRoot
		default:
			mount.Role = DiskRoleData
		}
	}
}

// RootDiskMount is the root filesystem alone, for a daemon in protected mode:
// its size and use, without the device or filesystem type, which reveals no
// more than the free space every report carries.
func RootDiskMount() *pb.DiskMount {
	var stat unix.Statfs_t
	if err := unix.Statfs("/", &stat); err != nil {
		return nil
	}
	return rootDiskMountFromStatfs(&stat)
}

func rootDiskMountFromStatfs(stat *unix.Statfs_t) *pb.DiskMount {
	totalBytes := int64(stat.Blocks) * int64(stat.Bsize)
	freeBytes := int64(stat.Bavail) * int64(stat.Bsize)
	if totalBytes <= 0 {
		return nil
	}
	usedBytes := totalBytes - freeBytes
	return &pb.DiskMount{
		MountPoint:   "/",
		TotalBytes:   totalBytes,
		UsedBytes:    usedBytes,
		FreeBytes:    freeBytes,
		UsagePercent: diskUsagePercent(usedBytes, totalBytes),
		Role:         DiskRoleRoot,
	}
}

func isManagedImageMount(device, mountPoint string, imageDirs []string) bool {
	if strings.HasPrefix(device, "/dev/loop") {
		return true
	}
	for _, dir := range imageDirs {
		if dir != "/" && strings.HasPrefix(mountPoint, dir+"/") {
			return true
		}
	}
	return false
}

// holdingMount is the mount point of the mount that holds path: the longest
// mount point that is path or one of its parents. Empty when none is listed.
func holdingMount(mounts []*pb.DiskMount, path string) string {
	best := ""
	for _, mount := range mounts {
		if mount == nil {
			continue
		}
		mountPoint := filepath.Clean(mount.MountPoint)
		if !pathWithin(path, mountPoint) {
			continue
		}
		if len(mountPoint) > len(best) {
			best = mountPoint
		}
	}
	return best
}

func pathWithin(path, dir string) bool {
	if dir == "/" {
		return strings.HasPrefix(path, "/")
	}
	return path == dir || strings.HasPrefix(path, dir+"/")
}

// resolveDir is the absolute, symlink-free form of dir as far as it exists.
func resolveDir(dir string) string {
	dir = filepath.Clean(dir)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return dir
}
