package exec

import (
	"strings"
	"sync"
)

// Agents (remote MCP clients and the in-app assistant) run one-shot node
// console commands through the "run" node exec action. They keep root, so
// they can repair a node or a failed service (systemctl, apt, journalctl,
// config files), but Opfield manages the node's containers, so their
// commands must not reach the container runtime by accident. The daemon runs
// each of them in the agent sandbox:
//
//   - its own mount namespace, where the container runtime's sockets and
//     runtime directories (Docker, containerd, Podman, CRI-O, k3s, the
//     socket the Docker daemon is configured with) are covered by /dev/null
//     or an empty read-only directory, and the runtime CLIs (docker, ctr,
//     nerdctl, podman, crictl, ...) by /dev/null, so they cannot run;
//   - its own process group: what it leaves running is killed with it.
//
// This is an accident guard, not a security boundary: the command runs as
// root and could leave the namespace on purpose (nsenter into PID 1's
// namespaces, unmounting a cover, starting a systemd unit, cron). It stops an
// agent from changing containers by mistake or by working around a refusal
// with another spelling (curl on the API socket, ctr, a decoded payload).
//
// People in the browser console get an ordinary PTY shell as before.

const (
	// AgentConsoleSandboxCapability is advertised by daemons that run agent
	// console commands in the sandbox; Opfield sends agent commands only to
	// them.
	AgentConsoleSandboxCapability = "node_console_agent_sandbox_v1"

	agentSandboxArg = "__opfield_agent_console_sandbox"
	// agentSandboxStatusFD is where the sandbox setup reports a failure; a
	// successful exec closes it.
	agentSandboxStatusFD = 3
	agentSandboxPath     = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// agentSandboxMasks are the container runtime sockets and runtime
// directories covered inside the sandbox. Paths a node does not have are
// skipped.
var agentSandboxMasks = []string{
	"/run/docker.sock",
	"/var/run/docker.sock",
	"/run/docker",
	"/var/run/docker",
	"/run/containerd",
	"/var/run/containerd",
	"/run/podman",
	"/var/run/podman",
	"/run/crio",
	"/var/run/crio",
	"/run/k3s",
	"/var/run/k3s",
	"/run/dockershim.sock",
	"/run/cri-dockerd.sock",
}

// agentSandboxPrograms are the container runtime CLIs covered inside the
// sandbox, wherever they are installed in agentSandboxProgramDirs.
var agentSandboxPrograms = []string{
	"docker",
	"dockerd",
	"docker-compose",
	"com.docker.cli",
	"ctr",
	"containerd-ctr",
	"nerdctl",
	"podman",
	"podman-remote",
	"podman-compose",
	"crictl",
	"runc",
	"crun",
}

var agentSandboxProgramDirs = []string{
	"/usr/local/sbin",
	"/usr/local/bin",
	"/usr/sbin",
	"/usr/bin",
	"/sbin",
	"/bin",
	"/snap/bin",
	"/usr/libexec/docker/cli-plugins",
	"/usr/local/lib/docker/cli-plugins",
}

var (
	extraMasksMu sync.Mutex
	extraMasks   []string
)

// AddAgentSandboxMasks covers more runtime paths in the sandbox, such as the
// socket a daemon is configured to reach Docker on ("unix:///path" or a
// path; other addresses are ignored).
func AddAgentSandboxMasks(paths ...string) {
	extraMasksMu.Lock()
	defer extraMasksMu.Unlock()
	for _, path := range paths {
		path = strings.TrimPrefix(path, "unix://")
		if strings.HasPrefix(path, "/") {
			extraMasks = append(extraMasks, path)
		}
	}
}

func registeredAgentSandboxMasks() []string {
	extraMasksMu.Lock()
	defer extraMasksMu.Unlock()
	return append([]string(nil), extraMasks...)
}
