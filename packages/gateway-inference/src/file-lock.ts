import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CliError } from './errors.js';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

export async function withFileLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  errorCode = 'RESOURCE_LOCKED'
): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        return await operation();
      } finally {
        await handle.close();
        await rm(lockFile, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lockFile)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CliError(errorCode, 'Another Opfield Inference process is updating this resource.');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
