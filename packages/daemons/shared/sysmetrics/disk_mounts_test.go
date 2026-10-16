package sysmetrics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"golang.org/x/sys/unix"
)

// fakeMountHost answers stat and statfs for the mount points of a mount
// table fixture: each mount point has a device and a filesystem id.
type fakeMountHost struct {
	devs  map[string]uint64
	fsids map[string]unix.Fsid
	// interrupted is how many statfs calls of a path fail with EINTR first.
	interrupted map[string]int
	files       map[string]bool
}

func (h *fakeMountHost) probe(machineID string) mountProbe {
	return mountProbe{
		machineID: machineID,
		stat: func(path string) (bool, uint64, error) {
			dev, ok := h.devs[path]
			if !ok {
				return false, 0, os.ErrNotExist
			}
			return !h.files[path], dev, nil
		},
		statfs: func(path string, stat *unix.Statfs_t) error {
			if h.interrupted[path] > 0 {
				h.interrupted[path]--
				return unix.EINTR
			}
			if _, ok := h.devs[path]; !ok {
				return unix.ENOENT
			}
			*stat = unix.Statfs_t{Blocks: 1000, Bavail: 250, Bsize: 4096, Fsid: h.fsids[path]}
			return nil
		},
	}
}

func mountPoints(mounts []*pb.DiskMount) []string {
	points := make([]string, 0, len(mounts))
	for _, mount := range mounts {
		points = append(points, mount.MountPoint)
	}
	return points
}

// storage-1 (F-11): its report listed the instance disks mounted before the
// first Docker overlay lines and lost every one after them. A line over the
// 64 KiB a bufio.Scanner takes stopped the scan there.
func TestDiskMountsKeepEveryMountAfterAVeryLongLine(t *testing.T) {
	host := &fakeMountHost{devs: map[string]uint64{"/": 1}, fsids: map[string]unix.Fsid{}}
	var table strings.Builder
	table.WriteString("rpool/data/subvol-1133-disk-0 / zfs rw,relatime,xattr,posixacl 0 0\n")
	table.WriteString("none /dev/loop1 tmpfs rw,relatime,size=492k,mode=755,uid=100000,gid=100000 0 0\n")
	table.WriteString("/dev/loop0 /var/lib/docker-daemon/databases/mounts/0c5f254b ext4 rw,relatime 0 0\n")
	host.devs["/var/lib/docker-daemon/databases/mounts/0c5f254b"] = 7<<8 | 0
	lower := strings.Repeat("/var/lib/docker/overlay2/l/ABCDEFGHIJKLMNOPQRSTUVWXYZ:", 1600)
	table.WriteString("overlay /var/lib/docker/overlay2/3e31/merged overlay rw,lowerdir=" + lower + ",upperdir=/u,workdir=/w 0 0\n")
	if line := strings.Split(table.String(), "\n")[3]; len(line) <= 64*1024 {
		t.Fatalf("fixture line is %d bytes, want over 64 KiB", len(line))
	}
	table.WriteString("nsfs /run/docker/netns/default nsfs rw 0 0\n")
	want := []string{"/", "/var/lib/docker-daemon/databases/mounts/0c5f254b"}
	for _, n := range []string{"1", "2", "6", "7"} {
		point := "/var/lib/docker-daemon/databases/mounts/after-" + n
		table.WriteString("/dev/loop" + n + " " + point + " ext4 rw,relatime 0 0\n")
		host.devs[point] = uint64(7<<8 | len(want))
		want = append(want, point)
	}
	got := mountPoints(diskMountsFromTable(table.String(), host.probe("m")))
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("mounts = %v, want %v", got, want)
	}
}

// A statfs a signal interrupted is tried again: the mount does not vanish
// from one report. A mount point the kernel escapes (a space) is measured
// under its real name.
func TestDiskMountsSurviveInterruptedStatfsAndEscapedPaths(t *testing.T) {
	host := &fakeMountHost{
		devs:        map[string]uint64{"/": 1, "/mnt/backup disk": 2, "/data": 3},
		fsids:       map[string]unix.Fsid{},
		interrupted: map[string]int{"/data": 2},
	}
	table := "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/backup\\040disk ext4 rw 0 0\n/dev/sdc1 /data xfs rw 0 0\n"
	got := mountPoints(diskMountsFromTable(table, host.probe("m")))
	if strings.Join(got, ",") != "/,/mnt/backup disk,/data" {
		t.Fatalf("mounts = %q", got)
	}
	// A statfs that keeps failing drops only that mount.
	host.interrupted["/data"] = statfsAttempts
	got = mountPoints(diskMountsFromTable(table, host.probe("m")))
	if strings.Join(got, ",") != "/,/mnt/backup disk" {
		t.Fatalf("mounts = %q", got)
	}
}

// A mount point mounted over shows its last mount, the one statfs measures:
// a disk image under the read-only placeholder of a volume is not reported
// with the placeholder's numbers, and a remounted image names its device.
func TestDiskMountsReportTheVisibleMountOfAMountPoint(t *testing.T) {
	host := &fakeMountHost{devs: map[string]uint64{"/": 1, "/v/a": 2, "/v/b": 3}, fsids: map[string]unix.Fsid{}}
	table := "/dev/sda1 / ext4 rw 0 0\n" +
		"/dev/loop3 /v/a ext4 rw 0 0\n" +
		"opfield-volume-placeholder /v/a tmpfs ro 0 0\n" +
		"/dev/loop4 /v/b ext4 rw 0 0\n" +
		"/dev/loop5 /v/b ext4 rw 0 0\n" +
		"/dev/sda1 /etc/hostname ext4 rw 0 0\n"
	host.devs["/etc/hostname"] = 1
	host.files = map[string]bool{"/etc/hostname": true}
	mounts := diskMountsFromTable(table, host.probe("m"))
	if got := mountPoints(mounts); strings.Join(got, ",") != "/,/v/b" {
		t.Fatalf("mounts = %v", got)
	}
	if mounts[1].Device != "/dev/loop5" || mounts[1].UsagePercent != 75 {
		t.Fatalf("/v/b = %+v", mounts[1])
	}
}

// O-1: the nginx, build, monitoring and relay daemons of one host report its
// disk with one id, so Opfield raises one alert for it.
func TestDiskIDNamesTheFilesystemOnItsHost(t *testing.T) {
	ext4 := unix.Fsid{Val: [2]int32{0x1234, -0x5678}}
	other := unix.Fsid{Val: [2]int32{0x1234, 0x9}}
	host := &fakeMountHost{
		devs:  map[string]uint64{"/": 2049, "/srv/bind": 2049, "/data": 2065},
		fsids: map[string]unix.Fsid{"/": ext4, "/srv/bind": ext4, "/data": other},
	}
	table := "/dev/sda1 / ext4 rw 0 0\n/dev/sda1 /srv/bind ext4 rw 0 0\n/dev/sdb1 /data ext4 rw 0 0\n"
	mounts := diskMountsFromTable(table, host.probe("4f1c0e5a9b2d4c7e8f00112233445566"))
	if len(mounts) != 3 {
		t.Fatalf("mounts = %v", mountPoints(mounts))
	}
	root, bind, data := mounts[0].DiskId, mounts[1].DiskId, mounts[2].DiskId
	if len(root) != 32 || root != bind {
		t.Fatalf("two mounts of one filesystem: %q, %q", root, bind)
	}
	if data == root || data == "" {
		t.Fatalf("another filesystem: %q, root %q", data, root)
	}
	// The same id from every daemon of the host, never from another host.
	if again := diskMountsFromTable(table, host.probe("4f1c0e5a9b2d4c7e8f00112233445566")); again[0].DiskId != root {
		t.Fatalf("second report: %q, first %q", again[0].DiskId, root)
	}
	if elsewhere := diskMountsFromTable(table, host.probe("another-host")); elsewhere[0].DiskId == root {
		t.Fatal("another host's disk has the same id")
	}
	// Two filesystems sharing an fsid on one host still differ by device.
	if DiskID("m", ext4, 1) == DiskID("m", ext4, 2) {
		t.Fatal("st_dev is not part of the id")
	}
	// No machine id: no disk id, Opfield alerts per node as before.
	for _, mount := range diskMountsFromTable(table, host.probe("")) {
		if mount.DiskId != "" {
			t.Fatalf("disk id without a machine id: %+v", mount)
		}
	}
}

func TestReadMachineIDFallsBackToDBus(t *testing.T) {
	dir := t.TempDir()
	systemd, dbus := filepath.Join(dir, "machine-id"), filepath.Join(dir, "dbus-machine-id")
	if got := readMachineID([]string{systemd, dbus}); got != "" {
		t.Fatalf("no file: %q", got)
	}
	if err := os.WriteFile(dbus, []byte("abc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// An empty /etc/machine-id (an image before its first boot) is no id.
	if err := os.WriteFile(systemd, []byte("\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readMachineID([]string{systemd, dbus}); got != "abc" {
		t.Fatalf("machine id = %q", got)
	}
	if err := os.WriteFile(systemd, []byte("def\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readMachineID([]string{systemd, dbus}); got != "def" {
		t.Fatalf("machine id = %q", got)
	}
}

// The real mount table of the test host: every listed disk mount has a disk
// id when the host has a machine id, and the root disk is listed.
func TestGetDiskMountsOnThisHost(t *testing.T) {
	if _, err := os.Stat(mountTablePath); err != nil {
		t.Skip("no mount table")
	}
	machineID := hostMachineID()
	for _, mount := range GetDiskMounts() {
		if (mount.DiskId == "") != (machineID == "") {
			t.Fatalf("%s: disk id %q with machine id %q", mount.MountPoint, mount.DiskId, machineID)
		}
	}
	if _, ok := DiskMountAt(t.TempDir(), "ext4", "/dev/x"); !ok {
		t.Fatal("a directory could not be measured")
	}
	if _, ok := DiskMountAt(filepath.Join(t.TempDir(), "missing"), "ext4", "/dev/x"); ok {
		t.Fatal("a missing path was measured")
	}
}
