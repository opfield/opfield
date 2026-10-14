// Overview: the app's health (its Production environment), one row per environment, alerts and
// app-wide monitoring (canvas frames app, app-healthy, app-partial).
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cpu,
  FileStack,
  Gauge,
  Globe,
  HardDrive,
  Layers,
  MemoryStick,
  Rocket,
  RotateCcw,
  TriangleAlert,
  Users,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice, NoticeAction, noticeTone } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { appEnvironmentRoute } from "@/lib/app-routes";
import { formatBytes } from "@/lib/utils";
import { PinnedNodeCard } from "@/pages/dashboard/PinnedNodeCard";
import { METRIC_COLORS as DATABASE_COLORS } from "@/pages/database-detail/shared";
import { METRIC_COLORS as STORAGE_COLORS } from "@/pages/storage-detail/shared";
import { api } from "@/services/api";
import type {
  AppDetail,
  AppEnvironmentDetail,
  AppOverviewAlert,
  AppOverviewContainers,
  AppOverviewDatabase,
  AppOverviewEnvironment,
  AppOverviewIssue,
  AppOverviewRange,
} from "@/types";
import { useAppLoad } from "../app-resources";
import { CardRow, EnvLabel, orderedEnvironments, plural, Section } from "../app-shared";
import { useNodeIndex } from "../use-node-index";

const FAMILY_WORD: Record<AppOverviewIssue["family"], [string, string]> = {
  containers: ["container", "containers"],
  compose: ["Compose project", "Compose projects"],
  databases: ["database", "databases"],
  storage: ["storage", "storage"],
  routes: ["route", "routes"],
  pages: ["Pages project", "Pages projects"],
  certificates: ["SSL certificate", "SSL certificates"],
  logging: ["logging environment", "logging environments"],
};

/** Neutral states (stopped on request, disabled, in maintenance, starting) do not change the health. */
const ISSUE_BADGE: Record<AppOverviewIssue["state"], "destructive" | "warning" | "secondary"> = {
  failing: "destructive",
  degraded: "warning",
  stopped: "secondary",
  disabled: "secondary",
  maintenance: "secondary",
  starting: "secondary",
};

const ISSUE_WORD: Record<AppOverviewIssue["state"], string> = {
  failing: "failing",
  degraded: "degraded",
  stopped: "stopped",
  disabled: "disabled",
  maintenance: "in maintenance",
  starting: "starting",
};

function issueLabel(issue: AppOverviewIssue): string {
  const [one, many] = FAMILY_WORD[issue.family];
  return `${issue.count} ${issue.count === 1 ? one : many} ${ISSUE_WORD[issue.state]}`;
}

type Series = Array<number | null>;

/**
 * Element-wise combination of series aligned at their newest point. A gap (null, or a point before a shorter series
 * starts) carries that series' last value, or adds nothing before its first one; a point no series knows stays null,
 * so a missing sample is never drawn as 0. `carry: false` for per-point counts (restarts).
 */
const combineSeries = (series: Series[], mode: "sum" | "average", carry = true): Series => {
  const present = series.filter((values) => values.length > 0);
  const length = Math.max(0, ...present.map((values) => values.length));
  const last: Array<number | null> = present.map(() => null);
  return Array.from({ length }, (_, index) => {
    const known: number[] = [];
    present.forEach((values, which) => {
      const offset = length - values.length;
      const value = index >= offset ? values[index - offset] : null;
      if (typeof value === "number") {
        last[which] = value;
        known.push(value);
      } else if (carry && last[which] !== null) {
        known.push(last[which]!);
      }
    });
    if (known.length === 0) return null;
    const total = known.reduce((sum, value) => sum + value, 0);
    return mode === "sum" ? total : total / known.length;
  });
};
const sumSeries = (series: Series[], carry = true) => combineSeries(series, "sum", carry);
const averageSeries = (series: Series[]) => combineSeries(series, "average");

const RANGE_MS: Record<AppOverviewRange, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};
const RANGE_WORDS: Record<AppOverviewRange, string> = { "1h": "last hour", "24h": "last 24 hours" };

/**
 * A series that starts later than the range (the member is new, or sampling began within it): the points before its
 * first known one are dropped so the chart spans the covered time at full width, and `since` says when that began.
 */
export function coverage(
  history: Series,
  range: AppOverviewRange,
  measuredAt: string
): { history: Series; since: string | null } {
  const first = history.findIndex((value) => typeof value === "number");
  if (first <= 0) return { history, since: null };
  const start =
    Date.parse(measuredAt) - RANGE_MS[range] + (first * RANGE_MS[range]) / history.length;
  return { history: history.slice(first), since: new Date(start).toISOString() };
}

/**
 * The sparkline ceiling: a known maximum (a limit, 100%) when there is one. Without one the chart spans the range's
 * peak, except a flat series (within 5%), which gets twice its value: a steady value is a line at half height, never
 * a full-height block.
 */
export function sparkScale(history: Series, ceiling?: number | null): number | undefined {
  if (ceiling && ceiling > 0) return ceiling;
  const values = history.filter((value): value is number => typeof value === "number");
  if (values.length === 0) return undefined;
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max <= 0) return undefined;
  return max - min <= max * 0.05 ? max * 2 : undefined;
}

const THROUGHPUT_LABEL: Record<AppOverviewDatabase["throughputUnit"], string> = {
  tx: "Transactions",
  ops: "Operations",
  q: "Queries",
};

const rate = (value: number, unit: string) =>
  `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}/s`;
const bytesRate = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);
const percent = (value: number) => `${value.toFixed(1)}%`;
/** A share of a total: one decimal below 10% (0.4%, not 0%), whole percent above. */
const share = (value: number) => (value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`);
/** Sum of the known values; null when none is known. */
const total = (values: Array<number | null | undefined>): number | null => {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};

interface EnvView {
  env: AppEnvironmentDetail;
  data: AppOverviewEnvironment | undefined;
}

/** Local HH:MM of an ISO time. */
const clock = (iso: string) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** A card's subtitle with "since HH:MM" while its series covers less than the range. */
const withSince = (subtitle: string | undefined, since: string | null) =>
  since ? (subtitle ? `${subtitle} · since ${clock(since)}` : `since ${clock(since)}`) : subtitle;

/**
 * Restarts card: restarts since sampling began (0 from the first reading), "since HH:MM" until the samples cover
 * the range, then the range; "—" until any environment has a reading.
 */
export function restartsCard(
  containers: readonly AppOverviewContainers[],
  range: AppOverviewRange = "1h"
): {
  count: number | null;
  value: string;
  subtitle: string;
} {
  const known = containers.filter((c) => c.restarts !== null);
  if (known.length === 0) return { count: null, value: "—", subtitle: "No data yet" };
  const count = known.reduce((sum, c) => sum + (c.restarts ?? 0), 0);
  const sinces = known.map((c) => c.restartsSince);
  const covered = sinces.some((since) => !since);
  const earliest = sinces.filter((since): since is string => Boolean(since)).sort()[0];
  return {
    count,
    value: String(count),
    subtitle: covered || !earliest ? RANGE_WORDS[range] : `since ${clock(earliest)}`,
  };
}

/**
 * Healthy card: healthy containers among those with a health check; containers without one are counted apart
 * (running counts as healthy for them, so they would read as healthy without being checked), and containers stopped
 * on request count as neither.
 */
export function healthyCard(
  views: ReadonlyArray<{ env: { name: string }; data: AppOverviewEnvironment }>
): {
  value: string;
  subtitle: string;
  progress?: { percent: number; color: string };
} {
  const containers = views.map((item) => item.data.containers);
  const noCheck = containers.reduce((sum, c) => sum + c.noHealthCheck, 0);
  const stopped = containers.reduce((sum, c) => sum + (c.stopped ?? 0), 0);
  const checked = containers.reduce(
    (sum, c) => sum + (c.checked ?? c.total - c.noHealthCheck - (c.stopped ?? 0)),
    0
  );
  const healthy = containers.reduce((sum, c) => sum + c.checkedHealthy, 0);
  if (checked === 0) return { value: "—", subtitle: "No health checks" };
  const unhealthy = views.flatMap((item) =>
    item.data.containers.unhealthy.map((name) => `${name} in ${item.env.name}`)
  );
  return {
    value: `${healthy}/${checked}`,
    progress: {
      percent: (healthy / checked) * 100,
      color: healthy < checked ? "var(--color-destructive)" : "var(--color-success)",
    },
    subtitle:
      unhealthy.length > 0
        ? `${unhealthy.slice(0, 2).join(", ")} ${unhealthy.length === 1 ? "is" : "are"} not healthy`
        : noCheck > 0
          ? `${noCheck} without a health check`
          : stopped > 0
            ? `${plural(stopped, "container")} stopped`
            : "Every container is healthy",
  };
}

export function OverviewTab({ app, version }: { app: AppDetail; version: number }) {
  const range: AppOverviewRange = "1h";
  const { data: overview, loading } = useAppLoad(`overview:${app.id}`, version, () =>
    api.getAppOverview(app.id, range)
  );
  const { byId: nodesById } = useNodeIndex(version);

  const envs: EnvView[] = orderedEnvironments(app.environments).map((env) => ({
    env,
    data: overview?.environments.find((item) => item.environmentId === env.id),
  }));
  const production = envs.find((item) => item.env.isProduction) ?? envs[0];
  const withData = envs.filter(
    (item): item is { env: AppEnvironmentDetail; data: AppOverviewEnvironment } =>
      Boolean(item.data)
  );
  const totalMembers = withData.reduce((sum, item) => sum + item.data.members, 0);

  if (loading) return <ContentLoading loading />;
  if (!production) return null;
  if (overview && totalMembers === 0) {
    return (
      <div className="space-y-6 pb-6">
        <EnvironmentsPanel appSlug={app.slug} envs={envs} productionName={production.env.name} />
        <EmptyState message="Nothing in this app yet. Allow a node per environment on its page, then create resources with New or import existing ones." />
      </div>
    );
  }

  const measuredAt = overview?.measuredAt ?? new Date().toISOString();
  const covered = (history: Series) => coverage(history, range, measuredAt);
  const alerts = withData.flatMap((item) =>
    item.data.alerts.map((alert) => ({ ...alert, env: item.env.name }))
  );
  const containers = withData.map((item) => item.data.containers);
  const containerTotal = containers.reduce((sum, c) => sum + c.total, 0);
  const healthCard = healthyCard(withData);
  const cpu = total(containers.map((c) => c.cpuPercent));
  const memory = total(containers.map((c) => c.memoryBytes));
  const memoryLimit = total(containers.map((c) => c.memoryLimitBytes)) ?? 0;
  const restartCard = restartsCard(containers, range);
  const cpuSeries = covered(sumSeries(containers.map((c) => c.cpuHistory)));
  const memorySeries = covered(sumSeries(containers.map((c) => c.memoryHistory)));
  const restartSeries = covered(
    sumSeries(
      containers.map((c) => c.restartsHistory),
      false
    )
  );
  const healthySeries = covered(averageSeries(containers.map((c) => c.healthyHistory ?? [])));
  const routes = withData.map((item) => item.data.routes);
  const routeTotal = routes.reduce((sum, r) => sum + r.total, 0);
  const requests = total(routes.map((r) => r.requestsPerSecond));
  const errors = total(routes.map((r) => r.errorsPerSecond));
  const traffic = total(routes.map((r) => r.trafficBytesPerSecond));
  const requestSeries = covered(sumSeries(routes.map((r) => r.requestsHistory)));
  const errorSeries = covered(sumSeries(routes.map((r) => r.errorsHistory)));
  const trafficSeries = covered(sumSeries(routes.map((r) => r.trafficHistory)));
  // The slowest environment's latency: request p95 with traffic, else health-check probes.
  const slowest = routes
    .filter((r) => r.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))[0];
  const latencySeries = covered(slowest?.latencyHistory ?? []);
  const latencySubtitle = !slowest
    ? "No traffic or health checks"
    : slowest.latencySource === "probe"
      ? "Health-check probes · no traffic"
      : "p95 of requests";
  const noTraffic = requests === null ? "No traffic data yet" : undefined;
  const databases = withData.flatMap((item) =>
    item.data.databases.map((db) => ({ env: item.env, db }))
  );
  const storages = withData.flatMap((item) =>
    item.data.storage.map((st) => ({ env: item.env, st }))
  );
  const pages = withData.flatMap((item) =>
    item.data.pages.map((page) => ({ env: item.env, page }))
  );
  const nodeIds = Array.from(new Set(withData.flatMap((item) => item.data.nodeIds)));
  const nodes = nodeIds.flatMap((id) => {
    const node = nodesById.get(id);
    return node ? [node] : [];
  });

  return (
    <div className="space-y-6 pb-6">
      <EnvironmentsPanel appSlug={app.slug} envs={envs} productionName={production.env.name} />

      <OverviewAlerts alerts={alerts} />

      {containerTotal > 0 && (
        <Section title={`Containers · ${containerTotal}`}>
          <CardRow>
            <StatCard
              label="CPU"
              value={cpu === null ? "—" : percent(cpu)}
              icon={Cpu}
              history={cpuSeries.history}
              sparklineMax={sparkScale(cpuSeries.history, 100)}
              color="var(--color-hue-blue)"
              subtitle={withSince(plural(containerTotal, "container"), cpuSeries.since)}
            />
            <StatCard
              label="Memory"
              value={memory === null ? "—" : formatBytes(memory)}
              icon={MemoryStick}
              history={memorySeries.history}
              sparklineMax={sparkScale(memorySeries.history, memoryLimit)}
              color="var(--color-hue-violet)"
              progress={
                memory !== null && memoryLimit > 0
                  ? { percent: (memory / memoryLimit) * 100 }
                  : undefined
              }
              subtitle={withSince(
                memory !== null && memoryLimit > 0
                  ? `${share((memory / memoryLimit) * 100)} of ${formatBytes(memoryLimit)} limits`
                  : "No memory limits",
                memorySeries.since
              )}
            />
            <StatCard
              label="Restarts"
              value={restartCard.value}
              icon={RotateCcw}
              history={restartSeries.history}
              sparklineMax={sparkScale(restartSeries.history)}
              color={restartCard.count ? "var(--color-hue-red)" : "var(--color-hue-slate)"}
              subtitle={restartCard.subtitle}
            />
            <StatCard
              label="Healthy"
              value={healthCard.value}
              icon={Activity}
              history={healthySeries.history}
              sparklineMax={100}
              color="var(--color-success)"
              progress={healthCard.progress}
              subtitle={withSince(healthCard.subtitle, healthySeries.since)}
            />
          </CardRow>
        </Section>
      )}

      {databases.map(({ env, db }) => {
        const disk = covered(db.diskHistory);
        const connections = covered(db.connectionsHistory);
        const throughput = covered(db.transactionsHistory);
        const cacheHit = covered(db.cacheHitHistory);
        const dbCpu = covered(db.cpuHistory);
        const diskLimit = db.diskLimitBytes ?? null;
        return (
          <Section key={db.id} title={`Database · ${db.name} · ${env.name}`}>
            <CardRow>
              <StatCard
                label="Disk"
                value={db.diskBytes === null ? "—" : formatBytes(db.diskBytes)}
                icon={HardDrive}
                history={disk.history}
                sparklineMax={sparkScale(disk.history, diskLimit)}
                progress={
                  db.diskPercent === null
                    ? undefined
                    : {
                        percent: db.diskPercent,
                        color: db.diskPercent >= 80 ? "var(--color-warning)" : undefined,
                      }
                }
                valueColor={
                  db.diskPercent !== null && db.diskPercent >= 80
                    ? "var(--color-warning-text)"
                    : undefined
                }
                subtitle={withSince(
                  db.diskPercent !== null && diskLimit
                    ? `${share(db.diskPercent)} of ${formatBytes(diskLimit)} limit`
                    : db.diskBytes === null && db.type === "redis"
                      ? "Not persisted to disk"
                      : "No size limit",
                  disk.since
                )}
                color={DATABASE_COLORS.database_size_bytes ?? "var(--color-hue-cyan)"}
              />
              <StatCard
                label="Connections"
                value={
                  db.connections === null
                    ? "—"
                    : db.maxConnections
                      ? `${db.connections}/${db.maxConnections}`
                      : String(db.connections)
                }
                icon={Users}
                history={connections.history}
                sparklineMax={sparkScale(connections.history, db.maxConnections)}
                progress={
                  db.connections !== null && db.maxConnections
                    ? { percent: (db.connections / db.maxConnections) * 100 }
                    : undefined
                }
                subtitle={
                  db.connections === null ? "No data yet" : withSince(undefined, connections.since)
                }
                color={DATABASE_COLORS.total_connections ?? "var(--color-hue-cyan)"}
              />
              <StatCard
                label={THROUGHPUT_LABEL[db.throughputUnit ?? "tx"]}
                value={
                  db.transactionsPerSecond === null
                    ? "—"
                    : rate(db.transactionsPerSecond, db.throughputUnit ?? "tx")
                }
                icon={Gauge}
                history={throughput.history}
                sparklineMax={sparkScale(throughput.history)}
                subtitle={
                  db.transactionsPerSecond === null
                    ? "No data yet"
                    : withSince("per second", throughput.since)
                }
                color={DATABASE_COLORS.transaction_rate ?? "var(--color-hue-green)"}
              />
              {db.cacheHitPercent === null && db.cpuPercent !== null ? (
                <StatCard
                  label="CPU"
                  value={percent(db.cpuPercent)}
                  icon={Cpu}
                  history={dbCpu.history}
                  sparklineMax={sparkScale(dbCpu.history, 100)}
                  subtitle={withSince("Database container", dbCpu.since)}
                  color={DATABASE_COLORS.managed_cpu_percent ?? "var(--color-hue-orange)"}
                />
              ) : (
                <StatCard
                  label="Cache hit"
                  value={db.cacheHitPercent === null ? "—" : percent(db.cacheHitPercent)}
                  icon={Zap}
                  history={cacheHit.history}
                  sparklineMax={100}
                  progress={
                    db.cacheHitPercent === null ? undefined : { percent: db.cacheHitPercent }
                  }
                  subtitle={
                    db.cacheHitPercent === null
                      ? "No data yet"
                      : withSince("Reads served from memory", cacheHit.since)
                  }
                  color={DATABASE_COLORS.cache_hit_ratio ?? "var(--color-hue-blue)"}
                />
              )}
            </CardRow>
          </Section>
        );
      })}

      {storages.map(({ env, st }) => {
        const disk = covered(st.diskHistory);
        const objects = covered(st.objectsHistory);
        const rx = covered(st.rxHistory);
        const tx = covered(st.txHistory);
        const quota = st.diskTotalBytes ?? null;
        return (
          <Section key={st.id} title={`Storage · ${st.name} · ${env.name}`}>
            <CardRow>
              <StatCard
                label="Disk"
                value={st.diskBytes === null ? "—" : formatBytes(st.diskBytes)}
                icon={HardDrive}
                history={disk.history}
                sparklineMax={sparkScale(disk.history, quota)}
                progress={st.diskPercent === null ? undefined : { percent: st.diskPercent }}
                subtitle={withSince(
                  st.diskPercent !== null && quota
                    ? `${share(st.diskPercent)} of ${formatBytes(quota)} quota`
                    : "No quota",
                  disk.since
                )}
                color={STORAGE_COLORS.disk_used_bytes}
              />
              <StatCard
                label="Objects"
                value={st.objects === null ? "—" : st.objects.toLocaleString()}
                icon={FileStack}
                history={objects.history}
                sparklineMax={sparkScale(objects.history)}
                color={STORAGE_COLORS.bucket_count}
                subtitle={withSince(
                  st.buckets === null ? undefined : `in ${plural(st.buckets, "bucket")}`,
                  objects.since
                )}
              />
              <StatCard
                label="Network RX"
                value={bytesRate(st.rxBytesPerSecond)}
                icon={ArrowDownToLine}
                history={rx.history}
                sparklineMax={sparkScale(rx.history)}
                subtitle={withSince(undefined, rx.since)}
                color={STORAGE_COLORS.network_rx_bytes}
              />
              <StatCard
                label="Network TX"
                value={bytesRate(st.txBytesPerSecond)}
                icon={ArrowUpFromLine}
                history={tx.history}
                sparklineMax={sparkScale(tx.history)}
                subtitle={withSince(undefined, tx.since)}
                color={STORAGE_COLORS.network_tx_bytes}
              />
            </CardRow>
          </Section>
        );
      })}

      {routeTotal > 0 && (
        <Section title={`Routes · ${routeTotal}`}>
          <CardRow>
            <StatCard
              label="Requests"
              value={requests === null ? "—" : rate(requests, "req")}
              icon={Globe}
              history={requestSeries.history}
              sparklineMax={sparkScale(requestSeries.history)}
              color="var(--color-hue-green)"
              subtitle={withSince(noTraffic ?? plural(routeTotal, "route"), requestSeries.since)}
            />
            <StatCard
              label="Errors"
              value={errors === null ? "—" : rate(errors, "err")}
              icon={TriangleAlert}
              history={errorSeries.history}
              sparklineMax={sparkScale(errorSeries.history)}
              color="var(--color-hue-red)"
              subtitle={withSince("HTTP 5xx", errorSeries.since)}
            />
            <StatCard
              label="Latency"
              value={slowest ? `${Math.round(slowest.latencyMs ?? 0)} ms` : "—"}
              icon={Activity}
              history={latencySeries.history}
              sparklineMax={sparkScale(latencySeries.history)}
              color="var(--color-hue-pink)"
              subtitle={withSince(latencySubtitle, latencySeries.since)}
            />
            <StatCard
              label="Traffic"
              value={bytesRate(traffic)}
              icon={ArrowDownToLine}
              history={trafficSeries.history}
              sparklineMax={sparkScale(trafficSeries.history)}
              subtitle={withSince(noTraffic, trafficSeries.since)}
              color="var(--color-hue-cyan)"
            />
          </CardRow>
        </Section>
      )}

      {pages.length > 0 && (
        <Section title={`Pages · ${pages.length}`}>
          <CardRow>
            {pages.flatMap(({ env, page }) => {
              const pageRequests = covered(page.requestsHistory);
              return [
                <StatCard
                  key={`${page.id}-deployment`}
                  label={`${page.name} · Deployment`}
                  value={page.activeDeployment ? "Active" : "None"}
                  icon={Rocket}
                  subtitle={env.name}
                  valueColor={page.activeDeployment ? "var(--color-success-text)" : undefined}
                />,
                <StatCard
                  key={`${page.id}-requests`}
                  label={`${page.name} · Requests`}
                  value={
                    page.requestsPerSecond === null ? "—" : rate(page.requestsPerSecond, "req")
                  }
                  icon={Globe}
                  history={pageRequests.history}
                  sparklineMax={sparkScale(pageRequests.history)}
                  color="var(--color-hue-green)"
                  subtitle={withSince(
                    page.routes === 0 ? `${env.name} · no route serves it` : env.name,
                    pageRequests.since
                  )}
                />,
              ];
            })}
          </CardRow>
        </Section>
      )}

      {nodes.length > 0 && (
        <Section title={`Nodes · ${nodes.length}`}>
          <div className="space-y-3">
            {nodes.map((node) => (
              <PinnedNodeCard key={node.id} node={node} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** The Alerts section: one notice per alert of every environment, or "No open alerts". */
export function OverviewAlerts({ alerts }: { alerts: Array<AppOverviewAlert & { env: string }> }) {
  return (
    <Section title="Alerts">
      {alerts.length > 0 ? (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const tone = noticeTone(alert.tone);
            return (
              <Notice
                key={`${alert.env}:${alert.title}`}
                tone={tone}
                title={`${alert.env} · ${alert.title}`}
                actions={
                  alert.href ? (
                    <NoticeAction tone={tone} to={alert.href}>
                      {alert.actionLabel ?? "Open"}
                    </NoticeAction>
                  ) : undefined
                }
              >
                {alert.detail}
              </Notice>
            );
          })}
        </div>
      ) : (
        <Notice tone="success" title="No open alerts">
          Every member of every environment is healthy.
        </Notice>
      )}
    </Section>
  );
}

function EnvironmentsPanel({
  appSlug,
  envs,
  productionName,
}: {
  appSlug: string;
  envs: EnvView[];
  productionName: string;
}) {
  const navigate = useNavigate();
  return (
    <PanelShell
      title="Environments"
      icon={<Layers className="h-4 w-4" />}
      description={`App health follows ${productionName}`}
    >
      {envs.map(({ env, data }) => {
        const issues = data?.issues ?? [];
        // Warnings that are no member's state (a nearly full disk, 5xx errors, nothing running): each degraded
        // member has its own warning alert and its own badge already.
        const degradedMembers = issues
          .filter((issue) => issue.state === "degraded")
          .reduce((sum, issue) => sum + issue.count, 0);
        const warnings = Math.max(
          0,
          (data?.alerts ?? []).filter((alert) => alert.tone === "warning").length - degradedMembers
        );
        return (
          <SettingsControlRow
            key={env.id}
            title={<EnvLabel env={env} />}
            onClick={
              env.access === "members"
                ? undefined
                : () => navigate(appEnvironmentRoute(appSlug, env.slug))
            }
            description={`${plural(data?.members ?? 0, "resource")} · ${env.health}`}
          >
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {issues.length === 0 && warnings === 0 ? (
                <Badge variant={env.health === "unknown" ? "secondary" : "success"} size="inline">
                  {env.health === "unknown" ? "No data" : "Healthy"}
                </Badge>
              ) : (
                <>
                  {issues.map((issue) => (
                    <Badge
                      key={`${issue.family}:${issue.state}`}
                      variant={ISSUE_BADGE[issue.state]}
                      size="inline"
                    >
                      {issueLabel(issue)}
                    </Badge>
                  ))}
                  {warnings > 0 && (
                    <Badge variant="warning" size="inline">
                      {plural(warnings, "warning")}
                    </Badge>
                  )}
                </>
              )}
            </div>
          </SettingsControlRow>
        );
      })}
    </PanelShell>
  );
}
