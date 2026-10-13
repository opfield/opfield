package sysmetrics

import (
	"bufio"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// minCPUSampleWindow is the shortest /proc/stat window that yields a CPU
// percentage. The 30 s health ticker and Opfield's health requests share one
// CPUState; when they run close together the window is a few milliseconds and
// a handful of ticks reads as 0 % or 100 %. Calls inside the window return the
// last computed value and keep the older baseline.
const minCPUSampleWindow = 5 * time.Second

// CPUState holds delta-based CPU metric state.
type CPUState struct {
	PrevIdle  uint64
	PrevTotal uint64

	sampledAt   time.Time
	lastPercent float64
}

// GetCPUPercent reads /proc/stat and computes CPU usage from deltas.
// The caller must ensure concurrent access to CPUState is synchronized.
func GetCPUPercent(state *CPUState) float64 {
	return state.sample(time.Now(), os.ReadFile)
}

func (state *CPUState) sample(now time.Time, readFile func(string) ([]byte, error)) float64 {
	if !state.sampledAt.IsZero() && now.Sub(state.sampledAt) < minCPUSampleWindow {
		return state.lastPercent
	}
	data, err := readFile("/proc/stat")
	if err != nil {
		return 0
	}
	idle, total, ok := parseProcStatCPU(data)
	if !ok {
		return 0
	}
	var percent float64
	if idle >= state.PrevIdle && total >= state.PrevTotal {
		percent = calculateCPUPercentFromDeltas(idle-state.PrevIdle, total-state.PrevTotal)
	}
	state.PrevIdle = idle
	state.PrevTotal = total
	state.sampledAt = now
	state.lastPercent = percent
	return percent
}

// parseProcStatCPU returns the idle and total ticks of the aggregate "cpu"
// line. The total is user+nice+system+idle+iowait+irq+softirq+steal: guest and
// guest_nice (fields 9-10) are already included in user and nice, so adding
// them would count time spent running VMs twice.
func parseProcStatCPU(data []byte) (idle, total uint64, ok bool) {
	line, _, _ := strings.Cut(string(data), "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i := 1; i < len(fields) && i <= 8; i++ {
		val, _ := strconv.ParseUint(fields[i], 10, 64)
		total += val
		if i == 4 { // idle is field index 4
			idle = val
		}
	}
	return idle, total, true
}

func calculateCPUPercentFromDeltas(idleDelta uint64, totalDelta uint64) float64 {
	if totalDelta == 0 || idleDelta > totalDelta {
		return 0
	}

	percent := float64(totalDelta-idleDelta) / float64(totalDelta) * 100.0
	return math.Min(math.Max(percent, 0), 100)
}

// GetCPUInfo reads /proc/cpuinfo and returns the CPU model name and core count.
func GetCPUInfo() (model string, cores int) {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "", 0
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 && model == "" {
				model = strings.TrimSpace(parts[1])
			}
		}
		if strings.HasPrefix(line, "processor") {
			cores++
		}
	}
	return model, cores
}
