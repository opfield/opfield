import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Clock3,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/ui/stat-card";
import { useRealtime } from "@/hooks/use-realtime";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  ManagedDatabaseBinding,
  ManagedDatabaseBindingRuntime,
  ManagedDatabaseBindingTargetType,
  ManagedObjectStorage,
  ManagedStorageBinding,
} from "@/types";

const MAX_HISTORY = 60;
const POLL_INTERVAL_MS = 2000;

export interface ContainerDatabaseLink {
  database: Pick<import("@/types").ManagedDatabase, "id" | "name" | "type">;
  binding: Pick<
    ManagedDatabaseBinding,
    | "id"
    | "managedDatabaseId"
    | "targetNodeId"
    | "targetType"
    | "targetResourceId"
    | "status"
    | "lastError"
  >;
}

/** A managed storage link of a container or deployment. */
export interface WorkloadStorageLink {
  storage: Pick<ManagedObjectStorage, "id" | "name">;
  binding: Pick<
    ManagedStorageBinding,
    "id" | "clusterId" | "targetNodeId" | "targetType" | "targetResourceId" | "status" | "lastError"
  >;
}

/** One database or storage link of the section, with how its runtime is read. */
interface RuntimeLink {
  id: string;
  name: string;
  badges: string[];
  status: ManagedDatabaseBinding["status"];
  load: () => Promise<ManagedDatabaseBindingRuntime | null>;
}

interface RuntimeSample {
  at: number;
  runtime: ManagedDatabaseBindingRuntime;
}

interface LinkRuntimeState {
  runtime: ManagedDatabaseBindingRuntime | null;
  history: RuntimeSample[];
  telemetryUnavailable: boolean;
  loading: boolean;
}

/** A Compose service link targets `<project id>:<encoded service name>`. */
function composeServiceName(targetResourceId: string) {
  const name = targetResourceId.slice(targetResourceId.indexOf(":") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function counter(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function rollingRate(history: RuntimeSample[], pick: (sample: RuntimeSample) => number): number[] {
  if (history.length < 2) return history.length ? [0] : [];
  return history.slice(1).map((sample, index) => {
    const previous = history[index];
    // A relay that stops or starts answering changes the counters' coverage, not what the link carried.
    if (relayUnknown(sample.runtime) !== relayUnknown(previous.runtime)) return 0;
    const elapsedSeconds = Math.max(0.001, (sample.at - previous.at) / 1000);
    return Math.max(0, pick(sample) - pick(previous)) / elapsedSeconds;
  });
}

/** A relay that holds the link's routes did not answer: its relay counters are unknown. */
function relayUnknown(runtime: ManagedDatabaseBindingRuntime) {
  return runtime.relayCountersComplete === false;
}

const RELAY_UNKNOWN = "A relay did not answer";

function latest(values: number[]) {
  return values.at(-1) ?? 0;
}

function duration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0 ms";
  if (milliseconds < 1) return `${Math.round(milliseconds * 1000)} µs`;
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

// Gateway names this limit for links without a fixed cap (relay admission bounds them by load).
const UNCAPPED_LINK_CONNECTIONS = 1_000_000;

/** Why the node or a relay refused a link's latest refused connection (the daemon's reasons). */
const REJECTION_REASONS: Record<string, string> = {
  link_limit: "link at its connection limit",
  node_limit: "node at its connection limit",
  relay_capacity: "relay at capacity",
  relay_unavailable: "relay unavailable",
  relay_refused: "relay refused",
  source_not_allowed: "source not allowed",
  unknown_peer: "unknown peer",
  network_unverified: "network not verified",
  network_changed: "network changed",
  grant_unavailable: "no relay grant",
  route_changed: "route changed",
};

function runtimeCards(runtime: ManagedDatabaseBindingRuntime, history: RuntimeSample[]) {
  const activeHistory = history.map((sample) => counter(sample.runtime.activeStreams));
  const openedRateHistory = rollingRate(history, (sample) => counter(sample.runtime.openedTotal));
  const sourceToTargetRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.sourceToTargetBytes)
  );
  const targetToSourceRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.targetToSourceBytes)
  );
  const failedRateHistory = rollingRate(history, (sample) => counter(sample.runtime.failedTotal));
  const throttledRateHistory = rollingRate(history, (sample) =>
    counter(sample.runtime.throttledTotal)
  );
  const completed = counter(runtime.completedTotal);
  const failed = counter(runtime.failedTotal);
  const successPercent =
    completed > 0 ? clampPercent(((completed - failed) / completed) * 100) : 100;
  const connections = runtime.connections ?? null;
  // The nodes' counts stand whatever the relays answered; without them the stream and byte counters are relays' too.
  const relayCounters = relayUnknown(runtime);
  const streamCounters = relayCounters && !connections;
  const lastRejection = connections?.lastRejectionReason
    ? (REJECTION_REASONS[connections.lastRejectionReason] ?? connections.lastRejectionReason)
    : null;
  const successHistory = history.map((sample) => {
    const sampleCompleted = counter(sample.runtime.completedTotal);
    const sampleFailed = counter(sample.runtime.failedTotal);
    return sampleCompleted > 0
      ? clampPercent(((sampleCompleted - sampleFailed) / sampleCompleted) * 100)
      : 100;
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Active streams"
        value={streamCounters ? "—" : counter(runtime.activeStreams).toLocaleString()}
        icon={Activity}
        history={activeHistory}
        color="var(--color-hue-blue)"
        subtitle={
          streamCounters
            ? RELAY_UNKNOWN
            : !connections || connections.limit <= 0
              ? "Current streams on this link"
              : connections.limit >= UNCAPPED_LINK_CONNECTIONS
                ? "Open connections, no fixed limit"
                : `Open connections, limit ${connections.limit.toLocaleString()}`
        }
      />
      <StatCard
        label="New streams"
        value={streamCounters ? "—" : `${latest(openedRateHistory).toFixed(1)}/s`}
        icon={Zap}
        history={openedRateHistory}
        color="var(--color-hue-cyan)"
        subtitle={
          streamCounters
            ? RELAY_UNKNOWN
            : `${counter(runtime.openedTotal).toLocaleString()} opened since ${connections ? "the node's daemon started" : "Relay start"}`
        }
      />
      <StatCard
        label="Source → target"
        value={streamCounters ? "—" : `${formatBytes(latest(sourceToTargetRateHistory))}/s`}
        icon={ArrowUpFromLine}
        history={sourceToTargetRateHistory}
        color="var(--color-hue-violet)"
        subtitle={
          streamCounters
            ? RELAY_UNKNOWN
            : `${formatBytes(counter(runtime.sourceToTargetBytes))} transferred`
        }
      />
      <StatCard
        label="Target → source"
        value={streamCounters ? "—" : `${formatBytes(latest(targetToSourceRateHistory))}/s`}
        icon={ArrowDownToLine}
        history={targetToSourceRateHistory}
        color="var(--color-hue-pink)"
        subtitle={
          streamCounters
            ? RELAY_UNKNOWN
            : `${formatBytes(counter(runtime.targetToSourceBytes))} transferred`
        }
      />
      <StatCard
        label="Open success"
        value={relayCounters ? "—" : `${successPercent.toFixed(1)}%`}
        icon={ShieldCheck}
        history={successHistory}
        sparklineMax={100}
        progress={
          relayCounters
            ? undefined
            : {
                percent: successPercent,
                color: successPercent >= 99 ? "var(--color-hue-green)" : "var(--color-hue-amber)",
              }
        }
        color="var(--color-hue-green)"
        subtitle={
          relayCounters
            ? RELAY_UNKNOWN
            : `${Math.max(0, completed - failed).toLocaleString()} successful completions`
        }
      />
      <StatCard
        label="Setup p95"
        value={relayCounters ? "—" : duration(counter(runtime.setupLatencyP95Ms))}
        icon={Timer}
        history={history.map((sample) => counter(sample.runtime.setupLatencyP95Ms))}
        color="var(--color-hue-amber)"
        subtitle={relayCounters ? RELAY_UNKNOWN : "OpenTunnel to both peers ready"}
      />
      <StatCard
        label="Average duration"
        value={relayCounters ? "—" : duration(counter(runtime.averageDurationMs))}
        icon={Clock3}
        history={history.map((sample) => counter(sample.runtime.averageDurationMs))}
        color="var(--color-hue-violet)"
        subtitle={relayCounters ? RELAY_UNKNOWN : `${completed.toLocaleString()} completed streams`}
      />
      <StatCard
        label="Admission rejects"
        value={relayCounters ? "—" : counter(runtime.throttledTotal).toLocaleString()}
        icon={Ban}
        history={throttledRateHistory}
        color="var(--color-hue-red)"
        subtitle={
          relayCounters
            ? RELAY_UNKNOWN
            : latest(throttledRateHistory) > 0
              ? `${latest(throttledRateHistory).toFixed(1)}/s currently`
              : lastRejection
                ? `Last: ${lastRejection}`
                : `${latest(failedRateHistory).toFixed(1)}/s tunnel failures`
        }
      />
    </div>
  );
}

function emptyRuntimeCards() {
  const cards = [
    ["Active streams", Activity],
    ["New streams", Zap],
    ["Source → target", ArrowUpFromLine],
    ["Target → source", ArrowDownToLine],
    ["Open success", ShieldCheck],
    ["Setup p95", Timer],
    ["Average duration", Clock3],
    ["Admission rejects", Ban],
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map(([label, icon]) => (
        <StatCard
          key={label}
          label={label}
          value="—"
          icon={icon}
          history={[]}
          subtitle="Waiting for runtime telemetry"
        />
      ))}
    </div>
  );
}

export function LinkRuntimeTab({
  links,
  storageLinks = [],
  onHealthChange,
}: {
  links: ContainerDatabaseLink[];
  storageLinks?: WorkloadStorageLink[];
  onHealthChange?: (down: boolean) => void;
}) {
  const [states, setStates] = useState<Record<string, LinkRuntimeState>>({});
  const generationRef = useRef(0);
  const orderedLinks = useMemo<RuntimeLink[]>(
    () =>
      [
        ...links.map(({ database, binding }) => ({
          id: binding.id,
          name: database.name,
          badges: [
            database.type,
            ...(binding.targetType === "compose_service"
              ? [composeServiceName(binding.targetResourceId)]
              : []),
          ],
          status: binding.status,
          load: async () =>
            (await api.getManagedDatabaseBindingRuntime(database.id, binding.id)).runtime,
        })),
        ...storageLinks.map(({ storage, binding }) => ({
          id: binding.id,
          name: storage.name,
          badges: ["S3"],
          status: binding.status,
          load: async () =>
            (await api.getManagedStorageBindingRuntime(storage.id, binding.id)).runtime,
        })),
      ].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      ),
    [links, storageLinks]
  );
  const linksRef = useRef(orderedLinks);
  linksRef.current = orderedLinks;
  const linkIds = orderedLinks.map(({ id }) => id).join("|");

  useEffect(() => {
    const generation = ++generationRef.current;
    const activeLinkIds = new Set(linkIds.split("|").filter(Boolean));
    let inFlight = false;
    setStates((current) =>
      Object.fromEntries(
        linksRef.current
          .filter(({ id }) => activeLinkIds.has(id))
          .map(({ id }) => [
            id,
            current[id] ?? {
              runtime: null,
              history: [],
              telemetryUnavailable: false,
              loading: true,
            },
          ])
      )
    );
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const currentLinks = linksRef.current.filter(({ status }) => status !== "error");
        const results = await Promise.allSettled(currentLinks.map((link) => link.load()));
        if (generation !== generationRef.current) return;
        const sampledAt = Date.now();
        setStates((current) => {
          if (generation !== generationRef.current) return current;
          const next: Record<string, LinkRuntimeState> = {};
          for (const [index, result] of results.entries()) {
            const linkId = currentLinks[index]!.id;
            const previous = current[linkId];
            if (result.status === "fulfilled") {
              const runtime = result.value;
              next[linkId] = {
                runtime,
                history: runtime
                  ? [...(previous?.history ?? []), { at: sampledAt, runtime }].slice(-MAX_HISTORY)
                  : (previous?.history ?? []),
                telemetryUnavailable: false,
                loading: false,
              };
            } else {
              next[linkId] = {
                runtime: previous?.runtime ?? null,
                history: previous?.history ?? [],
                telemetryUnavailable: true,
                loading: false,
              };
            }
          }
          return next;
        });
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [linkIds]);

  const hasDownLink = orderedLinks.some(({ status }) => status === "error");
  useContentLoading(
    orderedLinks.some(({ id, status }) => {
      if (status === "error") return false;
      const state = states[id];
      return !state || state.loading;
    })
  );
  useEffect(() => {
    onHealthChange?.(hasDownLink);
  }, [hasDownLink, onHealthChange]);

  return (
    <div className="space-y-6">
      {orderedLinks.map(({ id, name, badges, status }) => {
        const state = states[id];
        if (status === "error") return null;
        return (
          <section key={id} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-muted-foreground">{name}</h3>
              {badges.map((badge) => (
                <Badge key={badge} variant="secondary">
                  {badge}
                </Badge>
              ))}
              <Badge
                variant={
                  status === "ready"
                    ? "success"
                    : status === "creating" || status === "deleting"
                      ? "warning"
                      : "destructive"
                }
              >
                {status}
              </Badge>
            </div>

            {state?.loading || !state ? null : state.runtime ? (
              <>
                {runtimeCards(state.runtime, state.history)}
                {state.telemetryUnavailable && (
                  <p className="text-xs text-muted-foreground">
                    Runtime telemetry is temporarily unavailable. Showing the last confirmed sample.
                  </p>
                )}
              </>
            ) : state.telemetryUnavailable ? (
              <p className="text-xs text-muted-foreground">
                Runtime telemetry is temporarily unavailable.
              </p>
            ) : (
              emptyRuntimeCards()
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The Link Runtime of a workload: its managed database links and, for a container or deployment, its managed storage
 * links. A container's database links come with its details; the others are listed from the managed databases and
 * storage the caller can view. A Compose target id is the project id and matches the links of all its services.
 */
export function WorkloadLinkRuntime({
  nodeId,
  targetType,
  targetResourceId,
  databaseLinks,
  onHealthChange,
}: {
  nodeId: string;
  targetType: ManagedDatabaseBindingTargetType;
  targetResourceId: string;
  /** The links a container's details carry; listed here when absent. */
  databaseLinks?: ContainerDatabaseLink[];
  onHealthChange?: (down: boolean) => void;
}) {
  const canViewStorage = useAuthStore((state) => state.hasScopedAccess("storage:view"));
  const [listedDatabaseLinks, setListedDatabaseLinks] = useState<ContainerDatabaseLink[]>([]);
  const [storageLinks, setStorageLinks] = useState<WorkloadStorageLink[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(!databaseLinks);
  const [storageLoading, setStorageLoading] = useState(true);
  const databaseLoadRef = useRef(0);
  const storageLoadRef = useRef(0);
  const listsDatabases = !databaseLinks;
  const storageTarget = targetType === "container" || targetType === "deployment";
  const matches = useCallback(
    (binding: Pick<ManagedDatabaseBinding, "targetNodeId" | "targetType" | "targetResourceId">) =>
      binding.targetNodeId === nodeId &&
      binding.targetType === targetType &&
      (targetType === "compose_service"
        ? binding.targetResourceId.startsWith(`${targetResourceId}:`)
        : binding.targetResourceId === targetResourceId),
    [nodeId, targetResourceId, targetType]
  );

  const loadDatabases = useCallback(async () => {
    if (!listsDatabases) return;
    const current = ++databaseLoadRef.current;
    try {
      const databases = await api.listManagedDatabases();
      const results = await Promise.all(
        databases.map(async (database) => ({
          database,
          bindings: await api
            .listManagedDatabaseBindings(database.id)
            .catch(() => [] as ManagedDatabaseBinding[]),
        }))
      );
      if (current !== databaseLoadRef.current) return;
      setListedDatabaseLinks(
        results.flatMap(({ database, bindings }) =>
          bindings.filter(matches).map((binding) => ({
            database: { id: database.id, name: database.name, type: database.type },
            binding,
          }))
        )
      );
    } catch {
      // Without managed database access there is no link runtime to show.
      if (current === databaseLoadRef.current) setListedDatabaseLinks([]);
    } finally {
      if (current === databaseLoadRef.current) setDatabasesLoading(false);
    }
  }, [listsDatabases, matches]);

  const loadStorage = useCallback(async () => {
    const current = ++storageLoadRef.current;
    if (!storageTarget || !canViewStorage) {
      setStorageLinks([]);
      setStorageLoading(false);
      return;
    }
    try {
      const clusters = await api.listManagedObjectStorages();
      const results = await Promise.all(
        clusters.map(async (storage) => ({
          storage,
          bindings: await api
            .listManagedStorageBindings(storage.id)
            .catch(() => [] as ManagedStorageBinding[]),
        }))
      );
      if (current !== storageLoadRef.current) return;
      setStorageLinks(
        results.flatMap(({ storage, bindings }) =>
          bindings.filter(matches).map((binding) => ({
            storage: { id: storage.id, name: storage.name },
            binding,
          }))
        )
      );
    } catch {
      // Without managed storage access there is no link runtime to show.
      if (current === storageLoadRef.current) setStorageLinks([]);
    } finally {
      if (current === storageLoadRef.current) setStorageLoading(false);
    }
  }, [canViewStorage, matches, storageTarget]);

  useEffect(() => {
    setDatabasesLoading(listsDatabases);
    void loadDatabases();
  }, [listsDatabases, loadDatabases]);

  useEffect(() => {
    setStorageLoading(true);
    void loadStorage();
  }, [loadStorage]);

  useRealtime(
    "database.changed",
    (rawPayload) => {
      if (!listsDatabases) return;
      const payload = rawPayload as
        | {
            resourceKind?: string;
            targetNodeId?: string;
            targetType?: ManagedDatabaseBindingTargetType;
            targetResourceId?: string;
          }
        | undefined;
      if (payload?.resourceKind !== "managed_database_binding") return;
      if (
        payload.targetNodeId &&
        payload.targetType &&
        payload.targetResourceId !== undefined &&
        !matches({
          targetNodeId: payload.targetNodeId,
          targetType: payload.targetType,
          targetResourceId: payload.targetResourceId,
        })
      ) {
        return;
      }
      void loadDatabases();
    },
    { onReconnect: () => void loadDatabases() }
  );

  useRealtime(
    "storage.changed",
    (rawPayload) => {
      // Link changes carry their binding id; cluster changes do not touch this workload's links.
      if (!(rawPayload as { bindingId?: string } | undefined)?.bindingId) return;
      void loadStorage();
    },
    { onReconnect: () => void loadStorage() }
  );

  const links = databaseLinks ?? listedDatabaseLinks;
  useContentLoading(databasesLoading || storageLoading);
  if (links.length === 0 && storageLinks.length === 0) return null;
  return (
    <LinkRuntimeTab links={links} storageLinks={storageLinks} onHealthChange={onHealthChange} />
  );
}
