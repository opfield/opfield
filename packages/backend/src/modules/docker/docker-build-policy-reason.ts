import type {
  DockerBuildScanSummary,
  DockerBuildVulnerability,
  DockerBuildVulnerabilityScope,
} from '@/db/schema/index.js';

export type PolicySeverity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_ORDER: PolicySeverity[] = ['critical', 'high', 'medium', 'low'];
const OS_PACKAGE_TYPES = new Set(['deb', 'rpm', 'apk', 'alpm']);
const TOP_FINDINGS = 3;

/** Narrower scopes than the current one, with what each counts. */
const NARROWER_SCOPES: Record<DockerBuildVulnerabilityScope, string[]> = {
  all: [
    '"application" (OS packages only reported)',
    '"fixable_application" or "fixable_all" (only findings with a released fix)',
  ],
  application: ['"fixable_application" (only application findings with a released fix)'],
  fixable_all: ['"fixable_application" (OS packages only reported)'],
  fixable_application: [],
};

function fixable(finding: DockerBuildVulnerability): boolean {
  return finding.fixedVersions.length > 0 || finding.fixState.toLowerCase() === 'fixed';
}

/** The findings the scope counts, most severe first: the ones that blocked the image. */
function topFindings(
  summary: DockerBuildScanSummary,
  scope: DockerBuildVulnerabilityScope,
  violations: readonly PolicySeverity[]
): string[] {
  const counted = (summary.vulnerabilities ?? []).filter(
    (finding) =>
      violations.includes(finding.severity.toLowerCase() as PolicySeverity) &&
      (scope === 'all' || scope === 'fixable_all' || !OS_PACKAGE_TYPES.has(finding.packageType.toLowerCase())) &&
      (scope === 'all' || scope === 'application' || fixable(finding))
  );
  const rank = (finding: DockerBuildVulnerability) =>
    SEVERITY_ORDER.indexOf(finding.severity.toLowerCase() as PolicySeverity);
  return [...counted]
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, TOP_FINDINGS)
    .map((finding) => {
      const installed = [finding.packageName, finding.installedVersion].filter(Boolean).join(' ');
      const fix = finding.fixedVersions[0] ? `, fixed in ${finding.fixedVersions[0]}` : '';
      return `${finding.id} (${finding.severity.toLowerCase()}${installed ? `, ${installed}` : ''}${fix})`;
    });
}

/**
 * Why the policy rejected an image and what to do: the blocking counts per severity, the first findings the scope
 * counts, and the policy changes that would admit it (a narrower scope, or a threshold above the blocking severities).
 */
export function policyRejectionReason(input: {
  label: string;
  threshold: PolicySeverity;
  scope: DockerBuildVulnerabilityScope;
  violations: readonly PolicySeverity[];
  count: (severity: PolicySeverity) => number;
  summary: DockerBuildScanSummary;
}): string {
  const counts = input.violations.map((severity) => `${input.count(severity)} ${severity}`).join(', ');
  const findings = topFindings(input.summary, input.scope, input.violations);
  const worst = SEVERITY_ORDER.indexOf(input.violations[0]!);
  const threshold = worst === 0 ? '"none" (report only)' : `"${SEVERITY_ORDER[worst - 1]}"`;
  const changes = [
    ...(NARROWER_SCOPES[input.scope].length
      ? [`vulnerabilityScope ${NARROWER_SCOPES[input.scope].join(', or ')}`]
      : []),
    `vulnerabilityThreshold ${threshold}`,
  ];
  return [
    `${input.label} at or above ${input.threshold}: ${counts}.`,
    ...(findings.length ? [`Top findings: ${findings.join('; ')}.`] : []),
    'The image was not deployed.',
    `Update the affected packages and build again, or change the Git source policy (manage_docker_source upsert with policy, or Vulnerability policy in the Build panel of the Source tab): ${changes.join(', or ')}.`,
  ].join(' ');
}
