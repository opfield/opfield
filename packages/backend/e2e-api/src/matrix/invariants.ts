import type { MatrixContext } from './context.js';
import { ok, rows, sleep } from './http.js';
import { excerpt } from './report.js';

const ALERT_PATHS = ['/api/alerts', '/api/notifications/alerts'];

export type AlertSnapshot = Map<string, any>;

function alertKey(alert: any) {
  return String(alert?.id ?? `${alert?.type}|${alert?.title ?? alert?.message}`);
}

function isActive(alert: any) {
  return !(
    alert?.resolvedAt ||
    alert?.dismissedAt ||
    alert?.dismissed === true ||
    alert?.resolved === true ||
    alert?.status === 'resolved'
  );
}

export async function snapshotAlerts(ctx: MatrixContext): Promise<AlertSnapshot> {
  const out: AlertSnapshot = new Map();
  for (const path of ALERT_PATHS) {
    const response = await ctx.client.get(path, { query: { limit: 100 } });
    if (!ok(response)) continue;
    for (const alert of rows(response)) if (isActive(alert)) out.set(`${path}|${alertKey(alert)}`, alert);
  }
  return out;
}

/** New active system alerts compared with the start of the run are findings: the run left something unhealthy. */
export async function compareAlerts(ctx: MatrixContext, before: AlertSnapshot) {
  const after = await snapshotAlerts(ctx);
  const fresh = [...after.entries()].filter(([key]) => !before.has(key));
  const byKind = new Map<string, any[]>();
  for (const [, alert] of fresh) {
    const kind = String(alert?.type ?? alert?.category ?? alert?.title ?? 'alert');
    byKind.set(kind, [...(byKind.get(kind) ?? []), alert]);
  }
  for (const [kind, alerts] of byKind)
    ctx.report.add({
      severity: 'medium',
      invariant: 'no-new-alerts',
      title: `${alerts.length} new active system alert(s) of kind "${kind}" at the end of the run`,
      dedupeKey: `no-new-alerts|${kind}`,
      response: { status: 200, excerpt: excerpt(alerts.slice(0, 3), '') },
      detail: ctx.chaos.length
        ? `chaos events this run: ${ctx.chaos.map((event) => `${event.action} ${event.role}`).join(', ')}`
        : undefined,
    });
  return fresh.length;
}

/** Every async thing the run started must be terminal; waits up to `graceMs` for stragglers. */
export async function sweepAsyncs(ctx: MatrixContext, graceMs: number) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    let open = 0;
    for (const entry of ctx.asyncs) {
      if (entry.terminal) continue;
      try {
        const state = await entry.poll();
        entry.lastState = state.state;
        entry.terminal = state.terminal;
      } catch (error) {
        entry.lastState = `poll error: ${(error as Error).message.slice(0, 80)}`;
      }
      if (!entry.terminal) open += 1;
    }
    if (open === 0 || Date.now() > deadline) break;
    await sleep(ctx.config.pollMs);
  }
  for (const entry of ctx.asyncs.filter((item) => !item.terminal)) {
    const ageMin = Math.round((Date.now() - entry.startedAt) / 60_000);
    ctx.report.add({
      severity: ageMin * 60_000 > entry.deadlineMs ? 'high' : 'medium',
      invariant: 'async-terminal',
      title: `${entry.kind} "${entry.label}" still "${entry.lastState}" ${ageMin} min after it started`,
      dedupeKey: `async-terminal|${entry.kind}|${entry.label}`,
    });
  }
  ctx.report.note(
    `async tracker: ${ctx.asyncs.length} tracked, ${ctx.asyncs.filter((item) => !item.terminal).length} not terminal`
  );
}

/** Docker tasks on fleet nodes that stay pending/running beyond the task deadline. */
export async function staleDockerTasks(ctx: MatrixContext) {
  for (const node of [...ctx.fleet.values()].filter(
    (item) => item.ready && ['docker', 'storage', 'builder'].includes(item.role)
  )) {
    const response = await ctx.client.get('/api/docker/tasks', { query: { nodeId: node.nodeId, limit: 100 } });
    if (!ok(response)) continue;
    const stale = rows(response).filter((task) => {
      const started = Date.parse(task.createdAt ?? task.startedAt ?? '') || Date.now();
      return (
        ['pending', 'running', 'queued'].includes(task.status) && Date.now() - started > ctx.config.deadlines.taskMs
      );
    });
    if (stale.length)
      ctx.report.add({
        severity: 'high',
        invariant: 'async-terminal',
        title: `${stale.length} docker task(s) on the fleet ${node.role} node stuck in pending/running beyond ${Math.round(ctx.config.deadlines.taskMs / 60_000)} min`,
        dedupeKey: `stale-docker-tasks|${node.role}`,
        response: {
          status: 200,
          excerpt: excerpt(
            stale
              .slice(0, 3)
              .map((task) => ({ id: task.id, type: task.type, status: task.status, createdAt: task.createdAt })),
            ''
          ),
        },
      });
  }
}
