package docker

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Flags of a Proxmox "x86-64-v2-AES" guest (the production storage VM whose
// Valkey crashed) and of an "x86-64-v3" one.
const (
	testCPUFlagsV2 = "fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3 cx16 sse4_1 sse4_2 x2apic popcnt aes hypervisor lahf_lm cpuid_fault pti"
	testCPUFlagsV3 = testCPUFlagsV2 + " fma movbe xsave avx f16c rdrand abm bmi1 avx2 bmi2"
)

func testCPUInfo(flags ...string) string {
	var text strings.Builder
	for index, set := range flags {
		text.WriteString("processor\t: " + string(rune('0'+index)) + "\nflags\t\t: " + set + "\n\n")
	}
	return text.String()
}

func TestX86Level(t *testing.T) {
	for _, tc := range []struct {
		name    string
		cpuinfo string
		want    int
	}{
		{"none", "", 0},
		{"v1", testCPUInfo("fpu sse sse2 lm"), 1},
		{"v2-AES", testCPUInfo(testCPUFlagsV2, testCPUFlagsV2), 2},
		{"v3", testCPUInfo(testCPUFlagsV3), 3},
		{"v4", testCPUInfo(testCPUFlagsV3 + " avx512f avx512bw avx512cd avx512dq avx512vl"), 4},
		// AVX without AVX2 (Sandy Bridge) is still v2: Search crashes there too.
		{"avx only", testCPUInfo(testCPUFlagsV2 + " avx xsave"), 2},
		// The lowest processor counts.
		{"mixed", testCPUInfo(testCPUFlagsV3, testCPUFlagsV2), 2},
	} {
		if got := x86Level(tc.cpuinfo); got != tc.want {
			t.Errorf("%s: level %d, want %d", tc.name, got, tc.want)
		}
	}
}

func withCPULevel(t *testing.T, level int) {
	t.Helper()
	previous := nodeCPULevelOverride
	nodeCPULevelOverride = level
	t.Cleanup(func() { nodeCPULevelOverride = previous })
}

func TestValkeyModulesFollowTheCPU(t *testing.T) {
	withCPULevel(t, 2)
	config := managedValkeyModuleConfig()
	if strings.Contains(config, "\nloadmodule "+managedValkeySearchModule) || strings.HasPrefix(config, "loadmodule "+managedValkeySearchModule) {
		t.Fatalf("a v2 node loads Search:\n%s", config)
	}
	// The bundle's entrypoint adds every module the config does not name.
	if !strings.Contains(config, "loadmodule "+managedValkeySearchModule) {
		t.Fatalf("the config must name Search so the entrypoint leaves it out:\n%s", config)
	}
	for _, module := range []string{"/usr/lib/valkey/libjson.so", "/usr/lib/valkey/libvalkey_bloom.so"} {
		if !strings.Contains(config, "loadmodule "+module+"\n") {
			t.Fatalf("a v2 node loads %s:\n%s", module, config)
		}
	}
	if slices.Contains(managedValkeyNodeModules(), managedValkeySearchModule) {
		t.Fatal("restore staging on a v2 node loads Search")
	}
	if !slices.Contains(cpuCapabilities(), "cpu_x86_64_v2") || !slices.Contains(cpuCapabilities(), managedCapabilityValkeyCPUModules) {
		t.Fatalf("capabilities %v", cpuCapabilities())
	}

	withCPULevel(t, 3)
	if !strings.HasPrefix(managedValkeyModuleConfig(), "loadmodule /usr/lib/valkey/libjson.so\nloadmodule "+managedValkeySearchModule+"\n") {
		t.Fatalf("a v3 node loads JSON then Search:\n%s", managedValkeyModuleConfig())
	}
	if !slices.Equal(managedValkeyNodeModules(), managedValkeyModules) {
		t.Fatal("a v3 node stages restores with every module")
	}
}

func TestEngineExitError(t *testing.T) {
	// The start of a Valkey crash report on a CPU without AVX2.
	lines := []string{
		"1:C 24 Oct 2026 13:48:13.600 * oO0OoO0OoO0Oo Valkey is starting oO0OoO0OoO0Oo",
		"1:M 24 Oct 2026 13:48:13.650 * Module 'json' loaded from /usr/lib/valkey/libjson.so",
		"",
		"=== VALKEY BUG REPORT START: Cut & paste starting from here ===",
		"1:M 24 Oct 2026 13:48:13.655 # valkey 9.1.2 crashed by signal: 4, si_code: 2",
		"1:M 24 Oct 2026 13:48:13.655 # Crashed running the instruction at: 0x7c0da4a5fe56",
		"RAX:0000000000000000 RBX:0000000000000000",
		"=== VALKEY BUG REPORT END. Make sure to include from START to END. ===",
	}
	err := engineExitError(engineExit{ExitCode: 139}, lines)
	if !errors.Is(err, errEngineExited) {
		t.Fatal("not an engine exit")
	}
	message := err.Error()
	for _, want := range []string{"exit code 139 (SIGSEGV", "crashed by signal: 4", "Module 'json' loaded"} {
		if !strings.Contains(message, want) {
			t.Errorf("%q lacks %q", message, want)
		}
	}
	if strings.Contains(message, "RAX:") {
		t.Errorf("%q carries the register dump", message)
	}
	// Opfield keeps about 480 characters of an operation error.
	long := make([]string, 50)
	for index := range long {
		long[index] = strings.Repeat("x", 100)
	}
	if got := len(engineExitError(engineExit{ExitCode: 1}, long).Error()); got > 400 {
		t.Errorf("error of %d bytes", got)
	}
	if !strings.Contains(describeEngineExit(engineExit{ExitCode: 132}), "SIGILL") {
		t.Error("132 is SIGILL")
	}
	for _, exit := range []engineExit{{ExitCode: 0}, {ExitCode: 137}, {ExitCode: 143}} {
		if engineExitIsCrash(exit) {
			t.Errorf("%+v is a stop, not a crash", exit)
		}
	}
	for _, exit := range []engineExit{{ExitCode: 1}, {ExitCode: 132}, {ExitCode: 139}, {ExitCode: 137, OOMKilled: true}} {
		if !engineExitIsCrash(exit) {
			t.Errorf("%+v is a crash", exit)
		}
	}
}

func TestFailedStartLogIsKeptForTheLogs(t *testing.T) {
	m := &managedDatabaseManager{root: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	id := "6f1c1a52-8b39-4f3c-9d55-0b7b1c3f8a10"
	if _, ok := m.failedStartLog(id, 0, false); ok {
		t.Fatal("no failed start yet")
	}
	data, _ := json.Marshal(engineFailureLog{Lines: []string{"2026-10-24T13:48:13.600000000Z first", "2026-10-24T13:48:13.700000000Z second", "2026-10-24T13:48:13.800000000Z third"}})
	if err := os.MkdirAll(filepath.Dir(m.failureLogPath(id)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.failureLogPath(id), data, 0o600); err != nil {
		t.Fatal(err)
	}
	lines, ok := m.failedStartLog(id, 2, false)
	if !ok || !slices.Equal(lines, []string{"second", "third"}) {
		t.Fatalf("lines %v, %v", lines, ok)
	}
	if lines, _ := m.failedStartLog(id, 0, true); len(lines) != 3 || !strings.HasPrefix(lines[0], "2026-10-24T") {
		t.Fatalf("timestamped lines %v", lines)
	}
	if _, ok := m.failedStartLog("../etc/passwd", 0, false); ok {
		t.Fatal("an invalid id reads nothing")
	}
	m.forgetFailedStart(id)
	if _, ok := m.failedStartLog(id, 0, false); ok {
		t.Fatal("forgotten")
	}
}
