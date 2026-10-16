//go:build linux

package exec

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// agentSandboxWaitDelay is how long the output of a finished command is still
// read while a background process it started holds the pipes.
const agentSandboxWaitDelay = 500 * time.Millisecond

// A daemon binary started with agentSandboxArg is the sandbox setup of one
// agent command (see RunAgentCommand): it covers the runtime paths, drops to
// the sandbox identity and executes the command. It never returns to the
// daemon's own start-up.
func init() {
	if len(os.Args) > 1 && os.Args[1] == agentSandboxArg {
		runAgentSandbox(os.Args[2:])
	}
}

// AgentSandboxSupported reports whether this build can run agent commands in
// the sandbox.
func AgentSandboxSupported() bool { return true }

// RunAgentCommand runs an agent's one-shot console command in the sandbox
// described in agent_sandbox.go. It needs a root daemon (namespaces and the
// identity switch); without one, or when a runtime path cannot be covered,
// the command does not run and the error says why.
func RunAgentCommand(ctx context.Context, command []string, maxOutputBytes int64) (CommandResult, error) {
	return runAgentCommand(ctx, command, agentSandboxMasks, maxOutputBytes)
}

func runAgentCommand(ctx context.Context, command []string, masks []string, maxOutputBytes int64) (CommandResult, error) {
	if len(command) == 0 {
		return CommandResult{}, fmt.Errorf("command is required")
	}
	if maxOutputBytes <= 0 {
		maxOutputBytes = 128 * 1024
	}
	args := []string{agentSandboxArg, strconv.Itoa(len(masks))}
	args = append(args, masks...)
	args = append(args, "--")
	args = append(args, command...)
	// /proc/self/exe is this daemon's binary even after an update replaced the file.
	cmd := osexec.CommandContext(ctx, "/proc/self/exe", args...)
	cmd.Env = []string{"PATH=" + agentSandboxPath}
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{
		// A PID namespace would hide nothing the identity does not already
		// keep away and would break ps, which looks for its own PID in the
		// node's /proc; the process group lets the daemon end what the
		// command left running.
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

	// On the deadline the whole group is killed, and Wait stops waiting for
	// output pipes a background process still holds soon after the command
	// itself exited.
	cmd.Cancel = func() error {
		killAgentSandboxGroup(cmd.Process.Pid)
		return nil
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
	// EOF once the command replaced the setup (the descriptor is close-on-exec) or the setup exited.
	status, _ := io.ReadAll(statusRead)
	waitErr := cmd.Wait()
	// Background processes the command started (`sleep 600 &`) end with it.
	killAgentSandboxGroup(cmd.Process.Pid)
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

// killAgentSandboxGroup kills the processes left in a command's process
// group. Only processes of the sandbox identity are touched: the group's
// leader is reaped by then, and its number could in principle belong to
// another group already.
func killAgentSandboxGroup(pgid int) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		info, err := os.Stat("/proc/" + entry.Name())
		if err != nil {
			continue
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != AgentSandboxUID {
			continue
		}
		if processGroup(pid) == pgid {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// processGroup reads a process's group from /proc/<pid>/stat, or -1.
func processGroup(pid int) int {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return -1
	}
	// The command name in parentheses may contain spaces; the fields after it are fixed.
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return -1
	}
	fields := strings.Fields(string(data[end+1:]))
	// state, ppid, pgrp
	if len(fields) < 3 {
		return -1
	}
	pgrp, err := strconv.Atoi(fields[2])
	if err != nil {
		return -1
	}
	return pgrp
}

// runAgentSandbox is the setup process, started in its own mount namespace.
// args are: the number of masks, the masks, "--", the command.
func runAgentSandbox(args []string) {
	// Namespace and identity calls below act on this thread; exec replaces the process from it.
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
	masks, command, err := parseAgentSandboxArgs(args)
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
	groups := agentSandboxGroups()
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("set no_new_privs: %v", err)
	}
	// syscall's identity calls apply to every thread of the process.
	if err := syscall.Setgroups(groups); err != nil {
		fail("set groups: %v", err)
	}
	if err := syscall.Setgid(AgentSandboxGID); err != nil {
		fail("set gid %d: %v", AgentSandboxGID, err)
	}
	if err := syscall.Setuid(AgentSandboxUID); err != nil {
		fail("set uid %d: %v", AgentSandboxUID, err)
	}
	if os.Geteuid() != AgentSandboxUID || os.Getegid() != AgentSandboxGID {
		fail("the identity did not change")
	}
	env := []string{"PATH=" + agentSandboxPath, "HOME=/tmp", "LANG=C.UTF-8", "USER=opfield-agent", "LOGNAME=opfield-agent"}
	if err := os.Setenv("PATH", agentSandboxPath); err != nil {
		fail("set PATH: %v", err)
	}
	program, err := osexec.LookPath(command[0])
	if err != nil {
		fail("%v", err)
	}
	if err := os.Chdir("/"); err != nil {
		fail("chdir /: %v", err)
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
// anything else (a socket) with /dev/null. A path the node does not have is
// left alone.
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

// agentSandboxGroups are the log reader groups the node has.
func agentSandboxGroups() []int {
	var groups []int
	for _, name := range agentSandboxLogGroups {
		group, err := user.LookupGroup(name)
		if err != nil {
			continue
		}
		gid, err := strconv.Atoi(group.Gid)
		if err != nil || gid == 0 {
			continue
		}
		groups = append(groups, gid)
	}
	if groups == nil {
		groups = []int{}
	}
	return groups
}
