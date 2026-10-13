package lease

import (
	"time"

	"github.com/opfield/opfield/daemon-shared/leasefence"
)

// Watchdog liveness has two thresholds (A12.4).
//
// Fresh (heartbeat age <= leasefence.HeartbeatMaxAge, 3 s) gates everything
// that begins something: acquiring, starting a container, the backend gate
// and candidacy. A late heartbeat only delays these.
//
// Lost (age > leasefence.HeartbeatLostAge, 10 s, seen on two steps at least
// watchdogLostConfirm apart, or no heartbeat at all) makes a holder stop
// renewing and kill its containers. The bound:
//
//   - While the daemon runs, safety does not depend on the watchdog: the
//     daemon fences on its own timer at most 24 s after the send time of its
//     last successful round, and a successor starts no earlier than 30 real
//     seconds after the last accept of that round (AcceptorHold 33 s, 10%
//     clock rate) plus its rank. The watchdog is the backstop for a daemon
//     that dies or hangs, so a dead watchdog matters only if the daemon fails
//     too; the lost threshold bounds how long a node renews without it.
//   - A dead watchdog is seen at most HeartbeatLostAge, watchdogLostConfirm
//     and one step (250 ms) after its last heartbeat, about 11.5 s: the daemon
//     then abandons the key (no further renewal) and kills the containers
//     with no grace. The kill therefore precedes both its own 24 s timer and
//     any successor start, which needs 30 s after the last accept (scenario
//     l).
//   - The watchdog writes its heartbeat every HeartbeatInterval (1 s) from a
//     250 ms pass loop, so a watchdog stalled for up to ~8.7 s (CPU
//     starvation) never fences a workload; the old single 3 s threshold
//     fenced after a 1.75 s stall.
//
// Readers take the clock before reading the file; a heartbeat written in
// between is fresh (leasefence.Heartbeat.Age), not stale.
const watchdogLostConfirm = time.Second

type watchdogState struct {
	fresh bool
	alive bool
	lost  bool
	// lostSince is the first step of the current loss run, lostSteps how
	// many consecutive steps saw it.
	lostSince time.Duration
	lostSteps int
}

// observeWatchdogLocked records one heartbeat observation of a Step.
func (r *Runtime) observeWatchdogLocked(now, age time.Duration, present bool) {
	wd := &r.watchdog
	wd.fresh = present && age <= leasefence.HeartbeatMaxAge
	wd.alive = present && age <= leasefence.HeartbeatLostAge
	if wd.alive {
		if wd.lost {
			r.logger.Info("lease watchdog heartbeat is back")
		}
		wd.lost, wd.lostSteps = false, 0
		return
	}
	if wd.lostSteps == 0 {
		wd.lostSince = now
	}
	wd.lostSteps++
	if !wd.lost && wd.lostSteps >= 2 && now-wd.lostSince >= watchdogLostConfirm {
		wd.lost = true
		r.logger.Warn("lease watchdog heartbeat lost; holders stop renewing and kill their containers",
			"heartbeat_present", present, "heartbeat_age", age)
	}
}
