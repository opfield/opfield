import type { NodeNginxUpgrade } from '@/db/schema/nodes.js';

/**
 * The oldest nginx Opfield supports on an ingress node: 1.30.0-1.30.5 mishandle the regex map captures of the
 * maintenance and registry templates (CVE-2026-93479), older lines miss the fixes of 1.30.1-1.30.6. The installer,
 * the nginx daemon and its upgrade helper name the same version (a daemon test keeps them equal).
 */
export const NGINX_MINIMUM_VERSION = '1.30.6';

function parseVersion(version: string): number[] | null {
  const parts = version.trim().split('.');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  while (numbers.length < 3) numbers.push(0);
  return numbers;
}

export function nginxVersionAtLeast(actual: string, required: string = NGINX_MINIMUM_VERSION): boolean {
  const a = parseVersion(actual);
  const r = parseVersion(required);
  if (!a || !r) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== r[i]) return a[i] > r[i];
  }
  return true;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function seconds(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * The nginx daemon's upgrade of the host's nginx (HealthReport.nginx_upgrade), as the stored report keeps it:
 * `{ nginxUpgrade }`, or nothing for daemons that do not report it.
 */
export function nginxUpgradeHealth(report: unknown): { nginxUpgrade?: NodeNginxUpgrade } {
  const upgrade = (report as { nginxUpgrade?: unknown } | null | undefined)?.nginxUpgrade;
  if (!upgrade || typeof upgrade !== 'object') return {};
  const value = upgrade as Record<string, unknown>;
  const state = text(value.state);
  if (!state) return {};
  return {
    nginxUpgrade: {
      state,
      minimumVersion: text(value.minimumVersion),
      mode: text(value.mode),
      detail: text(value.detail),
      command: text(value.command),
      lastAttemptAt: seconds(value.lastAttemptAt),
      upgradedAt: seconds(value.upgradedAt),
      previousVersion: text(value.previousVersion),
    },
  };
}

/**
 * What the node page and the API say about an nginx older than NGINX_MINIMUM_VERSION: one sentence that ends with
 * what to do, or nothing while nginx is current. A daemon that upgrades nginx itself says where its upgrade stands; an
 * older daemon upgrades nginx once it is updated, or the installer does when run again on the node.
 */
export function nginxVersionNotice(health: {
  nginxVersion?: unknown;
  nginxUpgrade?: NodeNginxUpgrade;
}): string | undefined {
  const version = text(health.nginxVersion);
  if (!version || nginxVersionAtLeast(version)) return undefined;
  const lead = `nginx ${version} on this node is older than ${NGINX_MINIMUM_VERSION}, the oldest nginx Opfield supports (security fixes).`;
  const upgrade = health.nginxUpgrade;
  if (!upgrade) {
    return `${lead} Update the nginx daemon of this node: it then upgrades nginx to the nginx.org stable package without closing connections. Running the node installer again on the node upgrades it too.`;
  }
  switch (upgrade.state) {
    case 'upgrading':
      return `${lead} The nginx daemon is upgrading it now.`;
    case 'deferred':
      return `${lead} The nginx daemon upgrades it once this clears: ${upgrade.detail}.`;
    case 'manual':
      return `${lead} The nginx daemon runs without root and has no upgrade helper, so run as root on the node: ${upgrade.command}`;
    case 'failed':
      return `${lead} The nginx daemon's upgrade failed and the old nginx keeps serving: ${upgrade.detail}${
        upgrade.command ? ` Run as root on the node: ${upgrade.command}` : ' It tries again within 6 hours.'
      }`;
    default:
      return `${lead} ${upgrade.detail || 'The nginx daemon checks it every 6 hours.'}`;
  }
}
