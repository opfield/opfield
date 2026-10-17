import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
import { LEGACY_STATE_ROOT } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
import { isPubliclyRoutableIp } from '@/modules/nodes/node-service-address.js';
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
export const HOSTING_INSTALLER_REVISION = 'edbef9760ecec5a942e0fbcb257f7dfbae1a4007';
export const HOSTING_INSTALLER_BASE = `https://raw.githubusercontent.com/opfield/opfield/${HOSTING_INSTALLER_REVISION}/scripts`;
const INSTALLER_SHA256: Record<string, string> = {
  'setup-node.sh': '4fa8b6f4a123692f75d8ba0afb2bc889cd04f6253531d246b76d7a914f99bfa5',
  'setup-docker-node.sh': '5b0a78c9f55af8e628342c620cfcac33ecb7ac9805ac55092348db6e84d8a60e',
  'setup-database-node.sh': 'e723e6dbd0d479f1e0197461206722688a64a6b22a4e7b408d23e5aa588be984',
  'setup-storage-node.sh': '9c6e8b709e494a35e41a976f1f96539fede89619530c552af3af01c23a3d74a8',
  'setup-monitoring-node.sh': 'f256587500fa949c4d5360895b4dc9640a350d999d9f39e29956047aa38ca2b0',
  'setup-relay-node.sh': '5b2c4505e01969489acee9b4e98966fc003b611460b0a29733833376d32d7ff5',
};

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
  requireCleanHost?: boolean;
  operationMarker?: string;
  expectedOperationMarker?: string;
  waitForCloudInit?: boolean;
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
  return `#!/bin/bash
set -eu
umask 077
mkdir -p /var/lib/opfield
# The lock also fences a timed-out installer that is still running inside the guest.
exec 9>/var/lib/opfield/hosting-install.lock
flock -n 9 || { echo 'An Opfield hosting installer is already running' >&2; exit 44; }
${
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
trap 'rm -f "$installer_dir"/setup-*.sh; rmdir "$installer_dir"' EXIT
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
bash "$installer" ${args.map(shellArgument).join(' ')}
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
