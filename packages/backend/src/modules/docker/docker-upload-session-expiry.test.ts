import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileUploadChunk, completeFileUpload, initFileUpload } from './docker-read-operations.js';
import { appendVolumeFileUploadChunk, initVolumeFileUpload } from './docker-volume-network-operations.js';

const MINUTE = 60 * 1000;

function containerContext() {
  const sendDockerFileCommand = vi.fn(async () => ({ success: true }));
  return {
    sendDockerFileCommand,
    context: {
      nodeDispatch: { sendDockerFileCommand } as any,
      auditService: { log: vi.fn(async () => undefined) } as any,
      parseResult: (result: any) => result,
    },
  };
}

function volumeContext() {
  const sendDockerVolumeCommand = vi.fn(async () => ({ success: true }));
  return {
    sendDockerVolumeCommand,
    context: {
      nodeDispatch: { sendDockerVolumeCommand } as any,
      auditService: { log: vi.fn(async () => undefined) } as any,
      parseResult: (result: any) => result,
    } as any,
  };
}

function abortCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter((call: any[]) => call[1] === 'upload-abort');
}

describe('chunked upload sessions that expire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the node to remove the temp file of an abandoned container upload', async () => {
    const { context, sendDockerFileCommand } = containerContext();
    await initFileUpload(
      context,
      'node-1',
      'app',
      '/data/big.bin',
      10,
      'user-1',
      '00000000-0000-4000-8000-000000000001'
    );

    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(abortCalls(sendDockerFileCommand)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(abortCalls(sendDockerFileCommand)).toEqual([
      [
        'node-1',
        'upload-abort',
        { containerId: 'app', path: '00000000-0000-4000-8000-000000000001', targetPath: '/data/big.bin' },
      ],
    ]);
  });

  it('keeps an upload that is still receiving chunks', async () => {
    const { context, sendDockerFileCommand } = containerContext();
    await initFileUpload(
      context,
      'node-1',
      'app',
      '/data/live.bin',
      10,
      'user-1',
      '00000000-0000-4000-8000-000000000002'
    );

    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    await appendFileUploadChunk(
      context,
      'node-1',
      'app',
      '00000000-0000-4000-8000-000000000002',
      0,
      Buffer.from('12345')
    );
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(abortCalls(sendDockerFileCommand)).toHaveLength(0);

    await appendFileUploadChunk(
      context,
      'node-1',
      'app',
      '00000000-0000-4000-8000-000000000002',
      5,
      Buffer.from('67890')
    );
    await completeFileUpload(context, 'node-1', 'app', '00000000-0000-4000-8000-000000000002', '/data/live.bin', 10);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(abortCalls(sendDockerFileCommand)).toHaveLength(0);
  });

  it('tells the node to remove the temp file of an abandoned volume upload, and keeps a live one', async () => {
    const { context, sendDockerVolumeCommand } = volumeContext();
    await initVolumeFileUpload(
      context,
      'node-1',
      'data',
      '/a.bin',
      10,
      'user-1',
      '00000000-0000-4000-8000-000000000003'
    );
    await initVolumeFileUpload(
      context,
      'node-1',
      'data',
      '/b.bin',
      10,
      'user-1',
      '00000000-0000-4000-8000-000000000004'
    );

    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    await appendVolumeFileUploadChunk(
      context,
      'node-1',
      'data',
      '00000000-0000-4000-8000-000000000004',
      0,
      Buffer.from('12345')
    );
    await vi.advanceTimersByTimeAsync(11 * MINUTE);

    expect(abortCalls(sendDockerVolumeCommand)).toEqual([
      ['node-1', 'upload-abort', { name: 'data', path: '00000000-0000-4000-8000-000000000003', targetPath: '/a.bin' }],
    ]);
  });
});
