package docker

import (
	"path/filepath"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
)

// knownImageMount is a disk image this daemon mounts for an instance: a
// managed database or storage, or a disk-image volume.
type knownImageMount struct {
	imagePath string
	mountPath string
}

// knownImageMounts lists the disk images of the instances this daemon runs,
// from their records on disk (no manager lock, no Docker call: the health
// report must not wait on either).
func (p *DockerPlugin) knownImageMounts() []knownImageMount {
	var known []knownImageMount
	add := func(imagePath, mountPath string) {
		if imagePath != "" && mountPath != "" {
			known = append(known, knownImageMount{imagePath: imagePath, mountPath: mountPath})
		}
	}
	if p.databaseManager != nil {
		if records, _, err := p.databaseManager.records(); err == nil {
			for _, record := range records {
				if !record.Deleting {
					add(record.ImagePath, record.MountPath)
				}
			}
		}
	}
	if p.storageManager != nil {
		if records, _, err := p.storageManager.records(); err == nil {
			for _, record := range records {
				if !record.Removed {
					add(record.ImagePath, record.MountPath)
				}
			}
		}
	}
	if p.volumeImages != nil && p.volumeImages.supported {
		if records, err := p.volumeImages.records(); err == nil {
			for _, record := range records {
				if !record.Deleting {
					add(record.ImagePath, record.MountPath)
				}
			}
		}
	}
	return known
}

// completeManagedImageMounts makes the report list the disk of every instance
// the daemon runs (F-11: storage-1's report once listed 4 of its 8 instance
// disks). A known instance mount the generic enumeration did not list is added
// as managed_image, measured with statfs, when the visible mount at its path
// is a loop device bound to that instance's image: never the parent
// filesystem of an instance that is not mounted, nor another image.
func completeManagedImageMounts(mounts []*pb.DiskMount, known []knownImageMount, host *loopHost, measure func(mountPoint, fsType, device string) (*pb.DiskMount, bool)) []*pb.DiskMount {
	listed := make(map[string]bool, len(mounts))
	for _, mount := range mounts {
		if mount != nil {
			listed[filepath.Clean(mount.MountPoint)] = true
		}
	}
	var missing []knownImageMount
	for _, image := range known {
		if !listed[canonicalLoopPath(image.mountPath)] {
			missing = append(missing, image)
		}
	}
	if len(missing) == 0 {
		return mounts
	}
	table, err := host.mounts()
	if err != nil {
		return mounts
	}
	loops, err := host.loops()
	if err != nil {
		return mounts
	}
	visible := make(map[string]mountEntry, len(table))
	for _, entry := range table {
		visible[entry.MountPoint] = entry // the last entry is the visible one
	}
	byNumber := make(map[string]loopDevice, len(loops))
	for _, loop := range loops {
		byNumber[loop.Number] = loop
	}
	for _, image := range missing {
		mountPath := canonicalLoopPath(image.mountPath)
		if listed[mountPath] {
			continue
		}
		entry, ok := visible[mountPath]
		if !ok {
			continue
		}
		loop, ok := byNumber[entry.Number]
		if !ok || loop.Deleted || loop.BackingFile != canonicalLoopPath(image.imagePath) {
			continue
		}
		mount, ok := measure(mountPath, entry.FSType, loop.Path)
		if !ok {
			continue
		}
		mount.Role = sysmetrics.DiskRoleManagedImage
		mounts = append(mounts, mount)
		listed[mountPath] = true
	}
	return mounts
}
