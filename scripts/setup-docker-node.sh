#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Docker Node Setup ────────────────────────────────────────
# Installs docker-daemon on a host and enrolls it with the Gateway.
#
# Usage:
#   curl -sSL https://github.com/the-square-labs/gateway/releases/latest/download/setup-docker-node.sh | \
#     sudo bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
#
# Or download and run:
#   bash setup-docker-node.sh --gateway gateway.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ──────────────────────────────────────────────────────────────────────

LOG_FILE="/dev/null"

# ── Colors ───────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
TITLE_TAG='\033[48;2;140;176;132m\033[30m'
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'

# ── Defaults ─────────────────────────────────────────────────────────
GATEWAY_HOST="${GATEWAY_NODE_HOST:-}"
GATEWAY_PORT="${GATEWAY_NODE_PORT:-9443}"
GATEWAY_ADDR="${GATEWAY_NODE_ADDRESS:-}"
ENROLL_TOKEN="${GATEWAY_NODE_TOKEN:-}"
GATEWAY_CERT_SHA256="${GATEWAY_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
DISABLE_CONSOLE="${GATEWAY_NODE_DISABLE_CONSOLE:-0}"
DISABLE_FILES="${GATEWAY_NODE_DISABLE_FILES:-0}"
SECURE_RUNTIME="${GATEWAY_DOCKER_SECURE_RUNTIME:-0}"
RELEASES_API_URL="${GATEWAY_RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"
ARTIFACT_BASE_URL="${GATEWAY_ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"
RUN_USER=""
NON_INTERACTIVE=0
NO_LOGO=0
DRY_RUN=0
GUIDE_ACTIVE=0
APT_UPDATED=0
MANUAL_LAUNCH_TIMEOUT_SECONDS="${GATEWAY_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
OS_VERSION_CODENAME=""
DOCKER_USE_SUDO=0
DOCKER_SYSTEMD_UNIT=""
DOCKER_SOCKET="unix:///var/run/docker.sock"
DOCKER_MODE="${GATEWAY_DOCKER_MODE:-}"
BUILDER_EGRESS_PROFILE="${GATEWAY_BUILDER_EGRESS_PROFILE:-internet}"
BUILDER_RUNTIME_ROOT="/opt/gateway-builder"
BUILDER_RUNTIME_BIN_DIR="${BUILDER_RUNTIME_ROOT}/bin"
BUILDER_RUNTIME_LEGACY_BIN_DIR="${BUILDER_RUNTIME_ROOT}/legacy-bin"
BUILDER_RUNTIME_MANIFEST="${BUILDER_RUNTIME_ROOT}/runtime-manifest"
BUILDER_RUNTIME_PATH="${BUILDER_RUNTIME_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DATABASE_STORAGE_ROOT="${GATEWAY_DATABASE_STORAGE_ROOT:-}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0
MANUAL_FALLBACK_USED=0
DATABASE_PREFLIGHT_DIR=""
DATABASE_PREFLIGHT_MOUNT_DIR=""
DATABASE_PREFLIGHT_LOOP_DEVICE=""
# The directories the storage preflight created, deepest first (newline-separated): a refused preflight removes
# exactly these and leaves every directory it found in place.
DATABASE_PREFLIGHT_CREATED_DIRS=""

# ── Helpers ──────────────────────────────────────────────────────────
log()  {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        echo -e "${BRAND_MINT}│${NC} ${INFO_TAG} INFO ${NC} $*"
    else
        echo -e "${INFO_TAG} INFO ${NC} $*"
    fi
}
warn() { echo -e "${WARN_TAG} WARN ${NC} $*"; }
err()  { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; }
ok()   {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        echo -e "${BRAND_MINT}│${NC} \033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
    else
        echo -e "\033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
    fi
}

die() {
    err "$@"
    echo "" >&2
    echo -e "${ERROR_TAG} ■ ${NC} Installation completed with errors." >&2
    echo "" >&2
    exit 1
}

complete_success() {
    local message="${1:-Installation completed successfully.}"
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        guide_blank
        echo -e "${BRAND_MINT}■${NC} ${BOLD}${message}${NC}"
        echo ""
    else
        echo ""
        echo -e "${BRAND_MINT}■${NC} ${BOLD}${message}${NC}"
        echo ""
    fi
}

complete_incomplete() {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        guide_blank
        echo -e "${YELLOW}■${NC} ${BOLD}Installation not completed.${NC}"
        echo ""
    else
        echo ""
        echo -e "${YELLOW}■${NC} ${BOLD}Installation not completed.${NC}"
        echo ""
    fi
    # An install that was declined or stopped after the summary did not complete: it never exits 0.
    exit 1
}

show_logo() {
    local subtitle="Docker daemon installer"
    [[ "$DOCKER_MODE" == "databases" ]] && subtitle="Database daemon installer"
    [[ "$DOCKER_MODE" == "storage" ]] && subtitle="Storage daemon installer"
    [[ "$DOCKER_MODE" == "builder" ]] && subtitle="Builder daemon installer"
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Gateway Node Setup"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$subtitle"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() {
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "$*"
    else
        echo -e "${BRAND_MINT}│${NC} $*"
    fi
}

guide_blank() {
    [[ "${NO_LOGO:-0}" -eq 1 ]] || echo -e "${BRAND_MINT}│${NC}"
}
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

# Profiles that run the lease watchdog: Docker nodes (Availability) and storage nodes, also the legacy databases
# profile (availability sets of managed databases and storage).
lease_watchdog_profile() {
    [[ "$DOCKER_MODE" == "docker" || "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]]
}

guide_start() {
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "$*"
    else
        GUIDE_ACTIVE=1
        echo -e "${BRAND_MINT}╭${NC} $*"
    fi
}

# A value of the docker-daemon config by its key path (docker.mode, docker.database.storage_root), unquoted, whatever
# indentation the file uses: the installer writes two spaces, and the daemon rewrites the file with four when it drops
# the enrollment token. Status 1 when the key is not there.
docker_config_value() {
    local config_path="$1" want="$2"
    [[ -f "$config_path" ]] || return 1
    awk -v want="$want" -v q="'" '
        /^[[:space:]]*(#.*)?$/ || /^[[:space:]]*-/ { next }
        {
            match($0, /^ */)
            n = RLENGTH
            line = substr($0, n + 1)
            if (line !~ /^[A-Za-z0-9_.-]+:/) next
            key = line
            sub(/:.*/, "", key)
            value = substr(line, length(key) + 2)
            if (value != "" && value !~ /^[ \t]/) next
            while (depth > 0 && indent[depth] >= n) depth--
            depth++
            indent[depth] = n
            keys[depth] = key
            path = keys[1]
            for (i = 2; i <= depth; i++) path = path "." keys[i]
            if (path != want) next
            sub(/^[ \t]+/, "", value)
            sub(/[ \t]+#.*$/, "", value)
            sub(/[ \t]+$/, "", value)
            if (length(value) >= 2 && (substr(value, 1, 1) == "\"" || substr(value, 1, 1) == q) && substr(value, length(value)) == substr(value, 1, 1))
                value = substr(value, 2, length(value) - 2)
            print value
            found = 1
            exit
        }
        END { exit found ? 0 : 1 }
    ' "$config_path"
}

# The storage root an enrolled storage or database node runs with ('' without one): a re-run keeps it by default.
configured_database_storage_root() {
    local config_path="/etc/docker-daemon/config.yaml" mode
    mode=$(docker_config_value "$config_path" docker.mode 2>/dev/null) || return 0
    [[ "$mode" == "databases" || "$mode" == "storage" ]] || return 0
    docker_config_value "$config_path" docker.database.storage_root 2>/dev/null || echo "/var/lib/docker-daemon/databases"
}

# The node kind of a restricted profile, for messages: storage, or the legacy databases.
restricted_node_kind() {
    if [[ "$DOCKER_MODE" == "storage" ]]; then echo "Storage"; else echo "Database"; fi
}

database_storage_root_for_mount() {
    local mountpoint="$1"
    if [[ "$mountpoint" == "/" ]]; then
        echo "/var/lib/docker-daemon/databases"
    else
        echo "${mountpoint%/}/gateway-databases"
    fi
}

database_storage_capability_hint() {
    local virtualization=""
    if command_exists systemd-detect-virt; then
        virtualization=$(systemd-detect-virt 2>/dev/null || true)
    fi
    if [[ "$virtualization" == "lxc" ]]; then
        printf '%s' "This host is an LXC guest. Configure the outer host to pass /dev/loop-control and a loop-device pool, allow loop block devices and mounts, or use a VM/bare-metal database node."
        return
    fi
    printf '%s' "The database profile requires usable loop devices plus permission to mount ext4 filesystems."
}

cleanup_database_preflight() {
    local previous_status=$?
    set +e
    if [[ -n "$DATABASE_PREFLIGHT_MOUNT_DIR" ]] && command_exists mountpoint && mountpoint -q "$DATABASE_PREFLIGHT_MOUNT_DIR"; then
        umount "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || true
    fi
    if [[ -n "$DATABASE_PREFLIGHT_LOOP_DEVICE" ]] && command_exists losetup; then
        losetup -d "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || true
    fi
    if [[ -n "$DATABASE_PREFLIGHT_DIR" ]]; then
        rm -f "$DATABASE_PREFLIGHT_DIR/mnt/.write-test" "$DATABASE_PREFLIGHT_DIR/test.img" >/dev/null 2>&1 || true
        rmdir "$DATABASE_PREFLIGHT_DIR/mnt" "$DATABASE_PREFLIGHT_DIR" >/dev/null 2>&1 || true
    fi
    local created
    while IFS= read -r created; do
        [[ -z "$created" ]] || rmdir -- "$created" >/dev/null 2>&1 || true
    done <<< "$DATABASE_PREFLIGHT_CREATED_DIRS"
    DATABASE_PREFLIGHT_DIR=""
    DATABASE_PREFLIGHT_MOUNT_DIR=""
    DATABASE_PREFLIGHT_LOOP_DEVICE=""
    DATABASE_PREFLIGHT_CREATED_DIRS=""
    set -e
    return "$previous_status"
}

trap cleanup_database_preflight EXIT

select_database_storage() {
    [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]] || return 0
    # A re-run keeps the storage root the node runs with unless another is given.
    [[ -n "$DATABASE_STORAGE_ROOT" ]] || DATABASE_STORAGE_ROOT=$(configured_database_storage_root)
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        [[ -n "$DATABASE_STORAGE_ROOT" ]] || DATABASE_STORAGE_ROOT="/var/lib/docker-daemon/databases"
        return
    fi

    selector_title "Database images storage:"
    local -a mounts=() options=()
    local target source fstype candidate entry index mountpoint free storage_default=1 storage_choice custom_choice
    if command_exists findmnt; then
        while IFS=' ' read -r target source fstype; do
            # Database images need a Linux filesystem with room: not a pseudo or image filesystem, and not the boot or
            # EFI system partition (small, often vfat).
            case "$fstype" in tmpfs|devtmpfs|proc|sysfs|cgroup*|overlay|squashfs|ramfs|nsfs|vfat|msdos|fat|exfat) continue ;; esac
            case "$target" in /proc*|/sys*|/dev*|/run*|/snap*|/boot|/boot/*) continue ;; esac
            [[ -d "$target" ]] || continue
            candidate=$(database_storage_root_for_mount "$target")
            mounts+=("$target|$candidate")
        done < <(findmnt -rn -o TARGET,SOURCE,FSTYPE)
    fi
    if [[ "${#mounts[@]}" -eq 0 ]]; then
        mounts=("/|/var/lib/docker-daemon/databases")
    fi
    index=1
    for entry in "${mounts[@]}"; do
        candidate="${entry#*|}"
        if [[ -n "$DATABASE_STORAGE_ROOT" && "$candidate" == "$DATABASE_STORAGE_ROOT" ]]; then
            storage_default="$index"
            break
        fi
        index=$((index + 1))
    done
    index=1
    for entry in "${mounts[@]}"; do
        mountpoint="${entry%%|*}"
        candidate="${entry#*|}"
        free=$(df -hP "$mountpoint" | awk 'NR==2 {print $4}')
        options+=("${candidate}  (${mountpoint}, ${free} free)")
        index=$((index + 1))
    done
    custom_choice=$index
    options+=("Custom path")
    storage_choice=$(prompt_choice "Choose disk" "$storage_default" "${options[@]}")
    [[ "$storage_choice" =~ ^[0-9]+$ ]] && (( storage_choice >= 1 && storage_choice <= "$custom_choice" )) || die "Invalid storage choice: $storage_choice"
    if [[ "$storage_choice" -eq "$custom_choice" ]]; then
        guide_blank
        DATABASE_STORAGE_ROOT=$(prompt_input "Database images storage path" "${DATABASE_STORAGE_ROOT:-/var/lib/docker-daemon/databases}")
        [[ -n "$DATABASE_STORAGE_ROOT" ]] || die "Database storage path is required"
        guide_blank
    else
        DATABASE_STORAGE_ROOT="${mounts[$((storage_choice - 1))]#*|}"
    fi
    guide "${GRAY}Selected: ${NC}${DATABASE_STORAGE_ROOT}"
    guide_blank
}

# Creates the storage root and the parents it lacks, and records each directory it created (deepest first) for the
# cleanup of a refused preflight.
create_database_storage_root() {
    local dir="$1" missing=""
    while [[ "$dir" == /?* && ! -e "$dir" && ! -L "$dir" ]]; do
        missing+="${dir}"$'\n'
        dir=$(dirname -- "$dir")
    done
    DATABASE_PREFLIGHT_CREATED_DIRS="$missing"
    mkdir -p -- "$1" || die "Could not create the storage root ${1}."
}

preflight_database_storage() {
    [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]] || return 0
    [[ -n "$DATABASE_STORAGE_ROOT" && "$DATABASE_STORAGE_ROOT" == /* && "$DATABASE_STORAGE_ROOT" != "/" ]] || die "Database storage root is invalid."
    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "Dry run: skipping disposable storage preflight for ${DATABASE_STORAGE_ROOT}"
        return
    fi
    local required=(awk blockdev chmod df fallocate grep losetup mkfs.ext4 mount mountpoint mktemp resize2fs rm rmdir stat umount)
    local cmd image available_kib available_loop allocated_bytes loop_output
    for cmd in "${required[@]}"; do command_exists "$cmd" || die "Required command '$cmd' is missing; refusing enrollment."; done
    [[ ! -L "$DATABASE_STORAGE_ROOT" ]] || die "Refusing symlink storage root: ${DATABASE_STORAGE_ROOT}"
    if [[ ! -e "$DATABASE_STORAGE_ROOT" ]]; then
        create_database_storage_root "$DATABASE_STORAGE_ROOT"
    fi
    [[ -d "$DATABASE_STORAGE_ROOT" && -w "$DATABASE_STORAGE_ROOT" ]] || die "Storage root is not writable: ${DATABASE_STORAGE_ROOT}"
    available_kib=$(df -Pk -- "$DATABASE_STORAGE_ROOT" | awk 'NR==2 {print $4}')
    [[ "$available_kib" =~ ^[0-9]+$ && "$available_kib" -ge 163840 ]] || die "Storage root needs at least 160 MiB free to validate the minimum database image lifecycle."

    if ! available_loop=$(losetup -f 2>>"$LOG_FILE"); then
        die "No free loop device is available. $(database_storage_capability_hint)"
    fi
    [[ "$available_loop" == /dev/loop* && -b "$available_loop" ]] || die "losetup returned an unusable loop device. $(database_storage_capability_hint)"

    DATABASE_PREFLIGHT_DIR=$(mktemp -d "$DATABASE_STORAGE_ROOT/.gateway-db-preflight.XXXXXX")
    DATABASE_PREFLIGHT_MOUNT_DIR="$DATABASE_PREFLIGHT_DIR/mnt"
    image="$DATABASE_PREFLIGHT_DIR/test.img"
    mkdir "$DATABASE_PREFLIGHT_MOUNT_DIR"

    fallocate -l 64M "$image" >>"$LOG_FILE" 2>&1 || die "Could not preallocate a fixed-size database image."
    [[ "$(stat -c '%s' "$image")" -eq 67108864 ]] || die "Preflight image has the wrong logical size."
    allocated_bytes=$(( $(stat -c '%b' "$image") * 512 ))
    [[ "$allocated_bytes" -ge 67108864 ]] || die "Storage filesystem created a sparse image instead of reserving the requested capacity."
    mkfs.ext4 -q -F "$image" >>"$LOG_FILE" 2>&1 || die "Could not format the disposable database image as ext4."

    if loop_output=$(losetup --find --show --nooverlap "$image" 2>>"$LOG_FILE"); then
        DATABASE_PREFLIGHT_LOOP_DEVICE=$(printf '%s\n' "$loop_output" | awk '/^\/dev\/loop[0-9]+$/ { print; exit }')
    else
        DATABASE_PREFLIGHT_LOOP_DEVICE=$(losetup -f 2>>"$LOG_FILE") || die "No free loop device is available. $(database_storage_capability_hint)"
        losetup "$DATABASE_PREFLIGHT_LOOP_DEVICE" "$image" >>"$LOG_FILE" 2>&1 || die "Could not attach the disposable database image. $(database_storage_capability_hint)"
    fi
    [[ -n "$DATABASE_PREFLIGHT_LOOP_DEVICE" && -b "$DATABASE_PREFLIGHT_LOOP_DEVICE" ]] || die "losetup did not attach a usable loop device. $(database_storage_capability_hint)"

    mount -o noatime "$DATABASE_PREFLIGHT_LOOP_DEVICE" "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || die "Could not mount the disposable ext4 database image. $(database_storage_capability_hint)"
    printf 'gateway-db-preflight\n' > "$DATABASE_PREFLIGHT_MOUNT_DIR/.write-test" || die "Mounted database storage is not writable."

    fallocate -l 128M "$image" >>"$LOG_FILE" 2>&1 || die "Could not grow the disposable database image."
    losetup -c "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Loop device does not support capacity refresh."
    [[ "$(blockdev --getsize64 "$DATABASE_PREFLIGHT_LOOP_DEVICE")" -eq 134217728 ]] || die "Loop device did not observe expanded image capacity."
    resize2fs "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Could not grow the mounted ext4 database filesystem."

    umount "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || die "Could not unmount the disposable database image."
    DATABASE_PREFLIGHT_MOUNT_DIR=""
    losetup -d "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Could not detach the disposable loop device."
    DATABASE_PREFLIGHT_LOOP_DEVICE=""
    rm -f "$image"
    rmdir "$DATABASE_PREFLIGHT_DIR/mnt" "$DATABASE_PREFLIGHT_DIR"
    DATABASE_PREFLIGHT_DIR=""
    DATABASE_PREFLIGHT_CREATED_DIRS=""
    ok "Storage preflight passed for ${DATABASE_STORAGE_ROOT}"
}

preflight_database_docker() {
    [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]] || return 0
    docker_run info >>"$LOG_FILE" 2>&1 || die "Docker Engine is not reachable; refusing database-node enrollment."
    [[ "$DOCKER_SOCKET" == unix://* ]] || die "Database nodes require a local Docker Engine socket; refusing remote Docker context '${DOCKER_SOCKET}'."
    [[ -S "${DOCKER_SOCKET#unix://}" ]] || die "Docker Engine socket is unavailable at ${DOCKER_SOCKET#unix://}."
    ok "Docker Engine preflight passed (${DOCKER_SOCKET})"
}

# The Secure Link connector and the managed workloads run with memory, CPU and pids limits (the connector sets all
# three), so Docker has to be able to give its containers those cgroup controllers. On an LXC guest with OpenRC the
# root cgroup can have none enabled (cgroup.subtree_control is empty and OpenRC's cgroups service cannot change that
# while every process sits in the root cgroup): Docker and plain containers still start, but a container with limits
# fails with "pids.max: no such file or directory", and the node enrolls without its connectors working.
preflight_docker_cgroup_controllers() {
    [[ "$DOCKER_MODE" != "builder" ]] || return 0
    local info version driver memory_limit pids_limit cpu_quota controllers_file controller
    local missing=()
    if ! info=$(docker_run info --format '{{.CgroupVersion}} {{.CgroupDriver}} {{.MemoryLimit}} {{.PidsLimit}} {{.CPUCfsQuota}}' 2>>"$LOG_FILE"); then
        warn "Could not read the cgroup setup from Docker; skipping the container limits check."
        return 0
    fi
    IFS=' ' read -r version driver memory_limit pids_limit cpu_quota <<< "$info"
    [[ "$memory_limit" == "true" ]] || missing+=(memory)
    [[ "$pids_limit" == "true" ]] || missing+=(pids)
    [[ "$cpu_quota" == "true" ]] || missing+=(cpu)
    # Docker with the cgroupfs driver on cgroup v2 creates its containers below /sys/fs/cgroup/docker, which has the
    # controllers the root cgroup passes down. docker info reports the controllers the kernel offers, not those.
    if [[ "$version" == "2" && "$driver" == "cgroupfs" ]]; then
        controllers_file=/sys/fs/cgroup/docker/cgroup.controllers
        [[ -r "$controllers_file" ]] || controllers_file=/sys/fs/cgroup/cgroup.subtree_control
        if [[ -r "$controllers_file" ]]; then
            for controller in memory pids cpu; do
                [[ " $(cat "$controllers_file") " == *" ${controller} "* ]] || missing+=("$controller")
            done
        fi
    fi
    [[ "${#missing[@]}" -gt 0 ]] || return 0
    missing=($(printf '%s\n' "${missing[@]}" | sort -u))
    local IFS=' '
    err "Docker cannot give containers the cgroup controllers: ${missing[*]}."
    err "The Secure Link connector and managed workloads run with memory, CPU and pids limits; with these controllers missing"
    err "they fail to start, although the node would enroll. On Alpine with OpenRC in an LXC container, the host cgroup setup has"
    err "to enable them. Check: cat /sys/fs/cgroup/cgroup.subtree_control /sys/fs/cgroup/docker/cgroup.controllers (see docs/nodes.md)."
    die "Docker does not provide the cgroup controllers this node needs; nothing was enrolled."
}

# What the Build Worker profile needs from the host itself; checked before the installer changes or downloads anything.
preflight_builder_host() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    has_systemd || die "Builder nodes require systemd to supervise the isolated containerd and BuildKit services."
}

preflight_builder_runtime() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    local bundled=(containerd ctr buildkitd buildctl runc containerd-shim-runc-v2 syft grype)
    local system=(git iptables getent)
    local missing=() binary
    for binary in "${bundled[@]}"; do
        [[ -f "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && ! -L "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && -x "${BUILDER_RUNTIME_BIN_DIR}/${binary}" ]] || \
            missing+=("${BUILDER_RUNTIME_BIN_DIR}/${binary}")
    done
    for binary in "${system[@]}"; do
        command_exists "$binary" || missing+=("$binary")
    done
    if [[ "${#missing[@]}" -gt 0 ]]; then
        die "Builder runtime is incomplete. Missing: ${missing[*]}. Re-run the Gateway builder installer before enrollment."
    fi
    if [[ "$BUILDER_EGRESS_PROFILE" == "internet" ]]; then
        local plugin
        for plugin in bridge host-local firewall loopback; do
            [[ -x "/opt/gateway-builder/cni/bin/${plugin}" ]] || die "Builder internet egress requires CNI plugin ${plugin} in /opt/gateway-builder/cni/bin."
        done
    fi
    ok "Builder runtime preflight passed (BuildKit + dedicated containerd + runc)"
}

ensure_builder_system_packages() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    case "$ARCH" in
        amd64|arm64) ;;
        *) die "Builder runtime is supported only on amd64 and arm64 hosts." ;;
    esac
    local missing=() binary
    for binary in git iptables getent tar gzip sha256sum; do
        command_exists "$binary" || missing+=("$binary")
    done
    [[ "${#missing[@]}" -gt 0 ]] || return 0
    log "Installing Build Worker system dependencies..."
    case "$OS_ID" in
        ubuntu|debian)
            install_system_packages git iptables libc-bin tar gzip coreutils ca-certificates
            ;;
        alpine)
            install_system_packages git iptables musl-utils tar gzip coreutils ca-certificates
            ;;
        fedora|rhel|centos|centos_stream)
            install_system_packages git iptables glibc-common tar gzip coreutils ca-certificates
            ;;
        *) die "Automatic Build Worker dependency installation is unsupported on ${OS_ID}." ;;
    esac
}

guide_end() {
    :
}

summary_start() {
    guide_blank
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "${BRAND_MINT}◆${NC} ${BOLD}Configuration Summary${NC}"
    else
        echo -e "${BRAND_MINT}◆${NC} ${BOLD}Configuration Summary${NC}"
    fi
    guide_blank
}

summary_row() {
    guide "  $1"
}

summary_end() {
    guide_blank
}

# Without -y the installer asks on the terminal. When the terminal cannot be read (no controlling terminal, or the
# read fails with EIO under sudo's pty while stdout is a pipe) nothing was answered, and a default must not stand in
# for an answer: the run counts as non-interactive, which cannot approve what it asks about.
refuse_unanswered_prompt() {
    echo "" >&2
    die "Cannot read an answer from the terminal for: $1. Run the installer from a terminal (not through a pipe such as '| tee'), or pass -y to install non-interactively."
}

prompt_input() {
    local prompt="$1"
    local default="${2:-}"
    local result
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    if [ -n "$default" ]; then
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" result < /dev/tty || refuse_unanswered_prompt "$prompt"
    else
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty || refuse_unanswered_prompt "$prompt"
    fi
    echo "${result:-$default}"
}

prompt_secret() {
    local prompt="$1"
    local result
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo ""
        return
    fi
    read -rs -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty || refuse_unanswered_prompt "$prompt"
    echo "" >&2
    echo "$result"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-Y}"
    local reply
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        [[ "$default" =~ ^[yY]$ ]]
        return
    fi
    if [[ "$default" == "Y" ]]; then
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [Y/n]: ${NC}")" reply < /dev/tty || refuse_unanswered_prompt "$prompt"
        reply="${reply:-Y}"
    else
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [y/N]: ${NC}")" reply < /dev/tty || refuse_unanswered_prompt "$prompt"
        reply="${reply:-N}"
    fi
    [[ "$reply" =~ ^[yY]$ ]]
}

prompt_choice() {
    local prompt="$1"
    local default="$2"
    shift 2
    local -a options=("$@")
    local reply selected=0 key sequence tty="/dev/tty" tty_device="" supports_arrow_menu=1 index
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    tty_device=$(tty < "$tty" 2>/dev/null || true)
    case "$tty_device" in
        /dev/ttyS*|/dev/hvc*|/dev/xvc*|/dev/console) supports_arrow_menu=0 ;;
    esac
    if [[ "$supports_arrow_menu" -eq 1 && "${#options[@]}" -gt 0 && -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]]; then
        selected=$((default - 1))
        (( selected >= 0 && selected < ${#options[@]} )) || selected=0
        render_menu() {
            local resolved="${1:-0}" rail=" "
            [[ "$resolved" -eq 1 ]] && rail="│"
            for index in "${!options[@]}"; do
                if [[ "$index" -eq "$selected" ]]; then
                    printf "${BRAND_MINT}%s${NC}  ${BRAND_MINT}●${NC} ${BOLD}%d) %s${NC}\033[K\n" "$rail" "$((index + 1))" "${options[$index]}" > "$tty"
                else
                    printf "${BRAND_MINT}%s${NC}  ${GRAY}○${NC} %d) %s\033[K\n" "$rail" "$((index + 1))" "${options[$index]}" > "$tty"
                fi
            done
            [[ "$resolved" -eq 1 ]] || printf "  ${GRAY}Use ↑/↓ and Enter${NC}\033[K\n" > "$tty"
        }
        render_menu
        while true; do
            if ! IFS= read -rsn1 key < "$tty" 2>/dev/null; then
                printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
                render_menu 1
                printf "\r\033[K" > "$tty"
                break
            fi
            if [[ "$key" == $'\e' ]]; then
                IFS= read -rsn2 sequence < "$tty" 2>/dev/null || sequence=""
                key+="$sequence"
            fi
            case "$key" in
                $'\e[A') selected=$(( (selected + ${#options[@]} - 1) % ${#options[@]} )) ;;
                $'\e[B') selected=$(( (selected + 1) % ${#options[@]} )) ;;
                '')
                    printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
                    render_menu 1
                    printf "\r\033[K" > "$tty"
                    echo "$((selected + 1))"
                    return
                    ;;
                *) continue ;;
            esac
            printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
            render_menu
        done
    fi
    read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty || refuse_unanswered_prompt "$prompt"
    echo "${reply:-$default}"
}

need_root() {
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (or with sudo)"
    fi
}

detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_LIKE="${ID_LIKE:-$OS_ID}"
        OS_VERSION_CODENAME="${VERSION_CODENAME:-}"
    else
        OS_ID="unknown"
        OS_LIKE="unknown"
    fi
}

detect_arch() {
    local machine
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l)        ARCH="armv7" ;;
        *) die "Unsupported architecture: $machine" ;;
    esac
}

command_exists() { command -v "$1" &>/dev/null; }

# Keeps the backup just taken and removes the older ones of the same file, so repeated upgrades do not pile up copies.
prune_older_backups() {
    local target="$1" keep="$2" old
    for old in "${target}".backup.*; do
        [[ -f "$old" && "$old" != "$keep" && "$old" =~ \.backup\.[0-9]{8}_[0-9]{6}$ ]] || continue
        rm -f -- "$old"
    done
}
has_systemd() { command_exists systemctl && [[ -d /run/systemd/system ]]; }
has_openrc() { command_exists rc-service && command_exists rc-update; }

# ── Non-root mode (standard profile) ─────────────────────────────────
# A root daemon keeps its binary in /usr/local/bin. A daemon running as its own user must be able to replace its binary
# when it updates itself, so the binary lives in a directory that user owns and /usr/local/bin holds a root-owned wrapper.
DOCKER_DAEMON_BIN_LINK="/usr/local/bin/docker-daemon"
DOCKER_DAEMON_OWN_DIR="/usr/local/lib/docker-daemon"
DOCKER_DAEMON_OWN_BINARY="${DOCKER_DAEMON_OWN_DIR}/bin/docker-daemon"
DOCKER_DAEMON_OWN_HOST_IDENTITY="/var/lib/docker-daemon/host-identity"
SHARED_HOST_IDENTITY="/var/lib/gateway/host-identity"
# Docker trusts the daemon's registry proxy through this directory; root creates it on demand.
DOCKER_REGISTRY_PROXY_TRUST_DIR="/etc/docker/certs.d/127.0.0.1:5443"

# Reads an installed binary's version. A binary another user can replace is never run as root.
daemon_binary_version() {
    local binary="$1" owner
    owner=$(stat -Lc '%U' "$binary" 2>/dev/null || echo root)
    if [[ "$owner" == "root" ]]; then
        "$binary" version 2>/dev/null | awk '{print $2}'
    elif command_exists runuser; then
        runuser -u "$owner" -- "$binary" version 2>/dev/null | awk '{print $2}'
    else
        return 1
    fi
}

# In non-root mode /usr/local/bin/<daemon> is a root-owned wrapper, not the binary: the binary belongs to the service
# user, who replaces it on update, so root must never execute it. The wrapper switches a root caller to that user.
DAEMON_WRAPPER_MARK="# gateway-daemon-wrapper: runs the service user's binary, never as root"
write_daemon_wrapper() {
    local command_path="$1" binary="$2" temporary
    temporary=$(mktemp "$(dirname "$command_path")/.gateway-daemon-wrapper.XXXXXX") || return 1
    if ! cat >"$temporary" <<WRAPPER
#!/bin/sh
${DAEMON_WRAPPER_MARK}
if [ "\$(id -u)" = 0 ]; then
    if command -v runuser >/dev/null 2>&1; then
        exec runuser -u '${RUN_USER}' -- '${binary}' "\$@"
    elif command -v setpriv >/dev/null 2>&1; then
        exec setpriv --reuid='${RUN_USER}' --regid='${RUN_GROUP}' --init-groups -- '${binary}' "\$@"
    fi
    echo "Run this command as ${RUN_USER}: ${binary} belongs to that user and root never runs it." >&2
    exit 1
fi
exec '${binary}' "\$@"
WRAPPER
    then
        rm -f "$temporary"
        return 1
    fi
    if ! chmod 0755 "$temporary" || ! chown 0:0 "$temporary" || ! mv -f "$temporary" "$command_path"; then
        rm -f "$temporary"
        return 1
    fi
}

is_daemon_wrapper() {
    [[ -f "$1" && ! -L "$1" ]] && grep -Fqx "$DAEMON_WRAPPER_MARK" "$1" 2>/dev/null
}

run_as_run_user() {
    if [[ "$RUN_USER" == "root" ]]; then
        "$@"
    elif command_exists runuser; then
        runuser -u "$RUN_USER" -g "$RUN_GROUP" -- "$@"
    elif command_exists setpriv; then
        setpriv "--reuid=${RUN_USER}" "--regid=${RUN_GROUP}" --init-groups -- "$@"
    else
        # Files written as root here are handed to the run user afterwards.
        "$@"
    fi
}

# Root-only installer steps (Secure Runtime) never run the binary the run user owns, which that user can replace: they
# run a copy downloaded and verified in this run, in a directory only root can reach.
ROOT_DAEMON_COPY=""
ROOT_DAEMON_BINARY=""
prepare_root_daemon_binary() {
    if [[ "$RUN_USER" == "root" ]]; then
        ROOT_DAEMON_BINARY="$DOCKER_DAEMON_BIN_LINK"
        return
    fi
    [[ -z "$ROOT_DAEMON_BINARY" ]] || return 0
    ROOT_DAEMON_COPY=$(mktemp -d /tmp/gateway-docker-daemon-root.XXXXXX) || die "Could not stage the docker-daemon binary."
    curl -fsSL "$DOWNLOAD_URL" -o "${ROOT_DAEMON_COPY}/docker-daemon" >>"$LOG_FILE" 2>&1 \
        || die "Could not download docker-daemon ${RESOLVED_DAEMON_VERSION} for the root-only setup steps."
    verify_checksum "${ROOT_DAEMON_COPY}/docker-daemon" "docker-daemon-linux-${ARCH}"
    chmod 0700 "${ROOT_DAEMON_COPY}/docker-daemon"
    ROOT_DAEMON_BINARY="${ROOT_DAEMON_COPY}/docker-daemon"
}

# A non-root daemon reaches Docker only through the socket; check it before anything is started.
preflight_run_user_docker_access() {
    [[ "$RUN_USER" != "root" && "$DOCKER_MODE" == "docker" ]] || return 0
    local socket="${DOCKER_SOCKET#unix://}"
    [[ "$DOCKER_SOCKET" == unix://* ]] || return 0
    if ! runuser -u "$RUN_USER" -- test -r "$socket" -a -w "$socket" 2>/dev/null; then
        die "User '${RUN_USER}' cannot use the Docker socket ${socket}. Add it to the group that owns the socket (usually 'docker'), or install docker-daemon as root (--user root)."
    fi
    ok "Docker socket is usable by ${RUN_USER}"
}

# Hands the daemon everything it writes: its configuration, state and binary, and Docker's trust directory for the
# daemon's registry proxy. A daemon switched back to root gets back what its previous user owned there; connector
# socket directories and workload data keep their owners, and the daemon brings the connectors over itself.
grant_daemon_paths_to_run_user() {
    local path
    # While a switch away from a non-root user waits for the daemon to stop, that user keeps what it owns.
    [[ "$RUN_USER_SWITCH_PENDING" -eq 0 ]] || return 0
    hand_lease_records_to_run_user
    if [[ "$RUN_USER" == "root" ]]; then
        return_paths_to_root /etc/docker-daemon /var/lib/docker-daemon "$DOCKER_DAEMON_OWN_DIR" "$DOCKER_REGISTRY_PROXY_TRUST_DIR"
        return
    fi
    for path in /etc/docker-daemon /var/lib/docker-daemon "$DOCKER_DAEMON_OWN_DIR"; do
        [[ ! -e "$path" ]] || chown -hR "${RUN_USER}:${RUN_GROUP}" "$path"
    done
    if [[ "$DOCKER_MODE" == "docker" ]]; then
        install -d -m 0755 "$(dirname "$DOCKER_REGISTRY_PROXY_TRUST_DIR")"
        install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$DOCKER_REGISTRY_PROXY_TRUST_DIR"
    fi
}

# The lease watchdog's deadline records (tmpfs) belong to the daemon user, which writes and reads them. A run-user switch
# hands the directory and the records the previous daemon wrote to the new user before it starts, in both directions: a
# daemon that cannot read them cannot recover its running Availability copies, and the watchdog fences them at their
# deadline (a watchdog of an earlier release hands over only the directory). Only the directory and the singly linked
# record files in it change owner.
LEASE_RECORDS_DIR="/run/gateway-lease-watchdog/records"
hand_lease_records_to_run_user() {
    [[ -d "$LEASE_RECORDS_DIR" && ! -L "$LEASE_RECORDS_DIR" ]] || return 0
    chown -h "${RUN_USER}:${RUN_GROUP}" "$LEASE_RECORDS_DIR" 2>>"$LOG_FILE" || warn "Could not hand the lease watchdog records to ${RUN_USER}."
    find "$LEASE_RECORDS_DIR" -mindepth 1 -maxdepth 1 -type f -links 1 -name '*.json' \
        -exec chown -h "${RUN_USER}:${RUN_GROUP}" {} + 2>>"$LOG_FILE" || warn "Could not hand the lease watchdog records to ${RUN_USER}."
}

# The user a previous install ran the daemon as: the first owner other than root of its configuration, state or own binary
# directory (root without one), so a switch back to root is announced and handled even when one of them is root's.
previous_run_uid() {
    local path uid
    for path in "$@"; do
        uid=$(stat -c '%u' "$path" 2>/dev/null) || continue
        [[ "$uid" == 0 ]] || { echo "$uid"; return 0; }
    done
    echo 0
}
PREVIOUS_RUN_UID=$(previous_run_uid /etc/docker-daemon /var/lib/docker-daemon "$DOCKER_DAEMON_OWN_DIR")

# Gives root every entry in the paths that the previous non-root user owns; entries of other owners keep theirs.
return_paths_to_root() {
    local path
    [[ "$PREVIOUS_RUN_UID" != 0 ]] || return 0
    for path in "$@"; do
        [[ ! -e "$path" ]] || find "$path" -xdev -user "$PREVIOUS_RUN_UID" -exec chown -h 0:0 {} +
    done
}

# A daemon that moves to another user says so and gets a new launcher: the launcher copies
# in its state directory were written by that user, and no other user may run them. It is stopped for that, but as late
# as possible (finish_run_user_switch, right before the new process starts), so the traffic it serves is not left without
# a daemon while the installer downloads and prepares; the old process keeps running with what its user owns until then.
# A node that enrolls again (a token) runs steps as the new user first, so its daemon is stopped at once.
RUN_USER_SWITCH_PENDING=0
prepare_run_user_switch() {
    # A fresh install has nothing to switch. A daemon that ran as root is stopped before its files change owner too:
    # it keeps rewriting them (atomically, as root) while it runs, and the new user could not read them.
    [[ "$PREVIOUS_RUN_UID" != 0 || -d /etc/docker-daemon ]] || return 0
    [[ "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "docker-daemon ran as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); switching it to ${RUN_USER}..."
    if [[ "$EXISTING_ENROLLED" -eq 1 ]]; then
        RUN_USER_SWITCH_PENDING=1
        return 0
    fi
    stop_daemon_service || die "Could not stop docker-daemon to switch its user."
    rm -rf /var/lib/docker-daemon/launcher
}

# systemd drops a unit's file descriptor store when the unit stops (not when it restarts), and the daemon that stops hands
# its link sockets to that store for the next process. The store is kept for the switch, through the stop, the ownership
# change and the start, so connections made meanwhile wait in the sockets' backlog instead of being reset.
FD_STORE_HOLD=/run/systemd/system/docker-daemon.service.d/zz-run-user-switch.conf
hold_fd_store() {
    has_systemd || return 0
    [[ -f /etc/systemd/system/docker-daemon.service ]] || return 0
    install -d -m 0755 "$(dirname "$FD_STORE_HOLD")" || return 0
    printf '[Service]\nFileDescriptorStorePreserve=yes\n' > "$FD_STORE_HOLD" || return 0
    systemctl daemon-reload >>"$LOG_FILE" 2>&1 || true
}

release_fd_store_hold() {
    [[ -f "$FD_STORE_HOLD" ]] || return 0
    rm -f "$FD_STORE_HOLD"
    rmdir "$(dirname "$FD_STORE_HOLD")" 2>/dev/null || true
    systemctl daemon-reload >>"$LOG_FILE" 2>&1 || true
}

# The switch away from a non-root user: the old daemon is stopped only now (it hands its link sockets over while it still
# owns its state), then the launcher copies it wrote are removed and everything it owned goes to the new user. The next
# process starts right after, from start_daemon.
finish_run_user_switch() {
    [[ "$RUN_USER_SWITCH_PENDING" -eq 1 ]] || return 0
    RUN_USER_SWITCH_PENDING=0
    log "Stopping docker-daemon to switch its user..."
    hold_fd_store
    stop_daemon_service || { release_fd_store_hold; die "Could not stop docker-daemon to switch its user."; }
    rm -rf /var/lib/docker-daemon/launcher
    grant_daemon_paths_to_run_user
}

stop_daemon_service() {
    if has_systemd; then
        [[ ! -f /etc/systemd/system/docker-daemon.service ]] || systemctl stop docker-daemon >>"$LOG_FILE" 2>&1
    elif has_openrc; then
        [[ ! -f /etc/init.d/docker-daemon ]] || rc-service --ifstarted docker-daemon stop >>"$LOG_FILE" 2>&1
    else
        stop_manual_launcher /var/lib/docker-daemon/launcher docker
    fi
}

new_host_identity() {
    local value
    if [[ -r /proc/sys/kernel/random/uuid ]]; then
        value=$(cat /proc/sys/kernel/random/uuid) || return 1
    else
        value=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n') || return 1
        value="${value:0:8}-${value:8:4}-4${value:13:3}-$(printf '%x' $(( (16#${value:16:1} & 3) | 8 )))${value:17:3}-${value:20:12}"
    fi
    printf '%s\n' "$value"
}

# A daemon running as its own user cannot read the host identity that root daemons share (root-owned, mode 0600). It
# gets a copy of that same identity in its own state directory, so Gateway still sees one host and the shared file
# keeps its owner and mode. Without a shared identity yet, one is created there exactly as a root daemon would.
seed_host_identity_copy() {
    local shared="$1" copy="$2" identity="" temporary
    local pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if [[ -f "$copy" && ! -L "$copy" ]]; then
        identity=$(tr -d '[:space:]' <"$copy")
        [[ ! "$identity" =~ $pattern ]] || return 0
        identity=""
    fi
    if [[ -f "$shared" && ! -L "$shared" ]]; then
        identity=$(tr -d '[:space:]' <"$shared")
    elif [[ -e "$shared" || -L "$shared" ]]; then
        err "${shared} is not a regular file; fix it and run the installer again."
        return 1
    fi
    if [[ -z "$identity" && ! -e "$shared" ]]; then
        identity=$(new_host_identity) || return 1
        [[ -d "$(dirname "$shared")" ]] || mkdir -p -m 0700 "$(dirname "$shared")" || return 1
        temporary=$(mktemp "$(dirname "$shared")/.host-identity-XXXXXX") || return 1
        # Publish complete contents without replacing an identity another daemon wrote meanwhile.
        if ! printf '%s\n' "$identity" >"$temporary" || ! ln "$temporary" "$shared" 2>/dev/null; then
            identity=$(tr -d '[:space:]' <"$shared" 2>/dev/null || true)
        fi
        rm -f "$temporary"
    fi
    if [[ ! "$identity" =~ $pattern ]]; then
        err "The host identity at ${shared} is not valid; fix it and run the installer again."
        return 1
    fi
    temporary=$(mktemp "$(dirname "$copy")/.host-identity-XXXXXX") || return 1
    if ! printf '%s\n' "$identity" >"$temporary" || ! chmod 0600 "$temporary" || ! mv -f "$temporary" "$copy"; then
        rm -f "$temporary"
        return 1
    fi
}

# Points the daemon configuration at the host identity copy; the rest of the file is kept as written.
set_config_host_identity_path() {
    local config="$1" path="$2" temporary
    [[ -f "$config" && ! -L "$config" ]] || return 1
    grep -qx "host_identity_path: \"${path}\"" "$config" && return 0
    temporary=$(mktemp) || return 1
    grep -v '^host_identity_path:' "$config" >"$temporary" || true
    printf 'host_identity_path: "%s"\n' "$path" >>"$temporary"
    # Rewrite in place so the file keeps its owner and mode.
    cat "$temporary" >"$config" || { rm -f "$temporary"; return 1; }
    rm -f "$temporary"
}

# A daemon running as its own user enrolls with its copy of the host identity and owns everything it writes.
prepare_run_user_identity() {
    if [[ "$RUN_USER" == "root" ]]; then
        clear_config_host_identity_path /etc/docker-daemon/config.yaml \
            || die "Could not point /etc/docker-daemon/config.yaml at the shared host identity."
        return 0
    fi
    seed_host_identity_copy "$SHARED_HOST_IDENTITY" "$DOCKER_DAEMON_OWN_HOST_IDENTITY" \
        || die "Could not prepare the host identity for ${RUN_USER}."
    set_config_host_identity_path /etc/docker-daemon/config.yaml "$DOCKER_DAEMON_OWN_HOST_IDENTITY" \
        || die "Could not point /etc/docker-daemon/config.yaml at ${DOCKER_DAEMON_OWN_HOST_IDENTITY}."
    grant_daemon_paths_to_run_user
}

# A root daemon reads the shared host identity, as on a fresh root install.
clear_config_host_identity_path() {
    local config="$1" temporary
    [[ ! -L "$config" ]] || return 1
    [[ -f "$config" ]] && grep -q '^host_identity_path:' "$config" || return 0
    temporary=$(mktemp) || return 1
    grep -v '^host_identity_path:' "$config" >"$temporary" || true
    cat "$temporary" >"$config" || { rm -f "$temporary"; return 1; }
    rm -f "$temporary"
}

# The daemon records each control session Gateway accepted in its state directory (from GATEWAY_SESSION_SINCE on).
# The installer removes the record before it starts the daemon, so only a session of the daemon it started counts.
GATEWAY_SESSION_SINCE="v2.11.1-rc.2"
GATEWAY_SESSION_FILE="/var/lib/docker-daemon/gateway-session.json"
GATEWAY_SESSION_STARTED=0

forget_gateway_session() {
    rm -f "$GATEWAY_SESSION_FILE"
    GATEWAY_SESSION_STARTED=$(date +%s)
}

# Orders vX.Y.Z and vX.Y.Z-rc.N; a release orders after its release candidates.
release_order() {
    [[ "${1#v}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-rc\.([0-9]+))?$ ]] || return 1
    echo $(( ((BASH_REMATCH[1] * 1000 + BASH_REMATCH[2]) * 1000 + BASH_REMATCH[3]) * 100000 + ${BASH_REMATCH[5]:-99999} ))
}

# Daemons older than GATEWAY_SESSION_SINCE write no session record; development builds do.
daemon_records_gateway_session() {
    local order
    order=$(release_order "$1") || return 0
    (( order >= $(release_order "$GATEWAY_SESSION_SINCE") ))
}

# Gateway accepted a session of the daemon this run started, and that process still runs under its service manager.
gateway_session_is_current() {
    local pid connected_at
    [[ -f "$GATEWAY_SESSION_FILE" && ! -L "$GATEWAY_SESSION_FILE" ]] || return 1
    pid=$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$GATEWAY_SESSION_FILE")
    connected_at=$(sed -nE 's/.*"connected_at":([0-9]+).*/\1/p' "$GATEWAY_SESSION_FILE")
    [[ -n "$pid" && -n "$connected_at" ]] || return 1
    (( connected_at >= GATEWAY_SESSION_STARTED )) || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    if [[ "$MANUAL_FALLBACK_USED" -eq 0 ]] && has_systemd; then
        grep -q '/docker-daemon\.service$' "/proc/${pid}/cgroup" 2>/dev/null || return 1
    fi
}

# The enrollment error the daemon started by this run recorded instead of a session, if any.
gateway_session_enrollment_error() {
    [[ -f "$GATEWAY_SESSION_FILE" && ! -L "$GATEWAY_SESSION_FILE" ]] || return 1
    sed -nE 's/.*"enrollment_error":"(([^"\\]|\\.)*)".*/\1/p' "$GATEWAY_SESSION_FILE" | grep .
}

daemon_service_running() {
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        launcher_pid_is_live "${MANUAL_OWNER_PID:-}"
    elif has_systemd; then
        systemctl is-active --quiet docker-daemon
    else
        rc-service docker-daemon status >/dev/null 2>&1
    fi
}

show_daemon_log() {
    local manual_log=/var/lib/docker-daemon/launcher/manual.log
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        err "Daemon log: ${manual_log}"
        tail -n 20 "$manual_log" >&2 2>/dev/null || true
    elif has_systemd; then
        err "Daemon log: journalctl -u docker-daemon"
        journalctl -u docker-daemon -n 20 --no-pager >&2 2>/dev/null || true
    elif has_openrc; then
        err "Daemon log: /var/log/docker-daemon.err and /var/log/docker-daemon.log"
        tail -n 20 /var/log/docker-daemon.err /var/log/docker-daemon.log >&2 2>/dev/null || true
        # A service supervise-daemon cannot start leaves its reason in the system log, not in the service's own logs.
        grep -h 'supervise-daemon.*docker-daemon' /var/log/messages 2>/dev/null | tail -n 5 >&2 || true
    fi
}

fail_daemon_start() {
    err "$1"
    show_daemon_log
    die "docker-daemon is installed, but it is not running."
}

# An install is done once the daemon it started runs and Gateway accepted it. A daemon too old to record its session
# must have enrolled and keep running for 10 s instead.
await_gateway_connection() {
    local waited=0 limit="${GATEWAY_NODE_ENROLLMENT_WAIT_SECONDS:-90}" running=0
    while (( waited < limit )); do
        if daemon_records_gateway_session "$RESOLVED_DAEMON_VERSION"; then
            if gateway_session_is_current; then
                ok "docker-daemon is connected to Gateway"
                return 0
            fi
            # Gateway answered and refused the token: waiting cannot change that.
            if grep -q '"enrollment_refused":true' "$GATEWAY_SESSION_FILE" 2>/dev/null; then
                err "Gateway refused the enrollment token (already used, expired, or for another node): $(gateway_session_enrollment_error)"
                err "Create a new setup command in Gateway and run it on this host."
                show_daemon_log
                return 1
            fi
        elif [[ -f /etc/docker-daemon/certs/node.pem && -f /var/lib/docker-daemon/state.json ]] && daemon_service_running; then
            running=$((running + 1))
            if (( running >= 10 )); then
                ok "docker-daemon enrolled with Gateway and is running"
                warn "docker-daemon ${RESOLVED_DAEMON_VERSION} does not report its Gateway connection; check that the node is online in Gateway."
                return 0
            fi
        else
            running=0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    local enrollment_error
    if enrollment_error=$(gateway_session_enrollment_error); then
        err "docker-daemon could not enroll with Gateway: ${enrollment_error}"
    elif ! daemon_service_running; then
        err "docker-daemon is not running; the service manager could not keep it up. The log below shows why."
    else
        err "docker-daemon has not connected to Gateway within ${limit} s; check that Gateway at ${GATEWAY_ADDR} is reachable."
    fi
    show_daemon_log
    return 1
}

launcher_pid_from_json() {
    local metadata="$1"
    local pid
    [[ -f "$metadata" && ! -L "$metadata" ]] || return 1
    pid=$(sed -nE 's/.*"(pid|launcherPid|launcher_pid)"[[:space:]]*:[[:space:]]*([0-9]+).*/\2/p' "$metadata" | head -n 1 || true)
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    printf '%s\n' "$pid"
}

# A launcher that exited but whose parent never reaps it (PID 1 of a container that does not) stays a zombie: kill -0
# still succeeds for it, though it runs nothing. The state is the field after the command name in /proc/<pid>/stat,
# which may itself contain ") ", so it is read after the last one (the same on busybox and Alpine).
launcher_pid_is_live() {
    local pid="${1:-}" stat
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    [[ -r /proc/self/stat ]] || return 0
    stat=$(cat "/proc/${pid}/stat" 2>/dev/null) || return 1
    stat="${stat##*) }"
    [[ "${stat:0:1}" != "Z" && "${stat:0:1}" != "X" ]]
}

launcher_child_is_ready() {
    local metadata="$1"
    [[ -f "$metadata" && ! -L "$metadata" ]] || return 1
    grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' "$metadata" 2>/dev/null
}

legacy_file_owner_is_allowed() {
    local path="$1"
    local owner run_uid
    owner=$(stat -c '%u' "$path" 2>/dev/null || true)
    [[ "$owner" == "0" ]] && return 0
    [[ "$RUN_USER" != "root" ]] || return 1
    run_uid=$(id -u "$RUN_USER" 2>/dev/null || true)
    [[ -n "$run_uid" && "$owner" == "$run_uid" ]]
}

legacy_update_marker_is_recognizable() {
    local marker="$1"
    local daemon_binary="$2"
    [[ -f "$marker" && ! -L "$marker" ]] || return 1
    legacy_file_owner_is_allowed "$marker" || return 1
    case "$marker" in
        "${daemon_binary}.update-pending")
            grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?[[:space:]]*$' "$marker" 2>/dev/null
            ;;
        "${daemon_binary}.update-state.json")
            grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$marker" 2>/dev/null \
                && grep -Eq '"fromVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null \
                && grep -Eq '"targetVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null
            ;;
        "${daemon_binary}.update-outcome.json")
            grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$marker" 2>/dev/null \
                && grep -Eq '"status"[[:space:]]*:[[:space:]]*"rolled_back"' "$marker" 2>/dev/null \
                && grep -Eq '"fromVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null \
                && grep -Eq '"targetVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null
            ;;
        *)
            return 1
            ;;
    esac
}

retire_legacy_update_guard() {
    local unit="$1"
    local daemon_binary="$2"
    local dropin="/etc/systemd/system/${unit}.service.d/20-update-rollback.conf"
    local marker
    local marker_found=0
    local dropin_owner

    [[ -f "$dropin" && ! -L "$dropin" ]] || return 0
    dropin_owner=$(stat -c '%u' "$dropin" 2>/dev/null || true)
    [[ "$dropin_owner" == "0" ]] || return 0
    grep -Fq -- "update-guard" "$dropin" || return 0
    grep -Fq -- "$daemon_binary" "$dropin" || return 0
    grep -Eq -- "(^|[[:space:]=])${daemon_binary}([[:space:]]|$)" "$dropin" || return 0

    for marker in \
        "${daemon_binary}.update-state.json" \
        "${daemon_binary}.update-pending" \
        "${daemon_binary}.update-outcome.json"; do
        if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
            marker_found=1
            break
        fi
    done
    [[ "$marker_found" -eq 1 ]] || return 0

    if ! rm -f -- "$dropin"; then
        warn "Could not retire the legacy update guard at ${dropin}; preserving it."
        return 0
    fi
    for marker in \
        "${daemon_binary}.update-state.json" \
        "${daemon_binary}.update-pending" \
        "${daemon_binary}.update-outcome.json"; do
        if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
            rm -f -- "$marker" || warn "Could not retire legacy update marker ${marker}; preserving it."
        fi
    done
    ok "Retired the legacy update guard for ${daemon_binary}; preserved .previous and unknown files."
}

launcher_foreground_command() {
    local daemon_binary="$1"
    if [[ "$RUN_USER" == "root" ]]; then
        printf '%q run' "$daemon_binary"
    elif command_exists runuser; then
        # RUN_GROUP is the user's primary group; without -g runuser also keeps the docker group membership.
        printf 'runuser -u %q -- %q run' "$RUN_USER" "$daemon_binary"
    elif command_exists sudo; then
        printf 'sudo -n -u %q -g %q -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
    elif command_exists setpriv; then
        printf 'setpriv --reuid=%q --regid=%q --init-groups -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
    else
        printf '%q run' "$daemon_binary"
    fi
}

prepare_manual_launcher_state() {
    local state_dir="$1"
    local launcher_dir="${state_dir}/launcher"
    local manual_log="${launcher_dir}/manual.log"

    [[ ! -L "$launcher_dir" ]] || return 1
    mkdir -p "$launcher_dir" || return 1
    chmod 0700 "$launcher_dir" || return 1
    chown "${RUN_USER}:${RUN_GROUP}" "$launcher_dir" || return 1
    [[ ! -L "$manual_log" ]] || return 1
    touch "$manual_log" || return 1
    chmod 0640 "$manual_log" || return 1
    chown "${RUN_USER}:${RUN_GROUP}" "$manual_log" || return 1
}

# Stops the launcher a previous manual start left running, as a service manager does on restart. Only a process whose
# command line is this daemon's launcher is signalled.
stop_manual_launcher() {
    local launcher_dir="$1" daemon_type="$2" pid waited=0
    pid="$(launcher_pid_from_json "${launcher_dir}/owner.json" || true)"
    launcher_pid_is_live "$pid" || return 0
    tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -Fq -- " launcher --daemon-type ${daemon_type} " || return 0
    kill -TERM "$pid" 2>/dev/null || true
    while launcher_pid_is_live "$pid" && (( waited < 30 )); do
        sleep 1
        waited=$((waited + 1))
    done
    ! launcher_pid_is_live "$pid"
}


detach_manual_launcher() {
    local daemon_binary="$1"
    local manual_log="$2"
    local -a user_prefix=()

    if [[ "$RUN_USER" != "root" ]]; then
        if command_exists runuser; then
            # RUN_GROUP is the user's primary group; without -g runuser also keeps the docker group membership.
            user_prefix=(runuser -u "$RUN_USER" --)
        elif command_exists sudo; then
            user_prefix=(sudo -n -u "$RUN_USER" -g "$RUN_GROUP" --)
        elif command_exists setpriv; then
            user_prefix=(setpriv "--reuid=${RUN_USER}" "--regid=${RUN_GROUP}" --init-groups --)
        else
            return 1
        fi
    fi

    if command_exists setsid && command_exists nohup; then
        setsid nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 &
    elif command_exists nohup; then
        nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 &
    else
        return 1
    fi
    MANUAL_LAUNCH_PID=$!
}

wait_for_manual_launcher_ready() {
    local launcher_dir="$1"
    local daemon_type="$2"
    local owner_json="${launcher_dir}/owner.json"
    local child_json="${launcher_dir}/child.json"
    local owner_pid child_pid attempts=0

    while (( attempts < MANUAL_LAUNCH_TIMEOUT_SECONDS )); do
        owner_pid="$(launcher_pid_from_json "$owner_json" || true)"
        child_pid="$(launcher_pid_from_json "$child_json" || true)"
        if grep -Eq '"protocolVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$owner_json" 2>/dev/null \
            && grep -Fq -- "\"daemonType\":\"${daemon_type}\"" "$owner_json" 2>/dev/null \
            && launcher_pid_is_live "$owner_pid" \
            && launcher_pid_is_live "$child_pid" \
            && launcher_child_is_ready "$child_json"; then
            MANUAL_OWNER_PID="$owner_pid"
            MANUAL_CHILD_PID="$child_pid"
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
    done
    return 1
}

# Runs the daemon under its own launcher on a host without a service manager. A launcher a previous run started is
# stopped first, as a service restart would, so the daemon installed now runs.
manual_launcher_fallback() {
    local daemon_name="$1"
    local daemon_binary="$2"
    local state_dir="$3"
    local launcher_dir="${state_dir}/launcher"
    local manual_log="${launcher_dir}/manual.log"
    local daemon_type
    MANUAL_FALLBACK_USED=1

    case "$daemon_binary" in
        */docker-daemon) daemon_type="docker" ;;
        */nginx-daemon) daemon_type="nginx" ;;
        */monitoring-daemon) daemon_type="monitoring" ;;
        */relay-supervisor) daemon_type="relay" ;;
        *) err "Unknown launcher daemon binary ${daemon_binary}."; return 1 ;;
    esac

    if ! stop_manual_launcher "$launcher_dir" "$daemon_type"; then
        err "The running ${daemon_name} launcher did not stop; installed files were preserved."
        return 1
    fi
    if ! prepare_manual_launcher_state "$state_dir"; then
        err "Could not prepare manual launcher state for ${daemon_name}; installed files were preserved."
        echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
        return 1
    fi
    forget_gateway_session
    if ! detach_manual_launcher "$daemon_binary" "$manual_log"; then
        err "Could not detach ${daemon_name}; installed files and launcher files were preserved."
        echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
        return 1
    fi

    if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
        ok "${daemon_name} is running in manual mode (launcher PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
        echo "Manual launcher log: ${manual_log}"
        echo "Manual mode is not persistent across reboot."
        return 0
    fi

    err "Could not verify the detached ${daemon_name} launcher; installed files and launcher files were preserved."
    echo "Launcher state: ${launcher_dir}"
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    return 1
}

run_quiet() {
    if "$@" >>"$LOG_FILE" 2>&1; then
        return 0
    fi
    die "Command failed: $*. Check ${LOG_FILE} for details."
}

run_privileged_quiet() {
    if [[ $EUID -eq 0 ]]; then
        run_quiet "$@"
        return
    fi
    if command_exists sudo; then
        run_quiet sudo "$@"
        return
    fi
    die "This step requires root privileges. Re-run as root or install sudo."
}

download_with_progress() {
    local url="$1"
    local output="$2"
    if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 1 ]]; then
        curl -fL --silent --show-error "$url" -o "$output"
    else
        curl -fL --progress-bar "$url" -o "$output"
    fi
}

pkg_update_once() {
    if command_exists apt-get; then
        if [[ "$APT_UPDATED" -eq 0 ]]; then
            run_privileged_quiet apt-get update
            APT_UPDATED=1
        fi
    elif command_exists apk; then
        run_privileged_quiet apk update
    fi
}

install_system_packages() {
    pkg_update_once
    if command_exists apt-get; then
        run_privileged_quiet apt-get install -y "$@"
    elif command_exists yum; then
        run_privileged_quiet yum install -y "$@"
    elif command_exists dnf; then
        run_privileged_quiet dnf install -y "$@"
    elif command_exists apk; then
        run_privileged_quiet apk add "$@"
    else
        die "Could not detect a supported package manager for automatic dependency installation."
    fi
}

ensure_curl_installed() {
    if command_exists curl; then
        return
    fi
    [[ "$DRY_RUN" -eq 0 ]] || die "curl is required to resolve the daemon release during dry run."
    log "curl not found, installing it..."
    install_system_packages curl ca-certificates
}

docker_run() {
    if [[ "$DOCKER_USE_SUDO" -eq 1 ]]; then
        sudo docker "$@"
    else
        docker "$@"
    fi
}

detect_docker_access() {
    if docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=0
        detect_docker_socket
        return 0
    fi
    if command_exists sudo && sudo docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=1
        detect_docker_socket
        return 0
    fi
    return 1
}

detect_docker_socket() {
    local host
    host="$(docker_run context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    if [[ -n "$host" && "$host" != "<no value>" ]]; then
        DOCKER_SOCKET="$host"
    fi
}

systemd_unit_exists() {
    local unit="$1"
    local output
    if systemctl cat "$unit" >/dev/null 2>&1; then
        return 0
    fi
    output="$(systemctl list-unit-files --type=service --no-legend "$unit" 2>/dev/null || true)"
    [[ "$output" == "$unit "* || "$output" == "$unit"$'\t'* ]]
}

detect_docker_systemd_unit() {
    local unit
    for unit in docker.service snap.docker.dockerd.service; do
        if systemd_unit_exists "$unit"; then
            DOCKER_SYSTEMD_UNIT="$unit"
            return 0
        fi
    done
    DOCKER_SYSTEMD_UNIT=""
    return 1
}

docker_group_exists() {
    getent group docker >/dev/null 2>&1
}

docker_repo_distro_family() {
    case "$OS_ID" in
        ubuntu) echo "ubuntu" ;;
        debian) echo "debian" ;;
        alpine) echo "alpine" ;;
        fedora) echo "fedora" ;;
        rhel) echo "rhel" ;;
        centos|centos_stream) echo "centos" ;;
        *)
            if [[ "$OS_LIKE" == *ubuntu* ]]; then
                echo "ubuntu"
            elif [[ "$OS_LIKE" == *debian* ]]; then
                echo "debian"
            elif [[ "$OS_LIKE" == *fedora* ]]; then
                echo "fedora"
            elif [[ "$OS_LIKE" == *rhel* ]] || [[ "$OS_LIKE" == *centos* ]]; then
                echo "rhel"
            else
                echo ""
            fi
            ;;
    esac
}

setup_docker_apt_repository() {
    local repo_distro="$1"
    install_system_packages ca-certificates curl gnupg
    run_privileged_quiet install -m 0755 -d /etc/apt/keyrings
    run_privileged_quiet curl -fsSL "https://download.docker.com/linux/${repo_distro}/gpg" -o /etc/apt/keyrings/docker.asc
    run_privileged_quiet chmod a+r /etc/apt/keyrings/docker.asc
    local codename="$OS_VERSION_CODENAME"
    if [[ -z "$codename" ]] && command_exists lsb_release; then
        codename=$(lsb_release -cs 2>/dev/null || true)
    fi
    [[ -n "$codename" ]] || die "Could not determine distribution codename for Docker apt repository."
    local arch
    arch=$(dpkg --print-architecture)
    run_privileged_quiet tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/${repo_distro}
Suites: ${codename}
Components: stable
Architectures: ${arch}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    APT_UPDATED=0
}

setup_docker_rpm_repository() {
    local repo_distro="$1"
    ensure_curl_installed
    if command_exists dnf; then
        install_system_packages dnf-plugins-core
    elif command_exists yum; then
        install_system_packages yum-utils
    fi
    run_privileged_quiet curl -fsSL "https://download.docker.com/linux/${repo_distro}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
}

remove_conflicting_docker_packages() {
    local repo_family="$1"
    case "$repo_family" in
        ubuntu|debian)
            # A package name absent from this distro's indexes makes apt remove
            # fail even on a clean host. Remove only installed conflicts.
            local package
            local installed_conflicts=()
            for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
                if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
                    installed_conflicts+=("$package")
                fi
            done
            if (( ${#installed_conflicts[@]} > 0 )); then
                run_privileged_quiet apt-get remove -y "${installed_conflicts[@]}"
            fi
            APT_UPDATED=0
            ;;
        fedora|centos|rhel)
            if command_exists dnf; then
                run_privileged_quiet dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            elif command_exists yum; then
                run_privileged_quiet yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            fi
            ;;
    esac
}

# A Docker Engine this script installs starts with log rotation for every
# container, including ones created outside Gateway. An existing daemon.json
# belongs to the operator and is left alone.
seed_docker_log_defaults() {
    local config=/etc/docker/daemon.json
    [[ -e "$config" ]] && return 0
    mkdir -p /etc/docker
    cat > "$config" <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" }
}
JSON
    log "Docker will rotate container logs at 50 MB x 3 ($config)"
}

install_docker_engine() {
    local repo_family
    repo_family=$(docker_repo_distro_family)
    [[ -n "$repo_family" ]] || die "Automatic Docker installation is supported only on Alpine/Debian/Ubuntu/Fedora/CentOS/RHEL."
    remove_conflicting_docker_packages "$repo_family"
    seed_docker_log_defaults
    case "$repo_family" in
        alpine)
            install_system_packages docker docker-cli-compose
            ;;
        ubuntu|debian)
            setup_docker_apt_repository "$repo_family"
            install_system_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
        fedora|centos|rhel)
            setup_docker_rpm_repository "$repo_family"
            install_system_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
    esac
}

ensure_docker_running() {
    if detect_docker_access; then
        return
    fi
    log "Starting Docker service..."
    if has_systemd; then
        if detect_docker_systemd_unit; then
            if [[ "$DOCKER_SYSTEMD_UNIT" == "docker.service" ]]; then
                run_privileged_quiet systemctl enable --now containerd || true
                run_privileged_quiet systemctl enable --now "$DOCKER_SYSTEMD_UNIT"
            else
                run_privileged_quiet systemctl start "$DOCKER_SYSTEMD_UNIT"
            fi
        else
            run_privileged_quiet systemctl enable --now containerd || true
            run_privileged_quiet systemctl enable --now docker
        fi
    elif has_openrc; then
        run_privileged_quiet rc-update add containerd default || true
        run_privileged_quiet rc-service containerd start || true
        run_privileged_quiet rc-update add docker default || true
        run_privileged_quiet rc-service docker start
    elif command_exists service; then
        run_privileged_quiet service containerd start || true
        run_privileged_quiet service docker start
    fi
    local retries=5
    while [[ "$retries" -gt 0 ]]; do
        if detect_docker_access; then
            return
        fi
        retries=$((retries - 1))
        sleep 2
    done
    die "Docker is installed but the daemon is not reachable. Check ${LOG_FILE} for details."
}

quarantine_legacy_builder_runtime_conflicts() {
    [[ "$DOCKER_MODE" != "builder" ]] || return 0
    local legacy_containerd="/usr/local/bin/containerd"
    local legacy_shim="/usr/local/bin/containerd-shim-runc-v2"
    local legacy_runc="/usr/local/bin/runc"
    [[ -x "$legacy_containerd" && -x "$legacy_shim" && -x "$legacy_runc" ]] || return 0
    "$legacy_containerd" --version 2>/dev/null | grep -Fq " v2.3.4 " || return 0
    "$legacy_shim" -v 2>/dev/null | grep -Fq "v2.3.4" || return 0
    "$legacy_runc" --version 2>/dev/null | grep -Fq "runc version 1.5.1" || return 0

    local archive_dir="${BUILDER_RUNTIME_LEGACY_BIN_DIR}/$(date +%Y%m%d_%H%M%S)"
    install -d -m 0755 "$archive_dir"
    local binary source
    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        source="/usr/local/bin/${binary}"
        [[ -f "$source" && ! -L "$source" ]] || continue
        mv "$source" "${archive_dir}/${binary}"
    done
    warn "Moved a legacy Gateway builder runtime out of /usr/local/bin to ${archive_dir}."
    if has_systemd; then
        systemctl try-restart containerd >>"$LOG_FILE" 2>&1 || true
        systemctl try-restart docker >>"$LOG_FILE" 2>&1 || true
    elif has_openrc; then
        rc-service containerd restart >>"$LOG_FILE" 2>&1 || true
        rc-service docker restart >>"$LOG_FILE" 2>&1 || true
    fi
}

ensure_docker_installed() {
    [[ "$DOCKER_MODE" != "builder" ]] || return 0
    ensure_curl_installed
    quarantine_legacy_builder_runtime_conflicts
    if ! command_exists docker; then
        log "Docker not found, installing it..."
        install_docker_engine
    fi
    ensure_docker_running
}

check_dependencies() {
    ensure_curl_installed
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-docker}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

# The token a completed enrollment used, as a digest, written once the daemon this run started enrolled and connected:
# a re-run of the same setup command (its token now used) keeps the node's enrollment.
ENROLLMENT_TOKEN_DIGEST_FILE="/var/lib/docker-daemon/enrollment-token.sha256"
enrollment_token_digest() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

# A node already enrolled with this setup command's token keeps that enrollment: the re-run goes on as one without a
# token.
keep_enrollment_of_used_token() {
    [[ -n "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 && -f "$ENROLLMENT_TOKEN_DIGEST_FILE" ]] || return 0
    [[ "$(cat "$ENROLLMENT_TOKEN_DIGEST_FILE" 2>/dev/null)" == "$(enrollment_token_digest "$ENROLL_TOKEN")" ]] || return 0
    log "This node is already enrolled with this setup command's token; keeping its enrollment."
    ENROLL_TOKEN=""
}

remember_enrollment_token() {
    [[ -n "$ENROLL_TOKEN" && -f /etc/docker-daemon/certs/node.pem ]] || return 0
    (umask 077; enrollment_token_digest "$ENROLL_TOKEN" > "$ENROLLMENT_TOKEN_DIGEST_FILE") 2>> "$LOG_FILE" || return 0
    chown "${RUN_USER}:${RUN_GROUP}" "$ENROLLMENT_TOKEN_DIGEST_FILE" 2>> "$LOG_FILE" || true
}

# docker-daemon enrolls once: a host that is enrolled cannot take another node's token in place, so such a token is not
# used and the host keeps its node. An enrollment from an installer that kept no token digest (v2.11.0 and before)
# cannot tell its own setup command, which operators re-run to update the daemon, from a new node's: the run goes on as
# a re-run without a token and warns. With a digest, a different token is a new node's: the run fails before it changes
# anything, so the new node (still pending in Gateway) does not go unnoticed.
refuse_token_for_enrolled_node() {
    [[ -n "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 ]] || return 0
    local node_id node
    node_id=$(sed -nE 's/.*"node_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' /var/lib/docker-daemon/state.json 2>/dev/null | head -n 1 || true)
    node="docker node ${node_id:-(unknown id)}${EXISTING_GATEWAY_ADDR:+ of Gateway ${EXISTING_GATEWAY_ADDR}}"
    if [[ ! -f "$ENROLLMENT_TOKEN_DIGEST_FILE" ]]; then
        warn "This host is already enrolled as ${node}; the run keeps that enrollment and does not use the enrollment token."
        warn "If this is this node's own setup command (its token already used), nothing else is needed. If it is not, the"
        warn "new node was not enrolled: to enroll this host as that node, stop docker-daemon, move /etc/docker-daemon/certs and"
        warn "/var/lib/docker-daemon/state.json out of the way, run its setup command again, and delete the old node in Gateway."
        ENROLL_TOKEN=""
        return 0
    fi
    err "This host is already enrolled as ${node}; the enrollment token was not used, and nothing was changed."
    err "To keep this node (update, repair, change its run user), run the installer again without --token."
    err "To enroll this host as the new node instead: stop docker-daemon, move /etc/docker-daemon/certs and /var/lib/docker-daemon/state.json"
    err "out of the way, run this command again, and delete the old node in Gateway."
    die "The host is already enrolled; the new node stays pending in Gateway."
}

detect_existing_install() {
    local target="/usr/local/bin/docker-daemon"
    local config_path="/etc/docker-daemon/config.yaml"
    local state_path="/var/lib/docker-daemon/state.json"
    local cert_path="/etc/docker-daemon/certs/node.pem"
    EXISTING_INSTALL=0
    EXISTING_VERSION=""
    EXISTING_GATEWAY_ADDR=""
    EXISTING_ENROLLED=0

    if [[ -x "$target" ]]; then
        EXISTING_INSTALL=1
        EXISTING_VERSION=$(daemon_binary_version "$target" || echo "unknown")
    fi

    if [[ -f "$config_path" ]]; then
        EXISTING_GATEWAY_ADDR=$(awk -F'"' '/^[[:space:]]*address:[[:space:]]*"/ {print $2; exit}' "$config_path")
        if [[ -z "$EXISTING_GATEWAY_ADDR" ]]; then
            EXISTING_GATEWAY_ADDR=$(awk '/^[[:space:]]*address:[[:space:]]*/ {print $2; exit}' "$config_path")
        fi
    fi

    if [[ -f "$cert_path" && -f "$state_path" ]]; then
        EXISTING_ENROLLED=1
    fi
}

# Whether release $1 is older than release $2 (vX.Y.Z[-pre]; a pre-release is older than its release, rc.9 than rc.20).
daemon_version_older() {
    local a="${1#v}" b="${2#v}" a_pre="" b_pre="" i x y
    [[ "$a" == *-* ]] && a_pre="${a#*-}"
    [[ "$b" == *-* ]] && b_pre="${b#*-}"
    local IFS=.
    local -a ac=(${a%%-*}) bc=(${b%%-*}) ap=($a_pre) bp=($b_pre)
    for i in 0 1 2; do
        x="${ac[i]:-0}" y="${bc[i]:-0}"
        [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]] || return 1
        ((10#$x < 10#$y)) && return 0
        ((10#$x > 10#$y)) && return 1
    done
    [[ -n "$a_pre" ]] || return 1
    [[ -n "$b_pre" ]] || return 0
    for ((i = 0; i < ${#ap[@]} || i < ${#bp[@]}; i++)); do
        x="${ap[i]-}" y="${bp[i]-}"
        [[ -n "$x" ]] || return 0
        [[ -n "$y" ]] || return 1
        if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
            ((10#$x < 10#$y)) && return 0
            ((10#$x > 10#$y)) && return 1
        elif [[ "$x" != "$y" ]]; then
            [[ "$x" < "$y" ]]
            return
        fi
    done
    return 1
}

# A re-run without --version never moves a node to an older daemon than it runs: "latest" is the newest stable
# release, so a node on a newer release or pre-release keeps its version. Only --version (or
# GATEWAY_NODE_DAEMON_VERSION) naming the older release installs it.
keep_installed_newer_daemon() {
    local daemon="$1"
    [[ "$DAEMON_VERSION" == "latest" && "$EXISTING_INSTALL" -eq 1 ]] || return 0
    [[ "$EXISTING_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] || return 0
    daemon_version_older "$RESOLVED_DAEMON_VERSION" "$EXISTING_VERSION" || return 0
    warn "${daemon} ${EXISTING_VERSION} is installed; latest resolves to the older ${RESOLVED_DAEMON_VERSION}. Keeping ${EXISTING_VERSION}; pass --version ${RESOLVED_DAEMON_VERSION} to install the older release."
    resolve_download_url "$EXISTING_VERSION"
}

resolve_download_url() {
    local version="$1"
    local binary_name="docker-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest docker release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${RELEASES_API_URL}?component=docker-daemon")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-docker"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest docker release tag from ${RELEASES_API_URL}"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-docker}"
        RELEASE_BASE="${ARTIFACT_BASE_URL}/docker-daemon/${latest_tag}"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${ARTIFACT_BASE_URL}/docker-daemon/${RESOLVED_DAEMON_VERSION}-docker"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

# ── Parse Arguments ──────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Docker Node Setup — installs docker-daemon and enrolls with Gateway

Usage:
  setup-docker-node.sh [options]

  In interactive mode (default), the script prompts only for missing gateway host,
  enrollment token, and Gateway certificate fingerprint. Port defaults to 9443 and
  daemon version defaults to latest unless supplied.

Options:
  --gateway <addr>         Gateway gRPC address as host:port (e.g. gateway.example.com:9443)
  --host <host>            Gateway hostname or IP (e.g. gateway.example.com)
  --port <port>            Gateway gRPC port (default: 9443)
  --token <token>          Enrollment token from Gateway UI (Nodes > Add Node)
  --gateway-cert-sha256 <fp>
                           Gateway gRPC TLS leaf fingerprint from the generated setup command
  --version <ver>          Daemon version to install (default: latest; never older than an installed one)
  --mode <profile>         Node profile: docker, builder, databases, or storage (default: docker)
  --builder-egress <profile>
                           Builder egress: internet or offline (default: internet)
  --user <user>            Run daemon as this user (default: root)
  --disable-console        Turn the host console off (console.enabled: false in the daemon config)
  --disable-files          Turn host file access off (files.enabled: false in the daemon config)
  --secure-runtime         Install Secure Runtime (gVisor) on an existing install too, and fail when it cannot
                           (a fresh docker-profile install sets it up anyway)
  --no-logo                Suppress the logo banner
  --dry-run                Validate inputs and show the plan without changing the host
  -y, --yes                Non-interactive mode (no prompts, all values required via flags)
  -h, --help               Show this help

Environment variables:
  GATEWAY_NODE_HOST             Same as --host
  GATEWAY_NODE_PORT             Same as --port (default: 9443)
  GATEWAY_NODE_ADDRESS          Same as --gateway (host:port combined)
  GATEWAY_NODE_TOKEN            Same as --token
  GATEWAY_NODE_CERT_SHA256      Same as --gateway-cert-sha256
  GATEWAY_NODE_DAEMON_VERSION   Same as --version
  GATEWAY_LEASE_WATCHDOG_VERSION  Lease watchdog release (default: latest)
  GATEWAY_DOCKER_MODE           Same as --mode
  GATEWAY_BUILDER_EGRESS_PROFILE Same as --builder-egress (internet or offline; default: internet)
  GATEWAY_NODE_DISABLE_CONSOLE  Set to 1 to disable the host console
  GATEWAY_NODE_DISABLE_FILES    Set to 1 to disable host file access
  GATEWAY_DOCKER_SECURE_RUNTIME Set to 1 for --secure-runtime
  GATEWAY_RELEASES_API_URL      Override the Gateway release feed
  GATEWAY_ARTIFACT_BASE_URL     Override the Gateway artifact base URL

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-docker-node.sh

  # Fully non-interactive:
  sudo bash setup-docker-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom daemon user:
  sudo bash setup-docker-node.sh --user dockeruser --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
HELP
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gateway)        GATEWAY_ADDR="$2"; shift 2 ;;
        --host)           GATEWAY_HOST="$2"; shift 2 ;;
        --port)           GATEWAY_PORT="$2"; shift 2 ;;
        --token)          ENROLL_TOKEN="$2"; shift 2 ;;
        --gateway-cert-sha256) GATEWAY_CERT_SHA256="$2"; shift 2 ;;
        --version)        DAEMON_VERSION="$2"; shift 2 ;;
        --mode)           DOCKER_MODE="$2"; shift 2 ;;
        --builder-egress) BUILDER_EGRESS_PROFILE="$2"; shift 2 ;;
        --user)           RUN_USER="$2"; shift 2 ;;
        --disable-console) DISABLE_CONSOLE=1; shift ;;
        --disable-files)  DISABLE_FILES=1; shift ;;
        --secure-runtime) SECURE_RUNTIME=1; shift ;;
        --no-logo)        NO_LOGO=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; NO_LOGO=1; shift ;;
        -h|--help)        show_help ;;
        *) die "Unknown option: $1. Use --help for usage." ;;
    esac
done

[[ -n "$DOCKER_MODE" ]] || DOCKER_MODE="docker"
case "$DOCKER_MODE" in
    docker|builder|databases|storage) ;;
    *) die "Invalid --mode '${DOCKER_MODE}'. Expected docker, builder, databases, or storage." ;;
esac
case "$BUILDER_EGRESS_PROFILE" in
    internet|offline) ;;
    *) die "Invalid --builder-egress '${BUILDER_EGRESS_PROFILE}'. Expected internet or offline." ;;
esac
if [[ "$SECURE_RUNTIME" == "1" && "$DOCKER_MODE" != "docker" ]]; then
    die "--secure-runtime applies to the docker profile only."
fi

# Resolve GATEWAY_ADDR from --host/--port if --gateway not given
if [[ -n "$GATEWAY_HOST" && -z "$GATEWAY_ADDR" ]]; then
    GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
fi
# If --gateway was given, extract host/port for display
if [[ -n "$GATEWAY_ADDR" && -z "$GATEWAY_HOST" ]]; then
    GATEWAY_HOST="${GATEWAY_ADDR%%:*}"
    GATEWAY_PORT="${GATEWAY_ADDR##*:}"
    if [[ "$GATEWAY_PORT" == "$GATEWAY_HOST" ]]; then
        GATEWAY_PORT="9443"
        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
    fi
fi

# ── Validate ─────────────────────────────────────────────────────────
need_root
[[ "$DRY_RUN" -eq 1 ]] || preflight_builder_host
if [[ "$DRY_RUN" -eq 0 ]]; then
    LOG_FILE=$(mktemp /tmp/gateway_docker_setup.XXXXXX) || die "Could not create installer log file"
    chmod 600 "$LOG_FILE" || die "Could not secure installer log file"
fi
detect_os
detect_arch
check_dependencies
detect_existing_install
keep_enrollment_of_used_token
refuse_token_for_enrolled_node

if [[ -z "$GATEWAY_ADDR" && -n "$EXISTING_GATEWAY_ADDR" ]]; then
    GATEWAY_ADDR="$EXISTING_GATEWAY_ADDR"
    GATEWAY_HOST="${GATEWAY_ADDR%%:*}"
    GATEWAY_PORT="${GATEWAY_ADDR##*:}"
    if [[ "$GATEWAY_PORT" == "$GATEWAY_HOST" ]]; then
        GATEWAY_PORT="9443"
        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
    fi
fi

if [[ "$DOCKER_MODE" == "builder" ]]; then
    DOCKER_VER="not required"
elif command_exists docker; then
    DOCKER_VER=$(docker_run version --format '{{.Server.Version}}' 2>/dev/null || echo "unreachable")
else
    DOCKER_VER="not installed"
fi

# ── Logo ─────────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [[ "${GATEWAY_SETUP_NO_CLEAR:-0}" != "1" ]] && [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo
fi

# ── Interactive configuration ────────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Download and install the docker-daemon binary${NC}"
    guide "${GRAY}  2. Enroll this node with your Gateway server${NC}"
    guide "${GRAY}  3. Start the daemon as a systemd service${NC}"
    guide "${GRAY}  Docker ${DOCKER_VER} detected.${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled docker node detected — reusing current gateway configuration"
    else
        # Gateway host
        if [[ -z "$GATEWAY_HOST" ]]; then
            GATEWAY_HOST=$(prompt_input "Gateway hostname or IP" "")
            [[ -z "$GATEWAY_HOST" ]] && die "Gateway hostname is required"
        else
            guide "${GRAY}Gateway host: ${BRAND_MINT}${GATEWAY_HOST}${NC}"
        fi

        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"

        guide_blank

        # Enrollment token
        if [[ -z "$ENROLL_TOKEN" ]]; then
            ENROLL_TOKEN=$(prompt_secret "Enrollment token (from Nodes > Add Node)")
            [[ -z "$ENROLL_TOKEN" ]] && die "Enrollment token is required"
        else
            guide "${GRAY}Token: ${ENROLL_TOKEN:0:12}...${ENROLL_TOKEN: -4}${NC}"
        fi

        if [[ -z "$GATEWAY_CERT_SHA256" ]]; then
            GATEWAY_CERT_SHA256=$(prompt_input "Gateway certificate SHA-256 fingerprint" "")
            [[ -z "$GATEWAY_CERT_SHA256" ]] && die "Gateway certificate SHA-256 fingerprint is required"
        else
            guide "${GRAY}Gateway cert: ${GATEWAY_CERT_SHA256}${NC}"
        fi

        guide_blank
    fi

    refuse_token_for_enrolled_node
    select_database_storage
    preflight_database_storage

    [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]] || guide_blank

    # User selection
    if [[ -z "$RUN_USER" ]]; then
        selector_title "Run daemon as:"
        user_choice=$(prompt_choice "Choose" "1" "root  [default]" "Current user ($(logname 2>/dev/null || echo "$SUDO_USER"))" "Custom user")
        case "$user_choice" in
            1|root)   RUN_USER="root" ;;
            2)        RUN_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-root}")" ;;
            3)        RUN_USER=$(prompt_input "Username" ""); [[ -z "$RUN_USER" ]] && die "Username is required" ;;
            *)        RUN_USER="root" ;;
        esac
        guide "${GRAY}Selected: ${NC}${RUN_USER}"
    fi
    guide_end
else
    # Non-interactive: validate required fields
    if [[ -z "$GATEWAY_ADDR" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--gateway or --host is required in non-interactive mode"
    fi
    if [[ -z "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--token is required in non-interactive mode"
    fi
    if [[ -z "$GATEWAY_CERT_SHA256" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--gateway-cert-sha256 is required in non-interactive mode"
    fi
    [[ -z "$RUN_USER" ]] && RUN_USER="root"
    select_database_storage
    preflight_database_storage
fi

if [[ "$DOCKER_MODE" == "builder" && "$RUN_USER" != "root" ]]; then
    die "Builder docker-daemon profile must run as root to manage its dedicated BuildKit/containerd runtime."
fi
if [[ ( "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ) && "$RUN_USER" != "root" ]]; then
    die "$(restricted_node_kind) nodes must run docker-daemon as root."
fi

# ── Resolve run user/group ───────────────────────────────────────────
RUN_GROUP=""
if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="root"
else
    if ! id "$RUN_USER" &>/dev/null; then
        die "User '$RUN_USER' does not exist. Create it first or choose a different user."
    fi
    RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null)
fi

resolve_download_url "$DAEMON_VERSION"
detect_existing_install
keep_installed_newer_daemon docker-daemon

# ── Confirmation ─────────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing docker-daemon installation detected"
    echo -e "  ${GRAY}Current version: ${BRAND_MINT}${EXISTING_VERSION}${NC}"
    echo -e "  ${GRAY}Version to install: ${BRAND_MINT}${RESOLVED_DAEMON_VERSION}${NC}"
    echo ""
fi

summary_start
summary_row "Gateway:     ${GATEWAY_ADDR}"
if [[ -n "$ENROLL_TOKEN" ]]; then
    summary_row "Token:       ${ENROLL_TOKEN:0:12}..."
else
    summary_row "Token:       existing enrollment"
fi
if [[ -n "$GATEWAY_CERT_SHA256" ]]; then
    summary_row "Cert SHA256: ${GATEWAY_CERT_SHA256}"
else
    summary_row "Cert SHA256: existing enrollment"
fi
summary_row "Arch:        ${ARCH}"
summary_row "OS:          ${OS_ID}"
summary_row "Docker:      ${DOCKER_VER}"
summary_row "Install ver: ${RESOLVED_DAEMON_VERSION}"
summary_row "Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
summary_row "Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
summary_row "Profile:     ${DOCKER_MODE}"
summary_row "Run as:      ${RUN_USER}:${RUN_GROUP}"
summary_row "Updates:     ${ARTIFACT_BASE_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
fi
guide_blank

# ── Host access switches ─────────────────────────────────────────────
# --disable-console / --disable-files write console.enabled: false and
# files.enabled: false to the daemon config on this node. The installer only
# turns them off and keeps them off when enrollment rewrites the config;
# turning one back on is an edit of the config file on the node.
host_feature_disabled() {
    local config_file="$1"
    local section="$2"
    [[ -f "$config_file" ]] || return 1
    awk -v section="$section" '
        $0 ~ ("^" section ":[[:space:]]*(#.*)?$") { in_section = 1; next }
        in_section && /^[^[:space:]#]/ { in_section = 0 }
        in_section && /^[[:space:]]+enabled:[[:space:]]*(false|False|FALSE)[[:space:]]*(#.*)?$/ { found = 1 }
        END { exit found ? 0 : 1 }
    ' "$config_file"
}

disable_host_feature() {
    local config_file="$1"
    local section="$2"
    local tmp_file
    tmp_file=$(mktemp "${config_file}.XXXXXX") || die "Could not update ${section}.enabled in ${config_file}"
    if ! awk -v section="$section" '
        function emit() { if (!done) { print indent "enabled: false"; done = 1 } }
        BEGIN { indent = "  " }
        !in_section && $0 ~ ("^" section ":") {
            if ($0 !~ ("^" section ":[[:space:]]*(#.*)?$")) { failed = 1; exit 3 }
            print; in_section = 1; seen = 1; next
        }
        in_section && /^[^[:space:]#]/ { emit(); in_section = 0 }
        in_section && /^[[:space:]]+[^[:space:]#]/ {
            if (!child) { match($0, /^[[:space:]]+/); indent = substr($0, 1, RLENGTH); child = 1 }
            if ($0 ~ ("^" indent "enabled:")) { emit(); next }
        }
        { print }
        END {
            if (failed) exit 3
            if (in_section) emit()
            if (!seen) { print ""; print section ":"; print "  enabled: false" }
        }
    ' "$config_file" > "$tmp_file"; then
        rm -f "$tmp_file"
        die "Could not set ${section}.enabled: false in ${config_file}; edit the file by hand."
    fi
    # Write in place so the config keeps its owner and mode.
    cat "$tmp_file" > "$config_file" || die "Could not write ${config_file}"
    rm -f "$tmp_file"
    ok "${section}.enabled: false written to ${config_file}"
}

remember_host_access_config() {
    if host_feature_disabled "$1" console; then DISABLE_CONSOLE=1; fi
    if host_feature_disabled "$1" files; then DISABLE_FILES=1; fi
}

apply_host_access_config() {
    if [[ "$DISABLE_CONSOLE" == "1" ]]; then disable_host_feature "$1" console; fi
    if [[ "$DISABLE_FILES" == "1" ]]; then disable_host_feature "$1" files; fi
}

preview_host_access_config() {
    if [[ "$DISABLE_CONSOLE" == "1" ]]; then ok "console.enabled: false written to $1 (dry run)"; fi
    if [[ "$DISABLE_FILES" == "1" ]]; then ok "files.enabled: false written to $1 (dry run)"; fi
}

# What a real run does with the daemon binary: docker-daemon at the path this run installs it to is kept when it already has
# the version to install, else downloaded.
preview_daemon_binary() {
    local target="${DOCKER_DAEMON_OWN_BINARY}"
    if [[ "$RUN_USER" == "root" ]]; then
        target="${DOCKER_DAEMON_BIN_LINK}"
        # A link or wrapper of a non-root install is replaced by a downloaded root binary.
        if [[ -L "$target" ]] || is_daemon_wrapper "$target"; then target=""; fi
    fi
    if [[ -n "$target" && -f "$target" && "$(daemon_binary_version "$target" || true)" == "$RESOLVED_DAEMON_VERSION" ]]; then
        ok "docker-daemon already installed (${RESOLVED_DAEMON_VERSION})"
    else
        log "Downloading docker-daemon..."
        ok "docker-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    fi
    if [[ "$RUN_USER" != "root" ]]; then
        ok "${DOCKER_DAEMON_BIN_LINK} runs ${DOCKER_DAEMON_OWN_BINARY} as ${RUN_USER} (dry run)"
    fi
}

preview_run_user_switch() {
    [[ "$PREVIOUS_RUN_UID" != 0 && "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "docker-daemon runs as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); it is stopped and switched to ${RUN_USER} (dry run)"
}

preview_service_start() {
    local manager="manual mode (no supported service manager; not persistent across reboot)"
    if has_systemd; then
        manager="systemd unit docker-daemon"
    elif has_openrc; then
        manager="OpenRC service docker-daemon"
    fi
    log "Enabling and starting docker-daemon as ${RUN_USER} (${manager})..."
    ok "docker-daemon is connected to Gateway (dry run)"
}

dry_run_preview() {
    if [[ "$DOCKER_MODE" == "builder" ]]; then
        ok "Build Worker profile: Docker Engine is not installed; the worker runs its own BuildKit and containerd"
    elif command_exists docker; then
        ok "Docker is available (${DOCKER_VER})"
    else
        log "Docker not found, installing it..."
        ok "Docker installed (dry run)"
    fi
    if [[ "$RUN_USER" != "root" ]] && docker_group_exists && ! groups "$RUN_USER" 2>/dev/null | grep -qw docker; then
        log "Adding ${RUN_USER} to the docker group (dry run)"
    fi
    preview_run_user_switch
    log "Creating required directories..."
    ok "Directories created (dry run)"
    preview_daemon_binary
    if lease_watchdog_profile; then
        ok "Lease watchdog installed as its own service (dry run)"
    fi
    if [[ "$DOCKER_MODE" == "builder" ]]; then
        log "Downloading pinned Build Worker runtime components..."
        log "Verifying upstream runtime checksums..."
        ok "Builder runtime installed (dry run)"
    fi
    if [[ "$DOCKER_MODE" == "docker" && ( "$EXISTING_INSTALL" -eq 0 || "$SECURE_RUNTIME" == "1" ) ]]; then
        log "Running the Secure Runtime preflight and installing Secure Runtime where the host supports it (dry run)"
    fi
    if [[ "$EXISTING_ENROLLED" -eq 1 ]]; then
        ok "Node already enrolled — skipping enrollment (dry run)"
    else
        log "Writing config and enrolling with Gateway..."
        ok "Config written to /etc/docker-daemon/config.yaml (dry run)"
    fi
    if [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]]; then
        ok "Database docker profile written (root daemon, storage: ${DATABASE_STORAGE_ROOT}; dry run)"
    elif [[ "$DOCKER_MODE" == "builder" ]]; then
        ok "Builder docker profile written (no Docker socket; dry run)"
    fi
    preview_host_access_config /etc/docker-daemon/config.yaml
    preview_service_start
    complete_success "Dry run completed successfully — no host changes were made."
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

ensure_docker_installed
preflight_database_docker
preflight_docker_cgroup_controllers
ensure_builder_system_packages

if [[ "$RUN_USER" != "root" ]]; then
    if docker_group_exists && ! groups "$RUN_USER" 2>/dev/null | grep -qw docker; then
        warn "User '$RUN_USER' is not in the 'docker' group. Adding it now."
        usermod -aG docker "$RUN_USER" >>"$LOG_FILE" 2>&1 || true
    elif ! docker_group_exists; then
        warn "Docker group was not found. docker-daemon will run without SupplementaryGroups=docker."
    fi
fi
preflight_run_user_docker_access

# ── Step 1: Create directories ───────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/docker-daemon/certs
    mkdir -p /var/lib/docker-daemon

    if [[ "$DOCKER_MODE" == "builder" ]]; then
        mkdir -p /etc/gateway-builder /usr/local/lib/gateway-builder
        mkdir -p /var/lib/docker-daemon/builder /run/gateway-builder/buildkit /run/gateway-builder/containerd
        chmod 700 /etc/gateway-builder /usr/local/lib/gateway-builder /var/lib/docker-daemon/builder
    fi

    grant_daemon_paths_to_run_user

    ok "Directories created"
}

# ── Step 2: Download docker-daemon binary ────────────────────────────

verify_checksum() {
    local file="$1"
    local binary_name="$2"

    log "Verifying checksum..."
    local checksums_file="/tmp/gateway_checksums.txt"
    if curl -fsSL "${RELEASE_BASE}/checksums.txt" -o "$checksums_file" >> "$LOG_FILE" 2>&1; then
        local expected actual
        expected=$(grep "$binary_name" "$checksums_file" | awk '{print $1}')
        actual=$(sha256sum "$file" | awk '{print $1}')
        rm -f "$checksums_file"

        if [[ -z "$expected" ]]; then
            die "No checksum found for ${binary_name} in checksums.txt"
        fi

        if [[ "$expected" != "$actual" ]]; then
            die "Checksum verification failed! Expected: ${expected}, Got: ${actual}"
        fi
        ok "Checksum verified"
    else
        rm -f "$checksums_file"
        die "Could not download checksums.txt for checksum verification"
    fi
}

install_daemon() {
    if [[ "$RUN_USER" == "root" ]]; then
        # Never write a root binary through the link or wrapper left by an install that ran as another user.
        if [[ -L "$DOCKER_DAEMON_BIN_LINK" ]] || is_daemon_wrapper "$DOCKER_DAEMON_BIN_LINK"; then
            rm -f "$DOCKER_DAEMON_BIN_LINK"
        fi
        install_daemon_binary "$DOCKER_DAEMON_BIN_LINK"
        return
    fi
    install -d -m 0755 "$DOCKER_DAEMON_OWN_DIR" "$(dirname "$DOCKER_DAEMON_OWN_BINARY")"
    install_daemon_binary "$DOCKER_DAEMON_OWN_BINARY"
    write_daemon_wrapper "$DOCKER_DAEMON_BIN_LINK" "$DOCKER_DAEMON_OWN_BINARY" || die "Could not write the docker-daemon command at $DOCKER_DAEMON_BIN_LINK."
    grant_daemon_paths_to_run_user
}

install_daemon_binary() {
    local target="$1"
    local binary_name="docker-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$(daemon_binary_version "$target" || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "docker-daemon already installed (${existing_ver})"
            return 0
        fi
        # The version the node runs is the installed command's (EXISTING_VERSION): the binary here can be a copy a
        # run as another user left behind (a run-user switch), which says nothing about what is installed.
        local installed_ver="$existing_ver"
        [[ "$EXISTING_VERSION" =~ ^v[0-9] ]] && installed_ver="$EXISTING_VERSION"
        if [[ "$installed_ver" == "$RESOLVED_DAEMON_VERSION" ]]; then
            log "Installing docker-daemon ${RESOLVED_DAEMON_VERSION} at ${target}..."
        else
            log "Upgrading docker-daemon from ${installed_ver} to ${RESOLVED_DAEMON_VERSION}..."
        fi
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
        prune_older_backups "$target" "$backup"
    else
        log "Downloading docker-daemon..."
    fi

    if download_with_progress "$DOWNLOAD_URL" "${target}.tmp"; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$(daemon_binary_version "$target" || echo "unknown")
        ok "docker-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        die "Failed to download docker-daemon ${RESOLVED_DAEMON_VERSION} from releases"
    fi
}

install_builder_runtime() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    local containerd_version="2.3.4"
    local buildkit_version="0.32.2"
    local runc_version="1.5.1"
    local cni_version="1.9.1"
    local syft_version="1.51.0"
    local grype_version="0.117.0"
    local containerd_sha256 buildkit_sha256 runc_sha256 cni_sha256 syft_sha256 grype_sha256
    case "$ARCH" in
        amd64)
            containerd_sha256="9d68969855fbf676cdb8ed758e420fb048d61f984f61de3e53eddfebe484d168"
            buildkit_sha256="2975d0f651ad96ba8b80b9992ae1f9a964f4408569af5b6dc36544165c3926af"
            cni_sha256="b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303"
            syft_sha256="2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f"
            grype_sha256="38525dab1e06f162ebaa02f94d82d1f807076b011a44180cf2777edf1a7b9c26"
            runc_sha256="177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f"
            ;;
        arm64)
            containerd_sha256="a985fbb7e18fc0362d31a055338f5d7b0e087a3e27f14c70d1c5965399a29f95"
            buildkit_sha256="9e8f46bf309ec0ab262967be5538a4dbe06be756a82621f98253933bac5dcf92"
            cni_sha256="56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec"
            syft_sha256="6c0466811541ea03add5213a60a1562f0851e4c0b0ecfdee1a694a9455285900"
            grype_sha256="935f628bdf9331ffdd946931ea5fdb50045d3970ba52670cbeb44a88f127291b"
            runc_sha256="ca70e7dbd6616ca782a59b5d3ac86909123fdaa9fa3f89dcf29051c70eee7ce9"
            ;;
        *) die "Builder runtime is supported only on amd64 and arm64 hosts." ;;
    esac

    local staging_dir download_dir
    local installed_manifest="$BUILDER_RUNTIME_MANIFEST"

    if [[ -f "$installed_manifest" ]] \
        && grep -Fqx "format=3" "$installed_manifest" \
        && grep -Fqx "bin_dir=${BUILDER_RUNTIME_BIN_DIR}" "$installed_manifest" \
        && grep -Fqx "architecture=${ARCH}" "$installed_manifest" \
        && grep -Fqx "containerd=${containerd_version}" "$installed_manifest" \
        && grep -Fqx "buildkit=${buildkit_version}" "$installed_manifest" \
        && grep -Fqx "runc=${runc_version}" "$installed_manifest" \
        && grep -Fqx "cni_plugins=${cni_version}" "$installed_manifest" \
        && grep -Fqx "syft=${syft_version}" "$installed_manifest" \
        && grep -Fqx "grype=${grype_version}" "$installed_manifest"; then
        local complete=1 binary plugin
        for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
            [[ -f "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && ! -L "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && -x "${BUILDER_RUNTIME_BIN_DIR}/${binary}" ]] || complete=0
        done
        for plugin in bridge host-local firewall loopback; do
            [[ -x "/opt/gateway-builder/cni/bin/${plugin}" ]] || complete=0
        done
        if [[ "$complete" -eq 1 ]]; then
            ok "Builder runtime already installed for ${RESOLVED_DAEMON_VERSION}"
            return 0
        fi
    fi

    staging_dir=$(mktemp -d /tmp/gateway-builder-runtime.XXXXXX)
    download_dir=$(mktemp -d /tmp/gateway-builder-downloads.XXXXXX)
    trap 'rm -rf "$staging_dir" "$download_dir"' RETURN
    install -d -m 0755 "$staging_dir/bin" "$staging_dir/cni/bin" \
        "$download_dir/containerd" "$download_dir/buildkit" "$download_dir/cni" \
        "$download_dir/syft" "$download_dir/grype"

    download_builder_component() {
        local label="$1" url="$2" expected="$3" target="$4"
        log "Downloading ${label}..."
        download_with_progress "$url" "$target" || die "Failed to download ${label} from its official release."
        printf '%s  %s\n' "$expected" "$target" | sha256sum --check --status || \
            die "Checksum verification failed for ${label}."
    }

    download_builder_component "containerd ${containerd_version}" \
        "https://github.com/containerd/containerd/releases/download/v${containerd_version}/containerd-${containerd_version}-linux-${ARCH}.tar.gz" \
        "$containerd_sha256" "$download_dir/containerd.tar.gz"
    download_builder_component "BuildKit ${buildkit_version}" \
        "https://github.com/moby/buildkit/releases/download/v${buildkit_version}/buildkit-v${buildkit_version}.linux-${ARCH}.tar.gz" \
        "$buildkit_sha256" "$download_dir/buildkit.tar.gz"
    download_builder_component "CNI plugins ${cni_version}" \
        "https://github.com/containernetworking/plugins/releases/download/v${cni_version}/cni-plugins-linux-${ARCH}-v${cni_version}.tgz" \
        "$cni_sha256" "$download_dir/cni.tar.gz"
    download_builder_component "Syft ${syft_version}" \
        "https://github.com/anchore/syft/releases/download/v${syft_version}/syft_${syft_version}_linux_${ARCH}.tar.gz" \
        "$syft_sha256" "$download_dir/syft.tar.gz"
    download_builder_component "Grype ${grype_version}" \
        "https://github.com/anchore/grype/releases/download/v${grype_version}/grype_${grype_version}_linux_${ARCH}.tar.gz" \
        "$grype_sha256" "$download_dir/grype.tar.gz"
    download_builder_component "runc ${runc_version}" \
        "https://github.com/opencontainers/runc/releases/download/v${runc_version}/runc.${ARCH}" \
        "$runc_sha256" "$staging_dir/bin/runc"
    chmod 0755 "$staging_dir/bin/runc"

    tar -xzf "$download_dir/containerd.tar.gz" -C "$download_dir/containerd"
    tar -xzf "$download_dir/buildkit.tar.gz" -C "$download_dir/buildkit"
    tar -xzf "$download_dir/cni.tar.gz" -C "$download_dir/cni"
    tar -xzf "$download_dir/syft.tar.gz" -C "$download_dir/syft"
    tar -xzf "$download_dir/grype.tar.gz" -C "$download_dir/grype"

    local binary plugin
    for binary in containerd ctr containerd-shim-runc-v2; do
        install -m 0755 "$download_dir/containerd/bin/${binary}" "$staging_dir/bin/${binary}"
    done
    for binary in buildkitd buildctl; do
        install -m 0755 "$download_dir/buildkit/bin/${binary}" "$staging_dir/bin/${binary}"
    done
    install -m 0755 "$download_dir/syft/syft" "$staging_dir/bin/syft"
    install -m 0755 "$download_dir/grype/grype" "$staging_dir/bin/grype"
    for plugin in bridge host-local firewall loopback; do
        install -m 0755 "$download_dir/cni/${plugin}" "$staging_dir/cni/bin/${plugin}"
    done

    printf '%s\n' \
        "format=3" \
        "bin_dir=${BUILDER_RUNTIME_BIN_DIR}" \
        "architecture=${ARCH}" \
        "containerd=${containerd_version}" \
        "buildkit=${buildkit_version}" \
        "runc=${runc_version}" \
        "cni_plugins=${cni_version}" \
        "syft=${syft_version}" \
        "grype=${grype_version}" \
        > "$staging_dir/runtime-manifest"

    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        [[ -f "${staging_dir}/bin/${binary}" && ! -L "${staging_dir}/bin/${binary}" && -x "${staging_dir}/bin/${binary}" ]] || \
            die "Builder runtime staging is missing regular executable bin/${binary}."
    done
    for plugin in bridge host-local firewall loopback; do
        [[ -f "${staging_dir}/cni/bin/${plugin}" && ! -L "${staging_dir}/cni/bin/${plugin}" && -x "${staging_dir}/cni/bin/${plugin}" ]] || \
            die "Builder runtime staging is missing regular CNI plugin ${plugin}."
    done
    [[ -f "${staging_dir}/runtime-manifest" && ! -L "${staging_dir}/runtime-manifest" ]] || die "Builder runtime staging has no regular manifest."

    local legacy_manifest="${installed_manifest}.previous"
    rm -f "$legacy_manifest"
    if [[ -f "$installed_manifest" ]] && grep -Fqx "format=2" "$installed_manifest"; then
        cp -p "$installed_manifest" "$legacy_manifest"
    fi

    install -d -m 0755 "$BUILDER_RUNTIME_BIN_DIR" /opt/gateway-builder/cni/bin
    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        install -m 0755 "${staging_dir}/bin/${binary}" "${BUILDER_RUNTIME_BIN_DIR}/${binary}"
    done
    for plugin in bridge host-local firewall loopback; do
        install -m 0755 "${staging_dir}/cni/bin/${plugin}" "/opt/gateway-builder/cni/bin/${plugin}"
    done
    install -m 0644 "${staging_dir}/runtime-manifest" "$installed_manifest"

    if [[ -f "$installed_manifest" ]] && grep -Fqx "format=3" "$installed_manifest"; then
        if [[ -f "$legacy_manifest" ]] && grep -Fqx "format=2" "$legacy_manifest"; then
            install -d -m 0755 "$BUILDER_RUNTIME_LEGACY_BIN_DIR"
            for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
                local legacy_path="/usr/local/bin/${binary}"
                local archived_path="${BUILDER_RUNTIME_LEGACY_BIN_DIR}/${binary}.format-2"
                [[ -f "$legacy_path" && ! -L "$legacy_path" ]] || continue
                if [[ "$(sha256sum "$legacy_path" | awk '{print $1}')" == "$(sha256sum "${BUILDER_RUNTIME_BIN_DIR}/${binary}" | awk '{print $1}')" ]]; then
                    if [[ -e "$archived_path" ]]; then
                        archived_path="${archived_path}.$(date +%Y%m%d_%H%M%S)"
                    fi
                    mv -f "$legacy_path" "$archived_path"
                    warn "Moved legacy Gateway builder binary ${legacy_path} to ${archived_path}."
                else
                    warn "Left modified legacy builder path ${legacy_path} untouched; remove it manually if it shadows a system binary."
                fi
            done
        fi
        rm -f "$legacy_manifest"
    fi
    rm -rf "$staging_dir" "$download_dir"
    trap - RETURN
    ok "Builder runtime installed for ${RESOLVED_DAEMON_VERSION}"
}

# A fresh install sets Secure Runtime up; an existing one only with --secure-runtime, which also fails the install
# when Secure Runtime cannot be installed.
setup_secure_runtime() {
    [[ "$DOCKER_MODE" == "docker" ]] || return 0
    [[ "$EXISTING_INSTALL" -eq 0 || "$SECURE_RUNTIME" == "1" ]] || return 0
    prepare_root_daemon_binary
    local target="$ROOT_DAEMON_BINARY"
    local preflight_status=0
    set +e
    "$target" runtime preflight runsc --silent
    preflight_status=$?
    set -e

    case "$preflight_status" in
        0)
            ok "Secure Runtime is ready"
            return 0
            ;;
        10)
            log "Installing Secure Runtime..."
            if "$target" runtime install runsc --non-interactive; then
                ok "Secure Runtime installed and verified"
                return 0
            fi
            warn "Secure Runtime setup failed on this node."
            ;;
        20)
            warn "Current node does not support Secure Runtimes."
            ;;
        *)
            warn "Secure Runtime compatibility could not be verified on this node."
            ;;
    esac

    # Secure Runtime is optional. The reason it is missing is the node's own: its capabilities report the same one.
    local reason
    reason=$("$target" runtime preflight runsc --plain 2>/dev/null | sed -n 1p | awk -F'\t' '{ print ($3 != "" ? $3 : $2) }' || true)
    [[ "$SECURE_RUNTIME" != "1" ]] || die "Secure Runtime is not installed on this node${reason:+: ${reason}}."
    warn "Continuing without Secure Runtime${reason:+ (${reason})}. The node reports the same reason in its capabilities."
}

# Re-runs of v2.11.1-rc.21 and older inserted the profile (two-space "mode", "database" and "storage_root" lines) again
# under "docker:" of a config the daemon had rewritten with four spaces, which nested the daemon's own docker keys under
# docker.database. Those three lines are taken out again when the daemon's own section says the same.
repair_duplicated_database_profile() {
    local config_path="$1" candidate="${1}.repair.$$" mode root
    mode=$(sed -n 's/^  mode: "\(.*\)"$/\1/p' "$config_path" | head -n 1)
    root=$(sed -n 's/^    storage_root: "\(.*\)"$/\1/p' "$config_path" | head -n 1)
    awk '
        { line[NR] = $0 }
        END {
            for (i = 1; i <= NR; i++) if (line[i] ~ /^docker:[[:space:]]*$/) { d = i; break }
            if (!d || line[d + 1] !~ /^  mode: "[^"]*"$/ || line[d + 2] != "  database:" || line[d + 3] !~ /^    storage_root: "[^"]*"$/) exit 1
            n = d + 4
            while (n <= NR && line[n] ~ /^[[:space:]]*(#.*)?$/) n++
            # The next key sits at the depth of storage_root and is a docker key of the daemon, not one of docker.database.
            if (n > NR || line[n] !~ /^    [A-Za-z_]/ || line[n] ~ /^    (storage_root|reserve_bytes):/) exit 1
            for (i = 1; i <= NR; i++) if (i < d + 1 || i > d + 3) print line[i]
        }
    ' "$config_path" > "$candidate" 2>/dev/null || { rm -f "$candidate"; return 0; }
    if [[ "$(docker_config_value "$candidate" docker.mode || echo "$mode")" != "$mode" ]] ||
        [[ "$(docker_config_value "$candidate" docker.database.storage_root || echo "$root")" != "$root" ]]; then
        rm -f "$candidate"
        return 0
    fi
    chmod 600 "$candidate" && mv -f "$candidate" "$config_path" || { rm -f "$candidate"; die "Could not repair ${config_path}."; }
    log "Removed the duplicated database profile lines from ${config_path}"
}

# Writes docker.mode and docker.database.storage_root, the keys the daemon reads, once: a key that is there keeps its
# place, and a missing one goes into its section with the indentation the file uses.
set_database_profile_keys() {
    local config_path="$1" mode="$2" root="$3" tmp_config="${1}.tmp.$$" status=0
    awk -v mode="$mode" -v root="$root" '
        { line[NR] = $0 }
        END {
            for (i = 1; i <= NR; i++) if (line[i] ~ /^docker:[[:space:]]*$/) { d = i; break }
            if (!d) exit 1
            ci = 2
            for (i = d + 1; i <= NR; i++) {
                if (line[i] ~ /^[[:space:]]*(#.*)?$/) continue
                match(line[i], /^ */)
                if (RLENGTH > 0) ci = RLENGTH
                break
            }
            pad = sprintf("%" ci "s", "")
            db = 0
            for (i = d + 1; i <= NR; i++) {
                if (line[i] ~ /^[[:space:]]*(#.*)?$/) continue
                match(line[i], /^ */)
                if (RLENGTH == 0) break
                if (RLENGTH == ci && substr(line[i], ci + 1) ~ /^database:/) {
                    if (substr(line[i], ci + 1) !~ /^database:[ \t]*(#.*)?$/) exit 2
                    db = i
                    break
                }
            }
            dpad = pad pad
            if (db) {
                for (i = db + 1; i <= NR; i++) {
                    if (line[i] ~ /^[[:space:]]*(#.*)?$/) continue
                    match(line[i], /^ */)
                    if (RLENGTH > ci) dpad = sprintf("%" RLENGTH "s", "")
                    break
                }
            }
            for (i = 1; i <= NR; i++) {
                print line[i]
                if (i == d && mode != "") print pad "mode: \"" mode "\""
                if (i == d && root != "" && !db) {
                    print pad "database:"
                    print dpad "storage_root: \"" root "\""
                }
                if (i == db && root != "") print dpad "storage_root: \"" root "\""
            }
        }
    ' "$config_path" > "$tmp_config" || status=$?
    if [[ "$status" -ne 0 ]]; then
        rm -f "$tmp_config"
        [[ "$status" -ne 2 ]] || die "docker.database in ${config_path} is not a section; fix it and run the installer again."
        die "Could not write database docker profile."
    fi
    chmod 600 "$tmp_config"
    mv -f "$tmp_config" "$config_path"
}

write_database_profile_config() {
    [[ "$DOCKER_MODE" == "databases" || "$DOCKER_MODE" == "storage" ]] || return 0
    [[ "$RUN_USER" == "root" ]] || die "$(restricted_node_kind) nodes must run docker-daemon as root."
    [[ -n "$DATABASE_STORAGE_ROOT" && "$DATABASE_STORAGE_ROOT" == /* && "$DATABASE_STORAGE_ROOT" != "/" ]] || die "Database storage root is invalid."
    [[ "$DATABASE_STORAGE_ROOT" =~ ^[A-Za-z0-9._/@+-]+$ ]] || die "Database storage root contains unsupported characters."

    local config_path="/etc/docker-daemon/config.yaml"
    [[ -f "$config_path" ]] || die "docker-daemon config was not created by enrollment."
    grep -q '^docker:[[:space:]]*$' "$config_path" || die "docker-daemon config has no docker section."
    repair_duplicated_database_profile "$config_path"

    local mode root set_mode="" set_root=""
    mode=$(docker_config_value "$config_path" docker.mode || true)
    root=$(docker_config_value "$config_path" docker.database.storage_root || true)
    [[ -z "$mode" || "$mode" == "$DOCKER_MODE" ]] || die "Refusing to overwrite an existing docker profile (docker.mode: ${mode})."
    # A profile without its own storage root runs with the daemon's default one.
    [[ -n "$root" || -z "$mode" ]] || root="/var/lib/docker-daemon/databases"
    [[ -z "$root" || "$root" == "$DATABASE_STORAGE_ROOT" ]] || die "Refusing to overwrite an existing database storage root (${root})."
    [[ -n "$mode" ]] || set_mode="$DOCKER_MODE"
    docker_config_value "$config_path" docker.database.storage_root >/dev/null || set_root="$DATABASE_STORAGE_ROOT"
    if [[ -z "$set_mode" && -z "$set_root" ]]; then
        chmod 600 "$config_path"
        ok "Database docker profile already configured (root daemon, storage: ${DATABASE_STORAGE_ROOT})"
        return 0
    fi
    set_database_profile_keys "$config_path" "$set_mode" "$set_root"
    chmod 600 "$config_path"
    ok "Database docker profile written (root daemon, storage: ${DATABASE_STORAGE_ROOT})"
}

write_builder_profile_config() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    [[ "$RUN_USER" == "root" ]] || die "Builder docker-daemon profile must run as root."
    local config_path="${1:-/etc/docker-daemon/config.yaml}"
    [[ -f "$config_path" ]] || die "docker-daemon config was not created by enrollment."
    grep -q '^docker:$' "$config_path" || die "docker-daemon config has no docker section."
    grep -Eq '^[[:space:]]+mode:[[:space:]]*"?builder"?[[:space:]]*$' "$config_path" || die "Refusing a builder profile without docker.mode=builder."
    if grep -Eq '^[[:space:]]+(socket|allowlist):' "$config_path"; then
        die "Builder profile must not contain Docker socket or allowlist access."
    fi
    local tmp_config="${config_path}.tmp.$$"
    awk -v profile="$BUILDER_EGRESS_PROFILE" '
        $0 == "docker:" {
            print "docker:"
            print "  mode: \"builder\""
            print "  builder:"
            print "    egress_profile: \"" profile "\""
            rewriting = 1
            replaced = 1
            next
        }
        rewriting {
            # Remove the malformed top-level lines emitted by Gateway v2.9.6,
            # as well as the previous nested docker section.
            if ($0 ~ /^builder:[[:space:]]*$/ || $0 ~ /^[[:space:]]*egress_profile:/) next
            if ($0 ~ /^[^[:space:]]/) {
                rewriting = 0
                print
            }
            next
        }
        { print }
        END { if (!replaced) exit 1 }
    ' "$config_path" > "$tmp_config" || { rm -f "$tmp_config"; die "Could not write builder docker profile."; }
    chmod 600 "$tmp_config"
    mv -f "$tmp_config" "$config_path"
    chmod 600 "$config_path"
    ok "Builder docker profile written without Docker Engine access (egress: ${BUILDER_EGRESS_PROFILE})"
}

# ── Lease watchdog (own component, own unit) ─────────────────────────
# Docker Availability lease mode and availability sets of managed databases and
# storage need an independent fence (A2, A12): the watchdog kills a lease-mode
# container (or a set's primary) past its deadline without docker-daemon or
# dockerd. It has its own release line (vX.Y.Z-watchdog), its own binary and its
# own service unit, so a docker-daemon upgrade, downgrade or removal never
# disarms it. Without it the node simply stays out of lease mode and never
# holds a set's primary role. Docker nodes and storage nodes get it.
LEASE_WATCHDOG_BIN="/usr/local/bin/gateway-lease-watchdog"
LEASE_WATCHDOG_UNIT="gateway-lease-watchdog"
LEASE_WATCHDOG_VERSION="${GATEWAY_LEASE_WATCHDOG_VERSION:-latest}"
LEASE_WATCHDOG_INSTALLED=0

# The release channel the watchdog follows: the daemon's (preview for a release candidate). A daemon without root cannot
# set it on the watchdog's service later, so the installer does.
lease_watchdog_channel() {
    if [[ "$RESOLVED_DAEMON_VERSION" == *-rc.* ]]; then echo preview; else echo stable; fi
}

install_lease_watchdog() {
    lease_watchdog_profile || return 0
    local artifact="lease-watchdog-linux-${ARCH}"
    local tag base checksums expected actual current
    if [[ "$LEASE_WATCHDOG_VERSION" == "latest" ]]; then
        # The watchdog of the daemon's channel: a release candidate's watchdog changes ship as preview releases.
        tag=$(curl -fsSL "${RELEASES_API_URL}?component=lease-watchdog&channel=$(lease_watchdog_channel)" 2>>"$LOG_FILE" \
            | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*\(-rc\.[0-9]*\)\{0,1\}-watchdog"' | head -1 | cut -d'"' -f4 || true)
    else
        tag="$(normalize_daemon_version "$LEASE_WATCHDOG_VERSION")-watchdog"
    fi
    if [[ -z "$tag" ]]; then
        warn "No lease watchdog release found; lease mode (Availability, availability sets) stays unavailable on this node."
        return 0
    fi
    if [[ -x "$LEASE_WATCHDOG_BIN" ]]; then
        current=$("$LEASE_WATCHDOG_BIN" version 2>/dev/null | awk '{print $2}' || true)
        if [[ "${current}-watchdog" == "$tag" ]]; then
            ok "Lease watchdog already installed (${current})"
            LEASE_WATCHDOG_INSTALLED=1
            return 0
        fi
    fi
    base="${ARTIFACT_BASE_URL}/lease-watchdog/${tag}"
    log "Downloading lease watchdog ${tag}..."
    if ! download_with_progress "${base}/${artifact}" "${LEASE_WATCHDOG_BIN}.tmp"; then
        rm -f "${LEASE_WATCHDOG_BIN}.tmp"
        warn "Could not download the lease watchdog; lease mode (Availability, availability sets) stays unavailable on this node."
        return 0
    fi
    checksums=$(curl -fsSL "${base}/checksums.txt" 2>>"$LOG_FILE" || true)
    expected=$(printf '%s\n' "$checksums" | grep " ${artifact}\$" | awk '{print $1}')
    actual=$(sha256sum "${LEASE_WATCHDOG_BIN}.tmp" | awk '{print $1}')
    if [[ -z "$expected" || "$expected" != "$actual" ]]; then
        rm -f "${LEASE_WATCHDOG_BIN}.tmp"
        die "Lease watchdog checksum verification failed."
    fi
    chmod 0755 "${LEASE_WATCHDOG_BIN}.tmp"
    mv -f "${LEASE_WATCHDOG_BIN}.tmp" "$LEASE_WATCHDOG_BIN"
    LEASE_WATCHDOG_INSTALLED=1
    ok "Lease watchdog installed (${tag%-watchdog})"
}

start_lease_watchdog() {
    # Also on a re-run that could not resolve or download a watchdog release: an installed watchdog is restarted with
    # the current run user as its records owner (a run-user switch hands the records over).
    lease_watchdog_profile || return 0
    [[ "$LEASE_WATCHDOG_INSTALLED" -eq 1 || -x "$LEASE_WATCHDOG_BIN" ]] || return 0
    # Runs as root: it must kill container processes of any user. The records
    # directory is owned by the docker-daemon user, which writes the deadlines.
    local args="run --records-owner ${RUN_USER} --auto-update --releases-url ${RELEASES_API_URL} --artifact-base-url ${ARTIFACT_BASE_URL} --channel $(lease_watchdog_channel)"
    if has_systemd; then
        cat > "/etc/systemd/system/${LEASE_WATCHDOG_UNIT}.service" <<UNIT
[Unit]
Description=Gateway Availability Lease Watchdog
# Deliberately independent of docker-daemon and docker: it must keep
# enforcing lease deadlines when either one is stopped, hung or removed.
After=local-fs.target

[Service]
Type=simple
User=root
ExecStart=${LEASE_WATCHDOG_BIN} ${args}
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload >>"$LOG_FILE" 2>&1 || true
        systemctl enable "$LEASE_WATCHDOG_UNIT" >>"$LOG_FILE" 2>&1 || true
        if systemctl restart "$LEASE_WATCHDOG_UNIT" >>"$LOG_FILE" 2>&1; then
            ok "Lease watchdog is running"
        else
            warn "Lease watchdog did not start; lease mode (Availability, availability sets) stays unavailable on this node."
        fi
    elif has_openrc; then
        cat > "/etc/init.d/${LEASE_WATCHDOG_UNIT}" <<UNIT
#!/sbin/openrc-run
name="Gateway Availability Lease Watchdog"
command="${LEASE_WATCHDOG_BIN}"
command_args="${args}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=1
output_log="/var/log/${LEASE_WATCHDOG_UNIT}.log"
error_log="/var/log/${LEASE_WATCHDOG_UNIT}.err"

depend() {
    need localmount
}
UNIT
        chmod +x "/etc/init.d/${LEASE_WATCHDOG_UNIT}"
        rc-update add "$LEASE_WATCHDOG_UNIT" default >>"$LOG_FILE" 2>&1 || true
        if rc-service "$LEASE_WATCHDOG_UNIT" restart >>"$LOG_FILE" 2>&1 || rc-service "$LEASE_WATCHDOG_UNIT" start >>"$LOG_FILE" 2>&1; then
            ok "Lease watchdog is running"
        else
            warn "Lease watchdog did not start; lease mode (Availability, availability sets) stays unavailable on this node."
        fi
    else
        warn "No service manager for the lease watchdog; lease mode (Availability, availability sets) stays unavailable on this node."
    fi
}


# ── Step 3: Install and enroll ───────────────────────────────────────
enroll_daemon() {
    local target="/usr/local/bin/docker-daemon"

    # Check if already enrolled (certs exist)
    if [[ -f /etc/docker-daemon/certs/node.pem && -f /var/lib/docker-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        prepare_run_user_identity
        return 0
    fi

    log "Writing config and enrolling with Gateway..."
    if [[ "$DOCKER_MODE" == "builder" ]]; then
        if ! "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" --mode builder >> "$LOG_FILE" 2>&1; then
            die "Failed to enroll builder docker-daemon. Check ${LOG_FILE} for details."
        fi
    elif ! run_as_run_user "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" --docker-socket "$DOCKER_SOCKET" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll docker-daemon. Check ${LOG_FILE} for details."
    fi
    prepare_run_user_identity
    ok "Config written to /etc/docker-daemon/config.yaml"
}

# ── Step 4: Start the daemon ─────────────────────────────────────────
# A host with systemd or OpenRC runs the daemon as a service, and a service that does not start fails the install.
# Manual mode is only for hosts without a service manager.
start_daemon() {
    retire_legacy_update_guard "docker-daemon" "/usr/local/bin/docker-daemon"
    log "Enabling and starting docker-daemon..."

    if has_systemd; then
        detect_docker_systemd_unit || true
        local docker_after="network-online.target"
        local docker_wants="network-online.target"
        local supplementary_groups=""
        local service_environment=""
        if [[ "$DOCKER_MODE" != "builder" && -n "$DOCKER_SYSTEMD_UNIT" ]]; then
            docker_after="${docker_after} ${DOCKER_SYSTEMD_UNIT}"
            docker_wants="${docker_wants} ${DOCKER_SYSTEMD_UNIT}"
        elif [[ "$DOCKER_MODE" != "builder" ]] && detect_docker_access; then
            warn "Docker is reachable, but no systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        elif [[ "$DOCKER_MODE" != "builder" ]]; then
            warn "No systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        fi
        if [[ "$DOCKER_MODE" != "builder" ]] && docker_group_exists; then
            supplementary_groups="SupplementaryGroups=docker"
        elif [[ "$DOCKER_MODE" == "builder" ]]; then
            service_environment="Environment=\"PATH=${BUILDER_RUNTIME_PATH}\""
        fi

        cat > /etc/systemd/system/docker-daemon.service <<UNIT || die "Could not write the docker-daemon systemd unit."
[Unit]
Description=Gateway Docker Daemon
After=${docker_after}
Wants=${docker_wants}

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/docker-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536
# Link sockets outlive a daemon restart in the file descriptor store.
FileDescriptorStoreMax=4096
NotifyAccess=main
${supplementary_groups}
${service_environment}

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload >> "$LOG_FILE" 2>&1 || die "systemd daemon-reload failed."
        systemctl enable docker-daemon >> "$LOG_FILE" 2>&1 || die "Could not enable docker-daemon."
        forget_gateway_session
        systemctl restart docker-daemon >> "$LOG_FILE" 2>&1 || { release_fd_store_hold; fail_daemon_start "Could not start docker-daemon."; }
        release_fd_store_hold
    elif has_openrc; then
        local openrc_need="net docker"
        [[ "$DOCKER_MODE" != "builder" ]] || openrc_need="net"
        cat > /etc/init.d/docker-daemon <<UNIT || die "Could not write the docker-daemon OpenRC service."
#!/sbin/openrc-run
name="Gateway Docker Daemon"
description="Gateway Docker Daemon"
command="/usr/local/bin/docker-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/docker-daemon.log"
error_log="/var/log/docker-daemon.err"

depend() {
    need ${openrc_need}
}

# supervise-daemon opens the log files after it drops to the service user; a file left by another user (or by root
# before the daemon switched users) would fail it with EACCES, so root hands them over first.
start_pre() {
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/docker-daemon.log
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/docker-daemon.err
}
UNIT
        chmod +x /etc/init.d/docker-daemon || die "Could not make the docker-daemon OpenRC service executable."
        rc-update add docker-daemon default >> "$LOG_FILE" 2>&1 || die "Could not enable docker-daemon in OpenRC."
        forget_gateway_session
        if ! rc-service docker-daemon restart >> "$LOG_FILE" 2>&1 && ! rc-service docker-daemon start >> "$LOG_FILE" 2>&1; then
            fail_daemon_start "Could not start docker-daemon in OpenRC."
        fi
    else
        warn "No supported service manager found; using manual mode."
        manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon" \
            || fail_daemon_start "Could not start docker-daemon in manual mode."
    fi
    ok "docker-daemon started"
}

# ── Run ──────────────────────────────────────────────────────────────
prepare_run_user_switch
create_directories
install_daemon
install_lease_watchdog
install_builder_runtime
preflight_builder_runtime
setup_secure_runtime
remember_host_access_config /etc/docker-daemon/config.yaml
[[ -z "$ROOT_DAEMON_COPY" ]] || rm -rf "$ROOT_DAEMON_COPY"
enroll_daemon
write_database_profile_config
write_builder_profile_config
apply_host_access_config /etc/docker-daemon/config.yaml
finish_run_user_switch
# After the switch: the watchdog starts with --records-owner of the new user and hands its records over at once, before
# the daemon starts (a non-root daemon cannot read records left to the previous user).
start_lease_watchdog
start_daemon
# An install whose daemon does not run or did not connect to Gateway is not done.
if ! await_gateway_connection; then
    die "docker-daemon is installed, but it did not connect to Gateway."
fi
# The daemon enrolls when it first runs, not at install: only now are its certificate and the token's use there.
remember_enrollment_token

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Gateway within a few seconds."
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo -e "  Manual mode is not persistent across reboot."
elif has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status docker-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u docker-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service docker-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/docker-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}docker-daemon run${NC}"
fi
complete_success
