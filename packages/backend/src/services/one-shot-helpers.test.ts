import { describe, expect, it } from 'vitest';
import { isLeftoverOneShot, ONE_SHOT_LABEL, ONE_SHOT_LEFTOVER_AGE_MS } from './docker.service.js';
import { finishedContainerSweepKind } from './update.service.js';

describe('one-off helper containers (F-3)', () => {
  it('are left alone by the cleanup of finished update sidecars, which they look like', () => {
    const helper = { Id: 'helper', State: 'exited', Labels: { [ONE_SHOT_LABEL]: 'true' } };
    // The registry storage switch's Compose helper, just created: removing it killed the step before its output was read.
    expect(finishedContainerSweepKind({ Id: 'new', State: 'created', Labels: {} }, null)).toBe('skip');
    expect(finishedContainerSweepKind({ Id: 'run', State: 'running', Labels: {} }, null)).toBe('skip');
    expect(finishedContainerSweepKind(helper, null)).toBe('skip');
    expect(
      finishedContainerSweepKind({ Id: 'other', State: 'exited', Labels: { 'net.opfield.role': 'something-else' } }, null)
    ).toBe('skip');
    // Update sidecars still go.
    expect(
      finishedContainerSweepKind(
        { Id: 'sidecar', State: 'exited', Labels: { 'net.opfield.role': 'opfield-update-sidecar' } },
        null
      )
    ).toBe('sidecar');
    expect(finishedContainerSweepKind({ Id: 'old', State: 'exited', Labels: {} }, null)).toBe('maybe-sidecar');
    expect(finishedContainerSweepKind({ Id: 'old', State: 'exited', Labels: {} }, 'old')).toBe('skip');
  });

  it('are leftovers once they ended (or, never started, were created) a while ago', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(isLeftoverOneShot({ State: { Running: false, FinishedAt: ago(ONE_SHOT_LEFTOVER_AGE_MS) } }, now)).toBe(true);
    expect(isLeftoverOneShot({ State: { Running: false, FinishedAt: ago(60_000) } }, now)).toBe(false);
    expect(isLeftoverOneShot({ State: { Running: true, FinishedAt: ago(ONE_SHOT_LEFTOVER_AGE_MS) } }, now)).toBe(false);
    // Never ran: Docker reports year 1; the creation time counts.
    expect(
      isLeftoverOneShot(
        { Created: ago(2 * ONE_SHOT_LEFTOVER_AGE_MS), State: { Running: false, FinishedAt: '0001-01-01T00:00:00Z' } },
        now
      )
    ).toBe(true);
    expect(
      isLeftoverOneShot({ Created: ago(1_000), State: { Running: false, FinishedAt: '0001-01-01T00:00:00Z' } }, now)
    ).toBe(false);
  });
});
