import { describe, expect, it } from 'vitest';
import { parseNodeCommandResult } from './node-service-helpers.js';

describe('node file command results', () => {
  it('answers a path the daemon user may not open with 403, not a dispatch error (F-C4)', () => {
    expect(() => parseNodeCommandResult({ success: false, error: 'open /etc/m88-f.txt: permission denied' })).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'NODE_FILE_PERMISSION_DENIED' })
    );
  });

  it('answers a path that does not exist with 404', () => {
    expect(() =>
      parseNodeCommandResult({ success: false, error: 'write file: stat /srv/a.txt: no such file or directory' })
    ).toThrow(expect.objectContaining({ statusCode: 404, code: 'NODE_FILE_NOT_FOUND' }));
  });

  it('answers a request that is wrong for its path with 4xx, not a dispatch error', () => {
    for (const [error, statusCode, code] of [
      ['not a regular/readable file: /', 400, 'NODE_FILE_INVALID_PATH'],
      ['not a directory: /etc/hosts', 400, 'NODE_FILE_INVALID_PATH'],
      ['cannot modify root directory', 400, 'NODE_FILE_INVALID_PATH'],
      ['target path already exists: /srv/b', 409, 'NODE_FILE_EXISTS'],
      ['parent directory does not exist: /srv/x/a', 404, 'NODE_FILE_NOT_FOUND'],
      ['file is not writable: /srv/a', 403, 'NODE_FILE_PERMISSION_DENIED'],
    ] as const) {
      expect(() => parseNodeCommandResult({ success: false, error })).toThrow(
        expect.objectContaining({ statusCode, code })
      );
    }
  });

  it('keeps every other daemon failure a dispatch error', () => {
    expect(() => parseNodeCommandResult({ success: false, error: 'read file: input/output error' })).toThrow(
      expect.objectContaining({ statusCode: 502, code: 'DISPATCH_ERROR' })
    );
    expect(parseNodeCommandResult({ success: true, detail: '{"ok":true}' })).toEqual({ ok: true });
  });
});
