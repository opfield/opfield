package daemon

import (
	"log/slog"
	"sync"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/config"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// Reporter collects nginx-specific metrics.
// System-level metrics are delegated to sysmetrics.SystemReporter in the shared module.
type Reporter struct {
	cfg     *config.Config
	mgr     *nginx.Manager
	logger  *slog.Logger
	mu      sync.RWMutex
	rate4xx float64
	rate5xx float64
	version string
}

func NewReporter(cfg *config.Config, mgr *nginx.Manager, logger *slog.Logger) *Reporter {
	version, _ := mgr.GetVersion()
	return &Reporter{cfg: cfg, mgr: mgr, logger: logger, version: version}
}

// CollectHealth enriches a base health report with nginx-specific metrics.
// The base report already contains system-level metrics from sysmetrics.SystemReporter.
func (r *Reporter) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	if base == nil {
		base = &pb.HealthReport{}
	}

	base.NginxRunning = r.mgr.IsRunning()

	if valid, _, checked := r.mgr.CachedConfigValidity(); checked {
		base.ConfigValid = valid
	}
	base.NginxServiceProblem = r.mgr.ServiceProblem(base.NginxRunning)

	if uptime, err := r.mgr.GetUptime(); err == nil {
		base.NginxUptimeSeconds = int64(uptime.Seconds())
	}

	if workers, err := r.mgr.GetWorkerCount(); err == nil {
		base.WorkerCount = int32(workers)
	}

	base.NginxVersion = r.version

	// Nginx RSS
	base.NginxRssBytes = r.mgr.GetProcessRSS()

	r.mu.RLock()
	base.ErrorRate_4Xx = r.rate4xx
	base.ErrorRate_5Xx = r.rate5xx
	r.mu.RUnlock()

	return base
}

// CollectStats returns nginx stub_status metrics.
func (r *Reporter) CollectStats() *pb.StatsReport {
	report := &pb.StatsReport{}

	status, err := nginx.FetchStubStatus(r.cfg.Nginx.StubStatusURL)
	if err != nil {
		r.logger.Debug("failed to fetch stub_status", "error", err)
		return report
	}

	report.ActiveConnections = status.ActiveConnections
	report.Accepts = status.Accepts
	report.Handled = status.Handled
	report.Requests = status.Requests
	report.Reading = int32(status.Reading)
	report.Writing = int32(status.Writing)
	report.Waiting = int32(status.Waiting)

	return report
}

// SetErrorRates updates health-compatible error rates from the canonical
// traffic snapshot. Health polling itself never rereads access logs.
func (r *Reporter) SetErrorRates(total, count4xx, count5xx int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if total <= 0 {
		r.rate4xx = 0
		r.rate5xx = 0
		return
	}
	r.rate4xx = float64(count4xx) / float64(total) * 100.0
	r.rate5xx = float64(count5xx) / float64(total) * 100.0
}
