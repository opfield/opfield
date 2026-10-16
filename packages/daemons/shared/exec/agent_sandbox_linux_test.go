//go:build linux

package exec

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func requireRootForSandbox(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("the agent console sandbox needs a root daemon")
	}
}

func TestAgentSandboxArgs(t *testing.T) {
	masks, command, err := parseAgentSandboxArgs([]string{"2", "/a", "/b", "--", "sh", "-c", "true"})
	if err != nil || strings.Join(masks, ",") != "/a,/b" || strings.Join(command, " ") != "sh -c true" {
		t.Fatalf("parse = %v %v %v", masks, command, err)
	}
	for _, args := range [][]string{{}, {"x"}, {"1", "/a", "sh"}, {"0", "--"}, {"3", "/a", "--", "sh"}} {
		if _, _, err := parseAgentSandboxArgs(args); err == nil {
			t.Fatalf("parse %q succeeded", args)
		}
	}
}

// The sandbox runs the command as the unprivileged sandbox identity with
// no_new_privs, so it holds no capability and cannot become root again.
func TestAgentSandboxIdentity(t *testing.T) {
	requireRootForSandbox(t)
	result, err := runAgentCommand(context.Background(), []string{"sh", "-c", "id -u; id -g; grep -E '^(NoNewPrivs|CapEff):' /proc/self/status"}, nil, 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	want := strconv.Itoa(AgentSandboxUID) + "\n" + strconv.Itoa(AgentSandboxGID) + "\n"
	if !strings.HasPrefix(result.Stdout, want) {
		t.Fatalf("identity = %q, want prefix %q", result.Stdout, want)
	}
	if !strings.Contains(result.Stdout, "NoNewPrivs:\t1") || !strings.Contains(result.Stdout, "CapEff:\t0000000000000000") {
		t.Fatalf("privileges = %q", result.Stdout)
	}
}

// A runtime socket is covered however the command reaches it: by name, or
// through a process of the node's own mount namespace.
func TestAgentSandboxCoversRuntimeSockets(t *testing.T) {
	requireRootForSandbox(t)
	dir, err := os.MkdirTemp("", "agent-sandbox-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(dir, "docker.sock")
	listener, listenErr := net.Listen("unix", socketPath)
	if listenErr != nil {
		t.Fatal(listenErr)
	}
	defer listener.Close()
	// World-accessible on purpose: the cover must hold even for a socket every user may open.
	if err := os.Chmod(socketPath, 0o666); err != nil {
		t.Fatal(err)
	}
	runtimeDir := filepath.Join(dir, "containerd")
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "state"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	script := `test -S "$1" && echo socket; cat "$2/state" 2>/dev/null && echo; ls /proc/1/root/ >/dev/null 2>&1 && echo host-root; true`
	argv := []string{"sh", "-c", script, "sh", socketPath, runtimeDir}
	// Uncovered, the sandbox identity sees both: the cover, not file permissions, is what hides them below.
	result, err := runAgentCommand(context.Background(), argv, nil, 4096)
	if err != nil || strings.Fields(result.Stdout)[0] != "socket" || !strings.Contains(result.Stdout, "x") {
		t.Fatalf("uncovered run = %+v %v", result, err)
	}
	masks := []string{socketPath, runtimeDir, filepath.Join(dir, "absent.sock")}
	result, err = runAgentCommand(context.Background(), argv, masks, 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	if strings.TrimSpace(result.Stdout) != "" {
		t.Fatalf("the sandbox reached %q", result.Stdout)
	}
	// The cover is the sandbox's own: the node still has its socket.
	if info, err := os.Stat(socketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket on the node after the sandbox: %v %v", info, err)
	}
}

// The command cannot signal or trace the node's processes (a container's,
// the runtime's), still sees them for diagnostics, and what it leaves
// running ends with it.
func TestAgentSandboxProcesses(t *testing.T) {
	requireRootForSandbox(t)
	pid := strconv.Itoa(os.Getpid())
	script := "kill -0 " + pid + " 2>/dev/null && echo signalled; ls /proc/" + pid + "/root/ >/dev/null 2>&1 && echo traced; test -d /proc/" + pid + " && echo visible; sleep 30 & echo $!"
	result, err := runAgentCommand(context.Background(), []string{"sh", "-c", script}, nil, 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	lines := strings.Fields(result.Stdout)
	if len(lines) != 2 || lines[0] != "visible" {
		t.Fatalf("output = %q, want only visible and the background pid", result.Stdout)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		state, err := os.ReadFile("/proc/" + lines[1] + "/stat")
		if err != nil || strings.Contains(string(state), ") Z ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("background process %s still runs after the command", lines[1])
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestAgentSandboxReportsSetupFailure(t *testing.T) {
	requireRootForSandbox(t)
	_, err := runAgentCommand(context.Background(), []string{"opfield-no-such-program"}, nil, 4096)
	if err == nil || !strings.Contains(err.Error(), "agent console sandbox could not start") {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	result, err := runAgentCommand(ctx, []string{"sleep", "5"}, nil, 4096)
	if err == nil || result.ExitCode == 0 {
		t.Fatalf("a command past its deadline returned %+v %v", result, err)
	}
}

// A daemon that does not run as root cannot build the sandbox, so agent
// commands are refused instead of running without it.
func TestAgentSandboxRefusedWithoutRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs only as a non-root daemon")
	}
	result, err := runAgentCommand(context.Background(), []string{"id", "-u"}, nil, 4096)
	if err == nil || !strings.Contains(err.Error(), "needs a daemon running as root") || result.Stdout != "" {
		t.Fatalf("non-root run = %+v %v", result, err)
	}
}
