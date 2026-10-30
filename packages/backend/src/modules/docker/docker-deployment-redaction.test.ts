import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { container } from '@/container.js';
import { CryptoService } from '@/services/crypto.service.js';
import { presentDeploymentForCaller, redactDeploymentEnvironment } from './docker-deployment-redaction.js';
import { sealWebhookToken } from './docker-webhook-token.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

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

  it('reveals the webhook token to webhook managers, never the stored hash or ciphertext', () => {
    container.registerInstance(CryptoService, new CryptoService('ab'.repeat(32)));
    const sealed = { ...deployment(), webhook: { id: 'webhook-1', ...sealWebhookToken(TOKEN) } };
    const revealed = presentDeploymentForCaller(
      sealed,
      [`docker:containers:webhooks:${NODE_ID}/${DEPLOYMENT_ID}`],
      NODE_ID,
      DEPLOYMENT_ID
    );
    expect(revealed.webhook).toEqual({ id: 'webhook-1', token: TOKEN, tokenLost: false });
    const hidden = presentDeploymentForCaller(sealed, [`docker:containers:view:${NODE_ID}`], NODE_ID, DEPLOYMENT_ID);
    expect(hidden.webhook).toEqual({ id: 'webhook-1', token: '[REDACTED]', tokenLost: false });
  });

  it('flags a webhook that only has a hash as lost, with no token', () => {
    const sealed = { ...deployment(), webhook: { id: 'webhook-1', token: null, tokenHash: 'a'.repeat(64) } };
    const revealed = presentDeploymentForCaller(
      sealed,
      [`docker:containers:webhooks:${NODE_ID}/${DEPLOYMENT_ID}`],
      NODE_ID,
      DEPLOYMENT_ID
    );
    expect(revealed.webhook).toEqual({ id: 'webhook-1', token: null, tokenLost: true });
    const hidden = presentDeploymentForCaller(sealed, [`docker:containers:view:${NODE_ID}`], NODE_ID, DEPLOYMENT_ID);
    expect(hidden.webhook).toEqual({ id: 'webhook-1', token: null, tokenLost: true });
  });
});
