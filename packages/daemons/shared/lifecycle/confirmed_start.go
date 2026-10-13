package lifecycle

import (
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A start is confirmed once Opfield accepted this process's control session
// and, when the launcher started it as an update candidate, the launcher
// committed the update (its stability window passed). Before that the launcher
// may still roll back to the previous daemon binary, which can be a release
// that knows only the pre-Opfield host names; so renames of host objects that
// such a release would need (directories, config keys, service units) run only
// in the hooks registered here.

var startConfirmed struct {
	sync.Mutex
	fired bool
	hooks []func()
}

// startConfirmedPoll is how often a candidate looks whether the launcher
// committed it.
var startConfirmedPoll = 2 * time.Second

// OnStartConfirmed runs fn once this start is confirmed (at once, in its own
// goroutine, when it already is). Hooks must be idempotent and crash-safe: a
// crash or reboot reruns them on the next confirmed start.
func OnStartConfirmed(fn func()) {
	startConfirmed.Lock()
	if startConfirmed.fired {
		startConfirmed.Unlock()
		go fn()
		return
	}
	startConfirmed.hooks = append(startConfirmed.hooks, fn)
	startConfirmed.Unlock()
}

// StartConfirmed reports whether this start is confirmed.
func StartConfirmed() bool {
	startConfirmed.Lock()
	defer startConfirmed.Unlock()
	return startConfirmed.fired
}

// UpdateCandidate reports whether the launcher may still roll this start back: it runs a pending update the launcher
// has not committed yet. False once the start is confirmed, and for a start without a pending update (nothing to roll
// back to), which is confirmed as soon as Opfield accepts its control session.
func UpdateCandidate() bool {
	if StartConfirmed() {
		return false
	}
	stateDir := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv))
	if launcherManagedFromEnvironment() != "1" || !filepath.IsAbs(stateDir) {
		return false
	}
	pending, err := readLauncherUpdateState(stateDir)
	return err != nil || pending != nil
}

func fireStartConfirmed() {
	startConfirmed.Lock()
	if startConfirmed.fired {
		startConfirmed.Unlock()
		return
	}
	startConfirmed.fired = true
	hooks := startConfirmed.hooks
	startConfirmed.hooks = nil
	startConfirmed.Unlock()
	for _, hook := range hooks {
		hook()
	}
}

// scheduleStartConfirmed fires the hooks once the launcher committed this
// process's update; directly when no launcher manages the daemon (nothing can
// roll it back) or no update is pending.
func scheduleStartConfirmed(version string, logger *slog.Logger) {
	stateDir := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv))
	if launcherManagedFromEnvironment() != "1" || !filepath.IsAbs(stateDir) {
		go fireStartConfirmed()
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	go func() {
		waiting := false
		for {
			pending, err := readLauncherUpdateState(stateDir)
			if err == nil && (pending == nil || pending.TargetVersion != version) {
				if waiting {
					logger.Info("daemon update committed by the launcher; finishing host renames", "version", version)
				}
				fireStartConfirmed()
				return
			}
			waiting = true
			time.Sleep(startConfirmedPoll)
		}
	}()
}

// ResetStartConfirmedForTest forgets the confirmation and its hooks (tests).
func ResetStartConfirmedForTest(confirmed bool) {
	startConfirmed.Lock()
	defer startConfirmed.Unlock()
	startConfirmed.fired, startConfirmed.hooks = confirmed, nil
}
