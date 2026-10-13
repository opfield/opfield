import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { acceptedOperations } from '@/edition/accepted-operations.js';
import { createChildLogger } from '@/lib/logger.js';
import { firstShutdownReport, isShuttingDown } from '@/services/shutdown-state.js';
import { releaseLostCheckedOutClients } from './checked-out-client-errors.js';
import * as schema from './schema/index.js';

const logger = createChildLogger('Database');
const CONNECTION_LOSS_LOG_INTERVAL_MS = 60_000;

const { Pool } = pg;

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;
export type DrizzleTransaction = Parameters<Parameters<DrizzleClient['transaction']>[0]>[0];
export type DrizzleExecutor = DrizzleClient | DrizzleTransaction;

export function createDrizzleClient(connectionString: string): DrizzleClient {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  // pg re-emits the error of an idle client whose connection the server ended (postgres stops or restarts: 57P01)
  // on the pool. Without a listener it was an uncaught exception, 13 of them at a host shutdown (N-19), and one
  // could end the process in the middle of its drain. The pool replaces the client on the next query.
  let lastReported = 0;
  const reportLostConnection = (message: string, error: Error) => {
    if (isShuttingDown()) {
      if (firstShutdownReport('postgres')) {
        logger.info('Database connections closed while Opfield shuts down', { error: error.message });
      }
      return;
    }
    const now = Date.now();
    if (now - lastReported < CONNECTION_LOSS_LOG_INTERVAL_MS) return;
    lastReported = now;
    logger.warn(message, { error: error.message });
  };
  pool.on('error', (error) =>
    reportLostConnection('An idle database connection was lost; the next query opens a new one', error)
  );
  // A connection lost while a transaction or session lock holds it fails that operation, not the process.
  releaseLostCheckedOutClients(pool, (error) =>
    reportLostConnection('A database connection was lost while in use; the operation using it failed', error)
  );

  refuseAbandonedOperations(pool);
  return drizzle(pool, { schema });
}

/** Thrown to work a stopping Gateway left to durable recovery when it reaches the database. */
export class AbandonedOperationError extends Error {
  constructor() {
    super('Opfield is stopping; this operation is resumed by recovery after the restart');
    this.name = 'AbandonedOperationError';
  }
}

/**
 * Work a stopping Gateway left to recovery (acceptedOperations.abandonRunning) keeps running until the process
 * exits. It must not write anything from then on: a step that fails only because Gateway goes away would record the
 * operation as failed, and recovery would no longer resume it. A transaction already open completes.
 */
function refuseAbandonedOperations(pool: pg.Pool): void {
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const refuse = (args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      queueMicrotask(() => (callback as (error: Error) => void)(new AbandonedOperationError()));
      return undefined;
    }
    return Promise.reject(new AbandonedOperationError());
  };
  pool.query = ((...args: unknown[]) =>
    acceptedOperations.isAbandoned() ? refuse(args) : query(...args)) as unknown as typeof pool.query;
  pool.connect = ((...args: unknown[]) =>
    acceptedOperations.isAbandoned() ? refuse(args) : connect(...args)) as unknown as typeof pool.connect;
}
