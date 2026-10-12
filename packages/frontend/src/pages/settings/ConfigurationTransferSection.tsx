import { ArchiveRestore, Download, Route } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SimpleTable } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/progress-bar";
import { toastApiError } from "@/lib/api-error-toast";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  ConfigurationExportEstimate,
  ConfigurationExportProgress,
  ConfigurationExportSection,
  GatewayMoveNodeState,
  GatewayMoveStatus,
} from "@/services/api-configuration-transfer";
import {
  DEFAULT_GRPC_PORT,
  EXPORT_PASSPHRASE_MIN_LENGTH,
  estimatedExportBytes,
  exportPassphraseProblem,
  exportProgressPercent,
  MOVE_NODE_STATE_LABELS,
  normalizeMoveAddress,
} from "./configuration-transfer-model";

const PROGRESS_POLL_MS = 1_000;
const MOVE_POLL_MS = 5_000;

function sectionSize(section: ConfigurationExportSection): string {
  if (!section.available) return section.reason ?? "Not available";
  return section.bytes === null ? "Unknown size" : formatBytes(section.bytes);
}

function optionLabel(name: string, section: ConfigurationExportSection): string {
  return section.available && section.bytes !== null
    ? `${name} (${formatBytes(section.bytes)})`
    : name;
}

/** Starts the browser's own download of a one-time link without leaving the page. */
function startNativeDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  link.download = "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function ExportProgressView({ progress }: { progress: ConfigurationExportProgress }) {
  const percent = exportProgressPercent(progress);
  if (progress.state === "failed") {
    return (
      <Notice tone="destructive" title="The export failed">
        {progress.error ?? "The download stopped before the export was complete."}
      </Notice>
    );
  }
  if (progress.state === "completed") {
    return (
      <Notice tone="success" title="Export downloaded">
        {progress.filename} ({formatBytes(progress.bytesWritten)}). Keep it with its passphrase in a
        safe place.
      </Notice>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">
          {progress.state === "ready"
            ? "Waiting for the download to start"
            : progress.currentPart
              ? `Exporting ${progress.currentPart}`
              : "Exporting"}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {formatBytes(progress.bytesWritten)}
          {progress.estimatedBytes ? ` of about ${formatBytes(progress.estimatedBytes)}` : ""}
        </span>
      </div>
      <ProgressBar value={percent} aria-label="Export progress" />
    </div>
  );
}

function ExportDialog({
  open,
  estimate,
  progress,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  estimate: ConfigurationExportEstimate;
  progress: ConfigurationExportProgress | null;
  onOpenChange: (open: boolean) => void;
  onStarted: (progress: ConfigurationExportProgress) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeRegistry, setIncludeRegistry] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [starting, setStarting] = useState(false);
  const { registry, logs } = estimate.sections;
  const problem = exportPassphraseProblem(passphrase, confirmation);
  const estimatedBytes = estimatedExportBytes(estimate, { includeRegistry, includeLogs });

  // Each opening starts from an empty form; the passphrase never outlives the dialog.
  useEffect(() => {
    if (!open) return;
    setPassphrase("");
    setConfirmation("");
    setIncludeRegistry(false);
    setIncludeLogs(false);
  }, [open]);

  const handleExport = async () => {
    if (problem) return;
    setStarting(true);
    try {
      const result = await api.startConfigurationExport({
        passphrase,
        includeRegistry: includeRegistry && registry.available,
        includeLogs: includeLogs && logs.available,
      });
      setPassphrase("");
      setConfirmation("");
      onStarted(result.export);
      startNativeDownload(result.downloadUrl);
    } catch (error) {
      toastApiError(error, "Failed to start the export");
    } finally {
      setStarting(false);
    }
  };

  const running = progress?.state === "ready" || progress?.state === "running";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export configuration</DialogTitle>
        </DialogHeader>
        {progress ? (
          <div className="space-y-3">
            <ExportProgressView progress={progress} />
            {running ? (
              <p className="text-sm text-muted-foreground">
                The file downloads in your browser. Keep this page open until it finishes; you can
                close this dialog.
              </p>
            ) : null}
          </div>
        ) : (
          <form
            id="configuration-export-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleExport();
            }}
          >
            <p className="text-sm text-muted-foreground">
              The export holds the database, keys, certificates and files of this installation.
              Restore it in the setup of a fresh Opfield on the new host. Nothing stops while it
              runs.
            </p>
            <PanelShell title="Size" bodyClassName="divide-y divide-border">
              <DetailRow label="Database" value={sectionSize(estimate.sections.database)} />
              <DetailRow label="Files" value={sectionSize(estimate.sections.files)} />
              <DetailRow label="Registry images" value={sectionSize(registry)} />
              <DetailRow label="Logs" value={sectionSize(logs)} />
            </PanelShell>
            <div className="space-y-1.5">
              <label htmlFor="configuration-export-passphrase" className="text-sm font-medium">
                Passphrase
              </label>
              <Input
                id="configuration-export-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                placeholder={`At least ${EXPORT_PASSPHRASE_MIN_LENGTH} characters`}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="configuration-export-confirm" className="text-sm font-medium">
                Repeat passphrase
              </label>
              <Input
                id="configuration-export-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              {passphrase && confirmation && problem ? (
                <p className="text-xs text-destructive">{problem}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <CheckboxCard
                checked={includeRegistry && registry.available}
                disabled={!registry.available}
                onCheckedChange={setIncludeRegistry}
                label={optionLabel("Internal registry images", registry)}
                description={
                  registry.available
                    ? "Images pushed to the Opfield registry."
                    : (registry.reason ?? "Not available")
                }
              />
              <CheckboxCard
                checked={includeLogs && logs.available}
                disabled={!logs.available}
                onCheckedChange={setIncludeLogs}
                label={optionLabel("Logs", logs)}
                description={
                  logs.available
                    ? "Structured logs kept by Opfield."
                    : (logs.reason ?? "Not available")
                }
              />
            </div>
            {estimatedBytes !== null ? (
              <p className="text-sm text-muted-foreground">
                About {formatBytes(estimatedBytes)} before compression.
              </p>
            ) : null}
            {estimate.hostSpecific.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Not carried over</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {estimate.hostSpecific.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Notice tone="warning" title="The file opens every secret">
              Anyone with the file and its passphrase gets all keys, passwords and tokens of this
              installation. Store them apart.
            </Notice>
          </form>
        )}
        <DialogFooter>
          {progress ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="configuration-export-form"
                pending={starting}
                disabled={Boolean(problem)}
              >
                <Download className="h-4 w-4" />
                Export
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOVE_COLUMNS = [
  {
    id: "name",
    header: "Node",
    render: (node: GatewayMoveNodeState) => <span className="font-medium">{node.name}</span>,
  },
  {
    id: "type",
    header: "Type",
    render: (node: GatewayMoveNodeState) => (
      <span className="text-muted-foreground">{node.type}</span>
    ),
  },
  {
    id: "state",
    header: "State",
    align: "right" as const,
    render: (node: GatewayMoveNodeState) => {
      const state = MOVE_NODE_STATE_LABELS[node.state] ?? MOVE_NODE_STATE_LABELS.pending;
      return (
        <Badge variant={state.variant} title={node.error}>
          {state.label}
        </Badge>
      );
    },
  },
];

function MoveDialog({
  open,
  status,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  status: GatewayMoveStatus;
  onOpenChange: (open: boolean) => void;
  onSaved: (status: GatewayMoveStatus) => void;
}) {
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const normalized = normalizeMoveAddress(address);
  const sameAsCurrent =
    normalized !== null &&
    status.currentAddress !== null &&
    normalizeMoveAddress(status.currentAddress) === normalized;

  useEffect(() => {
    if (open) setAddress(status.announcement?.address ?? "");
  }, [open, status.announcement?.address]);

  const handleSave = async () => {
    if (!normalized || sameAsCurrent) return;
    setSaving(true);
    try {
      const next = await api.setGatewayMoveAddress(normalized);
      onSaved(next);
      const notTold = next.nodes.filter((node) => node.state !== "told").length;
      if (notTold > 0) {
        toast.warning(
          `Address announced. ${notTold} node${notTold === 1 ? " was" : "s were"} not told yet.`
        );
      } else {
        toast.success("Address announced to all nodes");
      }
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to announce the address");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move nodes to a new address</DialogTitle>
        </DialogHeader>
        <form
          id="gateway-move-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <p className="text-sm text-muted-foreground">
            Nodes and relays keep this address next to the current one. They switch to it only after
            this installation stays unreachable for 10 minutes and the restored one answers there
            with the same System CA. Until then nothing changes.
          </p>
          <PanelShell title="Address" bodyClassName="divide-y divide-border">
            <DetailRow
              label="Current address"
              value={<span className="font-mono">{status.currentAddress ?? "Not set"}</span>}
            />
            <DetailRow
              label="Announced"
              value={
                status.announcement ? (
                  <span className="flex flex-wrap items-center justify-end gap-x-2">
                    <span className="font-mono">{status.announcement.address}</span>
                    <span className="text-muted-foreground">
                      <RelativeTime value={status.announcement.announcedAt} />
                    </span>
                  </span>
                ) : (
                  "None"
                )
              }
            />
          </PanelShell>
          <PanelShell title="Nodes" bodyClassName="min-w-0">
            <SimpleTable
              columns={MOVE_COLUMNS}
              rows={status.nodes}
              getRowKey={(node) => node.nodeId}
              emptyMessage="No enrolled nodes"
            />
          </PanelShell>
          <div className="space-y-1.5">
            <label htmlFor="gateway-move-address" className="text-sm font-medium">
              New gRPC address
            </label>
            <Input
              id="gateway-move-address"
              value={address}
              placeholder={`opfield-new.example.com:${DEFAULT_GRPC_PORT}`}
              className="font-mono"
              onChange={(event) => setAddress(event.target.value)}
            />
            {address.trim() && !normalized ? (
              <p className="text-xs text-destructive">Enter a hostname or IP address with a port</p>
            ) : sameAsCurrent ? (
              <p className="text-xs text-destructive">This is the current address</p>
            ) : normalized && normalized !== address.trim() ? (
              <p className="text-xs text-muted-foreground">Nodes get {normalized}</p>
            ) : null}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="gateway-move-form"
            pending={saving}
            disabled={!normalized || sameAsCurrent}
          >
            Announce
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfigurationTransferSection() {
  const [estimate, setEstimate] = useState<ConfigurationExportEstimate | null>(null);
  const [move, setMove] = useState<GatewayMoveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [progress, setProgress] = useState<ConfigurationExportProgress | null>(null);

  const loadMove = useCallback(async (quiet = false) => {
    try {
      setMove(await api.getGatewayMoveStatus());
    } catch (error) {
      if (!quiet) toastApiError(error, "Failed to load nodes");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.getConfigurationExportEstimate(), api.getGatewayMoveStatus()])
      .then(([nextEstimate, nextMove]) => {
        if (!active) return;
        if (nextEstimate.status === "fulfilled") setEstimate(nextEstimate.value);
        else toast.error("Failed to load the export sizes");
        if (nextMove.status === "fulfilled") setMove(nextMove.value);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Nodes are told while they connect: follow them while an address is announced.
  const announced = Boolean(move?.announcement);
  useEffect(() => {
    if (!announced) return;
    const timer = window.setInterval(() => void loadMove(true), MOVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [announced, loadMove]);

  const exportId = progress?.id;
  const exportActive = progress?.state === "ready" || progress?.state === "running";
  useEffect(() => {
    if (!exportId || !exportActive) return;
    const timer = window.setInterval(() => {
      void api
        .getConfigurationExportProgress(exportId)
        .then(setProgress)
        .catch(() => {});
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [exportActive, exportId]);

  const openExport = () => {
    // A finished export is shown once; the next opening starts a new one.
    if (progress && !exportActive) setProgress(null);
    setExportOpen(true);
  };

  const withdraw = () =>
    void confirmAction(
      {
        title: "Withdraw the new address",
        description:
          "Nodes forget the announced address and stay with the current one. Withdraw it if the move is off.",
        confirmLabel: "Withdraw",
        variant: "destructive",
      },
      async () => {
        try {
          setMove(await api.setGatewayMoveAddress(null));
          toast.success("Address withdrawn");
          return true;
        } catch (error) {
          toastApiError(error, "Failed to withdraw the address");
          return false;
        }
      }
    );

  useContentLoading(loading);
  if (loading) return null;

  return (
    <>
      {estimate ? (
        <PanelShell
          icon={<ArchiveRestore className="h-4 w-4" />}
          title="Configuration export"
          description="Move this installation to another host"
          actions={
            <Button onClick={openExport} disabled={!estimate.available && !progress}>
              <Download className="h-4 w-4" />
              Export configuration
            </Button>
          }
          bodyClassName="divide-y divide-border"
        >
          {!estimate.available || (progress && !exportOpen) ? (
            <>
              {!estimate.available ? (
                <div className="p-4">
                  <Notice tone="warning" title="Export is not available here">
                    {estimate.unavailableReason ?? "This installation cannot be exported."}
                  </Notice>
                </div>
              ) : null}
              {progress && !exportOpen ? (
                <div className="p-4">
                  <ExportProgressView progress={progress} />
                </div>
              ) : null}
            </>
          ) : null}
        </PanelShell>
      ) : null}

      {move ? (
        <PanelShell
          icon={<Route className="h-4 w-4" />}
          title="Move nodes to a new address"
          description="Tell nodes and relays where this installation moves"
          actions={
            <div className="flex items-center gap-2">
              {move.announcement ? (
                <Button variant="outline" onClick={withdraw}>
                  Withdraw
                </Button>
              ) : null}
              <Button onClick={() => setMoveOpen(true)}>
                {move.announcement ? "Change address" : "Announce address"}
              </Button>
            </div>
          }
        />
      ) : null}

      {estimate ? (
        <ExportDialog
          open={exportOpen}
          estimate={estimate}
          progress={progress}
          onOpenChange={setExportOpen}
          onStarted={setProgress}
        />
      ) : null}
      {move ? (
        <MoveDialog open={moveOpen} status={move} onOpenChange={setMoveOpen} onSaved={setMove} />
      ) : null}
    </>
  );
}
