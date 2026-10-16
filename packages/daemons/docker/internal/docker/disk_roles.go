package docker

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"time"

	mobyclient "github.com/moby/moby/client"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
	builderruntime "github.com/opfield/opfield/docker-daemon/internal/builder"
)

// dockerRootRefresh is how often Docker's data root is looked up again: it
// changes only when dockerd restarts with another data-root.
const dockerRootRefresh = 10 * time.Minute

// dockerRootCache keeps Docker's data root (docker info DockerRootDir) for
// the health report, which must not wait on dockerd: a stale value is looked
// up again in the background.
type dockerRootCache struct {
	mu         sync.Mutex
	dir        string
	checkedAt  time.Time
	refreshing bool
}

// current is the last data root found (empty before the first lookup ends),
// starting a lookup in the background when it is older than dockerRootRefresh.
func (c *dockerRootCache) current(now time.Time, lookup func() (string, error)) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.refreshing && (c.checkedAt.IsZero() || now.Sub(c.checkedAt) >= dockerRootRefresh) {
		c.refreshing = true
		go c.refresh(lookup)
	}
	return c.dir
}

// refresh looks the data root up now; a failed lookup keeps the last one.
func (c *dockerRootCache) refresh(lookup func() (string, error)) {
	dir, err := lookup()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshing = false
	c.checkedAt = time.Now()
	if err == nil && dir != "" {
		c.dir = filepath.Clean(dir)
	}
}

func (p *DockerPlugin) lookupDockerRoot() (string, error) {
	if p.client == nil || p.client.cli == nil {
		return "", errors.New("no Docker client")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := p.client.cli.Info(ctx, mobyclient.InfoOptions{})
	if err != nil {
		return "", err
	}
	return info.Info.DockerRootDir, nil
}

// DiskRolePaths names where this node keeps data besides the daemon's state
// directory, for the roles of the disk mounts in its health report: Docker's
// data root, the managed storage root, and the directories of Opfield's disk
// images (managed databases, storage and disk-image volumes), whose mounts the
// built-in disk alert skips. A build worker has no Docker Engine; its BuildKit
// and containerd directories hold its builds.
func (p *DockerPlugin) DiskRolePaths() sysmetrics.DiskRolePaths {
	var paths sysmetrics.DiskRolePaths
	if p.cfg == nil {
		return paths
	}
	if p.cfg.Docker.Mode == "builder" {
		paths.StateDirs = []string{builderruntime.DefaultBuildkitStateDir, builderruntime.DefaultContainerdRootDir}
		return paths
	}
	paths.DockerRoot = p.dockerRoot.current(time.Now(), p.lookupDockerRoot)
	if root := p.cfg.Docker.Database.StorageRoot; root != "" {
		paths.StateDirs = append(paths.StateDirs, root)
		paths.ManagedImageDirs = append(paths.ManagedImageDirs, root)
	}
	if p.cfg.StateDir != "" {
		paths.ManagedImageDirs = append(paths.ManagedImageDirs, filepath.Join(p.cfg.StateDir, "volume-images"))
	}
	return paths
}
