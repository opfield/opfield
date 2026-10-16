package docker

import (
	"context"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

// Docker keeps a removed container's anonymous volumes (an image VOLUME, a bare "-v /path"), and nothing reaches
// them afterwards. When Opfield removes a container for good (a replaced or removed deployment slot or router, an
// Availability placement, a create that failed halfway, a Compose project taken down) it removes them too. A recreate
// is no such removal: it carries the anonymous volumes over to the new container (preservedVolumeMounts).
//
// A volume stays when another container uses it, when it carries the housekeeping protection label or Opfield's
// managed-volume label, when it is not on the local driver, and when the container's mount list names it (a volume
// chosen by name is the user's, even with a Docker-generated name). Named volumes are never touched.

const (
	housekeepingProtectedLabel = "opfield.housekeeping.protected"
	// legacy-name: the protection label before the Opfield rename; kept as long as volumes may carry it.
	legacyHousekeepingProtectedLabel = "gateway.housekeeping.protected"

	anonymousVolumeCleanupTimeout = 30 * time.Second
)

// containerAnonymousVolumes lists the anonymous volumes an inspected container mounts that are its own: a volume
// mount with a Docker-generated name that the container's mount list (HostConfig.Binds) does not name.
func containerAnonymousVolumes(insp *container.InspectResponse) []string {
	if insp == nil {
		return nil
	}
	named := map[string]bool{}
	if insp.HostConfig != nil {
		for _, bind := range insp.HostConfig.Binds {
			if source, _, found := strings.Cut(bind, ":"); found && isAnonymousVolumeName(source) {
				named[strings.TrimSpace(source)] = true
			}
		}
	}
	seen := map[string]bool{}
	var names []string
	for _, point := range insp.Mounts {
		if point.Type != mount.TypeVolume || !isAnonymousVolumeName(point.Name) {
			continue
		}
		if point.Driver != "" && point.Driver != "local" {
			continue
		}
		if named[point.Name] || seen[point.Name] {
			continue
		}
		seen[point.Name] = true
		names = append(names, point.Name)
	}
	return names
}

// anonymousVolumeRemovable reports whether an inspected volume may go with the container that created it.
func anonymousVolumeRemovable(v volume.Volume) bool {
	if !isAnonymousVolumeName(v.Name) {
		return false
	}
	if v.Driver != "" && v.Driver != "local" {
		return false
	}
	for _, key := range []string{housekeepingProtectedLabel, legacyHousekeepingProtectedLabel} {
		if value, ok := v.Labels[key]; ok && !strings.EqualFold(strings.TrimSpace(value), "false") {
			return false
		}
	}
	if value, ok := labelLookup(v.Labels, managedVolumeLabel); ok && strings.TrimSpace(value) != "" && value != "false" {
		return false
	}
	return true
}

// RemoveContainerAndAnonymousVolumes removes a container for good, then the anonymous volumes no other container
// uses. A volume that cannot be removed is logged; it never fails the removal that already happened.
func (c *Client) RemoveContainerAndAnonymousVolumes(ctx context.Context, ref string, force bool) error {
	var anonymous []string
	if inspected, err := c.cli.ContainerInspect(ctx, ref, client.ContainerInspectOptions{}); err == nil {
		anonymous = containerAnonymousVolumes(&inspected.Container)
	}
	if err := c.RemoveContainer(ctx, ref, force); err != nil {
		return err
	}
	c.removeOrphanedAnonymousVolumes(ctx, anonymous)
	return nil
}

// removeOrphanedAnonymousVolumes removes each listed anonymous volume that no container uses and that is not
// protected. It runs on its own deadline: the container it belonged to is already gone.
func (c *Client) removeOrphanedAnonymousVolumes(ctx context.Context, names []string) {
	if len(names) == 0 {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), anonymousVolumeCleanupTimeout)
	defer cancel()
	for _, name := range names {
		removed, err := c.removeOrphanedAnonymousVolume(cleanupCtx, name)
		switch {
		case err != nil:
			if c.logger != nil {
				c.logger.Warn("remove an anonymous volume of a removed container", "volume", name, "error", err)
			}
		case removed:
			if c.logger != nil {
				c.logger.Info("removed an anonymous volume of a removed container", "volume", name)
			}
		}
	}
}

func (c *Client) removeOrphanedAnonymousVolume(ctx context.Context, name string) (bool, error) {
	inspected, err := c.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, err
	}
	if !anonymousVolumeRemovable(inspected.Volume) {
		return false, nil
	}
	used, err := c.volumeInUse(ctx, name)
	if err != nil {
		return false, err
	}
	if used {
		return false, nil
	}
	// force=false: Docker still refuses a volume a container started using meanwhile.
	if _, err := c.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
