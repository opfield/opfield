import { describe, expect, it, vi } from 'vitest';
import { getContainerLogs } from './docker-read-operations.js';

function context(detail: string) {
  return {
    nodeDispatch: { sendDockerLogsCommand: vi.fn().mockResolvedValue({ success: true, detail }) },
    auditService: {},
    parseResult: (result: { detail?: string }) => (result.detail ? JSON.parse(result.detail) : null),
  } as never;
}

describe('container logs', () => {
  it('answers an empty list for a container that wrote nothing, also from a daemon that sends null', async () => {
    await expect(getContainerLogs(context('null'), 'node-1', 'quiet', 100, false)).resolves.toEqual([]);
    await expect(getContainerLogs(context(''), 'node-1', 'quiet', 100, false)).resolves.toEqual([]);
    await expect(getContainerLogs(context('["a","b"]'), 'node-1', 'loud', 100, false)).resolves.toEqual(['a', 'b']);
  });
});
