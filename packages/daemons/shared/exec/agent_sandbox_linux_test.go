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

func TestAgentSandboxMasksRegisteredSockets(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "custom-docker.sock")
	if err := os.WriteFile(socket, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	AddAgentSandboxMasks("unix://"+socket, "tcp://127.0.0.1:2375")
	paths := agentSandboxMaskPaths()
	found := false
	for _, path := range paths {
		if path == socket {
			found = true
		}
		if strings.HasPrefix(path, "tcp:") {
			t.Fatalf("a TCP address was taken as a path: %q", paths)
		}
	}
	if !found {
		t.Fatalf("registered socket missing from %q", paths)
	}
}

// Agents keep root for repairs: the command runs with the daemon's identity
// and its capabilities.
func TestAgentSandboxKeepsRoot(t *testing.T) {
	requireRootForSandbox(t)
	result, err := runAgentCommand(context.Background(), []string{"sh", "-c", "id -u; grep -E '^CapEff:' /proc/self/status"}, nil, "", 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	if !strings.HasPrefix(result.Stdout, "0\n") || strings.Contains(result.Stdout, "CapEff:\t0000000000000000") {
		t.Fatalf("identity = %q, want root with capabilities", result.Stdout)
	}
}

// A runtime socket, a runtime directory and a runtime CLI are covered in the
// sandbox only: the node keeps them.
func TestAgentSandboxCoversRuntime(t *testing.T) {
	requireRootForSandbox(t)
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "docker.sock")
	listener, listenErr := net.Listen("unix", socketPath)
	if listenErr != nil {
		t.Fatal(listenErr)
	}
	defer listener.Close()
	runtimeDir := filepath.Join(dir, "containerd")
	if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "state"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	program := filepath.Join(dir, "ctr")
	if err := os.WriteFile(program, []byte("#!/bin/sh\necho ran\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := `test -S "$1" && echo socket; cat "$2/state" 2>/dev/null && echo; "$3" 2>/dev/null; true`
	argv := []string{"sh", "-c", script, "sh", socketPath, runtimeDir, program}
	result, err := runAgentCommand(context.Background(), argv, nil, "", 4096)
	if err != nil || strings.Join(strings.Fields(result.Stdout), " ") != "socket x ran" {
		t.Fatalf("uncovered run = %+v %v", result, err)
	}
	masks := []string{socketPath, runtimeDir, program, filepath.Join(dir, "absent.sock")}
	result, err = runAgentCommand(context.Background(), argv, masks, "", 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	if strings.TrimSpace(result.Stdout) != "" {
		t.Fatalf("the sandbox reached %q", result.Stdout)
	}
	if info, err := os.Stat(socketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket on the node after the sandbox: %v %v", info, err)
	}
	if data, err := os.ReadFile(program); err != nil || !strings.Contains(string(data), "echo ran") {
		t.Fatalf("program on the node after the sandbox: %q %v", data, err)
	}
}

// ps works (no PID namespace), and what the command leaves running ends with
// it, also a process that left its process group.
func TestAgentSandboxProcesses(t *testing.T) {
	requireRootForSandbox(t)
	script := "ps -e >/dev/null && echo ps; setsid sleep 30 & echo $!; sleep 30 & echo $!; sleep 0.2"
	result, err := runAgentCommand(context.Background(), []string{"sh", "-c", script}, nil, "", 4096)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	lines := strings.Fields(result.Stdout)
	if len(lines) != 3 || lines[0] != "ps" {
		t.Fatalf("output = %q", result.Stdout)
	}
	for _, pid := range lines[1:] {
		deadline := time.Now().Add(2 * time.Second)
		for {
			state, err := os.ReadFile("/proc/" + pid + "/stat")
			if err != nil || strings.Contains(string(state), ") Z ") {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("background process %s still runs after the command", pid)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func TestAgentSandboxRunsAsConsoleUser(t *testing.T) {
	requireRootForSandbox(t)
	result, err := runAgentCommand(context.Background(), []string{"id", "-un"}, nil, "nobody", 4096)
	if err != nil || strings.TrimSpace(result.Stdout) != "nobody" {
		t.Fatalf("run as nobody = %+v %v", result, err)
	}
}

func TestAgentSandboxReportsSetupFailure(t *testing.T) {
	requireRootForSandbox(t)
	_, err := runAgentCommand(context.Background(), []string{"opfield-no-such-program"}, nil, "", 4096)
	if err == nil || !strings.Contains(err.Error(), "agent console sandbox could not start") {
		t.Fatalf("err = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	result, err := runAgentCommand(ctx, []string{"sh", "-c", "echo before; sleep 5"}, nil, "", 4096)
	if err == nil || !result.TimedOut || !strings.Contains(err.Error(), "time limit") {
		t.Fatalf("a command past its deadline returned %+v %v", result, err)
	}
	if strings.TrimSpace(result.Stdout) != "before" {
		t.Fatalf("the output written before the time limit was lost: %+v", result)
	}
}

// A daemon that does not run as root runs agent commands as its own user,
// says so, and keeps them away from a runtime socket that user can reach.
func TestAgentCommandWithoutRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("runs only as a non-root daemon")
	}
	result, err := RunAgentCommand(context.Background(), []string{"id", "-u"}, "", 4096)
	if err != nil {
		t.Fatalf("non-root run = %+v %v", result, err)
	}
	if strings.TrimSpace(result.Stdout) != strconv.Itoa(os.Getuid()) || result.RunAs == "" || result.Limits == "" {
		t.Fatalf("non-root run = %+v", result)
	}
	if result.Sandbox != AgentSandboxDaemonUser && result.Sandbox != AgentSandboxUserNamespace {
		t.Fatalf("sandbox = %q", result.Sandbox)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	result, err = runDaemonUserCommand(ctx, []string{"sh", "-c", "echo before; sleep 5"}, "", 4096)
	if err == nil || !result.TimedOut || strings.TrimSpace(result.Stdout) != "before" {
		t.Fatalf("a daemon-user command past its deadline returned %+v %v", result, err)
	}

	// A socket this user can connect to (as if it were in the docker group).
	dir := t.TempDir()
	socket := filepath.Join(dir, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if got := reachableRuntimeSockets([]string{socket, dir, filepath.Join(dir, "missing.sock")}); len(got) != 1 {
		t.Fatalf("reachable = %q, want the one socket", got)
	}
	result, err = runUnprivilegedAgentCommand(context.Background(), []string{"sh", "-c", "test -S " + socket + " && echo reached; id -u; grep -E '^Cap(Eff|Amb):' /proc/self/status"}, []string{socket}, "", 4096)
	if err != nil {
		if !strings.Contains(err.Error(), "unprivileged user namespaces") || !strings.Contains(err.Error(), socket) {
			t.Fatalf("refusal = %v", err)
		}
		t.Logf("this host has no unprivileged user namespaces: %v", err)
		return
	}
	want := strconv.Itoa(os.Getuid()) + "\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000"
	if result.Sandbox != AgentSandboxUserNamespace || strings.TrimSpace(result.Stdout) != want {
		t.Fatalf("user-namespace run = %+v, want only the uid and no capabilities", result)
	}
}

// On a node with Docker, the masks this node gets keep every spelling away
// from the runtime while root stays root.
func TestAgentSandboxOnDockerNode(t *testing.T) {
	requireRootForSandbox(t)
	if _, err := os.Stat("/var/run/docker.sock"); err != nil {
		t.Skip("no Docker on this host")
	}
	script := `id -u
curl -s --max-time 3 --unix-socket /var/run/docker.sock http://localhost/_ping && echo api-reached
echo ZG9ja2VyIHBzIC1x | base64 -d | sh >/dev/null 2>&1 && echo cli-reached
ctr version >/dev/null 2>&1 && echo ctr-reached
test -S /run/containerd/containerd.sock && echo containerd-reached
true`
	result, err := RunAgentCommand(context.Background(), []string{"sh", "-c", script}, "", 8192)
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, result)
	}
	if strings.TrimSpace(result.Stdout) != "0" {
		t.Fatalf("output = %q, want only uid 0", result.Stdout)
	}
}

// explore O-2 (rc.3): systemctl had no system bus in the sandbox. The sandbox
// covers only the container runtime, so root reaches systemd.
func TestAgentSandboxReachesSystemd(t *testing.T) {
	requireRootForSandbox(t)
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		t.Skip("no systemd on this host")
	}
	result, err := runAgentCommand(context.Background(), []string{"systemctl", "show", "--property=Version"}, nil, "", 4096)
	if err != nil || !strings.HasPrefix(result.Stdout, "Version=") {
		t.Fatalf("systemctl in the sandbox = %+v %v", result, err)
	}
}
