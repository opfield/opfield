package docker

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"strings"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/mount"
)

// A recreate builds the new container from the inspected one. Docker reports the image's VOLUME declarations in
// Config.Volumes and the anonymous volumes it created for them in Mounts; the volumes a recreate keeps are re-attached
// by name through HostConfig.Mounts (preservedVolumeMounts). Neither may outlive the mount list they came from: a
// mount list given with a recreate replaces every bind and volume, and an old image's VOLUME never reaches the new
// container. Docker refuses a create whose binds and HostConfig.Mounts share a destination ("Duplicate mount point").

// recreateMount is one entry of the mount list a recreate replaces the container's mounts with.
type recreateMount struct {
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
	Name          string `json:"name"`
	ReadOnly      bool   `json:"readOnly"`
}

// anonymousVolumeNamePattern is the name Docker gives an anonymous volume.
var anonymousVolumeNamePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func isAnonymousVolumeName(name string) bool {
	return anonymousVolumeNamePattern.MatchString(strings.TrimSpace(name))
}

// replaceRecreateMounts makes the requested list the container's binds and volumes. Binds and volume mounts of
// HostConfig.Mounts (an anonymous volume an earlier recreate re-attached, or one a docker CLI --mount created) were
// part of the list the request replaces and are dropped; other HostConfig mounts (tmpfs) stay unless a listed mount
// takes their path. The container's anonymous volumes stay candidates for re-attachment: keepImageVolumeMounts keeps
// those the new image declares a VOLUME for, and preservedVolumeMounts skips any path a listed mount takes.
func replaceRecreateMounts(insp *container.InspectResponse, mounts []recreateMount) {
	var binds []string
	for _, m := range mounts {
		source := m.HostPath
		if source == "" {
			source = m.Name
		}
		if source == "" {
			continue
		}
		bind := source + ":" + m.ContainerPath
		if m.ReadOnly {
			bind += ":ro"
		}
		binds = append(binds, bind)
	}
	var anonymous []container.MountPoint
	for _, point := range insp.Mounts {
		if point.Type == mount.TypeVolume && isAnonymousVolumeName(point.Name) {
			anonymous = append(anonymous, point)
		}
	}
	insp.HostConfig.Binds = binds
	listed, _ := explicitMountCoverage(&container.HostConfig{Binds: binds})
	var kept []mount.Mount
	for _, configured := range insp.HostConfig.Mounts {
		if configured.Type == mount.TypeVolume || configured.Type == mount.TypeBind || listed[cleanMountDestination(configured.Target)] {
			continue
		}
		kept = append(kept, configured)
	}
	insp.HostConfig.Mounts = kept
	insp.Mounts = anonymous
}

// keepImageVolumeMounts keeps the anonymous volumes whose path the image declares a VOLUME for: Docker would attach
// a new empty one there, so the existing one is re-attached. An anonymous volume the image no longer declares, and
// that the mount list left out, is not attached again. When the image cannot be inspected every one is kept.
func (c *Client) keepImageVolumeMounts(ctx context.Context, imageRef string, points []container.MountPoint) []container.MountPoint {
	if len(points) == 0 || strings.TrimSpace(imageRef) == "" {
		return points
	}
	inspected, err := c.cli.ImageInspect(ctx, imageRef)
	if err != nil {
		if c.logger != nil {
			c.logger.Warn("inspect image for its volumes; keeping anonymous volumes attached", "image", imageRef, "error", err)
		}
		return points
	}
	declared := map[string]bool{}
	if inspected.Config != nil {
		for destination := range inspected.Config.Volumes {
			declared[cleanMountDestination(destination)] = true
		}
	}
	var kept []container.MountPoint
	for _, point := range points {
		if declared[cleanMountDestination(point.Destination)] {
			kept = append(kept, point)
		}
	}
	return kept
}

// withoutDuplicateMountTargets drops the HostConfig mounts whose path a bind, a tmpfs or an earlier HostConfig mount
// already takes: Docker refuses such a create. Binds are the container's explicit mount list and win; a HostConfig
// mount at their path is a carried-over volume (an anonymous one a recreate before 2.12.3 kept). It returns the kept
// mounts and the dropped ones.
func withoutDuplicateMountTargets(hostConfig *container.HostConfig) ([]mount.Mount, []mount.Mount) {
	if hostConfig == nil || len(hostConfig.Mounts) == 0 {
		return nil, nil
	}
	taken := map[string]bool{}
	for _, bind := range hostConfig.Binds {
		if destination := bindDestination(bind); destination != "" {
			taken[destination] = true
		}
	}
	for destination := range hostConfig.Tmpfs {
		if cleaned := cleanMountDestination(destination); cleaned != "" {
			taken[cleaned] = true
		}
	}
	kept := make([]mount.Mount, 0, len(hostConfig.Mounts))
	var dropped []mount.Mount
	for _, configured := range hostConfig.Mounts {
		target := cleanMountDestination(configured.Target)
		if target != "" && taken[target] {
			dropped = append(dropped, configured)
			continue
		}
		if target != "" {
			taken[target] = true
		}
		kept = append(kept, configured)
	}
	return kept, dropped
}

// bindDestination is the container path of a bind ("source:/path[:mode]", or "/path" alone).
func bindDestination(bind string) string {
	parts := strings.Split(bind, ":")
	if len(parts) == 1 {
		return cleanMountDestination(parts[0])
	}
	return cleanMountDestination(parts[1])
}

var duplicateMountPointPattern = regexp.MustCompile(`(?i)duplicate mount point:?\s*(\S+)`)

// describeDuplicateMountError names the mounts that take the path Docker reports a duplicate mount point for, and
// where each comes from. Any other error is returned as it is.
func describeDuplicateMountError(err error, hostConfig *container.HostConfig) error {
	if err == nil || hostConfig == nil {
		return err
	}
	match := duplicateMountPointPattern.FindStringSubmatch(err.Error())
	if match == nil {
		return err
	}
	target := cleanMountDestination(strings.TrimRight(match[1], ".,;\"'"))
	var colliding []string
	for _, bind := range hostConfig.Binds {
		if bindDestination(bind) != target {
			continue
		}
		source, _, _ := strings.Cut(bind, ":")
		if strings.HasPrefix(source, "/") {
			colliding = append(colliding, fmt.Sprintf("host path %s (mount list)", source))
		} else {
			colliding = append(colliding, fmt.Sprintf("%s (mount list)", describeVolumeName(source)))
		}
	}
	for _, configured := range hostConfig.Mounts {
		if cleanMountDestination(configured.Target) != target {
			continue
		}
		switch configured.Type {
		case mount.TypeVolume:
			colliding = append(colliding, fmt.Sprintf("%s (kept from the previous container)", describeVolumeName(configured.Source)))
		case mount.TypeBind:
			colliding = append(colliding, fmt.Sprintf("host path %s (kept from the previous container)", configured.Source))
		default:
			colliding = append(colliding, fmt.Sprintf("%s mount (kept from the previous container)", configured.Type))
		}
	}
	for destination := range hostConfig.Tmpfs {
		if cleanMountDestination(destination) == target {
			colliding = append(colliding, "tmpfs")
		}
	}
	if len(colliding) < 2 {
		return err
	}
	return fmt.Errorf("%w: %s mount at %s; a path takes one mount, so keep only one of them in the container's mounts",
		err, strings.Join(colliding, " and "), target)
}

func describeVolumeName(name string) string {
	if isAnonymousVolumeName(name) {
		return "anonymous volume " + name[:12]
	}
	return fmt.Sprintf("volume %q", name)
}

// dropInheritedExposedPorts removes the ports the previous image exposed and nothing publishes: Docker adds the new
// image's own, so a port only the old image exposed would otherwise stay exposed.
func dropInheritedExposedPorts(config *container.Config, hostConfig *container.HostConfig, previousImage *image.InspectResponse) {
	if config == nil || len(config.ExposedPorts) == 0 || previousImage == nil || previousImage.Config == nil {
		return
	}
	for port := range config.ExposedPorts {
		if _, fromImage := previousImage.Config.ExposedPorts[port.String()]; !fromImage {
			continue
		}
		if hostConfig != nil && len(hostConfig.PortBindings[port]) > 0 {
			continue
		}
		delete(config.ExposedPorts, port)
	}
}

// dropReplacedImageDefaults clears what the container inherited from its current image when nextImageRef is another
// image (a new tag, or a newer image under the same tag), so the new image's defaults apply. It returns the env
// overrides without the ones that only restate an inherited default.
func (c *Client) dropReplacedImageDefaults(ctx context.Context, insp *container.InspectResponse, nextImageRef string, envOverrides map[string]string) map[string]string {
	previousImage := c.replacedImageConfig(ctx, insp.Image, nextImageRef)
	if previousImage == nil {
		return envOverrides
	}
	dropInheritedExposedPorts(insp.Config, insp.HostConfig, previousImage)
	return dropInheritedImageDefaults(insp.Config, previousImage, envOverrides)
}

// duplicateVolumes gives a copy its own anonymous volumes. An anonymous volume the source mounts by name (one a
// recreate re-attached, or one its mount list names) would otherwise be shared by both containers. Its path is
// declared in Volumes instead, so Docker creates a new one for the copy, as it does at the image's VOLUME paths.
func duplicateVolumes(volumes map[string]struct{}, hostConfig *container.HostConfig) map[string]struct{} {
	if hostConfig == nil {
		return volumes
	}
	volumes = maps.Clone(volumes)
	declare := func(target string) {
		if volumes == nil {
			volumes = map[string]struct{}{}
		}
		volumes[target] = struct{}{}
	}
	var binds []string
	for _, bind := range hostConfig.Binds {
		if source, _, _ := strings.Cut(bind, ":"); isAnonymousVolumeName(source) {
			declare(bindDestination(bind))
			continue
		}
		binds = append(binds, bind)
	}
	var mounts []mount.Mount
	for _, configured := range hostConfig.Mounts {
		if configured.Type == mount.TypeVolume && isAnonymousVolumeName(configured.Source) {
			declare(cleanMountDestination(configured.Target))
			continue
		}
		mounts = append(mounts, configured)
	}
	hostConfig.Binds, hostConfig.Mounts = binds, mounts
	return volumes
}
