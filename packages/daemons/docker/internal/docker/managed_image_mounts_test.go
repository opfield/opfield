package docker

import (
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
)

// F-11: storage-1's report listed 4 of its 8 instance disks. Every instance
// disk the daemon runs is in the report, measured as a managed_image, also
// when the mount table enumeration missed it; never the parent filesystem of
// an instance that is not mounted, nor a mount of another image.
func TestCompleteManagedImageMountsAddsOnlyRealInstanceMounts(t *testing.T) {
	root := "/nonexistent-opfield-images" // not resolvable through the test host's symlinks
	image := func(id string) string { return filepath.Join(root, "images", id+".img") }
	mount := func(id string) string { return filepath.Join(root, "mounts", id) }
	known := []knownImageMount{
		{imagePath: image("listed"), mountPath: mount("listed")},
		{imagePath: image("missed"), mountPath: mount("missed")},
		{imagePath: image("unmounted"), mountPath: mount("unmounted")},
		{imagePath: image("swapped"), mountPath: mount("swapped")},
		{imagePath: image("deleted"), mountPath: mount("deleted")},
		{imagePath: image("covered"), mountPath: mount("covered")},
	}
	host := &loopHost{
		mounts: func() ([]mountEntry, error) {
			return []mountEntry{
				{MountPoint: "/", Number: "0:50", FSType: "zfs"},
				{MountPoint: mount("listed"), Number: "7:0", FSType: "ext4"},
				{MountPoint: mount("missed"), Number: "7:1", FSType: "ext4"},
				{MountPoint: mount("swapped"), Number: "7:2", FSType: "ext4"},
				{MountPoint: mount("deleted"), Number: "7:3", FSType: "ext4"},
				{MountPoint: mount("covered"), Number: "7:4", FSType: "ext4"},
				{MountPoint: mount("covered"), Number: "0:99", FSType: "tmpfs"},
			}, nil
		},
		loops: func() ([]loopDevice, error) {
			return []loopDevice{
				{Path: "/dev/loop0", Number: "7:0", BackingFile: image("listed")},
				{Path: "/dev/loop1", Number: "7:1", BackingFile: image("missed")},
				{Path: "/dev/loop2", Number: "7:2", BackingFile: image("another")},
				{Path: "/dev/loop3", Number: "7:3", BackingFile: image("deleted"), Deleted: true},
				{Path: "/dev/loop4", Number: "7:4", BackingFile: image("covered")},
			}, nil
		},
	}
	var measured []string
	measure := func(mountPoint, fsType, device string) (*pb.DiskMount, bool) {
		measured = append(measured, mountPoint)
		return &pb.DiskMount{MountPoint: mountPoint, Filesystem: fsType, Device: device, TotalBytes: 100, DiskId: "id"}, true
	}
	mounts := []*pb.DiskMount{
		{MountPoint: "/", Role: sysmetrics.DiskRoleRoot},
		{MountPoint: mount("listed"), Device: "/dev/loop0", Role: sysmetrics.DiskRoleManagedImage},
	}
	got := completeManagedImageMounts(mounts, known, host, measure)
	if len(got) != 3 || strings.Join(measured, ",") != mount("missed") {
		t.Fatalf("mounts = %v, measured %v", got, measured)
	}
	added := got[2]
	if added.MountPoint != mount("missed") || added.Device != "/dev/loop1" || added.Filesystem != "ext4" || added.Role != sysmetrics.DiskRoleManagedImage || added.DiskId != "id" {
		t.Fatalf("added = %+v", added)
	}

	// A complete report reads neither the mount table nor the loop devices.
	host.mounts = func() ([]mountEntry, error) { t.Fatal("mount table read"); return nil, nil }
	if again := completeManagedImageMounts(got, known[:2], host, measure); len(again) != 3 {
		t.Fatalf("mounts = %v", again)
	}
}
