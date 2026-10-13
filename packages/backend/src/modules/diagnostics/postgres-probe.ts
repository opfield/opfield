import { performance } from 'node:perf_hooks';
import pg from 'pg';

const PROBE_TIMEOUT_MS = 2_000;
const LONG_QUERY_SECONDS = 30;

export interface PostgresProbeResult {
  status: 'ok' | 'unavailable';
  latencyMs: number | null;
  error?: string;
}

export interface PostgresDetails {
  version: string;
  databaseSizeBytes: number;
  maxConnections: number;
  connectionsByState: Record<string, number>;
  waitingOnLocks: number;
  /** Statements running for more than 30 seconds, oldest first. */
  longRunning: Array<{ pid: number; state: string; seconds: number; waitEvent: string | null; query: string }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer from Postgres within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Checks Postgres over a connection of its own, not the pool: queries queued in a saturated pool
 * would make a busy database look like an unavailable one. One connection, opened on demand and
 * replaced after any error; concurrent probes share one round trip.
 */
export class PostgresProbe {
  private client: pg.Client | null = null;
  private connecting: Promise<pg.Client> | null = null;
  private inFlight: Promise<PostgresProbeResult> | null = null;

  constructor(private readonly connectionString: string) {}

  probe(): Promise<PostgresProbeResult> {
    this.inFlight ??= this.runProbe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async details(): Promise<PostgresDetails> {
    const client = await this.connect();
    const [summary, states, long] = await withTimeout(
      Promise.all([
        client.query<{ version: string; size: string; max_connections: number }>(
          `SELECT version() AS version,
                  pg_database_size(current_database())::text AS size,
                  current_setting('max_connections')::int AS max_connections`
        ),
        client.query<{ state: string | null; count: number; locks: number }>(
          `SELECT coalesce(state, 'unknown') AS state, count(*)::int AS count,
                  count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS locks
             FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1`
        ),
        client.query<{ pid: number; state: string | null; seconds: number; wait_event: string | null; query: string }>(
          `SELECT pid, state, extract(epoch FROM now() - query_start)::int AS seconds,
                  wait_event_type AS wait_event, left(query, 200) AS query
             FROM pg_stat_activity
            WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
              AND query_start < now() - make_interval(secs => $1)
            ORDER BY query_start LIMIT 5`,
          [LONG_QUERY_SECONDS]
        ),
      ]),
      PROBE_TIMEOUT_MS * 2
    ).catch((error: unknown) => {
      this.drop();
      throw error;
    });
    const row = summary.rows[0];
    return {
      version: row?.version.split(' on ')[0] ?? '',
      databaseSizeBytes: Number(row?.size ?? 0),
      maxConnections: row?.max_connections ?? 0,
      connectionsByState: Object.fromEntries(states.rows.map((state) => [state.state ?? 'unknown', state.count])),
      waitingOnLocks: states.rows.reduce((sum, state) => sum + state.locks, 0),
      longRunning: long.rows.map((query) => ({
        pid: query.pid,
        state: query.state ?? 'unknown',
        seconds: query.seconds,
        waitEvent: query.wait_event,
        query: query.query,
      })),
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private async runProbe(): Promise<PostgresProbeResult> {
    const started = performance.now();
    try {
      const client = await this.connect();
      await withTimeout(client.query('SELECT 1'), PROBE_TIMEOUT_MS);
      return { status: 'ok', latencyMs: Math.round((performance.now() - started) * 10) / 10 };
    } catch (error) {
      this.drop();
      return { status: 'unavailable', latencyMs: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private connect(): Promise<pg.Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const client = new pg.Client({
        connectionString: this.connectionString,
        connectionTimeoutMillis: PROBE_TIMEOUT_MS,
        application_name: 'opfield-diagnostics',
        keepAlive: true,
      });
      // An idle connection the server closed reports here; the next probe opens a new one.
      client.on('error', () => {
        if (this.client === client) this.drop();
      });
      await client.connect();
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private drop(): void {
    const client = this.client;
    this.client = null;
    client?.end().catch(() => undefined);
  }
}
