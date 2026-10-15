import { describe, expect, it } from 'vitest';
import type { DockerBuildPolicySnapshot, DockerBuildScanSummary } from '@/db/schema/index.js';
import { evaluateDockerArtifactPolicy } from './docker-build-policy.js';

const counts = (critical: number, high: number, medium = 0, low = 0, unknown = 0) => ({
  critical,
  high,
  medium,
  low,
  unknown,
});

// 2 critical (1 OS, fixable), 3 high (2 OS, 1 fixable app).
const oldWorker: DockerBuildScanSummary = { ...counts(2, 3), osPackages: counts(1, 2) };
const full: DockerBuildScanSummary = { ...oldWorker, fixable: counts(1, 1), fixableOsPackages: counts(1, 0) };

describe('evaluateDockerArtifactPolicy', () => {
  it.each<[string, DockerBuildPolicySnapshot, DockerBuildScanSummary, string, string | null]>([
    ['all', { vulnerabilityThreshold: 'critical' }, full, 'rejected', 'Vulnerabilities at or above critical: critical'],
    [
      'application',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'application' },
      full,
      'rejected',
      'Application vulnerabilities at or above high: critical, high',
    ],
    [
      'fixable_all',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'fixable_all' },
      full,
      'rejected',
      'Fixable vulnerabilities at or above high: critical, high',
    ],
    [
      'fixable_application',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'fixable_application' },
      full,
      'rejected',
      'Fixable application vulnerabilities at or above high: high',
    ],
    [
      'fixable_application below threshold',
      { vulnerabilityThreshold: 'critical', vulnerabilityScope: 'fixable_application' },
      full,
      'approved',
      null,
    ],
    [
      'fixable scope without worker counts',
      { vulnerabilityThreshold: 'critical', vulnerabilityScope: 'fixable_all' },
      oldWorker,
      'error',
      'Complete fixable vulnerability counts are required for fixable-only policy. Rebuild with an updated Build Worker.',
    ],
    [
      'fixable counts larger than totals',
      { vulnerabilityThreshold: 'critical', vulnerabilityScope: 'fixable_application' },
      { ...full, fixableOsPackages: counts(2, 0) },
      'error',
      'Complete fixable vulnerability counts are required for fixable-only policy. Rebuild with an updated Build Worker.',
    ],
  ])('%s', (_name, policy, scanSummary, decision, reason) => {
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary })).toEqual({ decision, reason });
  });
});
