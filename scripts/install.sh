#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DEFAULT_IMAGE="ghcr.io/opfield/opfield"
# legacy-compat: scripts/stage-installers.sh puts scripts/legacy-compat.sh in place of this line.
# shellcheck source=legacy-compat.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/legacy-compat.sh"
# Official image repositories: the Opfield one, and the one signed manifests of releases before 2.12 name (--restore).
# Unless --image or OPFIELD_IMAGE names another repository, the installer installs the one the manifest names.
OFFICIAL_IMAGES=("ghcr.io/opfield/opfield" "$LEGACY_IMAGE_REPOSITORY")
DOCKER_COMPOSE_CLI_IMAGE_REF="docker.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"
# Third-party service images, pinned by digest and mirrored to GHCR by the release pipeline
# (config/third-party-images.json). The GHCR mirror is pulled first; Docker Hub serves the same
# digest when the mirror cannot be pulled, like on Docker nodes (packages/daemons/docker third_party_images.go).
THIRD_PARTY_MIRROR_REPOSITORY="ghcr.io/opfield/opfield"
REGISTRY_UPSTREAM_IMAGE_REF="docker.io/library/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8" # 3.1.2
POSTGRES_UPSTREAM_IMAGE_REF="docker.io/library/postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea" # 16.15-alpine
REDIS_UPSTREAM_IMAGE_REF="docker.io/library/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499" # 7.4.11-alpine
DEFAULT_INSTALL_DIR="/opt/opfield"
# LEGACY_INSTALL_DIR (legacy-compat.sh): installations made before 2.12.1 live there until their host move; an update
# finds them there.
# Present from the start of a fresh install until its setup code is shown; a re-run resumes it.
INSTALL_PENDING_MARKER=".opfield-install-pending"
# LEGACY_INSTALL_PENDING_MARKER (legacy-compat.sh): a fresh install of a release before 2.12.1 that stopped early.
# The first release that runs in the Opfield layout (directory /opt/opfield, Compose project, database and role
# `opfield`, OPFIELD_* settings). --restore installs older releases in the layout they know.
FIRST_OPFIELD_LAYOUT_VERSION="v2.12.1-rc.3"
# The first release whose app image keeps its data under /var/lib/opfield* inside the containers (earlier images use the
# legacy-compat.sh directories; later images link those to the Opfield ones).
FIRST_OPFIELD_DATA_DIR_VERSION="v2.12.3-rc.1"
HOST_MOVE_CONTAINER="opfield-host-move"
RELEASES_API_URL="${RELEASES_API_URL:-https://get.opfield.dev/opfield/releases}"
ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://get.opfield.dev/opfield}"
# legacy-name: pre-2.12.1 installer variables — automation written for releases before 2.12.1 still sets them; the
# OPFIELD_* name wins when both are set.
# The value of installer variable <suffix> under its pre-2.12.1 name (LEGACY_ENV_PREFIX), empty when unset.
legacy_installer_env() {
  local name="${LEGACY_ENV_PREFIX}$1"
  printf '%s' "${!name:-}"
}
INSTALL_DIR="${OPFIELD_INSTALL_DIR:-$(legacy_installer_env INSTALL_DIR)}"
IMAGE="${OPFIELD_IMAGE:-$(legacy_installer_env IMAGE)}"
IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
TRANSPORT="${OPFIELD_WEB_TRANSPORT:-$(legacy_installer_env WEB_TRANSPORT)}"
SOURCE_DIR="${OPFIELD_SOURCE_DIR:-$(legacy_installer_env SOURCE_DIR)}"
LOG_FILE="${OPFIELD_INSTALL_LOG_FILE:-$(legacy_installer_env INSTALL_LOG_FILE)}"
LOG_FILE="${LOG_FILE:-/tmp/opfield-install.log}"
DOCKER_DAEMON_CONFIG="${OPFIELD_DOCKER_DAEMON_CONFIG:-$(legacy_installer_env DOCKER_DAEMON_CONFIG)}"
DOCKER_DAEMON_CONFIG="${DOCKER_DAEMON_CONFIG:-/etc/docker/daemon.json}"
# OPFIELD_ for the release this run installs; the legacy prefix when --restore installs a release before 2.12.1.
ENV_PREFIX="OPFIELD_"
DRY_RUN=0
RELAY_BOOTSTRAP=0
RESTORE_FILE=""
RESTORE_PUBLIC_URL=""
RESTORE_GRPC_TARGET=""
RESTORE_VERSION=""
# --version: an exact Opfield release for a fresh install, release candidates included. Without it the newest stable
# release is installed.
PIN_VERSION="${OPFIELD_INSTALL_VERSION:-}"
CONSOLE_DOMAIN=""
ACME_EMAIL=""
UPDATE_SIGNING_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxLXGD8vCYQCYboK301miZXyAaoOLc43zFVnMlH3FeWg=
-----END PUBLIC KEY-----'

# ── Colors ────────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'
GUIDE_ACTIVE=0

info() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} ${INFO_TAG} INFO ${NC} $*"
  else
    echo -e "${INFO_TAG} INFO ${NC} $*"
  fi
}
warn() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} ${WARN_TAG} WARN ${NC} $*"
  else
    echo -e "${WARN_TAG} WARN ${NC} $*"
  fi
}
ok() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} \033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
  else
    echo -e "\033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
  fi
}
die() {
  echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2
  echo "" >&2
  echo -e "${ERROR_TAG} ■ ${NC} ${BOLD}Installation completed with errors.${NC}" >&2
  echo "" >&2
  exit 1
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_start() { GUIDE_ACTIVE=1; echo -e "${BRAND_MINT}╭${NC} $*"; }
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

short_digest() {
  local value="${1#sha256:}"
  if [[ ${#value} -le 12 ]]; then
    printf '%s' "$value"
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

artifact_url() {
  local package_name="$1" tag="$2" artifact_name="$3"
  printf '%s/%s/%s/%s' "${ARTIFACT_BASE_URL%/}" "$package_name" "$tag" "$artifact_name"
}

download_release_artifact() {
  local package_name="$1" tag="$2" artifact_name="$3" output="$4"
  curl -fsSL "$(artifact_url "$package_name" "$tag" "$artifact_name")" -o "$output" >>"$LOG_FILE" 2>&1
}

fetch_release() {
  local component="$1" current_version="${2:-}" channel="${3:-}" url
  url="${RELEASES_API_URL}?component=${component}"
  if [[ -n "$current_version" ]]; then
    url="${url}&current=${current_version}"
  fi
  if [[ -n "$channel" ]]; then
    url="${url}&channel=${channel}"
  fi
  curl -fsSL "$url" 2>>"$LOG_FILE"
}

# The relay release a pinned Opfield release (--version) installs with: the relay of that very release when it has
# one (a relay is released only when it changes), else the newest relay of its minor line, release candidates
# included for a release candidate. The relay manifest's minimum Opfield version still has to accept the release.
pinned_relay_tag() {
  local version="$1" line channel relay_json probe tag
  probe="$(mktemp)"
  if download_release_artifact relay "${version}-relay" relay-image.update.json "$probe"; then
    rm -f "$probe"
    printf '%s\n' "${version}-relay"
    return 0
  fi
  rm -f "$probe"
  line="$(printf '%s' "${version#v}" | cut -d. -f1-2)"
  channel=stable
  [[ "$version" != *-rc.* ]] || channel=preview
  relay_json="$(fetch_release relay "v${line}.0-rc.0" "$channel")" || return 1
  tag="$(
    printf '%s' "$relay_json" |
      grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' |
      sed -E 's/^.*"([^"]+)"$/\1/' |
      grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-relay$' |
      head -n1 || true
  )"
  # The resolver answers with the next minor line when this one has no relay release: that one does not belong here.
  [[ "${tag#v}" != "${line}."* ]] || printf '%s\n' "$tag"
}

# Whether a terminal can really be opened: under cloud-init or cron /dev/tty exists and passes -r/-w but has no
# controlling terminal behind it, so opening it fails.
tty_usable() {
  [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null
}

prompt_menu() {
  local default="$1"
  shift
  local -a options=("$@")
  local selected=$((default - 1)) key sequence tty="/dev/tty" index
  tty_usable && [[ "${TERM:-dumb}" != "dumb" ]] || { echo "$default"; return; }
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
    IFS= read -rsn1 key < "$tty" || { echo "$default"; return; }
    if [[ "$key" == $'\e' ]]; then
      IFS= read -rsn2 sequence < "$tty" || sequence=""
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
}

show_header() {
  local content_width=43 frame_width rule
  if [[ -t 1 ]] && command -v clear >/dev/null 2>&1; then
    clear
  fi
  frame_width=$((content_width + 2))
  printf -v rule '%*s' "$frame_width" ''
  rule="${rule// /─}"
  echo -e "${BRAND_MINT}╭${rule}╮${NC}"
  printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-*.*s${NC} ${BRAND_MINT}│${NC}\n" "$content_width" "$content_width" "Opfield Installer"
  printf "${BRAND_MINT}│${NC} ${GRAY}%-*.*s${NC} ${BRAND_MINT}│${NC}\n" "$content_width" "$content_width" "Infrastructure control plane"
  echo -e "${BRAND_MINT}╰${rule}╯${NC}"
  echo ""
}

run_quiet() {
  local label="$1"
  shift
  if "$@" </dev/null >>"$LOG_FILE" 2>&1; then
    return
  fi
  die "${label} failed. Check ${LOG_FILE} for details."
}

official_image() {
  local candidate
  for candidate in "${OFFICIAL_IMAGES[@]}"; do
    [[ "$1" == "$candidate" ]] && return 0
  done
  return 1
}

# Pulls a pinned third-party image and prints the reference to run it from: the GHCR mirror, or
# the upstream reference with the same digest when the mirror cannot be pulled.
pull_third_party_image() {
  local upstream="$1" repository mirror
  repository="${upstream%@*}"
  mirror="${THIRD_PARTY_MIRROR_REPOSITORY}/${repository##*/}@${upstream##*@}"
  if "${DOCKER[@]}" pull "$mirror" </dev/null >>"$LOG_FILE" 2>&1; then
    printf '%s' "$mirror"
  elif "${DOCKER[@]}" pull "$upstream" </dev/null >>"$LOG_FILE" 2>&1; then
    printf '%s' "$upstream"
  else
    return 1
  fi
}

# ── Docker Engine bootstrap ─────────────────────────────────────────
# Keep this installer self-contained: a fresh Opfield host must not require
# Docker to have been installed manually beforehand.  The package flow mirrors
# scripts/setup-docker-node.sh so Opfield and Docker-node installation use the
# same official Docker Engine repositories and Compose v2 plugin.
command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root_quiet() {
  local label="$1"
  shift
  if [[ $EUID -eq 0 ]]; then
    run_quiet "$label" "$@"
    return
  fi
  command_exists sudo || die "${label} requires root privileges. Re-run as root or install sudo."
  run_quiet "$label" sudo "$@"
}

run_root_best_effort() {
  local label="$1"
  shift
  if [[ $EUID -eq 0 ]]; then
    "$@" </dev/null >>"$LOG_FILE" 2>&1 || true
    return
  fi
  command_exists sudo || die "${label} requires root privileges. Re-run as root or install sudo."
  sudo "$@" </dev/null >>"$LOG_FILE" 2>&1 || true
}

detect_docker_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DOCKER_OS_ID="${ID:-unknown}"
    DOCKER_OS_LIKE="${ID_LIKE:-$DOCKER_OS_ID}"
    DOCKER_OS_CODENAME="${VERSION_CODENAME:-}"
  else
    DOCKER_OS_ID="unknown"
    DOCKER_OS_LIKE="unknown"
    DOCKER_OS_CODENAME=""
  fi
}

docker_repo_distro_family() {
  case "$DOCKER_OS_ID" in
    ubuntu) printf 'ubuntu' ;;
    debian) printf 'debian' ;;
    fedora) printf 'fedora' ;;
    rhel) printf 'rhel' ;;
    centos|centos_stream) printf 'centos' ;;
    *)
      if [[ "$DOCKER_OS_LIKE" == *ubuntu* ]]; then
        printf 'ubuntu'
      elif [[ "$DOCKER_OS_LIKE" == *debian* ]]; then
        printf 'debian'
      elif [[ "$DOCKER_OS_LIKE" == *fedora* ]]; then
        printf 'fedora'
      elif [[ "$DOCKER_OS_LIKE" == *rhel* || "$DOCKER_OS_LIKE" == *centos* ]]; then
        printf 'rhel'
      fi
      ;;
  esac
}

install_docker_packages() {
  if command_exists apt-get; then
    if [[ "${DOCKER_APT_UPDATED:-0}" -eq 0 ]]; then
      run_root_quiet "Refreshing package metadata" apt-get update
      DOCKER_APT_UPDATED=1
    fi
    run_root_quiet "Installing Docker dependencies" apt-get install -y "$@"
  elif command_exists dnf; then
    run_root_quiet "Installing Docker dependencies" dnf install -y "$@"
  elif command_exists yum; then
    run_root_quiet "Installing Docker dependencies" yum install -y "$@"
  else
    die "Could not detect a supported package manager for Docker installation."
  fi
}

ensure_curl_for_docker() {
  command_exists curl && return
  info "curl was not found; installing it for Docker setup"
  install_docker_packages curl ca-certificates
  ok "curl installed"
}

write_docker_apt_source() {
  local source_file="/etc/apt/sources.list.d/docker.sources"
  local source
  source="Types: deb
URIs: https://download.docker.com/linux/${1}
Suites: ${2}
Components: stable
Architectures: ${3}
Signed-By: /etc/apt/keyrings/docker.asc"

  if [[ $EUID -eq 0 ]]; then
    printf '%s\n' "$source" >"$source_file" || die "Could not write Docker apt repository configuration."
  else
    command_exists sudo || die "Writing the Docker apt repository requires root privileges."
    if ! printf '%s\n' "$source" | sudo tee "$source_file" >/dev/null 2>>"$LOG_FILE"; then
      die "Could not write Docker apt repository configuration. Check ${LOG_FILE} for details."
    fi
  fi
}

setup_docker_apt_repository() {
  local repo_distro="$1" codename arch
  install_docker_packages ca-certificates curl gnupg
  run_root_quiet "Preparing Docker apt keyring" install -m 0755 -d /etc/apt/keyrings
  run_root_quiet "Downloading Docker signing key" curl -fsSL "https://download.docker.com/linux/${repo_distro}/gpg" -o /etc/apt/keyrings/docker.asc
  run_root_quiet "Configuring Docker signing key" chmod a+r /etc/apt/keyrings/docker.asc
  codename="$DOCKER_OS_CODENAME"
  if [[ -z "$codename" ]] && command_exists lsb_release; then
    codename="$(lsb_release -cs 2>/dev/null || true)"
  fi
  [[ -n "$codename" ]] || die "Could not determine the distribution codename for Docker installation."
  arch="$(dpkg --print-architecture)"
  write_docker_apt_source "$repo_distro" "$codename" "$arch"
  DOCKER_APT_UPDATED=0
}

setup_docker_rpm_repository() {
  local repo_distro="$1"
  ensure_curl_for_docker
  if command_exists dnf; then
    install_docker_packages dnf-plugins-core
  else
    install_docker_packages yum-utils
  fi
  run_root_quiet "Configuring Docker package repository" curl -fsSL "https://download.docker.com/linux/${repo_distro}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
}

remove_conflicting_docker_packages() {
  local repo_family="$1"
  case "$repo_family" in
    ubuntu|debian)
      run_root_best_effort "Removing conflicting Docker packages" apt-get remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc
      DOCKER_APT_UPDATED=0
      ;;
    fedora|centos|rhel)
      if command_exists dnf; then
        run_root_best_effort "Removing conflicting Docker packages" dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc
      else
        run_root_best_effort "Removing conflicting Docker packages" yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc
      fi
      ;;
  esac
}

install_docker_engine() {
  local repo_family
  detect_docker_os
  repo_family="$(docker_repo_distro_family)"
  [[ -n "$repo_family" ]] || die "Automatic Docker installation is supported only on Debian, Ubuntu, Fedora, CentOS, and RHEL."

  info "Installing Docker Engine and Docker Compose v2 plugin"
  remove_conflicting_docker_packages "$repo_family"
  case "$repo_family" in
    ubuntu|debian)
      setup_docker_apt_repository "$repo_family"
      install_docker_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    fedora|centos|rhel)
      setup_docker_rpm_repository "$repo_family"
      install_docker_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
  esac
  ok "Docker Engine and Docker Compose v2 installed"
}

select_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  if command_exists sudo && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    return 0
  fi
  return 1
}

ensure_docker_running() {
  select_docker_command && return
  info "Starting Docker service"
  if command_exists systemctl; then
    run_root_quiet "Starting Docker service" systemctl enable --now docker
  elif command_exists rc-service; then
    command_exists rc-update && run_root_quiet "Enabling Docker service" rc-update add docker default
    run_root_quiet "Starting Docker service" rc-service docker start
  elif command_exists service; then
    run_root_quiet "Starting Docker service" service docker start
  else
    die "Docker is installed but no supported service manager was found. Start Docker, then run this installer again."
  fi

  local retries=5
  while [[ "$retries" -gt 0 ]]; do
    if select_docker_command; then
      ok "Docker service is running"
      return
    fi
    retries=$((retries - 1))
    sleep 2
  done
  die "Docker is installed but the daemon is not reachable. Check ${LOG_FILE} for details."
}

ensure_docker_available() {
  if ! command_exists docker; then
    guide_start "${GRAY}Preparing Docker Engine:${NC}"
    guide_blank
    info "Docker was not found on this host"
    ensure_curl_for_docker
    install_docker_engine
    guide_blank
  fi
  ensure_docker_running
}

json_string_field() {
  local file="$1" key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n1
}

json_number_field() {
  local file="$1" key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$file" | head -n1
}

decode_base64url() {
  local value="$1" output="$2"
  value="${value//-/+}"
  value="${value//_/\/}"
  case $((${#value} % 4)) in
    0) ;;
    2) value+="==" ;;
    3) value+="=" ;;
    *) return 1 ;;
  esac
  printf '%s' "$value" | openssl base64 -d -A >"$output"
}

verify_signed_release() {
  local version="$1"
  local tmp_dir manifest_file payload_file signature_file key_file
  local payload signature kind manifest_version tag image digest image_ref secure_connector_image_ref secure_connector_image secure_connector_digest

  tmp_dir="$(mktemp -d)"
  manifest_file="${tmp_dir}/opfield-image.update.json"
  payload_file="${tmp_dir}/payload.json"
  signature_file="${tmp_dir}/signature.bin"
  key_file="${tmp_dir}/update-signing-public-key.pem"

  info "Verifying signed release manifest for ${version}"
  # legacy-name: LEGACY_APP_IMAGE_MANIFEST_ASSET, the only name of the manifest of releases before 2.12.6 (a pinned
  # --version) — remove after every install runs v2.12.6
  if ! download_release_artifact opfield "$version" opfield-image.update.json "$manifest_file" &&
    ! download_release_artifact opfield "$version" "$LEGACY_APP_IMAGE_MANIFEST_ASSET" "$manifest_file"; then
    rm -rf "$tmp_dir"
    die "Could not download the signed release manifest. Check ${LOG_FILE} for details."
  fi

  payload="$(json_string_field "$manifest_file" payload)"
  signature="$(json_string_field "$manifest_file" signature)"
  if [[ -z "$payload" || -z "$signature" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest is malformed."
  fi
  if ! decode_base64url "$payload" "$payload_file" 2>>"$LOG_FILE" ||
    ! decode_base64url "$signature" "$signature_file" 2>>"$LOG_FILE"; then
    rm -rf "$tmp_dir"
    die "Signed release manifest contains invalid base64 data."
  fi
  printf '%s\n' "$UPDATE_SIGNING_PUBLIC_KEY" >"$key_file"
  if ! openssl pkeyutl -verify -rawin -pubin -inkey "$key_file" -in "$payload_file" -sigfile "$signature_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Signed release manifest signature verification failed."
  fi

  kind="$(json_string_field "$payload_file" kind)"
  manifest_version="$(json_string_field "$payload_file" version)"
  tag="$(json_string_field "$payload_file" tag)"
  image="$(json_string_field "$payload_file" image)"
  digest="$(json_string_field "$payload_file" digest)"
  image_ref="$(json_string_field "$payload_file" imageRef)"
  secure_connector_image_ref="$(json_string_field "$payload_file" secureLinkConnectorImage)"
  if [[ "$image" != "$IMAGE" ]] && official_image "$IMAGE" && official_image "$image"; then
    IMAGE="$image"
  fi
  if [[ "$kind" != "$LEGACY_APP_IMAGE_MANIFEST_KIND" || "$manifest_version" != "$version" || "$tag" != "$version" ||
    "$image" != "$IMAGE" || ! "$digest" =~ ^sha256:[a-f0-9]{64}$ || "$image_ref" != "${IMAGE}@${digest}" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest does not match the requested Opfield image."
  fi
  if [[ -n "$secure_connector_image_ref" ]]; then
    secure_connector_image="${IMAGE}/secure-link-connector"
    secure_connector_digest="${secure_connector_image_ref##*@}"
    if [[ "$secure_connector_image_ref" != "${secure_connector_image}@${secure_connector_digest}" || ! "$secure_connector_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      rm -rf "$tmp_dir"
      die "Signed release manifest contains an invalid secure-link connector image."
    fi
  fi
  rm -rf "$tmp_dir"

  IMAGE_REF="$image_ref"
  SECURE_LINK_CONNECTOR_IMAGE_REF="$secure_connector_image_ref"
  ok "Release ${version} verified (SHA-256: $(short_digest "$digest"))"
}

verify_signed_relay() {
  local relay_tag="$1"
  local tmp_dir manifest_file payload_file signature_file key_file
  local payload signature kind manifest_version tag image digest image_ref protocol_major min_opfield_version
  local secure_connector_image_ref secure_connector_image secure_connector_digest

  tmp_dir="$(mktemp -d)"
  manifest_file="${tmp_dir}/relay-image.update.json"
  payload_file="${tmp_dir}/payload.json"
  signature_file="${tmp_dir}/signature.bin"
  key_file="${tmp_dir}/update-signing-public-key.pem"

  info "Verifying signed relay manifest for ${relay_tag}"
  if ! download_release_artifact relay "$relay_tag" relay-image.update.json "$manifest_file"; then
    rm -rf "$tmp_dir"
    die "Could not download the signed relay manifest. Check ${LOG_FILE} for details."
  fi

  payload="$(json_string_field "$manifest_file" payload)"
  signature="$(json_string_field "$manifest_file" signature)"
  if [[ -z "$payload" || -z "$signature" ]] ||
    ! decode_base64url "$payload" "$payload_file" 2>>"$LOG_FILE" ||
    ! decode_base64url "$signature" "$signature_file" 2>>"$LOG_FILE"; then
    rm -rf "$tmp_dir"
    die "Signed relay manifest is malformed."
  fi
  printf '%s\n' "$UPDATE_SIGNING_PUBLIC_KEY" >"$key_file"
  if ! openssl pkeyutl -verify -rawin -pubin -inkey "$key_file" -in "$payload_file" -sigfile "$signature_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Signed relay manifest signature verification failed."
  fi

  kind="$(json_string_field "$payload_file" kind)"
  manifest_version="$(json_string_field "$payload_file" version)"
  tag="$(json_string_field "$payload_file" tag)"
  image="$(json_string_field "$payload_file" image)"
  digest="$(json_string_field "$payload_file" digest)"
  image_ref="$(json_string_field "$payload_file" imageRef)"
  protocol_major="$(json_number_field "$payload_file" protocolMajor)"
  min_opfield_version="$(json_string_field "$payload_file" "$LEGACY_MIN_VERSION_FIELD")"
  secure_connector_image_ref="$(json_string_field "$payload_file" secureLinkConnectorImage)"
  if [[ "$kind" != "relay-image" || "$tag" != "$relay_tag" || "$relay_tag" != "${manifest_version}-relay" ||
    ! "$manifest_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ || "$image" != "${IMAGE}/relay" ||
    ! "$digest" =~ ^sha256:[a-f0-9]{64}$ || "$image_ref" != "${IMAGE}/relay@${digest}" || "$protocol_major" != "1" ]]; then
    rm -rf "$tmp_dir"
    die "Signed relay manifest does not match a compatible Relay image."
  fi
  [[ -n "$min_opfield_version" ]] || min_opfield_version="$manifest_version"
  if [[ ! "$min_opfield_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || version_is_newer "$min_opfield_version" "$VERSION"; then
    rm -rf "$tmp_dir"
    die "Relay ${manifest_version} requires Opfield ${min_opfield_version} or newer."
  fi
  secure_connector_image="${IMAGE}/secure-link-connector"
  secure_connector_digest="${secure_connector_image_ref##*@}"
  if [[ "$secure_connector_image_ref" != "${secure_connector_image}@${secure_connector_digest}" ||
    ! "$secure_connector_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    rm -rf "$tmp_dir"
    die "Signed relay manifest contains an invalid secure-link connector image."
  fi
  rm -rf "$tmp_dir"

  RELAY_BUILD_VERSION="$manifest_version"
  RELAY_PROTOCOL_MAJOR="$protocol_major"
  RELAY_IMAGE_REF="$image_ref"
  SECURE_LINK_CONNECTOR_IMAGE_REF="$secure_connector_image_ref"
  RELAY_BOOTSTRAP=1
  ok "Relay ${manifest_version} verified (SHA-256: $(short_digest "$digest"))"
}

local_source_checksum() {
  (
    cd "$SOURCE_DIR"
    find . -type f \
      ! -path './.git/*' \
      ! -path './node_modules/*' \
      ! -path './.memory/*' \
      -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum
  ) | sha256sum | awk '{print $1}'
}

env_value() {
  local key="$1" env_file="${INSTALL_DIR}/.env"
  [[ -f "$env_file" ]] || return 0
  sed -n "s/^${key}=//p" "$env_file" | tail -n1
}

# The value of OPFIELD_<suffix> in .env.
# legacy-name: pre-2.12.1 names of a .env the foundation migrator has not rewritten yet (releases before 2.12.1).
setting_value() {
  local value
  value="$(env_value "OPFIELD_$1")"
  [[ -n "$value" ]] || value="$(env_value "${LEGACY_ENV_PREFIX}$1")"
  printf '%s' "$value"
}

# The .env key that holds setting <suffix>: the one the file has, or the current layout's name for a new one.
setting_key() {
  if ! grep -q "^OPFIELD_$1=" .env 2>/dev/null && grep -q "^${LEGACY_ENV_PREFIX}$1=" .env 2>/dev/null; then
    printf '%s%s' "$LEGACY_ENV_PREFIX" "$1" # legacy-name: kept until the foundation migrator renames it
  else
    printf '%s%s' "$ENV_PREFIX" "$1"
  fi
}

# Host Docker logging defaults. Opfield adds bounded json-file logs to its
# Compose services only when the daemon default is json-file and daemon.json
# sets no default max-size; another driver or a default max-size wins. Default
# log-opts without max-size (tag, labels, max-file) bound nothing.
DOCKER_LOG_DRIVER=""
DOCKER_LOG_OPTS=""
detect_docker_log_defaults() {
  local config="$DOCKER_DAEMON_CONFIG" compact
  DOCKER_LOG_DRIVER="$("${DOCKER[@]}" info --format '{{.LoggingDriver}}' 2>/dev/null | tr -d '[:space:]' || true)"
  DOCKER_LOG_OPTS=""
  [[ -n "$DOCKER_LOG_DRIVER" ]] || return 0
  if [[ ! -e "$config" ]]; then
    DOCKER_LOG_OPTS="none"
  elif compact="$(tr -d ' \t\r\n' <"$config" 2>/dev/null)"; then
    if [[ "$compact" == *'"log-opts":{'*'"max-size":"'?* ]]; then
      DOCKER_LOG_OPTS="set"
    else
      DOCKER_LOG_OPTS="none"
    fi
  fi
}

docker_bounded_logging_allowed() {
  [[ "$DOCKER_LOG_DRIVER" == "json-file" && "$DOCKER_LOG_OPTS" == "none" ]]
}

# Whether vX.Y.Z[-rc.N] version $1 is newer than $2, ordered like the Opfield backend: numerically,
# and a release candidate before its release. $1 in another format is never newer; $2 in another
# format is older than any release.
version_is_newer() {
  local pattern='^v?([0-9]+)\.([0-9]+)\.([0-9]+)(-rc\.([0-9]+))?$' index
  local -a candidate current
  [[ "$1" =~ $pattern ]] || return 1
  candidate=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[5]:-}")
  [[ "$2" =~ $pattern ]] || return 0
  current=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[5]:-}")
  for index in 0 1 2; do
    if ((10#${candidate[index]} != 10#${current[index]})); then
      ((10#${candidate[index]} > 10#${current[index]}))
      return
    fi
  done
  [[ -n "${current[3]}" ]] || return 1
  [[ -n "${candidate[3]}" ]] || return 0
  ((10#${candidate[3]} > 10#${current[3]}))
}

# Whether VERSION is a release before $1. A --source-dir build (local-*) is built from current source: never older.
release_predates() {
  [[ "$2" != local-* ]] && version_is_newer "$1" "$2"
}

prepare_install_metadata() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ "$FRESH" == 1 ]] || die "--source-dir is supported only for a fresh Opfield installation"
    [[ -d "$SOURCE_DIR" && -f "$SOURCE_DIR/Dockerfile" && -f "$SOURCE_DIR/package.json" ]] || \
      die "--source-dir must point to an Opfield source checkout"
    SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
    VERSION="local-$(date -u +%Y%m%d%H%M%S)"
    if [[ -n "$RESTORE_FILE" ]]; then
      # A source build restores only an export of a source build: it takes that build's version.
      [[ "$RESTORE_VERSION" == local-* ]] ||
        die "This export was made by Opfield ${RESTORE_VERSION}; restore it without --source-dir"
      VERSION="$RESTORE_VERSION"
    fi
    IMAGE_REF="${IMAGE}:${VERSION}"
    ARTIFACT_DIGEST="$(local_source_checksum)"
    [[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || die "Could not calculate the local source checksum"
    ARTIFACT_KIND="local source checksum"
    SECURE_LINK_CONNECTOR_IMAGE_REF=""
    RELAY_BUILD_VERSION="$VERSION"
    RELAY_PROTOCOL_MAJOR=1
    RELAY_IMAGE_REF="${IMAGE}/relay:${VERSION}"
    return
  fi

  local release_json relay_json relay_tag relay_version current_opfield_version current_relay_version
  if [[ -n "$PIN_VERSION" ]]; then
    # An exact release, only for a fresh install: updates of an installation go through Opfield itself.
    [[ "$FRESH" == 1 ]] || die "--version installs a fresh Opfield only; ${INSTALL_DIR} has an installation already"
    VERSION="$PIN_VERSION"
    info "Version: ${VERSION} (--version)"
    verify_signed_release "$VERSION"
  elif [[ -n "$RESTORE_FILE" ]]; then
    # An export restores into the exact Opfield version that made it.
    [[ "$RESTORE_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] ||
      die "This export was made by a development build (${RESTORE_VERSION}); restore it with --source-dir and the same source"
    VERSION="$RESTORE_VERSION"
    info "Version: ${VERSION} (the version that made the export)"
    verify_signed_release "$VERSION"
  else
    info "Resolving the latest Opfield release"
    # The installer and the updater record the running version; older installs only carry it in a
    # tagged image reference. A release candidate stays installed until its stable release exists.
    current_opfield_version="$(setting_value VERSION)"
    if [[ -z "$current_opfield_version" ]]; then
      current_opfield_version="$(setting_value IMAGE_REF)"
      current_opfield_version="${current_opfield_version##*:}"
    fi
    [[ "$current_opfield_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || current_opfield_version=""
    release_json="$(fetch_release opfield "$current_opfield_version")" || die "Unable to query Opfield releases"
    if [[ -z "$release_json" && -n "$current_opfield_version" ]]; then
      VERSION="$current_opfield_version"
    else
      VERSION="$(
        printf '%s' "$release_json" |
          grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' |
          sed -E 's/^.*"([^"]+)"$/\1/' |
          grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' |
          sort -V |
          tail -n1 || true
      )"
    fi
    [[ -n "$VERSION" ]] || die "The release API did not return an eligible Opfield release"
    info "Version: ${VERSION}"
    verify_signed_release "$VERSION"
  fi
  current_relay_version="$(setting_value RELAY_BUILD_VERSION)"
  if [[ "$FRESH" == 1 || -z "$(setting_value RELAY_IMAGE_REF)" || -z "$current_relay_version" ]]; then
    if [[ -n "$PIN_VERSION" ]]; then
      relay_tag="$(pinned_relay_tag "$VERSION")" || die "Unable to query Relay releases"
    else
      relay_json="$(fetch_release relay "$current_relay_version")" || die "Unable to query Relay releases"
      if [[ -z "$relay_json" && -n "$current_relay_version" ]]; then
        relay_tag="${current_relay_version}-relay"
      else
        relay_tag="$(
          printf '%s' "$relay_json" |
            grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' |
            sed -E 's/^.*"([^"]+)"$/\1/' |
            grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+-relay$' |
            sort -V |
            tail -n1 || true
        )"
      fi
    fi
    [[ -n "$relay_tag" ]] || die "The release API did not return an eligible Relay release"
    relay_version="${relay_tag%-relay}"
    if [[ "$FRESH" == 1 || -z "$current_relay_version" ]] || version_is_newer "$relay_version" "$current_relay_version"; then
      verify_signed_relay "$relay_tag"
    fi
  fi
  ARTIFACT_DIGEST="${IMAGE_REF##*@sha256:}"
  ARTIFACT_KIND="signed image digest"
}

print_install_details() {
  selector_title "Installation details:"
  guide "  ${GRAY}Release:${NC}         ${VERSION}"
  guide "  ${GRAY}${ARTIFACT_KIND}:${NC} $(short_digest "$ARTIFACT_DIGEST")"
  guide "  ${GRAY}Target path:${NC}     ${INSTALL_DIR}"
  guide "  ${GRAY}Mode:${NC}            $([[ "$FRESH" == 1 ]] && echo 'fresh install' || echo 'update')$([[ "$RESUME" == 1 ]] && echo ' (resumed)')"
  guide_blank
}

read_export_version() {
  local header_file magic
  magic="$(head -c 17 "$RESTORE_FILE" 2>/dev/null | LC_ALL=C tr -d '\n')" || magic=""
  [[ "$magic" == "OPFIELD-EXPORT/1" ]] || die "${RESTORE_FILE} is not an Opfield configuration export"
  header_file="$(mktemp)"
  head -c 65536 "$RESTORE_FILE" | LC_ALL=C sed -n '2p' >"$header_file"
  RESTORE_VERSION="$(json_string_field "$header_file" opfieldVersion)"
  # legacy-name: the version field of the header of an export made before 2.12.1.
  [[ -n "$RESTORE_VERSION" ]] || RESTORE_VERSION="$(json_string_field "$header_file" "$LEGACY_EXPORT_VERSION_FIELD")"
  rm -f "$header_file"
  [[ "$RESTORE_VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || die "The header of ${RESTORE_FILE} is invalid"
}

read_restore_passphrase() {
  if [[ -n "${OPFIELD_RESTORE_PASSPHRASE:-}" ]]; then
    RESTORE_PASSPHRASE="$OPFIELD_RESTORE_PASSPHRASE"
    return
  fi
  tty_usable || die "Set OPFIELD_RESTORE_PASSPHRASE to restore without a terminal"
  printf '%b' "${BRAND_MINT}│${NC} Export passphrase: " >/dev/tty
  IFS= read -rs RESTORE_PASSPHRASE </dev/tty || RESTORE_PASSPHRASE=""
  printf '\n' >/dev/tty
  [[ -n "$RESTORE_PASSPHRASE" ]] || die "No passphrase entered"
}

prompt_restore_address() {
  local addresses
  [[ -z "$RESTORE_PUBLIC_URL" && -z "$RESTORE_GRPC_TARGET" ]] || return 0
  tty_usable || return 0
  addresses="$(detect_local_host_addresses)"
  guide "${GRAY}This host's address. Press Enter to keep the address the export was made with.${NC}"
  [[ -z "$addresses" ]] || guide "${GRAY}Addresses of this host: ${addresses}${NC}"
  printf '%b' "${BRAND_MINT}│${NC} Public URL (https://opfield.example.com): " >/dev/tty
  IFS= read -r RESTORE_PUBLIC_URL </dev/tty || RESTORE_PUBLIC_URL=""
  printf '%b' "${BRAND_MINT}│${NC} gRPC address nodes connect to (host:9443): " >/dev/tty
  IFS= read -r RESTORE_GRPC_TARGET </dev/tty || RESTORE_GRPC_TARGET=""
}

restore_result_field() {
  printf '%s' "$1" | tail -n1 | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

run_restore() {
  local project postgres_id pass_file attempt result status message
  local -a args=()
  info "Starting the database for the restore"
  run_quiet "Database startup" "${DOCKER[@]}" compose up -d postgres redis
  for _ in $(seq 1 60); do
    "${DOCKER[@]}" compose exec -T postgres pg_isready -U "$DB_ROLE" -d "$DB_NAME" </dev/null >/dev/null 2>&1 && break
    sleep 2
  done
  postgres_id="$("${DOCKER[@]}" compose ps -q postgres)"
  [[ -n "$postgres_id" ]] || die "The database did not start. Check ${LOG_FILE} for details."
  project="$("${DOCKER[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$postgres_id")"
  [[ -n "$project" ]] || die "Cannot determine the Compose project name"
  prompt_restore_address
  [[ -z "$RESTORE_PUBLIC_URL" ]] || args+=(--public-url "$RESTORE_PUBLIC_URL")
  [[ -z "$RESTORE_GRPC_TARGET" ]] || args+=(--grpc-target "$RESTORE_GRPC_TARGET")
  # A restore that stopped halfway left this fresh directory configured; it may be replaced.
  [[ "$RESUME" != 1 ]] || args+=(--replace-existing)
  for attempt in 1 2 3; do
    read_restore_passphrase
    pass_file="$(mktemp)"
    chmod 600 "$pass_file"
    printf '%s' "$RESTORE_PASSPHRASE" >"$pass_file"
    RESTORE_PASSPHRASE=""
    info "Checking and restoring the export (the whole file is checked before anything changes)"
    set +e
    result="$("${DOCKER[@]}" run --rm --network none \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$INSTALL_DIR:/host" \
      -v "$RESTORE_FILE:/restore/export.opfield-export:ro" \
      -v "$pass_file:/restore/passphrase:ro" \
      "$IMAGE_REF" node dist/cli/configuration-restore.js restore /restore/export.opfield-export \
      --passphrase-file /restore/passphrase --host-dir /host --host-path "$INSTALL_DIR" --project "$project" \
      ${args[@]+"${args[@]}"} </dev/null 2>>"$LOG_FILE")"
    status=$?
    set -e
    rm -f "$pass_file"
    printf '%s\n' "$result" >>"$LOG_FILE"
    message="$(restore_result_field "$result" message)"
    case "$status" in
      0) break ;;
      2)
        if [[ -z "${OPFIELD_RESTORE_PASSPHRASE:-}" && "$attempt" -lt 3 ]]; then
          warn "The passphrase does not open this export. Try again."
          continue
        fi
        die "The passphrase does not open this export"
        ;;
      3) die "${message:-The export file is damaged or incomplete}" ;;
      4) die "${message:-The export was made by another Opfield version}" ;;
      *) die "Restore failed: ${message:-unknown error}. Check ${LOG_FILE} for details." ;;
    esac
  done
  RESTORED_PUBLIC_URL="${RESTORE_PUBLIC_URL:-$(restore_result_field "$result" sourcePublicUrl)}"
  RESTORED_OWNER_SIGN_IN="$(restore_result_field "$result" ownerSignIn)"
  ok "Export restored"
}

# A plain DNS name a public CA issues for: no wildcard, IP address, port or trailing dot.
valid_console_domain() {
  local domain="$1"
  [[ ${#domain} -le 253 && "$domain" == *.* && ! "$domain" =~ ^[0-9.]+$ ]] || return 1
  [[ "$domain" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]
}

validate_console_options() {
  if [[ -n "$CONSOLE_DOMAIN" ]]; then
    CONSOLE_DOMAIN="$(printf '%s' "${CONSOLE_DOMAIN%.}" | tr '[:upper:]' '[:lower:]')"
    valid_console_domain "$CONSOLE_DOMAIN" || die "--domain must be a DNS name such as console.example.com, got: ${CONSOLE_DOMAIN}"
    [[ -n "$ACME_EMAIL" ]] || die "--domain needs --acme-email for the Let's Encrypt account"
  fi
  if [[ -n "$ACME_EMAIL" ]]; then
    [[ -n "$CONSOLE_DOMAIN" ]] || die "--acme-email is used with --domain"
    [[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "--acme-email must be an email address, got: ${ACME_EMAIL}"
  fi
}

# Publishes the console listeners (HTTPS 443 and HTTP 80, which answers ACME challenges and redirects to HTTPS) on
# the app service next to its 3000 mapping. Runs on fresh and existing Compose files; does nothing when present.
add_console_ports() {
  local compose="$1" output
  grep -Eq '^[[:space:]]*-[[:space:]]*"?443:3443"?[[:space:]]*$' "$compose" && return 0
  output="$(mktemp "${compose}.XXXXXX")"
  awk '
    /^  app:[[:space:]]*$/ { in_app = 1; print; next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_app = 0 }
    in_app && !done && /^    ports:[[:space:]]*$/ {
      print
      print "      - \"80:3080\""
      print "      - \"443:3443\""
      done = 1
      next
    }
    { print }
    END { if (!done) exit 3 }
  ' "$compose" >"$output" || { rm -f "$output"; return 1; }
  cat "$output" >"$compose"
  rm -f "$output"
}

# Whether the installation in INSTALL_DIR still has (part of) the layout of the releases before 2.12.1, and the release
# this run installs moves it (foundation/host-move.ts in the app image).
installation_needs_host_move() {
  [[ "$LEGACY_LAYOUT" == 0 && "$FRESH" == 0 && -f "$INSTALL_DIR/docker-compose.yml" ]] || return 1
  ! version_is_newer "$FIRST_OPFIELD_LAYOUT_VERSION" "$VERSION" || return 1
  [[ "$(basename "$INSTALL_DIR")" != "$(basename "$LEGACY_INSTALL_DIR")" ]] || return 0
  grep -Eq '^name:[[:space:]]*["'"'"']?opfield["'"'"']?[[:space:]]*$' "$INSTALL_DIR/docker-compose.yml" || return 0
  [[ "$DB_NAME" == opfield ]] || return 0
  return 1
}

# Where the host move puts the installation: a sibling `opfield` of the legacy directory, otherwise where it is.
host_move_target_dir() {
  if [[ "$(basename "$INSTALL_DIR")" == "$(basename "$LEGACY_INSTALL_DIR")" && ! -e "$(dirname "$INSTALL_DIR")/opfield" ]]; then
    printf '%s/opfield' "$(dirname "$INSTALL_DIR")"
  else
    printf '%s' "$INSTALL_DIR"
  fi
}

# Moves an updated installation to the Opfield layout: the same container the app starts once an update settled; its
# name makes sure only one runs. Docker restarts it after a crash or reboot, and it resumes where it stopped.
run_host_move() {
  local app_id project network parent target status state
  installation_needs_host_move || return 0
  app_id="$("${DOCKER[@]}" compose ps -q app)"
  [[ -n "$app_id" ]] || { warn "Opfield is not running, so it stays in ${INSTALL_DIR} for now"; return 0; }
  project="$("${DOCKER[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$app_id")"
  network="$("${DOCKER[@]}" inspect --format '{{.HostConfig.NetworkMode}}' "$app_id")"
  target="$(host_move_target_dir)"
  parent="$(dirname "$INSTALL_DIR")"
  info "Moving Opfield to ${target}: Opfield and Secure Links through this host stop for about a minute"
  state="$("${DOCKER[@]}" inspect --format '{{.State.Status}}' "$HOST_MOVE_CONTAINER" 2>/dev/null || true)"
  if [[ "$state" != running && "$state" != restarting ]]; then
    "${DOCKER[@]}" rm -f "$HOST_MOVE_CONTAINER" >>"$LOG_FILE" 2>&1 || true
    run_quiet "Host move start" "${DOCKER[@]}" run -d --name "$HOST_MOVE_CONTAINER" \
      --label net.opfield.role=opfield-host-move --restart unless-stopped --network none --no-healthcheck \
      -v /var/run/docker.sock:/var/run/docker.sock -v "${parent}:${parent}" \
      -v /var/lib/opfield/sandbox-workspaces:/var/lib/opfield/sandbox-workspaces \
      "$IMAGE_REF" node dist/cli/host-move.js --dir "$INSTALL_DIR" --project "$project" --network "$network" --retry
  fi
  while :; do
    status="$("${DOCKER[@]}" wait "$HOST_MOVE_CONTAINER" 2>>"$LOG_FILE" | tail -n1 || true)"
    sleep 3
    # A run that stopped early is restarted by Docker and resumes the move.
    state="$("${DOCKER[@]}" inspect --format '{{.State.Status}}' "$HOST_MOVE_CONTAINER" 2>/dev/null || true)"
    [[ "$state" == running || "$state" == restarting ]] || break
  done
  "${DOCKER[@]}" logs "$HOST_MOVE_CONTAINER" >>"$LOG_FILE" 2>&1 || true
  case "$status" in
    0)
      INSTALL_DIR="$target"
      cd "$INSTALL_DIR"
      ok "Opfield moved to ${INSTALL_DIR}"
      ;;
    3) warn "The move to ${target} did not finish and was undone; Opfield runs from ${INSTALL_DIR} as before. Check ${LOG_FILE}" ;;
    *) die "The move to ${target} stopped (exit ${status:-unknown}). See: docker logs ${HOST_MOVE_CONTAINER}" ;;
  esac
}

usage() {
  cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--image IMAGE] [--source-dir PATH] [--http|--https]
                  [--domain FQDN --acme-email EMAIL] [--version VERSION] [--dry-run]
       install.sh --restore FILE [--public-url URL] [--grpc-target HOST:PORT] [--install-dir PATH]

Installs or updates Opfield in /opt/opfield (or --install-dir). An update
finds an installation made before 2.12.1 in the earlier directory and, once the new
release runs, moves it to /opt/opfield. On a fresh interactive install, the
only prompt selects native HTTPS or HTTP for port 3000. Non-interactive
installs default to native HTTPS. All product configuration continues in the
browser wizard.

--restore installs the Opfield version that made a configuration export into a
fresh directory and restores the export into it. It asks for the export's
passphrase (or reads OPFIELD_RESTORE_PASSPHRASE) and for this host's address;
--public-url and --grpc-target set the address without asking. Without them
the exported address is kept.

--domain serves the console at https://FQDN on port 443 with a Let's Encrypt
certificate that Opfield obtains (HTTP-01 on port 80) and renews by itself;
port 80 otherwise redirects to HTTPS and port 3000 keeps working as before.
Until FQDN points at this host the console on 443 uses the System CA
certificate. The public URL becomes https://FQDN. --acme-email is the
Let's Encrypt account contact and is required with --domain.

--version VERSION installs exactly that Opfield release (for example
v2.12.1 or a release candidate such as v2.12.1-rc.5) on a fresh host, with the
relay of that release (or the newest relay of its line). Off by default:
without it the installer takes the newest stable release. Release candidates
are for testing; an installation updates from there through Opfield. Also
read from OPFIELD_INSTALL_VERSION.

--source-dir builds the Opfield image from a local source checkout on this
host. It is intended for a fresh test installation and skips remote release
discovery and image pulls.

--dry-run renders the interactive flow and planned installation without
creating files, building or pulling images, or starting services.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?missing path}"; shift 2 ;;
    --image) IMAGE="${2:?missing image}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing path}"; shift 2 ;;
    --http) TRANSPORT="http"; shift ;;
    --https) TRANSPORT="https"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --restore) RESTORE_FILE="${2:?missing export file}"; shift 2 ;;
    --version) PIN_VERSION="${2:?missing version}"; shift 2 ;;
    --public-url) RESTORE_PUBLIC_URL="${2:?missing URL}"; shift 2 ;;
    --grpc-target) RESTORE_GRPC_TARGET="${2:?missing host:port}"; shift 2 ;;
    --domain) CONSOLE_DOMAIN="${2:?missing domain}"; shift 2 ;;
    --acme-email) ACME_EMAIL="${2:?missing email}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
validate_console_options
if [[ -n "$PIN_VERSION" ]]; then
  [[ "$PIN_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] ||
    die "--version takes a release such as v2.12.1 or v2.12.1-rc.5, not ${PIN_VERSION}"
  PIN_VERSION="v${PIN_VERSION#v}"
  [[ -z "$RESTORE_FILE" ]] || die "--version and --restore cannot be combined: a restore installs the version that made the export"
  [[ -z "$SOURCE_DIR" ]] || die "--version and --source-dir cannot be combined: a source build has its own version"
fi

# Without --install-dir: /opt/opfield, or an installation made before 2.12.1 that has not moved yet.
INSTALL_DIR_DEFAULTED=0
if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR_DEFAULTED=1
  INSTALL_DIR="$DEFAULT_INSTALL_DIR"
  if [[ ! -f "$DEFAULT_INSTALL_DIR/.env" && -f "$LEGACY_INSTALL_DIR/.env" && ! -L "$LEGACY_INSTALL_DIR" ]]; then
    INSTALL_DIR="$LEGACY_INSTALL_DIR" # legacy-name: see LEGACY_INSTALL_DIR
  fi
fi

show_header

RESTORED_PUBLIC_URL=""
RESTORED_OWNER_SIGN_IN=""
if [[ -n "$RESTORE_FILE" ]]; then
  [[ -f "$RESTORE_FILE" && -r "$RESTORE_FILE" ]] || die "Cannot read the export file ${RESTORE_FILE}"
  RESTORE_FILE="$(cd "$(dirname "$RESTORE_FILE")" && pwd)/$(basename "$RESTORE_FILE")"
  read_export_version
fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  umask 077
  : >"$LOG_FILE" 2>/dev/null || die "Unable to create installer log at ${LOG_FILE}"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
  ensure_docker_available
  command_exists curl || die "curl is required"
  command_exists openssl || die "openssl is required"
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

  if [[ ! -d "$INSTALL_DIR" ]]; then
    if mkdir -p "$INSTALL_DIR" 2>/dev/null; then :; else sudo mkdir -p "$INSTALL_DIR"; sudo chown "$(id -u):$(id -g)" "$INSTALL_DIR"; fi
  fi
  cd "$INSTALL_DIR"
  INSTALL_DIR="$(pwd)"
fi
# legacy-name: a pending marker of a release before 2.12.1 counts as well.
if [[ -f "$INSTALL_DIR/$LEGACY_INSTALL_PENDING_MARKER" && ! -f "$INSTALL_DIR/$INSTALL_PENDING_MARKER" ]]; then
  INSTALL_PENDING_MARKER="$LEGACY_INSTALL_PENDING_MARKER"
fi
FRESH=1
[[ -f "$INSTALL_DIR/.env" && ! -f "$INSTALL_DIR/$INSTALL_PENDING_MARKER" ]] && FRESH=0
# A fresh install that stopped before showing its setup code keeps its .env: the secrets in it may
# already be bound to the database volume.
RESUME=0
[[ "$FRESH" == 1 && -f "$INSTALL_DIR/.env" ]] && RESUME=1
[[ -z "$RESTORE_FILE" || "$FRESH" == 1 ]] ||
  die "--restore needs a fresh installation directory; ${INSTALL_DIR} already holds an Opfield installation"

if [[ "$DRY_RUN" -eq 1 ]]; then
  command -v curl >/dev/null || die "curl is required to inspect the release in dry-run mode"
  command -v openssl >/dev/null || die "openssl is required to verify the release in dry-run mode"
  DRY_RUN_LOG="$(mktemp)"
  LOG_FILE="$DRY_RUN_LOG"
else
  umask 077
  : >"$LOG_FILE" 2>/dev/null || die "Unable to create installer log at ${LOG_FILE}"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
fi

guide_start "${GRAY}Preparing Opfield installation:${NC}"
guide_blank
prepare_install_metadata
guide_blank
print_install_details

# A re-run without --domain keeps the console domain the installation already has.
if [[ -z "$CONSOLE_DOMAIN" ]]; then
  CONSOLE_DOMAIN="$(setting_value CONSOLE_DOMAIN)"
fi

# The layout of what this run writes: a fresh install of a release before 2.12.1 (only --restore installs one) gets the
# layout that release knows; everything else gets the Opfield layout, an existing installation through its host move.
LEGACY_LAYOUT=0
if [[ "$FRESH" == 1 ]] && release_predates "$FIRST_OPFIELD_LAYOUT_VERSION" "$VERSION"; then
  LEGACY_LAYOUT=1
  ENV_PREFIX="$LEGACY_ENV_PREFIX" # legacy-name: the settings names of the release this run installs
fi
DB_ROLE="opfield"
DB_NAME="opfield"
if [[ "$LEGACY_LAYOUT" == 1 ]]; then
  # legacy-name: database and role of the releases before 2.12.1
  DB_ROLE="$LEGACY_DATABASE"
  DB_NAME="$LEGACY_DATABASE"
elif [[ "$FRESH" == 0 && -f "$INSTALL_DIR/docker-compose.yml" ]] &&
  grep -Eq "DATABASE_URL[:=][[:space:]]*\"?postgres(ql)?://${LEGACY_DATABASE}:" "$INSTALL_DIR/docker-compose.yml"; then
  DB_ROLE="$LEGACY_DATABASE" # legacy-name: an installation that has not moved yet
  DB_NAME="$LEGACY_DATABASE"
fi
if [[ "$RESUME" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="$(env_value WEB_TLS_BOOTSTRAP_MODE)"
fi
if [[ "$FRESH" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="https"
  # A restore brings the web transport setting along with the database.
  if [[ -z "$RESTORE_FILE" ]] && tty_usable; then
    guide "${GRAY}Opfield can serve port 3000 with its own System CA certificate.${NC}"
    selector_title "Web transport:"
    transport_choice=$(prompt_menu "1" "Internal HTTPS  — use Opfield System CA on :3000" "HTTP            — configure TLS in a reverse proxy later")
    case "$transport_choice" in
      1) TRANSPORT="https" ;;
      2) TRANSPORT="http" ;;
      *) TRANSPORT="https" ;;
    esac
    guide "${GRAY}Selected: ${NC}${TRANSPORT}"
  fi
fi
[[ "$TRANSPORT" == "http" || "$TRANSPORT" == "https" || "$FRESH" == 0 ]] || die "OPFIELD_WEB_TRANSPORT must be http or https"
if [[ "$FRESH" == 1 && -z "$RESTORE_FILE" ]]; then
  if [[ -n "$CONSOLE_DOMAIN" ]]; then
    guide_blank
    guide "${GRAY}https://${CONSOLE_DOMAIN} gets a Let's Encrypt certificate once the name points at this host${NC}"
    guide "${GRAY}and ports 80 and 443 are reachable; until then it uses the System CA certificate.${NC}"
  elif [[ "$TRANSPORT" == "https" ]]; then
    guide_blank
    warn "Your browser will show a certificate warning on first visit."
    warn "This is expected until the Opfield System CA is trusted."
  else
    guide_blank
  fi
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry run: would validate Docker and prepare Opfield services in ${INSTALL_DIR}"
  info "Dry run: would start Opfield with ${TRANSPORT} on port 3000"
  if [[ "$FRESH" == 0 ]] && installation_needs_host_move; then
    info "Dry run: would then move the installation to $(host_move_target_dir) (Opfield and Secure Links stop for about a minute)"
  fi
  [[ -z "$CONSOLE_DOMAIN" ]] || info "Dry run: would serve https://${CONSOLE_DOMAIN} on ports 443 and 80 with a Let's Encrypt certificate"
  rm -f "$DRY_RUN_LOG"
  guide_blank
  echo -e "${BRAND_MINT}■${NC} ${BOLD}Dry run completed successfully — no host changes were made.${NC}"
  echo ""
  exit 0
fi

if [[ -n "$SOURCE_DIR" ]]; then
  info "Building Opfield from local source: ${SOURCE_DIR}"
  run_quiet "Opfield image build" "${DOCKER[@]}" build --build-arg "APP_VERSION=${VERSION}" --tag "$IMAGE_REF" "$SOURCE_DIR"
  run_quiet "Relay image build" "${DOCKER[@]}" build -f "$SOURCE_DIR/packages/relay/Dockerfile" --build-arg "RELAY_BUILD_VERSION=${VERSION}" --tag "$RELAY_IMAGE_REF" "$SOURCE_DIR"
fi

ensure_env() {
  local key="$1" value="$2"
  grep -q "^${key}=" .env 2>/dev/null || printf '%s=%s\n' "$key" "$value" >>.env
}

# Adds setting <suffix> unless .env has it under either name.
ensure_setting() {
  set_or_keep_setting "$1" "$2" keep
}

# Sets setting <suffix> under the name .env already uses (see setting_key).
set_setting() {
  set_or_keep_setting "$1" "$2" set
}

set_or_keep_setting() {
  local key
  key="$(setting_key "$1")"
  if [[ "$3" == keep ]]; then
    ensure_env "$key" "$2"
  else
    set_env "$key" "$2"
  fi
}

set_env() {
  local key="$1" value="$2" output
  output="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { if (!done) { print key "=" value; done=1 } next }
    { print }
    END { if (!done) print key "=" value }
  ' .env >"$output"
  mv "$output" .env
}

detect_local_host_address_lines() {
  if command -v ip >/dev/null; then
    ip -o addr show up scope global 2>/dev/null | awk '
      {
        interface = $2
        sub(/@.*/, "", interface)
      }
      interface == "lo" ||
      interface ~ /^docker/ ||
      interface ~ /^br-/ ||
      interface ~ /^veth/ ||
      interface ~ /^virbr/ ||
      interface ~ /^podman/ ||
      interface ~ /^cni/ ||
      interface ~ /^flannel/ ||
      interface ~ /^cali/ ||
      interface ~ /^kube/ ||
      interface ~ /^tailscale/ ||
      interface ~ /^zt/ ||
      interface ~ /^lxc/ ||
      interface ~ /^incus/ ||
      interface ~ /^vboxnet/ ||
      interface ~ /^vmnet/ { next }
      $3 == "inet" { sub(/\/.*/, "", $4); if ($4 !~ /^127\./) print $4; next }
      $3 == "inet6" {
        sub(/\/.*/, "", $4)
        address = tolower($4)
        if (address != "::1" && address !~ /^fe80:/) print $4
      }
    ' | awk '!seen[$0]++'
  fi
}

detect_local_host_addresses() {
  detect_local_host_address_lines | paste -sd, -
}

format_opfield_url() {
  local address="$1"
  if [[ "$address" == *:* ]]; then
    printf '%s://[%s]:3000' "$TRANSPORT" "$address"
  else
    printf '%s://%s:3000' "$TRANSPORT" "$address"
  fi
}

print_opfield_urls() {
  local address
  guide "${BRAND_MINT}Open:${NC}"
  [[ -z "$CONSOLE_DOMAIN" ]] || guide "  ${GRAY}Console:${NC} https://${CONSOLE_DOMAIN}"
  guide "  ${GRAY}Local:${NC}   ${TRANSPORT}://localhost:3000"
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    guide "  ${GRAY}Network:${NC} $(format_opfield_url "$address")"
  done < <(detect_local_host_address_lines)
}

REGISTRY_IMAGE_REF="$(setting_value REGISTRY_IMAGE_REF)"
if [[ "$FRESH" == 1 || -z "$REGISTRY_IMAGE_REF" ]]; then
  info "Pulling the pinned registry image"
  REGISTRY_IMAGE_REF="$(pull_third_party_image "$REGISTRY_UPSTREAM_IMAGE_REF")" ||
    die "Registry image pull failed. Check ${LOG_FILE} for details."
fi
if [[ "$FRESH" == 1 ]]; then
  info "Pulling the pinned PostgreSQL and Redis images"
  POSTGRES_IMAGE_REF="$(pull_third_party_image "$POSTGRES_UPSTREAM_IMAGE_REF")" ||
    die "PostgreSQL image pull failed. Check ${LOG_FILE} for details."
  REDIS_IMAGE_REF="$(pull_third_party_image "$REDIS_UPSTREAM_IMAGE_REF")" ||
    die "Redis image pull failed. Check ${LOG_FILE} for details."
fi

if [[ "$FRESH" == 1 ]]; then
  umask 077
  : >"$INSTALL_PENDING_MARKER"
  [[ "$RESUME" == 1 ]] || : >.env
fi
ensure_setting IMAGE_REF "$IMAGE_REF"
if [[ -n "${SECURE_LINK_CONNECTOR_IMAGE_REF:-}" ]]; then
  set_env SECURE_LINK_CONNECTOR_IMAGE "$SECURE_LINK_CONNECTOR_IMAGE_REF"
fi
ensure_env DB_PASSWORD "$(openssl rand -hex 24)"
ensure_env PKI_MASTER_KEY "$(openssl rand -hex 32)"
ensure_env SETUP_BOOTSTRAP "$([[ "$FRESH" == 1 && -z "$RESTORE_FILE" ]] && printf true || printf false)"
ensure_env WEB_TLS_BOOTSTRAP_MODE "${TRANSPORT:-http}"
if [[ "$LEGACY_LAYOUT" == 1 ]]; then
  ensure_env SANDBOX_RUNNER_WORKSPACE_DIR "${LEGACY_APP_DATA_DIR}/sandbox-workspaces" # legacy-name: see LEGACY_LAYOUT
else
  ensure_env SANDBOX_RUNNER_WORKSPACE_DIR "/var/lib/opfield/sandbox-workspaces"
fi
set_setting REGISTRY_IMAGE_REF "$REGISTRY_IMAGE_REF"
ensure_setting REGISTRY_HTTP_SECRET "$(openssl rand -hex 32)"
ensure_setting RELAY_MANAGED "$([[ -z "$SOURCE_DIR" ]] && printf true || printf false)"
if [[ -n "$ACME_EMAIL" ]]; then
  set_setting CONSOLE_DOMAIN "$CONSOLE_DOMAIN"
  set_setting ACME_EMAIL "$ACME_EMAIL"
fi
if [[ "$FRESH" == 1 ]]; then
  set_setting VERSION "$VERSION"
  set_setting RELAY_IMAGE_REF "$RELAY_IMAGE_REF"
  set_setting RELAY_BUILD_VERSION "$RELAY_BUILD_VERSION"
  set_setting RELAY_PROTOCOL_MAJOR "$RELAY_PROTOCOL_MAJOR"
  set_setting POSTGRES_IMAGE_REF "$POSTGRES_IMAGE_REF"
  set_setting REDIS_IMAGE_REF "$REDIS_IMAGE_REF"
fi
local_host_addresses="$(detect_local_host_addresses)"
if [[ -n "$local_host_addresses" ]]; then
  set_setting LOCAL_HOSTS "$local_host_addresses"
else
  ensure_setting LOCAL_HOSTS ""
fi
chmod 600 .env

# Always advance the managed image reference to the latest release.
set_setting IMAGE_REF "$IMAGE_REF"
chmod 600 .env

write_opfield_compose() {
  cat >docker-compose.yml <<'COMPOSE'
name: opfield
services:
  app:
    image: ${OPFIELD_IMAGE_REF}
    restart: unless-stopped
    stop_grace_period: 60s
    labels:
      net.opfield.managed-service: app
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://opfield:${DB_PASSWORD}@postgres:5432/opfield
      REDIS_URL: redis://redis:6379
      PKI_MASTER_KEY: ${PKI_MASTER_KEY}
      WEB_TLS_AUTO_DIR: /var/lib/opfield/tls
      GRPC_TLS_AUTO_DIR: /var/lib/opfield/tls
      OPFIELD_RELAY_REQUIRED: "true"
      OPFIELD_RELAY_MANAGED: "${OPFIELD_RELAY_MANAGED:-true}"
      OPFIELD_RELAY_TARGET: relay:9443
      OPFIELD_RELAY_IDENTITY_DIR: /var/lib/opfield-relay
      OPFIELD_RELAY_IMAGE_REF: ${OPFIELD_RELAY_IMAGE_REF}
      OPFIELD_RELAY_SERVICE_NAME: relay
      OPFIELD_RELAY_BUILD_VERSION: ${OPFIELD_RELAY_BUILD_VERSION}
      OPFIELD_RELAY_PROTOCOL_MAJOR: ${OPFIELD_RELAY_PROTOCOL_MAJOR}
      OPFIELD_REGISTRY_AUTH_DIR: /var/lib/opfield-registry-auth
      OPFIELD_REGISTRY_TOKEN_SERVICE: opfield-internal-registry
      SANDBOX_RUNNER_WORKSPACE_DIR: ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/opfield/sandbox-workspaces}
    ports:
      - "3000:3000"
    expose:
      - "9443"
    volumes:
      - app_data:/var/lib/opfield
      - relay_identity:/var/lib/opfield-relay
      - registry_auth:/var/lib/opfield-registry-auth
      - ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/opfield/sandbox-workspaces}:${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/opfield/sandbox-workspaces}
      # Intentional host trust boundary: required for signed self-update,
      # recovery, housekeeping, and Opfield-managed local services.
      # Run Opfield on a dedicated host/VM; a read-only bind is not safer.
      - /var/run/docker.sock:/var/run/docker.sock
      # The host's memory, CPUs, load and uptime for diagnostics. In an LXC the memory use comes from the
      # LXC's cgroup and the uptime from its init, since LXCFS answers /proc for the app container.
      - /proc/meminfo:/host/proc/meminfo:ro
      - /proc/loadavg:/host/proc/loadavg:ro
      - /proc/stat:/host/proc/stat:ro
      - /proc/1/stat:/host/proc/1/stat:ro
      - /sys/fs/cgroup:/host/cgroup:ro
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      # Inherit the image's bounded, child-process-free health probe.
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  relay:
    image: ${OPFIELD_RELAY_IMAGE_REF}
    entrypoint: ["/opfield-relay"]
    restart: unless-stopped
    labels:
      net.opfield.managed-service: relay
    environment:
      RELAY_IDENTITY_DIR: /var/lib/opfield-relay/identity
      RELAY_STATE_DIR: /var/lib/opfield-relay/state
      RELAY_APP_GRPC_TARGET: app:9443
      RELAY_POOL_ID: system
      RELAY_INSTANCE_ID: 00000000-0000-4000-8000-000000000001
    ports:
      - "9443:9443"
    volumes:
      - relay_identity:/var/lib/opfield-relay/identity:ro
      - relay_state:/var/lib/opfield-relay/state
    healthcheck:
      test: ["CMD", "/opfield-relay", "healthcheck"]
      interval: 5s
      timeout: 3s
      retries: 2
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  registry:
    image: ${OPFIELD_REGISTRY_IMAGE_REF}
    restart: unless-stopped
    labels:
      net.opfield.managed-service: registry
    environment:
      REGISTRY_HTTP_ADDR: 0.0.0.0:5000
      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001
      REGISTRY_LOG_LEVEL: info
      REGISTRY_HTTP_SECRET: ${OPFIELD_REGISTRY_HTTP_SECRET}
      REGISTRY_AUTH: token
      REGISTRY_AUTH_TOKEN_REALM: ${OPFIELD_REGISTRY_TOKEN_REALM:-https://opfield.invalid/api/docker/registry/token}
      REGISTRY_AUTH_TOKEN_SERVICE: opfield-internal-registry
      REGISTRY_AUTH_TOKEN_ISSUER: opfield-internal-registry
      REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE: /var/lib/opfield-registry-auth/token-cert.pem
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_INTERVAL: 10s
      REGISTRY_HEALTH_STORAGEDRIVER_THRESHOLD: "3"
    expose:
      - "5000"
    volumes:
      - registry_data:/var/lib/registry
      - registry_auth:/var/lib/opfield-registry-auth:ro
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:5001/debug/health >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  postgres:
    image: ${OPFIELD_POSTGRES_IMAGE_REF}
    restart: unless-stopped
    # A host shutdown stops every container at once. Smart shutdown (SIGTERM) lets the app finish its shutdown drain
    # on its open connections before postgres exits; the image's default (SIGINT) cuts them at once.
    stop_signal: SIGTERM
    stop_grace_period: 75s
    environment:
      POSTGRES_DB: opfield
      POSTGRES_USER: opfield
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opfield -d opfield"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  redis:
    image: ${OPFIELD_REDIS_IMAGE_REF}
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

volumes:
  app_data:
  relay_identity:
  relay_state:
  registry_data:
  registry_auth:
  postgres_data:
  redis_data:
COMPOSE
}

if [[ "$FRESH" == 1 ]]; then
  if [[ "$LEGACY_LAYOUT" == 1 ]]; then
    write_legacy_compose
  else
    write_opfield_compose
    if release_predates "$FIRST_OPFIELD_DATA_DIR_VERSION" "$VERSION"; then
      # legacy-name: an app image before FIRST_OPFIELD_DATA_DIR_VERSION keeps its data in the legacy directories.
      tmp_compose="$(mktemp)"
      sed -e "s#/var/lib/opfield-relay#${LEGACY_RELAY_IDENTITY_DIR}#g" \
        -e "s#/var/lib/opfield-registry-auth#${LEGACY_REGISTRY_AUTH_DIR}#g" \
        -e "s#/var/lib/opfield/tls#${LEGACY_APP_DATA_DIR}/tls#g" \
        -e "s#:/var/lib/opfield\$#:${LEGACY_APP_DATA_DIR}#" docker-compose.yml >"$tmp_compose"
      cat "$tmp_compose" >docker-compose.yml
      rm -f "$tmp_compose"
    fi
    if release_predates "$FIRST_OPFIELD_LAYOUT_VERSION" "$RELAY_BUILD_VERSION"; then
      # legacy-name: a relay image before 2.12.1 has only the legacy entrypoint (later ones keep it as a link).
      tmp_compose="$(mktemp)"
      awk -v legacy="\"${LEGACY_RELAY_BINARY}\"" '{ gsub("\"/opfield-relay\"", legacy); print }' docker-compose.yml >"$tmp_compose"
      cat "$tmp_compose" >docker-compose.yml
      rm -f "$tmp_compose"
    fi
  fi
  detect_docker_log_defaults
  if ! docker_bounded_logging_allowed; then
    # Keep the host's own logging (another driver, daemon.json log-opts, or unknown).
    tmp_compose="$(mktemp)"
    awk '
      /^    logging:$/ { skip = 1; next }
      skip && /^      / { next }
      { skip = 0; print }
    ' docker-compose.yml >"$tmp_compose"
    cat "$tmp_compose" >docker-compose.yml
    rm -f "$tmp_compose"
  fi
else
  info "Migrating the existing installer-managed Compose foundation"
  run_quiet "Opfield image pull" "${DOCKER[@]}" pull "$IMAGE_REF"
  # Run the target image's compatibility entry point with the existing app's
  # network and environment while that app is still serving traffic. Keep
  # credentials in a mode-0600 temporary file, not Docker command arguments.
  current_app_id="$("${DOCKER[@]}" compose ps -q app)"
  [[ -n "$current_app_id" ]] || die "Start the existing Opfield installation before preparing its licensed update"
  current_network="$("${DOCKER[@]}" inspect --format '{{.HostConfig.NetworkMode}}' "$current_app_id")"
  preparation_env="$(mktemp "$INSTALL_DIR/.opfield-update-env.XXXXXX")"
  chmod 600 "$preparation_env"
  trap 'rm -f "${preparation_env:-}"' EXIT
  if ! "${DOCKER[@]}" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$current_app_id" \
      | awk '/^(NODE_ENV|DATABASE_URL|REDIS_URL|PKI_MASTER_KEY)=/' > "$preparation_env"; then
    rm -f "$preparation_env"
    die "Cannot read the existing Opfield update environment"
  fi
  if ! run_quiet "License and private core preparation" "${DOCKER[@]}" run --rm \
      --network "$current_network" --env-file "$preparation_env" -v "$INSTALL_DIR:/host" "$IMAGE_REF" \
      node dist/cli/migrate-legacy-settings.js /host --prepare-only; then
    rm -f "$preparation_env"
    die "Private core preparation failed; the current Opfield installation remains running"
  fi
  rm -f "$preparation_env"
  trap - EXIT
  foundation_args=(node dist/foundation-migrator.js --host-dir /host --target-version "$VERSION" --image-ref "$IMAGE_REF")
  if [[ "$RELAY_BOOTSTRAP" == 1 ]]; then
    foundation_args+=(--relay-build-version "$RELAY_BUILD_VERSION" --relay-protocol-major "$RELAY_PROTOCOL_MAJOR" --relay-image-ref "$RELAY_IMAGE_REF")
  fi
  if [[ -n "${SECURE_LINK_CONNECTOR_IMAGE_REF:-}" ]]; then
    foundation_args+=(--secure-link-connector-image "$SECURE_LINK_CONNECTOR_IMAGE_REF")
  fi
  detect_docker_log_defaults
  foundation_env=()
  [[ -n "$DOCKER_LOG_DRIVER" ]] && foundation_env+=(-e "OPFIELD_DOCKER_LOG_DRIVER=$DOCKER_LOG_DRIVER")
  [[ -n "$DOCKER_LOG_OPTS" ]] && foundation_env+=(-e "OPFIELD_DOCKER_LOG_OPTS=$DOCKER_LOG_OPTS")
  run_quiet "Opfield foundation migration" "${DOCKER[@]}" run --rm ${foundation_env[@]+"${foundation_env[@]}"} -v "$INSTALL_DIR:/host" "$IMAGE_REF" "${foundation_args[@]}"
fi

if [[ -n "$CONSOLE_DOMAIN" ]]; then
  add_console_ports docker-compose.yml || die "Cannot publish ports 80 and 443 for the app service in docker-compose.yml"
fi

if [[ -z "$SOURCE_DIR" ]]; then
  info "Pulling ${IMAGE_REF}"
  if [[ "$FRESH" == 1 ]]; then
    run_quiet "Opfield service image pull" "${DOCKER[@]}" compose pull app relay
  else
    run_quiet "Opfield service image pull" "${DOCKER[@]}" compose pull app
    if [[ "$RELAY_BOOTSTRAP" == 1 ]]; then
      run_quiet "Relay service image pull" "${DOCKER[@]}" compose pull relay
    fi
  fi
fi
info "Preparing the pinned recovery helper"
run_quiet "Opfield recovery helper image pull" "${DOCKER[@]}" pull "$DOCKER_COMPOSE_CLI_IMAGE_REF"
[[ -z "$RESTORE_FILE" ]] || run_restore
info "Starting Opfield services"
if [[ "$FRESH" == 1 ]]; then
  run_quiet "Opfield service startup" "${DOCKER[@]}" compose up -d
else
  if [[ "$RELAY_BOOTSTRAP" == 1 ]]; then
    run_quiet "Relay service startup" "${DOCKER[@]}" compose up -d --no-deps relay
  fi
  run_quiet "Opfield service startup" "${DOCKER[@]}" compose up -d --no-deps app
fi

info "Waiting for Opfield"
healthy=0
for _ in $(seq 1 90); do
  if curl -kfsS https://127.0.0.1:3000/health >/dev/null 2>&1 || curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || die "Opfield did not become healthy; run: docker compose logs app"

# The first boot imports legacy OIDC_*, CLICKHOUSE_*, and APP_URL values into
# encrypted Opfield settings. The guarded migration command verifies a complete
# legacy tuple before it removes anything from disk.
if grep -Eq '^(OIDC_|CLICKHOUSE_|APP_URL=|SETUP_TOKEN=)' .env; then
  info "Finalizing legacy settings migration"
  run_quiet "Legacy settings migration" "${DOCKER[@]}" compose run --rm -T -v "$INSTALL_DIR:/host" app \
    node dist/cli/migrate-legacy-settings.js /host --settings-only
  run_quiet "Opfield restart after legacy migration" "${DOCKER[@]}" compose up -d --force-recreate app
fi

[[ "$FRESH" == 1 ]] || run_host_move

ok "Opfield ${VERSION} is running"
guide_blank
if [[ -n "$RESTORE_FILE" ]]; then
  guide "${BRAND_MINT}Restored from:${NC} ${RESTORE_FILE}"
  [[ -z "$RESTORED_PUBLIC_URL" ]] || guide "${BRAND_MINT}Open:${NC} ${RESTORED_PUBLIC_URL}"
  if [[ "$RESTORED_OWNER_SIGN_IN" == password-link ]]; then
    # The export came from a managed cloud installation: its Opfield account sign-in does not work here.
    owner_json="$("${DOCKER[@]}" compose exec -T app node dist/cli/owner-password-link.js </dev/null 2>>"$LOG_FILE" | sed -n '/^{"email":/p' | tail -n1 || true)"
    owner_email="$(printf '%s' "$owner_json" | sed -n 's/.*"email":"\([^"]*\)".*/\1/p')"
    owner_link="$(printf '%s' "$owner_json" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
    owner_expires="$(printf '%s' "$owner_json" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
    guide "${GRAY}The export came from an Opfield Cloud installation: sign-in with the Opfield account is off here${NC}"
    guide "${GRAY}and password sign-in is on. Set the owner's password with this one-time link:${NC}"
    if [[ -n "$owner_link" ]]; then
      guide "${BRAND_MINT}Owner:${NC}      ${owner_email}"
      guide "${BRAND_MINT}Password:${NC}   ${owner_link}"
      guide "${GRAY}Expires:${NC}    ${owner_expires}"
    else
      warn "The owner password link could not be issued. Check ${LOG_FILE} for details."
    fi
    guide "${GRAY}New link:${NC}   cd ${INSTALL_DIR} && docker compose exec app node dist/cli/owner-password-link.js"
    guide "${GRAY}Other accounts that signed in with the Opfield account need a new sign-in method.${NC}"
    guide "${GRAY}The licence stayed with the cloud installation; activate your own key in Settings > License.${NC}"
  else
    guide "${GRAY}Sign in with the accounts of the exported installation.${NC}"
  fi
  guide "${GRAY}Nodes and relays reconnect to this host's address; see the docs on moving Opfield.${NC}"
  rm -f "$INSTALL_PENDING_MARKER"
elif [[ "$FRESH" == 1 ]]; then
  if ! setup_json="$("${DOCKER[@]}" compose exec -T app node dist/cli/setup-code.js </dev/null 2>>"$LOG_FILE" | sed -n '/^{"id":/p' | tail -n1)"; then
    die "Opfield started, but the setup code could not be generated. Check ${LOG_FILE} for details."
  fi
  setup_code="$(printf '%s' "$setup_json" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  expires_at="$(printf '%s' "$setup_json" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
  ca_fingerprint="$(printf '%s' "$setup_json" | sed -n 's/.*"caFingerprint":"\([^"]*\)".*/\1/p')"
  [[ -n "$setup_code" ]] || die "Opfield started, but the setup code could not be generated"
  print_opfield_urls
  guide_blank
  guide "${BRAND_MINT}Setup code:${NC} ${setup_code}"
  guide "${GRAY}Expires:${NC}    ${expires_at}"
  guide "${GRAY}System CA:${NC}  ${ca_fingerprint}"
  guide "${GRAY}Reset:${NC}      cd ${INSTALL_DIR} && docker compose exec app node dist/cli/reset-setup.js"
  guide_blank
  guide "${GRAY}The setup code is shown once. Finish configuration in the browser.${NC}"
  rm -f "$INSTALL_PENDING_MARKER"
else
  guide "${GRAY}Existing installation updated; persisted Opfield settings were preserved.${NC}"
fi

guide_blank
echo -e "${BRAND_MINT}■${NC} ${BOLD}Opfield installation completed successfully.${NC}"
echo ""
