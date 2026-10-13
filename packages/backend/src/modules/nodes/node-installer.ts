import { getEnv } from '@/config/env.js';
import { INSTALLER_RELEASES_URL } from '@/config/vendor-urls.js';
import { container } from '@/container.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { DaemonUpdateService, daemonTypeForNodeType } from '@/services/daemon-update.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { DEFAULT_RELAY_SERVICE_PORT, requestedRelayServicePort } from '@/services/relay-service-endpoint.js';

// The update Worker serves a release's installers in GitHub's release download layout.
const RELEASE_DOWNLOADS = `${INSTALLER_RELEASES_URL}/download`;
// An unreleased build has no release assets of its own, so its commands run the installers from main.
const MAIN_INSTALLERS = 'https://raw.githubusercontent.com/opfield/opfield/main/scripts';
const INSTALLER_CHECKSUMS = 'opfield-node-installers.sha256';

export const NODE_INSTALLERS: Readonly<Record<string, string>> = {
  nginx: 'setup-node.sh',
  docker: 'setup-docker-node.sh',
  builder: 'setup-docker-node.sh',
  databases: 'setup-database-node.sh',
  storage: 'setup-storage-node.sh',
  monitoring: 'setup-monitoring-node.sh',
  relay: 'setup-relay-node.sh',
};

/**
 * Installers of this release that take --opfield and --opfield-cert-sha256. The command always runs the installer of
 * this release (or main), so its flags only have to match these scripts.
 */
export const OPFIELD_FLAG_INSTALLERS: ReadonlySet<string> = new Set([
  'setup-node.sh',
  'setup-docker-node.sh',
  'setup-monitoring-node.sh',
  'setup-database-node.sh',
  'setup-storage-node.sh',
  'setup-relay-node.sh',
]);

/** The enrollment address and certificate pin flags the installer of this release understands. */
function enrollmentFlags(installer: string): { address: string; certificate: string } {
  return OPFIELD_FLAG_INSTALLERS.has(installer)
    ? { address: '--opfield', certificate: '--opfield-cert-sha256' }
    : // legacy-name: --gateway flags of installers not yet taking --opfield — remove once every installer does.
      { address: '--gateway', certificate: '--gateway-cert-sha256' };
}

export type InstallTransport = 'curl' | 'wget';

export interface NodeInstallCommand {
  target: 'public' | 'local';
  label: string;
  /** The Opfield gRPC address the command enrolls with. */
  address: string;
  curl: string;
  wget: string;
}

export interface NodeInstallation {
  /** Gateway release the installers come from; null for an unreleased build, whose commands use main. */
  installerRelease: string | null;
  installCommands: NodeInstallCommand[];
}

interface EnrollmentTargets {
  public?: { label: string; address: string | null };
  local?: { label: string; address: string | null };
}

/** The Gateway release tag this build was stamped with. Development and other unreleased builds have none. */
export function installerRelease(appVersion: string): string | null {
  return RELEASE_VERSION_PATTERN.test(appVersion) ? `v${appVersion.replace(/^v/, '')}` : null;
}

/** The browser's host on the gRPC port: what a public target nobody configured yet falls back to. */
export function browserHostOpfield(host: string | undefined): string | null {
  const value = host?.split(',')[0]?.trim();
  if (!value) return null;
  try {
    return `${new URL(`http://${value}`).hostname}:${getEnv().GRPC_PORT}`;
  } catch {
    return null;
  }
}

/** The same fallback for callers without a browser request (AI and MCP tools): the host of the public URL. */
export async function publicUrlFallbackOpfield(): Promise<string | null> {
  if (!container.isRegistered(GeneralSettingsService)) return null;
  const publicUrl = await container.resolve(GeneralSettingsService).getPublicUrl();
  if (!publicUrl) return null;
  try {
    return browserHostOpfield(new URL(publicUrl).host);
  } catch {
    return null;
  }
}

/** Quotes a value for a POSIX shell only when it needs quoting, so ordinary commands stay readable. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * One setup command, shown with line continuations. A release build downloads the installer from its own GitHub
 * release and runs it only when it matches that release's opfield-node-installers.sha256. The steps use tools
 * every supported host has, busybox included (Debian, Ubuntu, RHEL, Alpine). An unreleased build pipes the
 * installer from main, unverified, as before installers were pinned.
 */
export function nodeInstallCommand(input: {
  installer: string;
  release: string | null;
  transport: InstallTransport;
  args: ReadonlyArray<readonly [flag: string, value?: string]>;
  /** One line, for a command shown inline instead of in a copy block. */
  oneLine?: boolean;
}): string {
  const argBreak = input.oneLine ? ' ' : ' \\\n  ';
  const args = input.args
    .map(([flag, value]) => `${argBreak}${flag}${value === undefined ? '' : ` ${shellWord(value)}`}`)
    .join('');
  if (!input.release) {
    const url = `${MAIN_INSTALLERS}/${input.installer}`;
    return `${input.transport === 'curl' ? `curl -sSL ${url}` : `wget -qO- ${url}`} | sudo bash -s --${args}`;
  }
  const base = `${RELEASE_DOWNLOADS}/${input.release}`;
  const download = (file: string) =>
    input.transport === 'curl' ? `curl -fsSL -o ${file} ${base}/${file}` : `wget -qO ${file} ${base}/${file}`;
  return [
    'cd "$(mktemp -d)"',
    download(input.installer),
    download(INSTALLER_CHECKSUMS),
    `grep ' ${input.installer}$' ${INSTALLER_CHECKSUMS} | sha256sum -c -`,
    `sudo bash ${input.installer}${args}`,
  ].join(input.oneLine ? ' && ' : ' && \\\n');
}

/**
 * A docker-daemon running as its own user reports `sudo bash setup-docker-node.sh --user <user> --secure-runtime` as
 * its Secure Runtime command: root never runs that daemon's binary, which its user can replace, so the node installer
 * installs Secure Runtime from a copy it downloads and verifies. Gateway shows it as one line that fetches and checks
 * this release's installer first, like the setup commands. Any other command is shown as the daemon reported it.
 */
export function secureRuntimeLocalCommand(
  command: string,
  release: string | null,
  daemonVersion?: string | null
): string {
  const match =
    /^sudo bash setup-docker-node\.sh --user ([A-Za-z0-9_][A-Za-z0-9_.-]*) --secure-runtime(?: --version (v\d+\.\d+\.\d+(?:-rc\.\d+)?))?$/.exec(
      command
    );
  if (!match) return command;
  const args: Array<readonly [flag: string, value?: string]> = [['--user', match[1] as string], ['--secure-runtime']];
  // The node keeps the daemon version it runs (its daemon names it from 2.11.1 on, else the version it registered):
  // without it the installer offers the latest stable release, which can be older than a release candidate (F-B6).
  const version =
    match[2] ??
    (daemonVersion && RELEASE_VERSION_PATTERN.test(daemonVersion) ? `v${daemonVersion.replace(/^v/, '')}` : null);
  if (version) args.push(['--version', version]);
  return nodeInstallCommand({
    installer: 'setup-docker-node.sh',
    release,
    transport: 'curl',
    args,
    oneLine: true,
  });
}

/** Setup commands for one enrollment token, one per enrollment target that has an address. */
export function nodeInstallCommands(input: {
  nodeType: string;
  release: string | null;
  token: string;
  opfieldCertSha256: string;
  targets: EnrollmentTargets;
  fallbackOpfield?: string | null;
  advertiseAddress?: string | null;
  servicePort?: number | null;
  daemonVersion?: string | null;
}): NodeInstallCommand[] {
  const installer = NODE_INSTALLERS[input.nodeType];
  if (!installer) return [];
  const targets = [
    {
      target: 'public' as const,
      label: input.targets.public?.label ?? 'Public node',
      address: input.targets.public?.address ?? input.fallbackOpfield ?? null,
    },
    ...(input.targets.local
      ? [{ target: 'local' as const, label: input.targets.local.label, address: input.targets.local.address }]
      : []),
  ];
  return targets.flatMap(({ target, label, address }) => {
    if (!address) return [];
    const flags = enrollmentFlags(installer);
    const args: Array<readonly [string, string]> = [
      [flags.address, address],
      ['--token', input.token],
      [flags.certificate, input.opfieldCertSha256],
    ];
    if (input.nodeType === 'builder') args.push(['--mode', 'builder']);
    if (input.advertiseAddress) args.push(['--advertise-address', input.advertiseAddress]);
    // The relay installer binds the default port unless told otherwise; only another port is passed.
    if (input.servicePort && input.servicePort !== DEFAULT_RELAY_SERVICE_PORT)
      args.push(['--service-port', String(input.servicePort)]);
    if (input.daemonVersion) args.push(['--version', input.daemonVersion]);
    const command = (transport: InstallTransport) =>
      nodeInstallCommand({ installer, release: input.release, transport, args });
    return [{ target, label, address, curl: command('curl'), wget: command('wget') }];
  });
}

/**
 * The setup commands of an enrollment response, shared by the UI and the AI/MCP tools: the installer from this
 * Gateway's release, pinned to the daemon release that matches it. A relay installs the release its pool runs.
 */
export async function nodeInstallation(input: {
  nodeType: string;
  token: string;
  opfieldCertSha256: string;
  targets: EnrollmentTargets;
  fallbackOpfield?: string | null;
  advertiseAddress?: string | null;
  servicePort?: number | null;
  /** The pool's relay release, when the caller already read it. */
  relayVersion?: string | null;
}): Promise<NodeInstallation> {
  const release = installerRelease(getEnv().APP_VERSION);
  const daemonVersion = await daemonInstallVersion(input.nodeType, input.relayVersion);
  return { installerRelease: release, installCommands: nodeInstallCommands({ ...input, release, daemonVersion }) };
}

/** nodeInstallation for a node enrollment: a created node or a new enrollment token of a pending one. */
export function enrollmentInstallation(
  enrollment: {
    node: { type: string; serviceAddresses?: string[] | null; metadata?: unknown };
    enrollmentToken: string;
    opfieldCertSha256: string;
    opfieldEnrollmentTargets: EnrollmentTargets;
  },
  fallbackOpfield?: string | null
): Promise<NodeInstallation> {
  return nodeInstallation({
    nodeType: enrollment.node.type,
    token: enrollment.enrollmentToken,
    opfieldCertSha256: enrollment.opfieldCertSha256,
    targets: enrollment.opfieldEnrollmentTargets,
    fallbackOpfield,
    advertiseAddress: enrollment.node.type === 'relay' ? enrollment.node.serviceAddresses?.[0] : null,
    servicePort: enrollment.node.type === 'relay' ? requestedRelayServicePort(enrollment.node.metadata) : null,
  });
}

/**
 * nodeInstallation for a relay re-enrollment token. It reinstalls the release the pool runs: "latest" can resolve
 * to a supervisor that ignores a re-enrollment token.
 */
export function relayReenrollmentInstallation(
  issued: {
    enrollmentToken: string;
    advertiseAddress?: string | null;
    servicePort?: number | null;
    relayVersion?: string | null;
  },
  opfieldCertSha256: string,
  targets: EnrollmentTargets,
  fallbackOpfield?: string | null
): Promise<NodeInstallation> {
  return nodeInstallation({
    nodeType: 'relay',
    token: issued.enrollmentToken,
    opfieldCertSha256,
    targets,
    fallbackOpfield,
    advertiseAddress: issued.advertiseAddress,
    servicePort: issued.servicePort,
    relayVersion: issued.relayVersion ?? null,
  });
}

async function daemonInstallVersion(nodeType: string, relayVersion: string | null | undefined): Promise<string | null> {
  if (nodeType === 'relay') {
    if (relayVersion !== undefined) return relayVersion;
    return container.isRegistered(RelayPoolService) ? container.resolve(RelayPoolService).currentRelayVersion() : null;
  }
  const daemonType = daemonTypeForNodeType(nodeType);
  if (!daemonType || !container.isRegistered(DaemonUpdateService)) return null;
  return container.resolve(DaemonUpdateService).installVersion(daemonType);
}
