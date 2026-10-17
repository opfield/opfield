import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { withWriteFileHint } from './ai-tool-errors.js';

// rc.3 stand O-6: write_file on a new path answered "DISPATCH_ERROR: file is not writable: /blob.txt" without saying
// that create_file makes a new file.
describe('write_file refusals', () => {
  it('name create_file when the file does not exist or is not writable', async () => {
    await expect(
      withWriteFileHint(Promise.reject(new AppError(502, 'DISPATCH_ERROR', 'file is not writable: /blob.txt')))
    ).rejects.toMatchObject({
      code: 'FILE_NOT_WRITABLE',
      message:
        'file is not writable: /blob.txt. write_file changes an existing regular file you may write; to make a new file use create_file (with content).',
    });
  });

  it('pass other errors and results through', async () => {
    await expect(withWriteFileHint(Promise.resolve(1))).resolves.toBe(1);
    const other = new Error('node offline');
    await expect(withWriteFileHint(Promise.reject(other))).rejects.toBe(other);
  });
});
