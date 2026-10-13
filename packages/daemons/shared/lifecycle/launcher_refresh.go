package lifecycle

// Launcher refresh.
//
// BootstrapLauncher installs the stable launcher copy once and never replaces
// it, so a node keeps the launcher code it was first installed with. A refresh
// moves the copy forward without ever exposing a node to an unproven launcher:
//
//  1. stage: once the gateway accepted a committed daemon, the daemon copies
//     its own binary to <launcher>.next and journals a trial. The launcher copy
//     itself is untouched, and nothing is staged while an update is pending.
//  2. trial: the running launcher execs <launcher>.next in place at a safe
//     moment (launcher_selfupdate.go), or the next BootstrapLauncher execs it
//     instead of the copy; either counts the attempt. Binaries that predate
//     the refresh never look at .next and keep using the known-good copy.
//  3. promote: the trial launcher replaces the copy once one of its children
//     was locally ready and stayed up for the stability window. The replaced
//     copy is kept as <launcher>.previous.
//  4. abandon: a trial that did not confirm after launcherRefreshAttemptLimit
//     starts, whose children kept failing, or whose staged file changed is
//     abandoned. The copy is used again and the same binary is never retried.
//
// A launcher process that predates the exec in place takes a refreshed
// launcher only when it next starts; a daemon under it turns its next update
// into one restart of the whole service for that (launcher_service_restart.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	launcherRefreshSchemaVersion     = 1
	launcherRefreshPhaseTrial        = "trial"
	launcherRefreshPhaseAbandoned    = "abandoned"
	launcherRefreshAttemptLimit      = 3
	launcherRefreshChildFailureLimit = 3
)

var (
	launcherRefreshCommitWait   = 5 * time.Minute
	launcherRefreshPollInterval = 5 * time.Second
	// launcherRefreshTrialWait bounds how long a daemon waits for a launcher
	// trial in progress to end before it stages itself (the trial confirms
	// after the child ran stable, well under a minute).
	launcherRefreshTrialWait   = 3 * time.Minute
	launcherRefreshLockTimeout = 10 * time.Second

	// Overridable in tests: the resolved path of the running executable and
	// the exec used to fall back from a failed trial launcher.
	currentExecutable = func() (string, error) {
		executable, err := os.Executable()
		if err != nil {
			return "", err
		}
		return filepath.EvalSymlinks(executable)
	}
	launcherExec = syscall.Exec

	sha256HexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type launcherRefreshState struct {
	SchemaVersion int        `json:"schemaVersion"`
	Phase         string     `json:"phase"`
	LauncherPath  string     `json:"launcherPath"`
	TargetSHA256  string     `json:"targetSha256"`
	TargetVersion string     `json:"targetVersion"`
	StagedAt      time.Time  `json:"stagedAt"`
	Attempts      int        `json:"attempts"`
	Reason        string     `json:"reason,omitempty"`
	AbandonedAt   *time.Time `json:"abandonedAt,omitempty"`
}

type launcherRefreshTrial struct {
	launcherPath string
	stagedPath   string
	targetSHA256 string
	failures     int
}

func launcherRefreshStatePath(stateDir string) string {
	return filepath.Join(stateDir, "launcher", "launcher-refresh.json")
}

func launcherRefreshLockPath(stateDir string) string {
	return filepath.Join(stateDir, "launcher", "launcher-refresh.lock")
}

func canonicalLauncherPath(stateDir, executable string) string {
	return filepath.Join(stateDir, "launcher", filepath.Base(executable)+"-launcher")
}

func stagedLauncherPath(launcherPath string) string {
	return launcherPath + ".next"
}

func previousLauncherPath(launcherPath string) string {
	return launcherPath + ".previous"
}

func launcherCommandArgs(launcherPath string, spec LauncherSpec) []string {
	args := []string{launcherPath, LauncherCommand, "--daemon-type", spec.DaemonType, "--state-dir", spec.StateDir, "--binary", spec.BinaryPath, "--"}
	return append(args, spec.ChildArgs...)
}

func readLauncherRefreshState(stateDir string) (*launcherRefreshState, error) {
	contents, err := os.ReadFile(launcherRefreshStatePath(stateDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var state launcherRefreshState
	if err := json.Unmarshal(contents, &state); err != nil {
		return nil, fmt.Errorf("decode launcher refresh state: %w", err)
	}
	validPhase := state.Phase == launcherRefreshPhaseTrial || state.Phase == launcherRefreshPhaseAbandoned
	if state.SchemaVersion != launcherRefreshSchemaVersion || !validPhase || !filepath.IsAbs(state.LauncherPath) || !sha256HexPattern.MatchString(state.TargetSHA256) {
		return nil, errors.New("launcher refresh state is invalid")
	}
	return &state, nil
}

func writeLauncherRefreshState(stateDir string, state *launcherRefreshState) error {
	state.SchemaVersion = launcherRefreshSchemaVersion
	return writeJSONFileAtomic(launcherRefreshStatePath(stateDir), state, 0600)
}

func removeLauncherRefreshState(stateDir string) error {
	path := launcherRefreshStatePath(stateDir)
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

// withLauncherRefreshLock serializes staging, trial selection and promotion,
// which run in different processes (daemon, bootstrap, launcher).
func withLauncherRefreshLock(stateDir string, fn func() error) error {
	if err := ensurePrivateLauncherDirectory(filepath.Join(stateDir, "launcher")); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), launcherRefreshLockTimeout)
	defer cancel()
	lock, err := acquireLauncherLock(ctx, launcherRefreshLockPath(stateDir))
	if err != nil {
		return fmt.Errorf("acquire launcher refresh lock: %w", err)
	}
	defer releaseLauncherLock(lock)
	return fn()
}

func regularFileExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("%s is not a regular file", path)
	}
	return true, nil
}

// stageLauncherRefresh stages source, the running committed daemon binary, as
// the next launcher. It never modifies the launcher copy and does nothing
// while a daemon update is pending.
// errLauncherTrialInProgress: a launcher started from the staged copy and has
// not confirmed or abandoned it yet. Every update restarts the launcher, and
// that start tries the launcher the previous daemon staged, while the updated
// daemon starts under it and would stage itself at once. Replacing the journal
// then left the trial nothing to promote, so no update ever installed a new
// launcher (N-20). The daemon waits for the trial to end instead.
var errLauncherTrialInProgress = errors.New("a launcher trial is in progress")

func stageLauncherRefresh(stateDir, launcherPath, source, version string, now time.Time) (bool, error) {
	staged := false
	err := withLauncherRefreshLock(stateDir, func() error {
		if pending, err := readLauncherUpdateState(stateDir); err != nil {
			return err
		} else if pending != nil {
			return nil
		}
		if exists, err := regularFileExists(launcherPath); err != nil {
			return err
		} else if !exists {
			// BootstrapLauncher installs a current copy when none exists.
			return nil
		}
		sourceSum, err := executableChecksum(source)
		if err != nil {
			return err
		}
		launcherSum, err := executableChecksum(launcherPath)
		if err != nil {
			return err
		}
		if launcherSum == sourceSum {
			return nil
		}
		next := stagedLauncherPath(launcherPath)
		current, readErr := readLauncherRefreshState(stateDir)
		if readErr == nil && current != nil && current.Phase == launcherRefreshPhaseTrial && current.Attempts > 0 &&
			current.TargetSHA256 != sourceSum && filepath.Clean(current.LauncherPath) == filepath.Clean(launcherPath) {
			// A launcher runs this trial (attempts are counted when it starts
			// one); it promotes or abandons it shortly.
			return errLauncherTrialInProgress
		}
		if readErr == nil && current != nil && current.TargetSHA256 == sourceSum && filepath.Clean(current.LauncherPath) == filepath.Clean(launcherPath) {
			if current.Phase == launcherRefreshPhaseAbandoned {
				// This binary already failed a launcher trial on this node.
				return nil
			}
			if nextSum, err := executableChecksum(next); err == nil && nextSum == sourceSum {
				return nil
			}
		}
		if sourceVersion, err := readDaemonBinaryVersion(source); err != nil {
			return fmt.Errorf("read daemon binary version: %w", err)
		} else if sourceVersion != version {
			return fmt.Errorf("daemon binary on disk is %s, not the running %s", sourceVersion, version)
		}
		// Retire an older trial before its staged file is replaced.
		if err := removeLauncherRefreshState(stateDir); err != nil {
			return err
		}
		if err := copyExecutableAtomic(source, next); err != nil {
			return fmt.Errorf("stage launcher copy: %w", err)
		}
		discard := func(cause error) error {
			_ = os.Remove(next)
			return cause
		}
		if nextSum, err := executableChecksum(next); err != nil {
			return discard(err)
		} else if nextSum != sourceSum {
			return discard(errors.New("daemon binary changed while it was staged"))
		}
		if err := probeLauncher(next); err != nil {
			return discard(fmt.Errorf("staged launcher probe failed: %w", err))
		}
		if nextVersion, err := readDaemonBinaryVersion(next); err != nil {
			return discard(fmt.Errorf("read staged launcher version: %w", err))
		} else if nextVersion != version {
			return discard(fmt.Errorf("staged launcher is %s, expected %s", nextVersion, version))
		}
		if err := writeLauncherRefreshState(stateDir, &launcherRefreshState{
			Phase:         launcherRefreshPhaseTrial,
			LauncherPath:  launcherPath,
			TargetSHA256:  sourceSum,
			TargetVersion: version,
			StagedAt:      now.UTC(),
		}); err != nil {
			return discard(fmt.Errorf("persist launcher refresh state: %w", err))
		}
		staged = true
		return nil
	})
	return staged, err
}

// selectLauncherForStart returns the launcher BootstrapLauncher execs: a
// staged trial launcher when one is due, otherwise the known-good copy. Every
// error keeps the known-good copy.
func selectLauncherForStart(stateDir, launcherPath string) string {
	selected := launcherPath
	err := withLauncherRefreshLock(stateDir, func() error {
		state, err := readLauncherRefreshState(stateDir)
		if err != nil {
			return err
		}
		if state == nil || state.Phase != launcherRefreshPhaseTrial || filepath.Clean(state.LauncherPath) != filepath.Clean(launcherPath) {
			return nil
		}
		// A pending daemon update stays with the launcher it was staged under,
		// unless the update restarts the service to start this trial
		// (launcher_service_restart.go).
		if pending, err := readLauncherUpdateState(stateDir); err != nil || (pending != nil && !pending.ServiceRestart) {
			return err
		}
		next, err := validateStagedLauncher(stateDir, state, launcherPath)
		if err != nil || next == "" {
			return err
		}
		// Count the attempt before exec so a crash-looping trial runs out.
		state.Attempts++
		if err := writeLauncherRefreshState(stateDir, state); err != nil {
			return err
		}
		selected = next
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher refresh skipped; using the installed launcher: %v\n", err)
		return launcherPath
	}
	return selected
}

// validateStagedLauncher returns the staged launcher of a due trial, or
// abandons a trial whose staged launcher cannot run and returns "". The
// caller holds the refresh lock.
func validateStagedLauncher(stateDir string, state *launcherRefreshState, launcherPath string) (string, error) {
	next := stagedLauncherPath(launcherPath)
	exists, err := regularFileExists(next)
	if err != nil {
		return "", abandonLauncherRefresh(stateDir, state, err.Error())
	}
	if !exists {
		if sum, sumErr := executableChecksum(launcherPath); sumErr == nil && sum == state.TargetSHA256 {
			// Promotion replaced the copy but did not clear the journal.
			return "", removeLauncherRefreshState(stateDir)
		}
		return "", abandonLauncherRefresh(stateDir, state, "staged launcher is missing")
	}
	if state.Attempts >= launcherRefreshAttemptLimit {
		return "", abandonLauncherRefresh(stateDir, state, fmt.Sprintf("staged launcher did not confirm after %d starts", state.Attempts))
	}
	if sum, err := executableChecksum(next); err != nil || sum != state.TargetSHA256 {
		return "", abandonLauncherRefresh(stateDir, state, "staged launcher checksum mismatch")
	}
	if err := probeLauncher(next); err != nil {
		return "", abandonLauncherRefresh(stateDir, state, "staged launcher probe failed: "+err.Error())
	}
	return next, nil
}

// abandonLauncherRefresh removes the staged launcher and records the target
// so it is never staged again. The caller holds the refresh lock.
func abandonLauncherRefresh(stateDir string, state *launcherRefreshState, reason string) error {
	if err := os.Remove(stagedLauncherPath(state.LauncherPath)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	abandonedAt := time.Now().UTC()
	state.Phase = launcherRefreshPhaseAbandoned
	state.Reason = reason
	state.AbandonedAt = &abandonedAt
	if err := writeLauncherRefreshState(stateDir, state); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Warning: abandoned launcher refresh to %s: %s\n", state.TargetVersion, reason)
	return nil
}

// detectLauncherRefreshTrial reports whether this launcher process runs from
// a staged launcher that is still on trial.
func detectLauncherRefreshTrial(stateDir string) *launcherRefreshTrial {
	executable, err := currentExecutable()
	if err != nil || !strings.HasSuffix(executable, ".next") {
		return nil
	}
	state, err := readLauncherRefreshState(stateDir)
	if err != nil || state == nil || state.Phase != launcherRefreshPhaseTrial {
		return nil
	}
	if filepath.Clean(stagedLauncherPath(state.LauncherPath)) != filepath.Clean(executable) {
		return nil
	}
	return &launcherRefreshTrial{
		launcherPath: state.LauncherPath,
		stagedPath:   executable,
		targetSHA256: state.TargetSHA256,
	}
}

// errLauncherTrialSuperseded: while this launcher was on trial, its journal
// was replaced. A newer daemon (an update during the trial) staged itself as
// the next launcher, or the trial was retired. Nothing is promoted; the
// installed launcher stays, and a newer staged one is tried on the next
// launcher start. Expected after an update that lands during a trial.
var errLauncherTrialSuperseded = errors.New("launcher refresh journal changed during the trial")

// promoteLauncherRefresh replaces the launcher copy with the proven trial
// launcher and keeps the replaced copy as <launcher>.previous.
func promoteLauncherRefresh(stateDir string, trial *launcherRefreshTrial) error {
	return withLauncherRefreshLock(stateDir, func() error {
		state, err := readLauncherRefreshState(stateDir)
		if err != nil {
			return err
		}
		if state == nil || state.Phase != launcherRefreshPhaseTrial || state.TargetSHA256 != trial.targetSHA256 || filepath.Clean(state.LauncherPath) != filepath.Clean(trial.launcherPath) {
			return errLauncherTrialSuperseded
		}
		if sum, err := executableChecksum(trial.stagedPath); err != nil {
			return err
		} else if sum != trial.targetSHA256 {
			return errors.New("staged launcher changed during the trial")
		}
		if err := copyExecutableAtomic(trial.launcherPath, previousLauncherPath(trial.launcherPath)); err != nil {
			return fmt.Errorf("back up launcher copy: %w", err)
		}
		if err := os.Rename(trial.stagedPath, trial.launcherPath); err != nil {
			return fmt.Errorf("promote staged launcher: %w", err)
		}
		if err := syncDirectory(filepath.Dir(trial.launcherPath)); err != nil {
			return err
		}
		return removeLauncherRefreshState(stateDir)
	})
}

// fallBackFromLauncherTrial abandons the trial and replaces this process with
// the known-good launcher copy. It returns only if exec fails.
func fallBackFromLauncherTrial(spec LauncherSpec, trial *launcherRefreshTrial, logger *slog.Logger) error {
	reason := fmt.Sprintf("daemon failed %d times under the staged launcher", trial.failures)
	if err := withLauncherRefreshLock(spec.StateDir, func() error {
		state, err := readLauncherRefreshState(spec.StateDir)
		if err != nil {
			return err
		}
		if state != nil && state.Phase == launcherRefreshPhaseTrial && state.TargetSHA256 == trial.targetSHA256 {
			return abandonLauncherRefresh(spec.StateDir, state, reason)
		}
		return nil
	}); err != nil {
		logger.Error("could not record the abandoned launcher refresh", "error", err)
	}
	logger.Error("staged launcher failed its trial; restarting with the installed launcher", "reason", reason, "launcher", trial.launcherPath)
	return launcherExec(trial.launcherPath, launcherCommandArgs(trial.launcherPath, spec), os.Environ())
}

// scheduleLauncherRefresh stages this daemon's binary as the next launcher
// once its update, if any, is committed. It runs after the gateway accepted
// the daemon, so only a committed daemon that reached control is staged.
func scheduleLauncherRefresh(version string, logger *slog.Logger) {
	if launcherManagedFromEnvironment() != "1" || strings.TrimSpace(version) == "" {
		return
	}
	stateDir := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv))
	if !filepath.IsAbs(stateDir) {
		return
	}
	executable, err := currentExecutable()
	if err != nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	launcherPath := canonicalLauncherPath(stateDir, executable)
	go func() {
		deadline := time.Now().Add(launcherRefreshCommitWait)
		// fromVersion: the version the update that started this process came
		// from ("" when this start was no update).
		fromVersion := ""
		for {
			pending, err := readLauncherUpdateState(stateDir)
			if err == nil && pending == nil {
				break
			}
			if err == nil && pending.TargetVersion == version && fromVersion == "" {
				fromVersion = pending.FromVersion
			}
			if time.Now().After(deadline) {
				logger.Info("launcher refresh skipped; daemon update is still pending", "version", version)
				return
			}
			time.Sleep(launcherRefreshPollInterval)
		}
		staged, err := stageLauncherRefresh(stateDir, launcherPath, executable, version, time.Now())
		if errors.Is(err, errLauncherTrialInProgress) {
			// The launcher that started this daemon tries the launcher the
			// previous daemon staged: let it confirm first, then stage this one
			// for the next launcher start.
			logger.Info("launcher refresh waits for the launcher trial in progress", "version", version)
			trialDeadline := time.Now().Add(launcherRefreshTrialWait)
			for errors.Is(err, errLauncherTrialInProgress) && time.Now().Before(trialDeadline) {
				time.Sleep(launcherRefreshPollInterval)
				staged, err = stageLauncherRefresh(stateDir, launcherPath, executable, version, time.Now())
			}
			if errors.Is(err, errLauncherTrialInProgress) {
				logger.Info("launcher refresh skipped; the launcher trial did not end in time, the next daemon start stages it", "version", version)
				return
			}
		}
		if err != nil {
			logger.Warn("launcher refresh was not staged", "error", err, "version", version)
			return
		}
		if staged {
			logger.Info("staged launcher refresh; the launcher takes it over in place, or on its next start", "version", version, "launcher", launcherPath)
		}
		if plan := planAfterUpdateRestart(stateDir, executable, version, fromVersion, LauncherFeatures(), os.Getppid(), os.Geteuid(), logger); plan != nil {
			requestAfterUpdateRestart(plan, fromVersion, logger)
		}
	}()
}
