#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Monitoring Node Setup ──────────────────────────────────
# Installs monitoring-daemon on a host and enrolls it with the Gateway.
# No nginx or Docker required — this agent reports system metrics only.
#
# Usage:
#   curl -sSL https://github.com/the-square-labs/gateway/releases/latest/download/setup-monitoring-node.sh | \
#     sudo bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ───────────────────────────────────────────────────────────────────

LOG_FILE="/dev/null"

# ── Colors ────────────────────────────────────────────────────────
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

# ── Defaults ──────────────────────────────────────────────────────
GATEWAY_HOST="${GATEWAY_NODE_HOST:-}"
GATEWAY_PORT="${GATEWAY_NODE_PORT:-9443}"
GATEWAY_ADDR="${GATEWAY_NODE_ADDRESS:-}"
ENROLL_TOKEN="${GATEWAY_NODE_TOKEN:-}"
GATEWAY_CERT_SHA256="${GATEWAY_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
DISABLE_CONSOLE="${GATEWAY_NODE_DISABLE_CONSOLE:-0}"
DISABLE_FILES="${GATEWAY_NODE_DISABLE_FILES:-0}"
RELEASES_API_URL="${GATEWAY_RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"
ARTIFACT_BASE_URL="${GATEWAY_ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"
RUN_USER=""
NON_INTERACTIVE=0
NO_LOGO=0
DRY_RUN=0
GUIDE_ACTIVE=0
APT_UPDATED=0
MANUAL_LAUNCH_TIMEOUT_SECONDS="${GATEWAY_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0
MANUAL_FALLBACK_USED=0

# ── Helpers ───────────────────────────────────────────────────────
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
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Opfield Node Setup"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Monitoring daemon installer"
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

guide_start() {
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "$*"
    else
        GUIDE_ACTIVE=1
        echo -e "${BRAND_MINT}╭${NC} $*"
    fi
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

# A root daemon keeps its binary in /usr/local/bin. A daemon running as its own user must be able to replace its binary
# when it updates itself, so the binary lives in a directory that user owns and /usr/local/bin holds a root-owned wrapper.
MONITORING_BIN_LINK="/usr/local/bin/monitoring-daemon"
MONITORING_OWN_DIR="/usr/local/lib/monitoring-daemon"
MONITORING_OWN_BINARY="${MONITORING_OWN_DIR}/bin/monitoring-daemon"
MONITORING_OWN_HOST_IDENTITY="/var/lib/monitoring-daemon/host-identity"
SHARED_HOST_IDENTITY="/var/lib/gateway/host-identity"

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

# Hands the daemon's configuration, state and binary to the run user: it reads its configuration, writes its
# certificates and state and replaces its binary on update. A daemon switched back to root gets back what its previous
# user owned.
grant_daemon_paths_to_run_user() {
    local path
    if [[ "$RUN_USER" == "root" ]]; then
        return_paths_to_root /etc/monitoring-daemon /var/lib/monitoring-daemon "$MONITORING_OWN_DIR"
        return
    fi
    for path in /etc/monitoring-daemon /var/lib/monitoring-daemon "$MONITORING_OWN_DIR"; do
        [[ ! -e "$path" ]] || chown -hR "${RUN_USER}:${RUN_GROUP}" "$path"
    done
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
PREVIOUS_RUN_UID=$(previous_run_uid /etc/monitoring-daemon /var/lib/monitoring-daemon "$MONITORING_OWN_DIR")

# Gives root every entry in the paths that the previous non-root user owns; entries of other owners keep theirs.
return_paths_to_root() {
    local path
    [[ "$PREVIOUS_RUN_UID" != 0 ]] || return 0
    for path in "$@"; do
        [[ ! -e "$path" ]] || find "$path" -xdev -user "$PREVIOUS_RUN_UID" -exec chown -h 0:0 {} +
    done
}

# A daemon that moves to another user says so, is stopped first and gets a new launcher: the launcher copies in its state
# directory were written by that user, and no other user may run them.
prepare_run_user_switch() {
    # A fresh install has nothing to switch. A daemon that ran as root is stopped before its files change owner too:
    # it keeps rewriting them (atomically, as root) while it runs, and the new user could not read them.
    [[ "$PREVIOUS_RUN_UID" != 0 || -d /etc/monitoring-daemon ]] || return 0
    [[ "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "monitoring-daemon ran as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); switching it to ${RUN_USER}..."
    stop_daemon_service || die "Could not stop monitoring-daemon to switch its user."
    rm -rf /var/lib/monitoring-daemon/launcher
}

stop_daemon_service() {
    if has_systemd; then
        [[ ! -f /etc/systemd/system/monitoring-daemon.service ]] || systemctl stop monitoring-daemon >>"$LOG_FILE" 2>&1
    elif has_openrc; then
        [[ ! -f /etc/init.d/monitoring-daemon ]] || rc-service --ifstarted monitoring-daemon stop >>"$LOG_FILE" 2>&1
    else
        stop_manual_launcher /var/lib/monitoring-daemon/launcher monitoring
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
GATEWAY_SESSION_FILE="/var/lib/monitoring-daemon/gateway-session.json"
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
        grep -q '/monitoring-daemon\.service$' "/proc/${pid}/cgroup" 2>/dev/null || return 1
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
        systemctl is-active --quiet monitoring-daemon
    else
        rc-service monitoring-daemon status >/dev/null 2>&1
    fi
}

show_daemon_log() {
    local manual_log=/var/lib/monitoring-daemon/launcher/manual.log
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        err "Daemon log: ${manual_log}"
        tail -n 20 "$manual_log" >&2 2>/dev/null || true
    elif has_systemd; then
        err "Daemon log: journalctl -u monitoring-daemon"
        journalctl -u monitoring-daemon -n 20 --no-pager >&2 2>/dev/null || true
    elif has_openrc; then
        err "Daemon log: /var/log/monitoring-daemon.err and /var/log/monitoring-daemon.log"
        tail -n 20 /var/log/monitoring-daemon.err /var/log/monitoring-daemon.log >&2 2>/dev/null || true
        # A service supervise-daemon cannot start leaves its reason in the system log, not in the service's own logs.
        grep -h 'supervise-daemon.*monitoring-daemon' /var/log/messages 2>/dev/null | tail -n 5 >&2 || true
    fi
}

fail_daemon_start() {
    err "$1"
    show_daemon_log
    die "monitoring-daemon is installed, but it is not running."
}

# An install is done once the daemon it started runs and Gateway accepted it. A daemon too old to record its session
# must have enrolled and keep running for 10 s instead.
await_gateway_connection() {
    local waited=0 limit="${GATEWAY_MONITORING_ENROLLMENT_WAIT_SECONDS:-90}" running=0
    while (( waited < limit )); do
        if daemon_records_gateway_session "$RESOLVED_DAEMON_VERSION"; then
            if gateway_session_is_current; then
                ok "monitoring-daemon is connected to Opfield"
                return 0
            fi
            # Gateway answered and refused the token: waiting cannot change that.
            if grep -q '"enrollment_refused":true' "$GATEWAY_SESSION_FILE" 2>/dev/null; then
                err "Opfield refused the enrollment token (already used, expired, or for another node): $(gateway_session_enrollment_error)"
                err "Create a new setup command in Opfield and run it on this host."
                show_daemon_log
                return 1
            fi
        elif [[ -f /etc/monitoring-daemon/certs/node.pem && -f /var/lib/monitoring-daemon/state.json ]] && daemon_service_running; then
            running=$((running + 1))
            if (( running >= 10 )); then
                ok "monitoring-daemon enrolled with Opfield and is running"
                warn "monitoring-daemon ${RESOLVED_DAEMON_VERSION} does not report its Opfield connection; check that the node is online in Opfield."
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
        err "monitoring-daemon could not enroll with Opfield: ${enrollment_error}"
    elif ! daemon_service_running; then
        err "monitoring-daemon is not running; the service manager could not keep it up. The log below shows why."
    else
        err "monitoring-daemon has not connected to Opfield within ${limit} s; check that Opfield at ${GATEWAY_ADDR} is reachable."
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
        printf 'runuser -u %q -g %q -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
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
            user_prefix=(runuser -u "$RUN_USER" -g "$RUN_GROUP" --)
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

check_dependencies() {
    if command_exists curl; then
        return
    fi
    [[ "$DRY_RUN" -eq 0 ]] || die "curl is required to resolve the daemon release during dry run."
    log "curl not found, installing it..."
    if command_exists apt-get; then
        if [[ "$APT_UPDATED" -eq 0 ]]; then
            apt-get update >>"$LOG_FILE" 2>&1
            APT_UPDATED=1
        fi
        apt-get install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists yum; then
        yum install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists dnf; then
        dnf install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists apk; then
        apk add curl ca-certificates >>"$LOG_FILE" 2>&1
    else
        die "curl is required and no supported package manager was found for automatic installation."
    fi
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-monitoring}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

# The token a completed enrollment used, as a digest, written once the daemon this run started enrolled and connected:
# a re-run of the same setup command (its token now used) keeps the node's enrollment.
ENROLLMENT_TOKEN_DIGEST_FILE="/var/lib/monitoring-daemon/enrollment-token.sha256"
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
    [[ -n "$ENROLL_TOKEN" && -f /etc/monitoring-daemon/certs/node.pem ]] || return 0
    (umask 077; enrollment_token_digest "$ENROLL_TOKEN" > "$ENROLLMENT_TOKEN_DIGEST_FILE") 2>> "$LOG_FILE" || return 0
    chown "${RUN_USER}:${RUN_GROUP}" "$ENROLLMENT_TOKEN_DIGEST_FILE" 2>> "$LOG_FILE" || true
}

# monitoring-daemon enrolls once: a host that is enrolled cannot take another node's token in place, so such a token is not
# used and the host keeps its node. An enrollment from an installer that kept no token digest (v2.11.0 and before)
# cannot tell its own setup command, which operators re-run to update the daemon, from a new node's: the run goes on as
# a re-run without a token and warns. With a digest, a different token is a new node's: the run fails before it changes
# anything, so the new node (still pending in Gateway) does not go unnoticed.
refuse_token_for_enrolled_node() {
    [[ -n "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 ]] || return 0
    local node_id node
    node_id=$(sed -nE 's/.*"node_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' /var/lib/monitoring-daemon/state.json 2>/dev/null | head -n 1 || true)
    node="monitoring node ${node_id:-(unknown id)}${EXISTING_GATEWAY_ADDR:+ of Opfield ${EXISTING_GATEWAY_ADDR}}"
    if [[ ! -f "$ENROLLMENT_TOKEN_DIGEST_FILE" ]]; then
        warn "This host is already enrolled as ${node}; the run keeps that enrollment and does not use the enrollment token."
        warn "If this is this node's own setup command (its token already used), nothing else is needed. If it is not, the"
        warn "new node was not enrolled: to enroll this host as that node, stop monitoring-daemon, move /etc/monitoring-daemon/certs and"
        warn "/var/lib/monitoring-daemon/state.json out of the way, run its setup command again, and delete the old node in Opfield."
        ENROLL_TOKEN=""
        return 0
    fi
    err "This host is already enrolled as ${node}; the enrollment token was not used, and nothing was changed."
    err "To keep this node (update, repair, change its run user), run the installer again without --token."
    err "To enroll this host as the new node instead: stop monitoring-daemon, move /etc/monitoring-daemon/certs and /var/lib/monitoring-daemon/state.json"
    err "out of the way, run this command again, and delete the old node in Opfield."
    die "The host is already enrolled; the new node stays pending in Opfield."
}

detect_existing_install() {
    local target="/usr/local/bin/monitoring-daemon"
    local config_path="/etc/monitoring-daemon/config.yaml"
    local state_path="/var/lib/monitoring-daemon/state.json"
    local cert_path="/etc/monitoring-daemon/certs/node.pem"
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
    local binary_name="monitoring-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest monitoring release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${RELEASES_API_URL}?component=monitoring-daemon")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-monitoring"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest monitoring release tag from ${RELEASES_API_URL}"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-monitoring}"
        RELEASE_BASE="${ARTIFACT_BASE_URL}/monitoring-daemon/${latest_tag}"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${ARTIFACT_BASE_URL}/monitoring-daemon/${RESOLVED_DAEMON_VERSION}-monitoring"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
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

# ── Parse Arguments ───────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Opfield Monitoring Node Setup — installs monitoring-daemon and enrolls with Opfield

Usage:
  setup-monitoring-node.sh [options]

  In interactive mode (default), the script prompts only for missing Opfield host,
  enrollment token, and Opfield certificate fingerprint. Port defaults to 9443 and
  daemon version defaults to latest unless supplied.

Options:
  --gateway <addr>         Opfield gRPC address as host:port (e.g. gateway.example.com:9443)
  --host <host>            Opfield hostname or IP (e.g. gateway.example.com)
  --port <port>            Opfield gRPC port (default: 9443)
  --token <token>          Enrollment token from Opfield UI (Nodes > Add Node)
  --gateway-cert-sha256 <fp>
                           Opfield gRPC TLS leaf fingerprint from the generated setup command
  --version <ver>          Daemon version to install (default: latest; never older than an installed one)
  --user <user>            Run daemon as this user (default: root)
  --disable-console        Turn the host console off (console.enabled: false in the daemon config)
  --disable-files          Turn host file access off (files.enabled: false in the daemon config)
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
  GATEWAY_NODE_DISABLE_CONSOLE  Set to 1 to disable the host console
  GATEWAY_NODE_DISABLE_FILES    Set to 1 to disable host file access
  GATEWAY_RELEASES_API_URL      Override the Opfield release feed
  GATEWAY_ARTIFACT_BASE_URL     Override the Opfield artifact base URL

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-monitoring-node.sh

  # Partially interactive (pre-fill host, prompt for token):
  sudo bash setup-monitoring-node.sh --host gateway.example.com

  # Fully non-interactive:
  sudo bash setup-monitoring-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom daemon user:
  sudo bash setup-monitoring-node.sh --user monitor --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
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
        --user)           RUN_USER="$2"; shift 2 ;;
        --disable-console) DISABLE_CONSOLE=1; shift ;;
        --disable-files)  DISABLE_FILES=1; shift ;;
        --no-logo)        NO_LOGO=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; NO_LOGO=1; shift ;;
        -h|--help)        show_help ;;
        *) die "Unknown option: $1. Use --help for usage." ;;
    esac
done

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

# ── Validate ──────────────────────────────────────────────────────
need_root
if [[ "$DRY_RUN" -eq 0 ]]; then
    LOG_FILE=$(mktemp /tmp/gateway_monitoring_setup.XXXXXX) || die "Could not create installer log file"
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

# ── Logo ──────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo
fi

# ── Interactive configuration ─────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Download and install the monitoring-daemon binary${NC}"
    guide "${GRAY}  2. Enroll this node with your Opfield server${NC}"
    guide "${GRAY}  3. Start the daemon as a systemd service${NC}"
    guide "${GRAY}  No nginx or other software is required.${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled monitoring node detected — reusing the current Opfield connection settings"
    else
        # Gateway host
        if [[ -z "$GATEWAY_HOST" ]]; then
            GATEWAY_HOST=$(prompt_input "Opfield hostname or IP" "")
            [[ -z "$GATEWAY_HOST" ]] && die "Opfield hostname is required"
        else
            guide "${GRAY}Opfield host: ${BRAND_MINT}${GATEWAY_HOST}${NC}"
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
            GATEWAY_CERT_SHA256=$(prompt_input "Opfield certificate SHA-256 fingerprint" "")
            [[ -z "$GATEWAY_CERT_SHA256" ]] && die "Opfield certificate SHA-256 fingerprint is required"
        else
            guide "${GRAY}Opfield cert: ${GATEWAY_CERT_SHA256}${NC}"
        fi

        guide_blank
    fi

    guide_blank

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
    refuse_token_for_enrolled_node
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
fi

# ── Resolve run user/group ────────────────────────────────────────
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
keep_installed_newer_daemon monitoring-daemon

# ── Confirmation ──────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing monitoring-daemon installation detected"
    echo -e "  ${GRAY}Current version: ${BRAND_MINT}${EXISTING_VERSION}${NC}"
    echo -e "  ${GRAY}Version to install: ${BRAND_MINT}${RESOLVED_DAEMON_VERSION}${NC}"
    echo ""
fi

summary_start
summary_row "Opfield:     ${GATEWAY_ADDR}"
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
summary_row "Install ver: ${RESOLVED_DAEMON_VERSION}"
summary_row "Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
summary_row "Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
summary_row "Run as:      ${RUN_USER}:${RUN_GROUP}"
summary_row "Updates:     ${ARTIFACT_BASE_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
fi
guide_blank

# ── Host access switches ──────────────────────────────────────────
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

# What a real run does with the daemon binary: monitoring-daemon at the path this run installs it to is kept when it already has
# the version to install, else downloaded.
preview_daemon_binary() {
    local target="${MONITORING_OWN_BINARY}"
    if [[ "$RUN_USER" == "root" ]]; then
        target="${MONITORING_BIN_LINK}"
        # A link or wrapper of a non-root install is replaced by a downloaded root binary.
        if [[ -L "$target" ]] || is_daemon_wrapper "$target"; then target=""; fi
    fi
    if [[ -n "$target" && -f "$target" && "$(daemon_binary_version "$target" || true)" == "$RESOLVED_DAEMON_VERSION" ]]; then
        ok "monitoring-daemon already installed (${RESOLVED_DAEMON_VERSION})"
    else
        log "Downloading monitoring-daemon..."
        ok "monitoring-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    fi
    if [[ "$RUN_USER" != "root" ]]; then
        ok "${MONITORING_BIN_LINK} runs ${MONITORING_OWN_BINARY} as ${RUN_USER} (dry run)"
    fi
}

preview_run_user_switch() {
    [[ "$PREVIOUS_RUN_UID" != 0 && "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "monitoring-daemon runs as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); it is stopped and switched to ${RUN_USER} (dry run)"
}

preview_service_start() {
    local manager="manual mode (no supported service manager; not persistent across reboot)"
    if has_systemd; then
        manager="systemd unit monitoring-daemon"
    elif has_openrc; then
        manager="OpenRC service monitoring-daemon"
    fi
    log "Enabling and starting monitoring-daemon as ${RUN_USER} (${manager})..."
    ok "monitoring-daemon is connected to Opfield (dry run)"
}

dry_run_preview() {
    preview_run_user_switch
    log "Creating required directories..."
    ok "Directories created (dry run)"
    preview_daemon_binary
    if [[ "$EXISTING_ENROLLED" -eq 1 ]]; then
        ok "Node already enrolled — skipping enrollment (dry run)"
    else
        log "Writing config and enrolling with Opfield..."
        ok "Config written to /etc/monitoring-daemon/config.yaml (dry run)"
    fi
    preview_host_access_config /etc/monitoring-daemon/config.yaml
    preview_service_start
    complete_success "Dry run completed successfully — no host changes were made."
}


# ── Step 1: Create directories ────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/monitoring-daemon/certs
    mkdir -p /var/lib/monitoring-daemon
    grant_daemon_paths_to_run_user

    ok "Directories created"
}

# ── Step 2: Download monitoring-daemon binary ─────────────────────

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
        if [[ -L "$MONITORING_BIN_LINK" ]] || is_daemon_wrapper "$MONITORING_BIN_LINK"; then
            rm -f "$MONITORING_BIN_LINK"
        fi
        install_daemon_binary "$MONITORING_BIN_LINK"
        return
    fi
    install -d -m 0755 "$MONITORING_OWN_DIR" "$(dirname "$MONITORING_OWN_BINARY")"
    install_daemon_binary "$MONITORING_OWN_BINARY"
    write_daemon_wrapper "$MONITORING_BIN_LINK" "$MONITORING_OWN_BINARY" || die "Could not write the monitoring-daemon command at $MONITORING_BIN_LINK."
    grant_daemon_paths_to_run_user
}

install_daemon_binary() {
    local target="$1"
    local binary_name="monitoring-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$(daemon_binary_version "$target" || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "monitoring-daemon already installed (${existing_ver})"
            return 0
        fi
        # The version the node runs is the installed command's (EXISTING_VERSION): the binary here can be a copy a
        # run as another user left behind (a run-user switch), which says nothing about what is installed.
        local installed_ver="$existing_ver"
        [[ "$EXISTING_VERSION" =~ ^v[0-9] ]] && installed_ver="$EXISTING_VERSION"
        if [[ "$installed_ver" == "$RESOLVED_DAEMON_VERSION" ]]; then
            log "Installing monitoring-daemon ${RESOLVED_DAEMON_VERSION} at ${target}..."
        else
            log "Upgrading monitoring-daemon from ${installed_ver} to ${RESOLVED_DAEMON_VERSION}..."
        fi
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
        prune_older_backups "$target" "$backup"
    else
        log "Downloading monitoring-daemon..."
    fi

    if curl -fsSL "$DOWNLOAD_URL" -o "${target}.tmp" >> "$LOG_FILE" 2>&1; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$(daemon_binary_version "$target" || echo "unknown")
        ok "monitoring-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        die "Failed to download monitoring-daemon ${RESOLVED_DAEMON_VERSION} from releases"
    fi
}


# ── Step 3: Install and enroll ────────────────────────────────────
enroll_daemon() {
    local target="/usr/local/bin/monitoring-daemon"

    # Check if already enrolled (certs exist)
    if [[ -f /etc/monitoring-daemon/certs/node.pem && -f /var/lib/monitoring-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        prepare_run_user_identity
        return 0
    fi

    log "Writing config and enrolling with Opfield..."
    if ! run_as_run_user "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll monitoring-daemon. Check ${LOG_FILE} for details."
    fi
    prepare_run_user_identity
    ok "Config written to /etc/monitoring-daemon/config.yaml"
}

# A daemon running as its own user enrolls with its copy of the host identity and owns everything it writes.
prepare_run_user_identity() {
    if [[ "$RUN_USER" == "root" ]]; then
        clear_config_host_identity_path /etc/monitoring-daemon/config.yaml \
            || die "Could not point /etc/monitoring-daemon/config.yaml at the shared host identity."
        return 0
    fi
    seed_host_identity_copy "$SHARED_HOST_IDENTITY" "$MONITORING_OWN_HOST_IDENTITY" \
        || die "Could not prepare the host identity for ${RUN_USER}."
    set_config_host_identity_path /etc/monitoring-daemon/config.yaml "$MONITORING_OWN_HOST_IDENTITY" \
        || die "Could not point /etc/monitoring-daemon/config.yaml at ${MONITORING_OWN_HOST_IDENTITY}."
    grant_daemon_paths_to_run_user
}

# ── Step 4: Start the daemon ──────────────────────────────────────
# A host with systemd or OpenRC runs the daemon as a service, and a service that does not start fails the install.
# Manual mode is only for hosts without a service manager.
start_daemon() {
    retire_legacy_update_guard "monitoring-daemon" "/usr/local/bin/monitoring-daemon"
    log "Enabling and starting monitoring-daemon..."

    if has_systemd; then
        cat > /etc/systemd/system/monitoring-daemon.service <<UNIT || die "Could not write the monitoring-daemon systemd unit."
[Unit]
Description=Opfield Monitoring Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/monitoring-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload >> "$LOG_FILE" 2>&1 || die "systemd daemon-reload failed."
        systemctl enable monitoring-daemon >> "$LOG_FILE" 2>&1 || die "Could not enable monitoring-daemon."
        forget_gateway_session
        systemctl restart monitoring-daemon >> "$LOG_FILE" 2>&1 || fail_daemon_start "Could not start monitoring-daemon."
    elif has_openrc; then
        cat > /etc/init.d/monitoring-daemon <<UNIT || die "Could not write the monitoring-daemon OpenRC service."
#!/sbin/openrc-run
name="Opfield Monitoring Daemon"
description="Opfield Monitoring Daemon"
command="/usr/local/bin/monitoring-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/monitoring-daemon.log"
error_log="/var/log/monitoring-daemon.err"

depend() {
    need net
}

# supervise-daemon opens the log files after it drops to the service user; a file left by another user (or by root
# before the daemon switched users) would fail it with EACCES, so root hands them over first.
start_pre() {
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/monitoring-daemon.log
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/monitoring-daemon.err
}
UNIT
        chmod +x /etc/init.d/monitoring-daemon || die "Could not make the monitoring-daemon OpenRC service executable."
        rc-update add monitoring-daemon default >> "$LOG_FILE" 2>&1 || die "Could not enable monitoring-daemon in OpenRC."
        forget_gateway_session
        if ! rc-service monitoring-daemon restart >> "$LOG_FILE" 2>&1 && ! rc-service monitoring-daemon start >> "$LOG_FILE" 2>&1; then
            fail_daemon_start "Could not start monitoring-daemon in OpenRC."
        fi
    else
        warn "No supported service manager found; using manual mode."
        manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon" \
            || fail_daemon_start "Could not start monitoring-daemon in manual mode."
    fi
    ok "monitoring-daemon started"
}

# A dry run stops here, once every function it uses is defined.
if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

# ── Run ───────────────────────────────────────────────────────────
prepare_run_user_switch
create_directories
install_daemon
remember_host_access_config /etc/monitoring-daemon/config.yaml
enroll_daemon
apply_host_access_config /etc/monitoring-daemon/config.yaml
start_daemon
# An install whose daemon does not run or did not connect to Gateway is not done.
if ! await_gateway_connection; then
    die "monitoring-daemon is installed, but it did not connect to Opfield."
fi
# The daemon enrolls when it first runs, not at install: only now are its certificate and the token's use there.
remember_enrollment_token

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Opfield within a few seconds."
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo -e "  Manual mode is not persistent across reboot."
elif has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status monitoring-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u monitoring-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service monitoring-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/monitoring-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}monitoring-daemon run${NC}"
fi
complete_success
