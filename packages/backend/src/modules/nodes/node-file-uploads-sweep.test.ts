import { describe, expect, it, vi } from 'vitest';
import { abortNodeFileUpload, initNodeFileUpload, sweepNodeFileUploads } from './node-file-operations.js';

// rc.3 stand O-8: an abandoned node file upload was cancelled only when someone started another upload, sessions were
// lost on restart (leaving the partial file), and upload_abort of an unknown id answered plain success.
function context(pending: Record<string, { nodeId: string; path: string }>) {
  const commands: Array<{ nodeId: string; action: string; uploadId: string }> = [];
  return {
    commands,
    pending,
    context: {
      nodeDispatch: {
        sendNodeFileCommand: vi.fn(async (nodeId: string, action: string, payload: { path: string }) => {
          commands.push({ nodeId, action, uploadId: payload.path });
          return { success: true };
        }),
      },
      auditService: { log: vi.fn() },
      parseResult: (result: unknown) => result,
      pendingUploads: {
        load: async () => ({ ...pending }),
        save: async (next: Record<string, { nodeId: string; path: string }>) => {
          for (const key of Object.keys(pending)) delete pending[key];
          Object.assign(pending, next);
        },
      },
    } as never,
  };
}

describe('abandoned node file uploads', () => {
  it('removes the partial file of an upload an earlier Opfield process started', async () => {
    const t = context({ 'lost-1': { nodeId: 'node-1', path: '/tmp/a.bin' } });
    await expect(sweepNodeFileUploads(t.context)).resolves.toBe(1);
    expect(t.commands).toEqual([{ nodeId: 'node-1', action: 'upload-abort', uploadId: 'lost-1' }]);
    expect(t.pending).toEqual({});
  });

  it('keeps an upload in progress and removes an expired one at the next pass', async () => {
    const t = context({});
    const { uploadId } = await initNodeFileUpload(
      t.context,
      'node-2',
      '/tmp/b.bin',
      100,
      'user-1',
      '00000000-0000-4000-8000-00000000000a'
    );
    expect(t.pending).toEqual({ '00000000-0000-4000-8000-00000000000a': { nodeId: 'node-2', path: '/tmp/b.bin' } });
    await sweepNodeFileUploads(t.context);
    expect(t.commands.filter((c) => c.action === 'upload-abort')).toEqual([]);

    await sweepNodeFileUploads(t.context, Date.now() + 31 * 60_000);
    expect(t.commands.filter((c) => c.action === 'upload-abort').map((c) => c.uploadId)).toContain(uploadId);
  });

  it('says whether there was an upload to cancel', async () => {
    const t = context({});
    await expect(abortNodeFileUpload(t.context, 'node-3', 'unknown')).resolves.toEqual({ aborted: false });
    await initNodeFileUpload(t.context, 'node-3', '/tmp/c.bin', 10, 'user-1', '00000000-0000-4000-8000-00000000000b');
    await expect(abortNodeFileUpload(t.context, 'node-3', '00000000-0000-4000-8000-00000000000b')).resolves.toEqual({
      aborted: true,
    });
    expect(t.pending).toEqual({});
  });
});
