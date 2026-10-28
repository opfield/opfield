import { describe, expect, it } from 'vitest';
import { presentDeploymentForCaller, redactDeploymentEnvironment } from './docker-deployment-redaction.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';

function deployment() {
  return {
    id: DEPLOYMENT_ID,
    desiredConfig: { image: 'app:v2', env: { DATABASE_URL: 'postgres://secret' } },
    slots: [
      { slot: 'blue', desiredConfig: { image: 'app:v1', env: { DATABASE_URL: 'postgres://old-secret' } } },
      { slot: 'green', desiredConfig: null },
    ],
    releases: [{ id: 'release-1', image: 'app:v2' }],
    webhook: { id: 'webhook-1', token: 'hook-token' },
  };
}

describe('deployment environment redaction', () => {
  it('removes desired and slot snapshot env for callers without environment access', () => {
    const source = deployment();
    const redacted = redactDeploymentEnvironment(source, false);
    expect(redacted.desiredConfig).toEqual({ image: 'app:v2' });
    expect(redacted.slots[0]!.desiredConfig).toEqual({ image: 'app:v1' });
    expect(redacted.slots[1]!.desiredConfig).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(source.desiredConfig.env.DATABASE_URL).toBe('postgres://secret');
  });

  it('keeps env for callers with environment access on the deployment', () => {
    const presented = presentDeploymentForCaller(
      deployment(),
      [`docker:containers:environment:${NODE_ID}/${DEPLOYMENT_ID}`],
      NODE_ID,
      DEPLOYMENT_ID
    );
    expect(presented.desiredConfig.env).toEqual({ DATABASE_URL: 'postgres://secret' });
    expect(presented.webhook.token).toBe('[REDACTED]');
  });

  it('gives a view-only caller neither env nor the webhook token', () => {
    const presented = presentDeploymentForCaller(
      deployment(),
      [`docker:containers:view:${NODE_ID}`, `docker:containers:environment:${NODE_ID}/other-deployment`],
      NODE_ID,
      DEPLOYMENT_ID
    );
    expect(presented.desiredConfig).not.toHaveProperty('env');
    expect(presented.slots[0]!.desiredConfig).not.toHaveProperty('env');
    expect(presented.webhook.token).toBe('[REDACTED]');
  });

  it('never returns the stored token hash, and leaves a token that is not stored in the clear null', () => {
    const sealed = {
      ...deployment(),
      webhook: { id: 'webhook-1', token: null, tokenHash: 'a'.repeat(64) },
    };
    const presented = presentDeploymentForCaller(sealed, [`docker:containers:view:${NODE_ID}`], NODE_ID, DEPLOYMENT_ID);
    expect(presented.webhook).toEqual({ id: 'webhook-1', token: null });
    const revealed = presentDeploymentForCaller(
      sealed,
      [`docker:containers:webhooks:${NODE_ID}/${DEPLOYMENT_ID}`],
      NODE_ID,
      DEPLOYMENT_ID
    );
    expect(revealed.webhook).toEqual({ id: 'webhook-1', token: null });
  });
});
