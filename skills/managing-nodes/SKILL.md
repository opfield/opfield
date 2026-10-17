---
name: managing-nodes
description: Enroll, inspect, and operate Opfield Nodes, the servers running Opfield daemons for nginx ingress, Docker, builder, storage and databases, monitoring, and relay. Use when asked to add a server to Opfield, check Node or daemon health, change a Node's service address, open a Node console or browse its filesystem, update daemons, or diagnose an offline or degraded Node. To create a new VM as a Node through a hosting account, use hosting-providers. For a brand-new installation, start with the instance setup in using-opfield. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Managing Nodes

Nodes are servers running an Opfield daemon that connects to the control plane over mutual-TLS gRPC (port 9443). A Node's type decides what it can run, and a Node is never silently repurposed to another type.

Start with `using-opfield` for connection, discovery, and safety rules; its instance-setup reference covers a brand-new control plane and first Nodes. Read `read_opfield_documentation({ topic: "nodes" })` (and `node-files`) before enrollment or file work: it has the current setup scripts, the manual-install fallback, and every reported health field.

## Node types

| Type | Runs |
| --- | --- |
| `nginx` | Ingress: Routes, TLS replicas, Access Lists, public traffic, Pages publication |
| `docker` | Containers, Deployments, images, volumes, networks, Compose Projects |
| `builder` | Isolated Git builds through a dedicated BuildKit and containerd profile, with no Docker socket |
| `storage` | Managed PostgreSQL, key-value stores, ClickHouse, managed SeaweedFS (and legacy MinIO), bounded backup jobs |
| `databases` | Legacy database-only profile, superseded by `storage` for new capacity |
| `monitoring` | Lightweight system metrics; no nginx or Docker required |
| `relay` | Secure Link Relay Pool worker; needs an advertised address reachable by participating hosts |

A Node's `type` decides which tools accept it (`list_nodes` and `get_node` say so in `usedFor`): Docker tools take only `docker` Nodes, Routes and Pages only `nginx` Nodes, managed databases and storage only `storage` or `databases` Nodes. `capabilities.daemonType` is the daemon build, not the role: storage, databases, and builder Nodes report `docker` there and are still not Docker Nodes.

Enroll only the roles the workload needs.

## Enroll a Node

Adding a server is an explicit infrastructure mutation; do it only on the user's request.

These steps enroll a server that already exists. To create a new server as a Node, a VM at HOSTKEY, DigitalOcean, Hetzner Cloud, or CloudBlast, or on a Proxmox host, use `hosting-providers` (`manage_hosting` `provision`): Opfield orders the VM, installs the daemon, and enrolls it, with no command to run by hand. `node_get` of `manage_hosting` shows the VM behind a hosted Node.

1. Prefer the Console flow (**Nodes > Add Node**): it shows the one-time enrollment command directly to the user, so the token never passes through chat.
2. `create_node({ type, displayName, ... })` (relay Nodes also need the advertised address) is the MCP equivalent. It returns a one-time enrollment token and the Opfield gRPC certificate fingerprint. Use it only when you will run the setup command on the target host yourself, with the user's authorization. Otherwise let the user use the Console.
3. Run the exact setup command Opfield documents for the type (`setup-<type>-node.sh` with `--opfield <host>:9443 --token ... --opfield-cert-sha256 sha256:...`, plus `--mode builder` for builders and `--storage-root <path> --yes` for unattended storage Nodes). Pass the token straight into that command; never print it, log it, store it, or repeat it. Never reconstruct a token, target, or fingerprint by hand.
4. The script installs the daemon, writes its config, starts a systemd service, and the daemon enrolls over mTLS. The token works once.
5. Poll `get_node` until the status moves from `pending` to `online`, then check the capability report (daemon version, features) before relying on the Node.

Never delete a Node record while its old daemon might still reconnect: deletion creates a new durable identity and blocks safe reconciliation. For a stuck offline Node, diagnose host power and network, system time, DNS, the daemon service, certificate identity, and outbound relay reachability before considering delete and re-enroll.

## Operate Nodes

- `list_nodes`, `get_node` (`nodes:details`); `rename_node` (`nodes:rename`); `delete_node` (`nodes:delete`).
- `manage_node_config` reads (`nodes:config:view`), updates, or tests (`nodes:manage`) the global nginx configuration. Test before update.
- `set_node_service_creation_lock` locks or unlocks creation of new services on a Node; `manage_relay_pool` manages relay Nodes.
- A Docker, database, or storage Node can set an explicit `serviceAddress` for cross-node and upstream reachability (`nodes:manage`); otherwise Opfield uses the first reported local address, then a public one.
- Daemon mTLS certificates renew automatically once a third of their lifetime remains; Opfield alerts below 30 days.
- Daemon updates come from the `maintenance` toolset (`manage_system_updates`; `read_opfield_documentation({ topic: "licensing-updates" })`). Update per `nodeId`, never "everything" at once. After an Opfield update, update the Node daemons before the Relay Pool (the pool update also recreates the local relay; current daemons reconnect to it within a second and ingress Nodes hold new Secure Link connections for up to 3 seconds). Nodes and relays that take part in a lease-mode Availability policy are sequenced by Opfield, one member per policy at a time: a queued update shows `metadata.updatePhase: waiting_for_lease_peers` with `metadata.updateWaitingFor` (see `high-availability`). Before that, an update waits up to 30 minutes for the long tasks running on the node (`waiting_for_tasks`, `metadata.updateWaitingForTasks`); `update_daemon` with `now: true` skips or ends that wait, so pass it only after the user confirmed that running tasks may fail. `metadata.lastUpdate` keeps the result of the last update: warnings, `serviceRestart` (the daemon restarted its whole service once for a newer launcher, or why not), and the connections it kept and cut.
- Restarts: a graceful Docker daemon restart is announced, so relays hold its registrations and ingress Nodes hold new connections to it for a few seconds instead of failing them; its containers keep running. The nginx daemon hands its Secure Link sockets to the next process across restarts and updates, except for the one restart that installs the new launcher after an upgrade. A daemon whose host becomes unreachable is dropped by the relays within about 3.5 seconds.
- Relays keep admitting connections on their last signed policy for the relay policy lease (72 hours by default, `relayPolicyLeaseHours` 1 to 168 in the general settings) while Opfield is down; revocations and changes need Opfield.

## Console and files

- `execute_node_console_command({ nodeId, command: ["sh", "-lc", "..."] })` runs one command on the host as root (or `console.user`) in the agent sandbox. You can repair the host with it: `systemctl`, `journalctl`, `apt`, config files, services that are not containers. Do not use the container runtime from it: the Docker, containerd and Podman sockets and the `docker`, `ctr`, `nerdctl`, `podman`, `crictl` and `runc` programs are covered, so ordinary Docker use does not work there. The sandbox is an accident guard, not a security boundary against a determined root process: root can still reach the runtime by another path (for example through `/proc`, `nsenter` or a systemd unit), and you must not try. Use the Docker tools for containers. It needs `nodes:console`, an OAuth manual-approval scope. Opfield blocks obviously catastrophic patterns; still treat every command as needing user intent. `NODE_CONSOLE_AGENT_SANDBOX_REQUIRED` means the Node's daemon must be updated first. A command runs at most `timeoutSeconds` (default 30, up to 300); at the limit the result has `timedOut: true` and the output so far. A failed command still returns `stdout`, `stderr`, `exitCode` and `error`. On a Node whose daemon does not run as root the command runs as the daemon user: `runAs` names it and `limits` says what fails without root. `df`, `du`, `findmnt`, `ls` and `stat` of `/var/lib/docker` or a runtime socket work.
- `manage_node_file` lists, reads, writes, creates, moves, and deletes files through the daemon, with chunked `upload_init`, `upload_chunk`, `upload_complete`, and `upload_abort`. Reads (`nodes:files:read`) are capped and report `truncated`; any change needs `nodes:files:write`. Both are manual-approval scopes.
- Change managed Docker objects only through the Docker tools. The agent console keeps ordinary Docker, containerd and Podman use out. A `docker`, `podman`, `nerdctl`, `ctr`, `crictl` or `runc` command or a runtime socket path is refused before it is sent: a change to an Opfield-managed object or a write under `/var/lib/docker-daemon`, `/etc/docker-daemon` or `/var/lib/docker` with `MANAGED_RESOURCE_CONSOLE_FORBIDDEN`, which names the object and the tool to use (`manage_docker_container` recreate, `remove_docker_container`, `manage_docker_deployment`, `manage_docker_compose`, `manage_docker_volume`, ...), anything else with `NODE_CONSOLE_RUNTIME_UNAVAILABLE`. Read containers with `list_docker_containers`, `get_docker_container`, `get_docker_container_logs` and `get_docker_container_stats`. `ssh_execute_command` refuses every command on a host with an Opfield Docker daemon (`SSH_MANAGED_TARGET_BLOCKED`). Do not retry with another shell form or try to leave the sandbox.
- Do not use the console to work around a type's design, such as giving a builder a Docker socket. Docker Nodes report Secure Runtime (gVisor) setup state; install it through Opfield's setup entrypoint, not the console, unless the user explicitly asks for host-level repair.

## Health

Health reports arrive every 30 seconds: CPU, memory, disk, load, swap, network, and type-specific data (nginx workers and 4xx/5xx rates; Docker container counts and stats). A disconnected Node shows its last known snapshot, and Opfield blocks mutations that would rely on unverified state.

## Verify

- After enrollment: `get_node` reports `online` with a fresh capability report.
- After a config or service-address change: re-read the Node; for nginx, the `test` passed and Routes on the Node still resolve.
- After console or file repairs: the symptom itself is gone (service running, disk freed), not only a zero exit code.

## Pitfalls

- A green connection indicator does not prove that Routes, certificates, workloads, or bindings on the Node converged after reconnect; check each resource family.
- A deleted Node record does not mean its workloads are gone: nginx, Docker, and database services may keep running independently.

Further reading: [Nodes overview](https://docs.opfield.dev/en/nodes/overview/), [Roles and installation](https://docs.opfield.dev/en/nodes/roles-and-installation/), [Updates and offline behavior](https://docs.opfield.dev/en/nodes/updates-and-offline-behavior/).
