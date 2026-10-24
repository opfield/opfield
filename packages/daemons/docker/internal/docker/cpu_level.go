package docker

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// A node's x86-64 microarchitecture level (the psABI levels v1 to v4) decides
// what some engine images can run there: the Search module of the
// valkey-bundle image needs AVX2 (x86-64-v3) and crashes with SIGILL on a
// v2 CPU (a Proxmox "x86-64-v2-AES" guest), so a key-value store on such a
// node starts Valkey without Search. The daemon reports the level as the
// capability cpuLevelCapabilityPrefix+"<n>" (amd64 only), and
// managedCapabilityValkeyCPUModules says it starts Valkey with the modules
// its CPU runs. An older daemon reports neither.
const (
	cpuLevelCapabilityPrefix          = "cpu_x86_64_v"
	managedCapabilityValkeyCPUModules = "managed_redis_valkey_cpu_modules_v1"
)

// x86-64 level feature sets, as /proc/cpuinfo names the flags (lzcnt is
// "abm", OSXSAVE shows as "xsave" plus the AVX flags the kernel only keeps
// when the OS saves the AVX state).
var (
	cpuLevel2Flags = []string{"cx16", "lahf_lm", "popcnt", "sse4_1", "sse4_2", "ssse3"}
	cpuLevel3Flags = []string{"avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"}
	cpuLevel4Flags = []string{"avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"}
)

// x86Level returns the x86-64 level of a /proc/cpuinfo text: 0 when it names
// no flags (not x86, unreadable), else 1 to 4. Every processor must have a
// feature for the level to count (a VM shows one CPU model for all of them).
func x86Level(cpuinfo string) int {
	level := 0
	for _, line := range strings.Split(cpuinfo, "\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) != "flags" {
			continue
		}
		flags := map[string]bool{}
		for _, flag := range strings.Fields(value) {
			flags[flag] = true
		}
		processorLevel := 1
		for _, set := range [][]string{cpuLevel2Flags, cpuLevel3Flags, cpuLevel4Flags} {
			if !hasAllFlags(flags, set) {
				break
			}
			processorLevel++
		}
		if level == 0 || processorLevel < level {
			level = processorLevel
		}
	}
	return level
}

func hasAllFlags(flags map[string]bool, names []string) bool {
	for _, name := range names {
		if !flags[name] {
			return false
		}
	}
	return true
}

var (
	nodeCPULevelOnce  sync.Once
	nodeCPULevelValue int
	// nodeCPULevelOverride replaces the detected level (tests); 0 keeps it.
	nodeCPULevelOverride int
)

// nodeX86Level is the node's x86-64 level, 0 off amd64 or when /proc/cpuinfo
// cannot be read.
func nodeX86Level() int {
	if nodeCPULevelOverride != 0 {
		return nodeCPULevelOverride
	}
	nodeCPULevelOnce.Do(func() {
		if runtime.GOARCH != "amd64" {
			return
		}
		data, err := os.ReadFile("/proc/cpuinfo")
		if err != nil {
			return
		}
		nodeCPULevelValue = x86Level(string(data))
	})
	return nodeCPULevelValue
}

// cpuCapabilities are the CPU capabilities a storage-profile daemon reports.
func cpuCapabilities() []string {
	values := []string{managedCapabilityValkeyCPUModules}
	if level := nodeX86Level(); level > 0 {
		values = append(values, cpuLevelCapabilityPrefix+strconv.Itoa(level))
	}
	return values
}

// valkeySearchRuns reports whether the valkey-bundle Search module runs on
// this node: it needs x86-64-v3 on amd64. An unknown level keeps it (the
// engine's crash report names the cause if it does not run).
func valkeySearchRuns() bool {
	level := nodeX86Level()
	return level == 0 || level >= 3
}
