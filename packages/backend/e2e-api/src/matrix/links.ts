import type { MatrixContext } from './context.js';
import { execInContainer } from './exec.js';
import { data, Failure, ok, waitFor } from './http.js';

/**
 * Invariant "desired = actual for links": whatever a database binding, storage binding or container link says about
 * its consumer workload (the env var names of its environment mapping, the link network) must be what the consumer's
 * container really has, within a deadline, after every create, recreate, restart or delete.
 */
export type ConsumerState = {
  found: boolean;
  env: Set<string>;
  /** Why the env could not be read (the API hides runtime env; the runner reads it through the console). */
  envError?: string;
  networks: Set<string>;
  running: boolean;
  restartCount: number;
};

export async function consumerState(ctx: MatrixContext, nodeId: string, container: string): Promise<ConsumerState> {
  const response = await ctx.client.get(`/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(container)}`, {
    template: '/api/docker/nodes/{nodeId}/containers/{containerId}',
    secretResponse: true,
  });
  if (!ok(response)) return { found: false, env: new Set(), networks: new Set(), running: false, restartCount: 0 };
  const inspect = data<any>(response) ?? {};
  const networksValue = inspect.NetworkSettings?.Networks ?? inspect.networks ?? {};
  const networks = new Set(
    Array.isArray(networksValue)
      ? networksValue.map((item: any) => String(item?.name ?? item))
      : Object.keys(networksValue)
  );
  const state = inspect.State ?? inspect.state ?? {};
  const running = state.Running === true || state === 'running' || state.Status === 'running';
  // The inspect API strips Config.Env and GET …/env returns the stored user env, so the real runtime env is read
  // inside the container (names only).
  let envError: string | undefined;
  const env = new Set<string>();
  if (running) {
    const result = await execInContainer(ctx, nodeId, String(inspect.Id ?? container), 'env | cut -d= -f1');
    if (result.output !== undefined)
      for (const line of result.output.split('\n'))
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.trim())) env.add(line.trim());
        else envError = result.error;
  } else envError = 'container not running';
  return {
    found: true,
    env,
    envError,
    networks,
    running,
    restartCount: Number(inspect.RestartCount ?? state.RestartCount ?? 0),
  };
}

/** Env var names and network a link row declares for its consumer. */
export function desiredOf(row: any, fallbackEnv: Record<string, string> = {}) {
  const environment = row?.environment && typeof row.environment === 'object' ? row.environment : fallbackEnv;
  const env = Object.values(environment).filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  const network = typeof row?.networkName === 'string' && row.networkName ? row.networkName : undefined;
  return { env, network };
}

/**
 * Polls the consumer until it matches `present` (all env names and the network attached) or `absent` (none of them),
 * and throws a Failure describing the difference when the deadline passes.
 */
export async function expectConsumerMatches(
  ctx: MatrixContext,
  options: {
    label: string;
    nodeId: string;
    container: string;
    env: string[];
    network?: string;
    present: boolean;
    timeoutMs?: number;
  }
) {
  let last: ConsumerState | undefined;
  const diff = (state: ConsumerState) => {
    const missing = options.present
      ? options.env.filter((name) => !state.env.has(name))
      : options.env.filter((name) => state.env.has(name));
    const network =
      options.network && (options.present ? !state.networks.has(options.network) : state.networks.has(options.network))
        ? [`network ${options.network} ${options.present ? 'not attached' : 'still attached'}`]
        : [];
    return [...missing.map((name) => `env ${name} ${options.present ? 'missing' : 'still set'}`), ...network];
  };
  const matched = await waitFor(
    async () => {
      last = await consumerState(ctx, options.nodeId, options.container);
      if (!last.found) return options.present ? undefined : true;
      if (last.envError && options.env.length) return undefined;
      return diff(last).length === 0 ? true : undefined;
    },
    { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: ctx.config.pollMs }
  );
  ctx.report.cover(
    `invariant:link desired=actual (${options.present ? 'present' : 'absent'})`,
    matched ? 'exercised' : 'failed',
    options.label
  );
  if (!matched) {
    const problems = !last?.found
      ? ['consumer container not found']
      : last.envError && options.env.length
        ? [`runtime env unreadable (${last.envError})`, ...diff(last).filter((item) => item.startsWith('network'))]
        : diff(last);
    throw new Failure(
      `desired≠actual after ${options.label}: ${problems.join(', ')} on consumer ${options.container} (running=${String(last?.running)}, restarts=${last?.restartCount ?? '?'})`
    );
  }
}
