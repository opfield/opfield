#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Opfield Daemon Setup — Dispatcher ───────────────────────────────
# Downloads and runs the appropriate setup script for a daemon type.
#
# Usage:
#   curl -sSL https://get.opfield.dev/opfield/releases/latest/download/setup-daemon.sh | \
#     sudo bash -s -- --type nginx --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<HEX>
# ────────────────────────────────────────────────────────────────────

# ── Colors ──────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[47m\033[90m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'

# ── Defaults ────────────────────────────────────────────────────────
# legacy-name: pre-2.12.1 installer environment —
# customer automation; drop with a changelog notice. Each is read when its OPFIELD_* name is not set (the new name wins).
for legacy_env in GATEWAY_SETUP_SCRIPT_DIR GATEWAY_SETUP_VERSION GATEWAY_RELEASE_DOWNLOAD_BASE; do
    opfield_env="OPFIELD_${legacy_env#GATEWAY_}"
    if [[ -z "${!opfield_env:-}" && -n "${!legacy_env:-}" ]]; then
        printf -v "$opfield_env" '%s' "${!legacy_env}"
    fi
done
unset legacy_env opfield_env
DAEMON_TYPE=""
LOCAL_SCRIPT_DIR="${OPFIELD_SETUP_SCRIPT_DIR:-}"
# A release publishes this file with its own tag here, so the node installers come from the same release.
INSTALLER_RELEASE=latest
SETUP_VERSION="${OPFIELD_SETUP_VERSION:-$INSTALLER_RELEASE}"
RELEASE_DOWNLOAD_BASE="${OPFIELD_RELEASE_DOWNLOAD_BASE:-https://get.opfield.dev/gateway/releases}"
PASSTHROUGH_ARGS=()

# ── Helpers ─────────────────────────────────────────────────────────
log()  { echo -e "${INFO_TAG} INFO ${NC} $*"; }
warn() { echo -e "${WARN_TAG} WARN ${NC} $*"; }
err()  { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; }
die()  { err "$@"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

sha256_file() {
    local file="$1"
    if command_exists sha256sum; then
        sha256sum "$file" | awk '{print $1}'
    elif command_exists shasum; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif command_exists openssl; then
        openssl dgst -sha256 "$file" | awk '{print $NF}'
    else
        die "A SHA-256 tool (sha256sum, shasum, or openssl) is required"
    fi
}

mktemp_compat() {
    local prefix="${1:-/tmp/opfield-tmp}"
    local dir template

    dir="$(dirname "$prefix")"
    template="$(basename "$prefix").XXXXXX"

    mkdir -p "$dir"
    mktemp "${dir}/${template}"
}

show_logo() {
    local title="$1"
    local subtitle="$2"

    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$title"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$subtitle"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_end() { echo -e "${BRAND_MINT}╰${NC}"; }
guide_start() { echo -e "${BRAND_MINT}╭${NC} $*"; }
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

prompt_menu() {
    local default="$1"
    shift
    local -a options=("$@")
    local selected=$((default - 1)) key sequence reply tty="/dev/tty" tty_device="" supports_arrow_menu=1 index
    [[ -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]] || die "Cannot show an interactive menu — use --type flag"
    tty_device=$(tty < "$tty" 2>/dev/null || true)
    case "$tty_device" in
        /dev/ttyS*|/dev/hvc*|/dev/xvc*|/dev/console) supports_arrow_menu=0 ;;
    esac
    if [[ "$supports_arrow_menu" -eq 1 ]]; then
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
    while true; do
        printf "${BRAND_MINT}◆${NC} ${BRAND_MINT}Choose [${default}]: ${NC}" > "$tty"
        # An unreadable terminal answered nothing; the default must not choose the node type.
        IFS= read -r reply < "$tty" 2>/dev/null || die "Cannot read an answer from the terminal — run the installer from a terminal, or use the --type flag"
        reply="${reply:-$default}"
        if [[ "$reply" =~ ^[0-9]+$ && "$reply" -ge 1 && "$reply" -le "${#options[@]}" ]]; then
            echo "$reply"
            return
        fi
        printf "${YELLOW}Enter a number from 1 to %d.${NC}\n" "${#options[@]}" > "$tty"
    done
}

# ── Parse Arguments ─────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Opfield Daemon Setup — downloads and runs the appropriate setup script

Usage:
  setup-daemon.sh --type <nginx|docker|storage|monitoring> [options...]

Options:
  --type <type>            Node type: nginx, docker, storage, or monitoring (databases is a legacy alias)
  --version <tag>          Opfield release tag containing the installers (default: the release
                           this installer came from)
  --script-dir <path>      Run a daemon-specific installer from a local directory
  -h, --help               Show this help

All other flags are forwarded to the daemon-specific setup script.

Examples:
  # Interactive type selection:
  sudo bash setup-daemon.sh

  # Direct nginx setup:
  sudo bash setup-daemon.sh --type nginx --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<HEX>

  # Docker daemon:
  sudo bash setup-daemon.sh --type docker --opfield opfield.example.com:9443 --token <TOKEN> --opfield-cert-sha256 sha256:<HEX>
HELP
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --type)           DAEMON_TYPE="$2"; shift 2 ;;
        --version)        SETUP_VERSION="$2"; shift 2 ;;
        --script-dir)     LOCAL_SCRIPT_DIR="$2"; shift 2 ;;
        -h|--help)        show_help ;;
        *)                PASSTHROUGH_ARGS+=("$1"); shift ;;
    esac
done

# ── Dependency check ────────────────────────────────────────────────
if ! command_exists curl; then
    die "curl is required but not found. Install it and retry."
fi

# ── Interactive type selection ──────────────────────────────────────
if [[ -z "$DAEMON_TYPE" ]]; then
    if [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo "Opfield Daemon Setup" "Choose a node installer"
    selector_title "Select daemon type to install:"
    choice=$(prompt_menu "1" "nginx       — Reverse proxy node (nginx + nginx-daemon)" "docker      — Docker container management node" "storage     — Managed databases, object storage and backups" "monitoring  — System metrics agent (no nginx/docker)")
    case "$choice" in
        1|nginx)      DAEMON_TYPE="nginx" ;;
        2|docker)     DAEMON_TYPE="docker" ;;
        3|storage)    DAEMON_TYPE="storage" ;;
        databases)   DAEMON_TYPE="databases" ;;
        4|monitoring) DAEMON_TYPE="monitoring" ;;
        *) die "Invalid choice: $choice" ;;
    esac
fi

# ── Validate type ───────────────────────────────────────────────────
case "$DAEMON_TYPE" in
    nginx|docker|storage|databases|monitoring) ;;
    *) die "Unknown daemon type: $DAEMON_TYPE. Use: nginx, docker, storage, or monitoring" ;;
esac

# ── Map type to script name ─────────────────────────────────────────
case "$DAEMON_TYPE" in
    nginx)      SCRIPT_NAME="setup-node.sh" ;;
    docker)     SCRIPT_NAME="setup-docker-node.sh" ;;
    databases)  SCRIPT_NAME="setup-database-node.sh" ;;
    storage)    SCRIPT_NAME="setup-storage-node.sh" ;;
    monitoring) SCRIPT_NAME="setup-monitoring-node.sh" ;;
esac

# ── Resolve and execute ─────────────────────────────────────────────
if [[ -n "$LOCAL_SCRIPT_DIR" ]]; then
    TMPSCRIPT="${LOCAL_SCRIPT_DIR%/}/${SCRIPT_NAME}"
    [[ -f "$TMPSCRIPT" ]] || die "Local installer not found: ${TMPSCRIPT}"
    log "Running local ${SCRIPT_NAME}..."
else
    if [[ "$SETUP_VERSION" == "latest" ]]; then
        RELEASE_URL="${RELEASE_DOWNLOAD_BASE%/}/latest/download"
    else
        [[ "$SETUP_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || die "Invalid release tag: ${SETUP_VERSION}"
        RELEASE_URL="${RELEASE_DOWNLOAD_BASE%/}/download/${SETUP_VERSION}"
    fi
    TMPDIR=$(mktemp -d /tmp/opfield-setup.XXXXXX)
    trap 'rm -rf "$TMPDIR"' EXIT
    CHECKSUMS="${TMPDIR}/opfield-node-installers.sha256"
    log "Downloading verified ${SCRIPT_NAME} from Opfield releases..."
    # legacy-name: gateway-daemon-installers.sha256, the only checksum list of releases before 2.12.1 (a pinned
    # --version) — remove once the installers no longer install such a release.
    curl -fsSL "${RELEASE_URL}/opfield-node-installers.sha256" -o "$CHECKSUMS" 2>/dev/null ||
        curl -fsSL "${RELEASE_URL}/gateway-daemon-installers.sha256" -o "$CHECKSUMS" ||
        die "Failed to download installer checksums from ${RELEASE_URL}"

    fetch_verified() {
        local name="$1" target="${TMPDIR}/$1" expected actual
        expected=$(awk -v name="$name" '$2 == name { print $1 }' "$CHECKSUMS")
        [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die "Missing or invalid checksum for ${name}"
        curl -fsSL "${RELEASE_URL}/${name}" -o "$target" || die "Failed to download ${name} from ${RELEASE_URL}"
        actual=$(sha256_file "$target")
        [[ "$actual" == "$expected" ]] || die "Checksum verification failed for ${name}"
        chmod 700 "$target"
    }

    fetch_verified "$SCRIPT_NAME"
    if [[ "$DAEMON_TYPE" == "databases" || "$DAEMON_TYPE" == "storage" ]]; then
        fetch_verified setup-docker-node.sh
    fi
    if [[ "$DAEMON_TYPE" == "storage" ]]; then
        fetch_verified setup-database-node.sh
    fi
    TMPSCRIPT="${TMPDIR}/${SCRIPT_NAME}"
    log "Running ${SCRIPT_NAME}..."
fi
echo ""

bash "$TMPSCRIPT" "${PASSTHROUGH_ARGS[@]}"
