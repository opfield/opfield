import { describe, expect, it } from 'vitest';
import { DockerComposeNodeDispatcher } from './compose-node-dispatcher.js';

const input = { action: 'apply', operationId: 'op-1', projectId: 'p-1', projectName: 'web', options: {} } as never;
const dispatcher = (result: { success: boolean; error?: string }) =>
  new DockerComposeNodeDispatcher({ sendDockerComposeCommand: async () => result } as never);

describe('DockerComposeNodeDispatcher', () => {
  it('turns a command the daemon never started before its session ended into a lost connection', async () => {
    await expect(
      dispatcher({ success: false, error: 'the control session ended before the command started; retry' }).execute(
        'node-1',
        input
      )
    ).rejects.toThrow(/connection changed/);
  });

  it('keeps any other daemon failure as the operation result', async () => {
    await expect(dispatcher({ success: false, error: 'compose up failed' }).execute('node-1', input)).resolves.toEqual({
      success: false,
      message: 'compose up failed',
      detail: undefined,
    });
  });
});
