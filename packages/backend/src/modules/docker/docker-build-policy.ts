import type {
  DockerArtifactPolicyDecision,
  DockerBuildPolicySnapshot,
  DockerBuildScanSummary,
  DockerBuildSeverityCounts,
  DockerBuildStatus,
  DockerBuildVulnerabilityScope,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { policyRejectionReason } from './docker-build-policy-reason.js';

export const WORKER_ACTIVE_BUILD_STATUSES: DockerBuildStatus[] = [
  'claimed',
  'checking_out',
  'building',
  'scanning',
  'pushing',
];

export const ACTIVE_BUILD_STATUSES: DockerBuildStatus[] = [...WORKER_ACTIVE_BUILD_STATUSES, 'deploying'];

export const TERMINAL_BUILD_STATUSES: DockerBuildStatus[] = ['succeeded', 'failed', 'cancelled', 'superseded'];

export const BUILD_LOG_CHUNK_MAX_BYTES = 256 * 1024;
export const BUILD_LOG_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_BUILD_LEASE_MS = 60_000;
export const ENFORCED_BUILD_CPU_LIMIT_MILLIS = 2000;
export const ENFORCED_BUILD_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3;
export const ENFORCED_BUILD_DISK_LIMIT_BYTES = 20 * 1024 ** 3;

export interface DockerBuildRolloutProgress {
  operationId: string;
  attempt: number;
  phase: 'accepted' | 'executing';
}

export function readDockerBuildRolloutProgress(progress: unknown): DockerBuildRolloutProgress | null {
  if (!progress || typeof progress !== 'object') return null;
  const rollout = (progress as Record<string, unknown>).rollout;
  if (!rollout || typeof rollout !== 'object') return null;
  const value = rollout as Record<string, unknown>;
  if (
    typeof value.operationId !== 'string' ||
    !value.operationId ||
    !Number.isSafeInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    (value.phase !== 'accepted' && value.phase !== 'executing')
  ) {
    return null;
  }
  return {
    operationId: value.operationId,
    attempt: Number(value.attempt),
    phase: value.phase,
  };
}

export const dockerBuildLimits = {
  logChunkMaxBytes: BUILD_LOG_CHUNK_MAX_BYTES,
  logTotalMaxBytes: BUILD_LOG_TOTAL_MAX_BYTES,
  defaultLeaseMs: DEFAULT_BUILD_LEASE_MS,
  enforcedCpuLimitMillis: ENFORCED_BUILD_CPU_LIMIT_MILLIS,
  enforcedMemoryLimitBytes: ENFORCED_BUILD_MEMORY_LIMIT_BYTES,
  enforcedDiskLimitBytes: ENFORCED_BUILD_DISK_LIMIT_BYTES,
};

const BUILD_TRANSITIONS: Record<DockerBuildStatus, readonly DockerBuildStatus[]> = {
  queued: ['claimed', 'cancelled', 'superseded'],
  claimed: ['checking_out', 'failed', 'cancelled', 'superseded'],
  checking_out: ['building', 'failed', 'cancelled', 'superseded'],
  building: ['scanning', 'pushing', 'failed', 'cancelled', 'superseded'],
  scanning: ['pushing', 'failed', 'cancelled', 'superseded'],
  pushing: ['deploying', 'succeeded', 'failed', 'cancelled', 'superseded'],
  deploying: ['succeeded', 'failed', 'cancelled', 'superseded'],
  succeeded: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

export const DEFAULT_BUILDER_PARALLELISM = 1;
export const DEFAULT_BUILDER_TIMEOUT_MINUTES = 30;
export const MAX_BUILDER_PARALLELISM = 16;
export const MAX_BUILDER_TIMEOUT_MINUTES = 360;

export function readBuilderNodeSettings(metadata: unknown): { parallelism: number; timeoutMinutes: number } {
  const record = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const settings =
    record.builderSettings && typeof record.builderSettings === 'object'
      ? (record.builderSettings as Record<string, unknown>)
      : {};
  const parallelism = Number(settings.parallelism);
  const timeoutMinutes = Number(settings.timeoutMinutes);
  return {
    parallelism:
      Number.isSafeInteger(parallelism) && parallelism >= 1 && parallelism <= MAX_BUILDER_PARALLELISM
        ? parallelism
        : DEFAULT_BUILDER_PARALLELISM,
    timeoutMinutes:
      Number.isSafeInteger(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= MAX_BUILDER_TIMEOUT_MINUTES
        ? timeoutMinutes
        : DEFAULT_BUILDER_TIMEOUT_MINUTES,
  };
}

export function assertSupportedDockerBuildResourcePolicy(policy: Record<string, unknown>): void {
  for (const [key, expected] of [
    ['cpuLimitMillis', ENFORCED_BUILD_CPU_LIMIT_MILLIS],
    ['memoryLimitBytes', ENFORCED_BUILD_MEMORY_LIMIT_BYTES],
    ['diskLimitBytes', ENFORCED_BUILD_DISK_LIMIT_BYTES],
  ] as const) {
    if (policy[key] !== undefined && Number(policy[key]) !== expected) {
      throw new AppError(
        409,
        'UNSUPPORTED_BUILD_RESOURCE_PROFILE',
        `Build policy ${key} must use the enforced worker profile value ${expected}`
      );
    }
  }
}

export function parseDockerBuildProgress(value: string): { progress?: Record<string, unknown> } {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { progress: parsed as Record<string, unknown> }
      : {};
  } catch {
    return {};
  }
}

export function parseDockerBuildScanSummary(value: string): DockerBuildScanSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const count = (key: string) => {
      const numeric = Number(parsed[key] ?? 0);
      return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
    };
    const text = (record: Record<string, unknown>, key: string) =>
      typeof record[key] === 'string' ? record[key].slice(0, 512) : '';
    const vulnerabilities = Array.isArray(parsed.vulnerabilities)
      ? parsed.vulnerabilities.slice(0, 100).flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const record = entry as Record<string, unknown>;
          const id = text(record, 'id');
          if (!id) return [];
          return [
            {
              id,
              severity: text(record, 'severity') || 'unknown',
              packageName: text(record, 'packageName'),
              installedVersion: text(record, 'installedVersion'),
              packageType: text(record, 'packageType'),
              fixedVersions: Array.isArray(record.fixedVersions)
                ? record.fixedVersions
                    .filter((item): item is string => typeof item === 'string')
                    .slice(0, 5)
                    .map((item) => item.slice(0, 512))
                : [],
              fixState: text(record, 'fixState'),
              namespace: text(record, 'namespace'),
              dataSource: text(record, 'dataSource'),
            },
          ];
        })
      : [];
    // These are full-report aggregates, independent of the truncated detail list.
    const validTotals =
      ['critical', 'high', 'medium', 'low', 'unknown'].every(
        (key) => typeof parsed[key] === 'number' && Number.isSafeInteger(parsed[key]) && Number(parsed[key]) >= 0
      ) &&
      (parsed.negligible === undefined ||
        (typeof parsed.negligible === 'number' && Number.isSafeInteger(parsed.negligible) && parsed.negligible >= 0));
    const severityCounts = (key: string): DockerBuildSeverityCounts | null => {
      const value = parsed[key];
      if (!validTotals || !value || typeof value !== 'object' || Array.isArray(value)) return null;
      const counts = value as Record<string, unknown>;
      const valid = (name: string) =>
        typeof counts[name] === 'number' && Number.isSafeInteger(counts[name]) && Number(counts[name]) >= 0;
      if (
        !['critical', 'high', 'medium', 'low', 'unknown'].every(valid) ||
        (counts.negligible !== undefined && !valid('negligible'))
      ) {
        return null;
      }
      return {
        critical: Number(counts.critical),
        high: Number(counts.high),
        medium: Number(counts.medium),
        low: Number(counts.low),
        unknown: Number(counts.unknown) + Number(counts.negligible ?? 0),
      };
    };
    const osPackages = severityCounts('osPackages');
    const fixable = severityCounts('fixable');
    const fixableOsPackages = severityCounts('fixableOsPackages');
    return {
      scanner: typeof parsed.scanner === 'string' ? parsed.scanner : 'grype',
      ...(parsed.skipped === true ? { skipped: true } : {}),
      critical: count('critical'),
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
      unknown: count('unknown') + count('negligible'),
      vulnerabilities,
      vulnerabilitiesTruncated: count('vulnerabilitiesTruncated'),
      ...(osPackages ? { osPackages } : {}),
      ...(fixable ? { fixable } : {}),
      ...(fixableOsPackages ? { fixableOsPackages } : {}),
    };
  } catch {
    return null;
  }
}

export function canTransitionDockerBuild(from: DockerBuildStatus, to: DockerBuildStatus): boolean {
  return BUILD_TRANSITIONS[from].includes(to);
}

export function redactDockerBuildLog(
  content: string,
  options: { secretValues?: readonly string[]; secretNames?: readonly string[] } = {}
): string {
  let redacted = content;
  for (const secret of options.secretValues ?? []) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  redacted = redacted.replace(/(https?:\/\/[^\s/:]+:)[^@\s]+@/gi, '$1[REDACTED]@');
  for (const name of options.secretNames ?? []) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(`(${escaped}\\s*[=:]\\s*)[^\\s]+`, 'gi'), '$1[REDACTED]');
  }
  return redacted;
}

export function expiredDockerBuildDisposition(input: {
  attempt: number;
  maxAttempts: number;
  cancellationRequestedAt: Date | null;
}): 'retry' | 'cancelled' | 'failed' {
  if (input.cancellationRequestedAt) return 'cancelled';
  return input.attempt < input.maxAttempts ? 'retry' : 'failed';
}

const POLICY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type PolicySeverity = (typeof POLICY_SEVERITIES)[number];

export function evaluateDockerArtifactPolicy(
  policy: DockerBuildPolicySnapshot,
  artifact: {
    sbomDigest?: string | null;
    provenanceDigest?: string | null;
    scanSummary?: DockerBuildScanSummary | null;
  }
): { decision: DockerArtifactPolicyDecision; reason: string | null } {
  const threshold = policy.vulnerabilityThreshold ?? 'critical';
  if (threshold === 'disabled') return { decision: 'approved', reason: 'Vulnerability scanning disabled by policy' };
  if (artifact.scanSummary?.skipped) {
    return { decision: 'error', reason: 'Build Worker skipped a vulnerability scan required by the source policy' };
  }
  if (threshold === 'none') return { decision: 'approved', reason: null };
  if (!artifact.scanSummary) {
    return { decision: 'error', reason: 'Vulnerability scan result is required' };
  }
  const scoped = scopedVulnerabilityCounts(policy.vulnerabilityScope, artifact.scanSummary);
  if ('error' in scoped) return { decision: 'error', reason: scoped.error };
  const thresholdIndex = POLICY_SEVERITIES.indexOf(threshold as PolicySeverity);
  const violations = POLICY_SEVERITIES.slice(0, thresholdIndex + 1).filter((severity) => scoped.count(severity) > 0);
  return violations.length > 0
    ? {
        decision: 'rejected',
        reason: policyRejectionReason({
          label: scoped.label,
          threshold: threshold as PolicySeverity,
          scope: policy.vulnerabilityScope ?? 'all',
          violations,
          count: scoped.count,
          summary: artifact.scanSummary,
        }),
      }
    : { decision: 'approved', reason: null };
}

/** True when every severity of `part` is a valid count no larger than the same severity of `whole`. */
function countsWithin(part: DockerBuildSeverityCounts | undefined, whole: DockerBuildSeverityCounts | undefined) {
  return (
    !!part &&
    !!whole &&
    [...POLICY_SEVERITIES, 'unknown' as const].every(
      (severity) =>
        Number.isSafeInteger(part[severity]) &&
        part[severity] >= 0 &&
        Number.isSafeInteger(whole[severity]) &&
        part[severity] <= whole[severity]
    )
  );
}

/** Counts that the policy scope lets block a deployment, or why the scan cannot be judged. */
function scopedVulnerabilityCounts(
  scope: DockerBuildVulnerabilityScope | undefined,
  summary: DockerBuildScanSummary
): { label: string; count: (severity: PolicySeverity) => number } | { error: string } {
  const { osPackages, fixable, fixableOsPackages } = summary;
  switch (scope) {
    case 'application':
      if (!countsWithin(osPackages, summary)) {
        return {
          error:
            'Complete OS package scan counts are required for application-only policy. Rebuild with an updated Build Worker.',
        };
      }
      return { label: 'Application vulnerabilities', count: (severity) => summary[severity] - osPackages![severity] };
    case 'fixable_all':
      if (!countsWithin(fixable, summary)) {
        return {
          error:
            'Complete fixable vulnerability counts are required for fixable-only policy. Rebuild with an updated Build Worker.',
        };
      }
      return { label: 'Fixable vulnerabilities', count: (severity) => fixable![severity] };
    case 'fixable_application':
      if (!countsWithin(fixable, summary) || !countsWithin(fixableOsPackages, fixable)) {
        return {
          error:
            'Complete fixable vulnerability counts are required for fixable-only policy. Rebuild with an updated Build Worker.',
        };
      }
      return {
        label: 'Fixable application vulnerabilities',
        count: (severity) => fixable![severity] - fixableOsPackages![severity],
      };
    default:
      return { label: 'Vulnerabilities', count: (severity) => summary[severity] };
  }
}

export interface BuilderOrderNode {
  id: string;
  folderId: string | null;
  sortOrder: number;
  createdAt: Date | string;
}

export interface BuilderOrderFolder {
  id: string;
  parentId: string | null;
  sortOrder: number;
}

/**
 * Build Workers take queued builds in the order of the Nodes list, so that order is their priority: the
 * first worker fills its parallel slots, then builds go to the next. The list shows top-level folders by
 * position, inside a folder its subfolders first and then its nodes, and nodes outside any folder last.
 */
export function orderBuildersLikeNodeList<T extends BuilderOrderNode>(
  builders: readonly T[],
  folders: readonly BuilderOrderFolder[]
): T[] {
  const byPosition = (a: { sortOrder: number; id: string }, b: { sortOrder: number; id: string }) =>
    a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  const known = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, BuilderOrderFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  // A folder's nodes follow all of its subfolders, so number folders in post-order.
  const blockOf = new Map<string, number>();
  const visit = (parent: string | null) => {
    for (const folder of [...(children.get(parent) ?? [])].sort(byPosition)) {
      visit(folder.id);
      blockOf.set(folder.id, blockOf.size);
    }
  };
  visit(null);
  const block = (node: T) =>
    node.folderId && blockOf.has(node.folderId) ? (blockOf.get(node.folderId) as number) : blockOf.size;
  const created = (node: T) => new Date(node.createdAt).getTime();
  return [...builders].sort(
    (a, b) => block(a) - block(b) || a.sortOrder - b.sortOrder || created(a) - created(b) || a.id.localeCompare(b.id)
  );
}
