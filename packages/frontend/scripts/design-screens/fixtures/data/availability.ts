import { HttpResponse, http } from "msw";
import type {
  AvailabilityEvent,
  AvailabilityMember,
  AvailabilityPreflightResult,
  AvailabilityView,
  DashboardRelayInstance,
  DashboardRelaySnapshot,
  Node,
} from "@/types";
import { ok, wrapped } from "../../handlers";
import { nodes } from "../nodes";
import { relaySnapshot } from "../ops/settings-tabs";
import { ago, uuid } from "../time";
import { ordersDb } from "./databases";

const dbNode = nodes.find((node) => node.slug === "db-1")!;
/** A second databases host for the copy. */
export const dbNode2: Node = {
  ...dbNode,
  id: uuid(1105),
  slug: "db-2",
  hostname: "db-2",
  displayName: "Database host 2",
  sortOrder: 50,
};
const witnessRelay = relaySnapshot.instances![1]!;

const capable = (node: Node): Node => ({
  ...node,
  capabilities: { managedDatabasesV1: true, managedStorageV1: true, databaseBackupsV1: true },
});

function member(overrides: Partial<AvailabilityMember>): AvailabilityMember {
  return {
    id: uuid(7101),
    nodeId: dbNode.id,
    nodeName: "Database host",
    priority: 50,
    role: "primary",
    eligible: true,
    eligibilityReason: null,
    lagBytes: null,
    lagSeconds: null,
    syncState: "none",
    status: "ready",
    desiredState: "member",
    publishedPort: 5433,
    lastError: null,
    lastReportedAt: ago(4, "s"),
    reporting: true,
    ...overrides,
  };
}

const primary = member({});
const copy = member({
  id: uuid(7102),
  nodeId: dbNode2.id,
  nodeName: "Database host 2",
  priority: 40,
  role: "copy",
  lagBytes: 0,
  lagSeconds: 0,
  syncState: "sync",
});

const healthy: AvailabilityView = {
  setId: uuid(7100),
  mode: "automatic",
  state: "healthy",
  stateReason: null,
  durability: "synchronous",
  durabilitySource: "auto",
  lossWindowText:
    "Synchronous: an automatic failover loses no acknowledged commit while the copy confirms; when the copy stops confirming for 10 s, writes continue on the primary and an automatic failover is not possible until it catches up.",
  maxLagBytes: 1024 * 1024,
  syncDegradeAfterSeconds: 10,
  priorityMode: false,
  failbackDelaySeconds: 300,
  rttP50Ms: 3.1,
  rttMeasuredAt: ago(4, "m"),
  primaryMemberId: primary.id,
  primarySince: ago(6, "d"),
  primaryGeneration: 0,
  members: [primary, copy],
  voters: [dbNode.id, dbNode2.id, witnessRelay.id],
  witnesses: [
    {
      id: uuid(7110),
      purpose: "lease",
      hostKind: "relay",
      relayInstanceId: witnessRelay.id,
      nodeId: null,
      role: "active",
      status: "ready",
    },
  ],
  missingForAutomatic: null,
  canLose: 1,
  lease: { mode: "lease", degraded: false, reason: null, joint: false, holderNodeId: dbNode.id },
  policyLeaseHours: 168,
  operation: null,
  connection: {
    multiHostUri:
      "postgresql://10.20.0.15:5433,10.20.0.16:5433/orders?target_session_attrs=read-write&sslmode=verify-full",
    hosts: [
      { memberId: primary.id, host: "10.20.0.15", port: 5433 },
      { memberId: copy.id, host: "10.20.0.16", port: 5433 },
    ],
  },
};

export type AvailabilityScreenState = "single" | "healthy" | "degraded" | "manual" | "failover";

export const availabilityViews: Record<Exclude<AvailabilityScreenState, "single">, AvailabilityView> = {
  healthy,
  degraded: {
    ...healthy,
    state: "no_failover",
    stateReason: {
      code: "sync_degraded",
      message:
        "Database host 2 stopped confirming writes 3 min ago. Writes continue on the primary; no automatic failover until it catches up.",
    },
    canLose: 0,
    members: [
      primary,
      {
        ...copy,
        eligible: false,
        eligibilityReason: "degraded",
        lagBytes: 42 * 1024 * 1024,
        lagSeconds: 184,
        syncState: "async",
      },
    ],
  },
  manual: {
    ...healthy,
    mode: "manual",
    durability: "asynchronous",
    lossWindowText:
      "Asynchronous: an automatic failover can lose up to about 1 MiB of recent writes (plus about 1 s); a copy further behind is not eligible.",
    rttP50Ms: 38,
    voters: [],
    witnesses: [],
    canLose: null,
    lease: null,
    primaryGeneration: 1,
    missingForAutomatic:
      "Automatic failover needs a third host for a witness: an allowed relay or a docker node on another host.",
    policyLeaseHours: 72,
    members: [primary, { ...copy, syncState: "async", lagBytes: 12 * 1024, lagSeconds: 0.2 }],
  },
  failover: {
    ...healthy,
    state: "failing_over",
    stateReason: { message: "Database host stopped answering 18 s ago; Database host 2 is taking over." },
    canLose: 0,
    operation: null,
    members: [{ ...primary, reporting: false, lastReportedAt: ago(19, "s") }, copy],
  },
};

export const availabilityEvents: AvailabilityEvent[] = [
  {
    id: uuid(7201),
    action: "availability.restored",
    details: { message: "Database host 2 caught up and confirms writes again" },
    createdAt: ago(2, "h"),
  },
  {
    id: uuid(7202),
    action: "availability.degraded",
    details: { message: "Database host 2 stopped confirming writes for 10 s" },
    createdAt: ago(3, "h"),
  },
  {
    id: uuid(7203),
    action: "availability.switchover",
    details: { fromNodeName: "Database host 2", toNodeName: "Database host" },
    createdAt: ago(6, "d"),
  },
  {
    id: uuid(7204),
    action: "availability.enabled",
    details: null,
    createdAt: ago(9, "d"),
  },
];

export const createPreflight: AvailabilityPreflightResult = {
  mode: "automatic",
  voters: [dbNode.id, dbNode2.id, witnessRelay.id],
  witnesses: [{ kind: "relay", id: witnessRelay.id, name: witnessRelay.displayName }],
  rttP50Ms: 3.1,
  defaultDurability: "synchronous",
  durability: "synchronous",
  lossWindowText: healthy.lossWindowText,
  restartNeeded: false,
  policyLeaseHours: 72,
  missingForAutomatic: null,
  blockers: [],
  warnings: [],
};

/** Witness hosting on the relay rows: the remote relay hosts orders-db's witness. */
export const witnessRelaySnapshot: DashboardRelaySnapshot = {
  ...relaySnapshot,
  instances: relaySnapshot.instances!.map((instance, index): DashboardRelayInstance =>
    index === 1
      ? {
          ...instance,
          witnessHosting: "allowed" as const,
          witnessHostingAllowed: true,
          witnesses: [
            {
              id: uuid(7110),
              setId: healthy.setId,
              ownerKind: "managed_database",
              ownerId: ordersDb.managed!.id,
              ownerName: "orders-db",
              kind: "lease",
              role: "active",
              state: "running",
              version: null,
              error: null,
            },
          ],
        }
      : { ...instance, witnessHosting: "disabled" as const, witnessHostingAllowed: false }
  ).concat([
    {
      ...relaySnapshot.instances![1]!,
      id: uuid(65113),
      faultDomainId: "partner",
      displayName: "partner-relay",
      advertisedAddresses: ["198.51.100.40"],
      activeAssignments: 2,
      health: { activeTunnels: 3, registeredEndpoints: 2, pressurePercent: 9 },
      protected: true,
      witnessHosting: "protected_needs_opt_in" as const,
      witnessHostingAllowed: true,
    },
  ]),
};

/** Availability endpoints of orders-db in the given state, plus the nodes its pickers list. */
export function availabilityHandlers(state: AvailabilityScreenState) {
  const managedId = ordersDb.managed!.id;
  const nodeList = [...nodes, dbNode2].map((node) =>
    node.type === "databases" || node.type === "storage" ? capable(node) : node
  );
  return [
    http.get("*/api/nodes", ({ request }) => {
      const type = new URL(request.url).searchParams.get("type");
      const data = nodeList.filter((node) => !type || type === "all" || node.type === type);
      return ok({ data, total: data.length, page: 1, limit: 100, totalPages: 1 });
    }),
    http.get("*/api/system/relay", () => wrapped(witnessRelaySnapshot)),
    http.post("*/api/databases/managed/availability/preflight", () => wrapped(createPreflight)),
    http.post("*/api/databases/managed/:id/availability/preflight", () =>
      wrapped({ ...createPreflight, restartNeeded: true })
    ),
    http.get("*/api/databases/managed/:id/availability/events", ({ params }) =>
      params.id === managedId && state !== "single"
        ? wrapped({ data: availabilityEvents, page: 1, limit: 20 })
        : wrapped({ data: [], page: 1, limit: 20 })
    ),
    http.get("*/api/databases/managed/:id/availability", ({ params }) =>
      params.id === managedId && state !== "single"
        ? wrapped(availabilityViews[state])
        : HttpResponse.json(
            { code: "AVAILABILITY_SET_NOT_FOUND", message: "Availability is not enabled" },
            { status: 404 }
          )
    ),
  ];
}
