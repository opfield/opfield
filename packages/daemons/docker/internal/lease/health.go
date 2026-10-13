package lease

import (
	"fmt"
	"time"
)

// Health release (D6) ports the backend health watch
// (opfield-commercial docker-availability.service.ts watchPlacementHealth /
// observePlacementHealth and adapters.ts runtimeInspection): the worst
// container decides; missing outranks stopped, which outranks restarting,
// which outranks a failing health check; a growing restart count is a loop.
// The daemon samples every 5 s and releases after 2 bad samples in a row.
// Opfield can ask for the same release when the copy fails its HTTP health
// check (ReleaseUnhealthy).
const (
	healthSampleEvery  = 5 * time.Second
	healthBadThreshold = 2
	// A node that released for health is not a candidate again for a
	// cooldown that doubles with every release of the same copy (the same
	// containers, restarted in place) that did not stay up for
	// healthStableAfter, from healthCooldownBase to healthCooldownMax: a
	// crash loop slows down, a single failure is healed in about 25 s. A new
	// copy (a rollout or recreate replaced the containers) starts over. The
	// protocol keeps the node from taking its own key back for
	// SuccessorWindow after the release anyway, so every other ready
	// candidate takes over first (by rank) even with the base cooldown.
	healthCooldownBase = 10 * time.Second
	healthCooldownMax  = 5 * time.Minute
	healthStableAfter  = 5 * time.Minute
	// healthRequestTTL drops a release request from Opfield that could not
	// be acted on (the copy was busy or not serving) instead of applying it
	// to a later copy.
	healthRequestTTL = 30 * time.Second
	// stableBeforeReady is how long a container without a health check runs
	// before its endpoint opens.
	stableBeforeReady = 3 * time.Second
)

// healthCooldown is the cooldown of the next health release of wl at now,
// and records that release.
func healthCooldown(wl *workload, now time.Duration) time.Duration {
	if wl.healthReleases > 0 && (now-wl.servingSince >= healthStableAfter || !sameIDs(wl.serveIDs, wl.healthReleasedIDs)) {
		wl.healthReleases = 0
	}
	cooldown := healthCooldownBase
	for i := 0; i < wl.healthReleases && cooldown < healthCooldownMax; i++ {
		cooldown *= 2
	}
	wl.healthReleases++
	wl.healthReleasedIDs = wl.serveIDs
	return min(cooldown, healthCooldownMax)
}

func sameIDs(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for id := range a {
		if !b[id] {
			return false
		}
	}
	return true
}

const (
	issueUnhealthy  = "unhealthy"
	issueRestarting = "restarting"
	issueStopped    = "stopped"
	issueMissing    = "missing"
)

var issueSeverity = map[string]int{issueUnhealthy: 1, issueRestarting: 2, issueStopped: 3, issueMissing: 4}

type healthTracker struct {
	lastSampleAt  time.Duration
	bad           int
	restartCounts map[string]int
	lastIssue     string
}

// classifyHealth returns the worst issue of the serving set, and whether a
// container is still starting. expected are the ids that must exist.
func classifyHealth(serve []Container, expected map[string]bool, previous map[string]int) (issue string, detail string, starting bool, counts map[string]int) {
	counts = map[string]int{}
	report := func(next, message string) {
		if issue == "" || issueSeverity[next] > issueSeverity[issue] {
			issue, detail = next, message
		}
	}
	if len(serve) == 0 {
		report(issueMissing, "the placement has no runtime containers")
	}
	present := map[string]bool{}
	for _, c := range serve {
		present[c.ID] = true
		counts[c.ID] = c.RestartCount
		if before, ok := previous[c.ID]; ok && c.RestartCount > before {
			report(issueRestarting, fmt.Sprintf("%s keeps restarting (restart count increased)", c.Name))
		}
		switch {
		case c.Restarting || c.Status == "restarting":
			report(issueRestarting, fmt.Sprintf("%s is restarting (%d restarts)", c.Name, c.RestartCount))
		case c.Paused || c.Status == "paused":
			report(issueStopped, fmt.Sprintf("%s is paused", c.Name))
		case !c.Running:
			report(issueStopped, fmt.Sprintf("%s is not running (exit code %d)", c.Name, c.ExitCode))
		case c.Health == "unhealthy":
			report(issueUnhealthy, fmt.Sprintf("%s failed its health check", c.Name))
		case c.Health == "starting":
			starting = true
		}
	}
	for id := range expected {
		if !present[id] {
			report(issueMissing, fmt.Sprintf("container %s no longer exists", shortID(id)))
		}
	}
	return issue, detail, starting, counts
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// sampleHealthLocked records one observation every healthSampleEvery and
// reports whether the release threshold was reached. A container view older
// than the sample period (dockerd hanging) is no evidence either way.
func (r *Runtime) sampleHealthLocked(wl *workload, serve []Container, now time.Duration) bool {
	tracker := &wl.health
	if now-tracker.lastSampleAt < healthSampleEvery || !r.snapshotFreshLocked(now) || now-r.snapshot.at > healthSampleEvery ||
		r.snapshot.at < wl.lastOpDone {
		return false
	}
	tracker.lastSampleAt = now
	issue, detail, _, counts := classifyHealth(serve, wl.serveIDs, tracker.restartCounts)
	tracker.restartCounts = counts
	if issue == "" {
		tracker.bad, tracker.lastIssue = 0, ""
		return false
	}
	tracker.bad++
	tracker.lastIssue = issue + ": " + detail
	return tracker.bad >= healthBadThreshold
}

// readyLocked gates endpoint registration: every serving container runs, is
// healthy (or has no health check and ran stableBeforeReady) (D8).
func (r *Runtime) readyLocked(wl *workload, serve []Container, now time.Duration) bool {
	if len(serve) == 0 || !r.snapshotFreshLocked(now) {
		return false
	}
	issue, _, starting, _ := classifyHealth(serve, wl.serveIDs, nil)
	if issue != "" || starting {
		return false
	}
	for _, c := range serve {
		if c.Health == "" && now-wl.servingSince < stableBeforeReady {
			return false
		}
	}
	return true
}
