package docker

import (
	"sync"
	"time"
)

// engineIncidentWindow is how far back the stops of an engine that nobody
// asked for (a crash, an out-of-memory kill) are reported.
const (
	engineIncidentWindow = 24 * time.Hour
	engineIncidentLimit  = 256
	// An engine that stopped on its own twice within this window and has not
	// run for engineRestartStableAfter since keeps failing.
	engineCrashLoopWindow = 5 * time.Minute
)

type engineIncident struct {
	at  time.Time
	oom bool
	// killed: a SIGKILL from another process (kill -9 of the engine's
	// process), not the kernel's out-of-memory kill.
	killed bool
}

// engineIncidents records, per instance, the stops of its engine nobody asked
// for. The supervisor starts such an engine again within seconds, so without
// them an engine the kernel kills for memory every few minutes would look
// healthy whenever Opfield asks.
type engineIncidents struct {
	mu     sync.Mutex
	events map[string][]engineIncident
	now    func() time.Time
}

func newEngineIncidents() *engineIncidents {
	return &engineIncidents{events: map[string][]engineIncident{}, now: time.Now}
}

func (e *engineIncidents) record(key string, oom bool) {
	cause := engineStopExited
	if oom {
		cause = engineStopOutOfMemory
	}
	e.recordStop(key, cause)
}

// recordStop records an unrequested stop with its cause.
func (e *engineIncidents) recordStop(key string, cause engineStopCause) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	events := append(e.prune(key, now), engineIncident{at: now, oom: cause == engineStopOutOfMemory, killed: cause == engineStopKilled})
	if len(events) > engineIncidentLimit {
		events = events[len(events)-engineIncidentLimit:]
	}
	e.events[key] = events
}

func (e *engineIncidents) forget(key string) {
	if e == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.events, key)
}

func (e *engineIncidents) prune(key string, now time.Time) []engineIncident {
	events := e.events[key]
	kept := events[:0]
	for _, event := range events {
		if now.Sub(event.at) <= engineIncidentWindow {
			kept = append(kept, event)
		}
	}
	if len(kept) == 0 {
		delete(e.events, key)
		return nil
	}
	e.events[key] = kept
	return kept
}

// detail is what inspect reports: the unrequested stops of the last day, how
// many of them were out-of-memory kills and how many SIGKILLs from another
// process (never counted as out of memory), and when the last ones were.
func (e *engineIncidents) detail(key string) map[string]any {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	events := e.prune(key, e.now())
	if len(events) == 0 {
		return nil
	}
	oom, killed := 0, 0
	var lastOOM, lastKilled time.Time
	for _, event := range events {
		if event.oom {
			oom++
			lastOOM = event.at
		}
		if event.killed {
			killed++
			lastKilled = event.at
		}
	}
	detail := map[string]any{
		"restarts": len(events),
		"oomKills": oom,
		"lastAt":   events[len(events)-1].at.UTC().Format(time.RFC3339),
		"sinceAt":  events[0].at.UTC().Format(time.RFC3339),
	}
	if oom > 0 {
		detail["lastOomAt"] = lastOOM.UTC().Format(time.RFC3339)
	}
	if killed > 0 {
		detail["signalKills"] = killed
		detail["lastSignalKillAt"] = lastKilled.UTC().Format(time.RFC3339)
	}
	return detail
}

// crashLooping reports an engine that stopped on its own at least twice in
// the last few minutes and has not run for a minute since startedAt (zero
// when it is not running).
func (e *engineIncidents) crashLooping(key string, startedAt time.Time) bool {
	if e == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	if !startedAt.IsZero() && now.Sub(startedAt) >= engineRestartStableAfter {
		return false
	}
	recent := 0
	for _, event := range e.events[key] {
		if now.Sub(event.at) <= engineCrashLoopWindow {
			recent++
		}
	}
	return recent >= 2
}
