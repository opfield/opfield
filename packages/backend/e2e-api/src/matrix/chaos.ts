import type { ChaosEvent, MatrixContext } from './context.js';
import { hostingAction } from './fleet.js';
import { data, ok, sleep, waitFor } from './http.js';
import { excerpt } from './report.js';

/**
 * Seeded chaos while the runtime lanes run: reboot a random fleet VM through the hosting API and require the node
 * to come back online with a fresh health report within the recovery deadline.
 */
export async function runChaos(ctx: MatrixContext, until: { done: boolean }) {
  const rng = ctx.rng.fork('chaos');
  const rounds = Math.max(1, Number(process.env.MATRIX_CHAOS_ROUNDS) || 1);
  for (let round = 0; round < rounds; round += 1) {
    // A VM whose hosting operation never finished is busy for hosting actions; chaos picks settled ones.
    const candidates = [...ctx.fleet.values()].filter(
      (node) => node.ready && node.resourceId && node.origin !== 'reused' && (!node.phase || node.phase === 'ready')
    );
    if (!candidates.length) {
      ctx.report.cover('chaos:reboot', 'skipped', undefined, 'no ready fleet VM with a hosting resource');
      return;
    }
    const victim = rng.pick(candidates);
    const delayMs = rng.int(20, 75) * 1000;
    // Let the runtime lanes get going so the reboot lands mid-lifecycle.
    const wakeAt = Date.now() + delayMs;
    while (Date.now() < wakeAt && !until.done) await sleep(1000);
    const event: ChaosEvent = { nodeId: victim.nodeId, role: victim.role, at: Date.now(), action: 'reboot' };
    ctx.chaos.push(event);
    console.log(
      `  ⚡ chaos round ${round + 1}: reboot ${victim.role} (${victim.name}) after ${Math.round(delayMs / 1000)}s`
    );
    await ctx.step(
      `chaos:reboot ${victim.role} recovers`,
      async () => {
        const result = await hostingAction(ctx, victim.resourceId!, 'reboot', ctx.config.deadlines.chaosRecoveryMs);
        if (result.missing) throw new Error('the fleet VM is no longer in the hosting resource list');
        if (result.operation?.phase !== 'ready')
          throw new Error(`hosting reboot ended in phase ${result.operation?.phase ?? 'unknown'} (${result.phases})`);
        const node = await waitFor(
          async () => {
            const response = await ctx.client.get(`/api/nodes/${victim.nodeId}`, { template: '/api/nodes/{id}' });
            const row = data<any>(response);
            const reported = Math.max(toMillis(row?.lastHealthReport?.timestamp), toMillis(row?.lastSeenAt));
            return ok(response) && row?.status === 'online' && row?.isConnected !== false && reported > event.at
              ? row
              : undefined;
          },
          { timeoutMs: ctx.config.deadlines.chaosRecoveryMs, intervalMs: ctx.config.pollMs }
        );
        if (!node) {
          const last = data<any>(await ctx.client.get(`/api/nodes/${victim.nodeId}`, { template: '/api/nodes/{id}' }));
          throw new Error(
            `node did not report online with a fresh health report within ${Math.round(ctx.config.deadlines.chaosRecoveryMs / 60_000)} min after reboot (status ${last?.status}, connected ${String(last?.isConnected)}): ${excerpt(last?.lastHealthReport ?? {}, '', 160)}`
          );
        }
        event.recoveredAt = Date.now();
        ctx.report.note(
          `chaos: ${victim.role} back online ${Math.round((event.recoveredAt - event.at) / 1000)}s after the reboot request`
        );
      },
      { invariant: 'chaos-recovery', severity: 'critical' }
    );
  }
}

/** Health report timestamps are unix seconds; lastSeenAt is ISO. */
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? toMillis(Number(value)) : Date.parse(value) || 0;
  return 0;
}
