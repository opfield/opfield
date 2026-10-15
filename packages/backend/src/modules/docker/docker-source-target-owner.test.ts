import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { assertContainerSourceTargetNotOwned, findContainerSourceTargetOwner } from './docker-source-target-owner.js';

const NODE = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';

function deps(labels: Record<string, string> | null, inspectError?: Error) {
  return {
    inspect: vi.fn(async () => {
      if (inspectError) throw inspectError;
      return labels ? { Config: { Labels: labels } } : null;
    }),
    composeProjectId: vi.fn().mockResolvedValue(PROJECT_ID),
    deploymentName: vi.fn().mockResolvedValue('api'),
  };
}

describe('a Git source on a container another workload owns', () => {
  it('refuses a Compose service container and names the Compose Project to attach to', async () => {
    const refusal = assertContainerSourceTargetNotOwned(
      NODE,
      'shop-web-1',
      deps({ 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' })
    );

    await expect(refusal).rejects.toMatchObject({
      statusCode: 409,
      code: 'SOURCE_TARGET_OWNED',
      details: { ownerKind: 'compose_project', ownerId: PROJECT_ID, ownerName: 'shop' },
    });
    await expect(refusal).rejects.toThrow(`targetType compose, composeProjectId ${PROJECT_ID}`);
  });

  it('refuses a blue/green slot container and names the deployment to attach to', async () => {
    const refusal = assertContainerSourceTargetNotOwned(
      NODE,
      'api-blue',
      deps({ 'net.opfield.deployment.managed': 'true', 'net.opfield.deployment.id': DEPLOYMENT_ID })
    );

    await expect(refusal).rejects.toMatchObject({ code: 'SOURCE_TARGET_OWNED', details: { ownerKind: 'deployment' } });
    await expect(refusal).rejects.toThrow(`blue/green deployment "api"`);
    await expect(refusal).rejects.toThrow(`targetType deployment, deploymentId ${DEPLOYMENT_ID}`);
  });

  it('accepts a standalone container, a container not built yet and a node it cannot reach now', async () => {
    await expect(assertContainerSourceTargetNotOwned(NODE, 'rin', deps({}))).resolves.toBeUndefined();
    await expect(assertContainerSourceTargetNotOwned(NODE, 'rin', deps(null))).resolves.toBeUndefined();
    await expect(
      findContainerSourceTargetOwner(NODE, 'rin', deps(null, new Error('Node is offline')))
    ).resolves.toBeNull();
  });
});
