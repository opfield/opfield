package monitoring

import (
	"context"
	"log/slog"
	"os"

	"github.com/opfield/opfield/daemon-shared/gpu"
	"github.com/opfield/opfield/daemon-shared/lifecycle"
	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/daemon-shared/sysmetrics"
)

// MonitoringPlugin implements lifecycle.DaemonPlugin for the monitoring daemon.
// It provides system-level metrics without any nginx-specific functionality.
type MonitoringPlugin struct {
	logger       *slog.Logger
	gpuCollector *gpu.Collector
}

// NewMonitoringPlugin creates a new MonitoringPlugin.
func NewMonitoringPlugin() *MonitoringPlugin {
	return &MonitoringPlugin{}
}

func (p *MonitoringPlugin) Type() string {
	return "monitoring"
}

func (p *MonitoringPlugin) SetLogger(logger *slog.Logger) {
	p.logger = logger
}

func (p *MonitoringPlugin) Init(cfg *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.logger = logger
	p.gpuCollector = gpu.NewCollector(logger)
	return nil
}

func (p *MonitoringPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	arch := sysmetrics.GetArchitecture()
	kernelVer := sysmetrics.GetKernelVersion()

	return &pb.RegisterMessage{
		NodeId:        nodeID,
		Hostname:      hostname,
		DaemonVersion: lifecycle.Version,
		CpuModel:      cpuModel,
		CpuCores:      int32(cpuCores),
		Architecture:  arch,
		KernelVersion: kernelVer,
		DaemonType:    "monitoring",
	}
}

func (p *MonitoringPlugin) HandleCommand(cmd *pb.OpfieldCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}

	switch payload := cmd.Payload.(type) {
	case *pb.OpfieldCommand_SetDaemonLogStream:
		stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
		p.logger.Info("daemon log stream updated", "enabled", payload.SetDaemonLogStream.Enabled, "min_level", payload.SetDaemonLogStream.MinLevel)
	default:
		result.Success = false
		result.Error = "unsupported command for monitoring daemon"
	}

	return result
}

func (p *MonitoringPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	// Monitoring nodes report physical inventory and any available host metrics.
	// Attachability is only used for Docker-node selection, so no Docker runtime
	// probe is attempted here.
	if p.gpuCollector != nil {
		base.GpuDevices = make([]*pb.GpuDevice, 0)
		for _, device := range p.gpuCollector.Collect(context.Background()) {
			base.GpuDevices = append(base.GpuDevices, device.ToProto())
		}
	}
	return base
}

func (p *MonitoringPlugin) CollectStats() *pb.StatsReport {
	// Monitoring daemon has no stats to report.
	return nil
}

func (p *MonitoringPlugin) OnSessionStart(ctx context.Context, _ *stream.Writer) error {
	return nil
}

func (p *MonitoringPlugin) OnSessionEnd() {
}
