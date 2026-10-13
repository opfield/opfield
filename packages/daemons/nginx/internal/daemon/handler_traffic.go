package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
	"github.com/opfield/opfield/daemon-shared/stream"
	"github.com/opfield/opfield/nginx-daemon/internal/nginx"
)

func (h *Handler) handleRequestTrafficStats(cmd *pb.RequestTrafficStatsCommand, result *pb.CommandResult) {
	tailLines := int(cmd.TailLines)
	if tailLines <= 0 {
		tailLines = 200
	}
	if tailLines > 100_000 {
		tailLines = 100_000
	}
	hostID := strings.TrimSpace(cmd.HostId)
	if hostID != "" && !isValidUUID(hostID) {
		result.Success = false
		result.Error = "invalid proxy host id"
		return
	}
	windowSeconds := int(cmd.WindowSeconds)
	if windowSeconds < 0 {
		windowSeconds = 0
	}
	if windowSeconds > 300 {
		windowSeconds = 300
	}

	type statusCodes struct {
		S2xx int `json:"s2xx"`
		S3xx int `json:"s3xx"`
		S4xx int `json:"s4xx"`
		S5xx int `json:"s5xx"`
	}
	type trafficStats struct {
		HostID            string      `json:"hostId,omitempty"`
		StatusCodes       statusCodes `json:"statusCodes"`
		AvgResponseTime   float64     `json:"avgResponseTime"`
		P95ResponseTime   float64     `json:"p95ResponseTime"`
		TotalRequests     int         `json:"totalRequests"`
		TotalBytes        int64       `json:"totalBytes"`
		RequestsPerSecond float64     `json:"requestsPerSecond"`
		BytesPerSecond    float64     `json:"bytesPerSecond"`
		BusiestClientRPS  int         `json:"busiestClientRps"`
		WindowSeconds     float64     `json:"windowSeconds"`
		SampleTruncated   bool        `json:"sampleTruncated"`
		LastRequestAt     string      `json:"lastRequestAt,omitempty"`
	}
	stats := trafficStats{HostID: hostID, WindowSeconds: float64(windowSeconds)}
	writeStats := func() {
		if hostID == "" && h.reporter != nil {
			h.reporter.SetErrorRates(stats.TotalRequests, stats.StatusCodes.S4xx, stats.StatusCodes.S5xx)
		}
		encoded, err := json.Marshal(stats)
		if err != nil {
			result.Success = false
			result.Error = "encode traffic stats"
			return
		}
		result.Detail = string(encoded)
	}

	logPaths := make([]string, 0, 1)
	if hostID != "" {
		logPaths = append(logPaths, filepath.Join(h.cfg.Nginx.LogsDir, fmt.Sprintf("proxy-%s.access.log", hostID)))
	} else {
		entries, err := os.ReadDir(h.cfg.Nginx.LogsDir)
		if err != nil {
			writeStats()
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".access.log") {
				logPaths = append(logPaths, filepath.Join(h.cfg.Nginx.LogsDir, entry.Name()))
			}
		}
	}

	now := time.Now()
	cutoff := now.Add(-time.Duration(windowSeconds) * time.Second)
	latencies := make([]float64, 0, min(tailLines, 4096))
	clientSeconds := make(map[string]int)
	var firstRequest time.Time
	var lastRequest time.Time
	for _, logPath := range logPaths {
		lines, err := nginx.TailLastN(logPath, tailLines)
		if err != nil {
			continue
		}
		reachedWindowStart := false
		for _, line := range lines {
			parsed := nginx.ParseLogLine("", line)
			if parsed.Status == 0 {
				continue
			}
			requestAt, timestampErr := time.Parse("02/Jan/2006:15:04:05 -0700", parsed.Timestamp)
			if windowSeconds > 0 && timestampErr == nil && requestAt.Before(cutoff) {
				reachedWindowStart = true
				continue
			}
			if timestampErr == nil && requestAt.After(lastRequest) {
				lastRequest = requestAt
			}
			if timestampErr == nil && (firstRequest.IsZero() || requestAt.Before(firstRequest)) {
				firstRequest = requestAt
			}
			stats.TotalRequests++
			stats.TotalBytes += parsed.BodyBytesSent
			switch {
			case parsed.Status >= 200 && parsed.Status < 300:
				stats.StatusCodes.S2xx++
			case parsed.Status >= 300 && parsed.Status < 400:
				stats.StatusCodes.S3xx++
			case parsed.Status >= 400 && parsed.Status < 500:
				stats.StatusCodes.S4xx++
			case parsed.Status >= 500:
				stats.StatusCodes.S5xx++
			}
			if seconds, ok := parseNginxDuration(parsed.UpstreamResponseTime); ok {
				latencies = append(latencies, seconds)
			}
			if parsed.RemoteAddr != "" && timestampErr == nil {
				key := parsed.RemoteAddr + "\x00" + requestAt.Format(time.RFC3339)
				clientSeconds[key]++
				if clientSeconds[key] > stats.BusiestClientRPS {
					stats.BusiestClientRPS = clientSeconds[key]
				}
			}
		}
		if windowSeconds > 0 && len(lines) >= tailLines && !reachedWindowStart {
			stats.SampleTruncated = true
		}
	}

	if len(latencies) > 0 {
		var total float64
		for _, latency := range latencies {
			total += latency
		}
		stats.AvgResponseTime = total / float64(len(latencies))
		sort.Float64s(latencies)
		index := (len(latencies)*95 + 99) / 100
		stats.P95ResponseTime = latencies[max(0, index-1)]
	}
	if windowSeconds > 0 {
		if stats.SampleTruncated && !firstRequest.IsZero() && !lastRequest.IsZero() {
			stats.WindowSeconds = max(1, lastRequest.Sub(firstRequest).Seconds())
		}
		stats.RequestsPerSecond = float64(stats.TotalRequests) / stats.WindowSeconds
		stats.BytesPerSecond = float64(stats.TotalBytes) / stats.WindowSeconds
	}
	if !lastRequest.IsZero() {
		stats.LastRequestAt = lastRequest.UTC().Format(time.RFC3339)
	}
	writeStats()
}

func parseNginxDuration(value string) (float64, bool) {
	for _, candidate := range strings.Split(value, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || candidate == "-" {
			continue
		}
		seconds, err := strconv.ParseFloat(candidate, 64)
		if err == nil && seconds >= 0 {
			return seconds, true
		}
	}
	return 0, false
}

func (h *Handler) handleSetDaemonLogStream(cmd *pb.SetDaemonLogStreamCommand, result *pb.CommandResult) {
	// Enable BEFORE logging so the forwarder picks up this message
	stream.SetDaemonLogStreaming(cmd.Enabled, cmd.MinLevel)
	h.logger.Info("daemon log stream enabled", "min_level", cmd.MinLevel)
}
