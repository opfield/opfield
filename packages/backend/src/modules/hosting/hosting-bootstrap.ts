import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
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
export const HOSTING_INSTALLER_REVISION = '58d708bef30110bcc70a48ece0d32785b21001f4';
export const HOSTING_INSTALLER_BASE = `https://raw.githubusercontent.com/opfield/opfield/${HOSTING_INSTALLER_REVISION}/scripts`;
const INSTALLER_SHA256: Record<string, string> = {
  'setup-node.sh': 'c5afa65657389f9d3aa0a0b8c8e4e8410c598b6c6af4416e37c5db558450e560',
  'setup-docker-node.sh': '31368ab6e92df1f284eac18fc9abe85214893ab0940854c9b68e99dd4ce57b1c',
  'setup-database-node.sh': '955cba6ef03e9685e60371085b5d5086bd010be1d684c90c6e867384b1356a60',
  'setup-storage-node.sh': '2af126db47e45e8350873eb13d17f73446fa77824c92d4ccfe9b15461548fc08',
  'setup-monitoring-node.sh': '8915cd4c65a1af50948e2f367dde54a5e8b41f43c1abf906cf69b0519b2616a8',
  'setup-relay-node.sh': '6b5d2b3429b7dfe36c6270cbf4b02f0aea582d609b72b7221cd7eef8e314bf8d',
};

export function shellArgument(value: string): string {
  if (value.includes('\0') || /[\r\n]/.test(value))
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid bootstrap argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildHostingBootstrap(input: {
  role: HostingRole;
  gateway: string;
  token: string;
  certificateFingerprint: string;
  relayAddress?: string;
  requireCleanHost?: boolean;
  operationMarker?: string;
  expectedOperationMarker?: string;
  waitForCloudInit?: boolean;
}): string {
  if (!INSTALLERS[input.role]) throw new AppError(400, 'HOSTING_ROLE_UNSUPPORTED', 'Unsupported node role');
  if (!input.gateway || !/^sha256:[a-f0-9]{64}$/i.test(input.certificateFingerprint))
    throw new AppError(
      409,
      'HOSTING_OPFIELD_NOT_READY',
      'Configure the Opfield enrollment endpoint and certificate first'
    );
  const url = new URL(`https://${input.gateway}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new AppError(400, 'HOSTING_OPFIELD_INVALID', 'Invalid Opfield enrollment endpoint');
  // legacy-name: --gateway flags — the pinned installer (HOSTING_INSTALLER_REVISION) predates --opfield; switch with the
  // next pin of a release whose installers take --opfield and --opfield-cert-sha256.
  const args = [
    '--gateway',
    input.gateway,
    '--token',
    input.token,
    '--gateway-cert-sha256',
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
if [ -s /var/lib/gateway/host-identity ]; then
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
mkdir -p /var/lib/gateway
# The lock also fences a timed-out installer that is still running inside the guest.
exec 9>/var/lib/gateway/hosting-install.lock
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
    ? `if [ "$(cat /var/lib/gateway/hosting-operation 2>/dev/null || true)" != ${shellArgument(input.expectedOperationMarker)} ] && { [ -s /var/lib/gateway/hosting-operation ] || [ -s /var/lib/gateway/host-identity ]; }; then
  echo 'This guest is not the original hosting installation target' >&2
  exit 45
fi`
    : ''
}
${clean}
${
  input.operationMarker
    ? `mkdir -p /var/lib/gateway
printf '%s\\n' ${shellArgument(input.operationMarker)} > /var/lib/gateway/hosting-operation
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

export function validateHostingGateway(value: string, allowPrivate: boolean): void {
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
