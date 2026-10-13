package lifecycle

import (
	"path/filepath"
	"strings"
)

// A launcher stops an update candidate on trial that does not prove itself
// (no local readiness, no Gateway control readiness) and starts the previous
// daemon again at once. That previous daemon (2.11.4-rc.6 or later) takes
// over connections handed to it like the next process of an update does, so
// a candidate stopped on trial hands its connections over too: a rollback
// keeps the streams the candidate took over and opened, instead of cutting
// them and leaving the restored daemon to find their peers reset. A stop of
// the whole service (the keeper stops with it) loses that handover, which
// costs nothing over the cut it replaces.

// candidateStopHandsOver reports whether this daemon is an update candidate
// still on trial whose previous daemon takes a handover over.
func candidateStopHandsOver() bool {
	if launcherManagedFromEnvironment() != "1" {
		return false
	}
	stateDir := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv))
	if !filepath.IsAbs(stateDir) {
		return false
	}
	state, err := readLauncherUpdateState(stateDir)
	if err != nil || state == nil || state.Phase == "staged" || state.TargetVersion != Version {
		return false
	}
	// Every daemon with launcher self-update (2.11.4-rc.6 on) restores a
	// handover at its start; older ones would leave the handed over sockets
	// in the keeper.
	probe, err := probeLauncherFeatures(state.PreviousPath)
	return err == nil && probe.has(LauncherFeatureSelfUpdate)
}
