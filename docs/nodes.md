# Nodes And Daemons

[Back to README](../README.md)

Opfield manages infrastructure hosts through small Go daemons. Each daemon connects outbound to the Opfield control plane over gRPC with mTLS.

## Daemon Types

| Type | Daemon | Purpose |
|------|--------|---------|
| nginx | `nginx-daemon` | Public ingress, routes, TLS termination, access lists, configuration, logs, and stats for host-native nginx. |
| docker | `docker-daemon` | Docker containers, deployments, cross-node migrations, portable and registry-backed `.gwca` archives, images, volumes, networks, tasks, files, consoles, registries, and offline inventory snapshots. |
| builder | `docker-daemon` (`builder` profile) | Build Worker: builds Git revisions and scans artifacts on an isolated Docker worker; application workloads and managed databases are rejected. |
| storage | `docker-daemon` (`storage` profile) | Managed Postgres, key-value stores, ClickHouse, SeaweedFS object storage (legacy MinIO clusters keep running), and native backup jobs; generic workloads are rejected. |
| monitoring | `monitoring-daemon` | Metrics-only host monitoring without nginx or Docker control. |
| relay | `relay-supervisor` and relay worker | Adds a physical host to the Relay Pool; see [Relay Nodes](#relay-nodes). |

The console labels these node types **Ingress**, **Docker**, **Build Worker**, **Storage**, **Monitoring**, and **Relay**.

Use a monitoring node when you want host metrics but do not want to grant Opfield ingress or Docker management on that host.

Existing `databases` nodes are shown as Storage nodes and are compatible with the Storage profile. Updating their daemon enables the unified capabilities without changing their identity, enrollment, or database storage root. Older daemons remain limited to the capabilities they advertise.

Every node counts toward the plan's managed-node limit, whatever its type and including nodes still pending enrollment. Community allows 25 managed nodes; paid plans have no plan quota. The limit is checked when a node is created, so existing nodes above it keep working.

## Host Resource Sizing

Opfield daemons have a small resource footprint compared with the services they manage, so they do not have separate CPU, memory, or disk requirements. Size each host for its operating system and actual workload:

- nginx nodes for nginx traffic, TLS termination, and log volume;
- Docker nodes for the containers and deployments running on them, plus their images: each container keeps the image it runs and one older version by default (see [Docker Image Cleanup](operations.md#docker-image-cleanup)), and the built-in alerts **Node disk almost full** and **Node disk full** fire at 85% and 95% use of any data disk of the node (the root disk, Docker's data disk or another attached disk);
- Storage nodes for the CPU, memory, swap, and storage allocated to managed databases, object storage, and backup jobs;
- monitoring nodes according to the existing host workload being observed.

## Quick Setup

1. Open Opfield.
2. Go to **Nodes > Add Node**.
3. Choose the node type.
4. Create the node.
5. Copy the setup command from the dialog.
6. Run it on the target host.

The command in the dialog belongs to the Opfield installation that shows it. It downloads the installer from that Opfield version's GitHub release, runs it only after `sha256sum` matches the release's `opfield-node-installers.sha256`, and pins with `--version` the newest daemon release of the same minor version (a relay gets the release its Relay Pool runs). A development build without a release version runs the installer from the `main` branch instead. The AI assistant and MCP tools return the same commands as `installCommands`.

The commands below install from the latest stable release. To match an older Opfield version, replace `latest/download` with `download/<opfield-version>`, for example `download/v2.11.0`.

Universal setup command:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-daemon.sh | \
  sudo bash -s -- --type nginx --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
```

> [!IMPORTANT]
> Daemons must reach the public Opfield relay endpoint directly on `9443/tcp`; the app-side gRPC listener is internal. During Opfield browser setup, select the direct public gRPC host or IP that should appear in enrollment commands; an optional local gRPC IP can be selected for nodes on the same private network. If the address changes later, update it in **Settings > General > Access and limits** and generate a fresh node command instead of maintaining a manual edit workflow.

The wrapper downloads the daemon-specific installer from the same release, checks it against the release's checksums, and forwards all other arguments. Its own `--version` selects the release the installers come from, not the daemon version; to pin the daemon version, set `OPFIELD_NODE_DAEMON_VERSION`, or use the daemon-specific installer with `--version`.

## Daemon-Specific Setup

Nginx node:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-node.sh | \
  sudo bash -s -- --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
```

Docker node:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-docker-node.sh | \
  sudo bash -s -- --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
```

**Alpine, OpenRC and LXC requirements.** Docker nodes need Docker to be able to give its containers the `memory`, `pids` and `cpu` cgroup controllers, because the Secure Link connector and managed workloads run with memory, CPU and pids limits. The installer checks this after Docker is present and refuses to enroll the node when a controller is missing. On an LXC guest running Alpine with OpenRC the root cgroup can have no controllers enabled: `cat /sys/fs/cgroup/cgroup.subtree_control` is empty, and OpenRC's `cgroups` service reports `Resource busy` because every process sits in the root cgroup. Docker and plain containers still start there, but a container with limits fails with `pids.max: no such file or directory`. The host cgroup setup has to enable the controllers before the node is installed; verify with `cat /sys/fs/cgroup/cgroup.subtree_control /sys/fs/cgroup/docker/cgroup.controllers`, which must list `memory`, `pids` and `cpu`. The installer does not change the host's cgroup setup. On an Alpine LXC guest, let OpenRC's `cgroups` service move the processes out of the root cgroup before it enables the controllers: run `rc-update add cgroups boot`, put the following into `/etc/conf.d/cgroups`, and reboot the guest:

```sh
# Move every process out of the root cgroup so that the cgroups service can pass the controllers down.
start_pre() {
	[ -w /sys/fs/cgroup/cgroup.subtree_control ] || return 0
	mkdir -p /sys/fs/cgroup/init
	for pid in $(cat /sys/fs/cgroup/cgroup.procs); do
		echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null
	done
	return 0
}
```

No change to the Proxmox container configuration is needed for this.

A Build Worker uses the same Docker installer with `--mode builder`.

**Build Worker priority.** Queued builds go to Build Workers in the order they appear in the Nodes list. The first online worker takes builds until all its parallel slots (Build Worker settings, parallelism) are busy, then the next one does, and so on. To make a worker preferred, drag it higher in the list; to keep one as overflow only, drag it to the bottom. The list order is:
- top-level folders by their position;
- inside a folder, its subfolders first, then its nodes;
- nodes outside any folder last.

A worker only takes builds for its platform (architecture).

Storage node:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-storage-node.sh | \
  sudo bash -s -- --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
```

See [Storage nodes, external storage and database backups](storage-and-backups.md) for what runs on a Storage node.

Monitoring node:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-monitoring-node.sh | \
  sudo bash -s -- --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
```

## Docker Secure Runtime

Opfield offers two workload isolation profiles:

| Profile | Docker runtime | Intended use |
|---------|----------------|--------------|
| **Default** | `runc` | Standard Docker compatibility and GPU/device support. |
| **Secure** | gVisor `runsc` | A stronger host-isolation boundary for compatible CPU-only workloads. |

The Default profile is available in every plan. The Secure profile is available in Business and Enterprise; see [Plans and licensing](licensing.md).

Secure Runtime is an additional defense layer, not a virtual machine and not a replacement for permissions, audit logging, network controls, or application security. Because gVisor implements a userspace kernel boundary, applications that depend on uncommon Linux syscalls or direct device access may require the Default profile.

### Setup and compatibility

A fresh generic Docker-node installation runs a Secure Runtime preflight before enrollment and attempts installation when the host is compatible. Secure Runtime is optional: on a host that does not support it, or where its setup fails, the installer warns with the reason, asks nothing, and continues; the node reports the same reason in its capabilities. With `--secure-runtime` the installation fails with that reason instead. Existing installations are not modified during upgrade: a user with `nodes:manage` on the node (broad `admin:update` is still accepted for one more release) can open **Node Details > Secure Runtime Setup** to run the persisted preflight and installation workflow with step and download progress.

The same operations are available locally:

```bash
sudo docker-daemon runtime preflight runsc
sudo docker-daemon runtime install runsc
```

Both commands accept `--json` or `--plain`, plus `--non-interactive` and `--silent` for installers. Preflight exits with `0` when healthy, `10` when installable, `20` when unsupported, and `30` for other failures; an install that did not install never exits `0`.

On a node whose daemon runs as its own user, `docker-daemon` runs as that user even under `sudo`, so `runtime install` cannot install there. Re-run the Docker node installer with `--secure-runtime` and the same `--user` instead (Node Details shows the full command, which downloads and checks this release's installer first): `sudo bash setup-docker-node.sh --user <user> --secure-runtime`. The installer installs Secure Runtime from a copy of the daemon binary it downloads and verifies itself, never from the user's binary, and fails when Secure Runtime cannot be installed. `--secure-runtime` also installs it on an existing root node.

Secure Runtime requires:

- Linux on `amd64` or `arm64`;
- a daemon connected to the local Docker Engine rather than a remote Docker host;
- the Docker CLI and a Docker service that the installer can restart;
- root privileges for installation.

Installation registers `runsc` in `/etc/docker/daemon.json` and restarts Docker. In an existing file only `runtimes.runsc` is added or updated; every other key and value stays exactly as written, and the original file is saved once as `/etc/docker/daemon.json.opfield-backup` before the first change (nodes set up before Opfield 2.12.1 keep the backup they made then). A file that already registers this `runsc` is not rewritten.

KVM is not required. A compatible LXC guest can use Secure Runtime when nested Docker, service management, and the required host capabilities are available; LXC compatibility is therefore host-configuration dependent rather than universal.

Opfield advertises Secure as available only after `runsc` is installed, configured in Docker, and passes consecutive Docker smoke tests. Secure workload creation fails closed while that status is unknown, unhealthy, installing, or unsupported.

### Workload boundaries

- Secure workloads cannot attach GPUs or host devices.
- Secure workloads cannot use host bind mounts. New or changed mounts use Opfield-managed local volumes in both profiles.
- Secure standalone containers and deployments cannot migrate between nodes in the current version.
- Secure standalone containers cannot be exported as `.gwca` archives because custom runtimes are outside the portable archive contract.
- Changing a saved workload between Default and Secure uses the normal recreate flow.
- All newly created Opfield workloads, including the Default profile, are non-privileged, add no Linux capabilities, and receive `no-new-privileges`.

## Docker GPU Workloads

Opfield can attach one or more discovered physical GPUs to a standalone Docker container or a blue/green deployment. The selection is node-local and uses stable device IDs; Opfield never accepts a browser-supplied host path or runtime ID.

### Host prerequisites

GPU support is opt-in host preparation. Opfield discovers and validates the resulting host state, but never installs a driver, a container runtime, or a vendor userspace stack.

- **NVIDIA:** install a working NVIDIA driver so `nvidia-smi` can query the card, then configure NVIDIA Container Toolkit with Docker so Docker reports an `nvidia` runtime. Opfield marks the device unavailable until both checks pass.
- **AMD:** the Linux driver must expose both `/dev/kfd` and the GPU's `/dev/dri/renderD*` node. Opfield maps only those daemon-discovered paths; an image still needs the ROCm or other userspace it requires.
- **Intel:** the Linux driver must expose the GPU's `/dev/dri/renderD*` node. `intel_gpu_top` is optional and only enriches utilization telemetry; the workload image still needs its own oneAPI, media, or other userspace dependencies where applicable.

The GPU must appear as attachable on the node before it can be selected. A device in NVIDIA MIG/partitioned mode, NVIDIA exclusive compute mode, or another unsupported virtualized/partitioned mode remains visible but cannot be attached.

### Shared-device and portability boundaries

- Physical GPU selections are shared: Opfield does not reserve VRAM, enforce quotas, schedule workloads, or calculate per-container GPU usage. Multiple containers may select the same attachable device.
- GPU changes use the normal recreate path. Duplicating a container preserves its GPU selection. A blue/green deployment gives the same selection to both application slots; the router never receives a GPU mapping.
- Node monitoring and GPU alerts use only device metrics that the daemon explicitly reports. A container's monitoring panel repeats that physical shared-device telemetry and does not claim it belongs only to that container.
- Opfield does not manage MIG, vGPU, SR-IOV, mediated devices, exclusive GPU allocation, or host driver/runtime installation. Existing unrecognized manual GPU mappings stay read-only so Opfield does not rewrite arbitrary host devices.
- GPU-attached containers and deployments cannot migrate between nodes in v1. GPU-attached standalone containers also cannot be exported as `.gwca` archives. Detach the GPU and recreate the workload before using those portability workflows.

## Lease Watchdog

Docker Availability runs failover in the data plane once a policy is in lease mode (see [Data-Plane Failover](capabilities.md#data-plane-failover-lease-mode)). There, a node that loses its lease must stop its copy of the workload even if the Docker daemon or `dockerd` hangs. The lease watchdog enforces that: `opfield-lease-watchdog` is a separate service on every general Docker node (installer mode `docker`; Build Workers and Storage nodes do not need it).

- **What it does.** The Docker daemon writes a deadline record for every lease-mode container to a tmpfs directory, `/run/opfield-lease-watchdog`. The watchdog checks those records four times a second and, once a container's lease deadline has passed, kills every process in that container's cgroup without going through the Docker daemon or `dockerd`. It keeps doing so on every pass, so a late start of that container dies too. It stops only containers that have such a record, opens no network listener, and runs as root because it must kill container processes of any user.
- **Heartbeat.** The watchdog writes a heartbeat every second. A Docker daemon whose watchdog heartbeat is older than 3 seconds does not acquire a lease or start a lease-mode container; when it is older than 10 seconds the daemon treats the watchdog as gone, stops its lease-mode copies, releases their slots, and reports the node as `watchdog_missing`.
- **Independent of the daemon.** It has its own binary (`/usr/local/bin/opfield-lease-watchdog`), its own systemd unit or OpenRC service (`opfield-lease-watchdog`), and its own release line (`vX.Y.Z-watchdog`), so updating, downgrading, or removing the Docker daemon never disarms it. Records stay enforced while no lease-aware Docker daemon runs and are removed only after 10 minutes without any sign of one, for example after a rollback to a daemon without leases.
- **Installation.** The Docker node installer downloads it, verifies its checksum, and starts it in `docker` mode; `OPFIELD_LEASE_WATCHDOG_VERSION` pins a release instead of the latest one. If no release can be downloaded or no service manager is found, the installer warns and the node simply stays out of lease mode. On nodes installed before the watchdog existed, a 2.11 Docker daemon installs it by itself when it runs as root and finds systemd or OpenRC, and no watchdog binary, service file, or heartbeat is present yet; it verifies the signed release manifest first and retries with backoff if that fails. The daemon never updates, stops, or replaces an existing watchdog.
- **Updates.** The watchdog checks for a newer release of its own line about every 6 hours (with jitter), verifies it, and never moves to an older release or from `stable` to a release candidate. A Docker daemon running as root keeps the watchdog on the daemon's own channel (`preview` for a release-candidate daemon, otherwise `stable`).
- **Non-root nodes.** A Docker daemon installed with `--user <non-root user>`, or one on a host without systemd or OpenRC, cannot install the watchdog itself. It reports that, and Availability lists the node under **Excluded nodes** (`lease.excludedNodes`) with `watchdog_missing`; when all nodes that would hold the workload have this problem, the policy's lease reason is `watchdog_missing` too. Re-run the Docker node installer on the host with `sudo`: an enrolled node needs no new token, and the installer installs the watchdog as a root service for the daemon's user. Pass the same `--user <non-root user>` again, because a non-interactive run otherwise rewrites the daemon service to run as root.

To check a node, run `sudo opfield-lease-watchdog status`: it prints whether the heartbeat is fresh and every deadline record with its policy, slot, and remaining time. `systemctl status opfield-lease-watchdog` (or `rc-service opfield-lease-watchdog status`) shows the service. An excluded node gets no new standby and takes no slot until the watchdog runs again; a holder whose watchdog stops running ends its own copy, and the next candidate takes over.

## Installer Options

Common daemon setup options:

| Option | Purpose |
|--------|---------|
| `--opfield <host:port>` | Opfield gRPC address. |
| `--token <token>` | One-time enrollment token generated by Opfield. |
| `--opfield-cert-sha256 <sha256:hex>` | Opfield gRPC TLS leaf certificate fingerprint generated with the token. Required for first enrollment. |
| `--host <host>` / `--port <port>` | Alternative to `--opfield` when specifying the Opfield address in separate parts. |
| `--version <tag>` | Install a specific daemon version (default: the latest stable daemon release, but never older than the installed daemon; see below). |
| `--user <username>` | Run nginx, Docker, or monitoring daemons as a specific user (see [Running Daemons Without Root](#running-daemons-without-root)). Storage nodes (including legacy database nodes) accept only `--user root`. |
| `--mode <profile>` | Docker installer only: `docker` (default), `builder`, or `storage`; `databases` is accepted as a legacy alias of the Storage profile. |
| `--builder-egress <profile>` | Docker installer with `--mode builder` only: `internet` (default) permits public dependency downloads while blocking metadata, private, and control-plane ranges; `offline` disables build-step egress. |
| `--secure-runtime` | Docker installer, `docker` profile only: install [Secure Runtime](#setup-and-compatibility) on an existing install too, and fail when it cannot. A fresh install sets it up anyway. |
| `--nginx-mode <mode>` / `--skip-nginx` | Nginx installer only: `managed` or `integrate` (see [Nginx Node Modes](#nginx-node-modes)); `--skip-nginx` reuses an installed nginx 1.25.1 or newer. |
| `--disable-console` / `--disable-files` | Turn the host console or host file access off on this node (writes `console.enabled: false` / `files.enabled: false`, see [Host Console And File Access](#host-console-and-file-access)). Environment: `OPFIELD_NODE_DISABLE_CONSOLE=1`, `OPFIELD_NODE_DISABLE_FILES=1`. |
| `--protected` | Relay installer only: install the relay in [protected mode](#protected-relays) (writes `protected.enabled: true`). Environment: `OPFIELD_RELAY_PROTECTED=1`. |
| `--dry-run` | Validate inputs and show the plan without changing the host. |
| `-y`, `--yes` | Non-interactive mode. An installation that is declined at "Proceed with installation?" or stopped after the summary exits with a non-zero code. Without it the installer asks on the terminal and stops when it cannot read an answer (no terminal, or `sudo` with its output piped through `tee`), instead of using the defaults. |
| `--help` | Show all supported options. |

A re-run without `--version` (and without `OPFIELD_NODE_DAEMON_VERSION`) never installs an older daemon than the one installed, for example when the node runs a newer pre-release than the stable release `latest` resolves to. The installer then prints the installed version and the release `latest` resolves to, keeps the installed version, and continues; to install the older release, name it with `--version`. The Docker (including the Build Worker and Storage profiles), nginx, monitoring, and relay installers all behave this way.

Every option also has an environment variable (`OPFIELD_NODE_ADDRESS`, `OPFIELD_NODE_TOKEN`, `OPFIELD_DOCKER_MODE`, and so on; `--help` lists them). `OPFIELD_LEASE_WATCHDOG_VERSION` pins the [lease watchdog](#lease-watchdog) release that the Docker installer installs in `docker` mode (default: the latest release).

The installers verify downloaded daemon binaries with SHA256 checksums and back up existing binaries during upgrades.

## Running Daemons Without Root

The monitoring, Docker (`docker` profile), nginx, and relay daemons can run as an existing non-root user: `--user <username>` for the monitoring, Docker, and nginx installers, and `OPFIELD_RELAY_RUN_USER` (optionally `OPFIELD_RELAY_RUN_GROUP`) for the relay installer. The installer itself still runs with `sudo`. The Storage profile (including legacy database nodes) and the builder profile run only as root; their installers stop with an error for any other user.

In non-root mode every installer:

- stops before changing the host when the user does not exist; the service group defaults to the user's primary group;
- gives the user the daemon's configuration, state, and library directories, and writes the configuration as that user;
- installs the daemon binary in `/usr/local/lib/<daemon>/bin`, owned by the user, so the daemon can update itself (for the relay: `/usr/local/lib/opfield-relay/bin/relay-supervisor`). `/usr/local/bin/<daemon>` is a root-owned wrapper that runs it; called as root (for example with `sudo`), the wrapper switches to the user first, so root never runs a binary that user can replace. The installers run their root-only steps from a root-owned copy;
- gives the daemon a copy of the host identity in its state directory (`host_identity_path` in its configuration). The shared `/var/lib/opfield/host-identity` stays root-owned and readable only by root. The installer creates the shared file when it is missing, so root daemons installed later on the host report the same identity;
- otherwise behaves as a root install.

Every installer, root or not, and every re-run on an enrolled node succeeds only when the daemon it started runs under the service manager and Opfield accepted its connection. Otherwise it exits with an error that names the daemon log (`journalctl -u <unit>`, the OpenRC log, or the manual launcher log) and prints its last lines: when the service does not start, when enrollment fails, or when the daemon has not connected in time (90 s; `OPFIELD_NODE_ENROLLMENT_WAIT_SECONDS`, `OPFIELD_MONITORING_ENROLLMENT_WAIT_SECONDS`, or `OPFIELD_RELAY_ENROLLMENT_WAIT_SECONDS`). The installers use manual mode (a detached launcher that does not survive a reboot) only on hosts without systemd or OpenRC. Re-running a node's own setup command, with its already used token, keeps the enrollment and runs as a re-run without a token. A different token on an enrolled host is not used: the Docker and monitoring installers stop with an error and change nothing (on a node enrolled before 2.11.1 they warn and continue the update), and the nginx installer enrolls with the new token but keeps the previous enrollment when Opfield refuses it. To enroll the host as another node, stop the daemon, move its `certs` directory and `state.json` aside, and run the new command.

To switch a node to another user, or back to root, re-run its installer with the other `--user` (no `--user` means root; for the relay, `OPFIELD_RELAY_RUN_USER`). The node keeps its enrollment and host identity. An enrolled relay needs no `--token` for such a re-run: the relay installer then keeps its identity and takes the Opfield address, certificate pin, advertised address, and port from its configuration unless you give them; a new relay still needs every argument. On Docker and nginx nodes the installer prepares everything while the daemon keeps serving and stops it right before the new process starts; the monitoring daemon and the relay supervisor are stopped first. The daemon is stopped before any of its files change owner. The switch restarts the daemon service once and, unlike a daemon update (see [Daemon Updates](#daemon-updates)), does not hand open connections to the new process. What is open through the daemon at that moment is closed once: database, storage, and container link connections (clients reconnect within about 1.5 seconds), and WebSockets and long responses through Route Secure Links to or from this node. New connections only wait: for Docker and nginx nodes under systemd the daemon keeps its listening sockets in systemd's file descriptor store through the switch, and the new process accepts them. On a Docker node whose storage links still use per-link sidecars from before 2.11.1, the switch also recreates those sidecars. The installer then gives its configuration, state, and library directories to the new user (back to root: only what the previous user owned there), discards the launcher copies the previous user wrote, and replaces `/usr/local/bin/<daemon>` with a root binary or a wrapper for the new user. The previous user keeps any group membership the installer gave it, such as `docker`; remove it with `gpasswd -d <user> docker` when it is no longer needed.

A daemon whose state directory is not accessible to it keeps launcher supervision and self-update by placing its launcher in `~/.cache/opfield-daemon/<type>` or `/tmp/opfield-daemon-<uid>/<type>`.

| Daemon | Requires | Not available without root |
|--------|----------|----------------------------|
| Monitoring | Nothing beyond the user. | None. Host metrics, console, and file operations work with the user's own permissions. |
| Relay | `CAP_NET_BIND_SERVICE` only for a relay port below 1024. The installer adds it to the systemd unit or OpenRC service; manual mode cannot grant it. | None. |
| Docker (`docker` profile) | Read and write access to the Docker socket. The installer adds the user to the `docker` group and stops when the user still cannot use the socket. Docker group membership is equivalent to root on the host. Proxy Secure Links and managed storage links work: their connector containers (uid 65532) get the daemon user's group as a supplementary group and share the socket directories through it. When a node switches between root and non-root (re-run the installer with the other `--user`), the daemon recreates the connector containers and socket directories of the previous mode by itself and removes the old socket directories once the new connectors run. | Disk-image volumes; moving volume data between nodes; installing Secure Runtime from Opfield (the installer installs it during setup; later, re-run it with `--user <user> --secure-runtime`, see [Setup and compatibility](#setup-and-compatibility)); the boot step that opens database link listeners before Docker after a reboot; the size of container log files in container stats (Docker keeps them under `/var/lib/docker/containers`, readable only by root, and its API does not report their size). The daemon reports `docker_daemon_non_root_v1`, and Opfield names this reason where these features are offered. The [lease watchdog](#lease-watchdog) still runs as a root service that the installer sets up. |
| Nginx | An nginx whose master process already runs as the same user, because the daemon writes `/etc/nginx` and reloads nginx itself. The installer gives nginx-daemon `CAP_NET_BIND_SERVICE` in its systemd unit or OpenRC service, because the daemon's `nginx -t` binds the configured listen ports. Prepare it before installing: run the nginx service as the user with `CAP_NET_BIND_SERVICE` (systemd drop-in with `User=`, `Group=`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `RuntimeDirectory=nginx`, `PIDFile=/run/nginx/nginx.pid`, and `pid /run/nginx/nginx.pid;` in `nginx.conf`; on OpenRC `command_user="user:group"` and `capabilities="^cap_net_bind_service"` in `/etc/conf.d/nginx`, with `pid /run/nginx/nginx.pid;` in `nginx.conf`; Alpine's nginx service then gives `/run/nginx` to that user, also on a host where the installer earlier secured the service for a root nginx; the installer also makes it give that user the pid file before the `nginx -t` it runs as root on every start, without which nginx cannot start again once stopped, and the node's health names the command until then), give the user `/etc/nginx`, `/var/log/nginx`, and nginx's temp directories, and make log rotation create files as the user. Use `--nginx-mode integrate`, because `managed` mode writes an `nginx.conf` for an nginx started as root. While such an nginx is stopped, systemd removes `/run/nginx`, so the daemon cannot test configurations and the node's health says to start nginx. Running nginx as its distribution user (`www-data` or `nginx`) and installing the daemon with that user is the simplest setup. To switch back to root, run the nginx service as root again first (remove the drop-in, give nginx's temp directories and log rotation back to their packaged owner); the installer stops before changing anything while the nginx master runs as another user, and then gives `/etc/nginx`, `/var/log/nginx`, `/var/www/acme-challenge`, and the daemon's `/run` socket directories back to root. | None once nginx runs as the user. Otherwise the installer stops before changing anything and lists what to prepare. |

## Nginx Node Modes

The nginx installer supports:

| Mode | Use when |
|------|----------|
| `managed` | Opfield should write a complete known-good nginx base config and default server. |
| `integrate` | The host already has nginx config you want to keep. Opfield injects managed includes and a local `stub_status` endpoint. |

Example:

```bash
curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-daemon.sh | \
  sudo bash -s -- --type nginx --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT> --nginx-mode integrate
```

Use `managed` for fresh ingress nodes where Opfield should own nginx. Use `integrate` when nginx is already used by other workloads on the same host.

In both modes the daemon installs a managed HTTPS default server (`listen 443 ssl default_server` with `ssl_reject_handshake on`), so a TLS request for a hostname without a route is refused instead of being answered with another route's site. Clients and load balancers that connect by IP over HTTPS without SNI are refused too. A node whose nginx already has its own 443 default server keeps it, and the daemon logs a warning.

Opfield routes require nginx `1.25.1` or newer. On a fresh host, the installer always uses the nginx.org stable package. When it detects an older existing nginx, it asks before upgrading it; declining stops the installation before Opfield changes the nginx configuration or enrolls the daemon. Non-interactive installation refuses an unsupported existing nginx because it cannot ask for that approval.

## Enrollment Flow

On first start, the daemon:

1. Connects to Opfield and verifies the presented gRPC TLS leaf certificate matches `opfield.cert_sha256`.
2. Sends the one-time enrollment token only after the certificate pin matches.
3. Receives an mTLS client certificate issued by Opfield's internal CA.
4. Clears the enrollment token from its local config.
5. Reconnects using the mTLS certificate.
6. Registers as online and begins syncing config or reporting metrics.

The token is only needed for enrollment. Long-term daemon authentication uses mTLS.

Setup commands always carry the fingerprint of the gRPC certificate Opfield currently serves. Because Opfield renews that certificate while running, it postpones renewal while enrollment tokens are outstanding and renews it anyway only in the certificate's last week. If that happens before a node enrolls, generate a fresh setup command.

## Firewall Requirements

| Direction | Port | Purpose |
|-----------|------|---------|
| Node to Opfield relay | `9443/tcp` | Public relay-backed gRPC control plane and tunnel endpoint; the app-side gRPC listener is internal. |
| Managed node to remote relay | `9443/tcp` by default, or the relay's port | mTLS relay data plane; required only for configured Relay Pool members. In Docker Availability lease mode, every Docker node of the policy and every Nginx node of its routes must reach every relay of the pool. |
| Internet to nginx node | `80/tcp`, `443/tcp` | Public HTTP/HTTPS traffic served by nginx. |

Managed nodes do not need inbound management ports for Opfield.

Lease-mode Availability needs that last row in full. Lease frames between the nodes of a policy travel only through relays, each Docker node of a lease-mode policy keeps a connection to every lease-capable relay, and the workload's member Secure Links are registered on every one of them, so the Nginx nodes that route to it must reach them all too. A node that cannot reach a relay loses that relay's vote and path, and a holder that reaches too few voters stops its copy in `strict` mode (see [Data-Plane Failover](capabilities.md#data-plane-failover-lease-mode)).

## Relay Nodes

Relay hosts use the same enrollment lifecycle as every other managed node. Create one from **Nodes > Add Node > Relay**, or use **Settings > Relay > Add relay node** to open that same flow with Relay preselected. The node remains pending and can be deleted normally until its supervisor enrolls successfully; only then does it appear in the Relay Pool. The generated command installs a signed `relay-supervisor` and its separately signed worker, pins the Opfield certificate before sending the one-time enrollment token, and persists a physical host identity used as the Relay Pool fault domain. Two relay processes on the same physical host do not count as redundant.

The supervisor connects outbound to Opfield. The worker listens on the advertised address and port (TCP `9443` by default), which must be reachable from participating Docker, nginx, Storage, and Opfield hosts. Opfield does not open that port, alter firewall rules, create an overlay, or traverse NAT.

A relay can listen on any other TCP port. Enter it as **Relay Port** when you create the relay node (or pass `servicePort` to `POST /api/nodes`); the generated command then carries `--service-port <port>`, and only that port needs to be open inbound on the relay host, from every participating Docker, nginx, and Storage host and from Opfield. The port the worker actually listens on is the one daemons dial: the supervisor reports it to Opfield, and when it differs from the port the node was created with (the installer was run with another `--service-port`), Opfield switches the relay to the reported port, hands daemons new grant bundles, and records `relay.instance.service_endpoint.change` in the audit log. An installer run with an `--advertise-address` that the relay does not list yet replaces its addresses the same way. To move a relay to another port later, run the installer on the relay host again with the new `--service-port` (the **Re-enroll** command carries the relay's current port), and open the new port before you do. **Settings > Relay** shows the address and port daemons use for each relay. Running a non-root relay supervisor on a port below 1024 requires a service manager; the installer grants the worker the right to bind it. Once the pool topology has been stable for 30 seconds, Opfield rebalances assignments onto a newly ready relay by itself: participating daemons probe the new relay set first, and a workload switches only after its probes succeed. **Rebalance** starts the same at once; automatic rebalancing pauses while a Relay Pool update runs. Daemons measure round trips to the relays, routes use the nearest relays first, and primaries change only when a relay is clearly closer. A route's other relays (its standbys, which carry its traffic while its primaries are down, drain, or restart) are the nearest remaining ones too, so a stop of the local relay moves traffic to the nearest remote relay. Once a nearer relay has been reachable for 20 seconds, streams move back to it within a few seconds, without cutting connections. A relay that a Relay Pool update or an operator drained serves at once when it is resumed; a relay that failed only fills free slots for 2 minutes after it is back. While a Relay Pool update runs, and for 2 minutes after it, relayed route health checks are not judged slow and a failed relayed check is checked again on the next run, because the update moves the routes' traffic between relays. A relay whose control connection to Opfield drops keeps its assignments for 3 minutes. Remote relays connect to Opfield through its local relay, so their control connections drop whenever it restarts; that time does not count, and the 3 minutes start once the local relay serves again. Meanwhile **Settings > Relay** and `GET /api/system/relay` list such a relay in the state it reported last, marked reconnecting (`reconnecting: true`), not offline: its relay port keeps serving. The same holds for the few seconds a relay's own control connection reconnects (its supervisor reconnects it after an update, for example): a relay is listed offline only once it has not come back within 5 seconds. A relay that most of the nodes measuring it cannot reach on its relay port loses its assignments within about a minute and gets none while that lasts, even when its control connection is up; once the nodes reach it again it is placed again within about two minutes, at first only where a slot is free. Availability members in lease mode are registered on every relay that supports leases.

Remote relay server certificates are issued for 365 days. Opfield checks them hourly and renews each one automatically from 60 days before expiry; the worker keeps serving the previous certificate during the renewal so connected daemons are not cut off. A worker too old for that rollover reports that it needs a Relay Pool update or re-enrollment instead. When a renewal fails or a certificate has expired, **Settings > Relay** offers **Renew certificate** for that relay.

A remote relay that is offline, stuck synchronizing, locked out of policy sync, or holding an expired certificate can be re-enrolled from **Settings > Relay** with **Re-enroll**. Opfield issues a single-use token and shows a ready installer command pinned to the pool's relay version; run it on the relay host. The installer waits for the supervisor to enroll and exits with an error when Opfield refuses the token (already used, expired, issued for another relay, or run on a host other than the relay's own); the relay then keeps running with its previous identity, and the installer says so. Running the installer again with a token that was already used therefore fails the same way; to keep the relay as it is, run it without `--token`. The local relay is never re-enrolled: when it refuses Opfield's policy because its pinned trust no longer matches (for example after Opfield's database was restored or Opfield was reinstalled over an existing relay volume), Opfield re-pins the active policy signing key on it automatically, at most once every 10 minutes, and records the reset in the audit log.

To remove a remote relay, drain it in **Settings > Relay**; once it carries no tunnels and no assignments, **Remove** deletes its node and revokes its identity (uninstall the supervisor on the host separately). A relay that is offline can be removed without a drain once its last signed policy has expired (the relay policy lease, 72 hours by default) and it has not reported for 90 seconds, so nothing can still connect through it, and only while every workload it served has another ready relay. Until then Opfield refuses the removal with `409 RELAY_OFFLINE_REMOVAL_UNSAFE`, whose message and `details.removableAfter` give the exact time; **Settings > Relay** shows "Can be removed after <date and time>" in your local time and keeps **Remove** disabled until then. `GET /api/system/relay` reports the same time as `removableAfter` for each offline remote relay.

Opfield also renews its own gRPC, web, and local relay certificates while running. It checks hourly and renews each one within 30 days of expiry; existing daemon and relay connections keep their current certificate and new handshakes receive the renewed one. Until the local relay confirms that it loaded the renewed files, Opfield keeps trusting both the previous and the new relay certificates and retries the reload, so neither side locks the other out. The local relay identity files are written as one set, so an interrupted write leaves the installed identity intact.

If Opfield is behind Cloudflare for the UI/API, configure Opfield's public gRPC target as a direct `9443/tcp` endpoint. A Cloudflare-proxied web hostname must not be selected unless it explicitly routes the Opfield gRPC port. Generated commands use the configured target, so normal enrollment does not require replacing the address by hand.

Daemons report local and detected public IP addresses in their health data. For Docker nodes, Opfield uses an explicitly configured service address first, then the first reported local address, then a reported public address for the endpoints other hosts and clients connect to directly: managed database links and published storage. Proxy routes to Docker containers, deployments, and Compose services do not use it: they always reach the workload through a Secure Link, without a host port. Configure the service address on the node detail page when automatic selection is not routable from the hosts or clients that use those endpoints.

### Protected Relays

A relay installed on a machine that belongs to someone else (a partner or customer whose host may hold personal data) can run in protected mode. In protected mode an Opfield administrator cannot get into the host through the relay:

- no console: the relay refuses the interactive shell, one-shot commands (including the assistant and MCP `execute_node_console_command`), and console input;
- no files: the relay refuses every host file operation (browse, read, write, upload, move, delete);
- no host diagnostics: health reports carry only aggregate CPU, memory, swap, load, uptime, file descriptor and root disk size and use figures (for the disk alerts), with no other disk mounts, devices or filesystem types, disk I/O, network interfaces, IP addresses, CPU model or kernel version, and the relay does not look up its public IP address;
- no other commands: the relay runs only its own operation (signed policy, drain, worker update, certificate renewal, its route counters, health, and its own logs) and refuses everything else Opfield sends, including commands added by later Opfield versions, with an error that says the relay is protected.

What Opfield can still do: route traffic through the relay, drain and resume it, renew its certificate, read its own logs and counters, and update it. Updates install only official releases signed with the release key built into the relay, as on every node, and a protected relay accepts no update to an older release than the one it runs (an older release could predate protected mode). A protected relay also refuses a policy that names a built-in local service: only the local relay next to Opfield serves those.

Protected mode is the machine owner's setting. It lives only in the relay's local configuration, `/etc/opfield-relay/config.yaml` (readable by root, and by the relay's run user on a non-root install). Opfield has no command that changes it, and a protected relay refuses every command that could write that file.

- Install a new relay protected: add `--protected` to the generated command (the relay setup dialogs offer **Protected relay**, which adds it). Re-running the installer keeps protected mode on; the installer never turns it off.
- Turn it on or off on an existing relay, as root on the relay host:

  ```bash
  relay-supervisor protected status
  relay-supervisor protected on      # or: relay-supervisor protected off
  systemctl restart opfield-relay-supervisor   # OpenRC: rc-service opfield-relay-supervisor restart
  ```

  `relay-supervisor protected on|off` writes the setting into the configuration file and keeps everything else in it. Editing the file by hand works the same way:

  ```yaml
  protected:
    enabled: true
    allow_database_witness: false
  ```

  The change applies when the relay supervisor restarts. The relay reports it when it reconnects.

Opfield shows a **Protected** badge on the relay in **Nodes**, on its node page, and in **Settings > Relay** (`protected: true` in `GET /api/system/relay`). A protected relay has no **Console** or **Files** tab and no console or file commands in the command palette. The API, the assistant and MCP refuse console and host file requests for it with `409 NODE_PROTECTED`.

`allow_database_witness` (default `false`) lets Opfield run database availability witness processes on a protected relay; without it, a protected relay must not get one. It has no effect while protected mode is off.

## Daemon Configuration

Daemons store config under `/etc/<daemon-name>/config.yaml`.

Example nginx daemon config:

```yaml
opfield:
  address: "opfield.example.com:9443"
  token: ""
  cert_sha256: "sha256:<opfield-grpc-leaf-fingerprint>"

tls:
  ca_cert: "/etc/nginx-daemon/certs/ca.pem"
  client_cert: "/etc/nginx-daemon/certs/node.pem"
  client_key: "/etc/nginx-daemon/certs/node-key.pem"

nginx:
  config_dir: "/etc/nginx/opfield/conf.d"
  certs_dir: "/etc/nginx/certs"
  logs_dir: "/var/log/nginx"
  global_config: "/etc/nginx/nginx.conf"
  binary: "/usr/sbin/nginx"
  stub_status_url: "http://127.0.0.1/nginx_status"
  htpasswd_dir: "/etc/nginx/opfield/htpasswd"
  acme_challenge_dir: "/var/www/acme-challenge"

console:
  enabled: true  # host console; false turns it off on this node
  user: ""       # OS user for console sessions; empty = daemon's user; another user needs a root daemon

files:
  enabled: true  # host file access; false turns it off on this node

state_dir: "/var/lib/nginx-daemon"
log_level: "info"
log_format: "json"
```

In `integrate` mode, the `stub_status_url` may use a local alternate port such as `http://127.0.0.1:8081/nginx_status`.

The Docker daemon reads `/etc/docker-daemon/config.yaml`. Its optional `docker.secure_links.subnet_pool` sets the address range of new secure-link networks (database, storage, and container links):

```yaml
docker:
  secure_links:
    subnet_pool: "10.213.0.0/16"  # default; IPv4, /26 or larger
```

Each new link network takes the first free /26 of the pool; subnets already used by Docker networks or by the host's routes are skipped. Change the pool when the default range overlaps a network the node reaches through its default route, such as a site network or a VPN behind a router, then restart the Docker daemon. Existing link networks keep their addresses until their link is recreated, and networks created before 2.11.1 keep theirs.

### Host Console And File Access

Every daemon type (nginx, Docker, Storage, Build Worker, Monitoring, Relay) accepts two host access switches in its config file:

| Key | Default | When `false` |
|-----|---------|--------------|
| `console.enabled` | `true` | The daemon refuses the host console: the interactive shell on the node's **Console** tab and its popout, and one-shot commands from the assistant and MCP (`execute_node_console_command`). |
| `files.enabled` | `true` | The daemon refuses host file access: browsing, reading, writing, uploading, moving, and deleting files on the node's **Files** tab, its file popout, the node file API, and the assistant and MCP node file tool. |

The switches live only in the config file on the node, so an Opfield administrator cannot turn them back on remotely. To change one, edit the file on the node and restart the daemon (for example `systemctl restart docker-daemon`). The daemon reports disabled features when it connects; Opfield then refuses those requests with `409 NODE_CONSOLE_DISABLED` or `409 NODE_FILES_DISABLED`, and the node page explains where to turn them back on.

Docker container consoles and container files are not affected: they reach into containers, not the host.

**To remove host access, disable both.** Turning off only the console is not a boundary: the daemon usually runs as root, and writing files as that user can still change the host and run code — systemd units, cron jobs, `authorized_keys`, or this config file itself to turn the console back on at the next restart. The node page shows a warning while the console is off and file access is on.

The node setup dialogs offer **Disable host console** and **Disable host files** checkboxes that add these flags to the generated command. Nodes ordered through a hosting provider are installed by Opfield itself with a pinned installer revision; turn the switches off on those nodes by editing the config file.

#### Managed Docker objects and agents

Agents (remote MCP callers with OAuth grants or API tokens, and the in-app assistant) run node console commands (`execute_node_console_command`) as root (or as `console.user` when it is set), so they can repair a node or a failed service: `systemctl`, `journalctl`, `apt`, editing configuration files, restarting services that are not containers. The **agent sandbox** keeps ordinary use of the container runtime out of their commands. The daemon starts each agent command in it: its own mount namespace, where the Docker, containerd, Podman, CRI-O and k3s sockets and runtime directories (`/var/run/docker.sock`, `/run/containerd/`, the socket set in the daemon config, the `hosts` and `exec-root` of `/etc/docker/daemon.json`, the containerd gRPC address) are covered, and where the runtime CLIs (`docker`, `dockerd`, `ctr`, `nerdctl`, `podman`, `crictl`, `runc`, ...) are covered by `/dev/null` and cannot run. What the command leaves running in the background is ended with it. A command runs for at most `timeoutSeconds` (30 seconds unless the call asks for more, up to 300); at the limit it is stopped with everything it started, and the result has `timedOut: true` and the output written so far. A command that fails (a non-zero exit, the time limit) still returns its `stdout`, `stderr`, `exitCode` and `risky`, with `error` saying why.

A daemon that does not run as root (installed with `--user`, or a relay with `OPFIELD_RELAY_RUN_USER`) cannot give agents root. It runs their commands as its own user, and the result says so: `runAs` names the user, `sandbox` is `daemon_user`, and `limits` explains that commands needing root (package installs, service changes, system files) fail. That user normally cannot reach the container runtime. When it can (it is in the `docker` group, or a rootless Docker or Podman runs as it), the daemon covers the runtime in a user namespace instead (`sandbox: user_namespace`; files and processes of other users show as owned by `nobody` there). A host that allows no unprivileged user namespaces then refuses agent commands with an error naming the socket: take the user out of the socket's group, or run the daemon as root.

The sandbox is an accident guard that stops ordinary Docker use from the agent console. It is not a security boundary against a determined root process: a root command that sets out to get around it can (reach the runtime socket by another path such as `/proc`, `nsenter` into PID 1's namespaces, unmount a cover, create a systemd unit or cron job), and what it then does to containers is not refused or audited as a change to a managed resource. The sandbox stops an agent from changing containers by mistake, or from working around a refusal with another ordinary spelling such as `curl --unix-socket`, `ctr` or a decoded payload piped to a shell. Agents should use the Docker tools for containers. Grant `nodes:console` only to agents you would trust with root on the node.

Opfield also refuses a command that visibly uses the runtime before sending it. A change to an Opfield-managed object (removing, recreating, stopping, starting, restarting, killing, pausing, renaming or updating a managed container, running a container under its name or on its host ports or volumes, network or volume changes, prunes, `docker compose` on a managed project, or a write under `/var/lib/docker-daemon`, `/etc/docker-daemon` or `/var/lib/docker`) gets `403 MANAGED_RESOURCE_CONSOLE_FORBIDDEN`, audited as **Refused a console command on a managed resource**, with the object and the Opfield tool to use. Any other `docker`, `podman`, `nerdctl`, `ctr`, `crictl` or `runc` command, or a runtime socket path, gets `403 NODE_CONSOLE_RUNTIME_UNAVAILABLE`, except disk and file checks (`df`, `du`, `findmnt`, `ls`, `stat` of `/var/lib/docker` or a socket), which run normally, audited as **Refused a console command that uses the container runtime**, with the Docker tools to use. The in-app assistant runs such a command at once and reports the refusal instead of asking for approval first. The result's `risky` is true for a command that matches a risky pattern, changes Docker objects, uses the runtime, uses a namespace tool (`nsenter`, `unshare`) or a unix-socket client, or runs code its command line does not show (`base64 -d | sh`, `curl ... | bash`, a script file, an interpreter). A daemon older than 2.12.3 runs one-shot commands without the sandbox, so Opfield sends agent commands only to updated daemons and answers `409 NODE_CONSOLE_AGENT_SANDBOX_REQUIRED` until the node's daemon is updated.

`ssh_execute_command` does not run in the sandbox. An SSH connector to an enrolled node is refused with `403 SSH_MANAGED_TARGET_BLOCKED`, both by the addresses the node reports and by its SSH host key: daemons of 2.12.3 and later report the fingerprints of the host's SSH host keys, so a connector pinned to one is refused whatever address reaches it (NAT, a forward, a jump host). On a host that still turns out to run an Opfield daemon (Docker, nginx, monitoring or relay), every agent command is refused the same way; use `execute_node_console_command` on the node. People in the browser console are not restricted.

The Docker daemon watches its containers: one that is removed, created under a managed name, renamed, stopped, killed, paused, resumed or updated (`docker update`) by anything other than Opfield is reported as **Changed outside Opfield** (an audit entry with the container and node, and the built-in alert rule **Container changed outside Opfield**, on by default, which notifies the webhooks the container and node rules used when it was added; edit or turn it off under Notifications). After a removal, a new container under the name or a rename, it is a different container to Opfield: it gets a new access identity, and a Git-source build refuses it with an error that says what happened. After a stop, kill or pause, start it from Opfield if it should run; after `docker update`, set its resources in Opfield. The audit entry and the alert message say which change it was and what it means. A container that exits on its own or that its restart policy restarts is not a change, and neither are the stops of Docker itself shutting down. The daemon tells its own operations apart by when Docker stamped each event, so a change made right after one of Opfield's own operations on the container is still reported.

`console.user` runs console sessions and agents' one-shot commands as another OS user. Only a daemon running as root can start processes as another user. A daemon that runs as its own user (`--user`) and names another user in `console.user` logs an error at startup, reports it when it connects, and refuses every console session. Opfield refuses those requests with `409 NODE_CONSOLE_USER_UNAVAILABLE`, and the node page names the fix: remove `console.user` or run the daemon as root. Sessions start in the user's home directory, or in `/` when the user has none (for example a system user created with `--no-create-home`).

### Files Daemons Clean Up On Their Own

Daemons remove what their own work leaves on the node, with no setting and on existing nodes from the first start of an updated daemon:

- **Every daemon:** temporary binaries of an update or launcher copy that a crash or power loss interrupted (older than an hour, next to the daemon binary and in the launcher state directory). A daemon download larger than 512 MiB is stopped. A partial file of a node **Files** upload (`.opfield-upload-<id>.tmp`) that nobody wrote to for an hour is removed from the directories the daemon wrote such files to; Opfield also cancels an upload whose session expired (30 minutes without a chunk).
- **nginx nodes,** once an hour: Pages uploads nobody finished for 6 hours, an upload of a Deployment once a newer upload of it starts, and an upload whose release could not be stored; extraction and certificate stages left by a crash; Pages runtime-configuration versions other than the active one and the one before it (each Pages publication added one before 2.12.3); certificate versions that are neither current, the most recent other one, written within the last hour, nor named by a config (each renewal added one); denial pages of revoked previews older than 30 days, when the managed default HTTPS server is installed; and proxy caches of routes the node no longer serves, also inside nginx's private `/tmp` when its service has `PrivateTmp`. Pages leaves 10 % of the node's filesystem free (at most 4 GiB): a release that would go below it is refused, and Opfield retries it later.
- **Build Workers:** image scans unpack into the build's own directory, which the build's disk limit counts and the build removes, and the vulnerability database lives in `/var/lib/docker-daemon/builder/grype-db` with only its current schema. Shortly after start and every six hours while no build runs, the worker removes job, secret and Pages build directories a crash left, scanner temp directories in `/tmp` older than an hour, and its BuildKit cache and image store.

Opfield also removes, every hour, Pages releases an ingress node still stores for Deployments that were deleted. The certificate and private key of a deleted certificate, or of one no route on the node uses any more, leave the node 24 hours after that (a grace period, so a route moved back keeps it): Opfield removes them every hour, a few minutes after it starts, and when the node reconnects, and keeps retrying while the node is offline. Certificates of deleted routes that earlier releases left on nodes are removed by the same pass after the update.

## Daemon Updates

From the UI:

1. Open the node detail page.
2. Review runtime and version status.
3. Click **Update** when an update is available.

To update several nodes at once, open **Nodes** and click **Update Nodes**. The dialog lists the nodes whose daemon is older than the latest release of its type and updates the selected ones together. Relay nodes are not listed: they update with the Relay Pool (**Settings > General**, **Update Relay Pool**), which drains them one at a time. Opfield refuses a daemon update for a node that is not connected, for a relay node, and for a node that already runs that release or a newer one, and it records the reason of a failed, rolled-back, or timed-out update on the node.

Nodes that vote in or can hold a lease-mode Availability policy restart one after another, so the policy never loses its quorum to an update. Opfield sends such a node's update only once the other voters and candidates of its policies are online, have reported their lease state, and vote again; until then the node shows the update phase `waiting_for_lease_peers` and the peers it waits for. Requests that arrive together run standbys first and holders last, and nodes that share no policy update in parallel, so you can select all of them in **Update Nodes**. A peer that has not settled 3 minutes after its restart stops blocking, and a request that waited 30 minutes fails and names the peers. A queued update survives an Opfield restart, and Relay Pool updates wait for lease peers the same way.

Before that, an update waits for the long tasks running on the node: backup and restore runs, image builds, Docker migrations to or from the node, image pulls and container actions, storage copy jobs, and container archive exports and imports. Until they end the node shows the update phase `waiting_for_tasks` and the tasks it waits for. After 30 minutes the update goes ahead anyway and the node keeps a warning with its last update. **Update now** starts it at once, after a confirmation, because the running tasks may fail. A waiting update survives an Opfield restart and still waits at most 30 minutes in total. An image pull or container action that Opfield lost track of (Opfield restarted, or the node's connection dropped while it ran) keeps running on the node and stays in the list until the node, once connected again, tells how it ended. A container update or recreate settled that way still gets its follow-ups, also when Opfield restarted before the node answered: after an image change, saved environment values that only repeated the old image's defaults follow the new image, and an update that did not apply (it failed, or never ran on the node) puts back the environment it saved before it ran, unless the environment was changed after it. Docker daemons from 2.11.4 tell at once whether such an update or recreate reached them; with an older daemon Opfield waits for the operation's time limit and then judges by the container. **Force cancel** on such a task drops its follow-ups. **Update Nodes** waits the same way for each node.

An update of a Docker or nginx node whose daemon supports live handover (it advertises `daemon_stream_handover_v1`) keeps relay stream sessions and container links to a target on the same node: the new daemon process takes them over after a pause of a second or two. These are still cut as before: raw streams of older peers, PostgreSQL links where the daemon opens TLS, registry pulls and pushes, and backup runs. A managed PostgreSQL with TLS takes its links over a unix socket on its node from 2.12.1, and a daemon update keeps them; an existing one moves to the socket when its container is next recreated (an engine version update, a change of engine settings such as `max_connections`, or a repair). A memory or CPU change is applied live and does not recreate it, so until then its links are cut on a daemon update. The first update onto a daemon with live handover, and a rollback below it, cut open connections once; **Last Update** shows it as "cut all connections of the node: the previous daemon version can't hand them over". A node whose launcher process started before 2.11.4 cuts them once more on its next update, which restarts the whole service so the new launcher starts (see below); updates after it keep connections. New connections wait for the new process, including the ingress health and maintenance access sockets of nginx nodes and the registry proxy of Docker nodes; only that one service restart refuses them on OpenRC and under systemd units without a file descriptor store. The node page says what an update would do now: **The update keeps connections**, **N connections will be cut**, or **Open connections are cut once** (with "The whole service restarts once to start the newer launcher" when that is why). **Last Update** under **Runtime** shows what the last update kept and cut, whether it restarted the whole service, and its warnings. Connections a replaced Secure Link connector still carried when it was removed (up to an hour after a Relay Pool update replaced it) are not part of a daemon update: **Connector Replacement** shows how many were cut and when, and the update's record stays as it was.

After a Docker node moves to the 2.11 daemon, the first apply of an unchanged Compose revision recreates its services once to add log rotation; see [Container Log Limits](operations.md#container-log-limits).

Opfield verifies the signed daemon release manifest before dispatching an update. New daemons verify the signed manifest locally, download the binary, verify its SHA256 checksum, replace the binary atomically, and hand restart to the launcher on launcher-managed installations. The service manager supervises the launcher; older direct-run installations still rely on service-manager restart.

The crash-safe launcher introduced in 2.10 preserves the previous binary and an on-disk update journal for Docker, nginx, monitoring, and the Relay supervisor. A candidate must report local readiness and remain running through a 30-second stability window before the update is committed. Failed candidates can roll back to the preserved binary; a 2.11.4 or later daemon that announced it reports Opfield control readiness must also reach Opfield within 3 minutes of local readiness, or the launcher restores the previous daemon. Opfield waits for an updated daemon as long (4.5 minutes) before it fails the update and treats the node as offline, so a rollback shows as "The daemon came back on … instead of …". A candidate stopped that way hands its connections to the restored daemon when that daemon is 2.11.4 or later, which carries them on. This is local process readiness, not proof of Relay connectivity or healthy customer workloads; verify reconnect, capabilities, and the relevant runtime after an update. If launcher bootstrap is unavailable and the daemon runs directly, launcher rollback protection is unavailable.

The launcher updates itself as well. Once an updated daemon is committed and connected, the launcher process replaces itself with the launcher of that release in place, while no update is pending. It keeps its process, the running daemon, and the listening sockets it holds, so nothing is closed. The new launcher stays on trial until a daemon process it started passed the 30-second window. If daemons keep failing under it, the node goes back to the previous launcher, and that launcher release is not tried again. The launcher updates in place only under systemd or OpenRC, which start the service again if the new launcher fails. In manual mode the new launcher starts with the next manual restart. The node details show the launcher version; "Unknown" says why: a launcher started before 2.11.4 (replaced when the service restarts), or a daemon too old to report it.

A launcher process started before 2.11.4 cannot update in place. When the update onto 2.11.4 came from a daemon without live handover (2.11.3 and earlier), which already cut every connection, the new daemon restarts the whole service once right after that update; **Last Update** shows it as one update: all connections cut by the previous daemon, then the restart's cut. Otherwise, once a node with such a launcher runs a 2.11.4 or later daemon, its next daemon update restarts the whole service once, so the new launcher starts with the updated daemon. That update hands no connections over and closes the open ones once (**Last Update** counts them as `service_restart`, or says "cut all connections of the node" when the daemon updated from was 2.11.4-rc.7 or earlier, which did not count them, and says why). The service starts with the launcher of the updated daemon, so the launcher is replaced once. The planned restart exits cleanly and is not recorded as a failure of the unit. Under systemd as root the restart is immediate; as a run user the unit starts again after its `RestartSec`. OpenRC starts the service again after its `respawn_delay`. On OpenRC, and under systemd units without a file descriptor store, new connections are refused during that one restart. Updates after it go through the new launcher. In manual mode, or with a systemd unit that does not set `Restart=always` for a run user, the update runs under the running launcher as before, and its result and the daemon log say why; a launcher from 2.11.0 or later still hands connections over then. Restart the service to start the new launcher.

**Updating a Docker or nginx node from 2.11.3.** Plan one short disruption window per node. Open connections drop twice, about 30 seconds apart: first when the old daemon is replaced, then when the service restarts once for the new launcher. Clients that reconnect after the first drop are cut again by the second. After that, daemon updates keep connections.

Daemons installed before signed-manifest support can perform one transition update: Opfield verifies the signed manifest and sends the verified checksum, while the old daemon enforces the checksum. After that update, daemon-side signature verification is enforced.

Release and update units are independent: nginx, Docker, monitoring, the Relay Pool supervisor, and the Relay Pool worker have their own signed artifact contracts. The local Relay image and the nginx/workload Secure Link connector image are digest-pinned and signed as one Relay release contract rather than inheriting the Opfield application version. Each Relay release names the minimum Opfield version it requires; Opfield offers or applies a standalone relay update only once it runs that version, so a relay update cannot run ahead of the Opfield update. Managed database application bindings do not require a database connector image; their listeners are owned by the target Docker daemon.

The installation-wide update channel applies to managed daemon checks. `stable` offers production tags only, while `preview` also allows matching `vX.Y.Z-rc.N-<component>` GitHub prereleases. Opfield resolves one staged target per daemon type from the oldest compatible installed version cohort, preferring a newer patch on that minor and otherwise the baseline release of the next minor. This avoids advertising a later target that would skip an older cohort's required upgrade step.

Docker nodes expose first-class Compose Projects. Community and paid plans discover existing projects from canonical labels and provide read-only inventory, status, monitoring, and logs. Personal and higher can create or adopt single-node image-only projects, validate complete single-file YAML, keep immutable revisions, run explicit lifecycle operations, stream aggregated logs, report drift, use ordinary non-Swarm CPU/memory/PID limits, attach managed databases, and target services from Routes or Secure Links without pinning an ephemeral container name. Business and Enterprise can instead attach an allowlisted Git source whose bounded Compose `build` sections are resolved by isolated Build Workers into one digest-pinned immutable revision. Opfield never reads host Compose source paths, and generated runtime networks or managed-database overlays are not written back into the authored source. Project-owned child containers, named volumes, and non-external networks are removed from standalone lists and protected from direct mutations; images and external/shared resources remain global.

The Docker daemon runs Compose through Docker's official `docker/compose-bin` image, pinned by multi-architecture OCI digest. It pulls the pinned image when absent and advertises `docker_compose_v1` only after the image is available and the executor initializes. If registry access is unavailable, Compose inventory remains readable but managed mutations fail closed until the runtime becomes available. Business and Enterprise can project an eligible mount-free Container, Deployment, or whole Compose Project across multiple independent Docker nodes with Opfield Availability. This is not a Docker cluster: each daemon remains outbound-only, images move through repository-scoped internal-registry Secure Links, and application, database, and management ports are never opened between Docker nodes. Same-node multi-instance scaling remains in development.

## Manual Setup

Manual setup is useful for locked-down hosts or custom packaging.

1. Create a node in Opfield and copy the enrollment token plus the Opfield certificate fingerprint.
2. Download the daemon binary, `checksums.txt`, and the matching `*.update.json` signed manifest from the release package.
3. Verify the signed manifest with the compiled Opfield update public key, then verify the SHA256 checksum.
4. Install the binary.
5. Write `/etc/<daemon-name>/config.yaml`.
6. Create and start a systemd service.

Example checksum flow:

```bash
curl -fsSL "https://get.opfield.dev/opfield/nginx-daemon/v2.0.0-nginx/nginx-daemon-linux-amd64" \
  -o /tmp/nginx-daemon-linux-amd64
curl -fsSL "https://get.opfield.dev/opfield/nginx-daemon/v2.0.0-nginx/checksums.txt" \
  -o /tmp/nginx-daemon-checksums.txt
curl -fsSL "https://get.opfield.dev/opfield/nginx-daemon/v2.0.0-nginx/nginx-daemon-linux-amd64.update.json" \
  -o /tmp/nginx-daemon-linux-amd64.update.json

expected=$(awk '/nginx-daemon-linux-amd64/ { print $1 }' /tmp/nginx-daemon-checksums.txt)
actual=$(sha256sum /tmp/nginx-daemon-linux-amd64 | awk '{ print $1 }')
[ "$expected" = "$actual" ] || { echo "checksum mismatch"; exit 1; }

install -m 755 /tmp/nginx-daemon-linux-amd64 /usr/local/bin/nginx-daemon
```

`checksums.txt` alone is not sufficient for automatic updates. Opfield and new daemons require the signed `*.update.json` manifest to establish release provenance.

Then enroll and start:

```bash
nginx-daemon install --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<FINGERPRINT>
systemctl enable --now nginx-daemon
```

Replace `nginx-daemon` with `docker-daemon` or `monitoring-daemon` as needed. A Storage node also uses `docker-daemon`, installed in its `storage` profile (`docker.mode: storage`); legacy database nodes keep the `databases` alias of that profile. A Build Worker uses the `builder` profile.

For a Storage node, use the installer rather than preparing filesystems manually:

```bash
sudo ./scripts/setup-daemon.sh --type storage
```

It rejects a host that cannot complete the same fixed-size storage lifecycle used at runtime: preallocate and format an ext4 image, attach a free loop device, mount and write it, grow the image and filesystem, then unmount and detach it. It also verifies the local Docker Engine before enrollment. Failed probes clean their temporary mount, loop attachment, and image before the installer exits. The Storage profile then uses fixed-size preallocated ext4 images under `/var/lib/docker-daemon/databases` by default (or the configured external mount), so each managed database, object storage volume, and backup workspace has a hard storage limit without reformatting the VM disk.

VM and bare-metal hosts normally expose the required loop and mount capabilities directly. An LXC Storage node is supported only when its outer host explicitly passes `/dev/loop-control` plus a loop-device pool and permits loop block devices and mounts. The installer detects an ordinary LXC guest without those capabilities and stops before enrollment with that remediation; it never falls back to an unbounded Docker volume. Each managed database, object storage member and running backup holds one loop device while it exists (as does each disk-image volume on a Docker node), so size the passed pool for all of them: when it is exhausted, a create fails with "node has no free loop device", and the daemon releases devices left by deleted instances on its own.

The Storage installer runs `docker-daemon` only as root and shows a local-disk selector in an interactive terminal. Choose an eligible mounted filesystem or a custom path; the selected location becomes the storage root. For automation, pass `--storage-root <path>` (or set `OPFIELD_DATABASE_STORAGE_ROOT`) together with the normal enrollment flags and `--yes`. The preflight runs before enrollment, and `--dry-run` performs no storage preparation or other host mutation.

Managed database links, managed storage links, and container links run through one shared secure-link connector per Docker node, each link on its own internal network. Opfield does not deploy a per-link connector container or open a host listener. After the 2.11.1 Docker daemon update, each workload with a database link, or with a storage link created before 2.11.1, is recreated once to move to the shared connector, one at a time per node (Deployments blue/green, without downtime); rolling the daemon back to 2.11.0 moves the links back the same way. At most four workloads per node are recreated at once (the daemon's concurrent command limit). See [Updating To 2.11.1](operations.md#updating-to-2111).

Published managed databases use native direct TLS by default. Opfield issues the server certificate from its independent Database CA and keeps the private key in daemon-owned storage outside the database image. PostgreSQL and key-value stores publish one TLS endpoint; ClickHouse publishes both HTTPS and its native TLS endpoint. The UI exposes the CA certificate/fingerprint with direct credentials and supports certificate rotation after node IP changes.

## Offline Behavior

If Opfield is offline:

- Existing nginx configs keep serving traffic, and an nginx node serves the last published status page from its cache.
- Docker containers keep running.
- Daemons keep retrying connection.
- Operators temporarily lose centralized UI/API control.
- New config changes cannot be pushed until Opfield is online again.
- Relays keep working on the last signed policy Opfield sent them. That policy is valid for the relay policy lease, 72 hours by default (1 hour to 7 days in **Settings > Relay**, **Policy lease**), counted from Opfield's last refresh, which it repeats every few minutes while it runs. After the lease runs out, a relay admits no new connections until Opfield is back. Relays from before 2.11 keep a 15-minute lease until the Relay Pool update. Revocations and placement changes need Opfield.
- Docker Availability policies in lease mode keep failing over without Opfield: in the default `strict` mode, a holder that is cut off from a majority of its policy's voters stops its own copy, and the next candidate takes over (see [Data-Plane Failover](capabilities.md#data-plane-failover-lease-mode)). Lease traffic between nodes runs through the relays, and Opfield's local relay stops when the Opfield host does, so failover that must survive the loss of the Opfield host needs a remote relay on another host. Policies that are not in lease mode are not failed over until Opfield is back.

When Opfield returns, daemons reconnect and resume normal operation. Opfield reconciles its records with the lease holders that took over while it was away and writes the takeovers to the audit log.
