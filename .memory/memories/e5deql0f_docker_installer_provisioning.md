---
{
  "id": "e5deql0f",
  "file_name": "e5deql0f_docker_installer_provisioning",
  "tags": [
    "alpine",
    "debian",
    "docker",
    "installer",
    "openrc",
    "opfield",
    "regression"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786049117386,
  "updated_at": 1791851507216
}
---
Opfield installer and daemon setup-script contract (Docker provisioning, unit detection, terminal output):

Docker bootstrap
- `scripts/install.sh` must bootstrap Docker on fresh Debian, Ubuntu, Fedora, CentOS, and RHEL hosts.
- `scripts/setup-docker-node.sh` must also bootstrap Docker on Alpine. Use Alpine community packages `docker` and `docker-cli-compose`, then enable/start Docker with OpenRC. Systemd is not required; the installer also registers `docker-daemon` as an OpenRC service.
- A minimal Alpine host must have Bash available to invoke the setup scripts. The matching Alpine community repository must expose the Docker packages.
- Install Docker CE from Docker's official repository on Debian/Ubuntu/Fedora/CentOS/RHEL and include the Compose v2 plugin.
- Start the Docker daemon, then select `docker` or `sudo docker` based on availability.
- Removing conflicting Docker packages is cleanup, not a required step. Run the apt/dnf/yum removal best-effort because supported distributions may not publish every package name (for example, Debian 12 does not publish `docker-compose-v2`), and an exit 100 there must not block repository setup and Docker CE installation.
- Regression checks: a fresh Debian 12 container must reach `Docker Engine and Docker Compose v2 installed` (a later service-start failure without systemd is expected); the Alpine check must get past package installation and reach `Starting Docker service` (a later daemon reachability failure in an unprivileged container is expected).
- Local Docker-in-Docker containers require starting `dockerd` on `/var/run/docker.sock` before starting `docker-daemon run`.

Docker unit detection
- Detect Docker's systemd unit, preferring `docker.service`, then `snap.docker.dockerd.service` (Ubuntu Snap Docker).
- Apply the detection consistently in `scripts/setup-docker-node.sh`, `scripts/install.sh`, and `packages/daemons/docker/cmd/docker-daemon/main.go`.
- Generated `docker-daemon` units reference the detected Docker unit with soft ordering (`Wants=`/`After=`, never a hard `Requires=`; see the Docker daemon service-dependency memory), and setup passes the detected Docker context host via `--docker-socket`.

Terminal output
- Keep installer status messages inside the guide-rail UI. Redirect package and daemon-install command output to the secured installer `LOG_FILE`, surface required-step failures through `die`, and use the existing `run_quiet` pattern.
- The node setup scripts (`setup-node.sh`, `setup-docker-node.sh`, `setup-monitoring-node.sh` and the other `setup-*-node.sh`) must redirect the invoked `*-daemon install` command's stdout and stderr to their `LOG_FILE`: the Go install command prints unstyled config/systemd lines that break the guide rail and duplicate the wrapper's styled success message.

Bounded Docker log access is specified in the Docker daemon large-log memory.
