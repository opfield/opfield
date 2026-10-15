import { describe, expect, it } from 'vitest';
import { type DockerSourceBuildSummary, describeDockerSourceState } from './docker-source-build-state.js';

const COMMIT = '0d9a2ae5b1c4f6e7a8b9c0d1e2f3a4b5c6d7e8f9';
const source = { autoBuild: true, autoDeploy: true, deployedCommitSha: null, lastPollError: null };

function build(overrides: Partial<DockerSourceBuildSummary> = {}): DockerSourceBuildSummary {
  return {
    id: 'build-1',
    status: 'succeeded',
    trigger: 'poll',
    commitSha: COMMIT,
    serviceName: null,
    errorCode: null,
    errorMessage: null,
    policyDecision: 'approved',
    policyReason: null,
    scanCounts: null,
    rolloutNote: null,
    createdAt: new Date('2026-10-15T12:46:55Z'),
    completedAt: new Date('2026-10-15T12:48:00Z'),
    ...overrides,
  };
}

describe('state of a Git source', () => {
  it('says that a vulnerability policy rejection is why nothing is deployed, and what admits the image', () => {
    // A rejection recorded before the reason named the fix.
    const state = describeDockerSourceState(source, [
      build({
        status: 'failed',
        errorCode: 'BUILD_ARTIFACT_POLICY_REJECTED',
        errorMessage: 'Vulnerabilities at or above critical: critical',
        policyDecision: 'rejected',
        policyReason: 'Vulnerabilities at or above critical: critical',
      }),
    ]);

    expect(state).toBe(
      'Latest build of commit 0d9a2ae5b1 failed: the vulnerability policy rejected the image, so it was not deployed. Vulnerabilities at or above critical: critical. Update the affected packages and build again, or change the Git source policy: vulnerabilityScope "application" (OS packages only reported), "fixable_application" or "fixable_all" (only findings with a released fix), or a vulnerabilityThreshold above the blocking severities. Nothing has been deployed from this source yet.'
    );
  });

  it('does not repeat the fix a current rejection message already names', () => {
    const reason =
      'Vulnerabilities at or above critical: 1 critical. The image was not deployed. Update the affected packages and build again, or change the Git source policy: vulnerabilityThreshold "none" (report only).';
    const state = describeDockerSourceState(source, [
      build({ status: 'failed', errorCode: 'BUILD_ARTIFACT_POLICY_REJECTED', errorMessage: reason }),
    ]);

    expect(state.split('Update the affected packages').length).toBe(2);
  });

  it('names the failed service build of a Compose commit', () => {
    const state = describeDockerSourceState(source, [
      build({ id: 'web', serviceName: 'web' }),
      build({
        id: 'api',
        serviceName: 'api',
        status: 'failed',
        errorCode: 'BUILD_FAILED',
        errorMessage: 'exit code 2',
      }),
    ]);

    expect(state).toContain('(service api) failed (BUILD_FAILED): exit code 2. Fix the cause, then build again');
  });

  it('tells a deployed build from one automatic deployment skipped, and says why no build exists', () => {
    expect(describeDockerSourceState({ ...source, deployedCommitSha: COMMIT }, [build()])).toBe(
      'Commit 0d9a2ae5b1 is deployed.'
    );
    expect(describeDockerSourceState({ ...source, autoDeploy: false }, [build()])).toContain(
      'automatic deployment is off, so it was not deployed'
    );
    expect(
      describeDockerSourceState(
        { ...source, lastPollError: 'The first build was not queued: All Build Workers are paused for new builds' },
        []
      )
    ).toBe(
      'No build yet: The first build was not queued: All Build Workers are paused for new builds. Nothing has been deployed from this source yet.'
    );
  });
});
