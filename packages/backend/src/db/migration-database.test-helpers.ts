import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** The host's migrations folder. */
export const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

/** The migrations up to and including `lastTag`, in a temporary folder drizzle's migrator can read. */
export function migrationsThrough(lastTag: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'opfield-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last < 0) throw new Error(`Unknown migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const file of readdirSync(migrationsFolder).filter((name) => name.endsWith('.sql'))) {
    if (entries.some((entry) => `${entry.tag}.sql` === file))
      copyFileSync(join(migrationsFolder, file), join(folder, file));
  }
  return folder;
}

/** Applies the migrations up to and including `lastTag`, or all of them. */
export async function migrateDatabase(pool: pg.Pool, lastTag?: string): Promise<void> {
  if (!lastTag) {
    await migrate(drizzle(pool), { migrationsFolder });
    return;
  }
  const folder = migrationsThrough(lastTag);
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * pool.end() resolves before its clients' sockets close, so a later `drop database ... with (force)` can terminate
 * a connection pg is still closing. That FATAL 57P01 is expected; any other client error still surfaces. pg-pool
 * re-emits an idle client's error on the pool, where an unheard error event is an uncaught exception.
 */
export function tolerateDatabaseDrop(pool: pg.Pool): pg.Pool {
  const tolerate = (error: Error & { code?: string }) => {
    if (error.code !== '57P01') throw error;
  };
  pool.on('error', tolerate);
  pool.on('connect', (client) => {
    client.on('error', tolerate);
  });
  return pool;
}

/**
 * A fresh database next to the one `url` names (`<name>_<suffix>`), so each opt-in suite has its own. The URL must
 * point at a local, dedicated `<prefix>*` database (`opfield_migration_test_*` by default): these suites drop and
 * create databases.
 */
export async function disposableDatabase(
  url: string,
  suffix: string,
  { prefix = 'opfield_migration_test_', max = 4 }: { prefix?: string; max?: number } = {}
) {
  const target = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    !/^[a-z0-9_]+_test_$/.test(prefix) ||
    !new RegExp(`^/${prefix}[a-z0-9_]+$`).test(target.pathname) ||
    !/^[a-z0-9_]+$/.test(suffix)
  ) {
    throw new Error(`Opt-in DB tests require a local, dedicated ${prefix}* database`);
  }
  const name = `${target.pathname.slice(1)}_${suffix}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  const own = new URL(url);
  own.pathname = `/${name}`;
  const pool = tolerateDatabaseDrop(new pg.Pool({ connectionString: own.toString(), max }));
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/** The driver error behind a drizzle or pg error. */
export function pgError(error: unknown): { code?: string; constraint?: string; detail?: string } {
  const candidate = error as { code?: string; cause?: unknown };
  return (candidate?.code ? candidate : candidate?.cause) as { code?: string; constraint?: string; detail?: string };
}

/** Awaits `promise` and returns what it rejected with (undefined when it resolved). */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
}
