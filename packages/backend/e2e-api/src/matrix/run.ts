import { runChaos } from './chaos.js';
import { loadMatrixConfig, type Phase } from './config.js';
import { MatrixContext } from './context.js';
import { Crawler, findLeftovers } from './crawl.js';
import {
  adoptForSweep,
  assertFleetHealthy,
  provisionFleet,
  resolveAddresses,
  reuseExistingFleet,
  teardownFleet,
} from './fleet.js';
import { MatrixClient, ok } from './http.js';
import { compareAlerts, snapshotAlerts, staleDockerTasks, sweepAsyncs } from './invariants.js';
import { Report } from './report.js';
import { Rng } from './rng.js';
import { runCleanups, runComposeRebootCheck, runRuntime } from './runtime.js';

async function main() {
  const config = loadMatrixConfig();
  const phasesLabel = [...config.phases].join(',');
  const report = new Report(config.seed, config.url, phasesLabel);
  const client = new MatrixClient(config.url, config.token, report, config.deadlines.requestMs);
  const ctx = new MatrixContext(config, client, report, new Rng(config.seed));
  // During a chaos fault (and one recovery deadline after it), node-offline answers are waited out.
  client.chaosRecoveryMs = config.deadlines.chaosRecoveryMs;
  client.chaosActive = () =>
    ctx.chaos.some((event) => !event.recoveredAt && Date.now() - event.at < config.deadlines.chaosRecoveryMs);
  const started = Date.now();
  console.log(`Opfield surface matrix · seed ${config.seed} · phases ${phasesLabel} · ${config.url}`);

  const phase = async (name: string, enabled: boolean, run: () => Promise<void>) => {
    const startedAt = new Date();
    if (!enabled) {
      report.phases.push({ phase: name, startedAt: startedAt.toISOString(), ms: 0, status: 'skipped' });
      return;
    }
    report.currentPhase = name;
    console.log(`\n== ${name}`);
    let status: 'ok' | 'failed' = 'ok';
    let note: string | undefined;
    try {
      await run();
    } catch (error) {
      status = 'failed';
      note = (error as Error).message.slice(0, 300);
      report.add({ severity: 'high', invariant: 'phase-completes', title: `phase ${name} aborted: ${note}` });
      console.error(`  phase ${name} error: ${(error as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
    report.phases.push({
      phase: name,
      startedAt: startedAt.toISOString(),
      ms: Date.now() - startedAt.getTime(),
      status,
      note,
    });
  };
  const has = (name: Phase) => config.phases.has(name);

  let crawler: Crawler | undefined;
  let alerts = new Map<string, any>();
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    await phase('teardown', true, async () => {
      await runCleanups(ctx);
      if (crawler && ctx.fleet.size) await findLeftovers(ctx, crawler, 'before fleet teardown', true);
      if ((has('fleet') && !config.keepFleet) || config.sweep) await teardownFleet(ctx);
      else if (ctx.fleet.size)
        report.note(`fleet kept (${[...ctx.fleet.values()].map((node) => node.name).join(', ')})`);
      if (crawler) await findLeftovers(ctx, crawler, 'after teardown', !has('fleet') || config.keepFleet);
    });
  };
  const onSignal = (signal: string) => {
    console.error(`\n${signal}: tearing down before exit`);
    teardown()
      .catch((error) => console.error(error))
      .finally(() => {
        const paths = report.write(config.outDir, { interrupted: signal });
        console.error(`report: ${paths.mdPath}`);
        process.exit(130);
      });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await phase('setup', true, async () => {
      const health = await client.get('/health', { allow5xx: true });
      if (!ok(health)) report.note(`/health answered ${health.status} at start`);
      alerts = await snapshotAlerts(ctx);
      report.note(`active alerts at start: ${alerts.size}`);
      crawler = await Crawler.load(ctx);
      report.note(`OpenAPI: ${crawler.spec.operations.length} operations`);
      if (config.sweep) {
        await adoptForSweep(ctx);
        return;
      }
      if (!has('fleet') || config.reuseFleet) {
        await reuseExistingFleet(ctx);
        await resolveAddresses(ctx);
      }
    });
    if (config.sweep) config.phases.clear();
    await phase('fleet', has('fleet'), () => provisionFleet(ctx));
    await phase('crawl', has('crawl') && Boolean(crawler), async () => {
      await crawler!.crawlGets();
      await crawler!.crudFamilies();
      await crawler!.negativeFuzz();
      await runCleanups(ctx);
    });
    await phase('runtime', has('runtime') || has('chaos'), async () => {
      const until = { done: false };
      const chaos = has('chaos') ? runChaos(ctx, until) : Promise.resolve();
      if (has('runtime') && process.env.MATRIX_ONLY === 'compose-reboot') await runComposeRebootCheck(ctx);
      else if (has('runtime')) await runRuntime(ctx, crawler);
      until.done = true;
      await chaos;
      await runCleanups(ctx);
    });
    await phase('invariants', true, async () => {
      await sweepAsyncs(ctx, 120_000);
      await staleDockerTasks(ctx);
      await assertFleetHealthy(ctx, 'end of run');
      await compareAlerts(ctx, alerts);
      if (ctx.undocumentedUsed.size && crawler) {
        const missing = [...ctx.undocumentedUsed].filter((key) => {
          const [method, path] = key.split(' ');
          return !crawler!.spec.find(method!, path!);
        });
        if (missing.length)
          report.add({
            severity: 'low',
            invariant: 'openapi-complete',
            title: `${missing.length} API operations the runner needed are absent from the OpenAPI document`,
            detail: missing.sort().join(', '),
          });
      }
    });
  } finally {
    await teardown();
    const extra = {
      fleet: [...ctx.fleet.values()],
      calls: { total: client.calls.length, byStatus: countBy(client.calls.map((call) => String(call.status))) },
      chaos: ctx.chaos,
    };
    const paths = report.write(config.outDir, extra);
    const summary = report.summary();
    console.log(`\nDone in ${Math.round((Date.now() - started) / 60_000)} min · ${client.calls.length} requests`);
    console.log(
      `coverage: ${summary.operations} operations (exercised ${summary.exercised}, failed ${summary.failed}, skipped ${summary.skipped}) · findings ${summary.findings} ${JSON.stringify(summary.bySeverity)}`
    );
    console.log(`report: ${paths.mdPath}\n        ${paths.jsonPath}`);
    process.exitCode = summary.bySeverity.critical || summary.bySeverity.high ? 1 : 0;
  }
}

function countBy(values: string[]) {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(2);
});
