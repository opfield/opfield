import { appendFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Audit rows Opfield could not store because its database was already gone (M-7): at a host shutdown dockerd stops
 * every container at once, so postgres can end before the app's shutdown drain wrote its last rows. They are kept in
 * a local file on the app's data volume and stored at the next start. A row keeps its id, so storing it twice (a start
 * that stopped halfway through the replay) adds it once.
 */
export interface SpooledAuditRow {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

const SPOOL_FILE = 'audit-spool.jsonl';
const REPLAY_SUFFIX = '.replaying.jsonl';

export function auditSpoolDir(): string {
  return process.env.AUDIT_SPOOL_DIR || '/var/lib/gateway/audit-spool';
}

export async function spoolAuditRow(row: SpooledAuditRow, dir = auditSpoolDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, SPOOL_FILE), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export interface SpooledAuditBatch {
  file: string;
  rows: SpooledAuditRow[];
  malformed: number;
}

/**
 * Moves the spool aside (rows spooled from now on start a new file) and returns every batch waiting, including those
 * of an earlier replay that did not finish. The caller removes a batch with `finishSpooledAuditBatch` once stored.
 */
export async function takeSpooledAuditBatches(dir = auditSpoolDir()): Promise<SpooledAuditBatch[]> {
  try {
    await rename(join(dir, SPOOL_FILE), join(dir, `audit-spool.${Date.now()}${REPLAY_SUFFIX}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const batches: SpooledAuditBatch[] = [];
  for (const name of names.filter((entry) => entry.endsWith(REPLAY_SUFFIX)).sort()) {
    const file = join(dir, name);
    const rows: SpooledAuditRow[] = [];
    let malformed = 0;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SpooledAuditRow;
        if (typeof row?.id === 'string' && typeof row.action === 'string' && typeof row.createdAt === 'string')
          rows.push(row);
        else malformed += 1;
      } catch {
        // A line cut by a crash mid-append.
        malformed += 1;
      }
    }
    batches.push({ file, rows, malformed });
  }
  return batches;
}

export async function finishSpooledAuditBatch(batch: SpooledAuditBatch): Promise<void> {
  await rm(batch.file, { force: true });
}

/** The database connection is gone (server shut down, refused, reset, pool closed), not a rejected row. */
export function isAuditDatabaseUnavailable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    if (/^(57P0[123]|08\d{3})$/.test(code)) return true;
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(code))
      return true;
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (
      /Connection terminated|terminating connection|Cannot use a pool after calling end|Client has encountered a connection error|timeout exceeded when trying to connect|the database system is shutting down/i.test(
        message
      )
    )
      return true;
    current = candidate.cause;
  }
  return false;
}
