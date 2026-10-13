package docker

import (
	"context"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
)

func (p *DockerPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	for kind, count := range p.legacyNames.current(p) {
		lifecycle.AddLegacyNames(base, kind, count)
	}
	if p.cfg.Docker.Mode == "builder" {
		return base
	}
	base.DockerVersion = p.version
	// Lease state goes first: it must reach Opfield even when Docker
	// itself does not answer.
	base.AvailabilityLease = p.availabilityLeaseReport()
	base.AvailabilityMembers = p.availabilityMemberReports()
	// So do the link counters: they come from the daemon's own state.
	base.ManagedLinks = p.managedLinkRuntime()
	base.RelayStreams = p.relayStreamStats()
	base.UpdateConnections = p.updateConnections()
	if p.storageManager != nil {
		mount, err := p.storageManager.storageRootHealthMount()
		if err != nil {
			p.logger.Warn("failed to collect managed storage root health", "error", err)
		} else {
			base.DiskMounts = append(base.DiskMounts, mount)
		}
	}

	ctx := context.Background()
	running, stopped, total, err := p.client.CountContainers(ctx)
	if err != nil {
		p.logger.Warn("failed to count containers for health", "error", err)
		return base
	}

	base.ContainersRunning = int32(running)
	base.ContainersStopped = int32(stopped)
	base.ContainersTotal = int32(total)

	// Include per-container resource stats if available
	if p.statsCollector != nil {
		base.ContainerStats = p.statsCollector.GetStats()
	}
	// GPU inventory is daemon-authoritative. The Docker client adds runtime
	// readiness (notably NVIDIA Container Toolkit) before it reaches Opfield.
	base.GpuDevices = make([]*pb.GpuDevice, 0)
	for _, device := range p.client.GPUDevices(ctx) {
		base.GpuDevices = append(base.GpuDevices, device.ToProto())
	}

	return base
}

// CollectStats returns nil; the docker daemon does not collect time-series stats
// in this foundational implementation.
func (p *DockerPlugin) CollectStats() *pb.StatsReport {
	return nil
}

// OnSessionStart is called when a new gRPC session is established.
func (p *DockerPlugin) OnSessionStart(ctx context.Context, writer *stream.Writer) error {
	p.sessionLive.Store(true)
	p.writer = writer
	p.buildEventMu.Lock()
	p.buildEventWriter = writer
	p.buildEventMu.Unlock()
	p.sessionCtx = ctx
	p.logStreamCancel = make(map[string]context.CancelFunc)
	if p.registryProxy != nil {
		// Renews the registry proxy server certificate before it expires.
		go p.registryProxy.runIdentityRenewal(ctx)
	}
	if p.cfg.Docker.Mode == "builder" {
		return nil
	}
	// Start stats collector goroutine
	collector := NewStatsCollector(p.client, p.allowlist, p.logger)
	p.statsCollector = collector
	go collector.Run(ctx)
	go p.followContainerStates(ctx, collector)
	go p.runMigrationArtifactCleanup(ctx)

	// Create exec manager with stream writer for async output
	p.execMgr = NewExecManager(p.client, writer, p.logger)
	// A Secure Runtime verification that finished after the registration
	// message was built and before this writer existed was never sent.
	if p.runtimeManager != nil {
		p.sendRuntimeStatus(p.getRuntimeStatus())
	}

	return nil
}

// OnSessionEnd is called when a gRPC session ends.
func (p *DockerPlugin) OnSessionEnd() {
	p.sessionLive.Store(false)
	// Exec sessions are cleaned up individually when their WebSocket closes.
	// Don't CloseAll here — it would kill other users' active sessions.
	p.execMgr = nil
	p.statsCollector = nil

	// Cancel all active log streams
	p.logStreamMu.Lock()
	for containerID, cancel := range p.logStreamCancel {
		cancel()
		delete(p.logStreamCancel, containerID)
	}
	p.logStreamMu.Unlock()
	if p.composeExecutor != nil {
		p.composeExecutor.cancelAll()
	}
	p.buildEventMu.Lock()
	p.buildEventWriter = nil
	p.buildEventMu.Unlock()
	p.writer = nil
	p.sessionCtx = nil
}
