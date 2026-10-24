import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
import { LEGACY_STATE_ROOT } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import { isPubliclyRoutableIp } from '@/modules/nodes/node-service-address.js';
import { DEFAULT_RELAY_SERVICE_PORT } from '@/services/relay-service-endpoint.js';
import type { HostingRole } from './hosting-provider.types.js';

const INSTALLERS: Record<HostingRole, string> = {
  nginx: 'setup-node.sh',
  docker: 'setup-docker-node.sh',
  builder: 'setup-docker-node.sh',
  databases: 'setup-database-node.sh',
  storage: 'setup-storage-node.sh',
  monitoring: 'setup-monitoring-node.sh',
  relay: 'setup-relay-node.sh',
};
// Published revision containing the Storage wrapper and self-sufficient Relay installation.
// Update revision and hashes together after publishing installer changes.
export const HOSTING_INSTALLER_REVISION = 'b4cbbb7c4ebe1f4904f90313d7a2bf8b0f7f18c6';
export const HOSTING_INSTALLER_BASE = `https://raw.githubusercontent.com/opfield/opfield/${HOSTING_INSTALLER_REVISION}/scripts`;
const INSTALLER_SHA256: Record<string, string> = {
  'setup-node.sh': 'e34bc09f0b5fc4394c8e3ed8f725bee7ba58d285d3a5a6674dc1bd60c2a36f9b',
  'setup-docker-node.sh': '707ab131f65bd2be7f8b858c01e1a44de8a2aa127a69835f7426a1dcbbed446e',
  'setup-database-node.sh': 'ebc4491d05f65cc13553f3de8d9b089f514c2e9a1b0f7fe3ac23966c3d1b4eba',
  'setup-storage-node.sh': 'b1fc4d0ac01a766b88a11698fc2b97f11351adfa6b9423b82ea9401fc4fb864d',
  'setup-monitoring-node.sh': '6c4d1f76ff001db05e3c18f2b5ed5cabfa6ea131ad5dd5ff34423d78780a1851',
  'setup-relay-node.sh': '908df4d0bb81c655ef704306561de6b640ae2b8cde18fe70c8fcb95ea495e895',
};

/** Written by a reportResult bootstrap when it ends; read through the guest agent (root-only, 0600). */
export const HOSTING_INSTALL_RESULT_FILE = '/var/lib/opfield/hosting-install.result';
const HOSTING_INSTALL_LOG_FILE = '/var/lib/opfield/hosting-install.log';

export interface HostingInstallResult {
  marker: string;
  exitCode: number;
  output: string[];
}

export function parseHostingInstallResult(content: string): HostingInstallResult | null {
  const lines = content.split('\n');
  const marker = lines[0]?.match(/^marker=(gw-[0-9a-f-]{36})$/)?.[1];
  const exit = lines[1]?.match(/^exit=(\d{1,3})$/)?.[1];
  if (!marker || exit === undefined) return null;
  return { marker, exitCode: Number(exit), output: lines.slice(2).filter((line) => line.trim()) };
}

/** The installer's own error lines, readable and bounded, for the operation's error message. */
export function hostingInstallFailureMessage(result: HostingInstallResult): string {
  const clean = result.output.map((line) =>
    line
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/^\s*(ERROR|WARN|INFO|OK)\s+/, '')
      .trim()
  );
  const errors = result.output
    .map((line, index) => (/^\s*ERROR\b/.test(line) ? clean[index] : ''))
    .filter((line) => line && !/^Daemon log:/.test(line) && !/^Installation completed with errors/.test(line));
  const detail = (errors.length ? errors.slice(0, 2) : clean.filter(Boolean).slice(-1))
    .join(' ')
    .slice(0, 400)
    .replace(/[.\s]+$/, '');
  return `The node installer failed on the VM (exit ${result.exitCode})${detail ? `: ${detail}` : ''}. Fix the cause, then retry installation on this VM.`;
}

export function shellArgument(value: string): string {
  if (value.includes('\0') || /[\r\n]/.test(value))
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid bootstrap argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildHostingBootstrap(input: {
  role: HostingRole;
  opfieldAddress: string;
  token: string;
  certificateFingerprint: string;
  relayAddress?: string;
  /** The relay port; the installer's default (9443) when omitted. */
  relayServicePort?: number;
  requireCleanHost?: boolean;
  operationMarker?: string;
  expectedOperationMarker?: string;
  waitForCloudInit?: boolean;
  /**
   * Cloud-init runs the installer and nobody waits for it: write its exit status and last output lines to
   * HOSTING_INSTALL_RESULT_FILE, which Opfield reads through the guest agent, so a failed installation ends at once with
   * the installer's error instead of at the bootstrap deadline. Requires operationMarker.
   */
  reportResult?: boolean;
}): string {
  if (!INSTALLERS[input.role]) throw new AppError(400, 'HOSTING_ROLE_UNSUPPORTED', 'Unsupported node role');
  if (!input.opfieldAddress || !/^sha256:[a-f0-9]{64}$/i.test(input.certificateFingerprint))
    throw new AppError(
      409,
      'HOSTING_OPFIELD_NOT_READY',
      'Configure the Opfield enrollment endpoint and certificate first'
    );
  const url = new URL(`https://${input.opfieldAddress}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new AppError(400, 'HOSTING_OPFIELD_INVALID', 'Invalid Opfield enrollment endpoint');
  const args = [
    '--opfield',
    input.opfieldAddress,
    '--token',
    input.token,
    '--opfield-cert-sha256',
    input.certificateFingerprint,
  ];
  if (input.role !== 'relay') args.push('--yes');
  if (input.role === 'builder') args.push('--mode', 'builder');
  if (input.role === 'relay') {
    if (!input.relayAddress)
      throw new AppError(400, 'HOSTING_RELAY_ADDRESS_REQUIRED', 'Relay advertised address is required');
    args.push('--advertise-address', input.relayAddress);
    if (input.relayServicePort !== undefined && input.relayServicePort !== DEFAULT_RELAY_SERVICE_PORT) {
      if (!Number.isInteger(input.relayServicePort) || input.relayServicePort < 1 || input.relayServicePort > 65535)
        throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid relay port');
      args.push('--service-port', String(input.relayServicePort));
    }
  }
  const clean = input.requireCleanHost
    ? `
# A cloned template must never inherit another Opfield host identity or certificate.
# legacy-name: the legacy state root of guests installed before 2.12.1 — remove once every node reports none
if [ -s /var/lib/opfield/host-identity ] || [ -s ${LEGACY_STATE_ROOT}/host-identity ]; then
  echo 'Opfield identity already exists; refusing to adopt or reinstall a cloned identity' >&2
  exit 42
fi
`
    : '';
  if (
    [input.operationMarker, input.expectedOperationMarker].some(
      (marker) => marker && !/^gw-[0-9a-f-]{36}$/.test(marker)
    )
  )
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid hosting operation marker');
  if (input.reportResult && !input.operationMarker)
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'An installation result needs its operation marker');
  const report = input.reportResult
    ? `set -o pipefail
# The result names this operation, so a stale file from another attempt is never taken for this one's.
rm -f ${HOSTING_INSTALL_RESULT_FILE} ${HOSTING_INSTALL_LOG_FILE}
report_install_result() {
  { printf 'marker=%s\\n' ${shellArgument(input.operationMarker!)}; printf 'exit=%s\\n' "$1"
    tail -n 30 ${HOSTING_INSTALL_LOG_FILE} 2>/dev/null | sed -e 's/\\x1b\\[[0-9;]*m//g' | grep -v 'Token:' | cut -c1-300 || true
  } > ${HOSTING_INSTALL_RESULT_FILE}.tmp 2>/dev/null || true
  # SELinux confines the guest agent (Fedora): it may read its own temporary files, not var_lib_t.
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then chcon -t virt_qemu_ga_tmp_t ${HOSTING_INSTALL_RESULT_FILE}.tmp 2>/dev/null || true; fi
  mv -f ${HOSTING_INSTALL_RESULT_FILE}.tmp ${HOSTING_INSTALL_RESULT_FILE} 2>/dev/null || true
}
trap 'report_install_result $?' EXIT
# The bootstrap's own refusals (exit 42-48) go to the log the result is taken from; the installer's output is teed there.
exec 2>>${HOSTING_INSTALL_LOG_FILE}
`
    : '';
  return `#!/bin/bash
set -eu
umask 077
mkdir -p /var/lib/opfield
# The lock also fences a timed-out installer that is still running inside the guest.
exec 9>/var/lib/opfield/hosting-install.lock
flock -n 9 || { echo 'An Opfield hosting installer is already running' >&2; exit 44; }
${report}${
  input.waitForCloudInit
    ? `# QGA and SSH come up before cloud-init finishes package/network setup. Never race its package manager.
if command -v cloud-init >/dev/null 2>&1; then
  timeout 600 cloud-init status --wait >/dev/null 2>&1 || { echo 'Cloud-init did not finish successfully' >&2; exit 46; }
fi
# Boot-time package runs (apt-daily, unattended-upgrades) hold the package locks for a while after cloud-init.
# unattended-upgrade-shutdown idles for the whole uptime and holds no lock, so only the upgrade run itself counts.
if command -v pidof >/dev/null 2>&1; then
  waited=0
  while pidof apt apt-get dpkg yum dnf apk >/dev/null 2>&1 || pgrep -f '/usr/bin/unattended-upgrade( |$)' >/dev/null 2>&1; do
    [ "$waited" -ge 600 ] && { echo 'A package manager on the server kept running for 10 minutes' >&2; exit 48; }
    sleep 5
    waited=$((waited + 5))
  done
fi`
    : ''
}
${
  input.expectedOperationMarker
    ? `# legacy-name: markers in the legacy state root of an installation attempt before 2.12.1 — remove once every node reports none
marker=$(cat /var/lib/opfield/hosting-operation 2>/dev/null || cat ${LEGACY_STATE_ROOT}/hosting-operation 2>/dev/null || true)
if [ "$marker" != ${shellArgument(input.expectedOperationMarker)} ] && { [ -n "$marker" ] || [ -s /var/lib/opfield/host-identity ] || [ -s ${LEGACY_STATE_ROOT}/host-identity ]; }; then
  echo 'This guest is not the original hosting installation target' >&2
  exit 45
fi`
    : ''
}
${clean}
${
  input.operationMarker
    ? `mkdir -p /var/lib/opfield
printf '%s\\n' ${shellArgument(input.operationMarker)} > /var/lib/opfield/hosting-operation
`
    : ''
}
installer_dir=$(mktemp -d)
${
  input.reportResult
    ? `trap 'status=$?; rm -f "$installer_dir"/setup-*.sh; rmdir "$installer_dir"; report_install_result "$status"' EXIT`
    : `trap 'rm -f "$installer_dir"/setup-*.sh; rmdir "$installer_dir"' EXIT`
}
fetch_installer() {
local installer="$installer_dir/$1" expected="$2"
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 "${HOSTING_INSTALLER_BASE}/$1" -o "$installer"
elif command -v wget >/dev/null 2>&1; then
  wget --timeout=120 -qO "$installer" "${HOSTING_INSTALLER_BASE}/$1"
else
  echo 'The selected image needs curl or wget' >&2
  exit 43
fi
printf '%s  %s\\n' "$expected" "$installer" | sha256sum -c - >/dev/null || { echo 'Installer integrity check failed' >&2; exit 47; }
chmod 0700 "$installer"
}
${input.role === 'databases' || input.role === 'storage' ? `fetch_installer 'setup-docker-node.sh' '${INSTALLER_SHA256['setup-docker-node.sh']}'` : ''}
${input.role === 'storage' ? `fetch_installer 'setup-database-node.sh' '${INSTALLER_SHA256['setup-database-node.sh']}'` : ''}
fetch_installer '${INSTALLERS[input.role]}' '${INSTALLER_SHA256[INSTALLERS[input.role]]}'
installer="$installer_dir/${INSTALLERS[input.role]}"
${
  input.reportResult
    ? `bash "$installer" ${args.map(shellArgument).join(' ')} 2>&1 | tee -a ${HOSTING_INSTALL_LOG_FILE}`
    : `bash "$installer" ${args.map(shellArgument).join(' ')}`
}
`;
}

export function validateHostingOpfieldAddress(value: string, allowPrivate: boolean): void {
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new AppError(400, 'HOSTING_OPFIELD_INVALID', 'Invalid Opfield enrollment endpoint');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || !url.port)
    throw new AppError(400, 'HOSTING_OPFIELD_INVALID', 'A remotely reachable Opfield endpoint with port is required');
  // Private Proxmox connectivity is allowed. Public provider reachability is checked before ordering.
  const ip = normalizeIp(host);
  if (ip && (isAlwaysBlockedOutboundIp(ip) || (!allowPrivate && !isPubliclyRoutableIp(ip))))
    throw new AppError(
      400,
      'HOSTING_OPFIELD_PRIVATE',
      'Set a publicly reachable Opfield gRPC address in General settings so cloud nodes can connect. No VM was ordered.'
    );
}
