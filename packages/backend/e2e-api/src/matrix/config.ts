import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ALL_PHASES = ['fleet', 'crawl', 'runtime', 'chaos'] as const;
export type Phase = (typeof ALL_PHASES)[number];

export type MatrixConfig = {
  url: string;
  token: string;
  connectorId: string;
  seed: string;
  /** Every resource the matrix creates starts with this prefix; leftover checks filter on it. */
  prefix: string;
  phases: Set<Phase>;
  outDir: string;
  /** Leave the fleet VMs running after the run (development loop). */
  keepFleet: boolean;
  /** Reuse ready fleet nodes named `<prefix><role>` instead of ordering new VMs. */
  reuseFleet: boolean;
  /** Roles the fleet orders (default all six). */
  roles: string[];
  /** Only tear down what an earlier run with this SEED left (VMs, nodes), then report. */
  sweep: boolean;
  /** Poll interval for every wait loop. */
  pollMs: number;
  deadlines: {
    hostingOperationMs: number;
    nodeOnlineMs: number;
    workloadMs: number;
    taskMs: number;
    chaosRecoveryMs: number;
    requestMs: number;
  };
};

function readToken() {
  if (process.env.OPFIELD_TOKEN) return process.env.OPFIELD_TOKEN.trim();
  if (process.env.OPFIELD_TOKEN_FILE) return readFileSync(process.env.OPFIELD_TOKEN_FILE, 'utf8').trim();
  throw new Error('Set OPFIELD_TOKEN (or OPFIELD_TOKEN_FILE) to an Opfield API token');
}

function minutes(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60_000;
}

export function loadMatrixConfig(): MatrixConfig {
  const url = process.env.OPFIELD_URL;
  if (!url) throw new Error('Set OPFIELD_URL, e.g. https://opfield.example:3000');
  const connectorId = process.env.HOSTING_CONNECTOR_ID ?? '';
  const seed = (process.env.SEED ?? String(Math.floor(Math.random() * 1_000_000))).toLowerCase();
  if (!/^[a-z0-9]{1,12}$/.test(seed)) throw new Error('SEED must be 1-12 lowercase letters or digits');
  const requested = (process.env.PHASES ?? ALL_PHASES.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = requested.filter((value) => !(ALL_PHASES as readonly string[]).includes(value));
  if (unknown.length) throw new Error(`Unknown PHASES: ${unknown.join(', ')} (known: ${ALL_PHASES.join(', ')})`);
  const phases = new Set(requested as Phase[]);
  if (phases.has('fleet') && !connectorId) throw new Error('The fleet phase needs HOSTING_CONNECTOR_ID');
  if (process.env.MATRIX_INSECURE_TLS === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return {
    url: url.replace(/\/+$/, ''),
    token: readToken(),
    connectorId,
    seed,
    prefix: `mx-${seed}-`,
    phases,
    outDir: resolve(process.env.MATRIX_OUT_DIR ?? resolve(import.meta.dirname, '../../out')),
    keepFleet: process.env.MATRIX_KEEP_FLEET === '1',
    reuseFleet: process.env.MATRIX_REUSE_FLEET === '1',
    roles: (process.env.MATRIX_ROLES ?? 'nginx,docker,storage,builder,monitoring,relay')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    sweep: process.env.MATRIX_SWEEP === '1',
    pollMs: Math.max(1000, Number(process.env.MATRIX_POLL_MS) || 4000),
    deadlines: {
      hostingOperationMs: minutes('MATRIX_HOSTING_DEADLINE_MIN', 15),
      nodeOnlineMs: minutes('MATRIX_NODE_ONLINE_DEADLINE_MIN', 5),
      workloadMs: minutes('MATRIX_WORKLOAD_DEADLINE_MIN', 8),
      taskMs: minutes('MATRIX_TASK_DEADLINE_MIN', 5),
      chaosRecoveryMs: minutes('MATRIX_CHAOS_DEADLINE_MIN', 8),
      requestMs: Math.max(5000, Number(process.env.MATRIX_REQUEST_TIMEOUT_MS) || 45_000),
    },
  };
}
