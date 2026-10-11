#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DEFAULT_IMAGE="ghcr.io/opfield/opfield"
# Official image repositories: the opfield organization and the earlier one every release is still published to.
# A release's signed manifest names one of them (ghcr.io/opfield/opfield from 2.12; earlier releases the other one);
# unless --image or GATEWAY_IMAGE names another repository, the installer installs the one the manifest names.
OFFICIAL_IMAGES=("ghcr.io/opfield/opfield" "ghcr.io/the-square-labs/gateway")
DOCKER_COMPOSE_CLI_IMAGE_REF="docker.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"
# Third-party service images, pinned by digest and mirrored to GHCR by the release pipeline
# (config/third-party-images.json). The GHCR mirror is pulled first; Docker Hub serves the same
# digest when the mirror cannot be pulled. Releases mirror them under both official repositories; the
# earlier one stays the pull source, like on Docker nodes (packages/daemons/docker third_party_images.go).
THIRD_PARTY_MIRROR_REPOSITORY="ghcr.io/the-square-labs/gateway"
REGISTRY_UPSTREAM_IMAGE_REF="docker.io/library/registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8" # 3.1.2
POSTGRES_UPSTREAM_IMAGE_REF="docker.io/library/postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea" # 16.15-alpine
REDIS_UPSTREAM_IMAGE_REF="docker.io/library/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499" # 7.4.11-alpine
DEFAULT_INSTALL_DIR="/opt/gateway"
# Present from the start of a fresh install until its setup code is shown; a re-run resumes it.
INSTALL_PENDING_MARKER=".gateway-install-pending"
RELEASES_API_URL="${RELEASES_API_URL:-https://get.opfield.dev/gateway/releases}"
ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://get.opfield.dev/gateway}"
INSTALL_DIR="${GATEWAY_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
IMAGE="${GATEWAY_IMAGE:-$DEFAULT_IMAGE}"
TRANSPORT="${GATEWAY_WEB_TRANSPORT:-}"
SOURCE_DIR="${GATEWAY_SOURCE_DIR:-}"
LOG_FILE="${GATEWAY_INSTALL_LOG_FILE:-/tmp/gateway-install.log}"
DRY_RUN=0
RELAY_BOOTSTRAP=0
RESTORE_FILE=""
RESTORE_PUBLIC_URL=""
RESTORE_GRPC_TARGET=""
RESTORE_VERSION=""
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
  local component="$1" current_version="${2:-}" url
  url="${RELEASES_API_URL}?component=${component}"
  if [[ -n "$current_version" ]]; then
    url="${url}&current=${current_version}"
  fi
  curl -fsSL "$url" 2>>"$LOG_FILE"
}

prompt_menu() {
  local default="$1"
  shift
  local -a options=("$@")
  local selected=$((default - 1)) key sequence tty="/dev/tty" index
  [[ -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]] || { echo "$default"; return; }
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
# Keep this installer self-contained: a fresh Gateway host must not require
# Docker to have been installed manually beforehand.  The package flow mirrors
# scripts/setup-docker-node.sh so Gateway and Docker-node installation use the
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
  manifest_file="${tmp_dir}/gateway-image.update.json"
  payload_file="${tmp_dir}/payload.json"
  signature_file="${tmp_dir}/signature.bin"
  key_file="${tmp_dir}/update-signing-public-key.pem"

  info "Verifying signed release manifest for ${version}"
  if ! download_release_artifact gateway "$version" gateway-image.update.json "$manifest_file"; then
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
  if [[ "$kind" != "gateway-image" || "$manifest_version" != "$version" || "$tag" != "$version" ||
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
  local payload signature kind manifest_version tag image digest image_ref protocol_major min_gateway_version
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
  min_gateway_version="$(json_string_field "$payload_file" minGatewayVersion)"
  secure_connector_image_ref="$(json_string_field "$payload_file" secureLinkConnectorImage)"
  if [[ "$kind" != "relay-image" || "$tag" != "$relay_tag" || "$relay_tag" != "${manifest_version}-relay" ||
    ! "$manifest_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ || "$image" != "${IMAGE}/relay" ||
    ! "$digest" =~ ^sha256:[a-f0-9]{64}$ || "$image_ref" != "${IMAGE}/relay@${digest}" || "$protocol_major" != "1" ]]; then
    rm -rf "$tmp_dir"
    die "Signed relay manifest does not match a compatible Relay image."
  fi
  [[ -n "$min_gateway_version" ]] || min_gateway_version="$manifest_version"
  if [[ ! "$min_gateway_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || version_is_newer "$min_gateway_version" "$VERSION"; then
    rm -rf "$tmp_dir"
    die "Relay ${manifest_version} requires Opfield ${min_gateway_version} or newer."
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

# Host Docker logging defaults. Gateway adds bounded json-file logs to its
# Compose services only when the daemon default is json-file and daemon.json
# sets no default log-opts; any other operator choice wins.
DOCKER_LOG_DRIVER=""
DOCKER_LOG_OPTS=""
detect_docker_log_defaults() {
  local config="${GATEWAY_DOCKER_DAEMON_CONFIG:-/etc/docker/daemon.json}" compact
  DOCKER_LOG_DRIVER="$("${DOCKER[@]}" info --format '{{.LoggingDriver}}' 2>/dev/null | tr -d '[:space:]' || true)"
  DOCKER_LOG_OPTS=""
  [[ -n "$DOCKER_LOG_DRIVER" ]] || return 0
  if [[ ! -e "$config" ]]; then
    DOCKER_LOG_OPTS="none"
  elif compact="$(tr -d ' \t\r\n' <"$config" 2>/dev/null)"; then
    if [[ "$compact" == *'"log-opts":{"'* ]]; then
      DOCKER_LOG_OPTS="set"
    else
      DOCKER_LOG_OPTS="none"
    fi
  fi
}

docker_bounded_logging_allowed() {
  [[ "$DOCKER_LOG_DRIVER" == "json-file" && "$DOCKER_LOG_OPTS" == "none" ]]
}

# Whether vX.Y.Z[-rc.N] version $1 is newer than $2, ordered like the Gateway backend: numerically,
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

  local release_json relay_json relay_tag relay_version current_gateway_version current_relay_version
  if [[ -n "$RESTORE_FILE" ]]; then
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
    current_gateway_version="$(env_value GATEWAY_VERSION)"
    if [[ -z "$current_gateway_version" ]]; then
      current_gateway_version="$(env_value GATEWAY_IMAGE_REF)"
      current_gateway_version="${current_gateway_version##*:}"
    fi
    [[ "$current_gateway_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || current_gateway_version=""
    release_json="$(fetch_release gateway "$current_gateway_version")" || die "Unable to query Opfield releases"
    if [[ -z "$release_json" && -n "$current_gateway_version" ]]; then
      VERSION="$current_gateway_version"
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
  current_relay_version="$(env_value GATEWAY_RELAY_BUILD_VERSION)"
  if [[ "$FRESH" == 1 || -z "$(env_value GATEWAY_RELAY_IMAGE_REF)" || -z "$current_relay_version" ]]; then
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
  RESTORE_VERSION="$(json_string_field "$header_file" gatewayVersion)"
  rm -f "$header_file"
  [[ "$RESTORE_VERSION" =~ ^[A-Za-z0-9._+-]+$ ]] || die "The header of ${RESTORE_FILE} is invalid"
}

read_restore_passphrase() {
  if [[ -n "${OPFIELD_RESTORE_PASSPHRASE:-}" ]]; then
    RESTORE_PASSPHRASE="$OPFIELD_RESTORE_PASSPHRASE"
    return
  fi
  [[ -r /dev/tty && -w /dev/tty ]] || die "Set OPFIELD_RESTORE_PASSPHRASE to restore without a terminal"
  printf '%b' "${BRAND_MINT}│${NC} Export passphrase: " >/dev/tty
  IFS= read -rs RESTORE_PASSPHRASE </dev/tty || RESTORE_PASSPHRASE=""
  printf '\n' >/dev/tty
  [[ -n "$RESTORE_PASSPHRASE" ]] || die "No passphrase entered"
}

prompt_restore_address() {
  local addresses
  [[ -z "$RESTORE_PUBLIC_URL" && -z "$RESTORE_GRPC_TARGET" ]] || return 0
  [[ -r /dev/tty && -w /dev/tty ]] || return 0
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
    "${DOCKER[@]}" compose exec -T postgres pg_isready -U gateway -d gateway </dev/null >/dev/null 2>&1 && break
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
  ok "Export restored"
}

usage() {
  cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--image IMAGE] [--source-dir PATH] [--http|--https] [--dry-run]
       install.sh --restore FILE [--public-url URL] [--grpc-target HOST:PORT] [--install-dir PATH]

Installs or updates Opfield. On a fresh interactive install, the only prompt
selects native HTTPS or HTTP for port 3000. Non-interactive installs default
to native HTTPS. All product configuration continues in the browser wizard.

--restore installs the Opfield version that made a configuration export into a
fresh directory and restores the export into it. It asks for the export's
passphrase (or reads OPFIELD_RESTORE_PASSPHRASE) and for this host's address;
--public-url and --grpc-target set the address without asking. Without them
the exported address is kept.

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
    --public-url) RESTORE_PUBLIC_URL="${2:?missing URL}"; shift 2 ;;
    --grpc-target) RESTORE_GRPC_TARGET="${2:?missing host:port}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

show_header

RESTORED_PUBLIC_URL=""
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

if [[ "$RESUME" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="$(env_value WEB_TLS_BOOTSTRAP_MODE)"
fi
if [[ "$FRESH" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="https"
  # A restore brings the web transport setting along with the database.
  if [[ -z "$RESTORE_FILE" && -r /dev/tty && -w /dev/tty ]]; then
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
[[ "$TRANSPORT" == "http" || "$TRANSPORT" == "https" || "$FRESH" == 0 ]] || die "GATEWAY_WEB_TRANSPORT must be http or https"
if [[ "$FRESH" == 1 && -z "$RESTORE_FILE" ]]; then
  if [[ "$TRANSPORT" == "https" ]]; then
    guide_blank
    warn "Your browser will show a certificate warning on first visit."
    warn "This is expected until the Opfield System CA is trusted."
  else
    guide_blank
  fi
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry run: would validate Docker and prepare Opfield services"
  info "Dry run: would start Opfield with ${TRANSPORT} on port 3000"
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

format_gateway_url() {
  local address="$1"
  if [[ "$address" == *:* ]]; then
    printf '%s://[%s]:3000' "$TRANSPORT" "$address"
  else
    printf '%s://%s:3000' "$TRANSPORT" "$address"
  fi
}

print_gateway_urls() {
  local address
  guide "${BRAND_MINT}Open:${NC}"
  guide "  ${GRAY}Local:${NC}   ${TRANSPORT}://localhost:3000"
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    guide "  ${GRAY}Network:${NC} $(format_gateway_url "$address")"
  done < <(detect_local_host_address_lines)
}

REGISTRY_IMAGE_REF="$(env_value GATEWAY_REGISTRY_IMAGE_REF)"
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
ensure_env GATEWAY_IMAGE_REF "$IMAGE_REF"
if [[ -n "${SECURE_LINK_CONNECTOR_IMAGE_REF:-}" ]]; then
  set_env SECURE_LINK_CONNECTOR_IMAGE "$SECURE_LINK_CONNECTOR_IMAGE_REF"
fi
ensure_env DB_PASSWORD "$(openssl rand -hex 24)"
ensure_env PKI_MASTER_KEY "$(openssl rand -hex 32)"
ensure_env SETUP_BOOTSTRAP "$([[ "$FRESH" == 1 && -z "$RESTORE_FILE" ]] && printf true || printf false)"
ensure_env WEB_TLS_BOOTSTRAP_MODE "${TRANSPORT:-http}"
ensure_env SANDBOX_RUNNER_WORKSPACE_DIR "/var/lib/gateway/sandbox-workspaces"
set_env GATEWAY_REGISTRY_IMAGE_REF "$REGISTRY_IMAGE_REF"
ensure_env GATEWAY_REGISTRY_HTTP_SECRET "$(openssl rand -hex 32)"
ensure_env GATEWAY_RELAY_MANAGED "$([[ -z "$SOURCE_DIR" ]] && printf true || printf false)"
if [[ "$FRESH" == 1 ]]; then
  set_env GATEWAY_VERSION "$VERSION"
  set_env GATEWAY_RELAY_IMAGE_REF "$RELAY_IMAGE_REF"
  set_env GATEWAY_RELAY_BUILD_VERSION "$RELAY_BUILD_VERSION"
  set_env GATEWAY_RELAY_PROTOCOL_MAJOR "$RELAY_PROTOCOL_MAJOR"
  set_env GATEWAY_POSTGRES_IMAGE_REF "$POSTGRES_IMAGE_REF"
  set_env GATEWAY_REDIS_IMAGE_REF "$REDIS_IMAGE_REF"
fi
local_host_addresses="$(detect_local_host_addresses)"
if [[ -n "$local_host_addresses" ]]; then
  set_env GATEWAY_LOCAL_HOSTS "$local_host_addresses"
else
  ensure_env GATEWAY_LOCAL_HOSTS ""
fi
chmod 600 .env

# Always advance the managed image reference to the latest release.
tmp_env="$(mktemp)"
awk -v ref="$IMAGE_REF" 'BEGIN{done=0} /^GATEWAY_IMAGE_REF=/{if(!done){print "GATEWAY_IMAGE_REF=" ref; done=1} next} {print} END{if(!done) print "GATEWAY_IMAGE_REF=" ref}' .env >"$tmp_env"
mv "$tmp_env" .env
chmod 600 .env

if [[ "$FRESH" == 1 ]]; then
  cat >docker-compose.yml <<'COMPOSE'
services:
  app:
    image: ${GATEWAY_IMAGE_REF}
    restart: unless-stopped
    stop_grace_period: 60s
    labels:
      com.wiolett.gateway.managed-service: app
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway
      REDIS_URL: redis://redis:6379
      PKI_MASTER_KEY: ${PKI_MASTER_KEY}
      WEB_TLS_AUTO_DIR: /var/lib/gateway/tls
      GRPC_TLS_AUTO_DIR: /var/lib/gateway/tls
      GATEWAY_RELAY_REQUIRED: "true"
      GATEWAY_RELAY_MANAGED: "${GATEWAY_RELAY_MANAGED:-true}"
      GATEWAY_RELAY_TARGET: relay:9443
      GATEWAY_RELAY_IDENTITY_DIR: /var/lib/gateway-relay
      GATEWAY_RELAY_IMAGE_REF: ${GATEWAY_RELAY_IMAGE_REF}
      GATEWAY_RELAY_SERVICE_NAME: relay
      GATEWAY_RELAY_BUILD_VERSION: ${GATEWAY_RELAY_BUILD_VERSION}
      GATEWAY_RELAY_PROTOCOL_MAJOR: ${GATEWAY_RELAY_PROTOCOL_MAJOR}
      GATEWAY_REGISTRY_AUTH_DIR: /var/lib/gateway-registry-auth
      SANDBOX_RUNNER_WORKSPACE_DIR: ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
    ports:
      - "3000:3000"
    expose:
      - "9443"
    volumes:
      - gateway_data:/var/lib/gateway
      - gateway_relay_identity:/var/lib/gateway-relay
      - gateway_registry_auth:/var/lib/gateway-registry-auth
      - ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
      # Intentional host trust boundary: required for signed self-update,
      # recovery, housekeeping, and Gateway-managed local services.
      # Run Gateway on a dedicated host/VM; a read-only bind is not safer.
      - /var/run/docker.sock:/var/run/docker.sock
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
    image: ${GATEWAY_RELAY_IMAGE_REF}
    entrypoint: ["/gateway-relay"]
    restart: unless-stopped
    labels:
      com.wiolett.gateway.managed-service: relay
    environment:
      RELAY_IDENTITY_DIR: /var/lib/gateway-relay/identity
      RELAY_STATE_DIR: /var/lib/gateway-relay/state
      RELAY_APP_GRPC_TARGET: app:9443
      RELAY_POOL_ID: system
      RELAY_INSTANCE_ID: 00000000-0000-4000-8000-000000000001
    ports:
      - "9443:9443"
    volumes:
      - gateway_relay_identity:/var/lib/gateway-relay/identity:ro
      - gateway_relay_state:/var/lib/gateway-relay/state
    healthcheck:
      test: ["CMD", "/gateway-relay", "healthcheck"]
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
    image: ${GATEWAY_REGISTRY_IMAGE_REF}
    restart: unless-stopped
    labels:
      com.wiolett.gateway.managed-service: registry
    environment:
      REGISTRY_HTTP_ADDR: 0.0.0.0:5000
      REGISTRY_HTTP_DEBUG_ADDR: 127.0.0.1:5001
      REGISTRY_HTTP_SECRET: ${GATEWAY_REGISTRY_HTTP_SECRET}
      REGISTRY_AUTH: token
      REGISTRY_AUTH_TOKEN_REALM: ${GATEWAY_REGISTRY_TOKEN_REALM:-https://gateway.invalid/api/docker/registry/token}
      REGISTRY_AUTH_TOKEN_SERVICE: gateway-internal-registry
      REGISTRY_AUTH_TOKEN_ISSUER: gateway-internal-registry
      REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE: /var/lib/gateway-registry-auth/token-cert.pem
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_ENABLED: "true"
      REGISTRY_HEALTH_STORAGEDRIVER_INTERVAL: 10s
      REGISTRY_HEALTH_STORAGEDRIVER_THRESHOLD: "3"
    expose:
      - "5000"
    volumes:
      - gateway_registry_data:/var/lib/registry
      - gateway_registry_auth:/var/lib/gateway-registry-auth:ro
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
    image: ${GATEWAY_POSTGRES_IMAGE_REF}
    restart: unless-stopped
    # A host shutdown stops every container at once. Smart shutdown (SIGTERM) lets the app finish its shutdown drain
    # on its open connections before postgres exits; the image's default (SIGINT) cuts them at once.
    stop_signal: SIGTERM
    stop_grace_period: 75s
    environment:
      POSTGRES_DB: gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d gateway"]
      interval: 5s
      timeout: 5s
      retries: 12
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

  redis:
    image: ${GATEWAY_REDIS_IMAGE_REF}
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
  gateway_data:
  gateway_relay_identity:
  gateway_relay_state:
  gateway_registry_data:
  gateway_registry_auth:
  postgres_data:
  redis_data:
COMPOSE
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
  preparation_env="$(mktemp "$INSTALL_DIR/.gateway-update-env.XXXXXX")"
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
  [[ -n "$DOCKER_LOG_DRIVER" ]] && foundation_env+=(-e "GATEWAY_DOCKER_LOG_DRIVER=$DOCKER_LOG_DRIVER")
  [[ -n "$DOCKER_LOG_OPTS" ]] && foundation_env+=(-e "GATEWAY_DOCKER_LOG_OPTS=$DOCKER_LOG_OPTS")
  run_quiet "Opfield foundation migration" "${DOCKER[@]}" run --rm ${foundation_env[@]+"${foundation_env[@]}"} -v "$INSTALL_DIR:/host" "$IMAGE_REF" "${foundation_args[@]}"
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
# encrypted Gateway settings. The guarded migration command verifies a complete
# legacy tuple before it removes anything from disk.
if grep -Eq '^(OIDC_|CLICKHOUSE_|APP_URL=|SETUP_TOKEN=)' .env; then
  info "Finalizing legacy settings migration"
  run_quiet "Legacy settings migration" "${DOCKER[@]}" compose run --rm -T -v "$INSTALL_DIR:/host" app \
    node dist/cli/migrate-legacy-settings.js /host --settings-only
  run_quiet "Opfield restart after legacy migration" "${DOCKER[@]}" compose up -d --force-recreate app
fi

ok "Opfield ${VERSION} is running"
guide_blank
if [[ -n "$RESTORE_FILE" ]]; then
  guide "${BRAND_MINT}Restored from:${NC} ${RESTORE_FILE}"
  [[ -z "$RESTORED_PUBLIC_URL" ]] || guide "${BRAND_MINT}Open:${NC} ${RESTORED_PUBLIC_URL}"
  guide "${GRAY}Sign in with the accounts of the exported installation.${NC}"
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
  print_gateway_urls
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
