#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# legacy-compat: scripts/stage-installers.sh puts scripts/legacy-compat.sh in place of this line.
# shellcheck source=legacy-compat.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/legacy-compat.sh"

# Opfield managed-database node setup.
#
# This is intentionally a thin, root-only wrapper around setup-docker-node.sh:
# the existing docker-daemon remains the only daemon binary. Storage selection
# and the capability preflight are rendered in its shared interactive flow.

GREEN='\033[0;32m'
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'

err() { printf '%b\n' "${ERROR_TAG} ERROR ${NC} $*" >&2; }
log() { printf '%b\n' "${GREEN}INFO${NC} $*"; }
die() {
    err "$@"
    echo "" >&2
    echo -e "${ERROR_TAG} ■ ${NC} Installation completed with errors." >&2
    echo "" >&2
    exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }

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

show_header() {
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Opfield Node Setup"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Database daemon installer"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_start() { echo -e "${BRAND_MINT}╭${NC} $*"; }

# Without -y the installer asks on the terminal. When the terminal cannot be read (no controlling terminal, or the
# read fails with EIO under sudo's pty while stdout is a pipe) nothing was answered, and a default must not stand in
# for an answer: the run counts as non-interactive, which cannot approve what it asks about.
refuse_unanswered_prompt() {
    echo "" >&2
    die "Cannot read an answer from the terminal for: $1. Run the installer from a terminal (not through a pipe such as '| tee'), or pass -y to install non-interactively."
}

prompt_choice() {
    local prompt="$1"
    local default="$2"
    local reply
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty || refuse_unanswered_prompt "$prompt"
    echo "${reply:-$default}"
}

# legacy-name: pre-2.12.1 names of the variables
# installer environment — customer automation; drop with a changelog notice. Each is read when its OPFIELD_* name is not
# set (the new name wins).
for legacy_suffix in SETUP_VERSION RELEASE_DOWNLOAD_BASE DATABASE_STORAGE_ROOT DOCKER_MODE; do
    legacy_env="${LEGACY_ENV_PREFIX}${legacy_suffix}"
    opfield_env="OPFIELD_${legacy_suffix}"
    if [[ -z "${!opfield_env:-}" && -n "${!legacy_env:-}" ]]; then
        printf -v "$opfield_env" '%s' "${!legacy_env}"
    fi
done
unset legacy_suffix legacy_env opfield_env

# A release publishes this file with its own tag here, so setup-docker-node.sh comes from the same release.
INSTALLER_RELEASE=latest
SETUP_VERSION="${OPFIELD_SETUP_VERSION:-$INSTALLER_RELEASE}"
RELEASE_DOWNLOAD_BASE="${OPFIELD_RELEASE_DOWNLOAD_BASE:-https://get.opfield.dev/opfield/releases}"
STORAGE_ROOT="${OPFIELD_DATABASE_STORAGE_ROOT:-}"
RUN_USER="root"
DRY_RUN=0
NON_INTERACTIVE=0
PASSTHROUGH=()
LOCAL_DOCKER_SCRIPT="$(dirname "$0")/setup-docker-node.sh"
DOWNLOADED_DOCKER_SCRIPT=""
PREFLIGHT_DIR=""
LOOP_DEVICE=""
MOUNT_DIR=""

usage() {
    cat <<'HELP'
Opfield Database Node Setup — restricted docker-daemon enrollment

Usage:
  setup-database-node.sh [options]

Options:
  --storage-root <path>   Existing or creatable local storage root used for the
                          disposable ext4 capability preflight (default:
                          /var/lib/docker-daemon/databases)
  --user root             Accepted only for compatibility; databases always run as root
  --dry-run               Validate delegated Docker setup without changing the host
  -h, --help              Show this help

All other options are forwarded to setup-docker-node.sh. The node is enrolled
only after the storage preflight succeeds.
HELP
    exit 0
}

cleanup() {
    set +e
    if [[ -n "$MOUNT_DIR" ]] && command_exists mountpoint && mountpoint -q "$MOUNT_DIR"; then
        umount "$MOUNT_DIR" >/dev/null 2>&1
    fi
    if [[ -n "$LOOP_DEVICE" ]]; then
        losetup -d "$LOOP_DEVICE" >/dev/null 2>&1
    fi
    cleanup_preflight
    if [[ -n "$DOWNLOADED_DOCKER_SCRIPT" ]]; then
        rm -f "$DOWNLOADED_DOCKER_SCRIPT"
    fi
}
trap cleanup EXIT INT TERM

cleanup_preflight() {
    [[ -n "$PREFLIGHT_DIR" ]] || return 0
    rm -f "$PREFLIGHT_DIR/test.img" >/dev/null 2>&1 || true
    rmdir "$PREFLIGHT_DIR/mnt" >/dev/null 2>&1 || true
    rmdir "$PREFLIGHT_DIR" >/dev/null 2>&1 || true
    PREFLIGHT_DIR=""
    MOUNT_DIR=""
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --storage-root)
            [[ $# -ge 2 ]] || die "--storage-root requires a path"
            STORAGE_ROOT="$2"
            shift 2
            ;;
        --user)
            [[ $# -ge 2 ]] || die "--user requires a value"
            # setup-storage-node.sh runs this installer for storage nodes.
            if [[ "$2" != "root" ]]; then
                [[ "${OPFIELD_DOCKER_MODE:-databases}" == "storage" ]] && die "Storage nodes must run docker-daemon as root."
                die "Database nodes must run docker-daemon as root."
            fi
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            PASSTHROUGH+=("--dry-run")
            shift
            ;;
        -y|--yes)
            NON_INTERACTIVE=1
            PASSTHROUGH+=("$1")
            shift
            ;;
        --opfield)
            [[ $# -ge 2 ]] || die "--opfield requires a value"
            PASSTHROUGH+=("$1" "$2")
            shift 2
            ;;
        --opfield-cert-sha256)
            [[ $# -ge 2 ]] || die "--opfield-cert-sha256 requires a value"
            PASSTHROUGH+=("$1" "$2")
            shift 2
            ;;
        -h|--help) usage ;;
        *) PASSTHROUGH+=("$1"); shift ;;
    esac
done

[[ "$EUID" -eq 0 ]] || die "This script must be run as root (or with sudo)."

if [[ -x "$LOCAL_DOCKER_SCRIPT" ]]; then
    DOCKER_SCRIPT="$LOCAL_DOCKER_SCRIPT"
else
    command_exists curl || die "curl is required to fetch setup-docker-node.sh."
    if [[ "$SETUP_VERSION" == "latest" ]]; then
        release_url="${RELEASE_DOWNLOAD_BASE%/}/latest/download"
    else
        [[ "$SETUP_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || die "Invalid release tag: ${SETUP_VERSION}"
        release_url="${RELEASE_DOWNLOAD_BASE%/}/download/${SETUP_VERSION}"
    fi
    DOWNLOADED_DOCKER_SCRIPT=$(mktemp /tmp/opfield-setup-docker.XXXXXX)
    checksums=$(mktemp /tmp/opfield-setup-checksums.XXXXXX)
    curl -fsSL "${release_url}/opfield-node-installers.sha256" -o "$checksums" ||
        die "Could not download installer checksums."
    curl -fsSL "${release_url}/setup-docker-node.sh" -o "$DOWNLOADED_DOCKER_SCRIPT" ||
        die "Could not download setup-docker-node.sh."
    expected=$(awk '$2 == "setup-docker-node.sh" { print $1 }' "$checksums")
    actual=$(sha256_file "$DOWNLOADED_DOCKER_SCRIPT")
    rm -f "$checksums"
    [[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] ||
        die "Checksum verification failed for setup-docker-node.sh."
    chmod 700 "$DOWNLOADED_DOCKER_SCRIPT"
    DOCKER_SCRIPT="$DOWNLOADED_DOCKER_SCRIPT"
fi

# setup-docker-node performs the actual docker installation and enrollment.
# Force the restricted node's service identity and preserve the caller's flags.
export OPFIELD_DATABASE_STORAGE_ROOT="$STORAGE_ROOT"
OPFIELD_DOCKER_MODE="${OPFIELD_DOCKER_MODE:-databases}"
case "$OPFIELD_DOCKER_MODE" in
    databases|storage) export OPFIELD_DOCKER_MODE ;;
    *) die "Invalid restricted Docker mode '${OPFIELD_DOCKER_MODE}'" ;;
esac
# legacy-name: pre-2.12.1 names of the variables for a setup-docker-node.sh of a release before
# 2.12.1 (a pinned OPFIELD_SETUP_VERSION) — remove once the installers no longer install such a release
export "${LEGACY_ENV_PREFIX}DATABASE_STORAGE_ROOT=$OPFIELD_DATABASE_STORAGE_ROOT" "${LEGACY_ENV_PREFIX}DOCKER_MODE=$OPFIELD_DOCKER_MODE"
if ! grep -Eq '^[[:space:]]*--opfield\)' "$DOCKER_SCRIPT"; then
    # legacy-name: the pre-2.12.1 address flags for a setup-docker-node.sh of a release before 2.12.1 (a pinned
    # OPFIELD_SETUP_VERSION) — remove once the installers no longer install such a release
    for i in "${!PASSTHROUGH[@]}"; do
        case "${PASSTHROUGH[$i]}" in
            --opfield) PASSTHROUGH[$i]="$LEGACY_ADDRESS_FLAG" ;;
            --opfield-cert-sha256) PASSTHROUGH[$i]="$LEGACY_CERT_FLAG" ;;
        esac
    done
fi
bash "$DOCKER_SCRIPT" "${PASSTHROUGH[@]}" --user "$RUN_USER"
