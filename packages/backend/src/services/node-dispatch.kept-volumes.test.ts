import { beforeEach, describe, expect, it, vi } from 'vitest';

const kept = vi.hoisted(() => ({ names: new Set<string>(), fail: false }));
vi.mock('./docker-kept-volumes.js', () => ({
  opfieldKeptVolumeNames: vi.fn(async () => {
    if (kept.fail) throw new Error('database unavailable');
    return new Set(kept.names);
  }),
}));

import { DOCKER_KEPT_VOLUMES_CAPABILITY, NodeDispatchService } from './node-dispatch.service.js';

const ADOPTED = 'a'.repeat(64);
const NAMED_IN_CONFIG = 'b'.repeat(64);

describe('NodeDispatchService kept volumes', () => {
  function harness(capable = true, keepResult = { success: true }) {
    const sent: Array<Record<string, any>> = [];
    const registry = {
      getNode: vi.fn(() => ({ type: 'docker', capabilities: [] })),
      hasCapability: vi.fn(
        (_nodeId: string, capability: string) => capable && capability === DOCKER_KEPT_VOLUMES_CAPABILITY
      ),
      sendCommand: vi.fn(async (_nodeId: string, command: Record<string, any>) => {
        sent.push(command);
        return command.dockerVolume?.action === 'keep' ? keepResult : { success: true };
      }),
    };
    const dispatch = new NodeDispatchService(registry as any, {} as any);
    (dispatch as any).assertGenericDockerNode = vi.fn(async () => undefined);
    (dispatch as any).assertNodeMutable = vi.fn(async () => undefined);
    return { dispatch, sent };
  }

  beforeEach(() => {
    kept.names = new Set([NAMED_IN_CONFIG, ADOPTED]);
    kept.fail = false;
  });

  it('tells the daemon which volumes to keep before a deployment command or a placement removal', async () => {
    const { dispatch, sent } = harness();

    await dispatch.sendDockerDeploymentCommand('node-1', 'deploy', { deploymentId: 'dep-1' });
    await dispatch.sendDockerContainerCommand('node-2', 'remove', {
      containerId: 'placement',
      force: true,
      configJson: JSON.stringify({ removeAnonymousVolumes: true }),
    });

    const keep = sent.filter((command) => command.dockerVolume?.action === 'keep');
    expect(keep).toHaveLength(2);
    expect(JSON.parse(keep[0].dockerVolume.content.toString())).toEqual({ names: [ADOPTED, NAMED_IN_CONFIG] });
    expect(sent.map((command) => Object.keys(command)[0])).toEqual([
      'dockerVolume',
      'dockerDeployment',
      'dockerVolume',
      'dockerContainer',
    ]);
  });

  it('sends an unchanged set once, and again when it changes', async () => {
    const { dispatch, sent } = harness();
    await dispatch.sendDockerDeploymentCommand('node-1', 'switch', { deploymentId: 'dep-1' });
    await dispatch.sendDockerDeploymentCommand('node-1', 'deploy', { deploymentId: 'dep-1' });
    kept.names.add('f'.repeat(64));
    await dispatch.sendDockerDeploymentCommand('node-1', 'deploy', { deploymentId: 'dep-1' });
    expect(sent.filter((command) => command.dockerVolume?.action === 'keep')).toHaveLength(2);
  });

  it('does not send the removal when a capable daemon cannot be told, nor when the set cannot be read', async () => {
    const refused = harness(true, { success: false, error: 'disk full' } as any);
    await expect(refused.dispatch.sendDockerDeploymentCommand('node-1', 'deploy', {})).rejects.toMatchObject({
      code: 'DOCKER_KEPT_VOLUMES_SYNC_FAILED',
    });
    expect(refused.sent.some((command) => command.dockerDeployment)).toBe(false);

    kept.fail = true;
    const unreadable = harness();
    await expect(unreadable.dispatch.sendDockerDeploymentCommand('node-1', 'deploy', {})).rejects.toMatchObject({
      code: 'DOCKER_KEPT_VOLUMES_UNAVAILABLE',
    });
    expect(unreadable.sent).toEqual([]);
  });

  it('leaves daemons without the capability, reads and plain container removals alone', async () => {
    const old = harness(false);
    await old.dispatch.sendDockerDeploymentCommand('node-1', 'deploy', {});
    expect(old.sent.map((command) => Object.keys(command)[0])).toEqual(['dockerDeployment']);

    const { dispatch, sent } = harness();
    await dispatch.sendDockerDeploymentCommand('node-1', 'inspect', {});
    await dispatch.sendDockerContainerCommand('node-1', 'remove', { containerId: 'user-container' });
    expect(sent.some((command) => command.dockerVolume)).toBe(false);
  });
});
