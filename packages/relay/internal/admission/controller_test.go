package admission

import (
	"runtime"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type fixedSampler struct{ pressure ResourcePressure }

func (s *fixedSampler) Sample() ResourcePressure { return s.pressure }

func newTestController(pressure uint32) (*Controller, *fixedSampler) {
	sampler := &fixedSampler{pressure: ResourcePressure{CPUPercent: pressure}}
	controller := NewWithSampler(sampler)
	controller.UpdatePolicy(&relayv1.AdmissionPolicy{
		Enabled:                    true,
		ProxyTargetPressurePercent: 70,
		DatabaseReservePercent:     20,
		HardPressurePercent:        95,
	})
	return controller, sampler
}

// warm runs the sampling steps the controller's loop takes in 2 s and returns
// the time of the last one.
func warm(controller *Controller) time.Time {
	now := time.Now()
	for range 8 {
		now = now.Add(pressureSampleInterval)
		controller.step(now)
	}
	return now
}

func TestHealthyRelayDoesNotLimitApplicationSize(t *testing.T) {
	controller, _ := newTestController(20)
	usage := Usage{ActiveProxy: 100_000, ProxyByRoute: map[string]uint64{"large": 100_000}}
	if err := controller.Admit(TrafficClassProxy, "large", usage); err != nil {
		t.Fatalf("healthy admission rejected: %v", err)
	}
}

func TestPressureThrottlesDominantProxyButAdmitsNewRoute(t *testing.T) {
	controller, _ := newTestController(72)
	// Warm the EWMA to the fixed pressure.
	warm(controller)
	usage := Usage{ActiveProxy: 10_000, ProxyByRoute: map[string]uint64{"large": 10_000}}
	if err := controller.Admit(TrafficClassProxy, "large", usage); err == nil {
		t.Fatal("dominant proxy route was admitted under pressure")
	}
	if err := controller.Admit(TrafficClassProxy, "new", usage); err != nil {
		t.Fatalf("new proxy route did not receive fair admission: %v", err)
	}
}

func TestDatabaseReserveRejectsProxyBeforeDatabase(t *testing.T) {
	controller, sampler := newTestController(92)
	warm(controller)
	if err := controller.Admit(TrafficClassProxy, "proxy", Usage{}); err == nil {
		t.Fatal("proxy was admitted inside database reserve")
	}
	if err := controller.Admit(TrafficClassDatabase, "database", Usage{}); err != nil {
		t.Fatalf("database did not receive reserved admission: %v", err)
	}
	sampler.pressure = ResourcePressure{CPUPercent: 100}
	warm(controller)
	if err := controller.Admit(TrafficClassDatabase, "database", Usage{}); err == nil {
		t.Fatal("database bypassed the absolute hard-pressure cutoff")
	}
}

func TestRegistryUsesAnExplicitNonDatabaseTrafficClass(t *testing.T) {
	controller, _ := newTestController(92)
	warm(controller)
	if err := controller.Admit(TrafficClassRegistry, "registry", Usage{}); err == nil {
		t.Fatal("registry traffic bypassed the non-database pressure cutoff")
	}
	if err := controller.Admit("unknown", "route", Usage{}); err == nil {
		t.Fatal("unknown traffic class was admitted")
	}
}

func TestDisabledAdmissionNeverThrottles(t *testing.T) {
	controller, _ := newTestController(100)
	controller.UpdatePolicy(&relayv1.AdmissionPolicy{Enabled: false})
	if err := controller.Admit(TrafficClassProxy, "proxy", Usage{}); err != nil {
		t.Fatalf("disabled admission rejected a tunnel: %v", err)
	}
	if state := controller.GetSnapshot().State; state != "disabled" {
		t.Fatalf("state = %q", state)
	}
}

func TestUnlimitedMemoryReportsRelayUsageWithoutHostPressure(t *testing.T) {
	pressure, rss, heap, limit := memoryPressureForLimit(18*1024*1024, 6*1024*1024, []byte("max\n"))
	if pressure != 0 || rss != 18*1024*1024 || heap != 6*1024*1024 || limit != 0 {
		t.Fatalf("unexpected unlimited memory metrics: pressure=%d rss=%d heap=%d limit=%d", pressure, rss, heap, limit)
	}
}

func TestFiniteMemoryLimitUsesRelayRSS(t *testing.T) {
	pressure, rss, _, limit := memoryPressureForLimit(256, 128, []byte("1024\n"))
	if pressure != 25 || rss != 256 || limit != 1024 {
		t.Fatalf("unexpected limited memory metrics: pressure=%d rss=%d limit=%d", pressure, rss, limit)
	}
}

func TestCountCPUListUsesProcessAffinity(t *testing.T) {
	if got := countCPUList("1-2,11,13"); got != 4 {
		t.Fatalf("cpu count = %d", got)
	}
	if got := countCPUList("0-3,8-9"); got != 6 {
		t.Fatalf("cpu count = %d", got)
	}
	if got := countCPUList("3-1"); got != 0 {
		t.Fatalf("invalid cpu count = %d", got)
	}
}

func TestProcessCPUNanosecondsSamplesAllRuntimeThreads(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux procfs required")
	}
	if used, ok := processCPUNanoseconds(); !ok || used == 0 {
		t.Fatalf("process cpu sample unavailable: used=%d ok=%t", used, ok)
	}
}

func TestSnapshotReportsSmoothedProcessPressure(t *testing.T) {
	controller, sampler := newTestController(40)
	last := warm(controller)
	sampler.pressure = ResourcePressure{CPUPercent: 0}
	controller.step(last.Add(pressureSampleInterval))
	snapshot := controller.GetSnapshot()
	if snapshot.CPUPressurePercent == 0 || snapshot.CPUPressurePercent >= 40 {
		t.Fatalf("smoothed cpu pressure = %d", snapshot.CPUPressurePercent)
	}
}

// Admission runs under the broker's global lock: a decision reads the
// published measurement and never samples, and a burst of decisions does not
// move the smoothed pressure (F5).
func TestAdmitNeverSamples(t *testing.T) {
	sampler := &countingSampler{pressure: ResourcePressure{CPUPercent: 40}}
	controller := NewWithSampler(sampler)
	controller.step(time.Now())
	before := controller.GetSnapshot().PressurePercent
	sampler.pressure = ResourcePressure{CPUPercent: 100}
	for range 100 {
		_ = controller.Admit(TrafficClassProxy, "proxy", Usage{})
	}
	if sampler.calls != 1 {
		t.Fatalf("sampler calls = %d, want only the explicit step", sampler.calls)
	}
	if after := controller.GetSnapshot().PressurePercent; after != before {
		t.Fatalf("pressure moved from %d to %d without a sampling step", before, after)
	}
}

// The smoothing follows time, not the number of steps: one step 10 ms after
// the last barely moves it, one after a long pause takes the new sample.
func TestSmoothingIsTimeBased(t *testing.T) {
	controller, sampler := newTestController(0)
	now := time.Now()
	controller.step(now)
	sampler.pressure = ResourcePressure{CPUPercent: 100}
	controller.step(now.Add(10 * time.Millisecond))
	if got := controller.GetSnapshot().PressurePercent; got > 2 {
		t.Fatalf("pressure after 10 ms = %d", got)
	}
	controller.step(now.Add(10 * time.Second))
	if got := controller.GetSnapshot().PressurePercent; got < 99 {
		t.Fatalf("pressure after 10 s = %d", got)
	}
}

// F6: registry routes share the registry class fairly under pressure, apart
// from proxy routes, and their refusals are counted as registry.
func TestRegistryRoutesGetFairShare(t *testing.T) {
	controller, _ := newTestController(72)
	warm(controller)
	usage := Usage{
		ActiveProxy: 10, ProxyByRoute: map[string]uint64{"proxy": 10},
		ActiveRegistry: 10_002, RegistryByRoute: map[string]uint64{"pulls": 10_000, "pushes": 2},
	}
	if err := controller.Admit(TrafficClassRegistry, "pulls", usage); err == nil {
		t.Fatal("dominant registry route was admitted under pressure")
	}
	if err := controller.Admit(TrafficClassRegistry, "pushes", usage); err != nil {
		t.Fatalf("small registry route did not receive fair admission: %v", err)
	}
	if err := controller.Admit(TrafficClassRegistry, "new", usage); err != nil {
		t.Fatalf("new registry route did not receive fair admission: %v", err)
	}
	snapshot := controller.GetSnapshot()
	if snapshot.ThrottledRegistryTotal != 1 || snapshot.ThrottledProxyTotal != 0 {
		t.Fatalf("throttled registry=%d proxy=%d", snapshot.ThrottledRegistryTotal, snapshot.ThrottledProxyTotal)
	}
}

type countingSampler struct {
	pressure ResourcePressure
	calls    int
}

func (s *countingSampler) Sample() ResourcePressure {
	s.calls++
	return s.pressure
}

// Daemons recognize an admission-pressure refusal by this message and demote
// the relay for new tunnels (daemon-shared relaybridge.RelayPenalties.Opened):
// a changed wording would leave an overloaded relay first again.
func TestRejectedMessageIsTheDaemonsContract(t *testing.T) {
	for state, want := range map[string]string{
		"hard_pressure":    "relay adaptive admission rejected database tunnel: hard_pressure",
		"database_reserve": "relay adaptive admission rejected database tunnel: database_reserve",
		"fair_share":       "relay adaptive admission rejected database tunnel: fair_share",
	} {
		if got := (&Rejected{TrafficClass: TrafficClassDatabase, State: state}).Error(); got != want {
			t.Fatalf("Rejected message %q, daemons expect %q", got, want)
		}
	}
}
