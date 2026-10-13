package admission

import (
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"time"

	relayv1 "github.com/opfield/opfield/daemon-shared/relayv1"
)

const (
	TrafficClassProxy    = "proxy"
	TrafficClassDatabase = "database"
	TrafficClassRegistry = "registry"

	defaultProxyTargetPercent  = 70
	defaultDatabaseReserve     = 20
	defaultHardPressurePercent = 95
	pressureSampleInterval     = 250 * time.Millisecond
	// pressureTimeConstant is the EWMA time constant: a step in load moves the
	// smoothed pressure by 1-1/e within it, however often tunnels open.
	pressureTimeConstant = time.Second
	// samplerIdleExit stops the sampling loop of a controller nobody asked for
	// a decision or a snapshot for that long; the next request restarts it.
	samplerIdleExit = time.Minute
)

type ResourcePressure struct {
	CPUPercent          uint32
	MemoryPercent       uint32
	FDPercent           uint32
	MemoryRSSBytes      uint64
	HeapInUseBytes      uint64
	MemoryLimitBytes    uint64
	OpenFileDescriptors uint64
	FileDescriptorLimit uint64
}

func (p ResourcePressure) Maximum() uint32 {
	return max(p.CPUPercent, p.MemoryPercent, p.FDPercent)
}

type Usage struct {
	ActiveProxy     uint64
	ActiveDatabase  uint64
	ActiveRegistry  uint64
	ProxyByRoute    map[string]uint64
	RegistryByRoute map[string]uint64
}

type Snapshot struct {
	State                  string
	PressurePercent        uint32
	CPUPressurePercent     uint32
	MemoryPressurePercent  uint32
	FDPressurePercent      uint32
	MemoryRSSBytes         uint64
	HeapInUseBytes         uint64
	MemoryLimitBytes       uint64
	OpenFileDescriptors    uint64
	FileDescriptorLimit    uint64
	ThrottledProxyTotal    uint64
	ThrottledDatabaseTotal uint64
	// ThrottledRegistryTotal counts refused registry tunnels; HealthResponse
	// has no field for it yet, so it reaches only the relay log.
	ThrottledRegistryTotal uint64
}

type sampler interface {
	Sample() ResourcePressure
}

// measurement is what one sampling step publishes. Admit and GetSnapshot read
// it without a lock: admission runs under the broker's global lock and must
// neither measure nor wait for a measurement.
type measurement struct {
	state    string
	pressure float64
	cpu      float64
	memory   float64
	fd       float64
	last     ResourcePressure
}

type Controller struct {
	// mu serializes sampling steps and policy updates; readers never take it.
	mu       sync.Mutex
	policy   atomic.Pointer[relayv1.AdmissionPolicy]
	current  atomic.Pointer[measurement]
	sampler  sampler
	sampled  bool
	sampleAt time.Time
	// autoSample runs the sampling loop on demand (New); a controller built
	// with NewWithSampler is stepped by its caller.
	autoSample bool
	running    atomic.Bool
	lastUsed   atomic.Int64

	throttledProxyTotal    atomic.Uint64
	throttledDatabaseTotal atomic.Uint64
	throttledRegistryTotal atomic.Uint64
}

func New() *Controller {
	controller := NewWithSampler(&systemSampler{})
	controller.autoSample = true
	return controller
}

func NewWithSampler(source sampler) *Controller {
	controller := &Controller{sampler: source}
	controller.current.Store(&measurement{state: "normal"})
	controller.UpdatePolicy(nil)
	return controller
}

func (c *Controller) UpdatePolicy(next *relayv1.AdmissionPolicy) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.policy.Store(normalizedPolicy(next))
	current := *c.current.Load()
	current.state = nextState(c.policy.Load(), current.state, current.pressure)
	c.current.Store(&current)
}

// Admit decides one tunnel from the latest published measurement. It takes no
// lock and never samples.
func (c *Controller) Admit(trafficClass, routeID string, usage Usage) error {
	c.ensureSampling()
	policy := c.policy.Load()
	if !policy.Enabled {
		return nil
	}
	current := c.current.Load()
	pressure := uint32(math.Round(current.pressure))
	proxyTarget := policy.ProxyTargetPressurePercent
	hardCutoff := policy.HardPressurePercent
	proxyCutoff := hardCutoff - policy.DatabaseReservePercent

	if trafficClass == TrafficClassDatabase {
		if pressure >= hardCutoff {
			c.throttledDatabaseTotal.Add(1)
			return &Rejected{TrafficClass: trafficClass, State: "hard_pressure"}
		}
		return nil
	}

	if trafficClass != TrafficClassProxy && trafficClass != TrafficClassRegistry {
		return &Rejected{TrafficClass: trafficClass, State: "unknown_traffic_class"}
	}
	if pressure >= proxyCutoff {
		c.countThrottled(trafficClass)
		return &Rejected{TrafficClass: trafficClass, State: "database_reserve"}
	}
	if pressure < proxyTarget || current.state == "normal" {
		return nil
	}
	if routeGetsFairAdmission(trafficClass, routeID, usage) {
		return nil
	}
	c.countThrottled(trafficClass)
	return &Rejected{TrafficClass: trafficClass, State: "fair_share"}
}

func (c *Controller) countThrottled(trafficClass string) {
	if trafficClass == TrafficClassRegistry {
		c.throttledRegistryTotal.Add(1)
		return
	}
	c.throttledProxyTotal.Add(1)
}

func (c *Controller) GetSnapshot() Snapshot {
	c.ensureSampling()
	current := c.current.Load()
	return Snapshot{
		State:                  current.state,
		PressurePercent:        uint32(math.Round(current.pressure)),
		CPUPressurePercent:     uint32(math.Round(current.cpu)),
		MemoryPressurePercent:  uint32(math.Round(current.memory)),
		FDPressurePercent:      uint32(math.Round(current.fd)),
		MemoryRSSBytes:         current.last.MemoryRSSBytes,
		HeapInUseBytes:         current.last.HeapInUseBytes,
		MemoryLimitBytes:       current.last.MemoryLimitBytes,
		OpenFileDescriptors:    current.last.OpenFileDescriptors,
		FileDescriptorLimit:    current.last.FileDescriptorLimit,
		ThrottledProxyTotal:    c.throttledProxyTotal.Load(),
		ThrottledDatabaseTotal: c.throttledDatabaseTotal.Load(),
		ThrottledRegistryTotal: c.throttledRegistryTotal.Load(),
	}
}

// ensureSampling starts the sampling loop of an automatic controller. The
// first measurement is taken inline so the very first decision has one; the
// loop measures every pressureSampleInterval after that and stops once nobody
// asked for samplerIdleExit.
func (c *Controller) ensureSampling() {
	if !c.autoSample {
		return
	}
	c.lastUsed.Store(time.Now().UnixNano())
	if c.running.Load() || !c.running.CompareAndSwap(false, true) {
		return
	}
	c.mu.Lock()
	stale := !c.sampled || time.Since(c.sampleAt) > 2*pressureSampleInterval
	c.mu.Unlock()
	if stale {
		// The first decision, or the first after an idle stop: the relay is
		// idle then, so one inline measurement is cheap.
		c.step(time.Now())
	}
	go c.sampleLoop()
}

func (c *Controller) idle() bool {
	return time.Since(time.Unix(0, c.lastUsed.Load())) > samplerIdleExit
}

func (c *Controller) sampleLoop() {
	ticker := time.NewTicker(pressureSampleInterval)
	defer ticker.Stop()
	for now := range ticker.C {
		if c.idle() {
			c.running.Store(false)
			// A request between the check and the store saw the loop running
			// and started none: keep sampling for it unless one did start.
			if c.idle() || !c.running.CompareAndSwap(false, true) {
				return
			}
		}
		c.step(now)
	}
}

// step takes one measurement and advances the smoothed pressure by the time
// since the previous one (alpha = 1-exp(-dt/tau)), so a burst of tunnel opens
// cannot skip the smoothing and a long pause does not freeze a stale sample.
func (c *Controller) step(now time.Time) {
	sample := c.sampler.Sample()
	c.mu.Lock()
	defer c.mu.Unlock()
	previous := c.current.Load()
	next := measurement{state: previous.state, last: sample}
	instant := float64(sample.Maximum())
	if !c.sampled {
		next.pressure, next.cpu = instant, float64(sample.CPUPercent)
		next.memory, next.fd = float64(sample.MemoryPercent), float64(sample.FDPercent)
		c.sampled = true
	} else {
		elapsed := now.Sub(c.sampleAt)
		if elapsed <= 0 {
			elapsed = pressureSampleInterval
		}
		alpha := 1 - math.Exp(-float64(elapsed)/float64(pressureTimeConstant))
		smooth := func(from, value float64) float64 { return from + (value-from)*alpha }
		next.pressure = smooth(previous.pressure, instant)
		next.cpu = smooth(previous.cpu, float64(sample.CPUPercent))
		next.memory = smooth(previous.memory, float64(sample.MemoryPercent))
		next.fd = smooth(previous.fd, float64(sample.FDPercent))
	}
	c.sampleAt = now
	next.state = nextState(c.policy.Load(), previous.state, next.pressure)
	if next.state != previous.state {
		slog.Info("relay admission state changed", "from", previous.state, "to", next.state,
			"pressure_percent", uint32(math.Round(next.pressure)), "cpu_percent", sample.CPUPercent,
			"memory_percent", sample.MemoryPercent, "fd_percent", sample.FDPercent,
			"throttled_proxy_total", c.throttledProxyTotal.Load(), "throttled_database_total", c.throttledDatabaseTotal.Load(),
			"throttled_registry_total", c.throttledRegistryTotal.Load())
	}
	c.current.Store(&next)
}

func nextState(policy *relayv1.AdmissionPolicy, state string, smoothed float64) string {
	if !policy.Enabled {
		return "disabled"
	}
	if state == "disabled" || state == "" {
		state = "normal"
	}
	pressure := uint32(math.Round(smoothed))
	proxyTarget := policy.ProxyTargetPressurePercent
	proxyCutoff := policy.HardPressurePercent - policy.DatabaseReservePercent
	recovery := proxyTarget - 10
	switch {
	case pressure >= policy.HardPressurePercent:
		return "hard_pressure"
	case pressure >= proxyCutoff:
		return "database_reserved"
	case pressure >= proxyTarget:
		return "proxy_throttled"
	case pressure <= recovery:
		return "normal"
	}
	return state
}

func normalizedPolicy(value *relayv1.AdmissionPolicy) *relayv1.AdmissionPolicy {
	if value == nil {
		return &relayv1.AdmissionPolicy{
			Enabled:                    true,
			ProxyTargetPressurePercent: defaultProxyTargetPercent,
			DatabaseReservePercent:     defaultDatabaseReserve,
			HardPressurePercent:        defaultHardPressurePercent,
		}
	}
	return &relayv1.AdmissionPolicy{
		Enabled:                    value.Enabled,
		ProxyTargetPressurePercent: value.ProxyTargetPressurePercent,
		DatabaseReservePercent:     value.DatabaseReservePercent,
		HardPressurePercent:        value.HardPressurePercent,
	}
}

// routeGetsFairAdmission shares a class between its routes under pressure:
// proxy routes among proxy routes, registry routes among registry routes.
func routeGetsFairAdmission(trafficClass, routeID string, usage Usage) bool {
	byRoute, total := usage.ProxyByRoute, usage.ActiveProxy
	if trafficClass == TrafficClassRegistry {
		byRoute, total = usage.RegistryByRoute, usage.ActiveRegistry
	}
	current := byRoute[routeID]
	if current == 0 {
		return true
	}
	activeRoutes := uint64(0)
	for _, count := range byRoute {
		if count > 0 {
			activeRoutes++
		}
	}
	if activeRoutes <= 1 {
		return false
	}
	fairShare := (total + activeRoutes - 1) / activeRoutes
	return current < fairShare
}

type Rejected struct {
	TrafficClass string
	State        string
}

func (e *Rejected) Error() string {
	return "relay adaptive admission rejected " + e.TrafficClass + " tunnel: " + e.State
}
