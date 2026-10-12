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
  AppOverviewDatabase,
  AppOverviewEnvironment,
  AppOverviewIssue,
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
};

function issueLabel(issue: AppOverviewIssue): string {
  const [one, many] = FAMILY_WORD[issue.family];
  return `${issue.count} ${issue.count === 1 ? one : many} ${issue.state}`;
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

const THROUGHPUT_LABEL: Record<AppOverviewDatabase["throughputUnit"], string> = {
  tx: "Transactions",
  ops: "Operations",
  q: "Queries",
};

const rate = (value: number, unit: string) =>
  `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}/s`;
const bytesRate = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);
const percent = (value: number) => `${value.toFixed(1)}%`;

interface EnvView {
  env: AppEnvironmentDetail;
  data: AppOverviewEnvironment | undefined;
}

export function OverviewTab({ app, version }: { app: AppDetail; version: number }) {
  const { data: overview, loading } = useAppLoad(`overview:${app.id}`, version, () =>
    api.getAppOverview(app.id, "1h")
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

  const alerts = withData.flatMap((item) =>
    item.data.alerts.map((alert) => ({ ...alert, env: item.env.name }))
  );
  const containers = withData.map((item) => item.data.containers);
  const containerTotal = containers.reduce((sum, c) => sum + c.total, 0);
  const containerHealthy = containers.reduce((sum, c) => sum + c.healthy, 0);
  const cpu = containers.reduce((sum, c) => sum + c.cpuPercent, 0);
  const memory = containers.reduce((sum, c) => sum + c.memoryBytes, 0);
  const memoryLimit = containers.reduce((sum, c) => sum + (c.memoryLimitBytes ?? 0), 0);
  const knownRestarts = containers.filter((c) => c.restarts !== null);
  const restarts =
    knownRestarts.length > 0 ? knownRestarts.reduce((sum, c) => sum + (c.restarts ?? 0), 0) : null;
  const unhealthy = withData.flatMap((item) =>
    item.data.containers.unhealthy.map((name) => `${name} in ${item.env.name}`)
  );
  const routes = withData.map((item) => item.data.routes);
  const routeTotal = routes.reduce((sum, r) => sum + r.total, 0);
  // The slowest environment's latency: request p95 with traffic, else health-check probes.
  const slowest = routes
    .filter((r) => r.latencyMs !== null)
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))[0];
  const latencySubtitle = !slowest
    ? "No traffic or health checks"
    : slowest.latencySource === "probe"
      ? "Health-check probes · no traffic"
      : "p95 of requests";
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
              value={percent(cpu)}
              icon={Cpu}
              history={sumSeries(containers.map((c) => c.cpuHistory))}
              sparklineMax={100}
              color="var(--color-hue-blue)"
              subtitle={plural(containerTotal, "container")}
            />
            <StatCard
              label="Memory"
              value={formatBytes(memory)}
              icon={MemoryStick}
              history={sumSeries(containers.map((c) => c.memoryHistory))}
              color="var(--color-hue-violet)"
              progress={memoryLimit > 0 ? { percent: (memory / memoryLimit) * 100 } : undefined}
              subtitle={
                memoryLimit > 0
                  ? `${Math.round((memory / memoryLimit) * 100)}% of ${formatBytes(memoryLimit)} limits`
                  : "No memory limits"
              }
            />
            <StatCard
              label="Restarts"
              value={restarts === null ? "—" : String(restarts)}
              icon={RotateCcw}
              history={sumSeries(
                containers.map((c) => c.restartsHistory),
                false
              )}
              color={restarts ? "var(--color-hue-red)" : "var(--color-hue-slate)"}
              subtitle={restarts === null ? "No data yet" : "last hour"}
            />
            <StatCard
              label="Healthy"
              value={`${containerHealthy}/${containerTotal}`}
              icon={Activity}
              history={averageSeries(containers.map((c) => c.healthyHistory ?? []))}
              sparklineMax={100}
              color="var(--color-success)"
              progress={{
                percent: containerTotal > 0 ? (containerHealthy / containerTotal) * 100 : 100,
                color:
                  containerHealthy < containerTotal
                    ? "var(--color-destructive)"
                    : "var(--color-success)",
              }}
              subtitle={
                unhealthy.length > 0
                  ? `${unhealthy.slice(0, 2).join(", ")} ${unhealthy.length === 1 ? "is" : "are"} not healthy`
                  : "Every container is healthy"
              }
            />
          </CardRow>
        </Section>
      )}

      {databases.map(({ env, db }) => (
        <Section key={db.id} title={`Database · ${db.name} · ${env.name}`}>
          <CardRow>
            <StatCard
              label="Disk"
              value={db.diskBytes === null ? "—" : formatBytes(db.diskBytes)}
              icon={HardDrive}
              history={db.diskHistory}
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
              subtitle={db.diskPercent === null ? undefined : `${Math.round(db.diskPercent)}% used`}
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
              history={db.connectionsHistory}
              progress={
                db.connections !== null && db.maxConnections
                  ? { percent: (db.connections / db.maxConnections) * 100 }
                  : undefined
              }
              subtitle={db.connections === null ? "No data yet" : undefined}
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
              history={db.transactionsHistory}
              subtitle={db.transactionsPerSecond === null ? "No data yet" : "per second"}
              color={DATABASE_COLORS.transaction_rate ?? "var(--color-hue-green)"}
            />
            {db.cacheHitPercent === null && db.cpuPercent !== null ? (
              <StatCard
                label="CPU"
                value={percent(db.cpuPercent)}
                icon={Cpu}
                history={db.cpuHistory}
                sparklineMax={100}
                subtitle="Database container"
                color={DATABASE_COLORS.managed_cpu_percent ?? "var(--color-hue-orange)"}
              />
            ) : (
              <StatCard
                label="Cache hit"
                value={db.cacheHitPercent === null ? "—" : percent(db.cacheHitPercent)}
                icon={Zap}
                history={db.cacheHitHistory}
                sparklineMax={100}
                progress={db.cacheHitPercent === null ? undefined : { percent: db.cacheHitPercent }}
                subtitle={db.cacheHitPercent === null ? "No data yet" : "Reads served from memory"}
                color={DATABASE_COLORS.cache_hit_ratio ?? "var(--color-hue-blue)"}
              />
            )}
          </CardRow>
        </Section>
      ))}

      {storages.map(({ env, st }) => (
        <Section key={st.id} title={`Storage · ${st.name} · ${env.name}`}>
          <CardRow>
            <StatCard
              label="Disk"
              value={st.diskBytes === null ? "—" : formatBytes(st.diskBytes)}
              icon={HardDrive}
              history={st.diskHistory}
              progress={st.diskPercent === null ? undefined : { percent: st.diskPercent }}
              subtitle={
                st.diskPercent === null ? undefined : `${Math.round(st.diskPercent)}% of quota`
              }
              color={STORAGE_COLORS.disk_used_bytes}
            />
            <StatCard
              label="Objects"
              value={st.objects === null ? "—" : st.objects.toLocaleString()}
              icon={FileStack}
              history={st.objectsHistory}
              color={STORAGE_COLORS.bucket_count}
              subtitle={st.buckets === null ? undefined : `in ${plural(st.buckets, "bucket")}`}
            />
            <StatCard
              label="Network RX"
              value={bytesRate(st.rxBytesPerSecond)}
              icon={ArrowDownToLine}
              history={st.rxHistory}
              color={STORAGE_COLORS.network_rx_bytes}
            />
            <StatCard
              label="Network TX"
              value={bytesRate(st.txBytesPerSecond)}
              icon={ArrowUpFromLine}
              history={st.txHistory}
              color={STORAGE_COLORS.network_tx_bytes}
            />
          </CardRow>
        </Section>
      ))}

      {routeTotal > 0 && (
        <Section title={`Routes · ${routeTotal}`}>
          <CardRow>
            <StatCard
              label="Requests"
              value={rate(
                routes.reduce((sum, r) => sum + r.requestsPerSecond, 0),
                "req"
              )}
              icon={Globe}
              history={sumSeries(routes.map((r) => r.requestsHistory))}
              color="var(--color-hue-green)"
              subtitle={plural(routeTotal, "route")}
            />
            <StatCard
              label="Errors"
              value={rate(
                routes.reduce((sum, r) => sum + r.errorsPerSecond, 0),
                "err"
              )}
              icon={TriangleAlert}
              history={sumSeries(routes.map((r) => r.errorsHistory))}
              color="var(--color-hue-red)"
              subtitle="HTTP 5xx"
            />
            <StatCard
              label="Latency"
              value={slowest ? `${Math.round(slowest.latencyMs ?? 0)} ms` : "—"}
              icon={Activity}
              history={slowest?.latencyHistory ?? []}
              color="var(--color-hue-pink)"
              subtitle={latencySubtitle}
            />
            <StatCard
              label="Traffic"
              value={bytesRate(routes.reduce((sum, r) => sum + r.trafficBytesPerSecond, 0))}
              icon={ArrowDownToLine}
              history={sumSeries(routes.map((r) => r.trafficHistory))}
              color="var(--color-hue-cyan)"
            />
          </CardRow>
        </Section>
      )}

      {pages.length > 0 && (
        <Section title={`Pages · ${pages.length}`}>
          <CardRow>
            {pages.flatMap(({ env, page }) => [
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
                value={page.requestsPerSecond === null ? "—" : rate(page.requestsPerSecond, "req")}
                icon={Globe}
                history={page.requestsHistory}
                color="var(--color-hue-green)"
                subtitle={env.name}
              />,
            ])}
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
        return (
          <SettingsControlRow
            key={env.id}
            title={<EnvLabel env={env} />}
            onClick={() => navigate(appEnvironmentRoute(appSlug, env.slug))}
            description={`${plural(data?.members ?? 0, "resource")} · ${env.health}`}
          >
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {issues.length === 0 ? (
                <Badge variant={env.health === "unknown" ? "secondary" : "success"} size="inline">
                  {env.health === "unknown" ? "No data" : "Healthy"}
                </Badge>
              ) : (
                issues.map((issue) => (
                  <Badge
                    key={`${issue.family}:${issue.state}`}
                    variant={issue.state === "failing" ? "destructive" : "warning"}
                    size="inline"
                  >
                    {issueLabel(issue)}
                  </Badge>
                ))
              )}
            </div>
          </SettingsControlRow>
        );
      })}
    </PanelShell>
  );
}
