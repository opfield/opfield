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
    [
      'all',
      { vulnerabilityThreshold: 'critical' },
      full,
      'rejected',
      'Vulnerabilities at or above critical: 2 critical.',
    ],
    [
      'application',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'application' },
      full,
      'rejected',
      'Application vulnerabilities at or above high: 1 critical, 1 high.',
    ],
    [
      'fixable_all',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'fixable_all' },
      full,
      'rejected',
      'Fixable vulnerabilities at or above high: 1 critical, 1 high.',
    ],
    [
      'fixable_application',
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'fixable_application' },
      full,
      'rejected',
      'Fixable application vulnerabilities at or above high: 1 high.',
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
    const result = evaluateDockerArtifactPolicy(policy, { scanSummary });
    expect(result.decision).toBe(decision);
    // A rejection starts with the blocking counts; the rest says what to do.
    if (decision === 'rejected') expect(result.reason?.startsWith(reason!)).toBe(true);
    else expect(result.reason).toBe(reason);
  });

  it('says what blocked the image and which policy changes would admit it', () => {
    const finding = (id: string, severity: string, packageType: string, fixedVersions: string[]) => ({
      id,
      severity,
      packageName: `pkg-${id}`,
      installedVersion: '1.0.0',
      packageType,
      fixedVersions,
      fixState: fixedVersions.length ? 'fixed' : 'not-fixed',
      namespace: '',
      dataSource: '',
    });
    const scanSummary: DockerBuildScanSummary = {
      ...full,
      vulnerabilities: [
        finding('CVE-2', 'High', 'npm', ['1.0.1']),
        finding('CVE-1', 'Critical', 'deb', []),
        finding('CVE-3', 'Critical', 'npm', ['2.0.0']),
      ],
    };

    expect(evaluateDockerArtifactPolicy({ vulnerabilityThreshold: 'critical' }, { scanSummary }).reason).toBe(
      'Vulnerabilities at or above critical: 2 critical. Top findings: CVE-1 (critical, pkg-CVE-1 1.0.0); CVE-3 (critical, pkg-CVE-3 1.0.0, fixed in 2.0.0). The image was not deployed. Update the affected packages and build again, or change the Git source policy (manage_docker_source upsert with policy, or Vulnerability policy in the Build panel of the Source tab): vulnerabilityScope "application" (OS packages only reported), or "fixable_application" or "fixable_all" (only findings with a released fix), or vulnerabilityThreshold "none" (report only).'
    );
    const narrow = evaluateDockerArtifactPolicy(
      { vulnerabilityThreshold: 'high', vulnerabilityScope: 'fixable_application' },
      { scanSummary }
    ).reason;
    expect(narrow).toContain('Top findings: CVE-2 (high, pkg-CVE-2 1.0.0, fixed in 1.0.1).');
    expect(narrow).toContain('vulnerabilityThreshold "critical".');
    expect(narrow).not.toContain('vulnerabilityScope');
  });
});
