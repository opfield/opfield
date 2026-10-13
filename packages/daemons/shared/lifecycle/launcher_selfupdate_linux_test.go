//go:build linux

package lifecycle

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/opfield/opfield/daemon-shared/listenerkeep"
	"github.com/opfield/opfield/daemon-shared/sockettest"
)

// The test binary doubles as the launcher and the daemon of these tests: a
// launcher that really execs in place needs a real Go launcher binary.
const (
	launcherTestHelperEnv = "LIFECYCLE_LAUNCHER_TEST_HELPER"
	launcherTestDirEnv    = "LIFECYCLE_LAUNCHER_TEST_DIR"
)

func TestMain(m *testing.M) {
	// A test binary started with a command (version, launcher-probe, launcher,
	// run) is a daemon or launcher of these tests, even when a test forgot the
	// helper variable: running the whole suite there again would start
	// launchers nobody stops and fill /tmp.
	if os.Getenv(launcherTestHelperEnv) == "1" || (len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-")) {
		os.Exit(runLauncherTestHelper())
	}
	os.Exit(m.Run())
}

func runLauncherTestHelper() int {
	// The staged copy reports the next version, so the test sees which image runs.
	Version = "v1"
	if executable, err := currentExecutable(); err == nil && strings.HasSuffix(executable, ".next") {
		Version = "v2"
	}
	launcherSelfUpdateCheck = 50 * time.Millisecond
	launcherStabilityWindow = 300 * time.Millisecond
	launcherRestartBackoff = 10 * time.Millisecond
	launcherRestartMax = 20 * time.Millisecond
	launcherKeeperSettle = 100 * time.Millisecond
	launcherStopGrace = time.Second
	// As under a service manager that starts the service again.
	launcherServiceManagerOf = func(int) launcherServiceManager { return launcherServiceManager{kind: launcherManagerOpenRC} }
	switch {
	case IsLauncherProbeCommand(os.Args):
		PrintLauncherProbe()
		return 0
	case IsLauncherCommand(os.Args):
		if err := RunLauncherCommand(os.Args, slog.New(slog.NewTextHandler(os.Stderr, nil))); err != nil {
			fmt.Fprintln(os.Stderr, "launcher failed:", err)
			return 1
		}
		return 0
	case len(os.Args) > 1 && os.Args[1] == "version":
		fmt.Println("test-daemon", Version)
		return 0
	case len(os.Args) > 1 && os.Args[1] == "run":
		return runLauncherTestDaemon(os.Getenv(launcherTestDirEnv))
	}
	return 2
}

// runLauncherTestDaemon serves an echo listener at a.sock that it keeps in the
// launcher, adopting the kept one when the launcher handed it over. SIGUSR1
// keeps a second listener, b.sock. It logs what it did to daemon.log.
func runLauncherTestDaemon(dir string) int {
	if err := BootstrapLauncher(LauncherSpec{}); err != nil {
		return 3
	}
	if _, err := os.Stat(filepath.Join(dir, "fail")); err == nil {
		return 1
	}
	logLine := func(format string, args ...any) {
		file, err := os.OpenFile(filepath.Join(dir, "daemon.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err == nil {
			fmt.Fprintf(file, format+"\n", args...)
			_ = file.Close()
		}
	}
	var adopted []string
	listeners := map[string]net.Listener{}
	for _, name := range listenerkeep.Inherited(dir) {
		file, ok := listenerkeep.Take(name)
		if !ok {
			continue
		}
		listener, err := net.FileListener(file)
		_ = file.Close()
		if err != nil {
			continue
		}
		base := filepath.Base(listenerkeep.NamePath(name))
		listeners[base] = listener
		adopted = append(adopted, base)
	}
	serve := func(listener net.Listener) {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(connection, connection) }()
		}
	}
	keep := func(base string) {
		path := filepath.Join(dir, base)
		listener := listeners[base]
		if listener == nil {
			created, err := net.Listen("unix", path)
			if err != nil {
				logLine("error %v", err)
				return
			}
			created.(*net.UnixListener).SetUnlinkOnClose(false)
			listener = created
			listeners[base] = listener
		}
		name, err := listenerkeep.Name(path)
		if err == nil {
			var file *os.File
			if file, err = duplicateTestListener(listener.(*net.UnixListener)); err == nil {
				err = listenerkeep.Keep(name, file)
				_ = file.Close()
			}
		}
		if err != nil {
			logLine("error %v", err)
		}
		go serve(listener)
	}
	keep("a.sock")
	for base := range listeners {
		if base != "a.sock" {
			keep(base)
		}
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGUSR1, syscall.SIGTERM)
	sort.Strings(adopted)
	logLine("start pid=%d adopted=%s", os.Getpid(), strings.Join(adopted, ","))
	NotifyLauncherLocalReady(Version)
	for sig := range signals {
		if sig == syscall.SIGTERM {
			return 0
		}
		keep("b.sock")
		logLine("kept b.sock")
	}
	return 0
}

// duplicateTestListener copies a listener's descriptor without File, which
// may switch the shared socket to blocking mode (as the daemons do).
func duplicateTestListener(listener *net.UnixListener) (*os.File, error) {
	raw, err := listener.SyscallConn()
	if err != nil {
		return nil, err
	}
	duplicated := -1
	var dupErr error
	if err := raw.Control(func(fd uintptr) {
		duplicated, dupErr = syscall.Dup(int(fd))
		if dupErr == nil {
			syscall.CloseOnExec(duplicated)
		}
	}); err != nil {
		return nil, err
	}
	if dupErr != nil {
		return nil, dupErr
	}
	return os.NewFile(uintptr(duplicated), "listener"), nil
}

type launcherInPlaceHarness struct {
	t            *testing.T
	dir          string
	stateDir     string
	binary       string
	launcherPath string
	next         string
	launcher     *exec.Cmd
	exited       chan error
}

func startLauncherInPlaceHarness(t *testing.T) *launcherInPlaceHarness {
	t.Helper()
	dir := sockettest.Dir(t)
	h := &launcherInPlaceHarness{t: t, dir: dir, stateDir: filepath.Join(dir, "state"), binary: filepath.Join(dir, "bin", "test-daemon")}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	h.launcherPath = canonicalLauncherPath(h.stateDir, h.binary)
	h.next = stagedLauncherPath(h.launcherPath)
	if err := ensurePrivateLauncherDirectory(filepath.Dir(h.launcherPath)); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{h.binary, h.launcherPath, h.next} {
		if err := copyExecutableAtomic(self, path); err != nil {
			t.Fatal(err)
		}
	}
	// Trailing bytes give the staged launcher its own checksum; it still runs.
	appendTo(t, h.next, "\nstaged launcher\n")

	h.launcher = exec.Command(h.launcherPath, launcherCommandArgs(h.launcherPath, LauncherSpec{
		DaemonType: "docker", StateDir: h.stateDir, BinaryPath: h.binary, ChildArgs: []string{"run"},
	})[1:]...)
	h.launcher.Env = append(os.Environ(), launcherTestHelperEnv+"=1", launcherTestDirEnv+"="+dir)
	logFile, err := os.Create(filepath.Join(dir, "launcher.log"))
	if err != nil {
		t.Fatal(err)
	}
	h.launcher.Stdout, h.launcher.Stderr = logFile, logFile
	if err := h.launcher.Start(); err != nil {
		t.Fatal(err)
	}
	_ = logFile.Close()
	h.exited = make(chan error, 1)
	go func() { h.exited <- h.launcher.Wait() }()
	t.Cleanup(func() {
		_ = h.launcher.Process.Signal(syscall.SIGTERM)
		select {
		case <-h.exited:
		case <-time.After(5 * time.Second):
			_ = h.launcher.Process.Kill()
		}
		if t.Failed() {
			for _, name := range []string{"launcher.log", "daemon.log"} {
				contents, _ := os.ReadFile(filepath.Join(dir, name))
				t.Logf("%s:\n%s", name, contents)
			}
		}
	})
	return h
}

func appendTo(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

// waitFor polls condition until it holds or 10 s passed.
func (h *launcherInPlaceHarness) waitFor(what string, condition func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (h *launcherInPlaceHarness) daemonLog() []string {
	contents, _ := os.ReadFile(filepath.Join(h.dir, "daemon.log"))
	var lines []string
	scanner := bufio.NewScanner(strings.NewReader(string(contents)))
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines
}

// daemonStarts returns the "start" lines of the daemon log.
func (h *launcherInPlaceHarness) daemonStarts() []string {
	var starts []string
	for _, line := range h.daemonLog() {
		if strings.HasPrefix(line, "start ") {
			starts = append(starts, line)
		}
	}
	return starts
}

func (h *launcherInPlaceHarness) launcherExecutable() string {
	executable, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", h.launcher.Process.Pid))
	return executable
}

func (h *launcherInPlaceHarness) stageNext() {
	h.t.Helper()
	sum, err := executableChecksum(h.next)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := writeLauncherRefreshState(h.stateDir, &launcherRefreshState{
		Phase:         launcherRefreshPhaseTrial,
		LauncherPath:  h.launcherPath,
		TargetSHA256:  sum,
		TargetVersion: "v2",
		StagedAt:      time.Now().UTC(),
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *launcherInPlaceHarness) owner() launcherOwner {
	h.t.Helper()
	owner, err := readLauncherOwner(h.stateDir)
	if err != nil {
		h.t.Fatal(err)
	}
	return *owner
}

func echo(t *testing.T, connection net.Conn, message string) {
	t.Helper()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := connection.Write([]byte(message)); err != nil {
		t.Fatalf("write %q: %v", message, err)
	}
	reply := make([]byte, len(message))
	if _, err := io.ReadFull(connection, reply); err != nil || string(reply) != message {
		t.Fatalf("echo of %q = %q, %v", message, reply, err)
	}
}

func daemonPID(t *testing.T, start string) int {
	t.Helper()
	var pid int
	if _, err := fmt.Sscanf(start, "start pid=%d", &pid); err != nil {
		t.Fatalf("daemon start line %q: %v", start, err)
	}
	return pid
}

// A launcher with a running daemon and a kept listener execs into the staged
// launcher: same process, the daemon keeps running with its connection, and
// the keeper still holds the listener and takes what the daemon keeps after
// the exec. A daemon the new launcher starts takes both over, and that start
// confirms the new launcher.
func TestLauncherUpdatesItselfInPlaceKeepingDaemonAndKeeper(t *testing.T) {
	h := startLauncherInPlaceHarness(t)
	launcherPID := h.launcher.Process.Pid
	h.waitFor("the daemon started", func() bool { return len(h.daemonStarts()) == 1 })
	if start := h.daemonStarts()[0]; !strings.HasSuffix(start, "adopted=") {
		t.Fatalf("first daemon adopted listeners: %q", start)
	}
	firstDaemon := daemonPID(t, h.daemonStarts()[0])
	connection, err := net.Dial("unix", filepath.Join(h.dir, "a.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	echo(t, connection, "before")
	if owner := h.owner(); owner.Version != "v1" || owner.PID != launcherPID {
		t.Fatalf("owner before = %+v", owner)
	}

	h.stageNext()
	h.waitFor("the launcher execed into the staged launcher", func() bool { return h.launcherExecutable() == h.next })
	h.waitFor("the new image wrote its owner record", func() bool { return h.owner().Version == "v2" })
	owner := h.owner()
	if owner.PID != launcherPID || !slices.Equal(owner.Features, launcherBinaryFeatures) {
		t.Fatalf("owner after exec = %+v", owner)
	}
	if state, err := readLauncherRefreshState(h.stateDir); err != nil || state == nil || state.Phase != launcherRefreshPhaseTrial || state.Attempts != 1 {
		t.Fatalf("refresh journal after exec = %+v, %v", state, err)
	}
	if err := syscall.Kill(firstDaemon, 0); err != nil {
		t.Fatalf("the daemon did not survive the launcher exec: %v", err)
	}
	if starts := h.daemonStarts(); len(starts) != 1 {
		t.Fatalf("the daemon restarted: %q", starts)
	}
	echo(t, connection, "after")

	// The daemon's channel to the keeper survived: what it keeps now reaches
	// the new image.
	if err := syscall.Kill(firstDaemon, syscall.SIGUSR1); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the daemon kept b.sock", func() bool { return strings.Contains(strings.Join(h.daemonLog(), "\n"), "kept b.sock") })
	if err := syscall.Kill(firstDaemon, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the new launcher started a daemon", func() bool { return len(h.daemonStarts()) == 2 })
	if start := h.daemonStarts()[1]; !strings.HasSuffix(start, "adopted=a.sock,b.sock") {
		t.Fatalf("the next daemon did not take over the kept listeners: %q", start)
	}
	fresh, err := net.Dial("unix", filepath.Join(h.dir, "a.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	echo(t, fresh, "adopted")

	nextSum, err := executableChecksum(h.next)
	if err != nil {
		t.Fatal(err)
	}
	h.waitFor("the new launcher was confirmed", func() bool {
		sum, err := executableChecksum(h.launcherPath)
		return err == nil && sum == nextSum
	})
	h.waitFor("the refresh journal was cleared", func() bool {
		state, err := readLauncherRefreshState(h.stateDir)
		return err == nil && state == nil
	})
	if h.launcher.Process.Pid != launcherPID || h.owner().PID != launcherPID {
		t.Fatal("the launcher process changed")
	}
}

// A launcher that execed in place stays on trial: when the daemons it starts
// keep failing, it falls back to the known-good copy, in place again, and the
// staged binary is never tried again.
func TestLauncherInPlaceTrialFallsBackWhenDaemonsFail(t *testing.T) {
	h := startLauncherInPlaceHarness(t)
	launcherPID := h.launcher.Process.Pid
	h.waitFor("the daemon started", func() bool { return len(h.daemonStarts()) == 1 })
	firstDaemon := daemonPID(t, h.daemonStarts()[0])
	h.stageNext()
	h.waitFor("the launcher execed into the staged launcher", func() bool { return h.launcherExecutable() == h.next })

	if err := os.WriteFile(filepath.Join(h.dir, "fail"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(firstDaemon, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the launcher fell back to the known-good copy", func() bool { return h.launcherExecutable() == h.launcherPath })
	state, err := readLauncherRefreshState(h.stateDir)
	if err != nil || state == nil || state.Phase != launcherRefreshPhaseAbandoned || !strings.Contains(state.Reason, "daemon failed") {
		t.Fatalf("refresh journal after the fallback = %+v, %v", state, err)
	}
	if _, err := os.Stat(h.next); !os.IsNotExist(err) {
		t.Fatalf("the abandoned staged launcher remains: %v", err)
	}
	if h.launcher.Process.Pid != launcherPID {
		t.Fatal("the launcher process changed")
	}
	if err := os.Remove(filepath.Join(h.dir, "fail")); err != nil {
		t.Fatal(err)
	}
	h.waitFor("the known-good launcher started a daemon", func() bool { return len(h.daemonStarts()) == 2 })
	h.waitFor("the known-good launcher wrote its owner record", func() bool { return h.owner().Version == "v1" })

	// The same binary is not staged again at once, only once its retry is due
	// (O-5: a dependency that was down must not keep the old launcher for good).
	// The same binary under a .next name, so its test helper reports v2 as
	// the staged copy does.
	again := writeNextAgain(t, h)
	if err := os.Rename(again, again+".next"); err != nil {
		t.Fatal(err)
	}
	again += ".next"
	// Staging runs the binary (version, launcher probe): as the test helper,
	// never as this test binary, which would run the whole suite again.
	t.Setenv(launcherTestHelperEnv, "1")
	staged, err := stageLauncherRefresh(h.stateDir, h.launcherPath, again, "v2", time.Now())
	var retry *launcherRefreshRetryLater
	if staged || !errors.As(err, &retry) || time.Until(retry.At) < 50*time.Minute {
		t.Fatalf("the abandoned binary was staged again at once: %v, %v", staged, err)
	}
	if staged, err := stageLauncherRefresh(h.stateDir, h.launcherPath, again, "v2", retry.At.Add(time.Second)); err != nil || !staged {
		t.Fatalf("the abandoned binary was not staged again once its retry was due: %v, %v", staged, err)
	}
	if state, err := readLauncherRefreshState(h.stateDir); err != nil || state == nil || state.Phase != launcherRefreshPhaseTrial || state.Abandons != 1 {
		t.Fatalf("refresh journal of the retry = %+v, %v", state, err)
	}
}

// writeNextAgain recreates the abandoned staged binary elsewhere, as the daemon
// that staged it would offer it again.
func writeNextAgain(t *testing.T, h *launcherInPlaceHarness) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	again := filepath.Join(h.dir, "bin", "again")
	if err := copyExecutableAtomic(self, again); err != nil {
		t.Fatal(err)
	}
	appendTo(t, again, "\nstaged launcher\n")
	return again
}

// The resume record carries every descriptor across exec, and an exec that
// fails leaves the launcher as it was: descriptors close-on-exec again and the
// keeper reading its channel.
func TestLauncherExecInPlaceFailureRestoresDescriptors(t *testing.T) {
	dir := sockettest.Dir(t)
	stateDir := filepath.Join(dir, "state")
	if err := ensurePrivateLauncherDirectory(filepath.Join(stateDir, "launcher")); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(stateDir, "launcher", "owner.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	keeper, err := listenerkeep.OpenStore(discardLauncherLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer keeper.Close()

	var record launcherResume
	var inherited []int
	oldExec := launcherExec
	launcherExec = func(path string, args []string, environment []string) error {
		for _, entry := range environment {
			if value, ok := strings.CutPrefix(entry, launcherResumeFDEnv+"="); ok {
				fd, _ := strconv.Atoi(value)
				contents := make([]byte, 1<<16)
				n, _ := syscall.Pread(fd, contents, 0)
				_ = json.Unmarshal(contents[:max(n, 0)], &record)
				inherited = append(inherited, fd)
			}
		}
		return syscall.ENOEXEC
	}
	defer func() { launcherExec = oldExec }()

	err = execLauncherInPlace(t.Context(), LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: "/bin/true"}, "/bin/true", lock, keeper, time.Now(), 4242, "v1")
	if err != syscall.ENOEXEC {
		t.Fatalf("exec in place = %v", err)
	}
	if record.SchemaVersion != launcherResumeSchemaVersion || record.ChildPID != 4242 || record.Keeper == nil || record.OwnerLockFD != int(lock.Fd()) {
		t.Fatalf("resume record = %+v", record)
	}
	for _, fd := range append(inherited, record.Keeper.Descriptors()...) {
		flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFD, 0)
		if errno == 0 && flags&syscall.FD_CLOEXEC == 0 {
			t.Fatalf("descriptor %d stays open across exec after the failed exec", fd)
		}
	}
	// The keeper reads its channel again.
	settleStarted := time.Now()
	keeper.Settle(2 * time.Second)
	if waited := time.Since(settleStarted); waited > time.Second {
		t.Fatalf("the keeper did not read its channel after the failed exec (waited %s)", waited)
	}
}
