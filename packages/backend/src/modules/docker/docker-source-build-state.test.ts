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

    expect(state).toContain(
      '(service api) failed (BUILD_FAILED): exit code 2. The build log has the full output (manage_docker_build logs with buildId api, or the build in the Builds list). Fix the cause, then build again'
    );
  });

  it('carries the failing Dockerfile step of a failed build and points to its log', () => {
    const state = describeDockerSourceState(source, [
      build({
        status: 'failed',
        errorCode: 'BUILD_FAILED',
        errorMessage:
          'Dockerfile:3 `RUN exit 7`: failed to solve: process "/bin/sh -c exit 7" did not complete successfully: exit code: 7',
      }),
    ]);

    expect(state).toContain('Dockerfile:3 `RUN exit 7`');
    expect(state).toContain('exit code: 7');
    expect(state).toContain('manage_docker_build logs with buildId build-1');
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

  it('says a newer head was not built and why, instead of only that the old commit is deployed (O-6)', () => {
    const head = '87f6052feb'.padEnd(40, '0');
    const full =
      "The internal registry's disk is 91% full (new builds and image pushes stop at 90%): free space on the Opfield host or remove old builds, then builds resume";
    expect(
      describeDockerSourceState({ ...source, desiredCommitSha: head, deployedCommitSha: COMMIT, lastPollError: full }, [
        build(),
      ])
    ).toBe(
      `Commit 87f6052feb was not built: ${full}. The next poll or sync builds it once that is resolved. Commit 0d9a2ae5b1 is deployed.`
    );
    // A poll error about the commit already built changes nothing.
    expect(
      describeDockerSourceState(
        { ...source, desiredCommitSha: COMMIT, deployedCommitSha: COMMIT, lastPollError: 'Repository is archived' },
        [build()]
      )
    ).toBe('Commit 0d9a2ae5b1 is deployed.');
  });

  it('says the target was rolled back when it runs an earlier commit than the newest build', () => {
    const older = 'f53ab3eb00'.padEnd(40, '0');
    expect(describeDockerSourceState({ ...source, deployedCommitSha: older }, [build()])).toBe(
      'Build of commit 0d9a2ae5b1 succeeded, but the target runs the earlier commit f53ab3eb00 (rolled back). The next new commit deploys again; to deploy 0d9a2ae5b1 now, roll back again (manage_docker_source rollback: it returns to the newer build without building), or build it again with force.'
    );
  });

  // rc.3 stand R-F-1: a build that lost the restarting registry told the user to "Fix the cause".
  it('does not blame the source for a build that lost the internal registry', () => {
    expect(
      describeDockerSourceState(source, [build({ status: 'failed', errorCode: 'INTERNAL_REGISTRY_UNAVAILABLE', errorMessage: 'x' })])
    ).toMatch(/Nothing is wrong with the source: build again once the registry is ready/);
    expect(describeDockerSourceState(source, [build({ status: 'queued', errorCode: 'BUILD_REGISTRY_RETRY' })])).toMatch(
      /is queued again: the internal registry restarted while it pushed/
    );
  });
});
