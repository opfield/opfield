package sysmetrics

import (
	"os"
	"path/filepath"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"golang.org/x/sys/unix"
)

// Paths below a directory that does not exist, so the host running the test
// cannot resolve them through its own symlinks.
const fakeHost = "/nonexistent-opfield-disk-roles"

func mountsAt(entries ...[2]string) []*pb.DiskMount {
	mounts := make([]*pb.DiskMount, 0, len(entries))
	for _, entry := range entries {
		mounts = append(mounts, &pb.DiskMount{MountPoint: entry[0], Device: entry[1]})
	}
	return mounts
}

func rolesOf(mounts []*pb.DiskMount) map[string]string {
	roles := map[string]string{}
	for _, mount := range mounts {
		roles[mount.MountPoint] = mount.Role
	}
	return roles
}

func TestAssignDiskRolesOnADockerHostWithSeparateDisks(t *testing.T) {
	mounts := mountsAt(
		[2]string{"/", "/dev/sda1"},
		[2]string{fakeHost + "/docker", "/dev/sdb1"},
		[2]string{fakeHost + "/state", "/dev/sdc1"},
		[2]string{fakeHost + "/state/databases/pg-1", "/dev/loop3"},
		[2]string{fakeHost + "/state/volume-images/mnt/v1", "/dev/mapper/v1"},
		[2]string{"/mnt/backups", "/dev/sdd1"},
		[2]string{"/boot/efi", "/dev/sda15"},
	)
	AssignDiskRoles(mounts, DiskRolePaths{
		DockerRoot:       fakeHost + "/docker",
		StateDirs:        []string{fakeHost + "/state", fakeHost + "/state/databases"},
		ManagedImageDirs: []string{fakeHost + "/state/databases", fakeHost + "/state/volume-images"},
	})
	want := map[string]string{
		"/":                                      DiskRoleRoot,
		fakeHost + "/docker":                     DiskRoleDockerRoot,
		fakeHost + "/state":                      DiskRoleOpfieldState,
		fakeHost + "/state/databases/pg-1":       DiskRoleManagedImage,
		fakeHost + "/state/volume-images/mnt/v1": DiskRoleManagedImage,
		"/mnt/backups":                           DiskRoleData,
		"/boot/efi":                              DiskRoleData,
	}
	if got := rolesOf(mounts); !equalRoles(got, want) {
		t.Fatalf("roles = %v, want %v", got, want)
	}
}

// On a one-disk host the root mount holds Docker's data root; the most
// specific role names it.
func TestAssignDiskRolesOnOneDisk(t *testing.T) {
	mounts := mountsAt([2]string{"/", "/dev/vda1"}, [2]string{fakeHost + "/state/databases/kv-1", "/dev/loop0"})
	AssignDiskRoles(mounts, DiskRolePaths{DockerRoot: fakeHost + "/docker", StateDirs: []string{fakeHost + "/state"}})
	want := map[string]string{"/": DiskRoleDockerRoot, fakeHost + "/state/databases/kv-1": DiskRoleManagedImage}
	if got := rolesOf(mounts); !equalRoles(got, want) {
		t.Fatalf("roles = %v, want %v", got, want)
	}

	// Without Docker (nginx, relay, monitoring) the root mount holds the state.
	mounts = mountsAt([2]string{"/", "/dev/vda1"})
	AssignDiskRoles(mounts, DiskRolePaths{StateDirs: []string{fakeHost + "/state"}})
	if mounts[0].Role != DiskRoleOpfieldState {
		t.Fatalf("root role = %q, want %q", mounts[0].Role, DiskRoleOpfieldState)
	}
}

// The managed storage root on a disk of its own is a data disk Opfield fills:
// it is watched (opfield_state), only the images mounted below it are not.
func TestAssignDiskRolesKeepsTheStorageRootDiskWatched(t *testing.T) {
	storageRoot := fakeHost + "/state/databases"
	mounts := mountsAt(
		[2]string{"/", "/dev/sda1"},
		[2]string{storageRoot, "/dev/sdb1"},
		[2]string{storageRoot + "/storage/mnt/s1", "/dev/sdb1"},
	)
	AssignDiskRoles(mounts, DiskRolePaths{StateDirs: []string{fakeHost + "/state", storageRoot}, ManagedImageDirs: []string{storageRoot}})
	want := map[string]string{
		"/":                             DiskRoleOpfieldState,
		storageRoot:                     DiskRoleOpfieldState,
		storageRoot + "/storage/mnt/s1": DiskRoleManagedImage,
	}
	if got := rolesOf(mounts); !equalRoles(got, want) {
		t.Fatalf("roles = %v, want %v", got, want)
	}
}

// A loop device is an Opfield disk image wherever it is mounted, even where it
// would hold the state directory.
func TestAssignDiskRolesLoopDeviceAlwaysManagedImage(t *testing.T) {
	mounts := mountsAt([2]string{"/", "/dev/sda1"}, [2]string{fakeHost + "/state", "/dev/loop7"})
	AssignDiskRoles(mounts, DiskRolePaths{StateDirs: []string{fakeHost + "/state"}})
	if got := rolesOf(mounts); got[fakeHost+"/state"] != DiskRoleManagedImage || got["/"] != DiskRoleRoot {
		t.Fatalf("roles = %v", got)
	}
}

func TestAssignDiskRolesWithoutPaths(t *testing.T) {
	mounts := mountsAt([2]string{"/", "overlay"}, [2]string{"/data", "/dev/sdb"}, [2]string{"/data/img", "/dev/loop1"})
	AssignDiskRoles(mounts, DiskRolePaths{})
	want := map[string]string{"/": DiskRoleRoot, "/data": DiskRoleData, "/data/img": DiskRoleManagedImage}
	if got := rolesOf(mounts); !equalRoles(got, want) {
		t.Fatalf("roles = %v, want %v", got, want)
	}
}

// Docker's data root behind a symlink is found on the disk it points to.
func TestAssignDiskRolesResolvesSymlinks(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "disk2", "docker")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "docker-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	disk2, err := filepath.EvalSymlinks(filepath.Join(base, "disk2"))
	if err != nil {
		t.Fatal(err)
	}
	mounts := mountsAt([2]string{"/", "/dev/sda1"}, [2]string{disk2, "/dev/sdb1"})
	AssignDiskRoles(mounts, DiskRolePaths{DockerRoot: link})
	if got := rolesOf(mounts); got[disk2] != DiskRoleDockerRoot || got["/"] != DiskRoleRoot {
		t.Fatalf("roles = %v", got)
	}
}

func TestRootDiskMountFromStatfs(t *testing.T) {
	mount := rootDiskMountFromStatfs(&unix.Statfs_t{Blocks: 1000, Bavail: 250, Bsize: 4096})
	if mount == nil || mount.MountPoint != "/" || mount.Role != DiskRoleRoot || mount.Device != "" || mount.Filesystem != "" {
		t.Fatalf("root mount = %+v", mount)
	}
	if mount.TotalBytes != 1000*4096 || mount.FreeBytes != 250*4096 || mount.UsedBytes != 750*4096 || mount.UsagePercent != 75 {
		t.Fatalf("root mount sizes = %+v", mount)
	}
	if rootDiskMountFromStatfs(&unix.Statfs_t{}) != nil {
		t.Fatal("a root filesystem without blocks gave a mount")
	}
}

func equalRoles(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	for key, value := range want {
		if got[key] != value {
			return false
		}
	}
	return true
}
