package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLauncherUpdateStateStagesAndRollsBack(t *testing.T) {
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	original, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	state, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, binary, "v2", true)
	for index := 0; index < launcherFailureThreshold; index++ {
		rolledBack, failureErr := recordLauncherCandidateFailure(stateDir, state, "candidate crashed", time.Now())
		if failureErr != nil {
			t.Fatal(failureErr)
		}
		if rolledBack != (index == launcherFailureThreshold-1) {
			t.Fatalf("rollback at failure %d = %v", index+1, rolledBack)
		}
	}
	restored, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatal("previous executable was not restored byte-for-byte")
	}
	if pending, err := readLauncherUpdateState(stateDir); err != nil || pending != nil {
		t.Fatalf("pending state after rollback = %#v, %v", pending, err)
	}
	contents, err := os.ReadFile(launcherOutcomePath(stateDir))
	if err != nil {
		t.Fatalf("rollback outcome was not persisted: %v", err)
	}
	if !strings.Contains(string(contents), `"status":"rolled_back"`) || !strings.Contains(string(contents), `"targetVersion":"v2"`) {
		t.Fatalf("rollback outcome = %s", contents)
	}
}

func TestLauncherUpdateRejectsSecondPendingUpdate(t *testing.T) {
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v3", time.Now()); err == nil || !strings.Contains(err.Error(), "already pending") {
		t.Fatalf("second update error = %v", err)
	}
}

func TestLauncherRollbackIsIdempotentAcrossJournalCleanupCrash(t *testing.T) {
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	state, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, binary, "v2", true)

	// Simulate a power loss after the good binary was restored but before the
	// update journal could be removed.
	if err := copyExecutableAtomic(state.PreviousPath, state.BinaryPath); err != nil {
		t.Fatal(err)
	}
	if err := rollbackLauncherUpdate(stateDir, state, "resume interrupted rollback"); err != nil {
		t.Fatal(err)
	}
	version, err := readDaemonBinaryVersion(binary)
	if err != nil || version != "v1" {
		t.Fatalf("restored version = %q, %v", version, err)
	}
	if _, err := os.Stat(state.PreviousPath); err != nil {
		t.Fatalf("known-good backup must remain reusable: %v", err)
	}
	if pending, err := readLauncherUpdateState(stateDir); err != nil || pending != nil {
		t.Fatalf("pending state after resumed rollback = %#v, %v", pending, err)
	}
}

func TestExecutableBackupPreservesParentDirectoryMode(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(parent, "daemon")
	writeLauncherTestExecutable(t, source, "v1", true)
	if err := copyExecutableAtomic(source, source+".previous"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0755 {
		t.Fatalf("parent directory mode changed to %o", mode)
	}
}

func TestDaemonExitCodeUsesDedicatedUpdateHandoff(t *testing.T) {
	if code := DaemonExitCode(&RestartRequestedError{Message: "updated"}); code != LauncherUpdateExitCode {
		t.Fatalf("restart exit code = %d", code)
	}
	if code := DaemonExitCode(context.Canceled); code != 1 {
		t.Fatalf("ordinary error exit code = %d", code)
	}
	// Stopped by the service manager for a whole-service restart: a clean
	// exit, so the stopping launcher exits cleanly too (O-3).
	if code := DaemonExitCode(&RestartRequestedError{Message: "updated", serviceStopped: true}); code != 0 {
		t.Fatalf("service restart exit code = %d", code)
	}
}

// A launcher stopped while its daemon exits for a staged update (the daemon
// of an update that restarts the whole service) stops cleanly: the unit does
// not record the planned restart as a failure, and the update stays staged
// for the next start (O-3).
func TestLauncherStopWhileDaemonExitsForUpdateIsClean(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	contents, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte(strings.Replace(string(contents), "trap 'exit 0' TERM INT", "trap 'exit 75' TERM INT", 1)), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, filepath.Join(stateDir, "launcher", "owner.json"), true)
	waitForLauncherChildReady(t, stateDir)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("launcher stop returned %v, want a clean stop", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop after context cancellation")
	}
}

func TestEnsureLauncherCopyNeverReplacesInvalidExistingLauncher(t *testing.T) {
	stateDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "test-daemon")
	launcherPath := filepath.Join(stateDir, "launcher", "test-daemon-launcher")
	writeLauncherTestExecutable(t, source, "v1", true)
	writeLauncherTestExecutable(t, launcherPath, "broken", false)
	before, err := os.ReadFile(launcherPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureLauncherCopy(source, launcherPath, stateDir); err == nil || !strings.Contains(err.Error(), "explicit repair required") {
		t.Fatalf("ensure invalid launcher error = %v", err)
	}
	after, err := os.ReadFile(launcherPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("invalid existing launcher was silently replaced")
	}
}

func TestLauncherOwnerLockSerializesConcurrentLaunchers(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "owner.lock")
	first, err := acquireLauncherLock(context.Background(), lockPath)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan *os.File, 1)
	errors := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		lock, lockErr := acquireLauncherLock(ctx, lockPath)
		if lockErr != nil {
			errors <- lockErr
			return
		}
		result <- lock
	}()
	select {
	case <-result:
		t.Fatal("second launcher acquired the owner lock concurrently")
	case err := <-errors:
		t.Fatalf("second launcher failed before owner release: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	releaseLauncherLock(first)
	select {
	case second := <-result:
		releaseLauncherLock(second)
	case err := <-errors:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("second launcher did not acquire the released owner lock")
	}
}

func TestLauncherChildRetainsOwnerLockIfLauncherCrashes(t *testing.T) {
	stateDir := t.TempDir()
	launcherDir := filepath.Join(stateDir, "launcher")
	if err := ensurePrivateLauncherDirectory(launcherDir); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(launcherDir, "owner.lock")
	lock, err := acquireLauncherLock(context.Background(), lockPath)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	child, _, done, err := startLauncherChild(LauncherSpec{
		DaemonType: "docker",
		StateDir:   stateDir,
		BinaryPath: binary,
		ChildArgs:  []string{"run"},
	}, lock, nil)
	if err != nil {
		t.Fatal(err)
	}
	// A real launcher crash closes its descriptor without issuing LOCK_UN.
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}

	contender, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer contender.Close()
	if err := syscall.Flock(int(contender.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
		t.Fatalf("child did not retain launcher ownership lock: %v", err)
	}
	if err := terminateLauncherChild(child, done, time.Second); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(contender.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("ownership lock remained after child exit: %v", err)
	}
	_ = syscall.Flock(int(contender.Fd()), syscall.LOCK_UN)
}

func TestLauncherOperatorStopForwardsSignalWithoutFailureState(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, filepath.Join(stateDir, "launcher", "owner.json"), true)
	waitForLauncherChildReady(t, stateDir)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop after context cancellation")
	}
	if pending, err := readLauncherUpdateState(stateDir); err != nil || pending != nil {
		t.Fatalf("operator stop mutated update state: %#v, %v", pending, err)
	}
}

func waitForLauncherChildReady(t *testing.T, stateDir string) {
	t.Helper()
	path := filepath.Join(stateDir, "launcher", "child.json")
	deadline := time.Now().Add(3 * time.Second)
	for {
		contents, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(contents), `"ready":true`) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("launcher child did not become ready: %s, %v", contents, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLauncherCommitsLocallyReadyStableCandidate(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, binary, "v2", true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, launcherStatePath(stateDir), false)
	if version, err := readDaemonBinaryVersion(binary); err != nil || version != "v2" {
		t.Fatalf("candidate version = %q, %v", version, err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func TestLauncherRollsBackCandidateWithoutReadiness(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, binary, "v2", false)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, launcherStatePath(stateDir), false)
	deadline := time.Now().Add(3 * time.Second)
	for {
		version, err := readDaemonBinaryVersion(binary)
		if err == nil && version == "v1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("previous binary was not restored: version=%q err=%v", version, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func TestLauncherRequiresFreshReadinessAfterSupervisorRestart(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	state, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := markLauncherCandidateStarted(stateDir, state, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := markLauncherLocalReady(stateDir, state, time.Now()); err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, binary, "v2", false)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		version, versionErr := readDaemonBinaryVersion(binary)
		if versionErr == nil && version == "v1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted readiness incorrectly committed the candidate: version=%q err=%v", version, versionErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func TestLauncherRollsBackCandidateThatCrashesDuringStabilityWindow(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	contents := `#!/bin/sh
case "$1" in
version) echo test-daemon v2; exit 0 ;;
esac
printf '%s\n' '{"type":"local_ready","version":"v2"}' >"/dev/fd/$GATEWAY_DAEMON_LAUNCHER_READY_FD"
exit 1
`
	if err := os.WriteFile(binary, []byte(contents), 0755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, launcherStatePath(stateDir), false)
	deadline := time.Now().Add(3 * time.Second)
	for {
		version, err := readDaemonBinaryVersion(binary)
		if err == nil && version == "v1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("previous binary was not restored after ready crash: version=%q err=%v", version, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func writeControlAwareLauncherTestExecutable(t *testing.T, path, version string, controlReady bool) {
	t.Helper()
	controlLine := ""
	if controlReady {
		controlLine = `printf '%s\n' '{"type":"control_ready","version":"` + version + `"}' >"/dev/fd/$GATEWAY_DAEMON_LAUNCHER_READY_FD"` + "\n"
	}
	contents := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"version) echo test-daemon " + version + "; exit 0 ;;\n" +
		"launcher-probe) echo gateway-daemon-launcher 1; exit 0 ;;\n" +
		"esac\n" +
		`printf '%s\n' '{"type":"local_ready","version":"` + version + `","awaitControl":true}' >"/dev/fd/$GATEWAY_DAEMON_LAUNCHER_READY_FD"` + "\n" +
		controlLine +
		"trap 'exit 0' TERM INT\n" + launcherTestIdleLoop
	if err := os.WriteFile(path, []byte(contents), 0755); err != nil {
		t.Fatal(err)
	}
}

func TestLauncherRollsBackCandidateThatNeverReachesOpfieldControl(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	// Locally ready (and stable) but never accepted by the gateway.
	writeControlAwareLauncherTestExecutable(t, binary, "v2", false)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		version, err := readDaemonBinaryVersion(binary)
		if err == nil && version == "v1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("candidate without gateway control was not rolled back: version=%q err=%v", version, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The binary is restored before the outcome is recorded and the journal removed.
	waitForLauncherPath(t, launcherStatePath(stateDir), false)
	outcome, err := os.ReadFile(launcherOutcomePath(stateDir))
	cancel()
	if err != nil || !strings.Contains(string(outcome), "Opfield control readiness timeout") {
		<-done
		t.Fatalf("rollback outcome = %s, %v", outcome, err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func TestLauncherCommitsCandidateAfterOpfieldControlReady(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir := t.TempDir()
	binary := filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, binary, "v1", true)
	if _, err := stageLauncherUpdate(stateDir, "docker", binary, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	writeControlAwareLauncherTestExecutable(t, binary, "v2", true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: binary, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, launcherStatePath(stateDir), false)
	if version, err := readDaemonBinaryVersion(binary); err != nil || version != "v2" {
		t.Fatalf("candidate version = %q, %v", version, err)
	}
	if _, err := os.Stat(launcherOutcomePath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("unexpected rollback outcome: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
}

func useFastLauncherTimings() func() {
	oldReady := launcherLocalReadyLimit
	oldControl := launcherControlReadyLimit
	oldStable := launcherStabilityWindow
	oldGrace := launcherStopGrace
	oldBackoff := launcherRestartBackoff
	oldMax := launcherRestartMax
	oldStateRetry := launcherStateRetry
	launcherLocalReadyLimit = 40 * time.Millisecond
	launcherControlReadyLimit = 150 * time.Millisecond
	launcherStabilityWindow = 60 * time.Millisecond
	launcherStopGrace = 100 * time.Millisecond
	launcherRestartBackoff = 10 * time.Millisecond
	launcherRestartMax = 20 * time.Millisecond
	launcherStateRetry = 20 * time.Millisecond
	return func() {
		launcherLocalReadyLimit = oldReady
		launcherControlReadyLimit = oldControl
		launcherStabilityWindow = oldStable
		launcherStopGrace = oldGrace
		launcherRestartBackoff = oldBackoff
		launcherRestartMax = oldMax
		launcherStateRetry = oldStateRetry
	}
}

// launcherTestIdleLoop keeps a test daemon running. Like a real daemon, which marks the ready pipe (fd 3) and the owner
// lock (fd 4) close-on-exec before it spawns anything, it keeps both out of its workers: a sleep that inherited the lock
// could outlive a SIGKILLed shell and hold the lock after the launcher already saw the child exit.
const launcherTestIdleLoop = "while :; do sleep 1 3>&- 4>&-; done\n"

func writeLauncherTestExecutable(t *testing.T, path, version string, ready bool) {
	t.Helper()
	writeLauncherTestExecutableWithMarker(t, path, version, ready, "")
}

func writeLauncherTestExecutableWithMarker(t *testing.T, path, version string, ready bool, marker string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	readyLine := ""
	if ready {
		readyLine = `if [ -n "$GATEWAY_DAEMON_LAUNCHER_READY_FD" ]; then printf '%s\n' '{"type":"local_ready","version":"` + version + `"}' >"/dev/fd/$GATEWAY_DAEMON_LAUNCHER_READY_FD"; fi`
	}
	trapLine := "trap 'exit 0' TERM INT"
	if marker != "" {
		trapLine = "trap 'printf terminated > " + marker + "; exit 0' TERM INT"
	}
	contents := "#!/bin/sh\n" +
		"case \"$1\" in\n" +
		"version) echo test-daemon " + version + "; exit 0 ;;\n" +
		"launcher-probe) " + func() string {
		if ready {
			return "echo gateway-daemon-launcher 1; exit 0"
		}
		return "exit 2"
	}() + " ;;\n" +
		"esac\n" + readyLine + "\n" + trapLine + "\n" + launcherTestIdleLoop
	if err := os.WriteFile(path, []byte(contents), 0755); err != nil {
		t.Fatal(err)
	}
}

func waitForLauncherPath(t *testing.T, path string, exists bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err := os.Stat(path)
		if (err == nil) == exists {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("path %s existence did not become %v: %v", path, exists, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func discardLauncherLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
