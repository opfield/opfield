package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

// StatsCollector periodically collects per-container resource usage from the
// Docker stats API. Running containers include live metrics; non-running
// containers are still reported with zero metrics so the gateway can observe
// lifecycle state continuously.
type StatsCollector struct {
	client    *Client
	allowlist *AllowlistChecker
	logger    *slog.Logger
	mu        sync.RWMutex
	stats     map[string]*pb.ContainerStats // keyed by container ID
	// stateVersion counts refreshStates passes: a metrics pass that a state refresh overtook keeps the newer states.
	stateVersion uint64
	// logReadWarning reports once that log files are unreadable, typically a
	// daemon running as a user outside the Docker data directory's group.
	logReadWarning sync.Once
}

// NewStatsCollector creates a new StatsCollector.
func NewStatsCollector(client *Client, allowlist *AllowlistChecker, logger *slog.Logger) *StatsCollector {
	return &StatsCollector{
		client:    client,
		allowlist: allowlist,
		logger:    logger,
		stats:     make(map[string]*pb.ContainerStats),
	}
}

// Run polls Docker stats every 10 seconds until the context is cancelled.
func (sc *StatsCollector) Run(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Collect once immediately
	sc.collect(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sc.collect(ctx)
		}
	}
}

// GetStats returns the current stats snapshot, thread-safe.
func (sc *StatsCollector) GetStats() []*pb.ContainerStats {
	sc.mu.RLock()
	defer sc.mu.RUnlock()

	result := make([]*pb.ContainerStats, 0, len(sc.stats))
	for _, s := range sc.stats {
		result = append(result, s)
	}
	return result
}

// collect gathers stats from all containers filtered by the allowlist.
func (sc *StatsCollector) collect(ctx context.Context) {
	sc.mu.RLock()
	version := sc.stateVersion
	sc.mu.RUnlock()
	containers, err := sc.client.ListContainers(ctx)
	if err != nil {
		sc.logger.Debug("stats: list containers failed", "error", err)
		return
	}

	// Filter by allowlist. Only running containers have Docker stats, but
	// stopped/exited containers still need state samples for alert windows.
	containers = sc.allowlist.Filter(containers)

	newStats := make(map[string]*pb.ContainerStats, len(containers))

	for _, ctr := range containers {
		if ctr.State != "running" {
			newStats[ctr.ID] = &pb.ContainerStats{
				ContainerId: ctr.ID,
				Name:        ctr.Name,
				Image:       ctr.Image,
				State:       ctr.State,
			}
			continue
		}

		stat, err := sc.collectOne(ctx, ctr.ID)
		if err != nil {
			sc.logger.Debug("stats: collect failed", "container", ctr.Name, "error", err)
			newStats[ctr.ID] = &pb.ContainerStats{
				ContainerId: ctr.ID,
				Name:        ctr.Name,
				Image:       ctr.Image,
				State:       ctr.State,
			}
			continue
		}

		stat.ContainerId = ctr.ID
		stat.Name = ctr.Name
		stat.Image = ctr.Image
		stat.State = ctr.State
		newStats[ctr.ID] = stat
	}

	sc.mu.Lock()
	if sc.stateVersion != version {
		// A container event refreshed the states while this pass sampled: which containers exist and their states
		// come from that newer list, the metrics from this pass where the state still matches.
		merged := make(map[string]*pb.ContainerStats, len(sc.stats))
		for id, current := range sc.stats {
			if sampled, ok := newStats[id]; ok && sampled.State == current.State {
				merged[id] = sampled
			} else {
				merged[id] = current
			}
		}
		newStats = merged
	}
	sc.stats = newStats
	sc.mu.Unlock()
}

// refreshStates reads which containers exist and their states again, without sampling metrics, and reports whether
// any of them changed. A container that started or exited keeps its last metrics only while it still runs.
func (sc *StatsCollector) refreshStates(ctx context.Context) (bool, error) {
	containers, err := sc.client.ListContainers(ctx)
	if err != nil {
		return false, err
	}
	containers = sc.allowlist.Filter(containers)

	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.stateVersion++
	next := make(map[string]*pb.ContainerStats, len(containers))
	changed := len(containers) != len(sc.stats)
	for _, ctr := range containers {
		if current, ok := sc.stats[ctr.ID]; ok && current.State == ctr.State {
			next[ctr.ID] = current
			continue
		}
		changed = true
		next[ctr.ID] = &pb.ContainerStats{
			ContainerId: ctr.ID,
			Name:        ctr.Name,
			Image:       ctr.Image,
			State:       ctr.State,
		}
	}
	sc.stats = next
	return changed, nil
}

// collectOne fetches a one-shot stats sample for a single container and
// returns a proto ContainerStats.
func (sc *StatsCollector) collectOne(ctx context.Context, containerID string) (*pb.ContainerStats, error) {
	result, err := sc.client.cli.ContainerStats(ctx, containerID, client.ContainerStatsOptions{
		Stream:                false,
		IncludePreviousSample: true,
	})
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()

	body, err := io.ReadAll(result.Body)
	if err != nil {
		return nil, err
	}

	var stats container.StatsResponse
	if err := json.Unmarshal(body, &stats); err != nil {
		return nil, err
	}

	inspectResult, err := sc.client.cli.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
	if err != nil {
		return statsResponseToProto(&stats, nil), nil
	}

	proto := statsResponseToProto(&stats, &inspectResult.Container)
	logBytes, err := containerLogBytes(inspectResult.Container.LogPath)
	if err != nil {
		sc.logReadWarning.Do(func() {
			sc.logger.Warn("stats: cannot read container log files; log sizes are not reported", "error", err)
		})
	}
	proto.LogBytes, proto.LogBytesAvailable = logBytes, inspectResult.Container.LogPath != "" && err == nil
	return proto, nil
}

// containerLogBytes sums the container's log file and its rotated siblings
// (json-file keeps <id>-json.log.1, .2 and so on next to it). Drivers other
// than json-file expose no log path, which is reported as zero without error.
func containerLogBytes(logPath string) (int64, error) {
	if logPath == "" {
		return 0, nil
	}
	entries, err := os.ReadDir(filepath.Dir(logPath))
	if err != nil {
		return 0, err
	}
	prefix := filepath.Base(logPath)
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
	}
	return total, nil
}

// statsResponseToProto converts a Docker StatsResponse to the protobuf ContainerStats.
func statsResponseToProto(stats *container.StatsResponse, inspect *container.InspectResponse) *pb.ContainerStats {
	cs := &pb.ContainerStats{}

	// CPU percent calculation
	cs.CpuPercent = calculateCPUPercent(stats, inspect)

	// Memory
	cs.MemoryUsageBytes = containerWorkingSetBytes(stats.MemoryStats)
	cs.MemoryLimitBytes = int64(stats.MemoryStats.Limit)
	// Docker may report host RAM here even for a configured container quota.
	// Reuse the inspect already fetched for CPU accounting, retaining a lower
	// effective cgroup limit when the stats endpoint reports one.
	if inspect != nil && inspect.HostConfig != nil && inspect.HostConfig.Memory > 0 {
		if cs.MemoryLimitBytes <= 0 || inspect.HostConfig.Memory < cs.MemoryLimitBytes {
			cs.MemoryLimitBytes = inspect.HostConfig.Memory
		}
	}

	// Network: aggregate all interfaces
	var rxBytes, txBytes uint64
	for _, netStats := range stats.Networks {
		rxBytes += netStats.RxBytes
		txBytes += netStats.TxBytes
	}
	cs.NetworkRxBytes = int64(rxBytes)
	cs.NetworkTxBytes = int64(txBytes)

	// Block IO
	var readBytes, writeBytes uint64
	for _, entry := range stats.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			readBytes += entry.Value
		case "write":
			writeBytes += entry.Value
		}
	}
	cs.BlockReadBytes = int64(readBytes)
	cs.BlockWriteBytes = int64(writeBytes)

	// PIDs
	cs.Pids = int64(stats.PidsStats.Current)

	return cs
}

// containerWorkingSetBytes is container memory as the docker stats CLI shows
// it: usage minus the inactive file cache, which the kernel reclaims before
// the container hits its limit. cgroup v2 reports inactive_file, cgroup v1
// total_inactive_file; older v1 daemons only have cache.
func containerWorkingSetBytes(mem container.MemoryStats) int64 {
	usage := mem.Usage
	cache, ok := mem.Stats["inactive_file"]
	if !ok {
		cache, ok = mem.Stats["total_inactive_file"]
	}
	if !ok {
		cache = mem.Stats["cache"]
	}
	if cache >= usage {
		return 0
	}
	return int64(usage - cache)
}

// calculateCPUPercent computes container CPU relative to the CPU capacity available
// to that container. A 1-CPU-limited container should show 100% when it fully
// saturates its quota, while an unlimited container uses total host CPU as its
// reference and stays on a 0-100 scale.
func calculateCPUPercent(stats *container.StatsResponse, inspect *container.InspectResponse) float64 {
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage) - float64(stats.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(stats.CPUStats.SystemUsage) - float64(stats.PreCPUStats.SystemUsage)

	if systemDelta <= 0 || cpuDelta < 0 {
		return 0.0
	}

	hostCPUs := availableHostCPUs(stats)
	containerCPUs := availableContainerCPUs(inspect, hostCPUs)
	if hostCPUs <= 0 || containerCPUs <= 0 {
		return 0.0
	}

	return math.Min(((cpuDelta/systemDelta)*hostCPUs/containerCPUs)*100.0, 100.0)
}

func availableHostCPUs(stats *container.StatsResponse) float64 {
	if stats.CPUStats.OnlineCPUs > 0 {
		return float64(stats.CPUStats.OnlineCPUs)
	}
	if n := len(stats.CPUStats.CPUUsage.PercpuUsage); n > 0 {
		return float64(n)
	}
	return 1
}

func availableContainerCPUs(inspect *container.InspectResponse, fallback float64) float64 {
	limit := fallback
	if inspect == nil || inspect.HostConfig == nil {
		return limit
	}

	if inspect.HostConfig.NanoCPUs > 0 {
		limit = math.Min(limit, float64(inspect.HostConfig.NanoCPUs)/1e9)
	}

	if inspect.HostConfig.CPUPeriod > 0 && inspect.HostConfig.CPUQuota > 0 {
		quotaLimit := float64(inspect.HostConfig.CPUQuota) / float64(inspect.HostConfig.CPUPeriod)
		if quotaLimit > 0 {
			limit = math.Min(limit, quotaLimit)
		}
	}

	if cpusetLimit := countCPUSet(inspect.HostConfig.CpusetCpus); cpusetLimit > 0 {
		limit = math.Min(limit, cpusetLimit)
	}

	if limit <= 0 {
		return fallback
	}
	return limit
}

func countCPUSet(cpuset string) float64 {
	cpuset = strings.TrimSpace(cpuset)
	if cpuset == "" {
		return 0
	}

	var count float64
	for _, part := range strings.Split(cpuset, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		if !strings.Contains(part, "-") {
			count++
			continue
		}

		bounds := strings.SplitN(part, "-", 2)
		if len(bounds) != 2 {
			continue
		}
		start, errStart := strconv.Atoi(strings.TrimSpace(bounds[0]))
		end, errEnd := strconv.Atoi(strings.TrimSpace(bounds[1]))
		if errStart != nil || errEnd != nil || end < start {
			continue
		}
		count += float64(end-start) + 1
	}

	return count
}
