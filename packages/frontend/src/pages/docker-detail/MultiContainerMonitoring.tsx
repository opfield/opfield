import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { dockerVolumeLabel } from "@/lib/docker-volume-label";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { DockerVolumeMetrics } from "@/types";
import type { InspectData } from "./helpers";
import { StatsTab } from "./StatsTab";
import { VolumeSpaceStatCard } from "./VolumeSpaceStatCard";

export interface ContainerMonitoringInstance {
  id: string;
  groupTitle?: string;
  title: string;
  description?: string;
  nodeId: string;
  containerId: string;
  data?: InspectData;
}

type ProcessSnapshot = {
  titles: string[];
  rows: string[][];
  status: "loading" | "ready" | "error";
  truncated?: boolean;
  totalProcesses?: number;
  limit?: number;
};

const PROCESS_COLUMN_WIDTHS: Record<string, string> = {
  PID: "88px",
  USER: "140px",
  "%CPU": "88px",
  "%MEM": "88px",
  VSZ: "100px",
  RSS: "100px",
  TT: "72px",
  STAT: "88px",
  STARTED: "140px",
  TIME: "120px",
};

function processColumnStyle(title: string, index: number, titles: string[]) {
  const flexibleIndex = titles.findIndex((item) => item.toUpperCase() === "COMMAND");
  if (index === (flexibleIndex >= 0 ? flexibleIndex : titles.length - 1)) return undefined;
  return { width: PROCESS_COLUMN_WIDTHS[title.toUpperCase()] ?? "120px" };
}

function normalizeProcessSnapshot(result: {
  Titles?: string[];
  Processes?: string[][];
  truncated?: boolean;
  totalProcesses?: number;
  limit?: number;
}): ProcessSnapshot {
  const ttyIndex = result.Titles?.findIndex((title) => title === "TTY" || title === "TT") ?? -1;
  return {
    titles: result.Titles?.filter((_, index) => index !== ttyIndex) ?? [],
    rows: result.Processes?.map((row) => row.filter((_, index) => index !== ttyIndex)) ?? [],
    status: "ready",
    truncated: result.truncated,
    totalProcesses: result.totalProcesses,
    limit: result.limit,
  };
}

function fallbackInspect(): InspectData {
  return {
    State: {
      Running: true,
      Status: "running",
    },
  } as InspectData;
}

type MountedVolume = { key: string; nodeId: string; name: string };

const VOLUME_METRICS_INTERVAL_MS = 30_000;

/** The named and anonymous volumes the instances mount, once per node and volume. */
function mountedVolumes(
  instances: ContainerMonitoringInstance[],
  inspectById: Record<string, InspectData>
): MountedVolume[] {
  const volumes = new Map<string, MountedVolume>();
  for (const instance of instances) {
    const inspect = instance.data ?? inspectById[instance.id];
    const mounts: unknown[] = Array.isArray(inspect?.Mounts) ? inspect.Mounts : [];
    for (const mount of mounts as Array<{ Type?: unknown; Name?: unknown }>) {
      if (mount.Type !== "volume" || typeof mount.Name !== "string" || !mount.Name) continue;
      const key = `${instance.nodeId}\n${mount.Name}`;
      if (!volumes.has(key)) volumes.set(key, { key, nodeId: instance.nodeId, name: mount.Name });
    }
  }
  return [...volumes.values()];
}

/** Disk usage of the mounted volumes, shown exactly as on the volume detail page. */
function MountedVolumesSection({ volumes }: { volumes: MountedVolume[] }) {
  // Volume and node names never contain "|" or a newline.
  const identity = volumes.map((volume) => volume.key).join("|");
  const [metricsByKey, setMetricsByKey] = useState<Record<string, DockerVolumeMetrics | null>>({});
  const [historyByKey, setHistoryByKey] = useState<Record<string, number[]>>({});
  // Volumes the user may not view, or hidden ones such as unused anonymous volumes, are left out.
  const [unavailableKeys, setUnavailableKeys] = useState<Record<string, true>>({});
  const lastCollectedAtRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setMetricsByKey({});
    setHistoryByKey({});
    setUnavailableKeys({});
    lastCollectedAtRef.current = {};
    const requested: MountedVolume[] = identity
      ? identity.split("|").map((key) => {
          const [nodeId = "", name = ""] = key.split("\n");
          return { key, nodeId, name };
        })
      : [];
    const load = async () => {
      const results = await Promise.all(
        requested.map(async (volume) => {
          try {
            return { volume, metrics: await api.getVolumeMetrics(volume.nodeId, volume.name) };
          } catch (error) {
            const hidden = error instanceof ApiRequestError && [403, 404].includes(error.status);
            return { volume, metrics: null, hidden };
          }
        })
      );
      if (cancelled) return;
      const sampled: Array<[string, number]> = [];
      for (const { volume, metrics } of results) {
        if (!metrics || lastCollectedAtRef.current[volume.key] === metrics.collectedAt) continue;
        lastCollectedAtRef.current[volume.key] = metrics.collectedAt;
        sampled.push([volume.key, metrics.usedBytes ?? 0]);
      }
      // Keep the last successful sample during transient daemon refreshes.
      setMetricsByKey((previous) => {
        const next = { ...previous };
        for (const { volume, metrics } of results) {
          if (metrics) next[volume.key] = metrics;
          else if (!(volume.key in next)) next[volume.key] = null;
        }
        return next;
      });
      if (sampled.length > 0) {
        setHistoryByKey((previous) => {
          const next = { ...previous };
          for (const [key, usedBytes] of sampled) {
            next[key] = [...(next[key] ?? []), usedBytes].slice(-60);
          }
          return next;
        });
      }
      setUnavailableKeys((previous) => {
        const next = { ...previous };
        for (const result of results) {
          if ("hidden" in result && result.hidden) next[result.volume.key] = true;
          else if (result.metrics) delete next[result.volume.key];
        }
        return next;
      });
    };
    void load();
    const interval = window.setInterval(() => void load(), VOLUME_METRICS_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [identity]);

  const visible = volumes.filter((volume) => !unavailableKeys[volume.key]);
  if (visible.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Volumes</h3>
        <p className="text-xs text-muted-foreground">Disk usage of the mounted volumes.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {visible.map((volume) => (
          <VolumeSpaceStatCard
            key={volume.key}
            label={dockerVolumeLabel(volume.name).text}
            metrics={metricsByKey[volume.key] ?? null}
            history={historyByKey[volume.key] ?? []}
          />
        ))}
      </div>
    </section>
  );
}

export function MultiContainerMonitoring({
  instances,
}: {
  instances: ContainerMonitoringInstance[];
}) {
  const identity = useMemo(
    () =>
      instances
        .map((instance) => `${instance.id}:${instance.nodeId}:${instance.containerId}`)
        .join("|"),
    [instances]
  );
  const [inspectById, setInspectById] = useState<Record<string, InspectData>>({});
  const [processesById, setProcessesById] = useState<Record<string, ProcessSnapshot>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [readyStats, setReadyStats] = useState<Record<string, string>>({});
  const instancesRef = useRef(instances);
  const identityRef = useRef(identity);
  instancesRef.current = instances;
  identityRef.current = identity;
  const groups = useMemo(() => {
    const grouped = new Map<string, { title?: string; instances: ContainerMonitoringInstance[] }>();
    for (const instance of instances) {
      const key = instance.groupTitle ? `group:${instance.groupTitle}` : `instance:${instance.id}`;
      const group = grouped.get(key) ?? { title: instance.groupTitle, instances: [] };
      group.instances.push(instance);
      grouped.set(key, group);
    }
    return [...grouped.entries()].map(([id, group]) => ({ id, ...group }));
  }, [instances]);

  useEffect(() => {
    let cancelled = false;
    const requestedIdentity = identity;
    const currentInstances = instancesRef.current;
    setInspectById({});
    void Promise.all(
      currentInstances.map(async (instance) => {
        if (instance.data) return [instance.id, instance.data] as const;
        try {
          return [
            instance.id,
            (await api.inspectContainer(
              instance.nodeId,
              instance.containerId,
              true
            )) as InspectData,
          ] as const;
        } catch {
          return [instance.id, fallbackInspect()] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled && identityRef.current === requestedIdentity) {
        setInspectById(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    const requestedIdentity = identity;
    const currentInstances = instancesRef.current;
    setProcessesById(
      Object.fromEntries(
        currentInstances.map((instance) => [
          instance.id,
          { titles: [], rows: [], status: "loading" } satisfies ProcessSnapshot,
        ])
      )
    );
    const load = async () => {
      const entries = await Promise.all(
        currentInstances.map(async (instance) => {
          try {
            const result = await api.getContainerTop(instance.nodeId, instance.containerId);
            return [instance.id, normalizeProcessSnapshot(result)] as const;
          } catch {
            return [
              instance.id,
              { titles: [], rows: [], status: "error" } satisfies ProcessSnapshot,
            ] as const;
          }
        })
      );
      if (!cancelled && identityRef.current === requestedIdentity) {
        setProcessesById(Object.fromEntries(entries));
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [identity]);

  // Keep the initial page-load registration alive across inspect -> stats.
  // StatsTab mounts after inspect, too late to register with PageTransition itself.
  const initialLoadPending = instances.some(
    (instance) =>
      readyStats[instance.id] !== identity ||
      !processesById[instance.id] ||
      processesById[instance.id].status === "loading"
  );
  const inspectPending = groups.some((group) =>
    group.instances.some((instance) => !(instance.data ?? inspectById[instance.id]))
  );
  useContentLoading(initialLoadPending || inspectPending);

  if (instances.length === 0) {
    return (
      <PanelShell title="Monitoring">
        <div className="px-4 py-8 text-sm text-muted-foreground">
          No serving instances are available for monitoring.
        </div>
      </PanelShell>
    );
  }

  const volumes = mountedVolumes(instances, inspectById);
  const processTitles = instances
    .map((instance) => processesById[instance.id]?.titles)
    .find((titles) => titles && titles.length > 0) ?? ["COMMAND"];
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.id} className="space-y-4">
          {group.title && (
            <h2 className="text-base font-semibold text-foreground">{group.title}</h2>
          )}
          {group.instances.map((instance) => {
            const inspect = instance.data ?? inspectById[instance.id];
            return (
              <div key={instance.id} className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{instance.title}</h3>
                  {instance.description && (
                    <p className="text-xs text-muted-foreground">{instance.description}</p>
                  )}
                </div>
                {inspect ? (
                  <StatsTab
                    nodeId={instance.nodeId}
                    containerId={instance.containerId}
                    data={inspect}
                    showProcesses={false}
                    className="pb-0"
                    onInitialLoadComplete={() => {
                      if (identityRef.current !== identity) return;
                      setReadyStats((previous) =>
                        previous[instance.id] === identity
                          ? previous
                          : { ...previous, [instance.id]: identity }
                      );
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </section>
      ))}

      <MountedVolumesSection volumes={volumes} />

      <PanelShell
        title="Processes"
        description="Running processes grouped by container instance."
        bodyClassName="overflow-x-auto"
      >
        <table className="w-full min-w-[1120px] table-fixed">
          <colgroup>
            {processTitles.map((title, columnIndex) => (
              <col key={title} style={processColumnStyle(title, columnIndex, processTitles)} />
            ))}
          </colgroup>
          <thead className="bg-header">
            <tr className="border-b border-border text-left">
              {processTitles.map((title) => (
                <th
                  key={title}
                  className="overflow-hidden text-ellipsis px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"
                >
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          {instances.map((instance, instanceIndex) => {
            const snapshot = processesById[instance.id] ?? {
              titles: [],
              rows: [],
              status: "loading" as const,
            };
            const isExpanded = expanded[instance.id] ?? true;
            const isLastInstance = instanceIndex === instances.length - 1;
            const label = instance.groupTitle
              ? `${instance.groupTitle} · ${instance.title}`
              : instance.title;
            return (
              <tbody key={instance.id}>
                <tr className="bg-muted/60">
                  <td colSpan={processTitles.length} className="p-0">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground transition-colors hover:bg-muted/80"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((current) => ({ ...current, [instance.id]: !isExpanded }))
                      }
                    >
                      <span>{label}</span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                  </td>
                </tr>
                <tr className={isLastInstance ? undefined : "border-b border-border"}>
                  <td colSpan={processTitles.length} className="p-0">
                    <div
                      aria-hidden={!isExpanded}
                      inert={isExpanded ? undefined : true}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
                        isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                      }`}
                    >
                      <div
                        className={`min-h-0 overflow-hidden ${isExpanded ? "border-t border-border" : ""}`}
                      >
                        {snapshot.rows.length > 0 ? (
                          <table className="w-full table-fixed">
                            <colgroup>
                              {processTitles.map((title, columnIndex) => (
                                <col
                                  key={title}
                                  style={processColumnStyle(title, columnIndex, processTitles)}
                                />
                              ))}
                            </colgroup>
                            <tbody>
                              {snapshot.rows.map((row, rowIndex) => (
                                <tr
                                  key={`${instance.id}-${rowIndex}`}
                                  className="border-b border-border last:border-b-0"
                                >
                                  {processTitles.map((title, columnIndex) => (
                                    <td
                                      key={`${title}-${columnIndex}`}
                                      className="overflow-hidden px-4 py-2 font-mono text-xs [overflow-wrap:anywhere]"
                                    >
                                      {row[columnIndex] ?? "—"}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="px-4 py-5 text-sm text-muted-foreground">
                            {snapshot.status === "loading"
                              ? "Loading processes..."
                              : snapshot.status === "error"
                                ? "Process list is temporarily unavailable. Retrying automatically."
                                : "No running processes reported. Retrying automatically."}
                          </div>
                        )}
                        {snapshot.truncated && (
                          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                            Showing first {snapshot.limit ?? snapshot.rows.length} of{" "}
                            {snapshot.totalProcesses ?? "many"} processes.
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            );
          })}
        </table>
      </PanelShell>
    </div>
  );
}
