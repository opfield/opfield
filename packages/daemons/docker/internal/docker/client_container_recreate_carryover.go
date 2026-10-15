package docker

import (
	"context"
	"path"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"
)

// recreateRollbackTimeout bounds the rollback that restores the original
// container after a failed recreate. The rollback deliberately does not
// inherit the task context: a cancelled or expired task must never leave the
// container deleted.
const recreateRollbackTimeout = 2 * time.Minute

func recreateRollbackContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), recreateRollbackTimeout)
}

// preservedVolumeMounts returns a volume mount for every volume the container
// had attached without an explicit bind, HostConfig mount or tmpfs covering
// the same destination. Those are anonymous volumes (image VOLUME
// declarations or bare `-v /path` specs); Docker would otherwise attach a new
// empty anonymous volume at the same path when the container is recreated.
// Like compose, the existing volume is re-attached by name at the same
// destination with the same read/write mode.
func preservedVolumeMounts(insp *container.InspectResponse) []mount.Mount {
	if insp == nil || len(insp.Mounts) == 0 {
		return nil
	}
	coveredDestinations, referencedVolumes := explicitMountCoverage(insp.HostConfig)
	var preserved []mount.Mount
	for _, point := range insp.Mounts {
		if point.Type != mount.TypeVolume || strings.TrimSpace(point.Name) == "" {
			continue
		}
		destination := cleanMountDestination(point.Destination)
		if destination == "" || coveredDestinations[destination] || referencedVolumes[point.Name] {
			continue
		}
		coveredDestinations[destination] = true
		preserved = append(preserved, mount.Mount{
			Type:     mount.TypeVolume,
			Source:   point.Name,
			Target:   point.Destination,
			ReadOnly: !point.RW,
		})
	}
	return preserved
}

func explicitMountCoverage(hostConfig *container.HostConfig) (map[string]bool, map[string]bool) {
	destinations := map[string]bool{}
	volumes := map[string]bool{}
	if hostConfig == nil {
		return destinations, volumes
	}
	for _, bind := range hostConfig.Binds {
		parts := strings.Split(bind, ":")
		if len(parts) == 1 {
			if destination := cleanMountDestination(parts[0]); destination != "" {
				destinations[destination] = true
			}
			continue
		}
		if destination := cleanMountDestination(parts[1]); destination != "" {
			destinations[destination] = true
		}
		if source := strings.TrimSpace(parts[0]); source != "" && !strings.HasPrefix(source, "/") {
			volumes[source] = true
		}
	}
	for _, configured := range hostConfig.Mounts {
		if destination := cleanMountDestination(configured.Target); destination != "" {
			destinations[destination] = true
		}
		if configured.Type == mount.TypeVolume && strings.TrimSpace(configured.Source) != "" {
			volumes[configured.Source] = true
		}
	}
	for destination := range hostConfig.Tmpfs {
		if cleaned := cleanMountDestination(destination); cleaned != "" {
			destinations[cleaned] = true
		}
	}
	return destinations, volumes
}

func cleanMountDestination(destination string) string {
	destination = strings.TrimSpace(destination)
	if destination == "" {
		return ""
	}
	return path.Clean(destination)
}

// replacedImageConfig returns the configuration of the container's current
// image when nextImageRef resolves to a different local image. It returns nil
// when the image does not change or either image cannot be inspected, in
// which case the container keeps its inherited configuration as before.
func (c *Client) replacedImageConfig(ctx context.Context, currentImageID string, nextImageRef string) *image.InspectResponse {
	currentImageID = strings.TrimSpace(currentImageID)
	nextImageRef = strings.TrimSpace(nextImageRef)
	if currentImageID == "" || nextImageRef == "" {
		return nil
	}
	next, err := c.cli.ImageInspect(ctx, nextImageRef)
	if err != nil {
		if c.logger != nil {
			c.logger.Warn("inspect replacement image; keeping inherited container config", "image", nextImageRef, "error", err)
		}
		return nil
	}
	if next.ID != "" && next.ID == currentImageID {
		return nil
	}
	current, err := c.cli.ImageInspect(ctx, currentImageID)
	if err != nil {
		if c.logger != nil {
			c.logger.Warn("inspect previous image; keeping inherited container config", "image", currentImageID, "error", err)
		}
		return nil
	}
	if current.ID != "" && current.ID == next.ID {
		return nil
	}
	return &current.InspectResponse
}

// dropInheritedImageDefaults clears container config values that equal the
// previous image's defaults, so the replacement image's defaults apply.
// Values that differ from the previous image's defaults were set explicitly
// and are kept. Env overrides that merely restate an inherited default
// (unchanged from the running container) are dropped as well; the filtered
// overrides are returned.
func dropInheritedImageDefaults(
	config *container.Config,
	previousImage *image.InspectResponse,
	envOverrides map[string]string,
) map[string]string {
	if config == nil || previousImage == nil || previousImage.Config == nil {
		return envOverrides
	}
	previous := previousImage.Config

	previousEnv := envListToValueMap(previous.Env)
	currentEnv := envListToValueMap(config.Env)
	inherited := make(map[string]bool, len(previous.Env))
	for _, entry := range previous.Env {
		inherited[entry] = true
	}
	env := make([]string, 0, len(config.Env))
	for _, entry := range config.Env {
		if inherited[entry] {
			continue
		}
		env = append(env, entry)
	}
	config.Env = env

	var overrides map[string]string
	if envOverrides != nil {
		overrides = make(map[string]string, len(envOverrides))
		for key, value := range envOverrides {
			previousValue, hadDefault := previousEnv[key]
			currentValue, hadCurrent := currentEnv[key]
			if hadDefault && hadCurrent && value == previousValue && value == currentValue {
				continue
			}
			overrides[key] = value
		}
	}

	// Docker only inherits the image Cmd when the container has no explicit
	// entrypoint, so a Cmd next to a custom entrypoint was set explicitly.
	entrypointInherited := slices.Equal(config.Entrypoint, previous.Entrypoint)
	if (entrypointInherited || len(config.Entrypoint) == 0) && slices.Equal(config.Cmd, previous.Cmd) {
		config.Cmd = nil
	}
	if entrypointInherited {
		config.Entrypoint = nil
	}
	if config.WorkingDir == previous.WorkingDir {
		config.WorkingDir = ""
	}
	if config.User == previous.User {
		config.User = ""
	}
	if config.StopSignal == previous.StopSignal {
		config.StopSignal = ""
	}
	if config.Healthcheck != nil && previous.Healthcheck != nil && reflect.DeepEqual(*config.Healthcheck, *previous.Healthcheck) {
		config.Healthcheck = nil
	}
	if len(config.Labels) > 0 {
		for key, value := range previous.Labels {
			if strings.HasPrefix(key, labelPrefix) || isLegacyLabelKey(key) {
				continue
			}
			if current, ok := config.Labels[key]; ok && current == value {
				delete(config.Labels, key)
			}
		}
	}
	return overrides
}

func envListToValueMap(entries []string) map[string]string {
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	return values
}

// removeContainerQuietly removes a partially created container with a fresh
// bounded context, so a cancelled task cannot leave a half-created container
// behind that would block the rollback from reusing its name.
func (c *Client) removeContainerQuietly(ctx context.Context, id string) {
	cleanupCtx, cancel := recreateRollbackContext(ctx)
	defer cancel()
	_, _ = c.cli.ContainerRemove(cleanupCtx, id, client.ContainerRemoveOptions{Force: true})
}
