package exec

// Agents (remote MCP clients and the in-app assistant) run one-shot node
// console commands through the "run" node exec action. Opfield manages the
// node's containers, so those commands must not reach the container runtime,
// however they are spelled: a Docker CLI, curl on the Docker API socket, ctr
// on containerd, a decoded payload piped to a shell, a script. The daemon
// therefore runs each of them in a sandbox, a process the kernel keeps away
// from the runtime:
//
//   - an unprivileged identity, AgentSandboxUID, with no_new_privs set: no
//     root, no docker group, and no setuid or file-capability program
//     (sudo, su, pkexec) can raise it again. It cannot open the runtime's
//     root-only sockets, signal or trace other users' processes (a
//     container's, the runtime's), or write system files. It can read what
//     any local user can read, plus the system logs (groups adm and
//     systemd-journal where they exist);
//   - its own mount namespace, where the runtime's sockets and state
//     directories (Docker, containerd, Podman, CRI-O, k3s) are covered, also
//     when a node made them readable to everyone;
//   - its own process group: what it leaves running is killed with it.
//
// People in the browser console get an ordinary PTY shell as before.

const (
	// AgentConsoleSandboxCapability is advertised by daemons that run agent
	// console commands in the sandbox; Opfield sends agent commands only to
	// them.
	AgentConsoleSandboxCapability = "node_console_agent_sandbox_v1"
	// AgentSandboxUID and AgentSandboxGID are the identity agent console
	// commands run as. Debian reserves 65000-65533; the ID stays inside the
	// 0-65535 range that unprivileged LXC containers map.
	AgentSandboxUID = 65530
	AgentSandboxGID = 65530

	agentSandboxArg = "__opfield_agent_console_sandbox"
	// agentSandboxStatusFD is where the sandbox setup reports a failure; a
	// successful exec closes it.
	agentSandboxStatusFD = 3
	agentSandboxPath     = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// agentSandboxMasks are the container runtime sockets and state directories
// covered inside the sandbox. Paths that do not exist on a node are skipped.
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
}

// agentSandboxLogGroups may read the system logs; the sandbox identity joins
// those that exist on the node.
var agentSandboxLogGroups = []string{"adm", "systemd-journal"}
