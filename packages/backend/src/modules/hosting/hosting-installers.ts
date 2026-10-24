import { getEnv } from '@/config/env.js';
import { INSTALLER_RELEASES_URL } from '@/config/vendor-urls.js';
import { compareSemver } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { daemonInstallVersion, INSTALLER_CHECKSUMS, installerRelease } from '@/modules/nodes/node-installer.js';
import type { HostingRole } from './hosting-provider.types.js';

/** The installer a hosted role runs, as in the node setup commands (node-installer.ts NODE_INSTALLERS). */
export const HOSTING_ROLE_INSTALLERS: Record<HostingRole, string> = {
  nginx: 'setup-node.sh',
  docker: 'setup-docker-node.sh',
  builder: 'setup-docker-node.sh',
  databases: 'setup-database-node.sh',
  storage: 'setup-storage-node.sh',
  monitoring: 'setup-monitoring-node.sh',
  relay: 'setup-relay-node.sh',
};

/**
 * Installers a role downloads into one directory: wrapper installers run their sibling from the same directory when
 * it is there, so the siblings come verified from the same release instead of being fetched by the wrapper itself.
 */
export function hostingRoleInstallerFiles(role: HostingRole): string[] {
  const main = HOSTING_ROLE_INSTALLERS[role];
  if (role === 'storage') return ['setup-docker-node.sh', 'setup-database-node.sh', main];
  if (role === 'databases') return ['setup-docker-node.sh', main];
  return [main];
}

/** The first relay release this release's relay installer installs (node-installer.ts OPFIELD_RELAY_INSTALLER_MIN). */
const RELAY_INSTALLER_MIN = 'v2.12.1-rc.3';

/** Where a hosted install takes its installers from: the release-staged installers of this Opfield release. */
export interface HostingInstallerSource {
  release: string;
  /** `<release downloads>/<tag>`: the same URLs the node setup commands download. */
  baseUrl: string;
  /** SHA-256 of every installer the role downloads, from the release's opfield-node-installers.sha256. */
  sha256: Record<string, string>;
  /** The daemon release the installer pins with --version, as the node setup commands do; null lets it choose. */
  daemonVersion: string | null;
}

const CHECKSUM_LIST_MAX_BYTES = 64 * 1024;
const CHECKSUM_TIMEOUT_MS = 15_000;
// A release's assets never change; only a successful read is kept.
const checksumCache = new Map<string, Record<string, string>>();

export function parseInstallerChecksums(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64}) [ *]?([A-Za-z0-9._-]+)$/.exec(line.trim());
    if (match) entries[match[2]!] = match[1]!;
  }
  return entries;
}

async function releaseChecksums(baseUrl: string, fetcher: typeof fetch): Promise<Record<string, string>> {
  const cached = checksumCache.get(baseUrl);
  if (cached) return cached;
  let text: string;
  try {
    const response = await fetcher(`${baseUrl}/${INSTALLER_CHECKSUMS}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(CHECKSUM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    throw new AppError(
      503,
      'HOSTING_INSTALLERS_UNAVAILABLE',
      `Could not read the node installer checksums of this Opfield release (${error instanceof Error ? error.message : 'request failed'}). No VM was ordered; try again shortly.`
    );
  }
  if (text.length > CHECKSUM_LIST_MAX_BYTES)
    throw new AppError(
      502,
      'HOSTING_INSTALLERS_INVALID',
      'The node installer checksum list of this release is invalid'
    );
  const entries = parseInstallerChecksums(text);
  checksumCache.set(baseUrl, entries);
  return entries;
}

/**
 * The installers a hosted node of this role runs: the installers published with this Opfield release (served by the
 * update Worker under get.opfield.dev in GitHub's release download layout, staged with legacy-compat.sh inlined),
 * verified against that release's opfield-node-installers.sha256 exactly like the node setup commands. Opfield reads
 * the checksum list itself over HTTPS and embeds the expected hashes into the bootstrap, so the guest runs only those
 * bytes. A build that is not a published release (APP_VERSION dev) has no such installers: hosted installation is
 * refused before anything is ordered.
 */
export async function resolveHostingInstallers(
  role: HostingRole,
  options: { appVersion?: string; fetcher?: typeof fetch } = {}
): Promise<HostingInstallerSource> {
  const release = installerRelease(options.appVersion ?? getEnv().APP_VERSION);
  if (!release)
    throw new AppError(
      409,
      'HOSTING_INSTALLERS_UNAVAILABLE',
      'This Opfield build is not a published release, so it has no published node installers to install hosted nodes with. Use a released Opfield, or install the node by hand with its setup command.'
    );
  const baseUrl = `${INSTALLER_RELEASES_URL}/download/${release}`;
  const checksums = await releaseChecksums(baseUrl, options.fetcher ?? fetch);
  const sha256: Record<string, string> = {};
  for (const file of hostingRoleInstallerFiles(role)) {
    const hash = checksums[file];
    if (!hash)
      throw new AppError(
        502,
        'HOSTING_INSTALLERS_INVALID',
        `The installer checksum list of ${release} does not list ${file}. No VM was ordered.`
      );
    sha256[file] = hash;
  }
  let daemonVersion = await daemonInstallVersion(role, undefined);
  // This release's relay installer refuses relays from before the Opfield layout: let it choose then.
  if (role === 'relay' && daemonVersion && compareSemver(daemonVersion, RELAY_INSTALLER_MIN) < 0) daemonVersion = null;
  return { release, baseUrl, sha256, daemonVersion };
}
