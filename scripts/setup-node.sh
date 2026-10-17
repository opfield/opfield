#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# legacy-compat: scripts/stage-installers.sh puts scripts/legacy-compat.sh in place of this line.
# shellcheck source=legacy-compat.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/legacy-compat.sh"

# ── Opfield Nginx Node Setup ─────────────────────────────────────────
# Installs nginx + nginx-daemon on a host and enrolls it with Opfield.
#
# Usage:
#   curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-node.sh | \
#     bash -s -- --opfield opfield.example.com:9443 --token <ENROLLMENT_TOKEN> --opfield-cert-sha256 sha256:<HEX>
#
# Or download and run:
#   bash setup-node.sh --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<HEX>
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
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'
TITLE_TAG='\033[48;2;140;176;132m\033[30m'

# ── Defaults ─────────────────────────────────────────────────────────
# legacy-name: pre-2.12.1 names of the
# installer environment — customer automation; drop with a changelog notice. Each is read when its OPFIELD_* name is
# not set (the new name wins).
for legacy_suffix in NODE_HOST NODE_PORT NODE_ADDRESS NODE_TOKEN NODE_CERT_SHA256 NODE_DAEMON_VERSION \
    NODE_SKIP_NGINX NODE_DISABLE_CONSOLE NODE_DISABLE_FILES NODE_NGINX_MODE NODE_APT_LOCK_RETRY_ATTEMPTS NODE_APT_LOCK_RETRY_DELAY_SECONDS \
    NODE_ENROLLMENT_WAIT_SECONDS RELEASES_API_URL ARTIFACT_BASE_URL MANUAL_LAUNCH_TIMEOUT_SECONDS; do
    legacy_env="${LEGACY_ENV_PREFIX}${legacy_suffix}"
    opfield_env="OPFIELD_${legacy_suffix}"
    if [[ -z "${!opfield_env:-}" && -n "${!legacy_env:-}" ]]; then
        printf -v "$opfield_env" '%s' "${!legacy_env}"
    fi
done
unset legacy_suffix legacy_env opfield_env
OPFIELD_HOST="${OPFIELD_NODE_HOST:-}"
OPFIELD_PORT="${OPFIELD_NODE_PORT:-9443}"
OPFIELD_ADDR="${OPFIELD_NODE_ADDRESS:-}"
ENROLL_TOKEN="${OPFIELD_NODE_TOKEN:-}"
OPFIELD_CERT_SHA256="${OPFIELD_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${OPFIELD_NODE_DAEMON_VERSION:-latest}"
SKIP_NGINX="${OPFIELD_NODE_SKIP_NGINX:-0}"
DISABLE_CONSOLE="${OPFIELD_NODE_DISABLE_CONSOLE:-0}"
DISABLE_FILES="${OPFIELD_NODE_DISABLE_FILES:-0}"
RELEASES_API_URL="${OPFIELD_RELEASES_API_URL:-https://get.opfield.dev/opfield/releases}"
ARTIFACT_BASE_URL="${OPFIELD_ARTIFACT_BASE_URL:-https://get.opfield.dev/opfield}"
RUN_USER=""
NGINX_MODE="${OPFIELD_NODE_NGINX_MODE:-}"
NON_INTERACTIVE=0
NO_LOGO=0
DRY_RUN=0
GUIDE_ACTIVE=0
STUB_STATUS_URL="http://127.0.0.1/nginx_status"
INTEGRATED_STUB_STATUS_PORT="8081"
# The Opfield nginx tree. A node installed before 2.12.1 has it at the legacy path; migrate_nginx_tree moves it
# here and leaves the legacy path as a link to it, because configurations written for the old path still name it.
NGINX_OPFIELD_DIR="/etc/nginx/opfield"
# legacy-name: the legacy nginx tree of nodes installed before 2.12.1 (kept as a link) — remove once every node
# reports none and no customer configuration names it
NGINX_LEGACY_DIR="$LEGACY_NGINX_DIR"
NGINX_SITES_DIR="${NGINX_OPFIELD_DIR}/conf.d"
NGINX_LEGACY_SITES_DIR="${NGINX_LEGACY_DIR}/conf.d"
NGINX_HTPASSWD_DIR="${NGINX_OPFIELD_DIR}/htpasswd"
NGINX_GLOBAL_CONF="/etc/nginx/nginx.conf"
NGINX_SYSTEMD_DROPIN_DIR="/etc/systemd/system/nginx.service.d"
NGINX_OPENRC_CONF_DIR="/etc/conf.d"
NGINX_MIN_VERSION="1.25.1"
NGINX_WORKER_NOFILE_MIN=65535
NGINX_SERVICE_NOFILE_MIN=65536
NGINX_WORKER_CONNECTIONS_MIN=8192
NGINX_SERVICE_RESTART_REQUIRED=0
APT_LOCK_RETRY_ATTEMPTS="${OPFIELD_NODE_APT_LOCK_RETRY_ATTEMPTS:-12}"
APT_LOCK_RETRY_DELAY_SECONDS="${OPFIELD_NODE_APT_LOCK_RETRY_DELAY_SECONDS:-5}"
MANUAL_LAUNCH_TIMEOUT_SECONDS="${OPFIELD_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_OPFIELD_ADDR=""
EXISTING_ENROLLED=0
MANUAL_FALLBACK_USED=0

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

show_header() {
    local title="$1"
    local subtitle="$2"

    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$title"
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
has_existing_nginx_config() {
    [[ -s /etc/nginx/nginx.conf || -s /usr/local/etc/nginx/nginx.conf || -s /usr/local/nginx/conf/nginx.conf ]]
}

# Whether an nginx config file has the directive line (leading and trailing
# blanks ignored; a commented-out line does not count).
nginx_conf_has_line() {
    local conf="$1"
    local line="$2"
    [[ -f "$conf" ]] || return 1
    awk -v line="$line" '
        { trimmed = $0; sub(/^[[:space:]]+/, "", trimmed); sub(/[[:space:]]+$/, "", trimmed) }
        trimmed == line { found = 1 }
        END { exit found ? 0 : 1 }
    ' "$conf"
}

# The nginx mode of an earlier Opfield install on this host, or nothing: a
# managed install writes nginx.conf with a direct include of the Opfield sites
# directory, an integrated one adds the include of sites.include.conf.
detect_installed_nginx_mode() {
    local global_conf="/etc/nginx/nginx.conf"
    # legacy-name: include lines of the legacy nginx tree written before 2.12.1 — remove once every node reports none
    if nginx_conf_has_line "$global_conf" "include ${NGINX_OPFIELD_DIR}/sites.include.conf;" || \
        nginx_conf_has_line "$global_conf" "include ${NGINX_LEGACY_DIR}/sites.include.conf;"; then
        echo "integrate"
    elif nginx_conf_has_line "$global_conf" "include ${NGINX_SITES_DIR}/*.conf;" || \
        nginx_conf_has_line "$global_conf" "include ${NGINX_LEGACY_SITES_DIR}/*.conf;"; then
        echo "managed"
    fi
}
# Before anything changes: an /etc/nginx/opfield directory with files next to the legacy nginx directory cannot be
# merged by the installer.
preflight_nginx_tree() {
    [[ -d "$NGINX_LEGACY_DIR" && ! -L "$NGINX_LEGACY_DIR" && -d "$NGINX_OPFIELD_DIR" && ! -L "$NGINX_OPFIELD_DIR" ]] || return 0
    [[ -n "$(ls -A "$NGINX_OPFIELD_DIR" 2>/dev/null)" ]] || return 0
    err "${NGINX_LEGACY_DIR} and ${NGINX_OPFIELD_DIR} are both directories with files; the Opfield nginx tree must be one of them."
    err "Move the files of ${NGINX_OPFIELD_DIR} into ${NGINX_LEGACY_DIR}, remove ${NGINX_OPFIELD_DIR}, and run the installer again."
    die "The nginx tree cannot be moved; nothing was changed."
}

has_systemd() { command_exists systemctl && [[ -d /run/systemd/system ]]; }
has_openrc() { command_exists rc-service && command_exists rc-update; }

# OpenRC caches service dependencies (/run/openrc/deptree) and checks the cache against the init scripts' mtimes in
# whole seconds: a script written in the second the cache was built (by a service started moments before) is missing
# from it at the next boot, and its service does not start. Rebuilt after every init script the installer writes.
openrc_refresh_deptree() {
    rc-update -u >> "$LOG_FILE" 2>&1 || warn "Could not refresh the OpenRC dependency cache; run: rc-update -u"
}

# ── Non-root mode ────────────────────────────────────────────────────
# A root daemon keeps its binary in /usr/local/bin. A daemon running as its own user must be able to replace its binary
# when it updates itself, so the binary lives in a directory that user owns and /usr/local/bin holds a root-owned wrapper.
NGINX_DAEMON_BIN_LINK="/usr/local/bin/nginx-daemon"
NGINX_DAEMON_OWN_DIR="/usr/local/lib/nginx-daemon"
NGINX_DAEMON_OWN_BINARY="${NGINX_DAEMON_OWN_DIR}/bin/nginx-daemon"
NGINX_DAEMON_OWN_HOST_IDENTITY="/var/lib/nginx-daemon/host-identity"
# The identity root daemons of one host share. The daemons move the legacy state root to /var/lib/opfield themselves
# (after a start their launcher confirmed) and leave it as a link to it; the installer never moves it.
SHARED_HOST_IDENTITY_DIR="/var/lib/opfield"
# legacy-name: the legacy shared host identity directory of daemons before 2.12.1 — remove once every node
# reports none
LEGACY_SHARED_HOST_IDENTITY_DIR="$LEGACY_STATE_ROOT"
# Sockets the daemon serves to nginx and Secure Links; root creates them on demand, a run user needs them prepared.
NGINX_DAEMON_RUNTIME_DIRS=(nginx-daemon opfield-secure-links opfield-registry-links opfield-ingress-health)
# An existing node whose daemon has not moved to the Opfield names yet (it writes opfield-names in its state directory
# when it has) still uses the old directories, and a daemon running as its own user cannot create the new ones itself:
# prepare both until its move.
# legacy-name: legacy nginx-daemon runtime directories — remove once every node reports none
if [[ -d /var/lib/nginx-daemon && ! -e /var/lib/nginx-daemon/opfield-names ]]; then
    NGINX_DAEMON_RUNTIME_DIRS+=("${LEGACY_RUNTIME_DIR_PREFIX}secure-links" "${LEGACY_RUNTIME_DIR_PREFIX}registry-links" "${LEGACY_RUNTIME_DIR_PREFIX}ingress-health")
fi
# Whether this host ran daemons under the pre-Opfield names before this run (unmoved, or moved and left with their
# links), read before the installer changes anything. Only such a host keeps old names: the old /run names at boot
# (directories before the move, links to the Opfield ones after) and links next to directories created under the new
# names. A fresh host gets none.
# legacy-name: pre-Opfield daemon names on this host — remove once every node reports none
NGINX_HAD_LEGACY_NAMES=0
if [[ -d /var/lib/nginx-daemon && ! -e /var/lib/nginx-daemon/opfield-names ]] ||
    [[ -e "$LEGACY_NGINX_DIR" || -L "$LEGACY_NGINX_DIR" || -e "$LEGACY_STATE_ROOT" || -L "$LEGACY_STATE_ROOT" ]] ||
    [[ -e "/run/${LEGACY_RUNTIME_DIR_PREFIX}secure-links" || -L "/run/${LEGACY_RUNTIME_DIR_PREFIX}secure-links" ]] ||
    [[ -e "/etc/systemd/system/${LEGACY_LEASE_WATCHDOG}.service" || -e "/etc/init.d/${LEGACY_LEASE_WATCHDOG}" ]] ||
    grep -qs "^${LEGACY_CONFIG_SECTION}:" /etc/nginx-daemon/config.yaml /etc/docker-daemon/config.yaml /etc/monitoring-daemon/config.yaml; then
    NGINX_HAD_LEGACY_NAMES=1
fi

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
DAEMON_WRAPPER_MARK="# opfield-daemon-wrapper: runs the service user's binary, never as root"
# legacy-name: wrapper marker written by installers before 2.12.1 — remove once every node reports none
LEGACY_DAEMON_WRAPPER_MARK="$LEGACY_DAEMON_WRAPPER_LINE"
write_daemon_wrapper() {
    local command_path="$1" binary="$2" temporary
    temporary=$(mktemp "$(dirname "$command_path")/.opfield-daemon-wrapper.XXXXXX") || return 1
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
    [[ -f "$1" && ! -L "$1" ]] && grep -Fqx -e "$DAEMON_WRAPPER_MARK" -e "$LEGACY_DAEMON_WRAPPER_MARK" "$1" 2>/dev/null
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

# The PID of the nginx master that serves this host's configuration, from its pid file.
nginx_master_pid() {
    local pid_path pid
    pid_path=$(nginx -T 2>/dev/null | sed -nE 's/^[[:space:]]*pid[[:space:]]+([^;[:space:]]+)[[:space:]]*;.*/\1/p' | tail -n 1 || true)
    [[ -n "$pid_path" ]] || pid_path=$(nginx -V 2>&1 | grep -o -- '--pid-path=[^ ]*' | cut -d= -f2 || true)
    [[ -n "$pid_path" ]] || pid_path=/run/nginx.pid
    [[ -s "$pid_path" ]] || return 1
    pid=$(tr -dc '0-9' <"$pid_path")
    [[ -n "$pid" && -d "/proc/${pid}" ]] || return 1
    printf '%s\n' "$pid"
}

# The pid file the host's nginx service watches: the one its unit (PIDFile=) or init script (pidfile=) names, else the
# one nginx was built with. An nginx.conf that names another file leaves the service manager without a master process
# (OpenRC reports the service crashed and cannot restart it while the old master keeps its ports).
nginx_service_pid_file() {
    local pid_file=""
    if has_systemd; then
        pid_file=$(systemctl show nginx.service -p PIDFile --value 2>/dev/null || true)
    elif has_openrc && [[ -f /etc/init.d/nginx ]]; then
        pid_file=$(sed -nE "s/^[[:space:]]*pidfile=[\"']?([^\"'[:space:]]*)[\"']?[[:space:]]*\$/\1/p" /etc/init.d/nginx | head -n 1)
    fi
    if [[ ! "$pid_file" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
        pid_file=$(nginx -V 2>&1 | grep -o -- '--pid-path=[^ ]*' | cut -d= -f2 || true)
    fi
    [[ "$pid_file" =~ ^/[A-Za-z0-9._/-]+$ ]] || pid_file=/run/nginx.pid
    printf '%s\n' "$pid_file"
}

# The directory of nginx's pid file. Its service creates it when it starts, so on a host whose nginx has not run since
# boot (an OpenRC /run/nginx, a tmpfs /run) nginx -t fails before the service ever starts.
ensure_nginx_pid_directory() {
    [[ "$DRY_RUN" -eq 0 ]] || return 0
    local pid_file pid_dir
    pid_file=$(nginx -T 2>/dev/null | sed -nE 's/^[[:space:]]*pid[[:space:]]+([^;[:space:]]+)[[:space:]]*;.*/\1/p' | tail -n 1 || true)
    [[ "$pid_file" =~ ^/[A-Za-z0-9._/-]+$ ]] || pid_file=$(nginx_service_pid_file)
    pid_dir="${pid_file%/*}"
    [[ -n "$pid_dir" && "$pid_dir" != /run && "$pid_dir" != /var/run && ! -e "$pid_dir" ]] || return 0
    install -d -m 0755 "$pid_dir"
}

backup_if_exists() {
    local file="$1"
    BACKUP_PATH=""
    if [[ -f "$file" ]]; then
        local backup="${file}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$file" "$backup"
        log "Backed up ${file} to ${backup}"
        prune_older_backups "$file" "$backup"
        BACKUP_PATH="$backup"
    fi
}

# nginx files this run changed, each followed by the copy taken before the change, so a failed nginx -t puts the
# previous configuration back instead of leaving a broken one for the next reload.
NGINX_CONFIG_ROLLBACK=()

# Only the first copy of a file counts: a second one in the same second would overwrite it with the changed file.
backup_nginx_config() {
    local index
    for ((index = 0; index < ${#NGINX_CONFIG_ROLLBACK[@]}; index += 2)); do
        [[ "${NGINX_CONFIG_ROLLBACK[index]}" == "$1" ]] && return 0
    done
    backup_if_exists "$1"
    [[ -n "$BACKUP_PATH" ]] && NGINX_CONFIG_ROLLBACK+=("$1" "$BACKUP_PATH")
    return 0
}

restore_nginx_config() {
    local index
    for ((index = 0; index < ${#NGINX_CONFIG_ROLLBACK[@]}; index += 2)); do
        if cp "${NGINX_CONFIG_ROLLBACK[index + 1]}" "${NGINX_CONFIG_ROLLBACK[index]}"; then
            log "Restored ${NGINX_CONFIG_ROLLBACK[index]} from ${NGINX_CONFIG_ROLLBACK[index + 1]}"
        else
            warn "Could not restore ${NGINX_CONFIG_ROLLBACK[index]} from ${NGINX_CONFIG_ROLLBACK[index + 1]}"
        fi
    done
}

# A root nginx must not leave its pid directory to the unprivileged nginx user that Alpine's service assigns it to on
# every start and reload: the daemon signals the process the pid file names. The service gives the directory to root
# unless /etc/conf.d/nginx runs nginx as another user (command_user), which then has to own it to write its pid. An
# earlier installer wrote root:root there for good; that is replaced even for a non-root daemon, because it takes the
# directory from the user nginx runs as.
# The service also tests the configuration as root before every start, and nginx -t creates a missing pid file (after
# every stop and every reboot): it would belong to root, and an nginx run as command_user could not start. So the
# service gives the pid file to that user too, before the test. The nginx daemon names the same line when it is missing.
NGINX_OPENRC_STOCK_LINE='checkpath --directory --owner nginx:nginx '
NGINX_OPENRC_EARLIER_LINE='checkpath --directory --mode 0755 --owner root:root '
NGINX_OPENRC_PID_FILE_LINE='checkpath --file --mode 0644 --owner "${command_user:-root:root}" ${pidfile}'

# The service hands nginx its pid directory but not its pid file.
nginx_openrc_pid_file_line_missing() {
    grep -Eq '^[[:space:]]*checkpath --directory .*[$][{]pidfile%/[*][}]' "$1" && \
        ! grep -Eq '^[[:space:]]*checkpath[[:space:]](.*[[:space:]])?(-f|--file)[[:space:]].*[$][{]?pidfile[}]?[[:space:]]*$' "$1"
}

ensure_nginx_openrc_pid_directory() {
    has_openrc || return 0
    [[ "$DRY_RUN" -eq 0 ]] || return 0
    local service=/etc/init.d/nginx
    local stock="$NGINX_OPENRC_STOCK_LINE"
    local earlier="$NGINX_OPENRC_EARLIER_LINE"
    local secured='checkpath --directory --mode 0755 --owner "${command_user:-root:root}" '
    local replaced=""
    local add_pid_file=0
    local mode
    local parent
    local candidate

    [[ -f "$service" && ! -L "$service" ]] || return 0
    if [[ "$RUN_USER" == "root" ]] && grep -Fq "${stock}"'${pidfile%/*}' "$service"; then
        replaced="$stock"
    elif grep -Fq "${earlier}"'${pidfile%/*}' "$service"; then
        replaced="$earlier"
    fi
    ! nginx_openrc_pid_file_line_missing "$service" || add_pid_file=1
    [[ -n "$replaced" || "$add_pid_file" -eq 1 ]] || return 0
    [[ "$(head -n 1 "$service")" == '#!/sbin/openrc-run' ]] || return 0
    for parent in /etc /etc/init.d; do
        [[ -d "$parent" && ! -L "$parent" && "$(stat -c %u "$parent")" == 0 ]] || \
            die "Untrusted nginx OpenRC service directory"
        mode=$(stat -c %a "$parent")
        (( (8#$mode & 8#022) == 0 )) || die "Untrusted nginx OpenRC service directory permissions"
    done
    [[ "$(stat -c %u "$service")" == 0 ]] || die "Untrusted nginx OpenRC service owner"
    mode=$(stat -c %a "$service")
    (( (8#$mode & 8#022) == 0 )) || die "Untrusted nginx OpenRC service permissions"
    candidate=$(mktemp /etc/init.d/.nginx-opfield-XXXXXX)
    cat "$service" > "$candidate"
    if [[ -n "$replaced" ]]; then
        sed "s/${replaced}/${secured}/" "$service" > "$candidate"
    fi
    if [[ "$add_pid_file" -eq 1 ]]; then
        # After each line that hands over the pid directory, with its indentation.
        awk -v line="$NGINX_OPENRC_PID_FILE_LINE" '{ print }
            /checkpath --directory / && index($0, "${pidfile%/*}") { match($0, /^[ \t]*/); print substr($0, 1, RLENGTH) line }' \
            "$candidate" > "${candidate}.pid" && cat "${candidate}.pid" > "$candidate"
        rm -f "${candidate}.pid"
    fi
    if { [[ -n "$replaced" ]] && ! grep -Fq "${secured}"'${pidfile%/*}' "$candidate"; } || \
        nginx_openrc_pid_file_line_missing "$candidate" || ! sh -n "$candidate"; then
        rm -f "$candidate"
        die "Invalid nginx OpenRC service after PID-directory migration"
    fi
    chmod "$mode" "$candidate"
    backup_if_exists "$service"
    mv -f "$candidate" "$service"
    openrc_refresh_deptree
    log "Secured nginx OpenRC PID-directory and PID-file ownership for start and reload"
}

# An operator who prepared nginx for the daemon's user (command_user in /etc/conf.d/nginx) on a host whose nginx service
# still has the line an earlier installer wrote, or no line for the pid file, has an nginx that cannot start: the service
# hands /run/nginx, or the pid file its own nginx -t creates, to root on every start. The preflight only detects this (it
# changes nothing); the repair is part of the plan the user confirms.
NGINX_SERVICE_REPAIR_PLANNED=0
nginx_openrc_service_repair_needed() {
    has_openrc || return 1
    [[ "$RUN_USER" != "root" && -f /etc/init.d/nginx && ! -L /etc/init.d/nginx ]] || return 1
    grep -Fq "${NGINX_OPENRC_EARLIER_LINE}"'${pidfile%/*}' /etc/init.d/nginx || \
        nginx_openrc_pid_file_line_missing /etc/init.d/nginx || return 1
    grep -Eq "^[[:space:]]*command_user=[\"']?${RUN_USER}([:\"'[:space:]]|\$)" /etc/conf.d/nginx 2>/dev/null || return 1
    ! rc-service nginx status >/dev/null 2>&1
}

# After the service line is migrated, the nginx that could not start for it is started (zap clears a crashed state).
start_nginx_after_service_repair() {
    [[ "$NGINX_SERVICE_REPAIR_PLANNED" -eq 1 && "$DRY_RUN" -eq 0 ]] || return 0
    ! rc-service nginx status >/dev/null 2>&1 || return 0
    rc-service nginx zap >> "$LOG_FILE" 2>&1 || true
    rc-service nginx start >> "$LOG_FILE" 2>&1 || die "Could not start nginx as ${RUN_USER} after updating its OpenRC service; see ${LOG_FILE}."
    log "Started nginx, which could not start with the earlier PID ownership"
}

# The daemon writes /etc/nginx and reloads nginx itself, so a non-root daemon needs an nginx master that runs as the
# same user. The installer does not convert the host's nginx service; it stops before changing anything instead.
preflight_run_user_nginx() {
    if [[ "$RUN_USER" == "root" ]]; then
        preflight_root_nginx
        return
    fi
    local run_uid master_pid master_uid problem=""
    run_uid=$(id -u "$RUN_USER")
    if ! command_exists nginx; then
        problem="nginx is not installed"
    elif nginx_openrc_service_repair_needed; then
        # The master cannot be found until the service is repaired, which the confirmed install does.
        NGINX_SERVICE_REPAIR_PLANNED=1
    elif ! master_pid=$(nginx_master_pid); then
        problem="no running nginx master process was found"
    else
        master_uid=$(stat -c '%u' "/proc/${master_pid}")
        if [[ "$master_uid" != "$run_uid" ]]; then
            problem="the nginx master process (PID ${master_pid}) runs as $(id -nu "$master_uid" 2>/dev/null || echo "uid ${master_uid}")"
        fi
    fi
    if [[ -z "$problem" && "$NGINX_MODE" == "managed" ]]; then
        problem="managed nginx mode replaces nginx.conf with one for an nginx started as root"
    fi
    [[ -n "$problem" ]] || return 0
    err "nginx-daemon can run as '${RUN_USER}' only next to an nginx whose master process runs as ${RUN_USER}; here ${problem}."
    err "The daemon writes /etc/nginx and reloads nginx itself. Prepare nginx, then run this installer again with --nginx-mode integrate:"
    err "  - run the nginx service as ${RUN_USER}:${RUN_GROUP} with CAP_NET_BIND_SERVICE and its pid file in a directory ${RUN_USER} owns"
    err "    (systemd drop-in for nginx.service: User=, Group=, AmbientCapabilities=CAP_NET_BIND_SERVICE, RuntimeDirectory=nginx,"
    err "    RuntimeDirectoryPreserve=yes, PIDFile=/run/nginx/nginx.pid, and 'pid /run/nginx/nginx.pid;' in nginx.conf;"
    err "    OpenRC: command_user=\"${RUN_USER}:${RUN_GROUP}\" and"
    err "    capabilities=\"^cap_net_bind_service\" in /etc/conf.d/nginx, and 'pid /run/nginx/nginx.pid;' in nginx.conf);"
    err "  - give ${RUN_USER} /etc/nginx, /var/log/nginx and the nginx temp directories, and make log rotation create files as ${RUN_USER};"
    err "  - start the prepared service (OpenRC: rc-service nginx zap, then rc-service nginx start; a service that crashed needs the zap);"
    err "  - or install nginx-daemon as root (--user root)."
    die "nginx is not prepared for a non-root nginx-daemon; nothing was changed."
}

# A root daemon writes nginx's configuration and keys as root, which an nginx master running as another user cannot
# read. A node switched back to root therefore needs its nginx service back to root first.
preflight_root_nginx() {
    local master_pid master_uid master_user
    command_exists nginx && master_pid=$(nginx_master_pid) || return 0
    master_uid=$(stat -c '%u' "/proc/${master_pid}")
    [[ "$master_uid" != 0 ]] || return 0
    master_user=$(id -nu "$master_uid" 2>/dev/null || echo "uid ${master_uid}")
    err "nginx-daemon runs as root here, but the nginx master process (PID ${master_pid}) runs as ${master_user}."
    err "Run the nginx service as root again (remove the drop-in that sets User=, Group= and AmbientCapabilities= for"
    err "nginx.service and restart nginx), give nginx's temp directories and log rotation back to its packaged owner,"
    err "then run this installer again. The installer gives /etc/nginx, /var/log/nginx and /var/www/acme-challenge back"
    err "to root itself. To keep nginx as ${master_user}, install nginx-daemon with --user ${master_user}."
    die "nginx runs as ${master_user}, not root; nothing was changed."
}

# Hands the daemon everything it writes: its configuration, state and binary, nginx's configuration and logs, the ACME
# challenge directory and its runtime socket directories. A daemon switched back to root gets back what its previous
# user owned there, so that user can no longer change what a root nginx loads.
grant_daemon_paths_to_run_user() {
    local path
    # While a switch away from a non-root user waits for the daemon to stop, that user keeps what it owns.
    [[ "$RUN_USER_SWITCH_PENDING" -eq 0 ]] || return 0
    if [[ "$RUN_USER" == "root" ]]; then
        return_paths_to_root /etc/nginx-daemon /var/lib/nginx-daemon "$NGINX_DAEMON_OWN_DIR" /etc/nginx /var/log/nginx \
            /var/www/acme-challenge "${NGINX_DAEMON_RUNTIME_DIRS[@]/#//run/}"
        return
    fi
    for path in /etc/nginx-daemon /var/lib/nginx-daemon "$NGINX_DAEMON_OWN_DIR" /etc/nginx /var/log/nginx /var/www/acme-challenge; do
        [[ ! -e "$path" ]] || chown -hR "${RUN_USER}:${RUN_GROUP}" "$path"
    done
    for path in "${NGINX_DAEMON_RUNTIME_DIRS[@]}"; do
        install -d -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "/run/${path}"
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
PREVIOUS_RUN_UID=$(previous_run_uid /etc/nginx-daemon /var/lib/nginx-daemon "$NGINX_DAEMON_OWN_DIR")

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
    [[ "$PREVIOUS_RUN_UID" != 0 || -d /etc/nginx-daemon ]] || return 0
    [[ "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "nginx-daemon ran as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); switching it to ${RUN_USER}..."
    if [[ -z "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 ]]; then
        RUN_USER_SWITCH_PENDING=1
        return 0
    fi
    stop_daemon_service || die "Could not stop nginx-daemon to switch its user."
    rm -rf /var/lib/nginx-daemon/launcher
}

# systemd drops a unit's file descriptor store when the unit stops (not when it restarts), and the daemon that stops hands
# its link sockets to that store for the next process. The store is kept for the switch, through the stop, the ownership
# change and the start, so connections made meanwhile wait in the sockets' backlog instead of being reset.
FD_STORE_HOLD=/run/systemd/system/nginx-daemon.service.d/zz-run-user-switch.conf
hold_fd_store() {
    has_systemd || return 0
    [[ -f /etc/systemd/system/nginx-daemon.service ]] || return 0
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
    log "Stopping nginx-daemon to switch its user..."
    hold_fd_store
    stop_daemon_service || { release_fd_store_hold; die "Could not stop nginx-daemon to switch its user."; }
    rm -rf /var/lib/nginx-daemon/launcher
    grant_daemon_paths_to_run_user
}

stop_daemon_service() {
    if has_systemd; then
        [[ ! -f /etc/systemd/system/nginx-daemon.service ]] || systemctl stop nginx-daemon >>"$LOG_FILE" 2>&1
    elif has_openrc; then
        [[ ! -f /etc/init.d/nginx-daemon ]] || rc-service --ifstarted nginx-daemon stop >>"$LOG_FILE" 2>&1
    else
        stop_manual_launcher /var/lib/nginx-daemon/launcher nginx
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

# The shared host identity: at /var/lib/opfield when it is there (a file, or through a linked directory), else at the
# legacy state root when that has one, else a new one is created at /var/lib/opfield. With neither, both are looked
# at once more after a pause: a daemon moving the directory right then must not make the host look like a new one.
shared_host_identity_path() {
    local current="${SHARED_HOST_IDENTITY_DIR}/host-identity"
    # legacy-name: host-identity in the legacy state root of daemons before 2.12.1 — remove once every node reports none
    local legacy="${LEGACY_SHARED_HOST_IDENTITY_DIR}/host-identity"
    local attempt
    for attempt in 1 2; do
        if [[ -e "$current" || -L "$current" ]]; then
            echo "$current"
            return 0
        fi
        if [[ -e "$legacy" || -L "$legacy" ]]; then
            echo "$legacy"
            return 0
        fi
        [[ "$attempt" -eq 2 ]] || sleep 1
    done
    echo "$current"
}

# On a host that ran daemons under the pre-Opfield names, a shared identity directory created at /var/lib/opfield gets
# the legacy state root as a link to it, the layout the daemons leave after they move the directory, so a daemon of an
# earlier release on this host finds the same identity. A fresh host gets no old name.
link_legacy_host_identity_dir() {
    [[ "$NGINX_HAD_LEGACY_NAMES" -eq 1 ]] || return 0
    [[ -d "$SHARED_HOST_IDENTITY_DIR" && ! -L "$SHARED_HOST_IDENTITY_DIR" ]] || return 0
    [[ ! -e "$LEGACY_SHARED_HOST_IDENTITY_DIR" && ! -L "$LEGACY_SHARED_HOST_IDENTITY_DIR" ]] || return 0
    ln -s "$(basename "$SHARED_HOST_IDENTITY_DIR")" "$LEGACY_SHARED_HOST_IDENTITY_DIR" 2>/dev/null || true
}

# A daemon running as its own user cannot read the host identity that root daemons share (root-owned, mode 0600). It
# gets a copy of that same identity in its own state directory, so Opfield still sees one host and the shared file
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
        clear_config_host_identity_path /etc/nginx-daemon/config.yaml \
            || die "Could not point /etc/nginx-daemon/config.yaml at the shared host identity."
        return 0
    fi
    local shared
    shared=$(shared_host_identity_path)
    seed_host_identity_copy "$shared" "$NGINX_DAEMON_OWN_HOST_IDENTITY" \
        || die "Could not prepare the host identity for ${RUN_USER}."
    link_legacy_host_identity_dir
    set_config_host_identity_path /etc/nginx-daemon/config.yaml "$NGINX_DAEMON_OWN_HOST_IDENTITY" \
        || die "Could not point /etc/nginx-daemon/config.yaml at ${NGINX_DAEMON_OWN_HOST_IDENTITY}."
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

# The daemon records each control session Opfield accepted in its state directory (from CONTROL_SESSION_SINCE on).
# The installer removes the record before it starts the daemon, so only a session of the daemon it started counts.
CONTROL_SESSION_SINCE="v2.11.1-rc.2"
CONTROL_SESSION_FILE="/var/lib/nginx-daemon/control-session.json"
# legacy-name: the legacy session record of daemons before 2.12.1 (2.12.1 daemons write both) — remove once
# every node reports none
LEGACY_CONTROL_SESSION_FILE="/var/lib/nginx-daemon/${LEGACY_SESSION_FILE_NAME}"
CONTROL_SESSION_STARTED=0

forget_control_session() {
    rm -f "$CONTROL_SESSION_FILE" "$LEGACY_CONTROL_SESSION_FILE"
    CONTROL_SESSION_STARTED=$(date +%s)
}

# The session record to read: the daemon's current one, else the one a daemon of an earlier release writes.
control_session_file() {
    if [[ -e "$CONTROL_SESSION_FILE" || -L "$CONTROL_SESSION_FILE" || ! -e "$LEGACY_CONTROL_SESSION_FILE" ]]; then
        echo "$CONTROL_SESSION_FILE"
    else
        echo "$LEGACY_CONTROL_SESSION_FILE"
    fi
}

# Orders vX.Y.Z and vX.Y.Z-rc.N; a release orders after its release candidates.
release_order() {
    [[ "${1#v}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-rc\.([0-9]+))?$ ]] || return 1
    echo $(( ((BASH_REMATCH[1] * 1000 + BASH_REMATCH[2]) * 1000 + BASH_REMATCH[3]) * 100000 + ${BASH_REMATCH[5]:-99999} ))
}

# Daemons older than CONTROL_SESSION_SINCE write no session record; development builds do.
daemon_records_control_session() {
    local order
    order=$(release_order "$1") || return 0
    (( order >= $(release_order "$CONTROL_SESSION_SINCE") ))
}

# Opfield accepted a session of the daemon this run started, and that process still runs under its service manager.
control_session_is_current() {
    local pid connected_at session
    session=$(control_session_file)
    [[ -f "$session" && ! -L "$session" ]] || return 1
    pid=$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$session")
    connected_at=$(sed -nE 's/.*"connected_at":([0-9]+).*/\1/p' "$session")
    [[ -n "$pid" && -n "$connected_at" ]] || return 1
    (( connected_at >= CONTROL_SESSION_STARTED )) || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    if [[ "$MANUAL_FALLBACK_USED" -eq 0 ]] && has_systemd; then
        grep -q '/nginx-daemon\.service$' "/proc/${pid}/cgroup" 2>/dev/null || return 1
    fi
}

# The enrollment error the daemon started by this run recorded instead of a session, if any.
control_session_enrollment_error() {
    local session
    session=$(control_session_file)
    [[ -f "$session" && ! -L "$session" ]] || return 1
    sed -nE 's/.*"enrollment_error":"(([^"\\]|\\.)*)".*/\1/p' "$session" | grep .
}

daemon_service_running() {
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        launcher_pid_is_live "${MANUAL_OWNER_PID:-}"
    elif has_systemd; then
        systemctl is-active --quiet nginx-daemon
    else
        rc-service nginx-daemon status >/dev/null 2>&1
    fi
}

show_daemon_log() {
    local manual_log=/var/lib/nginx-daemon/launcher/manual.log
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        err "Daemon log: ${manual_log}"
        tail -n 20 "$manual_log" >&2 2>/dev/null || true
    elif has_systemd; then
        err "Daemon log: journalctl -u nginx-daemon"
        journalctl -u nginx-daemon -n 20 --no-pager >&2 2>/dev/null || true
    elif has_openrc; then
        err "Daemon log: /var/log/nginx-daemon.err and /var/log/nginx-daemon.log"
        tail -n 20 /var/log/nginx-daemon.err /var/log/nginx-daemon.log >&2 2>/dev/null || true
        # A service supervise-daemon cannot start leaves its reason in the system log, not in the service's own logs.
        grep -h 'supervise-daemon.*nginx-daemon' /var/log/messages 2>/dev/null | tail -n 5 >&2 || true
    fi
}

fail_daemon_start() {
    err "$1"
    show_daemon_log
    die "nginx-daemon is installed, but it is not running."
}

# An install is done once the daemon it started runs and Opfield accepted it. A daemon too old to record its session
# must have enrolled and keep running for 10 s instead.
await_opfield_connection() {
    local waited=0 limit="${OPFIELD_NODE_ENROLLMENT_WAIT_SECONDS:-90}" running=0
    while (( waited < limit )); do
        if daemon_records_control_session "$RESOLVED_DAEMON_VERSION"; then
            if control_session_is_current; then
                ok "nginx-daemon is connected to Opfield"
                return 0
            fi
            # Opfield answered and refused the token: waiting cannot change that.
            if grep -q '"enrollment_refused":true' "$(control_session_file)" 2>/dev/null; then
                err "Opfield refused the enrollment token (already used, expired, or for another node): $(control_session_enrollment_error)"
                err "Create a new setup command in Opfield and run it on this host."
                show_daemon_log
                return 1
            fi
        elif [[ -f /etc/nginx-daemon/certs/node.pem && -f /var/lib/nginx-daemon/state.json ]] && daemon_service_running; then
            running=$((running + 1))
            if (( running >= 10 )); then
                ok "nginx-daemon enrolled with Opfield and is running"
                warn "nginx-daemon ${RESOLVED_DAEMON_VERSION} does not report its Opfield connection; check that the node is online in Opfield."
                return 0
            fi
        else
            running=0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    local enrollment_error
    if enrollment_error=$(control_session_enrollment_error); then
        err "nginx-daemon could not enroll with Opfield: ${enrollment_error}"
    elif ! daemon_service_running; then
        err "nginx-daemon is not running; the service manager could not keep it up. The log below shows why."
    else
        err "nginx-daemon has not connected to Opfield within ${limit} s; check that Opfield at ${OPFIELD_ADDR} is reachable."
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
    forget_control_session
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
    if ! command_exists curl; then
        die "curl is required but not found. Install it and retry."
    fi
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-nginx}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

# The token a completed enrollment used, as a digest: a re-run of the same setup command (its token now used) keeps
# the node's enrollment instead of replacing it with a token Opfield refuses.
ENROLLMENT_TOKEN_DIGEST_FILE="/var/lib/nginx-daemon/enrollment-token.sha256"
enrollment_token_digest() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

# A node already enrolled with this setup command's token keeps that enrollment: the re-run goes on as one without a
# token (Opfield would refuse the used token, and the node would lose a working enrollment).
keep_enrollment_of_used_token() {
    [[ -n "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 && -f "$ENROLLMENT_TOKEN_DIGEST_FILE" ]] || return 0
    [[ "$(cat "$ENROLLMENT_TOKEN_DIGEST_FILE" 2>/dev/null)" == "$(enrollment_token_digest "$ENROLL_TOKEN")" ]] || return 0
    log "This node is already enrolled with this setup command's token; keeping its enrollment."
    ENROLL_TOKEN=""
}

# The address: of a top-level section (opfield: or the pre-Opfield one) of the daemon configuration, without quotes or comment.
config_section_address() {
    awk -v section="$2" '
        $0 ~ ("^" section ":[[:space:]]*(#.*)?$") { in_section = 1; next }
        in_section && /^[^[:space:]#]/ { in_section = 0 }
        in_section && /^[[:space:]]+address:[[:space:]]*/ {
            value = $0
            sub(/^[[:space:]]+address:[[:space:]]*/, "", value)
            if (value ~ /^"/) { sub(/^"/, "", value); sub(/".*$/, "", value) }
            else { sub(/[[:space:]]+#.*$/, "", value); sub(/[[:space:]]+$/, "", value) }
            print value
            exit
        }
    ' "$1"
}

detect_existing_install() {
    local target="/usr/local/bin/nginx-daemon"
    local config_path="/etc/nginx-daemon/config.yaml"
    local state_path="/var/lib/nginx-daemon/state.json"
    local cert_path="/etc/nginx-daemon/certs/node.pem"
    EXISTING_INSTALL=0
    EXISTING_VERSION=""
    EXISTING_OPFIELD_ADDR=""
    EXISTING_ENROLLED=0

    if [[ -x "$target" ]]; then
        EXISTING_INSTALL=1
        EXISTING_VERSION=$(daemon_binary_version "$target" || echo "unknown")
    fi

    if [[ -f "$config_path" ]]; then
        EXISTING_OPFIELD_ADDR=$(config_section_address "$config_path" opfield)
        # legacy-name: the pre-Opfield section of /etc/nginx-daemon/config.yaml written before 2.12.1 — remove once every node
        # reports none
        [[ -n "$EXISTING_OPFIELD_ADDR" ]] || EXISTING_OPFIELD_ADDR=$(config_section_address "$config_path" "$LEGACY_CONFIG_SECTION")
        if [[ -z "$EXISTING_OPFIELD_ADDR" ]]; then
            EXISTING_OPFIELD_ADDR=$(awk -F'"' '/^[[:space:]]*address:[[:space:]]*"/ {print $2; exit}' "$config_path")
        fi
        if [[ -z "$EXISTING_OPFIELD_ADDR" ]]; then
            EXISTING_OPFIELD_ADDR=$(awk '/^[[:space:]]*address:[[:space:]]*/ {print $2; exit}' "$config_path")
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
# OPFIELD_NODE_DAEMON_VERSION) naming the older release installs it.
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
    local binary_name="nginx-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest nginx release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${RELEASES_API_URL}?component=nginx-daemon")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-nginx"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest nginx release tag from ${RELEASES_API_URL}"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-nginx}"
        RELEASE_BASE="${ARTIFACT_BASE_URL}/nginx-daemon/${latest_tag}"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${ARTIFACT_BASE_URL}/nginx-daemon/${RESOLVED_DAEMON_VERSION}-nginx"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

# ── Parse Arguments ──────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Opfield Node Setup — installs nginx + nginx-daemon and enrolls with Opfield

Usage:
  setup-node.sh [options]

  In interactive mode (default), the script prompts only for missing Opfield host,
  enrollment token, and Opfield certificate fingerprint. Port defaults to 9443 and
  daemon version defaults to latest unless supplied.

Options:
  --opfield <addr>         Opfield gRPC address as host:port (e.g. opfield.example.com:9443)
  --host <host>            Opfield hostname or IP (e.g. opfield.example.com)
  --port <port>            Opfield gRPC port (default: 9443)
  --token <token>          Enrollment token from Opfield UI (Nodes > Add Node)
  --opfield-cert-sha256 <fp>
                           Opfield gRPC TLS leaf fingerprint from the generated setup command
  --version <ver>          Daemon version to install (default: latest; never older than an installed one)
  --user <user>            Run daemon as this user (default: root)
  --skip-nginx             Reuse installed nginx (must be 1.25.1 or newer)
  --nginx-mode <mode>      Nginx config mode: managed or integrate
  --disable-console        Turn the host console off (console.enabled: false in the daemon config)
  --disable-files          Turn host file access off (files.enabled: false in the daemon config)
  --no-logo                Suppress the logo banner
  --dry-run                Validate inputs and show the plan without changing the host
  -y, --yes                Non-interactive mode (no prompts, all values required via flags)
  -h, --help               Show this help

Environment variables:
  OPFIELD_NODE_HOST             Same as --host
  OPFIELD_NODE_PORT             Same as --port (default: 9443)
  OPFIELD_NODE_ADDRESS          Same as --opfield (host:port combined)
  OPFIELD_NODE_TOKEN            Same as --token
  OPFIELD_NODE_CERT_SHA256      Same as --opfield-cert-sha256
  OPFIELD_NODE_DAEMON_VERSION   Same as --version
  OPFIELD_NODE_SKIP_NGINX       Set to 1 to skip nginx install
  OPFIELD_NODE_NGINX_MODE       Same as --nginx-mode
  OPFIELD_NODE_DISABLE_CONSOLE  Set to 1 to disable the host console
  OPFIELD_NODE_DISABLE_FILES    Set to 1 to disable host file access
  OPFIELD_RELEASES_API_URL      Override the Opfield release feed
  OPFIELD_ARTIFACT_BASE_URL     Override the Opfield artifact base URL

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-node.sh

  # Partially interactive (pre-fill host, prompt for token):
  sudo bash setup-node.sh --host opfield.example.com

  # Fully non-interactive:
  sudo bash setup-node.sh -y --host opfield.example.com --token opf_node_abc123 --opfield-cert-sha256 sha256:<HEX>

  # Host and port combined:
  sudo bash setup-node.sh --opfield opfield.example.com:9443 --token opf_node_abc123 --opfield-cert-sha256 sha256:<HEX>

  # Custom daemon user:
  sudo bash setup-node.sh --user www-data --opfield opfield.example.com:9443 --token TOKEN --opfield-cert-sha256 sha256:<HEX>
HELP
    exit 0
}

LEGACY_ADDR_FLAG=""
LEGACY_CERT_SHA256_FLAG=""
OPFIELD_ADDR_FLAG=""
OPFIELD_CERT_SHA256_FLAG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --opfield)        OPFIELD_ADDR_FLAG="$2"; shift 2 ;;
        # legacy-name: LEGACY_ADDRESS_FLAG — customer automation; drop with a changelog notice
        "$LEGACY_ADDRESS_FLAG") LEGACY_ADDR_FLAG="$2"; shift 2 ;;
        --host)           OPFIELD_HOST="$2"; shift 2 ;;
        --port)           OPFIELD_PORT="$2"; shift 2 ;;
        --token)          ENROLL_TOKEN="$2"; shift 2 ;;
        --opfield-cert-sha256) OPFIELD_CERT_SHA256_FLAG="$2"; shift 2 ;;
        # legacy-name: LEGACY_CERT_FLAG — customer automation; drop with a changelog notice
        "$LEGACY_CERT_FLAG") LEGACY_CERT_SHA256_FLAG="$2"; shift 2 ;;
        --version)        DAEMON_VERSION="$2"; shift 2 ;;
        --user)           RUN_USER="$2"; shift 2 ;;
        --skip-nginx)     SKIP_NGINX=1; shift ;;
        --nginx-mode)     NGINX_MODE="$2"; shift 2 ;;
        --disable-console) DISABLE_CONSOLE=1; shift ;;
        --disable-files)  DISABLE_FILES=1; shift ;;
        --no-logo)        NO_LOGO=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; NO_LOGO=1; shift ;;
        -h|--help)        show_help ;;
        *) die "Unknown option: $1. Use --help for usage." ;;
    esac
done
# A new flag wins over its legacy synonym, and either over the environment.
if [[ -n "$OPFIELD_ADDR_FLAG" ]]; then
    OPFIELD_ADDR="$OPFIELD_ADDR_FLAG"
elif [[ -n "$LEGACY_ADDR_FLAG" ]]; then
    OPFIELD_ADDR="$LEGACY_ADDR_FLAG"
fi
if [[ -n "$OPFIELD_CERT_SHA256_FLAG" ]]; then
    OPFIELD_CERT_SHA256="$OPFIELD_CERT_SHA256_FLAG"
elif [[ -n "$LEGACY_CERT_SHA256_FLAG" ]]; then
    OPFIELD_CERT_SHA256="$LEGACY_CERT_SHA256_FLAG"
fi
unset LEGACY_ADDR_FLAG LEGACY_CERT_SHA256_FLAG OPFIELD_ADDR_FLAG OPFIELD_CERT_SHA256_FLAG

# Resolve OPFIELD_ADDR from --host/--port if --opfield not given
if [[ -n "$OPFIELD_HOST" && -z "$OPFIELD_ADDR" ]]; then
    OPFIELD_ADDR="${OPFIELD_HOST}:${OPFIELD_PORT}"
fi
# If --opfield was given, extract host/port for display
if [[ -n "$OPFIELD_ADDR" && -z "$OPFIELD_HOST" ]]; then
    OPFIELD_HOST="${OPFIELD_ADDR%%:*}"
    OPFIELD_PORT="${OPFIELD_ADDR##*:}"
    # If no port in the address, use default
    if [[ "$OPFIELD_PORT" == "$OPFIELD_HOST" ]]; then
        OPFIELD_PORT="9443"
        OPFIELD_ADDR="${OPFIELD_HOST}:${OPFIELD_PORT}"
    fi
fi

# ── Validate ─────────────────────────────────────────────────────────
need_root
if [[ "$DRY_RUN" -eq 0 ]]; then
    LOG_FILE=$(mktemp /tmp/opfield_node_setup.XXXXXX) || die "Could not create installer log file"
    chmod 600 "$LOG_FILE" || die "Could not secure installer log file"
fi
detect_os
detect_arch
check_dependencies
detect_existing_install
keep_enrollment_of_used_token

if [[ -z "$OPFIELD_ADDR" && -n "$EXISTING_OPFIELD_ADDR" ]]; then
    OPFIELD_ADDR="$EXISTING_OPFIELD_ADDR"
    OPFIELD_HOST="${OPFIELD_ADDR%%:*}"
    OPFIELD_PORT="${OPFIELD_ADDR##*:}"
    if [[ "$OPFIELD_PORT" == "$OPFIELD_HOST" ]]; then
        OPFIELD_PORT="9443"
        OPFIELD_ADDR="${OPFIELD_HOST}:${OPFIELD_PORT}"
    fi
fi

# A host that already runs a Opfield nginx node keeps its nginx mode when
# --nginx-mode is not given. Re-running the enroll command without it on a
# managed host picked integrate, which added a second include of the Opfield
# sites directory ("duplicate default server"). Only a host without an
# earlier install gets the default.
if [[ -z "$NGINX_MODE" ]]; then
    NGINX_MODE="$(detect_installed_nginx_mode)"
fi

# ── Header ───────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [ -t 1 ] && command -v clear &>/dev/null; then
        clear
    fi
    show_header "Opfield Node Setup" "Nginx daemon installer"
fi

# ── Interactive configuration ────────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Install nginx (if not present)${NC}"
    guide "${GRAY}  2. Download and install the nginx-daemon binary${NC}"
    guide "${GRAY}  3. Enroll this node with your Opfield server${NC}"
    guide "${GRAY}  4. Start the daemon as a systemd service${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_OPFIELD_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled nginx node detected — reusing the current Opfield connection settings"
    else
        # Opfield host
        if [[ -z "$OPFIELD_HOST" ]]; then
            OPFIELD_HOST=$(prompt_input "Opfield hostname or IP" "")
            [[ -z "$OPFIELD_HOST" ]] && die "Opfield hostname is required"
        else
            guide "${GRAY}Opfield host: ${BRAND_MINT}${OPFIELD_HOST}${NC}"
        fi

        OPFIELD_ADDR="${OPFIELD_HOST}:${OPFIELD_PORT}"

        guide_blank

        # Enrollment token
        if [[ -z "$ENROLL_TOKEN" ]]; then
            ENROLL_TOKEN=$(prompt_secret "Enrollment token (from Nodes > Add Node)")
            [[ -z "$ENROLL_TOKEN" ]] && die "Enrollment token is required"
        else
            guide "${GRAY}Token: ${ENROLL_TOKEN:0:12}...${ENROLL_TOKEN: -4}${NC}"
        fi

        guide_blank

        if [[ -z "$OPFIELD_CERT_SHA256" ]]; then
            OPFIELD_CERT_SHA256=$(prompt_input "Opfield certificate SHA-256 fingerprint" "")
            [[ -z "$OPFIELD_CERT_SHA256" ]] && die "Opfield certificate SHA-256 fingerprint is required"
        else
            guide "${GRAY}Opfield cert: ${OPFIELD_CERT_SHA256}${NC}"
        fi
        # The daemon refuses any other form at enrollment, after the whole install.
        [[ "$OPFIELD_CERT_SHA256" =~ ^[sS][hH][aA]256:[0-9a-fA-F]{64}$ ]] ||
            die "Opfield certificate SHA-256 fingerprint must be sha256: followed by 64 hex characters (copy it from Nodes > Add Node)"

        guide_blank
    fi

    guide_blank

    # User selection
    if [[ -z "$RUN_USER" ]]; then
        selector_title "Run daemon as:"
        user_choice=$(prompt_choice "Choose" "1" "root  [default]" "Current user ($(logname 2>/dev/null || echo "${SUDO_USER:-root}"))" "Custom user")
        case "$user_choice" in
            1|root)   RUN_USER="root" ;;
            2)        RUN_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-root}")" ;;
            3)        RUN_USER=$(prompt_input "Username" ""); [[ -z "$RUN_USER" ]] && die "Username is required" ;;
            *)        RUN_USER="root" ;;
        esac
        guide "${GRAY}Selected: ${NC}${RUN_USER}"
        [[ -z "$NGINX_MODE" ]] && has_existing_nginx_config && guide_blank
    fi

    if [[ -z "$NGINX_MODE" ]] && has_existing_nginx_config; then
        selector_title "Nginx configuration mode:"
        nginx_mode_choice=$(prompt_choice "Choose" "2" "Managed    — installer owns the base nginx config" "Integrate  — keep existing nginx.conf and add Opfield includes")
        case "$nginx_mode_choice" in
            1|managed)   NGINX_MODE="managed" ;;
            2|integrate) NGINX_MODE="integrate" ;;
            *)           NGINX_MODE="integrate" ;;
        esac
        guide "${GRAY}Selected: ${NC}${NGINX_MODE}"
    elif [[ -z "$NGINX_MODE" ]]; then
        NGINX_MODE="managed"
    fi
    guide_end
else
    # Non-interactive: validate required fields
    if [[ -z "$OPFIELD_ADDR" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--opfield or --host is required in non-interactive mode"
    fi
    if [[ -z "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--token is required in non-interactive mode"
    fi
    if [[ -z "$OPFIELD_CERT_SHA256" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--opfield-cert-sha256 is required in non-interactive mode"
    fi
    # The daemon refuses any other form at enrollment, after the whole install.
    [[ -z "$OPFIELD_CERT_SHA256" || "$OPFIELD_CERT_SHA256" =~ ^[sS][hH][aA]256:[0-9a-fA-F]{64}$ ]] ||
        die "Opfield certificate SHA-256 fingerprint must be sha256: followed by 64 hex characters (copy it from Nodes > Add Node)"
    # Default user to root in non-interactive mode
    [[ -z "$RUN_USER" ]] && RUN_USER="root"
    if [[ -z "$NGINX_MODE" ]]; then
        if has_existing_nginx_config; then
            NGINX_MODE="integrate"
        else
            NGINX_MODE="managed"
        fi
    fi
fi

case "$NGINX_MODE" in
    managed|integrate) ;;
    *) die "Unknown nginx mode: $NGINX_MODE. Use: managed or integrate" ;;
esac

# ── Resolve run user/group ───────────────────────────────────────────
RUN_GROUP=""
if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="root"
else
    # Verify user exists
    if ! id "$RUN_USER" &>/dev/null; then
        die "User '$RUN_USER' does not exist. Create it first or choose a different user."
    fi
    RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null)
fi
preflight_run_user_nginx
preflight_nginx_tree

resolve_download_url "$DAEMON_VERSION"
detect_existing_install
keep_installed_newer_daemon nginx-daemon

# ── Confirmation ─────────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing nginx-daemon installation detected"
    echo -e "  ${GRAY}Current version: ${BRAND_MINT}${EXISTING_VERSION}${NC}"
    echo -e "  ${GRAY}Version to install: ${BRAND_MINT}${RESOLVED_DAEMON_VERSION}${NC}"
    echo ""
fi

summary_start
summary_row "Opfield:     ${OPFIELD_ADDR}"
if [[ -n "$ENROLL_TOKEN" ]]; then
    summary_row "Token:       ${ENROLL_TOKEN:0:12}..."
else
    summary_row "Token:       existing enrollment"
fi
if [[ -n "$OPFIELD_CERT_SHA256" ]]; then
    summary_row "Cert SHA256: ${OPFIELD_CERT_SHA256}"
else
    summary_row "Cert SHA256: existing enrollment"
fi
summary_row "Arch:        ${ARCH}"
summary_row "OS:          ${OS_ID}"
summary_row "Install ver: ${RESOLVED_DAEMON_VERSION}"
summary_row "Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
summary_row "Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
summary_row "Run as:      ${RUN_USER}:${RUN_GROUP}"
summary_row "Skip nginx:  $([ "$SKIP_NGINX" -eq 1 ] && echo "yes" || echo "no")"
summary_row "Nginx min:   ${NGINX_MIN_VERSION}"
summary_row "Nginx mode:  ${NGINX_MODE}"
[[ "$NGINX_SERVICE_REPAIR_PLANNED" -eq 0 ]] || summary_row "Nginx fix:   will update the nginx PID lines and start nginx"
summary_row "Updates:     ${ARTIFACT_BASE_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
fi
guide_blank

nginx_version() {
    nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p' | head -n 1
}

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

# What a real run does with the daemon binary: nginx-daemon at the path this run installs it to is kept when it already has
# the version to install, else downloaded.
preview_daemon_binary() {
    local target="${NGINX_DAEMON_OWN_BINARY}"
    if [[ "$RUN_USER" == "root" ]]; then
        target="${NGINX_DAEMON_BIN_LINK}"
        # A link or wrapper of a non-root install is replaced by a downloaded root binary.
        if [[ -L "$target" ]] || is_daemon_wrapper "$target"; then target=""; fi
    fi
    if [[ -n "$target" && -f "$target" && "$(daemon_binary_version "$target" || true)" == "$RESOLVED_DAEMON_VERSION" ]]; then
        ok "nginx-daemon already installed (${RESOLVED_DAEMON_VERSION})"
    else
        log "Downloading nginx-daemon..."
        ok "nginx-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    fi
    if [[ "$RUN_USER" != "root" ]]; then
        ok "${NGINX_DAEMON_BIN_LINK} runs ${NGINX_DAEMON_OWN_BINARY} as ${RUN_USER} (dry run)"
    fi
}

preview_run_user_switch() {
    [[ "$PREVIOUS_RUN_UID" != 0 && "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
    log "nginx-daemon runs as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); it is stopped and switched to ${RUN_USER} (dry run)"
}

preview_service_start() {
    local manager="manual mode (no supported service manager; not persistent across reboot)"
    if has_systemd; then
        manager="systemd unit nginx-daemon"
    elif has_openrc; then
        manager="OpenRC service nginx-daemon"
    fi
    log "Enabling and starting nginx-daemon as ${RUN_USER} (${manager})..."
    ok "nginx-daemon is connected to Opfield (dry run)"
}

preview_nginx_install() {
    local ver
    if ! command_exists nginx; then
        [[ "$SKIP_NGINX" -eq 0 ]] || die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+ to be installed."
        log "Adding nginx.org stable repository..."
        log "Installing nginx..."
        ok "nginx installed (dry run)"
        return
    fi
    ver=$(nginx_version)
    ver="${ver:-unknown}"
    if nginx_version_at_least "$ver" "$NGINX_MIN_VERSION"; then
        ok "nginx already installed (${ver})"
        return
    fi
    [[ "$SKIP_NGINX" -eq 0 ]] || die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+; found ${ver}."
    [[ "$NON_INTERACTIVE" -eq 0 ]] || die "nginx ${NGINX_MIN_VERSION}+ is required. Re-run interactively to approve the stable nginx upgrade."
    log "nginx ${ver} is below ${NGINX_MIN_VERSION}; the real run asks to upgrade it from the nginx.org stable repository."
}

dry_run_preview() {
    preview_run_user_switch
    preview_nginx_install
    [[ "$NGINX_SERVICE_REPAIR_PLANNED" -eq 0 ]] || log "Would update the nginx OpenRC service's PID lines and start nginx (dry run)"
    log "Creating required directories..."
    preview_nginx_tree
    ok "Directories created (dry run)"
    log "Configuring nginx (${NGINX_MODE} mode)..."
    ok "nginx configuration updated (${NGINX_MODE} mode; dry run)"
    preview_daemon_binary
    if [[ -n "$ENROLL_TOKEN" && ( -n "$(ls -A /etc/nginx-daemon/certs 2>/dev/null)" || -f /var/lib/nginx-daemon/state.json ) ]]; then
        log "Fresh enrollment token provided — the existing nginx-daemon enrollment state is backed up and replaced (dry run)"
    fi
    if [[ -z "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 1 ]]; then
        ok "Node already enrolled — skipping enrollment (dry run)"
    else
        log "Writing config and enrolling with Opfield..."
        ok "Config written to /etc/nginx-daemon/config.yaml (dry run)"
    fi
    preview_host_access_config /etc/nginx-daemon/config.yaml
    if [[ "$RUN_USER" != "root" ]]; then
        ok "nginx-daemon gets CAP_NET_BIND_SERVICE for nginx -t (dry run)"
    fi
    preview_service_start
    complete_success "Dry run completed successfully — no host changes were made."
}


# ── Step 1: Install nginx ────────────────────────────────────────────
# An apt-get that failed ends the install with apt's own reason (the lock holder of a busy package manager) and the log.
apt_failed() {
    local attempt_log="$1" status="$2" reason
    shift 2
    reason=$(grep '^E: ' "$attempt_log" | head -n 2 | tr '\n' ' ')
    rm -f "$attempt_log"
    [[ -n "$reason" ]] || reason="exit status ${status}. "
    die "apt-get $1 failed: ${reason}See ${LOG_FILE} for apt's full output."
}

run_apt_with_lock_retry() {
    local attempt=1
    local status=0
    local attempt_log

    while (( attempt <= APT_LOCK_RETRY_ATTEMPTS )); do
        attempt_log=$(mktemp /tmp/opfield-node-apt.XXXXXX) || die "Could not create apt log file"
        if apt-get "$@" > "$attempt_log" 2>&1; then
            cat "$attempt_log" >> "$LOG_FILE"
            rm -f "$attempt_log"
            return 0
        else
            status=$?
        fi

        cat "$attempt_log" >> "$LOG_FILE"
        if ! grep -Eqi 'Could not get lock|Unable to acquire the dpkg frontend lock|is another process using it' "$attempt_log" ||
            (( attempt == APT_LOCK_RETRY_ATTEMPTS )); then
            apt_failed "$attempt_log" "$status" "$@"
        fi
        rm -f "$attempt_log"

        warn "Package manager is busy; retrying in ${APT_LOCK_RETRY_DELAY_SECONDS}s (${attempt}/${APT_LOCK_RETRY_ATTEMPTS})..."
        sleep "$APT_LOCK_RETRY_DELAY_SECONDS"
        ((attempt += 1))
    done

    return "$status"
}

install_nginx_stable_repo() {
    log "Adding nginx.org stable repository..."
    case "$OS_LIKE" in
        *debian*|*ubuntu*)
            # Refresh the package lists first: on a host whose lists are stale the install below asks for package
            # versions the mirror no longer has (404).
            run_apt_with_lock_retry update -qq
            run_apt_with_lock_retry install -y -qq gnupg2 ca-certificates lsb-release
            # --yes lets a re-run after a failed install replace the keyring; apt
            # verifies with an unprivileged user, so it must stay world-readable
            # whatever the umask of the shell running the installer.
            curl -fsSL https://nginx.org/keys/nginx_signing.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg 2>> "$LOG_FILE"
            chmod 0644 /usr/share/keyrings/nginx-archive-keyring.gpg
            echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/$(. /etc/os-release && echo "$ID") $(lsb_release -cs) nginx" \
                > /etc/apt/sources.list.d/nginx.list
            chmod 0644 /etc/apt/sources.list.d/nginx.list
            run_apt_with_lock_retry update -qq
            ;;
        *rhel*|*fedora*|*centos*)
            cat > /etc/yum.repos.d/nginx.repo <<'REPO'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/$releasever/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
REPO
            ;;
        *)
            warn "Cannot add nginx.org repo for ${OS_ID}. Falling back to system package."
            ;;
    esac
}

nginx_version_at_least() {
    local actual="$1"
    local required="$2"
    local actual_major actual_minor actual_patch required_major required_minor required_patch

    [[ "$actual" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || return 1
    IFS='.' read -r actual_major actual_minor actual_patch <<< "$actual"
    IFS='.' read -r required_major required_minor required_patch <<< "$required"
    actual_patch="${actual_patch:-0}"
    required_patch="${required_patch:-0}"

    (( 10#$actual_major > 10#$required_major )) ||
        (( 10#$actual_major == 10#$required_major && 10#$actual_minor > 10#$required_minor )) ||
        (( 10#$actual_major == 10#$required_major && 10#$actual_minor == 10#$required_minor && 10#$actual_patch >= 10#$required_patch ))
}

install_nginx_package() {
    local upgrade_existing="${1:-0}"
    log "$([[ "$upgrade_existing" -eq 1 ]] && echo "Upgrading nginx..." || echo "Installing nginx...")"
    case "$OS_LIKE" in
        *debian*|*ubuntu*)
            run_apt_with_lock_retry update -qq
            run_apt_with_lock_retry install -y -qq nginx
            ;;
        *rhel*|*fedora*|*centos*)
            if command_exists dnf; then
                if [[ "$upgrade_existing" -eq 1 ]]; then
                    dnf upgrade -y -q nginx >> "$LOG_FILE" 2>&1
                else
                    dnf install -y -q nginx >> "$LOG_FILE" 2>&1
                fi
            else
                if [[ "$upgrade_existing" -eq 1 ]]; then
                    yum update -y -q nginx >> "$LOG_FILE" 2>&1
                else
                    yum install -y -q nginx >> "$LOG_FILE" 2>&1
                fi
            fi
            ;;
        *arch*)
            pacman -Sy --noconfirm nginx >> "$LOG_FILE" 2>&1
            ;;
        *alpine*)
            apk add --no-cache --upgrade nginx >> "$LOG_FILE" 2>&1
            ;;
        *)
            die "Cannot auto-install nginx on ${OS_ID}. Install nginx ${NGINX_MIN_VERSION} or newer and rerun."
            ;;
    esac
}

start_nginx_service() {
    if has_systemd; then
        systemctl enable nginx >> "$LOG_FILE" 2>&1 || true
        systemctl start nginx >> "$LOG_FILE" 2>&1 || true
    elif has_openrc; then
        rc-update add nginx default >> "$LOG_FILE" 2>&1 || true
        rc-service nginx start >> "$LOG_FILE" 2>&1 || true
    elif command_exists service; then
        service nginx start >> "$LOG_FILE" 2>&1 || true
    fi
}

install_nginx() {
    if command_exists nginx; then
        local ver
        ver=$(nginx_version)
        ver="${ver:-unknown}"
        if nginx_version_at_least "$ver" "$NGINX_MIN_VERSION"; then
            ok "nginx already installed (${ver})"
            return 0
        fi

        [[ "$SKIP_NGINX" -eq 0 ]] ||
            die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+; found ${ver}."

        warn "nginx ${ver} is below the required ${NGINX_MIN_VERSION} for Opfield HTTP/2 support."
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            die "nginx ${NGINX_MIN_VERSION}+ is required. Re-run interactively to approve the stable nginx upgrade."
        elif ! prompt_yes_no "Upgrade nginx to the official stable repository now?" "Y"; then
            die "Opfield node setup aborted. nginx ${NGINX_MIN_VERSION}+ is required."
        fi

        install_nginx_stable_repo
        install_nginx_package 1
        start_nginx_service
    else
        [[ "$SKIP_NGINX" -eq 0 ]] || die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+ to be installed."
        install_nginx_stable_repo
        install_nginx_package
        start_nginx_service
    fi

    local installed_ver
    installed_ver=$(nginx_version)
    installed_ver="${installed_ver:-unknown}"
    if ! nginx_version_at_least "$installed_ver" "$NGINX_MIN_VERSION"; then
        warn "nginx ${installed_ver} is below the required ${NGINX_MIN_VERSION} for Opfield HTTP/2 support."
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            die "nginx ${NGINX_MIN_VERSION}+ is required; found ${installed_ver}."
        elif ! prompt_yes_no "Upgrade nginx to the official stable repository now?" "Y"; then
            die "Opfield node setup aborted. nginx ${NGINX_MIN_VERSION}+ is required."
        fi
        install_nginx_stable_repo
        install_nginx_package 1
        start_nginx_service
        installed_ver=$(nginx_version)
        installed_ver="${installed_ver:-unknown}"
        nginx_version_at_least "$installed_ver" "$NGINX_MIN_VERSION" ||
            die "nginx ${NGINX_MIN_VERSION}+ is required; found ${installed_ver}."
    fi
    ok "nginx ready (${installed_ver})"
}

# ── Step 2: Configure nginx ───────────────────────────────────────────
# Adds an include line to the http block of nginx.conf. An include line an earlier release wrote for the same file under
# its old path (legacy_line) is replaced in place, so the file is included once; the copy taken first lets a failed
# nginx -t put nginx.conf back.
ensure_http_include() {
    local include_line="$1"
    local legacy_line="${2:-}"
    local global_conf="/etc/nginx/nginx.conf"
    local tmp_file has_include=0 has_legacy=0

    nginx_conf_has_line "$global_conf" "$include_line" && has_include=1
    [[ -n "$legacy_line" ]] && nginx_conf_has_line "$global_conf" "$legacy_line" && has_legacy=1
    if [[ "$has_include" -eq 1 && "$has_legacy" -eq 0 ]]; then
        return 0
    fi

    backup_nginx_config "$global_conf"
    tmp_file=$(mktemp /tmp/nginx-conf-XXXXXX)
    if ! awk -v include_line="$include_line" -v legacy_line="$legacy_line" -v has_include="$has_include" \
        -v has_legacy="$has_legacy" '
        { trimmed = $0; sub(/^[[:space:]]+/, "", trimmed); sub(/[[:space:]]+$/, "", trimmed) }
        legacy_line != "" && trimmed == legacy_line {
            if (!has_include && !inserted) {
                match($0, /^[[:space:]]*/)
                print substr($0, 1, RLENGTH) include_line
                inserted = 1
            }
            next
        }
        !has_include && !has_legacy && !inserted && $0 ~ /^[[:space:]]*http[[:space:]]*\{/ {
            print
            print "    " include_line
            inserted = 1
            next
        }
        { print }
        END {
            if (!has_include && !inserted) {
                exit 1
            }
        }
    ' "$global_conf" > "$tmp_file"; then
        rm -f "$tmp_file"
        return 1
    fi

    # Written in place so nginx.conf keeps its owner and mode.
    cat "$tmp_file" > "$global_conf" || { rm -f "$tmp_file"; return 1; }
    rm -f "$tmp_file"
    return 0
}

remove_legacy_conf_d_sites_include() {
    # legacy-name: the conf.d file of early installers (already legacy cleanup) — remove once every node
    # reports none
    local legacy_file="/etc/nginx/conf.d/${LEGACY_NGINX_MANAGED_CONF}"
    local effective_content

    [[ -f "$legacy_file" ]] || return 0
    effective_content=$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$legacy_file")
    [[ "$effective_content" == "include ${NGINX_SITES_DIR}/*.conf;" || \
        "$effective_content" == "include ${NGINX_LEGACY_SITES_DIR}/*.conf;" ]] || return 0

    backup_nginx_config "$legacy_file"
    rm -f "$legacy_file"
    log "Removed legacy duplicate Opfield sites include"
}

# A host switched from managed to integrate mode still has the managed direct
# include of the Opfield sites directory in nginx.conf (under its current or its
# pre-2.12.1 path); the integrate include replaces it, so the directory is
# included once.
remove_direct_sites_include() {
    local global_conf="/etc/nginx/nginx.conf"
    local line="include ${NGINX_SITES_DIR}/*.conf;"
    # legacy-name: direct include of the legacy conf.d written before 2.12.1 — remove once every node reports none
    local legacy_line="include ${NGINX_LEGACY_SITES_DIR}/*.conf;"
    local tmp_file

    nginx_conf_has_line "$global_conf" "$line" || nginx_conf_has_line "$global_conf" "$legacy_line" || return 0
    backup_nginx_config "$global_conf"
    tmp_file=$(mktemp /tmp/nginx-conf-XXXXXX)
    if ! awk -v line="$line" -v legacy_line="$legacy_line" '
        { trimmed = $0; sub(/^[[:space:]]+/, "", trimmed); sub(/[[:space:]]+$/, "", trimmed) }
        trimmed == line || trimmed == legacy_line { next }
        { print }
    ' "$global_conf" > "$tmp_file"; then
        rm -f "$tmp_file"
        die "Failed to remove the direct Opfield sites include from $global_conf"
    fi
    cat "$tmp_file" > "$global_conf" || { rm -f "$tmp_file"; die "Could not write $global_conf"; }
    rm -f "$tmp_file"
    log "Replaced the direct Opfield sites include with the integrate include"
}

ensure_nginx_worker_limits() {
    local global_conf="$NGINX_GLOBAL_CONF"
    local tmp_file
    local nofile_present=0
    local connections_present=0

    grep -Eq '^[[:space:]]*worker_rlimit_nofile[[:space:]]+[0-9]+[[:space:]]*;' "$global_conf" && nofile_present=1
    grep -Eq '^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;' "$global_conf" && connections_present=1

    tmp_file=$(mktemp /tmp/nginx-limits-XXXXXX)
    if ! awk \
        -v nofile_min="$NGINX_WORKER_NOFILE_MIN" \
        -v connections_min="$NGINX_WORKER_CONNECTIONS_MIN" \
        -v nofile_present="$nofile_present" \
        -v connections_present="$connections_present" '
        function leading_space(line) {
            match(line, /^[[:space:]]*/)
            return substr(line, 1, RLENGTH)
        }
        function numeric_value(line) {
            match(line, /[0-9]+/)
            return substr(line, RSTART, RLENGTH) + 0
        }
        BEGIN {
            nofile_seen = nofile_present
            events_seen = 0
            in_events = 0
            connections_seen = connections_present
            http_seen = 0
        }
        /^[[:space:]]*worker_rlimit_nofile[[:space:]]+[0-9]+[[:space:]]*;/ {
            nofile_seen = 1
            if (numeric_value($0) < nofile_min) {
                print leading_space($0) "worker_rlimit_nofile " nofile_min ";"
            } else {
                print
            }
            next
        }
        /^[[:space:]]*events[[:space:]]*\{/ {
            if (!nofile_seen) {
                print "worker_rlimit_nofile " nofile_min ";"
                print ""
                nofile_seen = 1
            }
            events_seen = 1
            in_events = 1
            print
            next
        }
        in_events && /^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;/ {
            connections_seen = 1
            if (numeric_value($0) < connections_min) {
                print leading_space($0) "worker_connections " connections_min ";"
            } else {
                print
            }
            next
        }
        in_events && /^[[:space:]]*}/ {
            if (!connections_seen) {
                print "    worker_connections " connections_min ";"
                connections_seen = 1
            }
            in_events = 0
            print
            next
        }
        /^[[:space:]]*server_tokens[[:space:]]+[^;]+[[:space:]]*;/ {
            line = $0
            sub(/server_tokens[[:space:]]+[^;]+[[:space:]]*;/, "", line)
            if (line !~ /^[[:space:]]*$/) print line
            next
        }
        /^[[:space:]]*http[[:space:]]*\{/ {
            print
            print "    server_tokens off;"
            http_seen = 1
            next
        }
        { print }
        END {
            if (!nofile_seen || !events_seen || !connections_seen || !http_seen) exit 1
        }
    ' "$global_conf" > "$tmp_file"; then
        rm -f "$tmp_file"
        die "Failed to ensure nginx worker file-descriptor limits in ${global_conf}"
    fi

    if ! cmp -s "$tmp_file" "$global_conf"; then
        backup_nginx_config "$global_conf"
        cat "$tmp_file" > "$global_conf"
        log "Applied nginx worker limits and disabled version tokens"
    fi
    rm -f "$tmp_file"
}

current_nginx_worker_nofile_limit() {
    local master_pid
    local child_pid
    local child_args

    master_pid=$(nginx_master_pid) || return 0
    [[ "$master_pid" =~ ^[0-9]+$ && -r "/proc/${master_pid}/task/${master_pid}/children" ]] || return 0

    for child_pid in $(cat "/proc/${master_pid}/task/${master_pid}/children"); do
        [[ "$child_pid" =~ ^[0-9]+$ && -r "/proc/${child_pid}/cmdline" && -r "/proc/${child_pid}/limits" ]] || continue
        child_args=$(tr '\0' ' ' < "/proc/${child_pid}/cmdline")
        [[ "$child_args" == *"nginx: worker process"* ]] || continue
        awk '$1 == "Max" && $2 == "open" && $3 == "files" { print $4; exit }' "/proc/${child_pid}/limits"
        return 0
    done
}

nginx_worker_requires_restart() {
    local running_nofile=""

    running_nofile=$(current_nginx_worker_nofile_limit)
    [[ "$running_nofile" =~ ^[0-9]+$ ]] && (( running_nofile < NGINX_WORKER_NOFILE_MIN ))
}

# A file the installer wrote under its pre-2.12.1 name gets the current name: renamed (the same contents, so the
# setting holds throughout), or removed when a file with the current name is there already. Fails without a change.
rename_legacy_installer_file() {
    local legacy="$1" current="$2"
    [[ -f "$legacy" && ! -L "$legacy" ]] || return 1
    if [[ -e "$current" || -L "$current" ]]; then
        rm -f -- "$legacy"
    else
        mv -f -- "$legacy" "$current"
    fi
}

# A non-root nginx keeps its pid file in its RuntimeDirectory= (/run/nginx), which systemd removes whenever nginx stops
# unless RuntimeDirectoryPreserve= keeps it. The daemon cannot create it again as nginx's user, so every nginx -t would
# fail until root starts nginx.
ensure_nginx_runtime_directory_preserved() {
    has_systemd || return 0
    local dropin_file="${NGINX_SYSTEMD_DROPIN_DIR}/zz-opfield-runtime-directory.conf"
    # legacy-name: the nginx runtime directory drop-in written before 2.12.1 — remove once every node
    # reports none
    if rename_legacy_installer_file "${NGINX_SYSTEMD_DROPIN_DIR}/${LEGACY_NGINX_RUNTIME_DROPIN}" "$dropin_file"; then
        systemctl daemon-reload >> "$LOG_FILE" 2>&1 || die "systemd daemon-reload failed."
    fi
    [[ "$RUN_USER" != "root" ]] || return 0
    local runtime_dirs preserve
    # ensure_nginx_service_limit ran daemon-reload just before, so the operator's drop-ins are loaded.
    runtime_dirs=$(systemctl show nginx.service -p RuntimeDirectory --value 2>/dev/null || true)
    [[ -n "$runtime_dirs" ]] || return 0
    preserve=$(systemctl show nginx.service -p RuntimeDirectoryPreserve --value 2>/dev/null || true)
    [[ "$preserve" != "yes" ]] || return 0
    mkdir -p "$NGINX_SYSTEMD_DROPIN_DIR"
    printf '[Service]\nRuntimeDirectoryPreserve=yes\n' > "$dropin_file" || die "Could not write ${dropin_file}."
    chmod 0644 "$dropin_file"
    systemctl daemon-reload >> "$LOG_FILE" 2>&1 || die "systemd daemon-reload failed."
    log "Kept nginx's runtime directory across nginx stops (RuntimeDirectoryPreserve=yes)"
}

# The daemon reloads nginx but never starts it as a non-root user, so nginx has to start with the host.
ensure_nginx_service_enabled() {
    if has_systemd; then
        systemctl is-enabled --quiet nginx 2>/dev/null && return 0
        systemctl enable nginx >> "$LOG_FILE" 2>&1 || warn "Could not enable nginx at boot; run: systemctl enable nginx"
    elif has_openrc; then
        rc-update show default 2>/dev/null | grep -Eq '^[[:space:]]*nginx[[:space:]]*[|]' && return 0
        rc-update add nginx default >> "$LOG_FILE" 2>&1 || warn "Could not enable nginx at boot; run: rc-update add nginx default"
    fi
}

ensure_nginx_service_limit() {
    if nginx_worker_requires_restart; then
        NGINX_SERVICE_RESTART_REQUIRED=1
    fi

    if has_systemd; then
        local dropin_dir="$NGINX_SYSTEMD_DROPIN_DIR"
        local dropin_file="${dropin_dir}/opfield-limits.conf"
        local desired
        local effective

        # legacy-name: the nginx limits drop-in written before 2.12.1 — remove once every node reports none
        rename_legacy_installer_file "${dropin_dir}/${LEGACY_NGINX_LIMITS_DROPIN}" "$dropin_file" || true
        systemctl daemon-reload >> "$LOG_FILE" 2>&1
        effective=$(systemctl show nginx.service -p LimitNOFILE --value 2>/dev/null || true)
        if [[ "$effective" != "infinity" ]] && \
            { [[ ! "$effective" =~ ^[0-9]+$ ]] || (( effective < NGINX_SERVICE_NOFILE_MIN )); }; then
            desired=$(mktemp /tmp/nginx-systemd-limits-XXXXXX)
            cat > "$desired" <<EOF
[Service]
LimitNOFILE=${NGINX_SERVICE_NOFILE_MIN}
EOF
            mkdir -p "$dropin_dir"
            if [[ ! -f "$dropin_file" ]] || ! cmp -s "$desired" "$dropin_file"; then
                cat "$desired" > "$dropin_file"
                chmod 0644 "$dropin_file"
                log "Configured systemd nginx file-descriptor limit"
            fi
            rm -f "$desired"
            NGINX_SERVICE_RESTART_REQUIRED=1
            systemctl daemon-reload >> "$LOG_FILE" 2>&1
        fi

        effective=$(systemctl show nginx.service -p LimitNOFILE --value 2>/dev/null || true)
        if [[ "$effective" =~ ^[0-9]+$ ]] && (( effective < NGINX_SERVICE_NOFILE_MIN )); then
            NGINX_SERVICE_RESTART_REQUIRED=1
        fi
        return 0
    fi

    if has_openrc; then
        local conf_dir="$NGINX_OPENRC_CONF_DIR"
        local conf_file="${conf_dir}/nginx"
        local marker="# Managed by Opfield: nginx file-descriptor limit"
        # legacy-name: /etc/conf.d/nginx marker written before 2.12.1 — remove once every node reports none
        local legacy_marker="$LEGACY_NGINX_LIMITS_MARKER"
        local current=""

        mkdir -p "$conf_dir"
        touch "$conf_file"
        # The block an earlier release added carries the current marker from now on; its limit line stays as it is.
        if grep -Fqx "$legacy_marker" "$conf_file"; then
            if grep -Fqx "$marker" "$conf_file"; then
                # Both blocks: the earlier one goes, with its limit line.
                awk -v legacy="$legacy_marker" '
                    dropped && /^[[:space:]]*rc_ulimit=/ { dropped = 0; next }
                    { dropped = 0 }
                    $0 == legacy { dropped = 1; next }
                    { print }
                ' "$conf_file" > "${conf_file}.opfield-tmp" && cat "${conf_file}.opfield-tmp" > "$conf_file"
                rm -f "${conf_file}.opfield-tmp"
            else
                sed -i "s/^${legacy_marker}\$/${marker}/" "$conf_file"
            fi
        fi
        current=$(grep -E '^[[:space:]]*rc_ulimit=.*-n[[:space:]]+[0-9]+' "$conf_file" | tail -n 1 | sed -E 's/.*-n[[:space:]]+([0-9]+).*/\1/' || true)
        if [[ ! "$current" =~ ^[0-9]+$ ]] || (( current < NGINX_SERVICE_NOFILE_MIN )); then
            if grep -Fq "$marker" "$conf_file"; then
                sed -i "/^${marker}$/,+1c\\${marker}\nrc_ulimit=\"\${rc_ulimit:-} -n ${NGINX_SERVICE_NOFILE_MIN}\"" "$conf_file"
            else
                printf '\n%s\nrc_ulimit="${rc_ulimit:-} -n %s"\n' "$marker" "$NGINX_SERVICE_NOFILE_MIN" >> "$conf_file"
            fi
            NGINX_SERVICE_RESTART_REQUIRED=1
            log "Configured OpenRC nginx file-descriptor limit"
        fi
        return 0
    fi

    warn "No supported service manager found; verify nginx has a nofile limit of at least ${NGINX_SERVICE_NOFILE_MIN}"
}

verify_nginx_fd_limits() {
    local rendered
    local worker_nofile
    local worker_connections
    local service_nofile=""
    local process_nofile=""

    rendered=$(nginx -T 2>&1) || die "Failed to inspect the effective nginx configuration"
    worker_nofile=$(printf '%s\n' "$rendered" | awk '/^[[:space:]]*worker_rlimit_nofile[[:space:]]+[0-9]+[[:space:]]*;/ { value=$2; gsub(/;/, "", value); print value; exit }')
    worker_connections=$(printf '%s\n' "$rendered" | awk '/^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;/ { value=$2; gsub(/;/, "", value); print value; exit }')

    [[ "$worker_nofile" =~ ^[0-9]+$ ]] && (( worker_nofile >= NGINX_WORKER_NOFILE_MIN )) || \
        die "Effective nginx worker_rlimit_nofile is below ${NGINX_WORKER_NOFILE_MIN}"
    [[ "$worker_connections" =~ ^[0-9]+$ ]] && (( worker_connections >= NGINX_WORKER_CONNECTIONS_MIN )) || \
        die "Effective nginx worker_connections is below ${NGINX_WORKER_CONNECTIONS_MIN}"

    if has_systemd; then
        service_nofile=$(systemctl show nginx.service -p LimitNOFILE --value 2>/dev/null || true)
        if [[ "$service_nofile" != "infinity" ]]; then
            [[ "$service_nofile" =~ ^[0-9]+$ ]] && (( service_nofile >= NGINX_SERVICE_NOFILE_MIN )) || \
                die "Effective nginx systemd LimitNOFILE is below ${NGINX_SERVICE_NOFILE_MIN}"
        fi
    fi

    process_nofile=$(current_nginx_worker_nofile_limit)
    if [[ -n "$process_nofile" && "$process_nofile" != "unlimited" ]]; then
        [[ "$process_nofile" =~ ^[0-9]+$ ]] && (( process_nofile >= NGINX_WORKER_NOFILE_MIN )) || \
            die "Running nginx worker process still has a nofile limit below ${NGINX_WORKER_NOFILE_MIN}"
    fi

    ok "nginx file-descriptor limits verified"
}

verify_nginx_server_tokens() {
    local rendered
    local server_tokens
    local unsafe_server_tokens

    rendered=$(nginx -T 2>&1) || die "Failed to inspect the effective nginx configuration"
    server_tokens=$(printf '%s\n' "$rendered" | awk '/^[[:space:]]*server_tokens[[:space:]]+[^;]+[[:space:]]*;/ { value=$2; gsub(/;/, "", value); print value; exit }')
    unsafe_server_tokens=$(printf '%s\n' "$rendered" | awk '/^[[:space:]]*server_tokens[[:space:]]+[^;]+[[:space:]]*;/ { value=$2; gsub(/;/, "", value); if (value != "off") print value }')

    [[ "$server_tokens" == "off" && -z "$unsafe_server_tokens" ]] || \
        die "Effective nginx server_tokens must be off"
}

configure_nginx_managed() {
    log "Configuring nginx in managed mode..."
    # nginx.conf below includes the Opfield sites directory itself.
    remove_legacy_conf_d_sites_include
    backup_nginx_config "/etc/nginx/nginx.conf"
    backup_nginx_config "/etc/nginx/conf.d/default.conf"
    backup_nginx_config "/etc/nginx/http.d/default.conf"

    cat > /etc/nginx/nginx.conf << 'EOF'
worker_processes auto;
worker_rlimit_nofile 65535;
pid __NGINX_PID_FILE__;

events {
    worker_connections 8192;
}

http {
    server_tokens off;
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    # Opfield Pages generated hostnames are longer than the default bucket fits.
    server_names_hash_bucket_size 128;
    client_max_body_size 50m;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include /etc/nginx/conf.d/*.conf;
    include __OPFIELD_SITES_DIR__/*.conf;
}
EOF
    sed -i "s|__OPFIELD_SITES_DIR__|${NGINX_SITES_DIR}|g; s|__NGINX_PID_FILE__|$(nginx_service_pid_file)|g" /etc/nginx/nginx.conf

    cat > /etc/nginx/conf.d/default.conf << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
    }

    location /health {
        access_log off;
        return 200 "OK\n";
        add_header Content-Type text/plain;
    }

    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
        access_log off;
    }

    location / {
        return 404;
    }

    # Opfield error pages: the page variables live in the file the nginx-daemon keeps (00-opfield-error-pages.conf).
    # 400 and 414 go to an internal path: a request whose request line nginx could not read has no URI for a named
    # location.
    error_page 401 403 404 405 408 413 429 500 502 503 504 @opfield_error;
    error_page 400 414 /.well-known/opfield-error;
    error_page 494 @opfield_error_494;
    error_page 495 @opfield_error_495;
    error_page 496 @opfield_error_496;
    error_page 497 @opfield_error_497;
    location @opfield_error {
        default_type text/html;
        return 200 $opfield_error_page;
    }
    location = /.well-known/opfield-error {
        internal;
        default_type text/html;
        return 200 $opfield_error_page;
    }
    location @opfield_error_494 {
        default_type text/html;
        return 200 $opfield_error_page_494;
    }
    location @opfield_error_495 {
        default_type text/html;
        return 200 $opfield_error_page_495;
    }
    location @opfield_error_496 {
        default_type text/html;
        return 200 $opfield_error_page_496;
    }
    location @opfield_error_497 {
        default_type text/html;
        return 200 $opfield_error_page_497;
    }
}
EOF

    # HTTPS catch-all: without an explicit 443 default_server, a TLS request
    # whose SNI or Host matches no route falls through to the first 443
    # server block nginx loaded, serving another route's content. The
    # nginx-daemon keeps this file in sync on every start (see
    # nginx.EnsureDefaultServer); it is written here too so the protection is
    # already in place before the daemon's first start, under the name the
    # installed daemon uses (align_default_server_file).
    align_default_server_file
    cat > "${NGINX_SITES_DIR}/$(default_server_file_name)" << 'EOF'
# Opfield managed default server (auto-injected)
# Rejects any TLS request whose SNI or Host does not match a configured
# route, so a deleted route's hostname (or any other hostname pointed at
# this node) cannot fall through to another route's server block.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
EOF

    ensure_error_pages_placeholder

    STUB_STATUS_URL="http://127.0.0.1/nginx_status"
}

# The default server above answers with the Opfield error pages, whose variables the nginx-daemon writes on every start
# (errorpages.Config). Until its first start a placeholder defines them, so nginx -t passes; the daemon replaces it.
ensure_error_pages_placeholder() {
    local file="${NGINX_SITES_DIR}/00-opfield-error-pages.conf"
    [[ -e "$file" || -e "${NGINX_SITES_DIR}/${LEGACY_ERROR_PAGES_CONF}" ]] && return 0
    {
        echo "# Opfield error pages placeholder: the nginx-daemon replaces this file on its first start."
        local variable
        for variable in '' _494 _495 _496 _497; do
            printf 'map $status $opfield_error_page%s {\n    default "";\n}\n' "$variable"
            printf 'map $status $opfield_error_page%s_unbranded {\n    default "";\n}\n' "$variable"
        done
    } > "$file"
}

configure_nginx_integrated() {
    local include_file="${NGINX_OPFIELD_DIR}/sites.include.conf"
    local stub_conf="${NGINX_OPFIELD_DIR}/stub_status.conf"

    log "Configuring nginx in integrate mode..."

    remove_legacy_conf_d_sites_include
    remove_direct_sites_include
    align_default_server_file
    backup_nginx_config "$include_file"
    backup_nginx_config "$stub_conf"

    cat > "$include_file" << 'EOF'
include __OPFIELD_SITES_DIR__/*.conf;
EOF
    sed -i "s|__OPFIELD_SITES_DIR__|${NGINX_SITES_DIR}|g" "$include_file"

    cat > "$stub_conf" << EOF
server {
    listen 127.0.0.1:${INTEGRATED_STUB_STATUS_PORT};
    server_name localhost;

    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
        access_log off;
    }
}
EOF

    # legacy-name: integrate include lines of the legacy nginx tree written before 2.12.1 (replaced in place) —
    # remove once every node reports none
    ensure_http_include "include ${NGINX_OPFIELD_DIR}/sites.include.conf;" "include ${NGINX_LEGACY_DIR}/sites.include.conf;" || \
        die "Failed to inject Opfield sites include into /etc/nginx/nginx.conf"
    ensure_http_include "include ${NGINX_OPFIELD_DIR}/stub_status.conf;" "include ${NGINX_LEGACY_DIR}/stub_status.conf;" || \
        die "Failed to inject Opfield stub_status include into /etc/nginx/nginx.conf"

    STUB_STATUS_URL="http://127.0.0.1:${INTEGRATED_STUB_STATUS_PORT}/nginx_status"
}

# nginx's temp directories (client bodies, proxied responses, ...), as built in: nginx -V names them, relative ones
# under its prefix.
nginx_temp_paths() {
    local build prefix path
    build=$(nginx -V 2>&1) || return 0
    prefix=$(grep -o -- '--prefix=[^ ]*' <<< "$build" | head -n 1 | cut -d= -f2)
    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        [[ "$path" == /* ]] || path="${prefix%/}/${path}"
        echo "$path"
    done < <(grep -o -- '--http-[a-z-]*-temp-path=[^ ]*' <<< "$build" | cut -d= -f2)
}

# An nginx run by the daemon's non-root user writes its temp files as that user.
hand_nginx_temp_paths_to_run_user() {
    [[ "$RUN_USER" != "root" ]] && command_exists nginx || return 0
    local path
    while IFS= read -r path; do
        [[ -d "$path" && ! -L "$path" ]] || continue
        chown -hR "${RUN_USER}:${RUN_GROUP}" "$path" 2>> "$LOG_FILE" || warn "Could not give ${path} to ${RUN_USER}; nginx may not buffer large responses."
    done < <(nginx_temp_paths)
}

configure_nginx() {
    if [[ "$NGINX_MODE" == "managed" ]]; then
        configure_nginx_managed
    else
        configure_nginx_integrated
    fi

    ensure_nginx_worker_limits
    ensure_nginx_openrc_pid_directory
    start_nginx_after_service_repair
    ensure_nginx_service_limit
    ensure_nginx_runtime_directory_preserved
    ensure_nginx_pid_directory

    if nginx -t >> "$LOG_FILE" 2>&1; then
        verify_nginx_server_tokens
        if has_systemd; then
            if ! systemctl is-active --quiet nginx; then
                systemctl start nginx >> "$LOG_FILE" 2>&1 || die "Failed to start nginx"
            elif [[ "$NGINX_SERVICE_RESTART_REQUIRED" -eq 1 ]] || nginx_worker_requires_restart; then
                systemctl restart nginx >> "$LOG_FILE" 2>&1 || die "Failed to restart nginx with the updated service limit"
            else
                systemctl reload nginx >> "$LOG_FILE" 2>&1 || nginx -s reload >> "$LOG_FILE" 2>&1 || \
                    die "Failed to reload nginx"
            fi
        elif has_openrc; then
            if ! rc-service nginx status >> "$LOG_FILE" 2>&1; then
                rc-service nginx start >> "$LOG_FILE" 2>&1 || die "Failed to start nginx"
            elif [[ "$NGINX_SERVICE_RESTART_REQUIRED" -eq 1 ]] || nginx_worker_requires_restart; then
                rc-service nginx restart >> "$LOG_FILE" 2>&1 || die "Failed to restart nginx with the updated service limit"
            else
                rc-service nginx reload >> "$LOG_FILE" 2>&1 || nginx -s reload >> "$LOG_FILE" 2>&1 || \
                    die "Failed to reload nginx"
            fi
        else
            nginx -s reload >> "$LOG_FILE" 2>&1 || die "Failed to reload nginx"
        fi
        verify_nginx_fd_limits
        ensure_nginx_service_enabled
        ok "nginx configuration updated (${NGINX_MODE} mode)"
    else
        restore_nginx_config
        die "nginx config test failed after configuration changes; the previous configuration is restored — check $LOG_FILE"
    fi
    # A root nginx -t (and -T) gives nginx's temp directories to the user nginx.conf names; an nginx running as the run
    # user then cannot buffer a response (13: Permission denied).
    hand_nginx_temp_paths_to_run_user
}

# ── Step 3: Create directories ───────────────────────────────────────
# Renames a path whose new name is not taken: mv -T where mv has it, else a plain mv once the new name is free.
rename_path() {
    mv -T -- "$1" "$2" 2>/dev/null || { [[ ! -e "$2" && ! -L "$2" ]] && mv -- "$1" "$2"; }
}

# The nginx tree moves from the legacy path to /etc/nginx/opfield once, and the legacy path stays as a link to it:
# configurations written for the old path (by Opfield and by the operator) keep working. The move is two renames with
# the link made first under a temporary name, so one of the two paths names the tree at every moment. A run that
# stopped between them leaves /etc/nginx/opfield and that temporary link, which the next run renames into place; any
# other link left under a temporary name is removed. A fresh host gets /etc/nginx/opfield only. A tree another
# component already named the other way round
# (/etc/nginx/opfield a link to the legacy path) is left as it is: both paths work.
migrate_nginx_tree() {
    local parent current legacy name stale link target
    current="$NGINX_OPFIELD_DIR"
    legacy="$NGINX_LEGACY_DIR"
    parent=$(dirname "$current")
    name=$(basename "$current")
    # The link that takes the place of the legacy tree, under a temporary name until the tree has moved.
    link="${parent}/${LEGACY_NGINX_LINK_PREFIX}$$"
    local interrupted=""
    for stale in "${parent}/${LEGACY_NGINX_LINK_PREFIX}"*; do
        [[ -L "$stale" ]] || continue
        # Left by a run that stopped between its two renames (the tree moved, the old name not linked yet): the link
        # finishes that move below. Any other is removed.
        if [[ -z "$interrupted" && "$(readlink -- "$stale")" == "$name" && -d "$current" && ! -L "$current" &&
            ! -e "$legacy" && ! -L "$legacy" ]]; then
            interrupted="$stale"
            continue
        fi
        rm -f -- "$stale"
    done
    [[ ! -L "$current" ]] || return 0
    if [[ -d "$legacy" && ! -L "$legacy" ]]; then
        # An empty /etc/nginx/opfield is in the way only; preflight_nginx_tree refused a populated one.
        [[ ! -d "$current" ]] || rmdir -- "$current" || die "Could not move ${legacy} to ${current}: ${current} is not empty."
        ln -sfn "$name" "$link" || die "Could not prepare the link ${legacy} -> ${name}."
        if ! rename_path "$legacy" "$current"; then
            rm -f -- "$link"
            die "Could not move ${legacy} to ${current}."
        fi
        rename_path "$link" "$legacy" || die "Moved ${legacy} to ${current}, but could not link ${legacy} to it; run the installer again."
        log "Moved ${legacy} to ${current}; ${legacy} links to it"
        return 0
    fi
    if [[ -L "$legacy" ]]; then
        target=$(readlink -- "$legacy")
        if [[ "$target" != "$name" && "$target" != "$current" && ! -e "$current" ]]; then
            # An operator's link to a tree elsewhere: the new path names the same tree.
            ln -sfn "$(basename "$legacy")" "$link" || die "Could not prepare the link ${current} -> ${legacy}."
            rename_path "$link" "$current" || { rm -f -- "$link"; die "Could not link ${current} to ${legacy}."; }
            return 0
        fi
    fi
    mkdir -p "$current"
    # Only a tree this installer moved gets the old name as a link; a fresh host has no legacy tree.
    if [[ -n "$interrupted" ]]; then
        rename_path "$interrupted" "$legacy" || die "Moved ${legacy} to ${current}, but could not link ${legacy} to it; run the installer again."
        log "Finished moving ${legacy} to ${current}; ${legacy} links to it"
    fi
}

preview_nginx_tree() {
    if [[ -d "$NGINX_LEGACY_DIR" && ! -L "$NGINX_LEGACY_DIR" && ! -L "$NGINX_OPFIELD_DIR" ]]; then
        log "Would move ${NGINX_LEGACY_DIR} to ${NGINX_OPFIELD_DIR} and link ${NGINX_LEGACY_DIR} to it (dry run)"
    fi
}

# The managed HTTPS catch-all belongs to the daemon too: it writes it on every start, under the file name of its
# release. A second copy under the other name would be a second default server, which nginx refuses, so the installer
# uses the name the installed daemon binary carries (a daemon of an earlier release, a pinned --version, has only the
# legacy one) and keeps one file of the two.
DEFAULT_SERVER_FILE="00-opfield-default-server.conf"
# legacy-name: the legacy default server config written by nginx-daemon and installers before 2.12.1 — remove once no
# supported nginx-daemon release writes it
LEGACY_DEFAULT_SERVER_FILE="$LEGACY_NGINX_DEFAULT_SERVER_CONF"

# The nginx-daemon binary the installed command runs, if any.
installed_daemon_binary() {
    if is_daemon_wrapper "$NGINX_DAEMON_BIN_LINK"; then
        echo "$NGINX_DAEMON_OWN_BINARY"
    elif [[ -f "$NGINX_DAEMON_BIN_LINK" ]]; then
        echo "$NGINX_DAEMON_BIN_LINK"
    fi
}

default_server_file_name() {
    local binary
    binary=$(installed_daemon_binary)
    if [[ -n "$binary" && -f "$binary" ]] && ! grep -aqF "$DEFAULT_SERVER_FILE" "$binary" 2>/dev/null && \
        grep -aqF "$LEGACY_DEFAULT_SERVER_FILE" "$binary" 2>/dev/null; then
        echo "$LEGACY_DEFAULT_SERVER_FILE"
    else
        echo "$DEFAULT_SERVER_FILE"
    fi
}

# Keeps the catch-all under the installed daemon's name only: the copy under the other name is renamed to it, or
# removed when that name is taken (a copy is kept for a failed nginx -t).
align_default_server_file() {
    local wanted other
    wanted=$(default_server_file_name)
    other="$LEGACY_DEFAULT_SERVER_FILE"
    [[ "$wanted" != "$LEGACY_DEFAULT_SERVER_FILE" ]] || other="$DEFAULT_SERVER_FILE"
    [[ -f "${NGINX_SITES_DIR}/${other}" && ! -L "${NGINX_SITES_DIR}/${other}" ]] || return 0
    if [[ -e "${NGINX_SITES_DIR}/${wanted}" ]]; then
        backup_nginx_config "${NGINX_SITES_DIR}/${other}"
        rm -f -- "${NGINX_SITES_DIR}/${other}"
    else
        mv -f -- "${NGINX_SITES_DIR}/${other}" "${NGINX_SITES_DIR}/${wanted}"
    fi
}

create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/nginx/conf.d
    migrate_nginx_tree
    mkdir -p "${NGINX_SITES_DIR}"
    mkdir -p /etc/nginx/certs
    mkdir -p "${NGINX_HTPASSWD_DIR}"
    mkdir -p /var/www/acme-challenge/.well-known/acme-challenge
    mkdir -p /etc/nginx-daemon/certs
    mkdir -p /var/lib/nginx-daemon
    # A fresh host runs with the Opfield names from the start; recorded now, so a re-run after a failed first run does
    # not mistake the state directory it left for a node from before the rename.
    if [[ "$NGINX_HAD_LEGACY_NAMES" -eq 0 && ! -e /var/lib/nginx-daemon/opfield-names ]]; then
        : > /var/lib/nginx-daemon/opfield-names
    fi
    grant_daemon_paths_to_run_user

    ok "Directories created"
}

# Site configurations and access lists from the directories of installers before the legacy nginx tree (already
# legacy cleanup) go to the current tree.
migrate_legacy_site_paths() {
    # legacy-name: the http.d sites directory of early installers (already legacy cleanup) — remove once
    # every node reports none
    local legacy_dirs=(
        "/etc/nginx/conf.d/sites"
        "$LEGACY_EARLY_SITES_DIR"
    )

    for legacy_dir in "${legacy_dirs[@]}"; do
        [[ "$legacy_dir" == "$NGINX_SITES_DIR" ]] && continue
        if [[ -d "$legacy_dir" ]]; then
            find "$legacy_dir" -maxdepth 1 -type f -name '*.conf' -exec mv -f {} "$NGINX_SITES_DIR"/ \; >> "$LOG_FILE" 2>&1 || true
        fi
    done

    if [[ -d /etc/nginx/htpasswd && "/etc/nginx/htpasswd" != "$NGINX_HTPASSWD_DIR" ]]; then
        find /etc/nginx/htpasswd -maxdepth 1 -type f -name 'access-list-*' -exec mv -f {} "$NGINX_HTPASSWD_DIR"/ \; >> "$LOG_FILE" 2>&1 || true
    fi
}

# ── Step 4: Download nginx-daemon binary ─────────────────────────────

verify_checksum() {
    local file="$1"
    local binary_name="$2"

    log "Verifying checksum..."
    local checksums_file="/tmp/opfield_checksums.txt"
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
        if [[ -L "$NGINX_DAEMON_BIN_LINK" ]] || is_daemon_wrapper "$NGINX_DAEMON_BIN_LINK"; then
            rm -f "$NGINX_DAEMON_BIN_LINK"
        fi
        install_daemon_binary "$NGINX_DAEMON_BIN_LINK"
        return
    fi
    install -d -m 0755 "$NGINX_DAEMON_OWN_DIR" "$(dirname "$NGINX_DAEMON_OWN_BINARY")"
    install_daemon_binary "$NGINX_DAEMON_OWN_BINARY"
    write_daemon_wrapper "$NGINX_DAEMON_BIN_LINK" "$NGINX_DAEMON_OWN_BINARY" || die "Could not write the nginx-daemon command at $NGINX_DAEMON_BIN_LINK."
    grant_daemon_paths_to_run_user
}

install_daemon_binary() {
    local target="$1"
    local binary_name="nginx-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$(daemon_binary_version "$target" || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "nginx-daemon already installed (${existing_ver})"
            return 0
        fi
        # The version the node runs is the installed command's (EXISTING_VERSION): the binary here can be a copy a
        # run as another user left behind (a run-user switch), which says nothing about what is installed.
        local installed_ver="$existing_ver"
        [[ "$EXISTING_VERSION" =~ ^v[0-9] ]] && installed_ver="$EXISTING_VERSION"
        if [[ "$installed_ver" == "$RESOLVED_DAEMON_VERSION" ]]; then
            log "Installing nginx-daemon ${RESOLVED_DAEMON_VERSION} at ${target}..."
        else
            log "Upgrading nginx-daemon from ${installed_ver} to ${RESOLVED_DAEMON_VERSION}..."
        fi
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
        prune_older_backups "$target" "$backup"
    else
        log "Downloading nginx-daemon..."
    fi

    if curl -fsSL "$DOWNLOAD_URL" -o "${target}.tmp" >> "$LOG_FILE" 2>&1; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$(daemon_binary_version "$target" || echo "unknown")
        ok "nginx-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        die "Failed to download nginx-daemon ${RESOLVED_DAEMON_VERSION} from releases"
    fi
}


# ── Step 5: Install and enroll ───────────────────────────────────────
reset_existing_enrollment_for_token() {
    if [[ -z "$ENROLL_TOKEN" ]]; then
        return
    fi

    # Only a node that enrolled before has anything to replace; create_directories made an empty certs directory.
    if [[ -z "$(ls -A /etc/nginx-daemon/certs 2>/dev/null)" && ! -f /var/lib/nginx-daemon/state.json ]]; then
        return
    fi

    local backup_dir="/var/lib/nginx-daemon/enrollment-backup.$(date +%Y%m%d_%H%M%S)"
    log "Fresh enrollment token provided — replacing existing nginx-daemon enrollment state..."
    mkdir -p "$backup_dir"
    ENROLLMENT_BACKUP_DIR="$backup_dir"
    # The configuration holds the Opfield address, token and certificate the enrollment used.
    [[ ! -f /etc/nginx-daemon/config.yaml ]] || cp -a /etc/nginx-daemon/config.yaml "$backup_dir/config.yaml"

    if [[ -n "$(ls -A /etc/nginx-daemon/certs 2>/dev/null)" ]]; then
        cp -a /etc/nginx-daemon/certs "$backup_dir/certs"
        rm -rf /etc/nginx-daemon/certs
    fi

    if [[ -f /var/lib/nginx-daemon/state.json ]]; then
        cp -a /var/lib/nginx-daemon/state.json "$backup_dir/state.json"
        rm -f /var/lib/nginx-daemon/state.json
    fi

    ok "Backed up previous enrollment state to ${backup_dir}"
}

# A token Opfield does not accept (already used, expired, another node's) must not cost an enrolled node its
# enrollment: the enrollment reset_existing_enrollment_for_token set aside comes back, and the daemon runs on it again.
# A new enrollment that completed (its certificate is there) stays.
ENROLLMENT_BACKUP_DIR=""
ENROLLMENT_RESTORED=0
restore_previous_enrollment() {
    [[ -n "$ENROLLMENT_BACKUP_DIR" && -d "$ENROLLMENT_BACKUP_DIR" ]] || return 0
    [[ ! -f /etc/nginx-daemon/certs/node.pem ]] || return 0
    warn "Restoring the previous enrollment from ${ENROLLMENT_BACKUP_DIR}..."
    stop_daemon_service || true
    if [[ -d "${ENROLLMENT_BACKUP_DIR}/certs" ]]; then
        rm -rf /etc/nginx-daemon/certs
        cp -a "${ENROLLMENT_BACKUP_DIR}/certs" /etc/nginx-daemon/certs
    fi
    [[ ! -f "${ENROLLMENT_BACKUP_DIR}/state.json" ]] || cp -a "${ENROLLMENT_BACKUP_DIR}/state.json" /var/lib/nginx-daemon/state.json
    if [[ -f "${ENROLLMENT_BACKUP_DIR}/config.yaml" ]]; then
        cp -a "${ENROLLMENT_BACKUP_DIR}/config.yaml" /etc/nginx-daemon/config.yaml
        apply_host_access_config /etc/nginx-daemon/config.yaml
    fi
    grant_daemon_paths_to_run_user
    forget_control_session
    ENROLLMENT_RESTORED=1
    if restart_daemon_service; then
        ok "nginx-daemon runs on its previous enrollment again"
    else
        warn "nginx-daemon did not start on its previous enrollment; start it with the service manager."
    fi
}

restart_daemon_service() {
    if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
        manual_launcher_fallback "nginx-daemon" "/usr/local/bin/nginx-daemon" "/var/lib/nginx-daemon"
    elif has_systemd; then
        systemctl restart nginx-daemon >> "$LOG_FILE" 2>&1
    elif has_openrc; then
        rc-service nginx-daemon restart >> "$LOG_FILE" 2>&1
    else
        return 1
    fi
}

remember_enrollment_token() {
    [[ -n "$ENROLL_TOKEN" && -f /etc/nginx-daemon/certs/node.pem ]] || return 0
    (umask 077; enrollment_token_digest "$ENROLL_TOKEN" > "$ENROLLMENT_TOKEN_DIGEST_FILE") 2>> "$LOG_FILE" || return 0
    chown "${RUN_USER}:${RUN_GROUP}" "$ENROLLMENT_TOKEN_DIGEST_FILE" 2>> "$LOG_FILE" || true
}

set_daemon_config_value() {
    local key="$1"
    local value="$2"
    local config_file="/etc/nginx-daemon/config.yaml"

    if ! grep -Eq "^[[:space:]]*${key}:[[:space:]]*" "$config_file"; then
        die "Missing ${key} in ${config_file}"
    fi

    # Accept both quoted and legacy unquoted YAML values. Older installers only
    # matched quoted values, leaving htpasswd_dir pointed at /etc/nginx/htpasswd
    # while generated host configs read the htpasswd directory of the Opfield tree.
    sed -i -E "s|^([[:space:]]*${key}:[[:space:]]*).*$|\\1\"${value}\"|" "$config_file"
    grep -Fq "${key}: \"${value}\"" "$config_file" || die "Failed to update ${key} in ${config_file}"
}

# Whether the daemon's install command takes --opfield and --opfield-cert-sha256: install without arguments prints its
# usage and exits without changing anything. A daemon of an earlier release (a pinned --version) knows only the
# legacy flags.
daemon_install_takes_opfield_flags() {
    local usage
    usage=$(run_as_run_user "$1" install 2>&1 || true)
    [[ "$usage" == *--opfield* ]]
}

enroll_daemon() {
    local target="/usr/local/bin/nginx-daemon"
    local address_flag="--opfield" cert_flag="--opfield-cert-sha256"

    if [[ -f /etc/nginx-daemon/config.yaml ]]; then
        set_daemon_config_value config_dir "$NGINX_SITES_DIR"
        set_daemon_config_value htpasswd_dir "$NGINX_HTPASSWD_DIR"
        if [[ "$STUB_STATUS_URL" != "http://127.0.0.1/nginx_status" ]]; then
            set_daemon_config_value stub_status_url "$STUB_STATUS_URL"
        fi
    fi

    reset_existing_enrollment_for_token

    # Check if already enrolled (certs exist)
    if [[ -f /etc/nginx-daemon/certs/node.pem && -f /var/lib/nginx-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        prepare_run_user_identity
        return 0
    fi

    log "Writing config and enrolling with Opfield..."
    if ! daemon_install_takes_opfield_flags "$target"; then
        # legacy-name: the address and fingerprint install flags of nginx-daemon before 2.12.1 — remove once the
        # installer no longer installs an nginx-daemon release before 2.12.1
        address_flag="$LEGACY_ADDRESS_FLAG"
        cert_flag="$LEGACY_CERT_FLAG"
    fi
    if ! run_as_run_user "$target" install "$address_flag" "$OPFIELD_ADDR" --token "$ENROLL_TOKEN" "$cert_flag" "$OPFIELD_CERT_SHA256" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll nginx-daemon. Check ${LOG_FILE} for details."
    fi
    set_daemon_config_value config_dir "$NGINX_SITES_DIR"
    set_daemon_config_value htpasswd_dir "$NGINX_HTPASSWD_DIR"
    if [[ "$STUB_STATUS_URL" != "http://127.0.0.1/nginx_status" ]]; then
        set_daemon_config_value stub_status_url "$STUB_STATUS_URL"
    fi
    prepare_run_user_identity
    ok "Config written to /etc/nginx-daemon/config.yaml"
}

# ── Step 6: Start the daemon ─────────────────────────────────────────
# A host with systemd or OpenRC runs the daemon as a service, and a service that does not start fails the install.
# Manual mode is only for hosts without a service manager.
start_daemon() {
    retire_legacy_update_guard "nginx-daemon" "/usr/local/bin/nginx-daemon"
    log "Enabling and starting nginx-daemon..."
    # A daemon running as its own user cannot create its socket directories in /run; the service manager does. Its
    # nginx -t binds the configured listen ports, below 1024 too, so it gets the capability its nginx has.
    # supervise-daemon opens the log files after it drops to the service user, so root hands them over first; a daemon
    # switched back to root gets them back the same way.
    local unit_runtime="" openrc_capabilities="" runtime_dirs
    local openrc_runtime=$'\n\nstart_pre() {\n    checkpath --file --owner '"${RUN_USER}:${RUN_GROUP}"$' --mode 0640 /var/log/nginx-daemon.log\n    checkpath --file --owner '"${RUN_USER}:${RUN_GROUP}"$' --mode 0640 /var/log/nginx-daemon.err'
    if [[ "$RUN_USER" != "root" ]]; then
        # Only the Opfield names: a service that prepared the old ones would recreate them as real directories at every
        # boot, also after the daemon moved to the new names.
        runtime_dirs="nginx-daemon opfield-secure-links opfield-registry-links opfield-ingress-health"
        unit_runtime=$'\nRuntimeDirectory='"${runtime_dirs}"$'\nRuntimeDirectoryMode=0755\nRuntimeDirectoryPreserve=yes\nAmbientCapabilities=CAP_NET_BIND_SERVICE'
        openrc_capabilities=$'\ncapabilities="^cap_net_bind_service"'
        openrc_runtime+=$'\n    for dir in '"${runtime_dirs}"$'; do\n        checkpath --directory --mode 0755 --owner '"${RUN_USER}:${RUN_GROUP}"$' "/run/${dir}"\n    done'
        if [[ "$NGINX_HAD_LEGACY_NAMES" -eq 1 ]]; then
            # The old names at boot, as root: directories until the daemon moved (it writes opfield-names), then links
            # to the Opfield directories, so raw routes that still name the legacy directories keep working.
            unit_runtime+=$'\n# legacy-name: the legacy runtime directories of a node before its move to the Opfield names — remove once every node reports none'
            unit_runtime+=$'\nExecStartPre=+/bin/sh -c \'for d in secure-links registry-links ingress-health; do if [ -e /var/lib/nginx-daemon/opfield-names ]; then if [ -d '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d ] && [ ! -L '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d ]; then rmdir '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d 2>/dev/null || true; fi; [ -e '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d ] || [ -L '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d ] || ln -s opfield-$$d '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d || true; else install -d -o '"${RUN_USER}"' -g '"${RUN_GROUP}"$' -m 0755 '"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'$$d; fi; done\''
            openrc_runtime+=$'\n    # legacy-name: the legacy runtime directories of a node before its move to the Opfield names — remove once every node reports none'
            openrc_runtime+=$'\n    for dir in secure-links registry-links ingress-health; do\n        if [ -e /var/lib/nginx-daemon/opfield-names ]; then\n            if [ -d "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" ] && [ ! -L "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" ]; then\n                rmdir "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" 2>/dev/null || true\n            fi\n            [ -e "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" ] || [ -L "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" ] || ln -s "opfield-${dir}" "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}" || true\n        else\n            checkpath --directory --mode 0755 --owner '"${RUN_USER}:${RUN_GROUP}"$' "'"/run/${LEGACY_RUNTIME_DIR_PREFIX}"$'${dir}"\n        fi\n    done'
        fi
    fi
    openrc_runtime+=$'\n}'

    if has_systemd; then
        # Write systemd unit with user/group support
        cat > /etc/systemd/system/nginx-daemon.service <<UNIT || die "Could not write the nginx-daemon systemd unit."
[Unit]
Description=Opfield Nginx Daemon
After=network-online.target nginx.service
Wants=network-online.target nginx.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/nginx-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536
# Secure Link sockets outlive a daemon restart in the file descriptor store.
FileDescriptorStoreMax=4096
NotifyAccess=main${unit_runtime}

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload >> "$LOG_FILE" 2>&1 || die "systemd daemon-reload failed."
        systemctl enable nginx-daemon >> "$LOG_FILE" 2>&1 || die "Could not enable nginx-daemon."
        forget_control_session
        systemctl restart nginx-daemon >> "$LOG_FILE" 2>&1 || { release_fd_store_hold; fail_daemon_start "Could not start nginx-daemon."; }
        release_fd_store_hold
    elif has_openrc; then
        cat > /etc/init.d/nginx-daemon <<UNIT || die "Could not write the nginx-daemon OpenRC service."
#!/sbin/openrc-run
name="Opfield Nginx Daemon"
description="Opfield Nginx Daemon"
command="/usr/local/bin/nginx-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5${openrc_capabilities}
output_log="/var/log/nginx-daemon.log"
error_log="/var/log/nginx-daemon.err"

depend() {
    need net
    want nginx
}${openrc_runtime}
UNIT
        chmod +x /etc/init.d/nginx-daemon || die "Could not make the nginx-daemon OpenRC service executable."
        rc-update add nginx-daemon default >> "$LOG_FILE" 2>&1 || die "Could not enable nginx-daemon in OpenRC."
        openrc_refresh_deptree
        forget_control_session
        if ! rc-service nginx-daemon restart >> "$LOG_FILE" 2>&1 && ! rc-service nginx-daemon start >> "$LOG_FILE" 2>&1; then
            fail_daemon_start "Could not start nginx-daemon in OpenRC."
        fi
    else
        warn "No supported service manager found; using manual mode."
        manual_launcher_fallback "nginx-daemon" "/usr/local/bin/nginx-daemon" "/var/lib/nginx-daemon" \
            || fail_daemon_start "Could not start nginx-daemon in manual mode."
    fi
    ok "nginx-daemon started"
}

# A dry run stops here, once every function it uses is defined.
if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

# ── Run ──────────────────────────────────────────────────────────────
prepare_run_user_switch
install_nginx
create_directories
migrate_legacy_site_paths
configure_nginx
install_daemon
align_default_server_file
remember_host_access_config /etc/nginx-daemon/config.yaml
enroll_daemon
apply_host_access_config /etc/nginx-daemon/config.yaml
finish_run_user_switch
start_daemon
# An install whose daemon does not run or did not connect to Opfield is not done.
if ! await_opfield_connection; then
    restore_previous_enrollment
    [[ "$ENROLLMENT_RESTORED" -eq 0 ]] || die "The node keeps its previous enrollment; the enrollment token was not used."
    die "nginx-daemon is installed, but it did not connect to Opfield."
fi
remember_enrollment_token

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Opfield within a few seconds."
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo -e "  Manual mode is not persistent across reboot."
elif has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status nginx-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u nginx-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service nginx-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/nginx-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}nginx-daemon run${NC}"
fi
complete_success
