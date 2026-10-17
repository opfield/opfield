//go:build linux

package exec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// agentSandboxWaitDelay is how long the output of a finished command is still
// read while a background process it started holds the pipes.
const agentSandboxWaitDelay = 500 * time.Millisecond

// A daemon binary started with agentSandboxArg is the sandbox setup of one
// agent command (see RunAgentCommand): it covers the runtime paths and
// executes the command. It never returns to the daemon's own start-up.
func init() {
	if len(os.Args) > 1 && os.Args[1] == agentSandboxArg {
		runAgentSandbox(os.Args[2:])
	}
}

// AgentSandboxSupported reports whether this build can run agent commands in
// the sandbox.
func AgentSandboxSupported() bool { return true }

// RunAgentCommand runs an agent's one-shot console command in the sandbox
// described in agent_sandbox.go, as root or as runAsUser (console.user) when
// one is configured. A daemon that does not run as root runs it as its own
// user instead (see runUnprivilegedAgentCommand); the result says so. When a
// runtime path cannot be covered the command does not run and the error says
// why. A command still running at ctx's deadline is stopped with everything it
// started; its output so far is returned with TimedOut set.
func RunAgentCommand(ctx context.Context, command []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	masks := agentSandboxMaskPaths()
	if os.Geteuid() != 0 {
		return runUnprivilegedAgentCommand(ctx, command, masks, runAsUser, maxOutputBytes)
	}
	return runAgentCommand(ctx, command, masks, runAsUser, maxOutputBytes)
}

// errUserNamespaceUnavailable marks a host (or a daemon unit) that does not let
// an unprivileged process create a user namespace.
var errUserNamespaceUnavailable = errors.New("unprivileged user namespaces are not available")

// runUnprivilegedAgentCommand runs an agent command for a daemon that does not
// run as root (an installer's --user, OPFIELD_RELAY_RUN_USER). Such a daemon
// cannot give the command root, so it runs as the daemon's user:
//
//   - when that user cannot reach any container runtime socket (the usual
//     case), directly, in its own process group;
//   - when it can (it is in the docker group, or a rootless runtime runs as
//     it), in a user and mount namespace that covers the runtime like the root
//     sandbox does; a host without unprivileged user namespaces refuses the
//     command then, naming the socket and the fix.
//
// The result names the user and what is limited, so the agent knows why a
// command that needs root fails.
func runUnprivilegedAgentCommand(ctx context.Context, command, masks []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	daemonUser := processUserName()
	if runAsUser != "" {
		if err := CheckRunAsUser(runAsUser); err != nil {
			return CommandResult{}, fmt.Errorf("cannot run as user %q: %w", runAsUser, err)
		}
	}
	reachable := reachableRuntimeSockets(append(masks, rootlessRuntimeSockets()...))
	if len(reachable) == 0 {
		result, err := runDaemonUserCommand(ctx, command, runAsUser, maxOutputBytes)
		result.RunAs = daemonUser
		result.Sandbox = AgentSandboxDaemonUser
		result.Limits = fmt.Sprintf("The node's daemon runs as %s, not root, so this command ran as %s: commands that need root (installing packages, changing services, editing system files) fail with permission errors. %s cannot reach the container runtime. Background processes the command started in a new session are not ended with it.", daemonUser, daemonUser, daemonUser)
		return result, err
	}
	result, started, err := runAgentCommandIn(ctx, command, append(masks, reachable...), runAsUser, maxOutputBytes, true)
	if errors.Is(err, errUserNamespaceUnavailable) {
		return CommandResult{}, fmt.Errorf("the node's daemon runs as %s, not root, and %s can reach the container runtime (%s), which Opfield cannot cover on this host because it does not allow unprivileged user namespaces; agent console commands are refused on this node. Take %s out of the group that owns the socket (usually docker), or run the daemon as root, and restart the daemon", daemonUser, daemonUser, strings.Join(reachable, ", "), daemonUser)
	}
	if !started {
		return result, err
	}
	result.RunAs = daemonUser
	result.Sandbox = AgentSandboxUserNamespace
	result.Limits = fmt.Sprintf("The node's daemon runs as %s, not root, so this command ran as %s in a user namespace that covers the container runtime: commands that need root fail with permission errors, and files and processes of other users (root included) show as owned by nobody (65534).", daemonUser, daemonUser)
	return result, err
}

// reachableRuntimeSockets lists the runtime sockets among paths (and in the
// runtime directories among them) this process could connect to.
func reachableRuntimeSockets(paths []string) []string {
	var reachable []string
	seen := map[string]bool{}
	check := func(path string) {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		if seen[path] {
			return
		}
		seen[path] = true
		info, err := os.Stat(path)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			return
		}
		// Connecting to a unix socket needs write permission on it.
		if unix.Access(path, unix.W_OK) == nil {
			reachable = append(reachable, path)
		}
	}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if !info.IsDir() {
			check(path)
			continue
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			check(filepath.Join(path, entry.Name()))
		}
	}
	return reachable
}

// rootlessRuntimeSockets are where rootless Docker and Podman of this
// process's user listen, and the socket DOCKER_HOST names.
func rootlessRuntimeSockets() []string {
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = "/run/user/" + strconv.Itoa(os.Getuid())
	}
	paths := []string{
		filepath.Join(runtimeDir, "docker.sock"),
		filepath.Join(runtimeDir, "podman", "podman.sock"),
		filepath.Join(runtimeDir, "containerd-rootless"),
	}
	if host := os.Getenv("DOCKER_HOST"); strings.HasPrefix(host, "unix://") {
		paths = append(paths, strings.TrimPrefix(host, "unix://"))
	}
	return paths
}

// runDaemonUserCommand runs the command as this (non-root) process's user, or
// runAsUser, in its own process group, which is killed when the command ends
// or at the deadline.
func runDaemonUserCommand(ctx context.Context, command []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	if len(command) == 0 {
		return CommandResult{}, fmt.Errorf("command is required")
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 128 * 1024
	}
	program, err := osexec.LookPath(command[0])
	if err != nil {
		return CommandResult{}, err
	}
	cmd := osexec.Command(program, command[1:]...)
	cmd.Args = command
	cmd.Env = os.Environ()
	cmd.Dir = "/"
	if err := applyRunAsUser(cmd, runAsUser); err != nil {
		return CommandResult{}, err
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
	stdout := &limitedBuffer{limit: maxOutputBytes}
	stderr := &limitedBuffer{limit: maxOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	started := time.Now()
	if err := cmd.Start(); err != nil {
		return CommandResult{}, err
	}
	killGroup := func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			killGroup()
		case <-done:
		}
	}()
	waitErr := waitWithDelay(cmd)
	close(done)
	killGroup()
	return finishAgentResult(ctx, started, cmd, stdout, stderr, waitErr)
}

// waitWithDelay waits for cmd, but stops waiting for its output pipes soon
// after it exited while a background process it started still holds them.
func waitWithDelay(cmd *osexec.Cmd) error {
	cmd.WaitDelay = agentSandboxWaitDelay
	err := cmd.Wait()
	if errors.Is(err, osexec.ErrWaitDelay) {
		return nil
	}
	return err
}

// finishAgentResult builds the result of a finished agent command. A command
// stopped at its deadline keeps its output, with TimedOut set and an error
// that says so.
func finishAgentResult(ctx context.Context, started time.Time, cmd *osexec.Cmd, stdout, stderr *limitedBuffer, waitErr error) (CommandResult, error) {
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	result := CommandResult{
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		ExitCode:  exitCode,
		Truncated: stdout.Truncated() || stderr.Truncated(),
	}
	if waitErr != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		result.TimedOut = true
		return result, fmt.Errorf("the command was still running after %s, its time limit, and was stopped with everything it started", time.Since(started).Round(time.Second))
	}
	return result, waitErr
}

func runAgentCommand(ctx context.Context, command, masks []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	result, started, err := runAgentCommandIn(ctx, command, masks, runAsUser, maxOutputBytes, false)
	if started {
		result.RunAs = agentRunAsName(runAsUser)
		result.Sandbox = AgentSandboxRoot
	}
	return result, err
}

func agentRunAsName(runAsUser string) string {
	if runAsUser != "" {
		return runAsUser
	}
	return processUserName()
}

// runAgentCommandIn runs the sandbox setup and the command in a new mount
// namespace; userNamespace adds a user namespace that maps only this
// process's own uid and gid, for a daemon that is not root. started is false
// when the command did not run (the sandbox could not be set up).
func runAgentCommandIn(ctx context.Context, command, masks []string, runAsUser string, maxOutputBytes int64, userNamespace bool) (result CommandResult, started bool, err error) {
	if len(command) == 0 {
		return CommandResult{}, false, fmt.Errorf("command is required")
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 128 * 1024
	}
	if runAsUser != "" {
		if _, err := resolveRunAsUser(runAsUser); err != nil {
			return CommandResult{}, false, fmt.Errorf("cannot run as user %q: %w", runAsUser, err)
		}
	}
	args := []string{agentSandboxArg, runAsUser, strconv.Itoa(len(masks))}
	args = append(args, masks...)
	args = append(args, "--")
	args = append(args, command...)
	// /proc/self/exe is this daemon's binary even after an update replaced the file.
	cmd := osexec.CommandContext(ctx, "/proc/self/exe", args...)
	cmd.Env = os.Environ()
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{
		// No PID namespace: ps looks for its own PID in the node's /proc and
		// fails inside one. The process group and the mount namespace let the
		// daemon find and end what the command left running.
		Cloneflags: syscall.CLONE_NEWNS,
		Setpgid:    true,
		Pdeathsig:  syscall.SIGKILL,
	}
	if userNamespace {
		cmd.SysProcAttr.Cloneflags |= syscall.CLONE_NEWUSER
		cmd.SysProcAttr.UidMappings = []syscall.SysProcIDMap{{ContainerID: os.Getuid(), HostID: os.Getuid(), Size: 1}}
		cmd.SysProcAttr.GidMappings = []syscall.SysProcIDMap{{ContainerID: os.Getgid(), HostID: os.Getgid(), Size: 1}}
		cmd.SysProcAttr.GidMappingsEnableSetgroups = false
		// The setup runs as the daemon's own (non-zero) uid in the namespace,
		// so exec would drop the capabilities the namespace gave it; ambient
		// CAP_SYS_ADMIN keeps the one the covers need. The setup clears it
		// before it executes the command.
		cmd.SysProcAttr.AmbientCaps = []uintptr{unix.CAP_SYS_ADMIN}
	}
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return CommandResult{}, false, fmt.Errorf("agent console sandbox: %w", err)
	}
	defer statusRead.Close()
	cmd.ExtraFiles = []*os.File{statusWrite}
	stdout := &limitedBuffer{limit: maxOutputBytes}
	stderr := &limitedBuffer{limit: maxOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	// The sandbox's mount namespace, read once the setup started: every process
	// still in it when the command ends is the command's.
	var namespace atomic.Value
	namespace.Store("")
	// On the deadline everything in the sandbox is killed, and Wait stops
	// waiting for output pipes a background process still holds soon after the
	// command itself exited.
	cmd.Cancel = func() error {
		killAgentSandboxProcesses(namespace.Load().(string))
		return cmd.Process.Kill()
	}

	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		statusWrite.Close()
		if userNamespace && (errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EACCES)) {
			return CommandResult{}, false, fmt.Errorf("%w: %v", errUserNamespaceUnavailable, err)
		}
		if errors.Is(err, syscall.EPERM) {
			return CommandResult{}, false, fmt.Errorf("agent console commands run in a sandbox that needs a daemon running as root: %w", err)
		}
		return CommandResult{}, false, fmt.Errorf("agent console sandbox could not start: %w", err)
	}
	statusWrite.Close()
	if link, err := os.Readlink("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/ns/mnt"); err == nil {
		if own, err := os.Readlink("/proc/self/ns/mnt"); err == nil && own != link {
			namespace.Store(link)
		}
	}
	// EOF once the command replaced the setup (the descriptor is close-on-exec) or the setup exited.
	status, _ := io.ReadAll(statusRead)
	waitErr := waitWithDelay(cmd)
	// Background processes the command started (`sleep 600 &`) end with it.
	killAgentSandboxProcesses(namespace.Load().(string))
	if len(status) > 0 {
		return CommandResult{}, false, fmt.Errorf("agent console sandbox could not start: %s", strings.TrimSpace(string(status)))
	}
	result, err = finishAgentResult(ctx, startedAt, cmd, stdout, stderr, waitErr)
	return result, true, err
}

// killAgentSandboxProcesses kills every process in the sandbox's mount
// namespace (namespace is its /proc/<pid>/ns/mnt link; empty does nothing).
func killAgentSandboxProcesses(namespace string) {
	if namespace == "" {
		return
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if link, err := os.Readlink("/proc/" + entry.Name() + "/ns/mnt"); err == nil && link == namespace {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// agentSandboxMaskPaths lists what the sandbox covers on this node: the
// runtime sockets and directories, those the Docker and containerd
// configuration names, the sockets daemons registered, and the runtime CLIs
// installed.
func agentSandboxMaskPaths() []string {
	paths := append([]string(nil), agentSandboxMasks...)
	paths = append(paths, registeredAgentSandboxMasks()...)
	paths = append(paths, configuredRuntimePaths()...)
	for _, dir := range agentSandboxProgramDirs {
		for _, program := range agentSandboxPrograms {
			paths = append(paths, filepath.Join(dir, program))
		}
	}
	seen := map[string]bool{}
	result := paths[:0]
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		if _, err := os.Lstat(path); err != nil {
			continue
		}
		seen[path] = true
		result = append(result, path)
	}
	return result
}

// configuredRuntimePaths reads the Docker daemon's hosts and exec-root
// (/etc/docker/daemon.json) and containerd's gRPC address
// (/etc/containerd/config.toml).
func configuredRuntimePaths() []string {
	var paths []string
	if data, err := os.ReadFile("/etc/docker/daemon.json"); err == nil {
		var config struct {
			Hosts    []string `json:"hosts"`
			ExecRoot string   `json:"exec-root"`
		}
		if json.Unmarshal(data, &config) == nil {
			for _, host := range config.Hosts {
				if strings.HasPrefix(host, "unix://") {
					paths = append(paths, strings.TrimPrefix(host, "unix://"))
				}
			}
			if strings.HasPrefix(config.ExecRoot, "/") {
				paths = append(paths, config.ExecRoot)
			}
		}
	}
	if data, err := os.ReadFile("/etc/containerd/config.toml"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			key, value, found := strings.Cut(strings.TrimSpace(line), "=")
			if !found || strings.TrimSpace(key) != "address" {
				continue
			}
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			if strings.HasPrefix(value, "/") {
				paths = append(paths, value)
			}
		}
	}
	return paths
}

// runAgentSandbox is the setup process, started in its own mount namespace.
// args are: the run-as user (may be empty), the number of masks, the masks,
// "--", the command.
func runAgentSandbox(args []string) {
	// Mount and identity calls below act on this thread; exec replaces the process from it.
	runtime.LockOSThread()
	status := os.NewFile(agentSandboxStatusFD, "agent-sandbox-status")
	fail := func(format string, values ...any) {
		if status != nil {
			fmt.Fprintf(status, format, values...)
		}
		os.Exit(127)
	}
	if status != nil {
		unix.CloseOnExec(agentSandboxStatusFD)
	}
	if len(args) == 0 {
		fail("missing sandbox arguments")
	}
	runAsUser := args[0]
	masks, command, err := parseAgentSandboxArgs(args[1:])
	if err != nil {
		fail("%v", err)
	}
	// Nothing mounted here may reach the node's own mount namespace.
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		fail("make the mounts private: %v", err)
	}
	for _, path := range masks {
		if err := maskAgentSandboxPath(path); err != nil {
			fail("cover %s: %v", path, err)
		}
	}
	// A non-root daemon's setup held CAP_SYS_ADMIN as an ambient capability for
	// the covers; the command must not keep it (it could remove them).
	if err := unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0); err != nil && !errors.Is(err, unix.EINVAL) {
		fail("drop ambient capabilities: %v", err)
	}
	env := os.Environ()
	if runAsUser != "" {
		target, err := resolveRunAsUser(runAsUser)
		if err != nil {
			fail("cannot run as user %q: %v", runAsUser, err)
		}
		if target.credential != nil {
			// syscall's identity calls apply to every thread of the process.
			if err := syscall.Setgroups([]int{}); err != nil {
				fail("set groups: %v", err)
			}
			if err := syscall.Setgid(int(target.credential.Gid)); err != nil {
				fail("set gid: %v", err)
			}
			if err := syscall.Setuid(int(target.credential.Uid)); err != nil {
				fail("set uid: %v", err)
			}
		}
		env = append(env, "HOME="+target.home, "USER="+runAsUser)
		if err := os.Chdir(target.dir); err != nil {
			fail("chdir %s: %v", target.dir, err)
		}
	}
	if os.Getenv("PATH") == "" {
		_ = os.Setenv("PATH", agentSandboxPath)
		env = append(env, "PATH="+agentSandboxPath)
	}
	program, err := osexec.LookPath(command[0])
	if err != nil {
		fail("%v", err)
	}
	err = syscall.Exec(program, command, env)
	fail("run %s: %v", command[0], err)
}

func parseAgentSandboxArgs(args []string) (masks, command []string, err error) {
	if len(args) == 0 {
		return nil, nil, errors.New("missing sandbox arguments")
	}
	count, convErr := strconv.Atoi(args[0])
	if convErr != nil || count < 0 || len(args) < count+2 || args[count+1] != "--" {
		return nil, nil, errors.New("malformed sandbox arguments")
	}
	masks = args[1 : count+1]
	command = args[count+2:]
	if len(command) == 0 {
		return nil, nil, errors.New("command is required")
	}
	return masks, command, nil
}

// maskAgentSandboxPath covers a directory with an empty read-only tmpfs and
// anything else (a socket, a program) with /dev/null, which cannot be
// connected to or executed. A path the node does not have is left alone.
func maskAgentSandboxPath(path string) error {
	// A path the command's user cannot even look up is out of its reach too.
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
		return nil
	}
	if err != nil {
		return err
	}
	info, err := os.Stat(resolved)
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return unix.Mount("tmpfs", resolved, "tmpfs", unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "mode=000,size=4k")
	}
	return unix.Mount("/dev/null", resolved, "", unix.MS_BIND, "")
}
