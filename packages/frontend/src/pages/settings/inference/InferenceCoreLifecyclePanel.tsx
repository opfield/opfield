import { ArrowRight, Cpu, Download, ExternalLink, RefreshCw, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { InferenceCoreOperationPhase, InferenceCoreStatus } from "@/types/inference-core";

const PHASE_LABELS: Record<InferenceCoreOperationPhase, string> = {
  resolving: "Resolving release",
  pulling: "Downloading image",
  installing: "Installing",
  starting: "Starting",
  updating: "Updating",
  rolling_back: "Rolling back",
};

/** Provider/model setup may proceed only when the core is ready and compatible. */
export function isInferenceCoreReady(status: InferenceCoreStatus | null): boolean {
  if (!status) return false;
  return (
    (status.state === "ready" || status.state === "update_available") &&
    status.compatibility === "compatible"
  );
}

const ACTIVE_STATE_LABELS: Partial<Record<InferenceCoreStatus["state"], string>> = {
  resolving: "Resolving release",
  pulling: "Downloading image",
  installing: "Installing",
  starting: "Checking readiness",
  updating: "Updating",
  rolling_back: "Rolling back",
};

/** User-actionable explanation shown in place of provider/model controls. */
export function inferenceCoreBlockedReason(status: InferenceCoreStatus | null): string | null {
  if (!status) return null;
  if (isInferenceCoreReady(status)) return null;
  switch (status.state) {
    case "not_installed":
      return "Install the inference core above before configuring providers and models.";
    case "degraded":
    case "failed":
      return "Repair the inference core above before configuring providers and models.";
    default:
      if (status.compatibility === "update_required") {
        return "Update the inference core to a compatible version before configuring providers and models.";
      }
      return "Providers and models become available when the current inference core operation finishes.";
  }
}

function stateBadge(status: InferenceCoreStatus) {
  const className = "shrink-0 whitespace-nowrap";
  if (status.installed && status.compatibility === "update_required") {
    return (
      <Badge variant="warning" size="inline" className={className}>
        Update required
      </Badge>
    );
  }
  switch (status.state) {
    case "not_installed":
      return (
        <Badge variant="secondary" size="inline" className={className}>
          Not installed
        </Badge>
      );
    case "resolving":
      return (
        <Badge variant="info" size="inline" className={className}>
          Resolving release
        </Badge>
      );
    case "pulling":
      return (
        <Badge variant="info" size="inline" className={className}>
          Downloading image
        </Badge>
      );
    case "installing":
      return (
        <Badge variant="info" size="inline" className={className}>
          Installing
        </Badge>
      );
    case "starting":
      return (
        <Badge variant="info" size="inline" className={className}>
          Starting
        </Badge>
      );
    case "ready":
      return (
        <Badge variant="success" size="inline" className={className}>
          Running
        </Badge>
      );
    case "update_available":
      return (
        <Badge variant="warning" size="inline" className={className}>
          Update available
        </Badge>
      );
    case "updating":
      return (
        <Badge variant="info" size="inline" className={className}>
          Updating
        </Badge>
      );
    case "rolling_back":
      return (
        <Badge variant="warning" size="inline" className={className}>
          Rolling back
        </Badge>
      );
    case "degraded":
      return (
        <Badge variant="warning" size="inline" className={className}>
          Degraded
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" size="inline" className={className}>
          Failed
        </Badge>
      );
  }
}

function healthBadge(health: InferenceCoreStatus["health"]) {
  switch (health.status) {
    case "healthy":
      return <Badge variant="success">Healthy</Badge>;
    case "unhealthy":
      return <Badge variant="destructive">Unhealthy</Badge>;
    default:
      return <Badge variant="secondary">Unknown</Badge>;
  }
}

function requestLimitsStatus(capability: InferenceCoreStatus["health"]["requestLimitsCapability"]) {
  switch (capability) {
    case "negotiated-v1":
      return <Badge variant="success">Supported</Badge>;
    case "legacy":
      return (
        <span className="text-warning-text">Opfield request limits require a core update</span>
      );
    default:
      return <span className="text-warning-text">Opfield request limits are unverified</span>;
  }
}

function OperationProgress({ status }: { status: InferenceCoreStatus }) {
  const operation = status.operation;
  if (!operation) return null;
  const progress = operation.progress;
  const stage = progress?.stage ?? PHASE_LABELS[operation.phase];
  const hasBytes =
    progress?.downloadedBytes != null && progress?.totalBytes != null && progress.totalBytes > 0;
  const percent = hasBytes
    ? Math.round(((progress.downloadedBytes ?? 0) / (progress.totalBytes ?? 1)) * 100)
    : null;
  const hasLayers = progress?.layersCompleted != null && progress?.layersTotal != null;

  return (
    <div aria-live="polite" className="space-y-1 px-4 py-3">
      <p className="text-sm font-medium">{stage}</p>
      {percent !== null ? (
        <>
          <ProgressBar
            value={percent}
            role="progressbar"
            aria-label={`Inference core ${operation.kind} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          />
          <p className="text-xs text-muted-foreground">
            {percent}% · {formatBytes(progress!.downloadedBytes!)} of{" "}
            {formatBytes(progress!.totalBytes!)}
            {hasLayers ? ` · ${progress!.layersCompleted} of ${progress!.layersTotal} layers` : ""}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {hasLayers
            ? `${progress!.layersCompleted} of ${progress!.layersTotal} layers`
            : "In progress. Download details appear when they are available."}
        </p>
      )}
    </div>
  );
}

/** Primary lifecycle action rendered by the setup dialog footer. */
export function InferenceCoreSetupFooterAction({
  status,
  loading = false,
  canManage,
  onRefresh,
  onContinue,
}: {
  status: InferenceCoreStatus | null;
  loading?: boolean;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onContinue?: () => void;
}) {
  const [acting, setActing] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setActing(true);
    try {
      await action();
      await onRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Inference core action failed");
    } finally {
      setActing(false);
    }
  };

  // The status request runs in place here: the setup dialog is already open
  // when Inference is enabled from it.
  if (loading && !status) return <Button pending>Loading core status</Button>;

  if (!status) {
    return canManage ? (
      <Button onClick={() => void run(async () => {})} pending={acting}>
        <RefreshCw /> Retry status
      </Button>
    ) : null;
  }

  const operationActive = status.operation?.status === "running";
  const activeLabel =
    (operationActive
      ? (status.operation?.progress?.stage ??
        (status.operation ? PHASE_LABELS[status.operation.phase] : undefined))
      : undefined) ?? ACTIVE_STATE_LABELS[status.state];
  if (operationActive || activeLabel) return <Button pending>{activeLabel ?? "Working"}</Button>;

  if (isInferenceCoreReady(status) && onContinue) {
    return (
      <Button onClick={onContinue} disabled={acting}>
        <ArrowRight /> Continue to providers
      </Button>
    );
  }

  if (!canManage) return null;

  if (status.state === "not_installed") {
    return (
      <Button onClick={() => void run(() => api.installInferenceCore())} pending={acting}>
        <Download /> Install inference core
      </Button>
    );
  }

  if (status.state === "failed" || status.state === "degraded") {
    const installed = status.installed !== null;
    return (
      <Button
        onClick={() =>
          void run(() => (installed ? api.repairInferenceCore() : api.installInferenceCore()))
        }
        pending={acting}
      >
        <Wrench />
        {installed ? "Repair" : "Retry install"}
      </Button>
    );
  }

  if (status.compatibility === "update_required") {
    return (
      <Button
        onClick={() =>
          void run(async () => {
            const target =
              (await api.checkInferenceCoreUpdates()).latest?.version ?? status.latest?.version;
            if (!target) throw new Error("No compatible inference core release is available");
            return api.updateInferenceCore(target);
          })
        }
        pending={acting}
      >
        <Download /> Update inference core
      </Button>
    );
  }

  return null;
}

export function InferenceCoreLifecyclePanel({
  mode,
  status,
  loading = false,
  error = null,
  canManage,
  onRefresh,
}: {
  mode: "setup" | "settings";
  status: InferenceCoreStatus | null;
  loading?: boolean;
  error?: string | null;
  canManage: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [acting, setActing] = useState<string | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const initialLoading = loading && !status;
  useContentLoading(initialLoading);

  if (initialLoading) return null;

  if (!status) {
    const retry = async () => {
      setActing("retry");
      try {
        await onRefresh();
      } finally {
        setActing(null);
      }
    };
    return (
      <PanelShell
        icon={<Cpu className="h-4 w-4" />}
        title="Inference core"
        description="The inference core status could not be loaded."
        actions={
          mode === "settings" ? (
            <Button variant="outline" onClick={() => void retry()} pending={acting === "retry"}>
              <RefreshCw /> Retry
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <p className="px-4 py-3 text-sm text-destructive break-words [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
      </PanelShell>
    );
  }

  const operationActive = status.operation?.status === "running";
  const incompatible = status.installed !== null && status.compatibility === "update_required";
  const updateAvailable = status.state === "update_available" || incompatible;
  const failed = status.state === "failed" || status.state === "degraded";

  const run = async (key: string, action: () => Promise<unknown>) => {
    setActing(key);
    try {
      await action();
      await onRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Inference core action failed");
    } finally {
      setActing(null);
    }
  };

  const install = () => run("install", () => api.installInferenceCore());

  const update = async () => {
    // The release found earlier may have been superseded; update straight to the newest one.
    let version: string | null;
    setActing("check");
    try {
      const result = await api.checkInferenceCoreUpdates();
      version = result.latest?.version ?? status.latest?.version ?? null;
      await onRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to check for updates");
      return;
    } finally {
      setActing(null);
    }
    if (!version) {
      toast.info("No newer inference core release is available");
      return;
    }
    const target = version;
    const confirmed = await confirm({
      title: "Update Inference Core",
      description: `Update the inference core from ${status.installed?.version ?? "the current version"} to ${target}? Inference is briefly interrupted during the update. If the update fails, Opfield automatically restores the previous version.`,
      confirmLabel: "Update",
    });
    if (!confirmed) return;
    await run("update", () => api.updateInferenceCore(target));
  };

  const repair = () => run("repair", () => api.repairInferenceCore());

  const checkUpdates = async () => {
    setActing("check");
    try {
      const result = await api.checkInferenceCoreUpdates();
      await onRefresh();
      if (result.latest && result.latest.version !== status.installed?.version) {
        toast.info(`Inference core ${result.latest.version} is available`);
      } else {
        toast.success("Inference core is up to date");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to check for updates");
    } finally {
      setActing(null);
    }
  };

  // A button whose action runs shows the spinner from `pending` instead of its icon.
  const actionIcon = (key: string, icon: ReactNode) => (acting === key ? null : icon);

  const actions =
    mode === "settings" && canManage ? (
      <>
        {status.state === "not_installed" && (
          <Button
            onClick={() => void install()}
            disabled={operationActive || acting !== null}
            pending={acting === "install"}
          >
            {actionIcon("install", <Download />)} Install inference core
          </Button>
        )}
        {(status.state === "update_available" || incompatible) && (
          <>
            {status.latest?.releaseNotesUrl && (
              <Button variant="outline" onClick={() => setReleaseNotesOpen(true)}>
                <ExternalLink /> Release notes
              </Button>
            )}
            <Button
              onClick={() => void update()}
              disabled={operationActive || acting !== null}
              pending={acting === "update" || acting === "check"}
            >
              <Download />
              {status.latest ? ` Update to ${status.latest.version}` : " Update inference core"}
            </Button>
          </>
        )}
        {failed && !operationActive && (
          <Button
            onClick={() => void (status.installed ? repair() : install())}
            disabled={acting !== null}
            pending={acting === "repair" || acting === "install"}
          >
            <Wrench /> {status.installed ? "Repair" : "Retry install"}
          </Button>
        )}
        {(status.state === "ready" || status.state === "update_available" || incompatible) && (
          <Button
            variant="outline"
            onClick={() => void checkUpdates()}
            disabled={operationActive || acting !== null}
            pending={acting === "check"}
          >
            {actionIcon("check", <RefreshCw />)} Check for updates
          </Button>
        )}
      </>
    ) : null;

  return (
    <>
      <PanelShell
        icon={<Cpu className="h-4 w-4" />}
        aria-label="Inference core status"
        className={
          status.state === "updating"
            ? "border-link"
            : updateAvailable
              ? "border-warning"
              : undefined
        }
        title={
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            Inference core {stateBadge(status)}
          </span>
        }
        description={
          status.state === "not_installed"
            ? "The inference core is downloaded and run privately on this Opfield host. Opfield Inference routes provider traffic through it once installed."
            : "The managed runtime that runs Opfield Inference privately on this Opfield host."
        }
        actions={actions}
        wrapHeader
      >
        <div className="divide-y divide-border">
          {operationActive && status.operation ? <OperationProgress status={status} /> : null}

          {status.state === "not_installed" && (
            <>
              <DetailRow label="Available" value={status.latest?.version ?? "Unknown"} />
              <DetailRow
                label="Download size"
                value={status.latest ? formatBytes(status.latest.sizeBytes) : "Unknown"}
              />
            </>
          )}

          {status.installed && status.state !== "not_installed" && (
            <>
              <DetailRow label="Version" value={status.installed.version} />
              <DetailRow label="Health" value={healthBadge(status.health)} />
              <DetailRow
                label="Request limits"
                value={requestLimitsStatus(status.health.requestLimitsCapability)}
              />
              <DetailRow
                label="Last check"
                value={<RelativeTime value={status.health.checkedAt} fallback="Never" />}
              />
            </>
          )}

          {status.state === "update_available" && status.latest && (
            <DetailRow
              label="Update"
              value={
                <span className="text-warning-text">
                  {status.installed?.version ?? "current"} → {status.latest.version}
                </span>
              }
            />
          )}

          {incompatible && (
            <DetailRow
              label="Required"
              value={status.latest?.version ?? "A newer inference core release"}
            />
          )}

          {status.lastError && (failed || status.state === "ready") && (
            <div aria-live="polite" className="px-4 py-3">
              <p
                className={`text-sm break-words [overflow-wrap:anywhere] max-h-32 overflow-y-auto ${
                  failed ? "text-destructive" : "text-warning-text"
                }`}
              >
                {status.lastError}
              </p>
              {!failed && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The previously installed version remains active.
                </p>
              )}
            </div>
          )}
        </div>
      </PanelShell>

      {status.latest?.releaseNotesUrl && (
        <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Release Notes</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
              Release notes for inference core {status.latest.version} are published at{" "}
              <a
                href={status.latest.releaseNotesUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[color:var(--color-link)] hover:underline"
              >
                {status.latest.releaseNotesUrl}
              </a>
            </p>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
