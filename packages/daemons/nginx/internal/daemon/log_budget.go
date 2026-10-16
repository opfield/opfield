package daemon

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

// The nginx log budget (nginx.EnforceLogBudget) runs for the life of the
// process, connected to Opfield or not: logs grow either way.

const (
	logBudgetInterval = 5 * time.Minute
	// logRetentionStateKey keeps the retention Housekeeping sent across
	// restarts (days; 0: no age limit).
	logRetentionStateKey = "nginx_log_retention_days"
	maxLogRetentionDays  = 3650
)

type logBudget struct {
	mu        sync.Mutex
	last      *nginx.LogBudgetResult
	policy    nginx.LogBudgetPolicy
	lastError string
	started   sync.Once
}

func (p *NginxPlugin) startLogBudget() {
	p.logBudget.started.Do(func() {
		nginx.CleanTmpLogCuts(p.cfg.Nginx.LogsDir)
		go func() {
			ticker := time.NewTicker(logBudgetInterval)
			defer ticker.Stop()
			p.enforceLogBudget()
			for range ticker.C {
				p.enforceLogBudget()
			}
		}()
	})
}

// logRetention is the retention Housekeeping last sent, or the default.
func (p *NginxPlugin) logRetention() time.Duration {
	if p.state == nil {
		return nginx.DefaultLogRetention
	}
	value, ok := p.state.GetExtra(logRetentionStateKey)
	if !ok {
		return nginx.DefaultLogRetention
	}
	var days float64
	switch v := value.(type) {
	case float64:
		days = v
	case int:
		days = float64(v)
	case uint32:
		days = float64(v)
	case string:
		parsed, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return nginx.DefaultLogRetention
		}
		days = parsed
	default:
		return nginx.DefaultLogRetention
	}
	if days <= 0 {
		return 0
	}
	if days > maxLogRetentionDays {
		days = maxLogRetentionDays
	}
	return time.Duration(days) * 24 * time.Hour
}

// enforceLogBudget runs one pass and keeps its result for the health report.
func (p *NginxPlugin) enforceLogBudget() nginx.LogBudgetResult {
	p.logBudget.mu.Lock()
	defer p.logBudget.mu.Unlock()
	logsDir := p.cfg.Nginx.LogsDir
	policy := nginx.DefaultLogBudgetPolicy(nginx.FilesystemBytes(logsDir), p.logRetention())
	referenced, ok := nginx.ReferencedRouteLogs(p.cfg.Nginx.ConfigDir, p.cfg.Nginx.GlobalConfig)
	if !ok {
		referenced = nil
	}
	result, err := nginx.EnforceLogBudget(logsDir, referenced, policy, time.Now())
	p.logBudget.policy = policy
	p.logBudget.last = &result
	if err != nil {
		// One line per distinct problem, not one per pass.
		if message := err.Error(); message != p.logBudget.lastError {
			p.logger.Warn("nginx log budget could not bound every log", "dir", logsDir, "error", err)
			p.logBudget.lastError = message
		}
	} else {
		p.logBudget.lastError = ""
	}
	if result.RemovedFiles > 0 || result.TruncatedFiles > 0 {
		p.logger.Info("bounded nginx logs",
			"removed", result.RemovedFiles,
			"truncated", result.TruncatedFiles,
			"freed_bytes", result.FreedBytes,
			"bytes", result.Bytes,
			"budget_bytes", policy.BudgetBytes,
		)
	}
	return result
}

// logUsageReport is the last pass for the health report; nil before the first.
func (p *NginxPlugin) logUsageReport() *pb.NginxLogUsage {
	p.logBudget.mu.Lock()
	defer p.logBudget.mu.Unlock()
	if p.logBudget.last == nil {
		return nil
	}
	return &pb.NginxLogUsage{
		Bytes:         uint64(max(p.logBudget.last.Bytes, 0)),
		Files:         uint32(p.logBudget.last.Files),
		OldestUnix:    p.logBudget.last.OldestUnix,
		BudgetBytes:   uint64(max(p.logBudget.policy.BudgetBytes, 0)),
		MaxFileBytes:  uint64(max(p.logBudget.policy.MaxFileBytes, 0)),
		RetentionDays: uint32(p.logBudget.policy.MaxAge / (24 * time.Hour)),
	}
}

// ConfigureNginxLogs keeps the retention Housekeeping sends and applies it.
func (p *NginxPlugin) ConfigureNginxLogs(command *pb.ConfigureNginxLogsCommand) (string, error) {
	days := command.GetRetentionDays()
	if days > maxLogRetentionDays {
		days = maxLogRetentionDays
	}
	if p.state != nil {
		p.state.SetExtra(logRetentionStateKey, float64(days))
		if err := p.state.Save(); err != nil {
			return "", err
		}
	}
	result := p.enforceLogBudget()
	detail, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(detail), nil
}
