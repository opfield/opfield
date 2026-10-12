import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DockerAvailabilityPolicy, DockerAvailabilityResource } from "@/types";
import { AvailabilityLeaseSummaryRows } from "./AvailabilityLeaseSummaryRows";
import { AvailabilityOperationsPanel } from "./AvailabilityOperationsPanel";
import { AvailabilityPrioritySummaryRows } from "./AvailabilityPrioritySummaryRows";
import { resolveAvailabilitySurfaceStatus } from "./availability-status";
import { useStableAvailabilityResource } from "./use-stable-availability-resource";

function label(value: string) {
  if (value === "single") return "Single node";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function variant(status: string) {
  if (["online", "healthy", "serving", "ready", "completed", "single"].includes(status))
    return "success" as const;
  if (["offline", "failed", "unavailable", "unhealthy"].includes(status))
    return "destructive" as const;
  if (
    [
      "degraded",
      "enabling",
      "scaling",
      "rolling_out",
      "starting",
      "stopping",
      "restarting",
      "disabling",
      "waiting",
      "draining",
      "unreachable",
    ].includes(status)
  )
    return "warning" as const;
  return "secondary" as const;
}

function StatusBadge({ status, error }: { status: string; error?: string | null }) {
  const badge = (
    <Badge
      size="inline"
      variant={variant(status)}
      tabIndex={error ? 0 : undefined}
      aria-label={error ? `${label(status)}: ${error}` : undefined}
    >
      {label(status)}
    </Badge>
  );
  if (!error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm break-words">
        {error}
      </TooltipContent>
    </Tooltip>
  );
}

export function AvailabilitySummary({
  resource,
  policy: controlledPolicy,
  loading: controlledLoading,
  runtimeState,
}: {
  resource: DockerAvailabilityResource;
  policy?: DockerAvailabilityPolicy | null;
  loading?: boolean;
  runtimeState?: string;
}) {
  const controlled = controlledPolicy !== undefined;
  const [localPolicy, setLocalPolicy] = useState<DockerAvailabilityPolicy | null>(null);
  const [localLoading, setLocalLoading] = useState(true);
  const policy = controlled ? controlledPolicy : localPolicy;
  const loading = controlled ? Boolean(controlledLoading) : localLoading;
  const stableResource = useStableAvailabilityResource(resource);

  const load = useCallback(() => {
    if (controlled) return;
    void api
      .getDockerAvailability(stableResource)
      .then(setLocalPolicy)
      .catch((error) => {
        setLocalPolicy(null);
        toastApiError(error, "Failed to load Availability");
      })
      .finally(() => setLocalLoading(false));
  }, [controlled, stableResource]);

  useEffect(load, [load]);
  useRealtime("docker.availability.changed", load);
  useRealtime("docker.availability.operation.changed", load);

  useContentLoading(loading);
  if (loading) return null;
  const mode = policy?.mode ?? "single";
  // Single-node lifecycle actions do not update the HA policy's desired state.
  const stopped =
    mode === "single" && runtimeState !== undefined
      ? ["stopped", "exited", "created", "dead"].includes(runtimeState)
      : Boolean(policy && !policy.shouldRun);
  const placements =
    policy?.placements.filter((placement) => placement.actualState !== "removed") ?? [];
  const serving = placements.filter((placement) => placement.serving).length;
  const desired = mode === "replicated" ? (policy?.desiredReplicaCount ?? 1) : 1;
  const unhealthy = placements.filter(
    (placement) =>
      placement.actualState === "unreachable" || placement.applicationHealth === "unhealthy"
  ).length;
  const displayStatus =
    policy && mode !== "single"
      ? resolveAvailabilitySurfaceStatus({
          policyStatus: policy.status,
          operation: policy.latestOperation,
          shouldRun: policy.shouldRun,
          serving,
          desired,
        })
      : stopped
        ? "stopped"
        : (policy?.status ?? "single");
  const currentOperation =
    policy?.latestOperation &&
    ["pending", "running", "waiting", "cleanup_pending"].includes(policy.latestOperation.status)
      ? policy.latestOperation
      : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        <PanelShell
          title={
            <span className="inline-flex flex-wrap items-center gap-2" aria-label="Availability">
              <span>Availability</span>
              <StatusBadge status={displayStatus} error={policy?.lastErrorMessage} />
            </span>
          }
          icon={<ShieldCheck className="h-4 w-4" />}
          description="Logical workload state across independent Docker nodes. Replicas are judged by their container state and Docker health check, and by the HTTP health checks of their Routes and deployment."
          // Two columns filled row by row on wide screens: the row count depends on the mode and
          // the lease state, so rows pair up instead of splitting into two uneven lists. The
          // last row's bottom border slides under the panel edge.
          bodyClassName="-mb-px grid grid-cols-1 xl:grid-cols-2 [&>*]:border-b [&>*]:border-border xl:[&>*:nth-child(even)]:border-l"
        >
          <DetailRow label="Mode" value={label(mode)} />
          <DetailRow
            label="Serving"
            value={stopped ? "Stopped" : `${serving || (mode === "single" ? 1 : 0)}/${desired}`}
          />
          {policy && !stopped ? <AvailabilityPrioritySummaryRows policy={policy} /> : null}
          {policy && !stopped ? <AvailabilityLeaseSummaryRows policy={policy} /> : null}
          <DetailRow
            label="Placement health"
            value={stopped ? "Stopped" : unhealthy > 0 ? `${unhealthy} need attention` : "Healthy"}
          />
          <DetailRow
            label="Current operation"
            value={
              currentOperation
                ? `${label(currentOperation.type)} · ${label(currentOperation.phase)}`
                : "—"
            }
          />
        </PanelShell>
        {policy && policy.mode !== "single" ? (
          <AvailabilityOperationsPanel
            policyId={policy.id}
            desiredGeneration={policy.desiredGeneration}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
