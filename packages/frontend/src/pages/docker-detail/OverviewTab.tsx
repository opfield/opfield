import { ClipboardCopy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { AvailabilitySummary } from "@/components/docker/availability/AvailabilitySummary";
import { ImageReference } from "@/components/docker/ImageReference";
import { Badge } from "@/components/ui/badge";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDisplayImageRef, resolveContainerImageReference } from "@/lib/docker-image-ref";
import { isOpfieldManagedDockerNetwork } from "@/lib/docker-networks";
import { normalizeDockerRuntimeProfile } from "@/lib/docker-runtime-profile";
import { dockerVolumeLabel, isAnonymousVolumeName } from "@/lib/docker-volume-label";
import { formatShellWords } from "@/lib/shell-words";
import { shortCommitSha } from "@/lib/workload-image-label";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DockerAvailabilityPolicy } from "@/types";
import { copyToClipboard, type InspectData, STATUS_BADGE } from "./helpers";
import { type ContainerDatabaseLink, WorkloadLinkRuntime } from "./LinkRuntimeTab";

export function OverviewTab({
  nodeId,
  containerId,
  data,
  imageReferenceOverride,
  sourceIdentity,
  databaseLinks,
  onSecureLinkHealthChange,
  logicalContainerName,
  availabilityPolicy,
  availabilityLoading,
}: {
  nodeId: string;
  containerId: string;
  data: InspectData;
  imageReferenceOverride?: string | null;
  sourceIdentity?: {
    repositoryFullPath: string;
    deployedCommitSha: string | null;
  } | null;
  databaseLinks: ContainerDatabaseLink[];
  onSecureLinkHealthChange?: (down: boolean) => void;
  logicalContainerName?: string;
  availabilityPolicy?: DockerAvailabilityPolicy | null;
  availabilityLoading?: boolean;
}) {
  const transition = data._transition as string | undefined;
  const state = transition ?? data.State?.Status ?? (data.State?.Running ? "running" : "stopped");
  const id = data.Id ?? containerId;
  const image = formatDisplayImageRef(
    imageReferenceOverride || resolveContainerImageReference(data)
  );
  const created = data.Created ?? "";
  const restartPolicy = data.HostConfig?.RestartPolicy?.Name ?? "no";
  const platform = data.Platform ?? "";
  const hostname = (data.Config?.Hostname ?? "") as string;
  const runtimeName = (data.HostConfig?.Runtime ?? "") as string;
  const runtimeProfile = normalizeDockerRuntimeProfile(runtimeName);
  const entrypoint = (data.Config?.Entrypoint ?? []) as string[];
  const cmd = (data.Config?.Cmd ?? []) as string[];
  const workingDir = (data.Config?.WorkingDir ?? "") as string;
  const user = (data.Config?.User ?? "") as string;

  // Ports
  const portBindings = (data.HostConfig?.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp: string; HostPort: string }> | null
  >;
  const ports: Array<{ container: string; host: string }> = [];
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    if (bindings) {
      for (const b of bindings) {
        ports.push({
          container: containerPort,
          host: b.HostPort ? `${b.HostIp || "0.0.0.0"}:${b.HostPort}` : "-",
        });
      }
    }
  }

  // Mounts
  const mounts = (data.Mounts ?? []) as Array<{
    Type: string;
    Name?: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;

  // Networks the user attached; Opfield's own (links, managed databases, Secure Links) stay out, as in Settings.
  const networkEntries = (
    Object.entries(data.NetworkSettings?.Networks ?? {}) as Array<[string, any]>
  ).filter(([name]) => !isOpfieldManagedDockerNetwork(name));

  // Recent tasks — refresh on inspect cycle and whenever a docker.task event arrives
  const containerName = logicalContainerName || (data.Name ?? "").replace(/^\//, "");
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  // Recent Activity appears only when there are tasks: wait for the first answer.
  const [recentTasksLoaded, setRecentTasksLoaded] = useState(false);
  useContentLoading(!recentTasksLoaded);
  // Task history needs docker:tasks on this node; without it the panel stays hidden and nothing is requested.
  const canViewTasks = useAuthStore(
    (state) => state.hasScope("docker:tasks") || state.hasScope(`docker:tasks:${nodeId}`)
  );
  const refreshTasks = useCallback(() => {
    if (!canViewTasks) {
      setRecentTasksLoaded(true);
      return;
    }
    api
      .listDockerTasks({ nodeId })
      .then((tasks) => {
        const filtered = (tasks ?? [])
          .filter((t) => t.containerId === containerId || t.containerName === containerName)
          .slice(0, 3);
        setRecentTasks(filtered);
      })
      .catch(() => {})
      .finally(() => setRecentTasksLoaded(true));
  }, [canViewTasks, nodeId, containerId, containerName]);
  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);
  useRealtime("docker.task.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (!ev || ev.nodeId !== nodeId) return;
    refreshTasks();
  });
  // Container state changes (start/stop/recreate) also produce tasks worth showing
  useRealtime("docker.container.changed", (payload) => {
    const ev = payload as { nodeId?: string; name?: string; id?: string; oldId?: string };
    if (!ev || ev.nodeId !== nodeId) return;
    if (ev.id === containerId || ev.oldId === containerId || ev.name === containerName) {
      refreshTasks();
    }
  });

  return (
    <div className="space-y-4">
      <AvailabilitySummary
        resource={{ type: "container", nodeId, containerName }}
        policy={availabilityPolicy}
        loading={availabilityLoading}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* General */}
        <PanelShell
          title="General"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Status"
            value={<Badge variant={STATUS_BADGE[state] ?? "secondary"}>{state}</Badge>}
          />
          <DetailRow
            label="Container ID"
            value={
              // Inline copy control inside the value text; a Button would change the row height.
              <button
                type="button"
                className="flex items-center gap-1.5 font-mono hover:text-primary cursor-pointer"
                title={id}
                onClick={() => copyToClipboard(id)}
              >
                {id.slice(0, 12)}
                <ClipboardCopy className="h-3 w-3" />
              </button>
            }
          />
          <DetailRow
            label={sourceIdentity ? "Source" : "Image"}
            value={
              sourceIdentity ? (
                <span className="flex min-w-0 max-w-full items-center justify-end gap-1.5">
                  <span className="truncate">{sourceIdentity.repositoryFullPath}</span>
                  {sourceIdentity.deployedCommitSha ? (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground">
                        &middot;
                      </span>
                      <span className="shrink-0 font-mono">
                        {shortCommitSha(sourceIdentity.deployedCommitSha)}
                      </span>
                    </>
                  ) : null}
                  {/* Inline copy icon inside the value text, like the Container ID above. */}
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-primary"
                    aria-label="Copy immutable image reference"
                    title="Copy immutable image reference"
                    onClick={() => copyToClipboard(image)}
                  >
                    <ClipboardCopy className="h-3 w-3" />
                  </button>
                </span>
              ) : (
                <ImageReference
                  value={imageReferenceOverride || resolveContainerImageReference(data)}
                  source={data.imageSource}
                  sourceImage={data.imageSourceImage}
                />
              )
            }
          />
          <DetailRow label="Created" value={<RelativeTime value={created} />} />
          <DetailRow label="Restart Policy" value={restartPolicy} />
          {platform && <DetailRow label="Platform" value={platform} />}
        </PanelShell>

        {/* Execution */}
        <PanelShell
          title="Execution"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Entrypoint"
            value={
              <span className="font-mono">
                {entrypoint.length > 0 ? formatShellWords(entrypoint) : "-"}
              </span>
            }
          />
          <DetailRow
            label="Command"
            value={
              <span className="font-mono">{cmd.length > 0 ? formatShellWords(cmd) : "-"}</span>
            }
          />
          <DetailRow
            label="Working Dir"
            value={<span className="font-mono">{workingDir || "-"}</span>}
          />
          <DetailRow label="User" value={<span className="font-mono">{user || "-"}</span>} />
          <DetailRow
            label="Hostname"
            value={<span className="font-mono">{hostname || "-"}</span>}
          />
          <DetailRow
            label="Runtime"
            value={
              runtimeProfile === "secure" ? (
                <Badge variant="success">Secure · gVisor</Badge>
              ) : runtimeProfile === "default" ? (
                "Default"
              ) : (
                <span className="font-mono">{runtimeName}</span>
              )
            }
          />
        </PanelShell>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Ports */}
        <PanelShell
          title="Port Mappings"
          className="flex flex-col"
          bodyClassName="flex flex-1 flex-col [&>*]:flex-1"
          actions={ports.length > 0 ? <Badge variant="secondary">{ports.length}</Badge> : null}
        >
          {ports.length > 0 ? (
            <div className="max-h-80 divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border overflow-auto">
              {ports.map((p, i) => (
                <DetailRow
                  key={i}
                  label={p.host}
                  value={<span className="font-mono">{p.container}</span>}
                />
              ))}
            </div>
          ) : (
            <EmptyState message="No port mappings" embedded />
          )}
        </PanelShell>

        {/* Networks */}
        <PanelShell
          title="Networks"
          className="flex flex-col"
          bodyClassName="flex flex-1 flex-col [&>*]:flex-1"
          actions={
            networkEntries.length > 0 ? (
              <Badge variant="secondary">{networkEntries.length}</Badge>
            ) : null
          }
        >
          {networkEntries.length > 0 ? (
            <div className="max-h-80 divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border overflow-auto">
              {networkEntries.map(([name, cfg]) => (
                <DetailRow
                  key={name}
                  label={name}
                  value={<span className="font-mono">{cfg?.IPAddress || "-"}</span>}
                />
              ))}
            </div>
          ) : (
            <EmptyState message="No networks" embedded />
          )}
        </PanelShell>
      </div>

      {/* Mounts */}
      {mounts.length > 0 && (
        <PanelShell
          title="Mounts"
          actions={<Badge variant="secondary">{mounts.length}</Badge>}
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {mounts.map((m, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3 gap-4">
              <div className="min-w-0 flex-1">
                {/* The whole name; the row truncates it only by the width it has. */}
                {m.Type === "volume" && isAnonymousVolumeName(m.Name) ? (
                  <span className="text-sm truncate block" title={m.Name}>
                    {dockerVolumeLabel(m.Name ?? "").full}
                  </span>
                ) : (
                  <span className="text-sm font-mono truncate block" title={m.Source}>
                    {m.Source}
                  </span>
                )}
                <span
                  className="text-xs text-muted-foreground font-mono truncate block"
                  title={m.Destination}
                >
                  → {m.Destination}
                </span>
              </div>
              <Badge variant={m.RW ? "success" : "secondary"} className="shrink-0">
                {m.RW ? "RW" : "RO"}
              </Badge>
            </div>
          ))}
        </PanelShell>
      )}

      <WorkloadLinkRuntime
        nodeId={nodeId}
        targetType="container"
        targetResourceId={containerName}
        databaseLinks={databaseLinks}
        onHealthChange={onSecureLinkHealthChange}
      />

      {/* Recent Tasks */}
      {recentTasks.length > 0 && (
        <PanelShell
          title="Recent Activity"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {recentTasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm capitalize">{task.type}</span>
                {task.progress && (
                  <span className="text-sm text-muted-foreground">{task.progress}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    task.status === "succeeded"
                      ? "success"
                      : task.status === "failed"
                        ? "destructive"
                        : task.status === "running"
                          ? "warning"
                          : "secondary"
                  }
                >
                  {task.status}
                </Badge>
                {task.createdAt && (
                  <RelativeTime value={task.createdAt} className="text-sm text-muted-foreground" />
                )}
              </div>
            </div>
          ))}
        </PanelShell>
      )}
    </div>
  );
}
