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
// one is configured. It needs a root daemon (a mount namespace); without one,
// or when a runtime path cannot be covered, the command does not run and the
// error says why.
func RunAgentCommand(ctx context.Context, command []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	return runAgentCommand(ctx, command, agentSandboxMaskPaths(), runAsUser, maxOutputBytes)
}

func runAgentCommand(ctx context.Context, command, masks []string, runAsUser string, maxOutputBytes int64) (CommandResult, error) {
	if len(command) == 0 {
		return CommandResult{}, fmt.Errorf("command is required")
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 128 * 1024
	}
	if runAsUser != "" {
		if _, err := resolveRunAsUser(runAsUser); err != nil {
			return CommandResult{}, fmt.Errorf("cannot run as user %q: %w", runAsUser, err)
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
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return CommandResult{}, fmt.Errorf("agent console sandbox: %w", err)
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
	cmd.WaitDelay = agentSandboxWaitDelay

	if err := cmd.Start(); err != nil {
		statusWrite.Close()
		if errors.Is(err, syscall.EPERM) {
			return CommandResult{}, fmt.Errorf("agent console commands run in a sandbox that needs a daemon running as root: %w", err)
		}
		return CommandResult{}, fmt.Errorf("agent console sandbox could not start: %w", err)
	}
	statusWrite.Close()
	if link, err := os.Readlink("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/ns/mnt"); err == nil {
		if own, err := os.Readlink("/proc/self/ns/mnt"); err == nil && own != link {
			namespace.Store(link)
		}
	}
	// EOF once the command replaced the setup (the descriptor is close-on-exec) or the setup exited.
	status, _ := io.ReadAll(statusRead)
	waitErr := cmd.Wait()
	// Background processes the command started (`sleep 600 &`) end with it.
	killAgentSandboxProcesses(namespace.Load().(string))
	if errors.Is(waitErr, osexec.ErrWaitDelay) {
		waitErr = nil
	}
	if len(status) > 0 {
		return CommandResult{}, fmt.Errorf("agent console sandbox could not start: %s", strings.TrimSpace(string(status)))
	}
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
	return result, waitErr
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
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	info, err := os.Stat(resolved)
	if errors.Is(err, os.ErrNotExist) {
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
