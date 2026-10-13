/**
 * Apps of the fictional installation: "shop" with Production and Staging, plus two smaller apps
 * for the list. Shapes follow src/types/apps.ts (GET /api/apps, /api/apps/:id, /api/apps/:id/overview).
 */
import { HttpResponse, http } from "msw";
import type {
  AppDetail,
  AppEnvironmentDetail,
  AppOverview,
  AppOverviewEnvironment,
  AppSummary,
} from "@/types";
import { ok, wrapped } from "../handlers";
import { databases, storages } from "./catalog";
import { appsNode, edgeNode } from "./nodes";
import { ago, nowIso, uuid } from "./time";

const folders = (seed: number) => ({
  containers: uuid(seed + 1),
  compose: uuid(seed + 2),
  routes: uuid(seed + 3),
  databases: uuid(seed + 4),
  storage: uuid(seed + 5),
  pages: uuid(seed + 6),
  certificates: uuid(seed + 7),
  logging: uuid(seed + 8),
});

const production: AppEnvironmentDetail = {
  id: uuid(7101),
  slug: "production",
  name: "Production",
  isProduction: true,
  maintenanceEnabled: false,
  health: "healthy",
  memberCounts: { container: 3, database: 1, storage: 1, route: 2, pages: 1 },
  placementFolderIds: folders(7110),
  allowedNodeIds: [appsNode.id, edgeNode.id],
  incidents: [],
};

const staging: AppEnvironmentDetail = {
  id: uuid(7102),
  slug: "staging",
  name: "Staging",
  isProduction: false,
  maintenanceEnabled: false,
  health: "degraded",
  memberCounts: { container: 2, database: 1, route: 1 },
  placementFolderIds: folders(7120),
  allowedNodeIds: [appsNode.id],
  incidents: [],
};

export const shopApp: AppDetail = {
  id: uuid(7001),
  slug: "shop",
  name: "shop",
  maintenanceOverride: false,
  incident: "none",
  environments: [production, staging],
  permissions: {
    edit: true,
    delete: true,
    operate: true,
    envManage: { [production.id]: true, [staging.id]: true },
    promote: { [production.id]: true, [staging.id]: true },
    operateEnv: { [production.id]: true, [staging.id]: true },
  },
};

export const appSummaries: AppSummary[] = [
  {
    id: shopApp.id,
    slug: "shop",
    name: "shop",
    environments: [
      { id: production.id, slug: "production", name: "Production", isProduction: true, health: "healthy" },
      { id: staging.id, slug: "staging", name: "Staging", isProduction: false, health: "degraded" },
    ],
    health: "healthy",
    incident: "none",
    cpuPercent: 23.4,
    memoryBytes: 1_610_612_736,
    running: 7,
    failing: 0,
    degraded: 0,
  },
  {
    id: uuid(7002),
    slug: "billing",
    name: "billing",
    environments: [
      { id: uuid(7201), slug: "production", name: "Production", isProduction: true, health: "degraded" },
    ],
    health: "degraded",
    incident: "none",
    cpuPercent: 8.1,
    memoryBytes: 536_870_912,
    running: 3,
    failing: 0,
    degraded: 1,
  },
  {
    id: uuid(7003),
    slug: "docs",
    name: "docs",
    environments: [
      { id: uuid(7301), slug: "production", name: "Production", isProduction: true, health: "healthy" },
    ],
    health: "healthy",
    incident: "none",
    cpuPercent: 0.4,
    memoryBytes: 67_108_864,
    running: 1,
    failing: 0,
    degraded: 0,
  },
];

/** A gentle deterministic wave: `points` samples around `base` with amplitude `spread`. */
const series = (base: number, spread: number, points = 60, phase = 0) =>
  Array.from({ length: points }, (_, index) =>
    Math.max(0, Number((base + spread * Math.sin((index + phase) / 5) + (spread / 3) * Math.cos(index / 2)).toFixed(2)))
  );

const GiB = 1_073_741_824;

function overviewEnvironment(env: AppEnvironmentDetail, scale: number): AppOverviewEnvironment {
  const isProduction = env.isProduction;
  return {
    environmentId: env.id,
    health: env.health,
    members: Object.values(env.memberCounts).reduce((sum, count) => sum + (count ?? 0), 0),
    issues: isProduction ? [] : [{ family: "containers", state: "degraded", count: 1 }],
    alerts: isProduction
      ? []
      : [
          {
            tone: "warning",
            title: "shop-worker restarted 4 times in the last hour",
            detail: "Restarts",
            href: "/docker",
            actionLabel: "Open",
          },
        ],
    containers: {
      total: isProduction ? 3 : 2,
      healthy: isProduction ? 3 : 1,
      cpuPercent: 18.2 * scale,
      cpuHistory: series(18 * scale, 4 * scale),
      memoryBytes: 1.2 * GiB * scale,
      memoryLimitBytes: 3 * GiB * scale,
      memoryHistory: series(1.2 * GiB * scale, 0.1 * GiB * scale, 60, 3),
      restarts: isProduction ? 0 : 4,
      restartsHistory: series(isProduction ? 0 : 0.2, isProduction ? 0 : 0.2, 60, 7),
      unhealthy: isProduction ? [] : ["shop-worker"],
    },
    databases: [
      {
        id: databases[0].id,
        slug: isProduction ? databases[0].slug : "orders-db-staging",
        name: isProduction ? databases[0].name : "orders-db-staging",
        diskBytes: 18.4 * GiB * scale,
        diskPercent: 46 * scale,
        diskHistory: series(46 * scale, 0.6, 60, 2),
        connections: Math.round(34 * scale),
        maxConnections: 200,
        connectionsHistory: series(34 * scale, 6 * scale, 60, 5),
        transactionsPerSecond: 212 * scale,
      },
    ],
    storage: isProduction
      ? [
          {
            id: storages[0].id,
            slug: storages[0].slug,
            name: storages[0].name,
            diskBytes: 64 * GiB,
            diskPercent: 31,
            diskHistory: series(31, 0.4),
            objects: 182_400,
            objectsHistory: series(182_000, 300),
            buckets: 3,
            rxBytesPerSecond: 2_400_000,
            rxHistory: series(2_400_000, 600_000),
            txBytesPerSecond: 5_100_000,
            txHistory: series(5_100_000, 900_000, 60, 4),
          },
        ]
      : [],
    routes: {
      total: isProduction ? 2 : 1,
      requestsPerSecond: 148 * scale,
      requestsHistory: series(148 * scale, 30 * scale),
      errorsPerSecond: 0.4 * scale,
      errorsHistory: series(0.4 * scale, 0.3 * scale, 60, 9),
      latencyMs: 42,
      latencyHistory: series(42, 6, 60, 1),
      trafficBytesPerSecond: 3_800_000 * scale,
      trafficHistory: series(3_800_000 * scale, 700_000 * scale, 60, 6),
    },
    pages: isProduction
      ? [
          {
            id: uuid(5001),
            slug: "marketing-site",
            name: "marketing-site",
            activeDeployment: { id: uuid(5101), createdAt: ago(3, "h") },
            requestsPerSecond: 12.5,
            requestsHistory: series(12.5, 3),
          },
        ]
      : [],
    nodeIds: isProduction ? [appsNode.id, edgeNode.id] : [appsNode.id],
  };
}

export const shopOverview: AppOverview = {
  range: "1h",
  measuredAt: nowIso(),
  environments: [overviewEnvironment(production, 1), overviewEnvironment(staging, 0.2)],
};

export function appsHandlers() {
  return [
    http.get("*/api/apps", () => wrapped(appSummaries)),
    http.get("*/api/apps/:app/overview", () => wrapped(shopOverview)),
    http.get("*/api/apps/:app/incidents", () => wrapped([])),
    http.get("*/api/apps/:app/activity", () => ok({ data: [], total: 0, page: 1, limit: 25 })),
    http.get("*/api/apps/:app", ({ params }) =>
      params.app === shopApp.slug || params.app === shopApp.id
        ? wrapped(shopApp)
        : HttpResponse.json({ message: "Not found" }, { status: 404 })
    ),
  ];
}
