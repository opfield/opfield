package docker

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

// Node housekeeping removes what a daemon crash or an interrupted operation leaves on a Docker node and nothing else
// removes: helper containers, env files of removed containers, and temporary files. It runs at start and then
// periodically; each part selects only objects this daemon creates, by label or by its own file names.

const (
	nodeHousekeepingInterval = 15 * time.Minute
	nodeHousekeepingTimeout  = 2 * time.Minute

	// helperContainerLabel marks a short-lived container the daemon runs for one operation and removes right after
	// (a volume file helper, the Compose sidecar). Its value names the kind.
	helperContainerLabel = labelPrefix + "helper"

	// An exited helper is removed this long after it finished; a created one that never started, this long after its
	// creation (an extension bundle is read from a created container that is never started).
	helperExitedMinAge  = 15 * time.Minute
	helperCreatedMinAge = time.Hour

	// envFileOrphanMinAge: the env file of a container that no longer exists goes after a day.
	envFileOrphanMinAge = 24 * time.Hour
	// staleTempMinAge: a temporary file or directory this old belongs to no running write.
	staleTempMinAge = time.Hour
)

// Helper kinds (helperContainerLabel values).
const (
	helperKindVolume           = "volume"
	helperKindComposeSidecar   = "compose-sidecar"
	helperKindExtensionBundle  = "postgres-extension-bundle"
	helperKindConnectorCleanup = "connector-cleanup"
	helperKindPostgres         = "postgres"
)

// helperContainerLabels are the labels of a helper of kind, merged into extra.
func helperContainerLabels(kind string, extra map[string]string) map[string]string {
	labels := make(map[string]string, len(extra)+1)
	for key, value := range extra {
		labels[key] = value
	}
	labels[helperContainerLabel] = kind
	return labels
}

// helperLabelFilters select the helper containers: the helper label, and the markers some helpers carried before it
// (so leftovers of an older daemon are found too).
var helperLabelFilters = []string{
	helperContainerLabel,
	"net.opfield.compose.sidecar=true",
	pgHelperLabel + "=1",
	"net.opfield.managed=" + connectorCleanLabel,
}

func (p *DockerPlugin) startNodeHousekeeping() {
	if p.client == nil {
		return
	}
	if removed := sweepStaleTempFiles(p.cfg.StateDir, os.TempDir(), time.Now()); len(removed) > 0 {
		p.logger.Info("removed stale temporary files", "count", len(removed), "paths", removed)
	}
	go p.runNodeHousekeeping(context.Background())
}

func (p *DockerPlugin) runNodeHousekeeping(ctx context.Context) {
	p.nodeHousekeepingPass(ctx)
	ticker := time.NewTicker(nodeHousekeepingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.nodeHousekeepingPass(ctx)
		}
	}
}

func (p *DockerPlugin) nodeHousekeepingPass(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, nodeHousekeepingTimeout)
	defer cancel()
	now := time.Now()
	if removed, err := p.client.removeStaleHelperContainers(ctx, now); err != nil {
		p.logger.Warn("remove leftover helper containers", "error", err)
	} else if len(removed) > 0 {
		p.logger.Info("removed leftover helper containers", "containers", removed)
	}
	if p.envStore != nil {
		if removed, err := p.removeOrphanedEnvFiles(ctx, now); err != nil {
			p.logger.Warn("remove env files of removed containers", "error", err)
		} else if len(removed) > 0 {
			p.logger.Info("removed env files of removed containers", "files", removed)
		}
	}
}

// removeStaleHelperContainers removes the helper containers that are no longer running and are past their age. A
// running, paused or restarting one is never touched.
func (c *Client) removeStaleHelperContainers(ctx context.Context, now time.Time) ([]string, error) {
	seen := map[string]bool{}
	var removed []string
	var errs []error
	for _, filter := range helperLabelFilters {
		listed, err := c.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
			All:     true,
			Filters: make(mobyclient.Filters).Add("label", filter),
		})
		if err != nil {
			return removed, err
		}
		for _, item := range listed.Items {
			if seen[item.ID] {
				continue
			}
			seen[item.ID] = true
			switch item.State {
			case container.StateExited, container.StateDead, container.StateCreated:
			default:
				continue
			}
			inspected, err := c.cli.ContainerInspect(ctx, item.ID, mobyclient.ContainerInspectOptions{})
			if err != nil {
				if !isNotFoundErr(err) {
					errs = append(errs, err)
				}
				continue
			}
			if !helperContainerStale(&inspected.Container, now) {
				continue
			}
			// RemoveVolumes takes only the volumes Docker created for the helper (an image VOLUME); a volume the
			// helper mounted by name stays.
			if _, err := c.cli.ContainerRemove(ctx, item.ID, mobyclient.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !isNotFoundErr(err) {
				errs = append(errs, err)
				continue
			}
			removed = append(removed, strings.TrimPrefix(inspected.Container.Name, "/"))
		}
	}
	return removed, errors.Join(errs...)
}

// helperContainerStale reports a helper that no operation can still be using.
func helperContainerStale(insp *container.InspectResponse, now time.Time) bool {
	if insp == nil || insp.State == nil {
		return false
	}
	created, _ := time.Parse(time.RFC3339Nano, insp.Created)
	switch insp.State.Status {
	case container.StateCreated:
		return !created.IsZero() && now.Sub(created) >= helperCreatedMinAge
	case container.StateExited, container.StateDead:
		finished, err := time.Parse(time.RFC3339Nano, insp.State.FinishedAt)
		if err != nil || finished.IsZero() || finished.Year() < 2000 {
			return !created.IsZero() && now.Sub(created) >= helperCreatedMinAge
		}
		return now.Sub(finished) >= helperExitedMinAge
	}
	return false
}

// removeContainerEnvFiles deletes the env files of a container Opfield removed.
func (p *DockerPlugin) removeContainerEnvFiles(containerName string) {
	if p.envStore == nil || containerName == "" {
		return
	}
	if err := p.envStore.Remove(containerName); err != nil {
		p.logger.Warn("remove the env files of a removed container", "container", containerName, "error", err)
	}
}

// removeOrphanedEnvFiles deletes the env files whose container no longer exists. Nothing is deleted when the
// container list is not available.
func (p *DockerPlugin) removeOrphanedEnvFiles(ctx context.Context, now time.Time) ([]string, error) {
	listed, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true})
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, item := range listed.Items {
		for _, name := range item.Names {
			existing[strings.TrimPrefix(name, "/")] = true
		}
		if len(item.ID) >= 12 {
			existing[item.ID[:12]] = true
		}
	}
	return p.envStore.RemoveOrphans(existing, envFileOrphanMinAge, now)
}

var (
	// atomicfile writes ".<name>.tmp-<random digits>" next to the file it replaces.
	atomicTempName = regexp.MustCompile(`^\..+\.tmp-[0-9]+$`)
	// statecompat writes "<name>.pending-<pid>".
	pendingTempName = regexp.MustCompile(`^.+\.pending-[0-9]+$`)
	// The runsc install work directory and the Compose staging directory (os.MkdirTemp in the system temp dir).
	tempDirectoryName = regexp.MustCompile(`^(opfield-runsc-install-|opfield-compose-)[0-9]+$`)
)

// staleTempWalkDepth bounds the state directory walk: the daemon's state files sit a few levels deep.
const staleTempWalkDepth = 6

// sweepStaleTempFiles removes, at daemon start, the temporary files a crash left: the atomic-write temporaries in
// the state directory and the runsc and Compose work directories in the system temp directory, each only when older
// than an hour. The walk stays on the state directory's filesystem, so it never enters a mounted instance disk.
func sweepStaleTempFiles(stateDir, tempDir string, now time.Time) []string {
	var removed []string
	if stateDir != "" {
		removed = append(removed, sweepStateDirTemps(stateDir, now)...)
	}
	if tempDir != "" {
		entries, err := os.ReadDir(tempDir)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() || !tempDirectoryName.MatchString(entry.Name()) {
					continue
				}
				info, err := entry.Info()
				if err != nil || now.Sub(info.ModTime()) < staleTempMinAge {
					continue
				}
				path := filepath.Join(tempDir, entry.Name())
				if os.RemoveAll(path) == nil {
					removed = append(removed, path)
				}
			}
		}
	}
	return removed
}

func sweepStateDirTemps(stateDir string, now time.Time) []string {
	root, err := os.Lstat(stateDir)
	if err != nil || !root.IsDir() {
		return nil
	}
	rootDevice, ok := fileDevice(root)
	if !ok {
		return nil
	}
	rootDepth := strings.Count(filepath.Clean(stateDir), string(filepath.Separator))
	var removed []string
	_ = filepath.WalkDir(stateDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			if path == stateDir {
				return nil
			}
			if strings.Count(filepath.Clean(path), string(filepath.Separator))-rootDepth >= staleTempWalkDepth {
				return fs.SkipDir
			}
			info, err := entry.Info()
			if err != nil {
				return fs.SkipDir
			}
			if device, ok := fileDevice(info); !ok || device != rootDevice {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		name := entry.Name()
		if !atomicTempName.MatchString(name) && !pendingTempName.MatchString(name) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < staleTempMinAge {
			return nil
		}
		if os.Remove(path) == nil {
			removed = append(removed, path)
		}
		return nil
	})
	return removed
}

func fileDevice(info fs.FileInfo) (uint64, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(stat.Dev), true //nolint:unconvert // Dev is int32 on darwin
}
