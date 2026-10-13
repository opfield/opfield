import { ArrowRight, ClipboardCopy } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { AvailabilitySummary } from "@/components/docker/availability/AvailabilitySummary";
import { ImageReference } from "@/components/docker/ImageReference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { resolveDeploymentImageReference } from "@/lib/docker-image-ref";
import { deploymentImageOrigin, workloadImageLabel } from "@/lib/workload-image-label";
import { api } from "@/services/api";
import type { DockerDeployment, DockerDeploymentRelease, DockerDeploymentSlot } from "@/types";
import { copyToClipboard, type InspectData, STATUS_BADGE } from "../docker-detail/helpers";
import { WorkloadLinkRuntime } from "../docker-detail/LinkRuntimeTab";

export function statusVariant(
  status?: string
): "default" | "secondary" | "destructive" | "success" | "warning" {
  if (!status) return "secondary";
  if (STATUS_BADGE[status]) return STATUS_BADGE[status];
  if (status === "ready" || status === "healthy" || status === "succeeded") return "success";
  if (status === "failed" || status === "unhealthy" || status === "unavailable")
    return "destructive";
  if (
    status === "deploying" ||
    status === "draining" ||
    status === "pending" ||
    status === "starting" ||
    status === "stopping" ||
    status === "restarting" ||
    status === "killing" ||
    status === "removing" ||
    status === "switching" ||
    status === "rolling_back" ||
    status === "enabling" ||
    status === "scaling" ||
    status === "rolling_out" ||
    status === "disabling"
  )
    return "warning";
  return "secondary";
}

function shortId(value?: string | null) {
  return value ? value.slice(0, 12) : "-";
}

export function DeploymentOverview({
  deployment,
  active,
  serviceState,
  activeState,
  primaryRoute,
  sourceImageReference,
}: {
  deployment: DockerDeployment;
  active: DockerDeploymentSlot | null;
  serviceState: string;
  activeState: string;
  primaryRoute: DockerDeployment["routes"][number] | null;
  sourceImageReference?: string | null;
}) {
  const configuredImage = deployment.desiredConfig.image;
  const desiredImage = resolveDeploymentImageReference(
    configuredImage,
    configuredImage,
    sourceImageReference ?? active?.image
  );
  const activeImage = resolveDeploymentImageReference(
    active?.image,
    configuredImage,
    sourceImageReference
  );
  return (
    <div className="space-y-4 pb-6">
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: deployment.id }}
        runtimeState={serviceState}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PanelShell
          title="General"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Status"
            value={<Badge variant={statusVariant(serviceState)}>{serviceState}</Badge>}
          />
          <DetailRow
            label="Deployment ID"
            value={
              // Inline copy control inside the value text; a Button would change the row height.
              <button
                type="button"
                className="flex items-center gap-1.5 font-mono hover:text-primary cursor-pointer"
                onClick={() => copyToClipboard(deployment.id)}
              >
                {shortId(deployment.id)}
                <ClipboardCopy className="h-3 w-3" />
              </button>
            }
          />
          <DetailRow
            label="Desired Image"
            value={
              <ImageReference
                value={desiredImage}
                {...deploymentImageOrigin(deployment, desiredImage)}
              />
            }
          />
          <DetailRow
            label="Active Image"
            value={
              <ImageReference
                value={activeImage}
                {...deploymentImageOrigin(deployment, activeImage)}
              />
            }
          />
          <DetailRow label="Created" value={<RelativeTime value={deployment.createdAt} />} />
          <DetailRow label="Updated" value={<RelativeTime value={deployment.updatedAt} />} />
        </PanelShell>

        <PanelShell
          title="Active Slot"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Slot"
            value={<span className="capitalize">{deployment.activeSlot}</span>}
          />
          <DetailRow
            label="Health"
            value={
              <Badge variant={statusVariant(active?.health)}>{active?.health ?? "unknown"}</Badge>
            }
          />
          <DetailRow
            label="Status"
            value={
              <Badge variant={statusVariant(active?.status)}>{active?.status ?? "unknown"}</Badge>
            }
          />
          <DetailRow label="Runtime" value={activeState} />
        </PanelShell>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PanelShell
          title="Port Mappings"
          actions={
            <Badge variant="secondary" size="inline">
              {deployment.routes.length}
            </Badge>
          }
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          {deployment.routes.map((route) => (
            <DetailRow
              key={route.id}
              label={`0.0.0.0:${route.hostPort}`}
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono">tcp/{route.containerPort}</span>
                  {route.isPrimary && (
                    <Badge variant="secondary" size="inline">
                      Primary
                    </Badge>
                  )}
                </span>
              }
            />
          ))}
        </PanelShell>

        <PanelShell
          title="Health Check"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Path"
            value={<span className="font-mono">{deployment.healthConfig.path}</span>}
          />
          <DetailRow
            label="Status"
            value={
              <span className="font-mono">
                {deployment.healthConfig.statusMin}-{deployment.healthConfig.statusMax}
              </span>
            }
          />
          <DetailRow label="Interval" value={`${deployment.healthConfig.intervalSeconds}s`} />
          <DetailRow label="Timeout" value={`${deployment.healthConfig.timeoutSeconds}s`} />
          <DetailRow label="Drain" value={`${deployment.drainSeconds}s`} />
          <DetailRow
            label="Primary"
            value={
              <span className="font-mono">
                {primaryRoute ? `${primaryRoute.hostPort} -> ${primaryRoute.containerPort}` : "-"}
              </span>
            }
          />
        </PanelShell>
      </div>

      <WorkloadLinkRuntime
        nodeId={deployment.nodeId}
        targetType="deployment"
        targetResourceId={deployment.id}
      />
    </div>
  );
}

export function DeploymentSlots({
  deployment,
  nodeId,
  action,
  serviceBusy,
  runAction,
  canManage,
  activeSlotOverride,
  slotInspects,
  sourceImageReference,
}: {
  deployment: DockerDeployment;
  nodeId: string;
  action: string | null;
  serviceBusy: boolean;
  runAction: (name: string, fn: () => Promise<void>) => Promise<void>;
  canManage: boolean;
  activeSlotOverride?: "blue" | "green";
  slotInspects?: Partial<Record<"blue" | "green", InspectData>>;
  sourceImageReference?: string | null;
}) {
  const activeSlot = activeSlotOverride ?? deployment.activeSlot;
  const orderedSlots = (["blue", "green"] as const)
    .map((slotName) => deployment.slots.find((slot) => slot.slot === slotName))
    .filter((slot): slot is DockerDeploymentSlot => Boolean(slot));

  return (
    <div className="space-y-4 pb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {orderedSlots.map((slot) => {
          const inspect = slotInspects?.[slot.slot];
          const runtimeStatus = String(
            inspect?.State?.Status ?? (inspect?.State?.Running ? "running" : "")
          );
          const status = slot.status === "stopping" ? slot.status : runtimeStatus || slot.status;
          const runtimeHealth = String(inspect?.State?.Health?.Status ?? "");
          // Docker retains the last health result after a normal slot stop.
          // Only a settled standby is intentionally stopped; keep failures and
          // in-flight transitions visible rather than masking them as neutral.
          const stoppedStandby =
            slot.slot !== activeSlot &&
            ["exited", "stopped", "standby"].includes(status) &&
            !serviceBusy &&
            !action &&
            !deployment._transition &&
            !slot.drainingUntil &&
            slot.status !== "failed" &&
            !String(inspect?.State?.Error ?? "").trim();
          const health = stoppedStandby ? "stopped" : runtimeHealth || slot.health;
          const containerId = String(inspect?.Id ?? inspect?.ID ?? slot.containerId ?? "");
          const effectiveImage = resolveDeploymentImageReference(
            slot.image,
            deployment.desiredConfig.image,
            sourceImageReference,
            inspect
          );

          return (
            <PanelShell
              key={slot.slot}
              title={`${slot.slot[0].toUpperCase()}${slot.slot.slice(1)} slot`}
              className={slot.slot === activeSlot ? "border-foreground" : undefined}
              headerClassName="min-h-[4.25rem]"
              actions={
                canManage && slot.slot !== activeSlot ? (
                  <Button
                    pending={action === `switch-${slot.slot}`}
                    disabled={!!action || serviceBusy || !containerId}
                    onClick={() =>
                      runAction(`switch-${slot.slot}`, async () => {
                        await api.switchDockerDeployment(nodeId, deployment.id, slot.slot);
                        toast.success("Switched active slot");
                      })
                    }
                  >
                    Switch
                  </Button>
                ) : null
              }
            >
              <div className="divide-y divide-border -mb-px">
                <DetailRow
                  label="Role"
                  value={
                    <div className="flex justify-end gap-2">
                      {slot.slot === activeSlot && <Badge>Active</Badge>}
                      {status === "draining" && <Badge variant="warning">Draining</Badge>}
                      {slot.slot !== activeSlot && status !== "draining" && (
                        <Badge variant="secondary">Standby</Badge>
                      )}
                    </div>
                  }
                />
                <DetailRow
                  label="Status"
                  value={<Badge variant={statusVariant(status)}>{status}</Badge>}
                />
                <DetailRow
                  label="Health"
                  value={<Badge variant={statusVariant(health)}>{health}</Badge>}
                />
                <div
                  className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-4 border-b border-border px-4 py-3 md:grid-cols-[8rem_minmax(0,1fr)]"
                  style={
                    slot.slot === activeSlot
                      ? { borderBottomColor: "var(--color-foreground)" }
                      : undefined
                  }
                >
                  <span className="pt-0.5 text-sm text-muted-foreground">Image</span>
                  <span className="min-w-0 max-w-full justify-self-end text-right text-sm">
                    <ImageReference
                      value={effectiveImage}
                      {...deploymentImageOrigin(deployment, effectiveImage)}
                    />
                  </span>
                </div>
              </div>
            </PanelShell>
          );
        })}
      </div>

      <PanelShell
        title="Recent Activity"
        actions={
          <Badge variant="secondary" size="inline">
            {deployment.releases.length}
          </Badge>
        }
        bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
      >
        {deployment.releases.map((release) => (
          <ReleaseRow key={release.id} release={release} />
        ))}
      </PanelShell>
    </div>
  );
}

function ReleaseRow({ release }: { release: DockerDeploymentRelease }) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm capitalize">{release.triggerSource}</span>
          <span className="inline-flex min-w-0 items-center text-sm text-muted-foreground">
            {release.fromSlot ?? "-"}
            <ArrowRight className="mx-1.5 h-3.5 w-3.5 shrink-0" />
            {release.toSlot ?? "-"}
          </span>
        </div>
        <p
          className="text-xs text-muted-foreground font-mono truncate"
          title={workloadImageLabel(release).title}
        >
          {workloadImageLabel(release).kind === "none" ? "-" : workloadImageLabel(release).text}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
        <Badge variant={statusVariant(release.status)} size="inline">
          {release.status}
        </Badge>
        <RelativeTime
          value={release.createdAt}
          className="text-sm text-muted-foreground tabular-nums"
        />
      </div>
    </div>
  );
}

export function DeploymentConfig({
  deployment,
  editorHeight,
}: {
  deployment: DockerDeployment;
  editorHeight?: string;
}) {
  const jsonText = useMemo(
    () =>
      JSON.stringify(
        {
          id: deployment.id,
          name: deployment.name,
          status: deployment.status,
          activeSlot: deployment.activeSlot,
          desiredConfig: deployment.desiredConfig,
          routes: deployment.routes,
          healthConfig: deployment.healthConfig,
          drainSeconds: deployment.drainSeconds,
          routerName: deployment.routerName,
          routerImage: deployment.routerImage,
          networkName: deployment.networkName,
          slots: deployment.slots.map((slot) => ({
            slot: slot.slot,
            image: slot.image,
            status: slot.status,
            health: slot.health,
            drainingUntil: slot.drainingUntil,
            updatedAt: slot.updatedAt,
          })),
        },
        null,
        2
      ),
    [deployment]
  );

  return (
    <PanelShell
      title="Deployment Config"
      description="Service-level configuration"
      className="flex flex-1 flex-col min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <Button
          variant="ghost"
          size="icon"
          onClick={() => copyToClipboard(jsonText)}
          title="Copy JSON"
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <CodeEditor
        value={jsonText}
        onChange={() => {}}
        readOnly
        language="json"
        height={editorHeight}
        bordered={false}
      />
    </PanelShell>
  );
}
