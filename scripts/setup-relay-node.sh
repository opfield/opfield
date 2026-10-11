#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

GATEWAY=""
TOKEN=""
GATEWAY_CERT_SHA256=""
ADVERTISE_ADDRESS=""
SERVICE_PORT="9443"
SERVICE_PORT_GIVEN=0
VERSION="latest"
RELEASES_API_URL="${GATEWAY_RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"
ARTIFACT_BASE_URL="${GATEWAY_ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"
RUN_USER="${GATEWAY_RELAY_RUN_USER:-root}"
# Defaults to the run user's primary group (root for root).
RUN_GROUP="${GATEWAY_RELAY_RUN_GROUP:-}"
# The setup log: GATEWAY_RELAY_SETUP_LOG, or a new file under /tmp as the other installers keep. A dry run writes none.
LOG_FILE=/dev/null
MANUAL_LAUNCH_TIMEOUT_SECONDS="${GATEWAY_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
MANUAL_FALLBACK_USED=0
ENROLLMENT_WAIT_SECONDS="${GATEWAY_RELAY_ENROLLMENT_WAIT_SECONDS:-90}"
DISABLE_CONSOLE="${GATEWAY_NODE_DISABLE_CONSOLE:-0}"
DISABLE_FILES="${GATEWAY_NODE_DISABLE_FILES:-0}"
PROTECTED="${GATEWAY_RELAY_PROTECTED:-0}"
ALLOW_DATABASE_WITNESS=0
DRY_RUN=0

usage() {
  echo "Usage: setup-relay-node.sh --gateway host:port --token TOKEN --gateway-cert-sha256 sha256:HEX --advertise-address HOST [--service-port 9443] [--version vX.Y.Z] [--disable-console] [--disable-files] [--protected] [--dry-run]"
  echo "  An enrolled relay can be re-run without --token: it keeps its identity and takes the Opfield address, certificate"
  echo "  pin, advertised address and port from its configuration unless they are given. With a token it re-enrolls."
  echo "  --disable-console  Turn the host console off (console.enabled: false; env GATEWAY_NODE_DISABLE_CONSOLE=1)"
  echo "  --disable-files    Turn host file access off (files.enabled: false; env GATEWAY_NODE_DISABLE_FILES=1)"
  echo "  --protected        Protected mode (protected.enabled: true; env GATEWAY_RELAY_PROTECTED=1): Opfield cannot open a"
  echo "                     console, run commands, read or write files or collect host diagnostics on this machine; it can only"
  echo "                     update the relay with official signed releases and route traffic through it. The machine owner"
  echo "                     turns it off with: relay-supervisor protected off, then a restart of the relay supervisor."
  echo "  --dry-run          Validate inputs and show the plan without changing the host"
}

# Host access switches: the installer only turns them off, and keeps a switch a
# previous install turned off when it rewrites the config. Turning one back on
# is an edit of the config file on the node.
host_feature_disabled() {
  local config_file="$1" section="$2"
  [[ -f "$config_file" ]] || return 1
  awk -v section="$section" '
    $0 ~ ("^" section ":[[:space:]]*(#.*)?$") { in_section = 1; next }
    in_section && /^[^[:space:]#]/ { in_section = 0 }
    in_section && /^[[:space:]]+enabled:[[:space:]]*(false|False|FALSE)[[:space:]]*(#.*)?$/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$config_file"
}

# Protected mode and its database witness switch: the installer only turns protected mode on, and keeps both switches
# as a previous install or the machine owner set them when it rewrites the config. Turning protected mode off is
# `relay-supervisor protected off` (or an edit of the config file) on the machine.
relay_protected_setting() {
  local config_file="$1" key="$2"
  [[ -f "$config_file" ]] || return 1
  awk -v key="$key" '
    /^protected:[[:space:]]*(#.*)?$/ { in_section = 1; next }
    in_section && /^[^[:space:]#]/ { in_section = 0 }
    in_section && $0 ~ ("^[[:space:]]+" key ":[[:space:]]*(true|True|TRUE)[[:space:]]*(#.*)?$") { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$config_file"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

ensure_dependencies() {
  local dependency needs_coreutils=0
  local missing=() packages=()
  for dependency in curl jq openssl sha256sum install uname; do
    command_exists "$dependency" && continue
    missing+=("$dependency")
    case "$dependency" in
      curl) packages+=(curl ca-certificates) ;;
      jq|openssl) packages+=("$dependency") ;;
      sha256sum|install|uname) needs_coreutils=1 ;;
    esac
  done
  # An already prepared host needs neither a package manager nor network access here.
  [[ ${#missing[@]} -gt 0 ]] || return 0
  [[ "$needs_coreutils" -eq 0 ]] || packages+=(coreutils)

  printf 'Installing missing Relay installer dependencies:'
  printf ' %s' "${missing[@]}"
  printf '\n'
  # The package manager's output goes to the setup log; a failure shows its last lines.
  if command_exists apt-get; then
    if ! apt-get update >>"$LOG_FILE" 2>&1; then
      dependency_install_failed 'Could not refresh APT package metadata'
      return 1
    fi
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}" >>"$LOG_FILE" 2>&1; then
      dependency_install_failed 'Could not install Relay dependencies with apt-get'
      return 1
    fi
  elif command_exists dnf; then
    if ! dnf install -y "${packages[@]}" >>"$LOG_FILE" 2>&1; then
      dependency_install_failed 'Could not install Relay dependencies with dnf'
      return 1
    fi
  elif command_exists yum; then
    if ! yum install -y "${packages[@]}" >>"$LOG_FILE" 2>&1; then
      dependency_install_failed 'Could not install Relay dependencies with yum'
      return 1
    fi
  elif command_exists apk; then
    if ! apk add --no-cache "${packages[@]}" >>"$LOG_FILE" 2>&1; then
      dependency_install_failed 'Could not install Relay dependencies with apk'
      return 1
    fi
  else
    printf 'No supported package manager found. Install these commands and retry:' >&2
    printf ' %s' "${missing[@]}" >&2
    printf '\n' >&2
    return 1
  fi

  for dependency in "${missing[@]}"; do
    if ! command_exists "$dependency"; then
      echo "$dependency is still missing after package installation; Relay installation stopped." >&2
      return 1
    fi
  done
  return 0
}

# A package manager that failed: its last lines (its reason) under the message, and where the rest is.
dependency_install_failed() {
  local tail_lines=""
  [[ "$LOG_FILE" == /dev/null ]] || tail_lines=$(tail -n 5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /' || true)
  echo "$1; Relay installation stopped." >&2
  [[ -z "$tail_lines" ]] || printf '%s\n' "$tail_lines" >&2
  [[ "$LOG_FILE" == /dev/null ]] || echo "Setup log: ${LOG_FILE}" >&2
}

# A real run keeps a setup log: what the terminal shows (each status line, every error) and the detail it does not
# show (package manager and service manager output).
SETUP_LOG_OUT_PID=""
SETUP_LOG_ERR_PID=""
open_setup_log() {
  if [[ -n "${GATEWAY_RELAY_SETUP_LOG:-}" ]]; then
    LOG_FILE="$GATEWAY_RELAY_SETUP_LOG"
    if ! (umask 077 && : >>"$LOG_FILE"); then
      echo "Could not write the setup log ${LOG_FILE} (GATEWAY_RELAY_SETUP_LOG); Relay installation stopped." >&2
      exit 1
    fi
  elif ! LOG_FILE=$(mktemp /tmp/gateway_relay_setup.XXXXXX); then
    echo "Could not create the setup log under /tmp; Relay installation stopped." >&2
    exit 1
  fi
  chmod 0600 "$LOG_FILE" 2>/dev/null || true
  command_exists tee || return 0
  exec 3>&1 4>&2
  exec > >(tee -a "$LOG_FILE")
  SETUP_LOG_OUT_PID=$!
  exec 2> >(tee -a "$LOG_FILE" >&4)
  SETUP_LOG_ERR_PID=$!
}

# Waits (briefly) for the log copies to finish so the last lines reach the terminal and the log before the run ends.
close_setup_log() {
  [[ -n "$SETUP_LOG_OUT_PID" ]] || return 0
  exec 1>&3 2>&4 3>&- 4>&-
  local waited=0
  while (( waited < 50 )) && { kill -0 "$SETUP_LOG_OUT_PID" 2>/dev/null || kill -0 "$SETUP_LOG_ERR_PID" 2>/dev/null; }; do
    sleep 0.1
    waited=$((waited + 1))
  done
  SETUP_LOG_OUT_PID=""
}

has_systemd() { command_exists systemctl && [[ -d /run/systemd/system ]]; }

# Checks the service user before anything is installed: systemd would otherwise fail the unit with 217/USER on every
# restart while the installer waits for an enrollment that cannot happen.
resolve_run_identity() {
  if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="${RUN_GROUP:-root}"
    return 0
  fi
  if ! id -u "$RUN_USER" >/dev/null 2>&1; then
    echo "Relay run user '${RUN_USER}' (GATEWAY_RELAY_RUN_USER) does not exist; Relay installation stopped." >&2
    echo "Create it first, for example: useradd --system --no-create-home --shell /usr/sbin/nologin ${RUN_USER}" >&2
    return 1
  fi
  if [[ -z "$RUN_GROUP" ]]; then
    if ! RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null) || [[ -z "$RUN_GROUP" ]]; then
      echo "Could not resolve the primary group of '${RUN_USER}'; set GATEWAY_RELAY_RUN_GROUP." >&2
      return 1
    fi
  elif command_exists getent && ! getent group "$RUN_GROUP" >/dev/null 2>&1; then
    echo "Relay run group '${RUN_GROUP}' (GATEWAY_RELAY_RUN_GROUP) does not exist; Relay installation stopped." >&2
    return 1
  fi
}

# Only a relay that runs as its own user needs the capability to bind a privileged port; root has it already.
needs_bind_capability() { [[ "$RUN_USER" != "root" && "$SERVICE_PORT" -lt 1024 ]]; }

new_host_identity() {
  local value
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    value=$(cat /proc/sys/kernel/random/uuid) || return 1
  else
    value=$(openssl rand -hex 16) || return 1
    value="${value:0:8}-${value:8:4}-4${value:13:3}-$(printf '%x' $(( (16#${value:16:1} & 3) | 8 )))${value:17:3}-${value:20:12}"
  fi
  printf '%s\n' "$value"
}

# A relay running as its own user cannot read the host identity that root daemons share (root-owned, mode 0600). It
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
    echo "${shared} is not a regular file; fix it and run the installer again." >&2
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
    echo "The host identity at ${shared} is not valid; fix it and run the installer again." >&2
    return 1
  fi
  temporary=$(mktemp "$(dirname "$copy")/.host-identity-XXXXXX") || return 1
  if ! printf '%s\n' "$identity" >"$temporary" || ! chmod 0600 "$temporary" || ! mv -f "$temporary" "$copy"; then
    rm -f "$temporary"
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

# A root relay keeps its binary in /usr/local/bin. A relay running as its own user must be able to replace its binary
# when it updates itself, so the binary lives in the relay's own directory and /usr/local/bin holds a root-owned wrapper.
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

# The installed supervisor's version ('' when none answers); a non-root supervisor runs as its user, never as root.
installed_supervisor_version() {
  local binary=/usr/local/bin/relay-supervisor owner
  [[ -x "$binary" ]] || return 0
  owner=$(stat -Lc '%U' "$binary" 2>/dev/null || echo root)
  if [[ "$owner" == root ]] || is_daemon_wrapper "$binary"; then
    "$binary" version 2>/dev/null | awk '{print $2}'
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$owner" -- "$binary" version 2>/dev/null | awk '{print $2}'
  fi
}

# The version to install: a re-run without --version never moves a relay to an older supervisor than it runs ("latest"
# is the newest stable release); only --version naming the older release installs it.
relay_version_to_install() {
  local requested="$1" resolved="$2" installed
  installed=$(installed_supervisor_version || true)
  if [[ "$requested" == latest && "$installed" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] && daemon_version_older "$resolved" "$installed"; then
    echo "Relay supervisor ${installed} is installed; latest resolves to the older ${resolved}. Keeping ${installed}; pass --version ${resolved} to install the older release." >&2
    resolved="$installed"
  fi
  echo "$resolved"
}

install_supervisor_binary() {
  local source="$1" link="$2" own_dir="$3"
  if [[ "$RUN_USER" == "root" ]]; then
    # Never write a root binary through the link or wrapper left by an install that ran as another user.
    if [[ -L "$link" ]] || is_daemon_wrapper "$link"; then
      rm -f "$link"
    fi
    install -m 0755 "$source" "$link"
    return
  fi
  install -d -m 0755 "$own_dir"
  install -m 0755 "$source" "${own_dir}/relay-supervisor"
  write_daemon_wrapper "$link" "${own_dir}/relay-supervisor" \
    || { echo "Could not write the relay-supervisor command at ${link}; Relay installation stopped." >&2; exit 1; }
}

# Hands every relay path to the run user: the supervisor reads its configuration, writes its state and identities and
# replaces its own and the worker binary on update. A relay switched back to root gets back what its previous user
# owned, run-supervisor included, which root starts.
grant_relay_paths_to_run_user() {
  if [[ "$RUN_USER" == "root" ]]; then
    return_paths_to_root "$@"
    return
  fi
  chown -hR "${RUN_USER}:${RUN_GROUP}" "$@"
}

# The user a previous install ran the relay as: the first owner other than root of its configuration, state or own binary
# directory (root without one), so a switch back to root is announced and handled even when one of them is root's.
previous_run_uid() {
  local path uid
  for path in "$@"; do
    uid=$(stat -c '%u' "$path" 2>/dev/null) || continue
    [[ "$uid" == 0 ]] || { echo "$uid"; return 0; }
  done
  echo 0
}
PREVIOUS_RUN_UID=$(previous_run_uid /etc/gateway-relay-supervisor /var/lib/gateway-relay-supervisor /usr/local/lib/gateway-relay)

# Gives root every entry in the paths that the previous non-root user owns; entries of other owners keep theirs.
return_paths_to_root() {
  local path
  [[ "$PREVIOUS_RUN_UID" != 0 ]] || return 0
  for path in "$@"; do
    [[ ! -e "$path" ]] || find "$path" -xdev -user "$PREVIOUS_RUN_UID" -exec chown -h 0:0 {} +
  done
}

# A relay that moves to another user says so, is stopped first and gets a new launcher: the launcher copies in its state
# directory were written by that user, and no other user may run them.
prepare_run_user_switch() {
  # A fresh install has nothing to switch. A supervisor that ran as root is stopped before its files change owner too:
  # it keeps rewriting them (atomically, as root) while it runs, and the new user could not read them.
  [[ "$PREVIOUS_RUN_UID" != 0 || -d /etc/gateway-relay-supervisor ]] || return 0
  [[ "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]] || return 0
  echo "The relay supervisor ran as $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}"); switching it to ${RUN_USER}."
  if ! stop_relay_supervisor; then
    echo "Could not stop the relay supervisor to switch its user; Relay installation stopped." >&2
    exit 1
  fi
  rm -rf /var/lib/gateway-relay-supervisor/launcher
}

stop_relay_supervisor() {
  if has_systemd; then
    [[ ! -f /etc/systemd/system/gateway-relay-supervisor.service ]] || systemctl stop gateway-relay-supervisor >>"$LOG_FILE" 2>&1
  elif has_openrc; then
    [[ ! -f /etc/init.d/gateway-relay-supervisor ]] || rc-service --ifstarted gateway-relay-supervisor stop >>"$LOG_FILE" 2>&1
  else
    stop_manual_launcher /var/lib/gateway-relay-supervisor/launcher relay
  fi
}

supervisor_log_hint() {
  local manual_log=/var/lib/gateway-relay-supervisor/launcher/manual.log
  if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo "Supervisor log: ${manual_log}" >&2
    tail -n 20 "$manual_log" >&2 2>/dev/null || true
  elif has_systemd; then
    echo "Supervisor log: journalctl -u gateway-relay-supervisor" >&2
    journalctl -u gateway-relay-supervisor -n 20 --no-pager >&2 2>/dev/null || true
  elif has_openrc; then
    echo "Supervisor log: /var/log/gateway-relay-supervisor.err and /var/log/gateway-relay-supervisor.log" >&2
    tail -n 20 /var/log/gateway-relay-supervisor.err /var/log/gateway-relay-supervisor.log >&2 2>/dev/null || true
    # A service supervise-daemon cannot start leaves its reason in the system log, not in the service's own logs.
    grep -h 'supervise-daemon.*gateway-relay' /var/log/messages 2>/dev/null | tail -n 5 >&2 || true
  fi
}

fail_supervisor_start() {
  echo "$1" >&2
  supervisor_log_hint
  echo "Relay supervisor ${VERSION} is installed, but it is not running." >&2
  exit 1
}

# The supervisor records each control session Gateway accepted in its state directory (from GATEWAY_SESSION_SINCE
# on). The installer removes the record before it starts the supervisor, so only a session of the supervisor it
# started counts.
GATEWAY_SESSION_SINCE="v2.11.1-rc.2"
GATEWAY_SESSION_FILE="/var/lib/gateway-relay-supervisor/gateway-session.json"
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

# Supervisors older than GATEWAY_SESSION_SINCE write no session record; development builds do.
daemon_records_gateway_session() {
  local order
  order=$(release_order "$1") || return 0
  (( order >= $(release_order "$GATEWAY_SESSION_SINCE") ))
}

# Gateway accepted a session of the supervisor this run started, and that process still runs under its service manager.
gateway_session_is_current() {
  local pid connected_at
  [[ -f "$GATEWAY_SESSION_FILE" && ! -L "$GATEWAY_SESSION_FILE" ]] || return 1
  pid=$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$GATEWAY_SESSION_FILE")
  connected_at=$(sed -nE 's/.*"connected_at":([0-9]+).*/\1/p' "$GATEWAY_SESSION_FILE")
  [[ -n "$pid" && -n "$connected_at" ]] || return 1
  (( connected_at >= GATEWAY_SESSION_STARTED )) || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [[ "$MANUAL_FALLBACK_USED" -eq 0 ]] && has_systemd; then
    grep -q '/gateway-relay-supervisor\.service$' "/proc/${pid}/cgroup" 2>/dev/null || return 1
  fi
}

supervisor_service_running() {
  if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    launcher_pid_is_live "${MANUAL_OWNER_PID:-}"
  elif has_systemd; then
    systemctl is-active --quiet gateway-relay-supervisor
  else
    rc-service gateway-relay-supervisor status >/dev/null 2>&1
  fi
}
has_openrc() { command_exists rc-service && command_exists rc-update; }

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
    echo "Could not retire the legacy update guard at ${dropin}; preserving it." >&2
    return 0
  fi
  for marker in \
    "${daemon_binary}.update-state.json" \
    "${daemon_binary}.update-pending" \
    "${daemon_binary}.update-outcome.json"; do
    if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
      rm -f -- "$marker" || echo "Could not retire legacy update marker ${marker}; preserving it." >&2
    fi
  done
  echo "Retired the legacy update guard for ${daemon_binary}; preserved .previous and unknown files."
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
    setsid nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 3>&- 4>&- &
  elif command_exists nohup; then
    nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 3>&- 4>&- &
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

# Runs the supervisor under its own launcher on a host without a service manager. A launcher a previous run started
# is stopped first, as a service restart would, so the supervisor installed now runs.
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
    *) echo "Unknown launcher daemon binary ${daemon_binary}." >&2; return 1 ;;
  esac

  if ! stop_manual_launcher "$launcher_dir" "$daemon_type"; then
    echo "The running ${daemon_name} launcher did not stop; installed files were preserved." >&2
    return 1
  fi
  if ! prepare_manual_launcher_state "$state_dir"; then
    echo "Could not prepare manual launcher state for ${daemon_name}; installed files were preserved." >&2
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    return 1
  fi
  forget_gateway_session
  if ! detach_manual_launcher "$daemon_binary" "$manual_log"; then
    echo "Could not detach ${daemon_name}; installed files and launcher files were preserved." >&2
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    return 1
  fi

  if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
    echo "${daemon_name} is running in manual mode (launcher PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
    echo "Manual launcher log: ${manual_log}"
    echo "Manual mode is not persistent across reboot."
    return 0
  fi

  echo "Could not verify the detached ${daemon_name} launcher; installed files and launcher files were preserved." >&2
  echo "Launcher state: ${launcher_dir}"
  echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
  return 1
}

RELAY_CONFIG=/etc/gateway-relay-supervisor/config.yaml
RELAY_IDENTITY=/var/lib/gateway-relay-supervisor/supervisor-identity/node.pem

# A value of the relay's configuration: key inside a section (gateway: address), or a list item under a key.
relay_config_value() {
  local section="$1" key="$2"
  [[ -f "$RELAY_CONFIG" && ! -L "$RELAY_CONFIG" ]] || return 1
  awk -v q="'" -v section="$section" -v key="$key" '
    $0 ~ ("^" section ":[[:space:]]*(#.*)?$") { in_section = 1; next }
    in_section && /^[^[:space:]#]/ { in_section = 0 }
    in_section && $0 ~ ("^[[:space:]]+" key ":[[:space:]]*[^[:space:]]") {
      value = $0
      sub("^[[:space:]]+" key ":[[:space:]]*", "", value)
      gsub("^[\"" q "]|[\"" q "]?[[:space:]]*$", "", value)
      print value
      exit
    }
  ' "$RELAY_CONFIG" | grep .
}

relay_config_advertised_address() {
  [[ -f "$RELAY_CONFIG" && ! -L "$RELAY_CONFIG" ]] || return 1
  awk -v q="'" '
    /^[[:space:]]+advertised_addresses:[[:space:]]*(#.*)?$/ { in_list = 1; next }
    in_list && /^[[:space:]]+-[[:space:]]*[^[:space:]]/ {
      value = $0
      sub(/^[[:space:]]+-[[:space:]]*/, "", value)
      gsub("^[\"" q "]|[\"" q "]?[[:space:]]*$", "", value)
      print value
      exit
    }
    in_list && !/^[[:space:]]+-/ { in_list = 0 }
  ' "$RELAY_CONFIG" | grep .
}

# A relay that enrolled before has its identity and configuration; re-running the installer without a token keeps both
# and takes what was not given from that configuration, as the other node installers do.
RELAY_ENROLLED=0
RERUN_WITHOUT_TOKEN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway) GATEWAY="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --gateway-cert-sha256) GATEWAY_CERT_SHA256="$2"; shift 2 ;;
    --advertise-address) ADVERTISE_ADDRESS="$2"; shift 2 ;;
    --service-port) SERVICE_PORT="$2"; SERVICE_PORT_GIVEN=1; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --disable-console) DISABLE_CONSOLE=1; shift ;;
    --disable-files) DISABLE_FILES=1; shift ;;
    --protected) PROTECTED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID} -eq 0 ]] || { echo "Run this installer as root" >&2; exit 1; }
[[ -s "$RELAY_IDENTITY" && -f "$RELAY_CONFIG" ]] && RELAY_ENROLLED=1
if [[ "$RELAY_ENROLLED" -eq 1 && -z "$TOKEN" ]]; then
  RERUN_WITHOUT_TOKEN=1
  [[ -n "$GATEWAY" ]] || GATEWAY=$(relay_config_value gateway address || true)
  [[ -n "$GATEWAY_CERT_SHA256" ]] || GATEWAY_CERT_SHA256=$(relay_config_value gateway cert_sha256 || true)
  [[ -n "$ADVERTISE_ADDRESS" ]] || ADVERTISE_ADDRESS=$(relay_config_advertised_address || true)
  [[ "$SERVICE_PORT_GIVEN" -eq 1 ]] || SERVICE_PORT=$(relay_config_value worker service_port || echo "$SERVICE_PORT")
  if [[ -z "$GATEWAY" || -z "$GATEWAY_CERT_SHA256" || -z "$ADVERTISE_ADDRESS" ]]; then
    echo "This relay is enrolled, but ${RELAY_CONFIG} does not name its Opfield address, certificate pin and advertised address; pass --gateway, --gateway-cert-sha256 and --advertise-address." >&2
    usage >&2
    exit 2
  fi
fi
[[ -n "$GATEWAY" && ( -n "$TOKEN" || "$RERUN_WITHOUT_TOKEN" -eq 1 ) && -n "$GATEWAY_CERT_SHA256" && -n "$ADVERTISE_ADDRESS" ]] || { usage >&2; exit 2; }
[[ "$SERVICE_PORT" =~ ^[0-9]+$ && "$SERVICE_PORT" -ge 1 && "$SERVICE_PORT" -le 65535 ]] || { echo "Invalid service port" >&2; exit 2; }
resolve_run_identity || exit 1

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# The relay release the feed names as its target ('' without one). Read without jq: a dry run installs nothing, jq
# included. The target is the only release in the answer, and its tag_name comes first.
relay_feed_tag() {
  curl -fsSL "${RELEASES_API_URL}?component=relay" 2>>"$LOG_FILE" | tr -d '\n' \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-relay"' | head -n 1 \
    | sed -E 's/.*"(v[^"]+)"$/\1/' || true
}

# Shows what a real run does, without installing dependencies or changing the host.
relay_dry_run() {
  local version="$VERSION" manager="manual mode (not persistent across reboot)"
  if [[ "$version" == "latest" ]]; then
    if ! command_exists curl; then
      echo "curl is required to resolve the latest Relay release during a dry run; install curl or pass --version." >&2
      exit 1
    fi
    version=$(relay_feed_tag)
    [[ -n "$version" ]] || { echo "Could not resolve the latest Relay release from ${RELEASES_API_URL}; pass --version." >&2; exit 1; }
    version=$(relay_version_to_install latest "${version%-relay}")
    version="v${version#v}"
  else
    version="v${version#v}"
  fi
  has_systemd && manager="systemd unit gateway-relay-supervisor"
  ! has_openrc || has_systemd || manager="OpenRC service gateway-relay-supervisor"
  echo "Dry run: Relay supervisor ${version} (${ARCH}) for Opfield ${GATEWAY}, advertised at ${ADVERTISE_ADDRESS}:${SERVICE_PORT}."
  if [[ "$RERUN_WITHOUT_TOKEN" -eq 1 ]]; then
    echo "The relay is enrolled and no token was given: it keeps its identity (Opfield address, certificate pin and advertised address come from its configuration unless given)."
  elif [[ "$RELAY_ENROLLED" -eq 1 ]]; then
    echo "The relay is enrolled and a token was given: it re-enrolls, and keeps its previous identity if Opfield refuses the token."
  fi
  if [[ "$PREVIOUS_RUN_UID" != 0 && "$PREVIOUS_RUN_UID" != "$(id -u "$RUN_USER")" ]]; then
    echo "Would stop the relay supervisor and switch it from $(id -nu "$PREVIOUS_RUN_UID" 2>/dev/null || echo "uid ${PREVIOUS_RUN_UID}") to ${RUN_USER}."
  fi
  echo "Would install the signed relay-supervisor and relay worker binaries and run them as ${RUN_USER}:${RUN_GROUP} under the ${manager}."
  needs_bind_capability && echo "Would grant ${RUN_USER} CAP_NET_BIND_SERVICE for port ${SERVICE_PORT}."
  [[ "$DISABLE_CONSOLE" != "1" ]] || echo "Would write console.enabled: false to /etc/gateway-relay-supervisor/config.yaml."
  [[ "$DISABLE_FILES" != "1" ]] || echo "Would write files.enabled: false to /etc/gateway-relay-supervisor/config.yaml."
  if [[ "$PROTECTED" == "1" ]] || relay_protected_setting "$RELAY_CONFIG" enabled; then
    echo "Would write protected.enabled: true to /etc/gateway-relay-supervisor/config.yaml (protected mode)."
  fi
  echo "Would wait for the relay to enroll and connect to Opfield."
  echo "Dry run completed; no host changes were made."
}
if [[ "$DRY_RUN" -eq 1 ]]; then
  relay_dry_run
  exit 0
fi
open_setup_log
trap close_setup_log EXIT
echo "Setup log: ${LOG_FILE}"
ensure_dependencies

if [[ "$VERSION" == "latest" ]]; then
  TAG=$(relay_feed_tag)
  [[ -n "$TAG" ]] || { echo "Could not resolve the latest Relay release from ${RELEASES_API_URL}; pass --version." >&2; exit 1; }
  VERSION=$(relay_version_to_install latest "${TAG%-relay}")
fi
VERSION="v${VERSION#v}"
TAG="${VERSION}-relay"

PACKAGE_BASE="${ARTIFACT_BASE_URL%/}/relay-supervisor/${TAG}"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"; close_setup_log' EXIT

cat >"${TEMP_DIR}/update-public-key.pem" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxLXGD8vCYQCYboK301miZXyAaoOLc43zFVnMlH3FeWg=
-----END PUBLIC KEY-----
KEY

decode_base64url() {
  local value="$1" remainder
  value="${value//-/+}"
  value="${value//_/\/}"
  remainder=$(( ${#value} % 4 ))
  [[ "$remainder" -eq 0 ]] || value="${value}$(printf '=%.0s' $(seq 1 $((4 - remainder))))"
  printf '%s' "$value" | openssl base64 -d -A
}

# Where a binary is downloaded from. The signed manifest names its origin URL; a mirror (GATEWAY_ARTIFACT_BASE_URL) serves
# the binary next to its manifest, at the same path under its base. Either way it must match the signed checksum.
relay_artifact_url() {
  local signed_url="$1" name="$2"
  if [[ -n "${GATEWAY_ARTIFACT_BASE_URL:-}" ]]; then
    printf '%s/%s\n' "$PACKAGE_BASE" "$name"
  else
    printf '%s\n' "$signed_url"
  fi
}

fetch_verified() {
  local name="$1" daemon_type="$2"
  local manifest="${TEMP_DIR}/${name}.update.json"
  local payload="${TEMP_DIR}/${name}.payload"
  local signature="${TEMP_DIR}/${name}.sig"
  local binary="${TEMP_DIR}/${name}" url
  curl -fsSL "${PACKAGE_BASE}/${name}.update.json" -o "$manifest"
  [[ "$(jq -r '.schemaVersion' "$manifest")" == "1" && "$(jq -r '.keyId' "$manifest")" == "wiolett-update-v1" ]] || { echo "Untrusted manifest envelope for ${name}" >&2; exit 1; }
  decode_base64url "$(jq -r '.payload' "$manifest")" >"$payload"
  decode_base64url "$(jq -r '.signature' "$manifest")" >"$signature"
  openssl pkeyutl -verify -pubin -inkey "${TEMP_DIR}/update-public-key.pem" -rawin -in "$payload" -sigfile "$signature" >/dev/null
  [[ "$(jq -r '.kind' "$payload")" == "daemon-binary" && "$(jq -r '.version' "$payload")" == "$VERSION" && "$(jq -r '.tag' "$payload")" == "$TAG" && "$(jq -r '.daemonType' "$payload")" == "$daemon_type" && "$(jq -r '.arch' "$payload")" == "$ARCH" && "$(jq -r '.artifactName' "$payload")" == "$name" ]] || { echo "Manifest scope mismatch for ${name}" >&2; exit 1; }
  url=$(relay_artifact_url "$(jq -r '.downloadUrl' "$payload")" "$name")
  curl -fsSL "$url" -o "$binary" || { echo "Could not download ${name} from ${url}" >&2; exit 1; }
  [[ "$(sha256sum "$binary" | awk '{print $1}')" == "$(jq -r '.sha256' "$payload")" ]] || { echo "Checksum mismatch for ${name}" >&2; exit 1; }
}

SUPERVISOR="relay-supervisor-linux-${ARCH}"
WORKER="relay-worker-linux-${ARCH}"
fetch_verified "$SUPERVISOR" relay
fetch_verified "$WORKER" relay-worker

prepare_run_user_switch
install -d -m 0700 /etc/gateway-relay-supervisor /var/lib/gateway-relay-supervisor /usr/local/lib/gateway-relay
install_supervisor_binary "${TEMP_DIR}/${SUPERVISOR}" /usr/local/bin/relay-supervisor /usr/local/lib/gateway-relay/bin
install -m 0755 "${TEMP_DIR}/${WORKER}" /usr/local/lib/gateway-relay/gateway-relay
cat >/usr/local/lib/gateway-relay/run-supervisor <<'RUNNER'
#!/bin/sh
set -eu
exec /usr/local/bin/relay-supervisor run "$@"
RUNNER
chmod 0755 /usr/local/lib/gateway-relay/run-supervisor
if host_feature_disabled /etc/gateway-relay-supervisor/config.yaml console; then DISABLE_CONSOLE=1; fi
if host_feature_disabled /etc/gateway-relay-supervisor/config.yaml files; then DISABLE_FILES=1; fi
if relay_protected_setting /etc/gateway-relay-supervisor/config.yaml enabled; then PROTECTED=1; fi
if relay_protected_setting /etc/gateway-relay-supervisor/config.yaml allow_database_witness; then ALLOW_DATABASE_WITNESS=1; fi
HOST_IDENTITY_PATH=/var/lib/gateway/host-identity
if [[ "$RUN_USER" != "root" ]]; then
  HOST_IDENTITY_PATH=/var/lib/gateway-relay-supervisor/host-identity
  seed_host_identity_copy /var/lib/gateway/host-identity "$HOST_IDENTITY_PATH" \
    || { echo "Could not prepare the relay host identity; Relay installation stopped." >&2; exit 1; }
fi
# Without a token the supervisor keeps its identity: a token in the configuration of an enrolled supervisor starts a
# re-enrollment.
GATEWAY_TOKEN_YAML=""
[[ -z "$TOKEN" ]] || GATEWAY_TOKEN_YAML=$'\n'"  token: ${TOKEN}"
cat >/etc/gateway-relay-supervisor/config.yaml <<CONFIG
gateway:
  address: ${GATEWAY}${GATEWAY_TOKEN_YAML}
  cert_sha256: ${GATEWAY_CERT_SHA256}
tls:
  ca_cert: /var/lib/gateway-relay-supervisor/supervisor-identity/ca.pem
  client_cert: /var/lib/gateway-relay-supervisor/supervisor-identity/node.pem
  client_key: /var/lib/gateway-relay-supervisor/supervisor-identity/node-key.pem
state_dir: /var/lib/gateway-relay-supervisor
host_identity_path: ${HOST_IDENTITY_PATH}
log_level: info
log_format: json
worker:
  binary_path: /usr/local/lib/gateway-relay/gateway-relay
  identity_dir: /var/lib/gateway-relay-supervisor/worker-identity
  state_dir: /var/lib/gateway-relay-supervisor/worker-state
  service_port: ${SERVICE_PORT}
  advertised_addresses:
    - ${ADVERTISE_ADDRESS}
CONFIG
if [[ "$DISABLE_CONSOLE" == "1" ]]; then
  printf 'console:\n  enabled: false\n' >>/etc/gateway-relay-supervisor/config.yaml
  echo "console.enabled: false written to /etc/gateway-relay-supervisor/config.yaml"
fi
if [[ "$DISABLE_FILES" == "1" ]]; then
  printf 'files:\n  enabled: false\n' >>/etc/gateway-relay-supervisor/config.yaml
  echo "files.enabled: false written to /etc/gateway-relay-supervisor/config.yaml"
fi
if [[ "$PROTECTED" == "1" || "$ALLOW_DATABASE_WITNESS" == "1" ]]; then
  PROTECTED_YAML=false
  WITNESS_YAML=false
  [[ "$PROTECTED" != "1" ]] || PROTECTED_YAML=true
  [[ "$ALLOW_DATABASE_WITNESS" != "1" ]] || WITNESS_YAML=true
  printf 'protected:\n  enabled: %s\n  allow_database_witness: %s\n' "$PROTECTED_YAML" "$WITNESS_YAML" >>/etc/gateway-relay-supervisor/config.yaml
  [[ "$PROTECTED" != "1" ]] || echo "protected.enabled: true written to /etc/gateway-relay-supervisor/config.yaml (protected mode)"
fi
chmod 0600 /etc/gateway-relay-supervisor/config.yaml
# The supervisor records whether Gateway accepted the token written above. A relay that is already enrolled keeps its
# previous identity when the token is refused (used, expired, wrong node), so only this record tells the two apart.
ENROLLMENT_RESULT=/var/lib/gateway-relay-supervisor/enrollment-result.json
REENROLLMENT=0
[[ ! -s /var/lib/gateway-relay-supervisor/supervisor-identity/node.pem ]] || REENROLLMENT=1
rm -f "$ENROLLMENT_RESULT"
grant_relay_paths_to_run_user /etc/gateway-relay-supervisor /var/lib/gateway-relay-supervisor /usr/local/lib/gateway-relay
UNIT_CAPABILITIES=""
OPENRC_CAPABILITIES=""
if needs_bind_capability; then
  UNIT_CAPABILITIES=$'\nAmbientCapabilities=CAP_NET_BIND_SERVICE'
  OPENRC_CAPABILITIES=$'\ncapabilities="^cap_net_bind_service"'
fi

# A host with systemd or OpenRC runs the supervisor as a service, and a service that does not start fails the install.
# Manual mode is only for hosts without a service manager.
start_relay_supervisor() {
  retire_legacy_update_guard "gateway-relay-supervisor" "/usr/local/bin/relay-supervisor"

  if has_systemd; then
    cat >/etc/systemd/system/gateway-relay-supervisor.service <<UNIT || fail_supervisor_start "Could not write the relay supervisor systemd unit."
[Unit]
Description=Opfield Relay Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/lib/gateway-relay/run-supervisor
Restart=always
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=1048576${UNIT_CAPABILITIES}

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload >>"$LOG_FILE" 2>&1 && systemctl enable gateway-relay-supervisor >>"$LOG_FILE" 2>&1 \
      || fail_supervisor_start "Could not register the relay supervisor with systemd."
    forget_gateway_session
    systemctl restart gateway-relay-supervisor >>"$LOG_FILE" 2>&1 || fail_supervisor_start "Could not start the relay supervisor."
  elif has_openrc; then
    cat >/etc/init.d/gateway-relay-supervisor <<UNIT || fail_supervisor_start "Could not write the relay supervisor OpenRC service."
#!/sbin/openrc-run
name="Opfield Relay Supervisor"
description="Opfield Relay Supervisor"
command="/usr/local/lib/gateway-relay/run-supervisor"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=3${OPENRC_CAPABILITIES}
output_log="/var/log/gateway-relay-supervisor.log"
error_log="/var/log/gateway-relay-supervisor.err"

depend() {
    need net
}

# supervise-daemon opens the log files after it drops to the service user; a file left by another user (or by root
# before the daemon switched users) would fail it with EACCES, so root hands them over first.
start_pre() {
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/gateway-relay-supervisor.log
    checkpath --file --owner ${RUN_USER}:${RUN_GROUP} --mode 0640 /var/log/gateway-relay-supervisor.err
}
UNIT
    chmod +x /etc/init.d/gateway-relay-supervisor && rc-update add gateway-relay-supervisor default >>"$LOG_FILE" 2>&1 \
      || fail_supervisor_start "Could not register the relay supervisor with OpenRC."
    forget_gateway_session
    if ! rc-service gateway-relay-supervisor restart >>"$LOG_FILE" 2>&1 && ! rc-service gateway-relay-supervisor start >>"$LOG_FILE" 2>&1; then
      fail_supervisor_start "Could not start the relay supervisor with OpenRC."
    fi
  else
    echo "No supported service manager found; using manual mode." >&2
    manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor" \
      || fail_supervisor_start "Could not start the relay supervisor in manual mode."
  fi
  echo "Relay supervisor started."
}

# The relay is installed once Gateway accepted the token written above and then a session of the supervisor this run
# started. A supervisor too old to record its session must have enrolled and keep running for 10 s instead.
await_enrollment() {
  local waited=0 outcome error enrolled=0 running=0
  # Without a token there is no enrollment to wait for: the relay is enrolled and only has to connect.
  [[ -n "$TOKEN" ]] || enrolled=1
  while [[ "$waited" -lt "$ENROLLMENT_WAIT_SECONDS" ]]; do
    if [[ "$enrolled" -eq 0 && -s "$ENROLLMENT_RESULT" ]]; then
      outcome=$(jq -r '.outcome // empty' "$ENROLLMENT_RESULT" 2>/dev/null || true)
      error=$(jq -r '.error // empty' "$ENROLLMENT_RESULT" 2>/dev/null || true)
      if [[ "$outcome" == "enrolled" ]]; then
        echo "Relay enrolled with Opfield."
        enrolled=1
      elif [[ "$outcome" == "failed" ]]; then
        if [[ "$REENROLLMENT" -eq 1 ]]; then
          echo "Relay re-enrollment failed: ${error}" >&2
          echo "The relay keeps running with its previous identity. Issue a new re-enroll token in Opfield (Settings > Relay) and run the installer again." >&2
        else
          echo "Relay enrollment failed: ${error}" >&2
          echo "Create a new enrollment token in Opfield and run the installer again." >&2
        fi
        return 1
      fi
    fi
    if [[ "$enrolled" -eq 1 ]]; then
      if daemon_records_gateway_session "$VERSION"; then
        if gateway_session_is_current; then
          echo "Relay supervisor is connected to Opfield."
          return 0
        fi
      elif supervisor_service_running; then
        running=$((running + 1))
        if [[ "$running" -ge 10 ]]; then
          echo "Relay supervisor ${VERSION} does not report its Opfield connection; check that the relay is online in Opfield." >&2
          return 0
        fi
      else
        running=0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if ! supervisor_service_running; then
    echo "The relay supervisor is not running; the service manager could not keep it up. The log below shows why." >&2
  elif [[ "$enrolled" -eq 1 ]]; then
    echo "The relay supervisor has not connected to Opfield within ${ENROLLMENT_WAIT_SECONDS} s; check that Opfield at ${GATEWAY} is reachable and the supervisor log." >&2
  else
    echo "The relay supervisor has not reported its enrollment within ${ENROLLMENT_WAIT_SECONDS} s; check that Opfield at ${GATEWAY} is reachable and the supervisor log." >&2
  fi
  return 2
}

start_relay_supervisor
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]] && needs_bind_capability; then
  echo "Manual mode cannot grant ${RUN_USER} the right to bind port ${SERVICE_PORT}; use a port from 1024 or a service manager." >&2
fi
enrollment_status=0
await_enrollment || enrollment_status=$?
if [[ "$enrollment_status" -eq 1 && "$REENROLLMENT" -eq 1 ]]; then
  # Gateway refused the token of a re-enrollment: the relay keeps running as it was, but that is not what was asked.
  echo "Relay supervisor ${VERSION} is installed and the relay keeps running with its previous identity, but it was not re-enrolled." >&2
  echo "To keep the relay as it is, run the installer again without --token." >&2
  supervisor_log_hint
  exit 1
fi
if [[ "$enrollment_status" -ne 0 ]]; then
  # A timeout is a failure too: a supervisor that cannot start never reports, and the relay is not usable.
  echo "Relay supervisor ${VERSION} is installed, but the relay is not enrolled and connected to Opfield." >&2
  supervisor_log_hint
  exit 1
fi
echo "Relay supervisor ${VERSION} installed. Ensure TCP ${SERVICE_PORT} is reachable at ${ADVERTISE_ADDRESS}."
