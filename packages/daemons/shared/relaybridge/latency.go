package relaybridge

import (
	"sort"
	"sync"
	"time"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const (
	// LatencySampleInterval is how often a daemon measures each relay.
	LatencySampleInterval = 30 * time.Second
	// latencyWeight is the share of a new sample in the moving average: a
	// single slow round trip moves it, but only a lasting change settles it.
	latencyWeight = 0.3
	// latencyMaxAge drops a relay that was not measured for a few intervals:
	// its distance is unknown again rather than stale. A relay the daemon
	// keeps failing to reach is still reported (Samples).
	latencyMaxAge = 3 * time.Minute
)

// LatencyTracker holds the smoothed round-trip time from this daemon to each
// relay. It is process-wide: the lifecycle measures, tunnel selection reads.
type LatencyTracker struct {
	mu      sync.Mutex
	now     func() time.Time
	samples map[string]latencySample
}

type latencySample struct {
	micros float64
	// at is the last measurement (zero: never measured).
	at time.Time
	// failingSince is when this daemon stopped reaching the relay (its lanes
	// went down, or a probe went unanswered); zero while it reaches it.
	failingSince time.Time
	// failedAt is when the daemon last failed to reach it. The prober tries
	// every relay of its assignments and of the pool each interval, so a
	// failure confirmed within latencyMaxAge is one it still sees.
	failedAt time.Time
}

// Latency is the tracker the daemon lifecycle feeds and tunnel selection reads.
var Latency = NewLatencyTracker(time.Now)

func NewLatencyTracker(now func() time.Time) *LatencyTracker {
	return &LatencyTracker{now: now, samples: map[string]latencySample{}}
}

// Observe folds one measured round trip into the relay's moving average.
func (t *LatencyTracker) Observe(relayInstanceID string, rtt time.Duration) {
	if relayInstanceID == "" || rtt <= 0 {
		return
	}
	micros := float64(rtt.Microseconds())
	if micros < 1 {
		micros = 1
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if current, ok := t.samples[relayInstanceID]; ok && current.measured(now) {
		micros = current.micros + latencyWeight*(micros-current.micros)
	}
	t.samples[relayInstanceID] = latencySample{micros: micros, at: now}
}

// Fail records that this daemon could not reach the relay: its lanes went
// down or a probe went unanswered. The round trip measured before stays (the
// relay's distance did not change), and the health report says for how long
// the relay has been failing, which Gateway reads as a data-plane failure. A
// relay never measured is reported failing too, without a round trip.
func (t *LatencyTracker) Fail(relayInstanceID string) {
	if relayInstanceID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	sample := t.samples[relayInstanceID]
	if sample.failingSince.IsZero() {
		sample.failingSince = now
	}
	sample.failedAt = now
	t.samples[relayInstanceID] = sample
}

// Reached clears a failure without a new measurement: a lane to the relay is
// connected again.
func (t *LatencyTracker) Reached(relayInstanceID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if sample, ok := t.samples[relayInstanceID]; ok && !sample.failingSince.IsZero() {
		sample.failingSince, sample.failedAt = time.Time{}, time.Time{}
		t.samples[relayInstanceID] = sample
	}
}

// RTT is the relay's smoothed round trip, if it was measured recently.
func (t *LatencyTracker) RTT(relayInstanceID string) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	sample, ok := t.samples[relayInstanceID]
	if !ok || !sample.measured(t.now()) {
		return 0, false
	}
	return time.Duration(sample.micros * float64(time.Microsecond)), true
}

// measured reports a round trip recent enough to use.
func (s latencySample) measured(now time.Time) bool {
	return !s.at.IsZero() && now.Sub(s.at) <= latencyMaxAge
}

// failing reports a relay the daemon still fails to reach: one it keeps
// trying, not one it stopped measuring.
func (s latencySample) failing(now time.Time) bool {
	return !s.failingSince.IsZero() && now.Sub(s.failedAt) <= latencyMaxAge
}

// Samples reports every recently measured relay, and every relay the daemon
// keeps failing to reach, for the health report. A failing relay stays in it
// however long ago it was last measured (its round trip 0 once that is
// stale): it is in this daemon's assignments or among the relays to measure,
// and Gateway keeps it out of placement only while the daemons say so.
func (t *LatencyTracker) Samples() []*pb.RelayLatencySample {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	result := make([]*pb.RelayLatencySample, 0, len(t.samples))
	for id, sample := range t.samples {
		measured, failing := sample.measured(now), sample.failing(now)
		if !measured && !failing {
			delete(t.samples, id)
			continue
		}
		report := &pb.RelayLatencySample{RelayInstanceId: id}
		if measured {
			report.RttMicros = uint32(sample.micros + 0.5)
		}
		if failing {
			report.FailingMs = uint32(max(1, now.Sub(sample.failingSince).Milliseconds()))
		}
		result = append(result, report)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RelayInstanceId < result[j].RelayInstanceId })
	return result
}

// LatencyTargets lists the pool relays Gateway asks this daemon to measure,
// with the relays its assignments use first so their details win.
func LatencyTargets(bundle *pb.SyncRelayGrantsCommand) []Target {
	byID := map[string]Target{}
	for _, target := range RequiredTargets(bundle) {
		byID[target.ID] = target
	}
	for _, target := range bundle.GetRelayLatencyTargets() {
		id := target.GetRelayInstanceId()
		if _, known := byID[id]; id == "" || known {
			continue
		}
		byID[id] = Target{ID: id, Addresses: append([]string(nil), target.GetAddresses()...), Port: target.GetPort()}
	}
	result := make([]Target, 0, len(byID))
	for _, target := range byID {
		result = append(result, target)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
