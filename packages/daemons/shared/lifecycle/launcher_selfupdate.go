package lifecycle

// Launcher self-update.
//
// The launcher process outlives every daemon update, so a refreshed launcher
// copy (launcher_refresh.go) used to take effect only when the service
// restarted. Now a running launcher execs into the staged launcher in place,
// at a safe moment: no daemon update pending (which also covers a live
// handover between two daemon processes), its daemon child locally ready, and
// the launcher itself not on trial.
//
// The process keeps its PID, and its daemon child stays its child and keeps
// running. The owner lock, the keeper's channel to the daemon and every
// descriptor the keeper holds survive the exec: their close-on-exec flag is
// cleared just before it, with no process starting in between, and their
// numbers travel in a resume record, an unlinked file whose descriptor the
// new image finds in the environment and reads first.
//
// The exec is a trial start like a start of the service: it counts an attempt,
// and the new launcher replaces the known-good copy only once a daemon process
// it started itself was ready and stable (the next daemon update or restart).
// A new image that crashes takes its daemon child with it (Pdeathsig); the
// service manager starts the service again, and that start tries the staged
// launcher until its attempts run out, then uses the known-good copy. A
// launcher that no service manager starts again (manual mode) therefore never
// execs in place; it takes the refreshed launcher on its next start.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
)

const (
	launcherResumeFDEnv         = "OPFIELD_DAEMON_LAUNCHER_RESUME_FD"
	launcherResumeSchemaVersion = 1
	launcherResumeMaxSize       = 16 << 20

	launcherManagerSystemd = "systemd"
	launcherManagerOpenRC  = "openrc"
)

var (
	// launcherSelfUpdateCheck is how often a launcher looks for a staged
	// launcher to exec into; launcherRespawnRecheck how often it asks again
	// whether a service manager would start it again.
	launcherSelfUpdateCheck = 10 * time.Second
	launcherRespawnRecheck  = time.Minute

	// Overridable in tests: the service manager running a launcher process.
	launcherServiceManagerOf = detectLauncherServiceManager

	errLauncherExecAborted = errors.New("the launcher is stopping")
)

// launcherResume is what a launcher image hands the image it execs into.
type launcherResume struct {
	SchemaVersion int                  `json:"schemaVersion"`
	FromVersion   string               `json:"fromVersion"`
	StartedAt     time.Time            `json:"startedAt"`
	OwnerLockFD   int                  `json:"ownerLockFd"`
	Keeper        *listenerkeep.Export `json:"keeper,omitempty"`
	ChildPID      int                  `json:"childPid,omitempty"`
	ChildVersion  string               `json:"childVersion,omitempty"`

	lock *os.File
}

// launcherRunningFeatures are the features of this launcher image.
func launcherRunningFeatures(keeper bool) []string {
	if keeper {
		return append([]string(nil), launcherBinaryFeatures...)
	}
	return []string{LauncherFeatureSelfUpdate, LauncherFeatureOpenRC}
}

// takeLauncherResume takes over what the previous image handed this one, or
// returns nil when this image did not start from an exec in place.
func takeLauncherResume() (*launcherResume, error) {
	value, ok := os.LookupEnv(launcherResumeFDEnv)
	if !ok {
		// legacy-name: GATEWAY_DAEMON_LAUNCHER_RESUME_FD from a pre-Opfield launcher image execing into this one — remove once every node reports none
		value, ok = os.LookupEnv(legacyLauncherResumeFDEnv)
	}
	_ = os.Unsetenv(launcherResumeFDEnv)
	_ = os.Unsetenv(legacyLauncherResumeFDEnv)
	if !ok {
		return nil, nil
	}
	fd, err := strconv.Atoi(value)
	if err != nil || fd < 3 {
		return nil, errors.New("launcher resume descriptor is invalid")
	}
	syscall.CloseOnExec(fd)
	file := os.NewFile(uintptr(fd), "launcher-resume")
	defer file.Close()
	contents, err := io.ReadAll(io.NewSectionReader(file, 0, launcherResumeMaxSize))
	if err != nil {
		return nil, fmt.Errorf("read launcher resume record: %w", err)
	}
	var resume launcherResume
	if err := json.Unmarshal(contents, &resume); err != nil {
		return nil, fmt.Errorf("decode launcher resume record: %w", err)
	}
	if resume.SchemaVersion != launcherResumeSchemaVersion || resume.OwnerLockFD < 3 {
		return nil, errors.New("launcher resume record is invalid")
	}
	syscall.CloseOnExec(resume.OwnerLockFD)
	lock := os.NewFile(uintptr(resume.OwnerLockFD), "owner.lock")
	// The lock moved with its descriptor: taking it on the same open file
	// description again succeeds at once.
	if err := syscall.Flock(resume.OwnerLockFD, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("the owner lock did not move with the launcher: %w", err)
	}
	resume.lock = lock
	return &resume, nil
}

// adoptLauncherChild supervises the daemon child the previous image started:
// it is still this process's child, so waiting for it works as before.
func adoptLauncherChild(pid int) (*exec.Cmd, <-chan error) {
	process, _ := os.FindProcess(pid) // never fails on Unix
	done := make(chan error, 1)
	go func() {
		state, err := process.Wait()
		switch {
		case err != nil:
			done <- err
		case !state.Success():
			done <- &exec.ExitError{ProcessState: state}
		default:
			done <- nil
		}
	}()
	return &exec.Cmd{Process: process}, done
}

func launcherSelfUpdateTrialDue(state *launcherRefreshState, launcherPath string, cannotResume map[string]bool) bool {
	return state != nil && state.Phase == launcherRefreshPhaseTrial && state.Attempts < launcherRefreshAttemptLimit &&
		filepath.Clean(state.LauncherPath) == filepath.Clean(launcherPath) && !cannotResume[state.TargetSHA256]
}

// launcherSelfUpdateDue reports, cheaply and without the refresh lock (it runs
// every few seconds), whether a staged launcher waits for this launcher and no
// daemon update is pending.
func launcherSelfUpdateDue(stateDir, launcherPath string, cannotResume map[string]bool) (bool, error) {
	if state, err := readLauncherRefreshState(stateDir); err != nil || !launcherSelfUpdateTrialDue(state, launcherPath, cannotResume) {
		return false, err
	}
	pending, err := readLauncherUpdateState(stateDir)
	return err == nil && pending == nil, err
}

// claimLauncherSelfUpdate returns the staged launcher to exec into in place
// and counts the attempt, or "" when none is due. cannotResume remembers the
// staged launchers (by checksum) that cannot take over in place; the next
// start of the service tries those.
func claimLauncherSelfUpdate(stateDir, launcherPath string, cannotResume map[string]bool) (string, error) {
	selected := ""
	err := withLauncherRefreshLock(stateDir, func() error {
		state, err := readLauncherRefreshState(stateDir)
		if err != nil || !launcherSelfUpdateTrialDue(state, launcherPath, cannotResume) {
			return err
		}
		if pending, err := readLauncherUpdateState(stateDir); err != nil || pending != nil {
			return err
		}
		next, err := validateStagedLauncher(stateDir, state, launcherPath)
		if err != nil || next == "" {
			return err
		}
		if probe, err := probeLauncherFeatures(next); err != nil || !probe.has(LauncherFeatureSelfUpdate) {
			// Staged by a daemon that predates self-update (a downgrade).
			cannotResume[state.TargetSHA256] = true
			return nil
		}
		// Count the attempt before exec, as a start of the service does.
		state.Attempts++
		if err := writeLauncherRefreshState(stateDir, state); err != nil {
			return err
		}
		selected = next
		return nil
	})
	return selected, err
}

// execLauncherInPlace replaces this launcher image with target, handing it the
// owner lock, the keeper and the running daemon child. It returns only when
// the exec did not happen; the launcher then carries on as before.
func execLauncherInPlace(ctx context.Context, spec LauncherSpec, target string, lock *os.File, keeper *listenerkeep.Store, startedAt time.Time, childPID int, childVersion string) error {
	resume := launcherResume{
		SchemaVersion: launcherResumeSchemaVersion,
		FromVersion:   Version,
		StartedAt:     startedAt,
		OwnerLockFD:   int(lock.Fd()),
		ChildPID:      childPID,
		ChildVersion:  childVersion,
	}
	resumeKeeper := func() {}
	if keeper != nil {
		export, resumeFn, err := keeper.PrepareExec()
		if err != nil {
			return fmt.Errorf("prepare the listener keeper: %w", err)
		}
		resume.Keeper = &export
		resumeKeeper = resumeFn
	}
	defer resumeKeeper()
	record, err := writeLauncherResume(filepath.Join(spec.StateDir, "launcher"), &resume)
	if err != nil {
		return err
	}
	defer record.Close()
	descriptors := []int{resume.OwnerLockFD, int(record.Fd())}
	if resume.Keeper != nil {
		descriptors = append(descriptors, resume.Keeper.Descriptors()...)
	}
	environment := append(environmentWithout(environmentWithout(os.Environ(), launcherResumeFDEnv), legacyLauncherResumeFDEnv),
		launcherEnvPairs(launcherResumeFDEnv, legacyLauncherResumeFDEnv, strconv.Itoa(int(record.Fd())))...)

	// No process may start while these descriptors stay open across exec.
	syscall.ForkLock.Lock()
	defer syscall.ForkLock.Unlock()
	if ctx.Err() != nil {
		return errLauncherExecAborted
	}
	inherited := 0
	defer func() {
		for _, fd := range descriptors[:inherited] {
			syscall.CloseOnExec(fd)
		}
	}()
	for _, fd := range descriptors {
		if err := clearCloseOnExec(fd); err != nil {
			return fmt.Errorf("keep descriptor %d across exec: %w", fd, err)
		}
		inherited++
	}
	return launcherExec(target, launcherCommandArgs(target, spec), environment)
}

func writeLauncherResume(dir string, resume *launcherResume) (*os.File, error) {
	encoded, err := json.Marshal(resume)
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(dir, ".launcher-resume-*")
	if err != nil {
		return nil, fmt.Errorf("create launcher resume record: %w", err)
	}
	// Only the descriptor carries the record.
	_ = os.Remove(file.Name())
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("write launcher resume record: %w", err)
	}
	return file, nil
}

func clearCloseOnExec(fd int) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, 0); errno != 0 {
		return errno
	}
	return nil
}

func environmentWithout(environment []string, name string) []string {
	kept := make([]string, 0, len(environment))
	for _, entry := range environment {
		if !strings.HasPrefix(entry, name+"=") {
			kept = append(kept, entry)
		}
	}
	return kept
}

// launcherServiceManager is what runs a launcher process: a systemd unit whose
// main process it is, OpenRC's supervise-daemon, or nothing (manual mode).
type launcherServiceManager struct {
	kind string
	// unit and restart (Restart=) describe a systemd unit.
	unit    string
	restart string
}

// respawns reports whether the service manager starts the launcher again when
// it exits on its own, a crash included.
func (m launcherServiceManager) respawns() bool {
	switch m.kind {
	case launcherManagerSystemd:
		return m.restart == "always" || m.restart == "on-failure"
	case launcherManagerOpenRC:
		// supervise-daemon respawns its process whatever it exited with.
		return true
	default:
		return false
	}
}

func (m launcherServiceManager) String() string {
	switch m.kind {
	case launcherManagerSystemd:
		return fmt.Sprintf("systemd unit %s (Restart=%s)", m.unit, m.restart)
	case launcherManagerOpenRC:
		return "OpenRC supervise-daemon"
	default:
		return "no service manager (manual mode)"
	}
}

// The systemd unit of this process and the process information the service
// manager is told from (replaceable in tests). Systemd is told by the unit's
// main PID (or its INVOCATION_ID and PID 1 as the parent), never by a process
// name.
var (
	launcherSystemdUnit = listenerkeep.SystemdUnit
	launcherProcRoot    = "/proc"
)

func detectLauncherServiceManager(launcherPID int) launcherServiceManager {
	parent, parentErr := parentProcessID(launcherPID)
	if unit, err := launcherSystemdUnit(); err == nil && unit != "" {
		properties, err := systemctlShow(unit, "MainPID", "Restart")
		if err == nil {
			if properties["MainPID"] == strconv.Itoa(launcherPID) {
				return launcherServiceManager{kind: launcherManagerSystemd, unit: unit, restart: properties["Restart"]}
			}
		} else if parentErr == nil && parent == 1 && os.Getenv("INVOCATION_ID") != "" {
			// A run user without D-Bus cannot ask systemd. A process systemd
			// started for the unit (INVOCATION_ID) whose parent is systemd
			// is the unit's main process; Restart= comes from its files.
			if restart, ok := systemdUnitFileRestart(unit, systemdUnitDirectories); ok {
				return launcherServiceManager{kind: launcherManagerSystemd, unit: unit, restart: restart}
			}
		}
	}
	if parentErr == nil && parent > 1 && isOpenRCSupervisor(parent) {
		return launcherServiceManager{kind: launcherManagerOpenRC}
	}
	return launcherServiceManager{}
}

// openRCSupervisor is the program OpenRC supervises a service with.
const openRCSupervisor = "supervise-daemon"

// isOpenRCSupervisor reports whether process pid runs OpenRC's
// supervise-daemon. Its comm reads "supervise-daemo": the kernel keeps 15
// characters of a process name (TASK_COMM_LEN). So the executable decides
// where it is readable (the process's owner and root), then the command line
// (readable by every user), and comm, also in its truncated form, only when
// neither is.
func isOpenRCSupervisor(pid int) bool {
	dir := filepath.Join(launcherProcRoot, strconv.Itoa(pid))
	if executable, err := os.Readlink(filepath.Join(dir, "exe")); err == nil {
		return filepath.Base(strings.TrimSuffix(executable, " (deleted)")) == openRCSupervisor
	}
	if commandLine, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil && len(commandLine) > 0 {
		program, _, _ := strings.Cut(string(commandLine), "\x00")
		return filepath.Base(program) == openRCSupervisor
	}
	name, err := os.ReadFile(filepath.Join(dir, "comm"))
	if err != nil {
		return false
	}
	comm := strings.TrimSpace(string(name))
	return comm == openRCSupervisor || comm == openRCSupervisor[:launcherCommLength]
}

// launcherCommLength is how much of a process name /proc/<pid>/comm keeps
// (TASK_COMM_LEN less the terminating NUL).
const launcherCommLength = 15

// systemdUnitDirectories are where systemd loads units from, highest priority
// first.
var systemdUnitDirectories = []string{"/etc/systemd/system", "/run/systemd/system", "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"}

// systemdUnitFileRestart reads the Restart= setting of unit from its unit file
// and drop-ins, as systemd combines them.
func systemdUnitFileRestart(unit string, directories []string) (string, bool) {
	var files []string
	for _, directory := range directories {
		if _, err := os.Stat(filepath.Join(directory, unit)); err == nil {
			files = append(files, filepath.Join(directory, unit))
			break
		}
	}
	if len(files) == 0 {
		return "", false
	}
	// Drop-ins apply in file name order; a name in a directory of higher
	// priority hides the same name further down.
	dropIns := map[string]string{}
	var names []string
	for _, directory := range directories {
		matches, _ := filepath.Glob(filepath.Join(directory, unit+".d", "*.conf"))
		for _, match := range matches {
			if _, seen := dropIns[filepath.Base(match)]; !seen {
				dropIns[filepath.Base(match)] = match
				names = append(names, filepath.Base(match))
			}
		}
	}
	slices.Sort(names)
	for _, name := range names {
		files = append(files, dropIns[name])
	}
	restart := "no"
	for _, path := range files {
		contents, err := os.ReadFile(path)
		if err != nil {
			return "", false
		}
		section := ""
		for _, line := range strings.Split(string(contents), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "[") {
				section = line
				continue
			}
			if value, ok := strings.CutPrefix(line, "Restart="); ok && section == "[Service]" {
				restart = strings.TrimSpace(value)
				if restart == "" {
					restart = "no"
				}
			}
		}
	}
	return restart, true
}

func systemctlShow(unit string, properties ...string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := []string{"show"}
	for _, property := range properties {
		args = append(args, "--property="+property)
	}
	output, err := exec.CommandContext(ctx, "systemctl", append(args, unit)...).Output()
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		if key, value, ok := strings.Cut(scanner.Text(), "="); ok {
			values[key] = value
		}
	}
	return values, nil
}

func parentProcessID(pid int) (int, error) {
	contents, err := os.ReadFile(filepath.Join(launcherProcRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	// pid (comm) state ppid ...; comm may hold spaces and parentheses.
	fields := strings.Fields(string(contents[strings.LastIndexByte(string(contents), ')')+1:]))
	if len(fields) < 2 {
		return 0, errors.New("process status is invalid")
	}
	return strconv.Atoi(fields[1])
}
