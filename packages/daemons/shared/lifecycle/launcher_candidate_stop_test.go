package lifecycle

import (
	"path/filepath"
	"testing"
	"time"
)

// An update candidate stopped on trial hands its connections over when the
// daemon its launcher restores takes a handover over (O-13): never before the
// candidate started, never for a previous daemon that predates handovers.
func TestCandidateStopHandsOverOnlyToADaemonThatTakesItOver(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	binary := filepath.Join(dir, "bin", "docker-daemon")
	writeLauncherProbeExecutable(t, binary, nil)
	state, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	previousVersion := Version
	Version = "v2"
	t.Cleanup(func() { Version = previousVersion })
	t.Setenv(LauncherManagedEnv, "1")
	t.Setenv(LauncherStateDirEnv, stateDir)

	// The previous daemon stops for the update (journal staged): not a candidate.
	writeLauncherProbeExecutable(t, state.PreviousPath, launcherBinaryFeatures)
	if candidateStopHandsOver() {
		t.Fatal("a staged update counted as a candidate on trial")
	}
	if err := markLauncherCandidateStarted(stateDir, state, time.Now()); err != nil {
		t.Fatal(err)
	}
	if !candidateStopHandsOver() {
		t.Fatal("a candidate on trial with a previous daemon that takes handovers over does not hand over")
	}
	if err := markLauncherLocalReady(stateDir, state, time.Now()); err != nil {
		t.Fatal(err)
	}
	if !candidateStopHandsOver() {
		t.Fatal("a locally ready candidate waiting for Opfield does not hand over")
	}
	// A previous daemon from before launcher self-update never takes a handover.
	writeLauncherProbeExecutable(t, state.PreviousPath, nil)
	if candidateStopHandsOver() {
		t.Fatal("handing over to a previous daemon that predates handovers")
	}
	writeLauncherProbeExecutable(t, state.PreviousPath, launcherBinaryFeatures)
	// Another version than the update's target is not its candidate.
	Version = "v3"
	if candidateStopHandsOver() {
		t.Fatal("a daemon of another version counted as the candidate")
	}
	Version = "v2"
	// A committed update: no journal.
	if err := removeLauncherUpdateState(stateDir); err != nil {
		t.Fatal(err)
	}
	if candidateStopHandsOver() {
		t.Fatal("a committed daemon counted as a candidate")
	}
}
