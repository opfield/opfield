package docker

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
)

// Containers whose json-file log has no max-size: those created before Opfield
// set log rotation (2.11.0), those created outside Opfield (`docker run`,
// another Compose) on a host whose daemon.json bounds nothing, and those whose
// own log options set none. Docker cannot change a container's log options
// without recreating it, and nothing rotates these logs, so one chatty
// container fills the disk. The daemon bounds them in place: once such a log
// is over containerLogMaxBytes (the 50 MB x 3 a workload Opfield creates may
// keep), its last containerLogKeepBytes stay and the rest goes. Docker writes
// the log O_APPEND, so it goes on at the new end; no restart, no recreate.

const (
	containerLogBudgetFirstRun = 2 * time.Minute
	containerLogBudgetInterval = time.Hour
	containerLogMaxBytes       = 150 << 20
	containerLogKeepBytes      = 10 << 20
)

func (p *DockerPlugin) runContainerLogBudget(ctx context.Context) {
	timer := time.NewTimer(containerLogBudgetFirstRun)
	defer timer.Stop()
	warned := map[string]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		p.boundContainerLogs(ctx, warned)
		timer.Reset(containerLogBudgetInterval)
	}
}

func (p *DockerPlugin) boundContainerLogs(ctx context.Context, warned map[string]bool) {
	if p.client == nil || p.client.cli == nil {
		return
	}
	listCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	listed, err := p.client.cli.ContainerList(listCtx, mobyclient.ContainerListOptions{All: true})
	cancel()
	if err != nil {
		return
	}
	for _, item := range listed.Items {
		inspectCtx, cancelInspect := context.WithTimeout(ctx, 10*time.Second)
		inspected, err := p.client.cli.ContainerInspect(inspectCtx, item.ID, mobyclient.ContainerInspectOptions{})
		cancelInspect()
		if err != nil || inspected.Container.HostConfig == nil {
			continue
		}
		if !unboundedJSONFileLog(inspected.Container.HostConfig.LogConfig) || inspected.Container.LogPath == "" {
			continue
		}
		name := strings.TrimPrefix(inspected.Container.Name, "/")
		freed, err := cutContainerLog(inspected.Container.LogPath, containerLogMaxBytes, containerLogKeepBytes)
		if err != nil {
			// One line per container and problem (a non-root daemon may not reach Docker's files).
			key := item.ID + ":" + err.Error()
			if !warned[key] {
				warned[key] = true
				p.logger.Warn("cannot bound the log of a container without log rotation", "container", name, "error", err)
			}
			continue
		}
		if freed > 0 {
			p.logger.Info("cut the log of a container without log rotation; recreate it from Opfield to rotate its log",
				"container", name, "freed_bytes", freed, "kept_bytes", containerLogKeepBytes)
		}
	}
}

// unboundedJSONFileLog: Docker keeps the json-file log of this configuration
// in one file that never rotates. Docker records the daemon's default options
// in the container's own at creation, so a host that bounds json-file in
// daemon.json shows max-size here too.
func unboundedJSONFileLog(cfg container.LogConfig) bool {
	return cfg.Type == jsonFileLogDriver && strings.TrimSpace(cfg.Config["max-size"]) == ""
}

// cutContainerLog keeps the last keepBytes (from the first whole line) of the
// log at path once it is over maxBytes, and returns the bytes freed.
func cutContainerLog(path string, maxBytes, keepBytes int64) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() <= maxBytes {
		return 0, nil
	}
	size := info.Size()
	tail, err := readLogTail(path, size, keepBytes)
	if err != nil {
		return 0, err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	if err := file.Truncate(0); err != nil {
		return 0, err
	}
	// O_APPEND: lines Docker wrote since the truncate stay before the kept tail.
	if _, err := file.Write(tail); err != nil {
		return 0, fmt.Errorf("restore the kept tail: %w", err)
	}
	return size - int64(len(tail)), nil
}

func readLogTail(path string, size, keepBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	start := size - keepBytes
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(io.LimitReader(file, size-start))
	if start > 0 {
		if _, err := reader.ReadBytes('\n'); err != nil {
			return nil, nil
		}
	}
	var tail bytes.Buffer
	if _, err := io.Copy(&tail, reader); err != nil {
		return nil, err
	}
	return tail.Bytes(), nil
}
