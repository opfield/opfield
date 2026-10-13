package lifecycle

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/hostrename"
	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

const (
	LauncherProtocolVersion = 1
	LauncherCommand         = "launcher"
	LauncherProbeCommand    = "launcher-probe"
	LauncherManagedEnv      = "OPFIELD_DAEMON_LAUNCHER_MANAGED"
	LauncherReadyFDEnv      = "OPFIELD_DAEMON_LAUNCHER_READY_FD"
	LauncherOwnerFDEnv      = "OPFIELD_DAEMON_LAUNCHER_OWNER_FD"
	LauncherStateDirEnv     = "OPFIELD_DAEMON_LAUNCHER_STATE_DIR"
	LauncherUpdateExitCode  = 75
)

var (
	launcherLocalReadyLimit = 30 * time.Second
	// A candidate that announced it will report Opfield control readiness
	// must receive its first Opfield command within this window. Opfield
	// waits for an updated daemon at least this plus launcherLocalReadyLimit
	// (LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS in daemon-update.service.ts): change
	// both together.
	launcherControlReadyLimit = 3 * time.Minute
	launcherStabilityWindow   = 30 * time.Second
	launcherStopGrace         = 15 * time.Second
	launcherRestartBackoff    = time.Second
	launcherRestartMax        = 5 * time.Second
	launcherStateRetry        = 5 * time.Second
	launcherKeeperSettle      = 500 * time.Millisecond
)

type LauncherSpec struct {
	DaemonType string
	StateDir   string
	BinaryPath string
	ChildArgs  []string
}

type launcherOwner struct {
	PID             int       `json:"pid"`
	StartedAt       time.Time `json:"startedAt"`
	DaemonType      string    `json:"daemonType"`
	BinaryPath      string    `json:"binaryPath"`
	ProtocolVersion int       `json:"protocolVersion"`
	// Version and Features describe the launcher image running now; launchers
	// that predate them leave them out. The daemon reads them (LauncherFeatures).
	Version  string   `json:"version,omitempty"`
	Features []string `json:"features,omitempty"`
}

type launcherReadinessEvent struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	// AwaitControl on local_ready announces that this daemon will also send
	// control_ready once Opfield accepted it. Launchers that predate the
	// field ignore it and keep committing on local readiness alone.
	AwaitControl bool `json:"awaitControl,omitempty"`
}

const (
	launcherEventLocalReady   = "local_ready"
	launcherEventControlReady = "control_ready"
)

type launcherChildStatus struct {
	PID       int       `json:"pid"`
	Version   string    `json:"version,omitempty"`
	Ready     bool      `json:"ready"`
	UpdatedAt time.Time `json:"updatedAt"`
}

var (
	localReadyOnce   sync.Once
	controlReadyOnce sync.Once

	launcherReadyMu       sync.Mutex
	launcherReadyFile     *os.File
	launcherReadyOpened   bool
	launcherReadyVersion  string
	launcherAwaitsControl bool
)

func init() {
	// A daemon child gets Pdeathsig when the thread that started it exits
	// (go.dev/issue/27505), and an exec ends every thread but the one that
	// calls it. The launcher starts its children and execs in place from its
	// main goroutine only (runLauncher), locked here to the main thread, which
	// outlives both.
	if IsLauncherCommand(os.Args) {
		runtime.LockOSThread()
	}
}

func IsLauncherCommand(args []string) bool {
	return len(args) > 1 && args[1] == LauncherCommand
}

func IsLauncherProbeCommand(args []string) bool {
	return len(args) > 1 && args[1] == LauncherProbeCommand
}

// PrintLauncherProbe answers `launcher-probe`, and with --features describes
// the launcher of this binary (set Version first).
func PrintLauncherProbe() {
	if len(os.Args) > 2 && os.Args[2] == launcherFeaturesFlag {
		encoded, _ := json.Marshal(launcherProbeFeatures{Protocol: LauncherProtocolVersion, Version: Version, Features: launcherBinaryFeatures})
		fmt.Println(string(encoded))
		return
	}
	fmt.Printf("gateway-daemon-launcher %d\n", LauncherProtocolVersion)
}

// BootstrapLauncher replaces a direct daemon invocation with a stable launcher
// copy. If no safe copy can be created, it returns an error and the caller may
// continue running directly with rollback protection unavailable.
func BootstrapLauncher(spec LauncherSpec) error {
	if launcherManagedFromEnvironment() == "1" {
		// Keep ownership in this daemon if the launcher dies, but never leak the
		// lock into worker processes subsequently spawned by the daemon.
		if fd, err := strconv.Atoi(launcherEnv(LauncherOwnerFDEnv, legacyLauncherOwnerFDEnv)); err == nil && fd >= 3 {
			syscall.CloseOnExec(fd)
		}
		// Likewise the listeners the launcher kept for this process, before
		// anything starts a helper process.
		listenerkeep.Init()
		return nil
	}
	if strings.TrimSpace(spec.DaemonType) == "" || strings.TrimSpace(spec.StateDir) == "" {
		return errors.New("launcher daemon type and state directory are required")
	}
	executable := spec.BinaryPath
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return fmt.Errorf("resolve daemon executable: %w", err)
		}
	}
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("resolve daemon executable symlink: %w", err)
	}
	if err := retireLegacyUpdateGuard(spec.DaemonType, executable); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: legacy update-guard cleanup incomplete: %v\n", err)
	}
	stateDir, launcherPath, err := ensureStableLauncher(spec.StateDir, spec.DaemonType, executable)
	if err != nil {
		return err
	}
	// The start after a service restart for an update runs this (updated)
	// binary's launcher at once (launcher_service_restart.go).
	if err := stageServiceRestartLauncher(stateDir, launcherPath, executable); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: the updated launcher was not staged for this start; using the launcher staged before: %v\n", err)
	}
	// A staged launcher refresh is tried here; the known-good copy is used
	// whenever the trial is not due, not valid, or an update is pending.
	launcherPath = selectLauncherForStart(stateDir, launcherPath)
	childArgs := spec.ChildArgs
	if len(childArgs) == 0 {
		childArgs = []string{"run"}
	}
	args := launcherCommandArgs(launcherPath, LauncherSpec{DaemonType: spec.DaemonType, StateDir: stateDir, BinaryPath: executable, ChildArgs: childArgs})
	environment := append(os.Environ(), launcherEnvPairs(LauncherStateDirEnv, legacyLauncherStateDirEnv, stateDir)...)
	return syscall.Exec(launcherPath, args, environment)
}

func RunLauncherCommand(args []string, logger *slog.Logger) error {
	spec, err := parseLauncherArgs(args)
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return runLauncher(context.Background(), spec, logger)
}

func parseLauncherArgs(args []string) (LauncherSpec, error) {
	if !IsLauncherCommand(args) {
		return LauncherSpec{}, errors.New("launcher command is required")
	}
	var spec LauncherSpec
	index := 2
	for index < len(args) {
		if args[index] == "--" {
			spec.ChildArgs = append([]string(nil), args[index+1:]...)
			break
		}
		if index+1 >= len(args) {
			return LauncherSpec{}, fmt.Errorf("launcher flag %s requires a value", args[index])
		}
		switch args[index] {
		case "--daemon-type":
			spec.DaemonType = args[index+1]
		case "--state-dir":
			spec.StateDir = args[index+1]
		case "--binary":
			spec.BinaryPath = args[index+1]
		default:
			return LauncherSpec{}, fmt.Errorf("unknown launcher flag %s", args[index])
		}
		index += 2
	}
	if spec.DaemonType == "" || !filepath.IsAbs(spec.StateDir) || !filepath.IsAbs(spec.BinaryPath) {
		return LauncherSpec{}, errors.New("launcher requires daemon type and absolute state/binary paths")
	}
	if len(spec.ChildArgs) == 0 {
		spec.ChildArgs = []string{"run"}
	}
	return spec, nil
}

func runLauncher(ctx context.Context, spec LauncherSpec, logger *slog.Logger) error {
	// Children start, and the launcher execs in place, from this goroutine on
	// this thread only (see init).
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	launcherDir := filepath.Join(spec.StateDir, "launcher")
	if err := ensurePrivateLauncherDirectory(launcherDir); err != nil {
		return fmt.Errorf("create launcher state directory: %w", err)
	}
	signalCtx, stopSignals := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stopSignals()
	// A launcher image that execed into this one in place hands over its owner
	// lock, its keeper and its daemon child (launcher_selfupdate.go).
	resume, err := takeLauncherResume()
	if err != nil {
		return fmt.Errorf("take over from the previous launcher image: %w", err)
	}
	var lock *os.File
	startedAt := time.Now().UTC()
	if resume != nil {
		lock = resume.lock
		if !resume.StartedAt.IsZero() {
			startedAt = resume.StartedAt
		}
	} else if lock, err = acquireLauncherLock(signalCtx, filepath.Join(launcherDir, "owner.lock")); err != nil {
		return err
	}
	defer releaseLauncherLock(lock)

	// Listeners a daemon process keeps outlive it here, and in systemd's file
	// descriptor store when the unit has one, so the next process takes them
	// over and a restart or update refuses no connection.
	var keeper *listenerkeep.Store
	if resume != nil && resume.Keeper != nil {
		if keeper, err = listenerkeep.AdoptStore(*resume.Keeper, logger); err != nil {
			logger.Warn("listener keeper of the previous launcher image could not be taken over; the next daemon process takes over no listeners", "error", err)
			keeper = nil
		}
	}
	if keeper == nil {
		if keeper, err = listenerkeep.OpenStore(logger); err != nil {
			logger.Warn("listener keeper is unavailable; daemon restarts drop listeners", "error", err)
			keeper = nil
		}
	}
	if keeper != nil {
		defer keeper.Close()
	}

	owner := launcherOwner{
		PID:             os.Getpid(),
		StartedAt:       startedAt,
		DaemonType:      spec.DaemonType,
		BinaryPath:      spec.BinaryPath,
		ProtocolVersion: LauncherProtocolVersion,
		Version:         Version,
		Features:        launcherRunningFeatures(keeper != nil),
	}
	if err := writeJSONFileAtomic(filepath.Join(launcherDir, "owner.json"), &owner, 0600); err != nil {
		return fmt.Errorf("write launcher owner metadata: %w", err)
	}
	defer os.Remove(filepath.Join(launcherDir, "owner.json"))

	// A staged launcher on trial replaces the installed copy once a child was
	// stable under it, and hands over to the installed copy if children keep
	// failing before that.
	trial := detectLauncherRefreshTrial(spec.StateDir)
	if trial != nil {
		logger.Info("running a staged launcher on trial", "launcher", trial.launcherPath)
	}
	promoteTrial := func() {
		if trial == nil {
			return
		}
		confirmed := trial
		trial = nil
		if err := promoteLauncherRefresh(spec.StateDir, confirmed); err != nil {
			if errors.Is(err, errLauncherTrialSuperseded) {
				// A daemon update during the trial staged a newer launcher: that one
				// is tried on the next launcher start instead of this one.
				logger.Info("launcher trial superseded by a newer staged launcher; the installed launcher stays until that one is tried", "launcher", confirmed.launcherPath)
				return
			}
			logger.Error("staged launcher was stable but could not replace the installed launcher", "error", err)
			return
		}
		logger.Info("launcher refresh confirmed; replaced the installed launcher", "launcher", confirmed.launcherPath)
	}
	trialChildFailed := func() error {
		if trial == nil {
			return nil
		}
		trial.failures++
		if trial.failures < launcherRefreshChildFailureLimit {
			return nil
		}
		return fallBackFromLauncherTrial(spec, trial, logger)
	}

	// A proven launcher execs into a staged launcher in place once one is due
	// and the moment is safe; see launcher_selfupdate.go.
	launcherPath := canonicalLauncherPath(spec.StateDir, spec.BinaryPath)
	cannotResume := map[string]bool{}
	var respawn launcherServiceManager
	var respawnCheckedAt time.Time
	lastSelfUpdateSkip := ""
	skipSelfUpdate := func(reason string, attrs ...any) {
		// Checked every few seconds: say it once until the reason changes.
		if key := fmt.Sprint(append([]any{reason}, attrs...)...); key != lastSelfUpdateSkip {
			lastSelfUpdateSkip = key
			logger.Info(reason, attrs...)
		}
	}
	selfUpdate := func(childPID int, childVersion string) {
		if trial != nil || signalCtx.Err() != nil {
			return
		}
		if due, err := launcherSelfUpdateDue(spec.StateDir, launcherPath, cannotResume); err != nil || !due {
			if err != nil {
				skipSelfUpdate("launcher update in place skipped", "error", err)
			}
			return
		}
		if !respawn.respawns() && time.Since(respawnCheckedAt) >= launcherRespawnRecheck {
			respawn, respawnCheckedAt = launcherServiceManagerOf(os.Getpid()), time.Now()
		}
		if !respawn.respawns() {
			// Nothing would start the service again if the new image failed:
			// the next start of the service tries the staged launcher instead.
			skipSelfUpdate("launcher update in place skipped; the refreshed launcher starts with the service", "service_manager", respawn.String())
			return
		}
		target, err := claimLauncherSelfUpdate(spec.StateDir, launcherPath, cannotResume)
		if err != nil {
			skipSelfUpdate("launcher update in place skipped", "error", err)
			return
		}
		if target == "" {
			return
		}
		logger.Info("updating the launcher in place", "launcher", target, "child_pid", childPID)
		err = execLauncherInPlace(signalCtx, spec, target, lock, keeper, startedAt, childPID, childVersion)
		if errors.Is(err, errLauncherExecAborted) {
			return
		}
		logger.Error("launcher update in place failed; the running launcher stays", "error", err, "launcher", target)
		if abandonErr := withLauncherRefreshLock(spec.StateDir, func() error {
			state, readErr := readLauncherRefreshState(spec.StateDir)
			if readErr != nil || state == nil || state.Phase != launcherRefreshPhaseTrial {
				return readErr
			}
			return abandonLauncherRefresh(spec.StateDir, state, "exec in place failed: "+err.Error())
		}); abandonErr != nil {
			logger.Error("could not record the abandoned launcher refresh", "error", abandonErr)
		}
	}

	var adopted *launcherResume
	if resume != nil && resume.ChildPID > 0 {
		adopted = resume
		logger.Info("launcher updated in place; supervising the running daemon", "from_version", resume.FromVersion, "version", Version, "child_pid", resume.ChildPID)
	}
	backoff := launcherRestartBackoff
	for {
		if signalCtx.Err() != nil {
			return nil
		}
		var (
			state  *launcherUpdateState
			child  *exec.Cmd
			events <-chan launcherReadinessEvent
			done   <-chan error
			err    error
			hooks  = launcherChildHooks{selfUpdate: selfUpdate}
		)
		if adopted != nil {
			// The daemon the previous image started: no update was pending for
			// it (a safe moment), and it was ready. A launcher on trial is
			// confirmed only by a child it started itself.
			child, done = adoptLauncherChild(adopted.ChildPID)
			hooks.ready, hooks.version = true, adopted.ChildVersion
			adopted = nil
		} else {
			if state, err = prepareLauncherCandidate(spec); err != nil {
				return err
			}
			if keeper != nil {
				// Apply what the previous process kept or dropped last.
				keeper.Settle(launcherKeeperSettle)
			}
			if trial != nil {
				hooks.onStable = promoteTrial
			}
			child, events, done, err = startLauncherChild(spec, lock, keeper)
		}
		if err != nil {
			if state != nil {
				if rollbackErr := rollbackLauncherUpdate(spec.StateDir, state, "candidate exec failed"); rollbackErr != nil {
					return fmt.Errorf("start candidate: %v; rollback: %w", err, rollbackErr)
				}
				logger.Error("candidate exec failed; restored previous daemon", "error", err, "target_version", state.TargetVersion)
				if trialErr := trialChildFailed(); trialErr != nil {
					return trialErr
				}
				continue
			}
			logger.Error("daemon child exec failed; retrying", "error", err)
			if trialErr := trialChildFailed(); trialErr != nil {
				return trialErr
			}
			select {
			case <-signalCtx.Done():
				return nil
			case <-time.After(backoff):
			}
			if backoff < launcherRestartMax {
				backoff *= 2
				if backoff > launcherRestartMax {
					backoff = launcherRestartMax
				}
			}
			continue
		}
		childStatusPath := filepath.Join(launcherDir, "child.json")
		if err := writeJSONFileAtomic(childStatusPath, &launcherChildStatus{PID: child.Process.Pid, Version: hooks.version, Ready: hooks.ready, UpdatedAt: time.Now().UTC()}, 0600); err != nil {
			logger.Warn("launcher child status is unavailable", "error", err)
		}

		outcome := superviseLauncherChild(signalCtx, spec, state, child, events, done, hooks, logger)
		_ = os.Remove(childStatusPath)
		if outcome.stop {
			return outcome.err
		}
		if outcome.err != nil {
			logger.Warn("daemon child stopped", "error", outcome.err)
		}
		if !outcome.handoff {
			if trialErr := trialChildFailed(); trialErr != nil {
				return trialErr
			}
		} else {
			// The daemon exited to hand over to its staged update: start the
			// candidate at once, every connection waits for it meanwhile.
			backoff = launcherRestartBackoff
			continue
		}
		select {
		case <-signalCtx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < launcherRestartMax {
			backoff *= 2
			if backoff > launcherRestartMax {
				backoff = launcherRestartMax
			}
		}
	}
}

type launcherChildOutcome struct {
	stop bool
	// handoff marks a child that exited to hand over to a staged update.
	handoff bool
	err     error
}

func prepareLauncherCandidate(spec LauncherSpec) (*launcherUpdateState, error) {
	state, err := readLauncherUpdateState(spec.StateDir)
	if err != nil || state == nil {
		return state, err
	}
	if filepath.Clean(state.BinaryPath) != filepath.Clean(spec.BinaryPath) || state.DaemonType != spec.DaemonType {
		return nil, errors.New("pending launcher update does not belong to this daemon")
	}
	version, err := readDaemonBinaryVersion(spec.BinaryPath)
	if err != nil || version != state.TargetVersion {
		if rollbackErr := rollbackLauncherUpdate(spec.StateDir, state, "candidate version did not match update target"); rollbackErr != nil {
			return nil, fmt.Errorf("candidate version validation failed: %v; rollback: %w", err, rollbackErr)
		}
		return nil, nil
	}
	if state.Phase == "staged" {
		if err := markLauncherCandidateStarted(spec.StateDir, state, time.Now()); err != nil {
			return nil, err
		}
	}
	return state, nil
}

func startLauncherChild(spec LauncherSpec, ownerLock *os.File, keeper *listenerkeep.Store) (*exec.Cmd, <-chan launcherReadinessEvent, <-chan error, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	cmd := exec.Command(spec.BinaryPath, spec.ChildArgs...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// The child inherits the same flock open-file description. If the launcher
	// itself crashes, a replacement launcher cannot acquire ownership until the
	// old child has actually exited after Pdeathsig, preventing process overlap.
	cmd.ExtraFiles = []*os.File{writer, ownerLock}
	cmd.Env = os.Environ()
	cmd.Env = append(cmd.Env, launcherEnvPairs(LauncherManagedEnv, legacyLauncherManagedEnv, "1")...)
	cmd.Env = append(cmd.Env, launcherEnvPairs(LauncherReadyFDEnv, legacyLauncherReadyFDEnv, "3")...)
	cmd.Env = append(cmd.Env, launcherEnvPairs(LauncherOwnerFDEnv, legacyLauncherOwnerFDEnv, "4")...)
	cmd.Env = append(cmd.Env, launcherEnvPairs(LauncherStateDirEnv, legacyLauncherStateDirEnv, spec.StateDir)...)
	releaseKept := func() {}
	if keeper != nil {
		files, environment, release := keeper.ChildFiles(3 + len(cmd.ExtraFiles))
		cmd.ExtraFiles = append(cmd.ExtraFiles, files...)
		cmd.Env = append(cmd.Env, environment...)
		releaseKept = release
	}
	cmd.SysProcAttr = launcherChildSysProcAttr()
	if err := cmd.Start(); err != nil {
		releaseKept()
		reader.Close()
		writer.Close()
		return nil, nil, nil, err
	}
	releaseKept()
	writer.Close()
	events := make(chan launcherReadinessEvent, 4)
	go func() {
		defer close(events)
		defer reader.Close()
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var event launcherReadinessEvent
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				events <- event
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	return cmd, events, done, nil
}

// launcherChildHooks lets the launcher act on a supervised child.
type launcherChildHooks struct {
	// onStable, when set, runs once this child was locally ready for the
	// stability window, independently of any pending update.
	onStable func()
	// selfUpdate, when set, is offered every launcherSelfUpdateCheck while no
	// update is pending and the child is ready. It returns only when the
	// launcher did not exec in place.
	selfUpdate func(childPID int, childVersion string)
	// ready and version describe a child taken over already ready from the
	// previous launcher image.
	ready   bool
	version string
}

func superviseLauncherChild(ctx context.Context, spec LauncherSpec, initialState *launcherUpdateState, child *exec.Cmd, events <-chan launcherReadinessEvent, done <-chan error, hooks launcherChildHooks, logger *slog.Logger) launcherChildOutcome {
	state := initialState
	childReady, childVersion := hooks.ready, hooks.version
	var selfUpdateTick <-chan time.Time
	if hooks.selfUpdate != nil {
		ticker := time.NewTicker(launcherSelfUpdateCheck)
		defer ticker.Stop()
		selfUpdateTick = ticker.C
	}
	var readyTimer *time.Timer
	var readyTimeout <-chan time.Time
	var controlTimer *time.Timer
	var controlTimeout <-chan time.Time
	var stabilityTimer *time.Timer
	var stabilityTimeout <-chan time.Time
	var onStableTimer *time.Timer
	var onStableTimeout <-chan time.Time
	startStability := func() {
		if stabilityTimer == nil {
			stabilityTimer = time.NewTimer(launcherStabilityWindow)
			stabilityTimeout = stabilityTimer.C
		}
	}
	defer func() {
		if controlTimer != nil {
			controlTimer.Stop()
		}
		if stabilityTimer != nil {
			stabilityTimer.Stop()
		}
		if onStableTimer != nil {
			onStableTimer.Stop()
		}
	}()
	// A persisted ready_stabilizing phase only describes the previous child.
	// Every newly launched candidate must prove local readiness again.
	if state != nil {
		readyTimer = time.NewTimer(launcherLocalReadyLimit)
		readyTimeout = readyTimer.C
		defer readyTimer.Stop()
	}
	for {
		select {
		case <-ctx.Done():
			err := terminateLauncherChild(child, done, launcherStopGrace)
			if daemonProcessExitCode(err) == LauncherUpdateExitCode {
				// The daemon exited for its staged update while the service
				// stops: a clean stop, the next start takes the update.
				err = nil
			}
			return launcherChildOutcome{stop: true, err: err}
		case <-readyTimeout:
			err := terminateLauncherChild(child, done, launcherStopGrace)
			return launcherChildOutcome{err: handleLauncherCandidateExit(spec, state, "local readiness timeout", err, logger)}
		case <-controlTimeout:
			// The candidate runs but never proved it can reach and be accepted
			// by Opfield. Committing it would strand the node, so restore
			// the previous daemon now.
			_ = terminateLauncherChild(child, done, launcherStopGrace)
			if err := rollbackLauncherUpdate(spec.StateDir, state, "Opfield control readiness timeout"); err != nil {
				return launcherChildOutcome{stop: true, err: err}
			}
			logger.Error("candidate never reached Opfield; restored previous daemon", "target_version", state.TargetVersion)
			return launcherChildOutcome{err: fmt.Errorf("candidate %s did not reach Opfield control readiness within %s", state.TargetVersion, launcherControlReadyLimit)}
		case <-onStableTimeout:
			onStableTimeout = nil
			hooks.onStable()
		case <-selfUpdateTick:
			if state == nil && childReady {
				hooks.selfUpdate(child.Process.Pid, childVersion)
			}
		case <-stabilityTimeout:
			if state != nil {
				if err := removeLauncherUpdateState(spec.StateDir); err != nil {
					logger.Error("failed to commit stable daemon update; retrying", "error", err, "version", state.TargetVersion)
					stabilityTimer.Reset(launcherStateRetry)
					stabilityTimeout = stabilityTimer.C
					continue
				}
				logger.Info("daemon update committed after candidate stability window", "version", state.TargetVersion)
				state = nil
				stabilityTimeout = nil
			}
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if event.Type == launcherEventControlReady {
				if state == nil || controlTimeout == nil {
					continue
				}
				if event.Version != state.TargetVersion {
					_ = terminateLauncherChild(child, done, launcherStopGrace)
					if err := rollbackLauncherUpdate(spec.StateDir, state, "candidate control readiness version did not match update target"); err != nil {
						return launcherChildOutcome{stop: true, err: err}
					}
					return launcherChildOutcome{err: fmt.Errorf("candidate reported version %s, expected %s", event.Version, state.TargetVersion)}
				}
				controlTimer.Stop()
				controlTimeout = nil
				logger.Info("candidate reached Opfield control readiness", "version", state.TargetVersion)
				startStability()
				continue
			}
			if event.Type != launcherEventLocalReady {
				continue
			}
			childReady, childVersion = true, event.Version
			if err := writeJSONFileAtomic(filepath.Join(spec.StateDir, "launcher", "child.json"), &launcherChildStatus{
				PID:       child.Process.Pid,
				Version:   event.Version,
				Ready:     true,
				UpdatedAt: time.Now().UTC(),
			}, 0600); err != nil {
				logger.Warn("launcher child status is unavailable", "error", err)
			}
			if hooks.onStable != nil && onStableTimer == nil {
				onStableTimer = time.NewTimer(launcherStabilityWindow)
				onStableTimeout = onStableTimer.C
			}
			if state == nil {
				continue
			}
			if event.Version != state.TargetVersion {
				_ = terminateLauncherChild(child, done, launcherStopGrace)
				if err := rollbackLauncherUpdate(spec.StateDir, state, "candidate readiness version did not match update target"); err != nil {
					return launcherChildOutcome{stop: true, err: err}
				}
				return launcherChildOutcome{err: fmt.Errorf("candidate reported version %s, expected %s", event.Version, state.TargetVersion)}
			}
			readyTimeout = nil
			if err := markLauncherLocalReady(spec.StateDir, state, time.Now()); err != nil {
				logger.Error("failed to persist candidate readiness; continuing stability check", "error", err, "version", state.TargetVersion)
			}
			if event.AwaitControl {
				// Commit only after the candidate proved it reaches Opfield.
				if controlTimer == nil && stabilityTimer == nil {
					controlTimer = time.NewTimer(launcherControlReadyLimit)
					controlTimeout = controlTimer.C
				}
				continue
			}
			// A daemon that predates control_ready keeps the local-only rule.
			startStability()
		case err := <-done:
			fresh, readErr := readLauncherUpdateState(spec.StateDir)
			if readErr != nil {
				return launcherChildOutcome{stop: true, err: readErr}
			}
			if fresh != nil && fresh.Phase == "staged" {
				if daemonProcessExitCode(err) == LauncherUpdateExitCode {
					return launcherChildOutcome{handoff: true}
				}
				return launcherChildOutcome{err: fmt.Errorf("daemon exited after staging an update without the update handoff code: %v", err)}
			}
			if state == nil {
				return launcherChildOutcome{err: err}
			}
			return launcherChildOutcome{err: handleLauncherCandidateExit(spec, fresh, "candidate process exited", err, logger)}
		}
	}
}

func daemonProcessExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func handleLauncherCandidateExit(spec LauncherSpec, state *launcherUpdateState, reason string, processErr error, logger *slog.Logger) error {
	if state == nil {
		return processErr
	}
	rolledBack, err := recordLauncherCandidateFailure(spec.StateDir, state, reason, time.Now())
	if err != nil {
		return err
	}
	if rolledBack {
		logger.Error("candidate crash threshold reached; restored previous daemon", "target_version", state.TargetVersion)
	}
	return processErr
}

func terminateLauncherChild(child *exec.Cmd, done <-chan error, grace time.Duration) error {
	if child == nil || child.Process == nil {
		return nil
	}
	_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
	select {
	case err := <-done:
		return normalizeOperatorStop(err)
	case <-time.After(grace):
		_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		return normalizeOperatorStop(<-done)
	}
}

func normalizeOperatorStop(err error) error {
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return nil
		}
	}
	return err
}

// NotifyLauncherLocalReady reports local readiness only. A launcher commits a
// pending update after its stability window without waiting for Opfield.
func NotifyLauncherLocalReady(version string) {
	localReadyOnce.Do(func() {
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventLocalReady, Version: version}, true)
	})
}

// NotifyLauncherLocalReadyAwaitingControl reports local readiness and
// announces a later NotifyLauncherControlReady. A launcher that understands
// the announcement commits a pending update only after control readiness.
func NotifyLauncherLocalReadyAwaitingControl(version string) {
	localReadyOnce.Do(func() {
		launcherReadyMu.Lock()
		launcherReadyVersion = version
		launcherAwaitsControl = true
		launcherReadyMu.Unlock()
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventLocalReady, Version: version, AwaitControl: true}, false)
	})
}

// NotifyLauncherControlReady reports that Opfield accepted this daemon's
// control session (its first command after Register arrived). It is a no-op
// unless NotifyLauncherLocalReadyAwaitingControl announced it.
func NotifyLauncherControlReady() {
	notifyLauncherControlReady(nil)
}

// notifyLauncherControlReady also stages this daemon as the next launcher once
// its update, if any, is committed; see launcher_refresh.go.
func notifyLauncherControlReady(logger *slog.Logger) {
	launcherReadyMu.Lock()
	awaits, version := launcherAwaitsControl, launcherReadyVersion
	launcherReadyMu.Unlock()
	if !awaits {
		return
	}
	controlReadyOnce.Do(func() {
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventControlReady, Version: version}, true)
		scheduleLauncherRefresh(version, logger)
		scheduleStartConfirmed(version, logger)
	})
}

// writeLauncherReadiness writes one event to the launcher pipe. The pipe stays
// open between events when more are expected and is closed after the last.
func writeLauncherReadiness(event launcherReadinessEvent, last bool) {
	launcherReadyMu.Lock()
	defer launcherReadyMu.Unlock()
	if !launcherReadyOpened {
		launcherReadyOpened = true
		fdValue := launcherEnv(LauncherReadyFDEnv, legacyLauncherReadyFDEnv)
		if fdValue == "" {
			return
		}
		fd, err := strconv.Atoi(fdValue)
		if err != nil || fd < 3 {
			return
		}
		// The pipe may stay open while the daemon spawns workers; never leak it.
		syscall.CloseOnExec(fd)
		launcherReadyFile = os.NewFile(uintptr(fd), "launcher-ready")
	}
	if launcherReadyFile == nil {
		return
	}
	message, _ := json.Marshal(event)
	_, _ = launcherReadyFile.Write(append(message, '\n'))
	if last {
		_ = launcherReadyFile.Close()
		launcherReadyFile = nil
	}
}

func ensureStableLauncher(preferredStateDir, daemonType, executable string) (string, string, error) {
	candidates := []string{preferredStateDir}
	if cacheDir, err := os.UserCacheDir(); err == nil {
		candidates = append(candidates, fallbackLauncherDir(filepath.Join(cacheDir, "opfield-daemon", daemonType), filepath.Join(cacheDir, "gateway-daemon", daemonType)))
	}
	candidates = append(candidates, fallbackLauncherDir(
		filepath.Join(os.TempDir(), fmt.Sprintf("opfield-daemon-%d", os.Getuid()), daemonType),
		filepath.Join(os.TempDir(), fmt.Sprintf("gateway-daemon-%d", os.Getuid()), daemonType)))
	return ensureStableLauncherIn(candidates, executable, os.Lstat)
}

// fallbackLauncherDir is the Opfield-named launcher directory, unless a launcher
// already lives under the pre-Opfield name: its owner lock and update state
// must stay where the running launcher looks for them, or two launchers could
// run one daemon.
func fallbackLauncherDir(dir, legacy string) string {
	if _, err := os.Lstat(dir); err == nil {
		return dir
	}
	// legacy-name: gateway-daemon launcher fallback directory of pre-Opfield daemons — remove once every node reports none
	if _, err := os.Lstat(legacy); err == nil {
		return legacy
	}
	return dir
}

// ensureStableLauncherIn uses the first candidate directory that holds or can
// take the launcher copy. A directory this user may not search (a state
// directory owned by root, for a daemon running as another user) is skipped
// like one where the copy cannot be created; any other error stops the search.
func ensureStableLauncherIn(candidates []string, executable string, lstat func(string) (os.FileInfo, error)) (string, string, error) {
	var failures []error
	for _, stateDir := range candidates {
		launcherPath := canonicalLauncherPath(stateDir, executable)
		if _, statErr := lstat(launcherPath); statErr == nil {
			if err := ensureLauncherCopy(executable, launcherPath, stateDir); err != nil {
				return "", "", err
			}
			return stateDir, launcherPath, nil
		} else if errors.Is(statErr, os.ErrPermission) {
			// EACCES and EPERM: this user cannot use the directory at all.
			failures = append(failures, statErr)
			continue
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return "", "", statErr
		}
		if err := ensureLauncherCopy(executable, launcherPath, stateDir); err != nil {
			failures = append(failures, err)
			continue
		}
		return stateDir, launcherPath, nil
	}
	return "", "", errors.Join(failures...)
}

func ensureLauncherCopy(executable, launcherPath, stateDir string) error {
	if _, err := os.Stat(launcherPath); err == nil {
		if probeErr := probeLauncher(launcherPath); probeErr != nil {
			return fmt.Errorf("installed launcher is incompatible; explicit repair required: %w", probeErr)
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := ensurePrivateLauncherDirectory(filepath.Dir(launcherPath)); err != nil {
		return err
	}
	if err := copyExecutableAtomic(executable, launcherPath); err != nil {
		return fmt.Errorf("install stable launcher copy: %w", err)
	}
	return probeLauncher(launcherPath)
}

func probeLauncher(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, LauncherProbeCommand).Output()
	if err != nil {
		return err
	}
	expected := fmt.Sprintf("gateway-daemon-launcher %d", LauncherProtocolVersion)
	if strings.TrimSpace(string(output)) != expected {
		return fmt.Errorf("unsupported launcher probe response %q", strings.TrimSpace(string(output)))
	}
	return nil
}

func readDaemonBinaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(output))
	if len(fields) < 2 {
		return "", errors.New("daemon version output is invalid")
	}
	return fields[len(fields)-1], nil
}

func launcherStateDirFromEnvironment(executable string) string {
	if value := strings.TrimSpace(launcherEnv(LauncherStateDirEnv, legacyLauncherStateDirEnv)); value != "" {
		return value
	}
	switch filepath.Base(executable) {
	case "docker-daemon":
		return "/var/lib/docker-daemon"
	case "nginx-daemon":
		return "/var/lib/nginx-daemon"
	case "monitoring-daemon":
		return "/var/lib/monitoring-daemon"
	case "relay-supervisor":
		// legacy-name: /var/lib/gateway-relay-supervisor until the relay supervisor moved it — remove once every node reports none
		return hostrename.Resolve(hostrename.Pair{Old: "/var/lib/gateway-relay-supervisor", New: "/var/lib/opfield-relay"})
	default:
		return fallbackLauncherDir(filepath.Join(filepath.Dir(executable), ".opfield-launcher"), filepath.Join(filepath.Dir(executable), ".gateway-launcher"))
	}
}

func acquireLauncherLock(ctx context.Context, path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open launcher owner lock: %w", err)
	}
	for {
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			return file, nil
		} else if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return nil, fmt.Errorf("acquire launcher owner lock: %w", err)
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func releaseLauncherLock(file *os.File) {
	if file == nil {
		return
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}
