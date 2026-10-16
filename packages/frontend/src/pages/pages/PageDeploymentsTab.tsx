import { PackageOpen, Pin, PinOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyButton } from "@/components/common/CopyButton";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { loadPageDeployments } from "@/lib/page-deployments";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PageDeployment } from "@/types";
import {
  formatPageBytes,
  formatPageExpiry,
  pagePreviewUrl,
  pageStatusLabel,
  pageStatusVariant,
} from "./page-format";

/** Pinned Deployments always lead the list, newest first within each group (the server's order). */
function pinnedFirst(deployments: PageDeployment[]): PageDeployment[] {
  return [...deployments].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.sequence - a.sequence
  );
}

export function PageDeploymentsTab({
  projectId,
  previewsEnabled = true,
}: {
  projectId: string;
  previewsEnabled?: boolean;
}) {
  const canManage = useAuthStore((state) =>
    state.hasScopedAccess(`pages:deployments:manage:${projectId}`)
  );
  const [deployments, setDeployments] = useState<PageDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDeployment, setSelectedDeployment] = useState<PageDeployment | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const loadRequestRef = useRef(0);

  const openDetails = (deployment: PageDeployment) => {
    setSelectedDeployment(deployment);
    setDetailsOpen(true);
  };

  const load = useCallback(
    async ({ fresh = true }: { fresh?: boolean } = {}) => {
      const requestId = ++loadRequestRef.current;
      try {
        const response = await loadPageDeployments(projectId, { fresh });
        if (requestId !== loadRequestRef.current) return;
        setDeployments(pinnedFirst(response.data ?? []));
      } catch (error) {
        if (requestId === loadRequestRef.current) {
          toastApiError(error, "Failed to load Deployments");
        }
      } finally {
        if (requestId === loadRequestRef.current) setLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    // The first load shares the request the project header just started.
    void load({ fresh: false });
  }, [load]);
  useRealtime("pages.deployment.changed", (payload) => {
    const event = payload as { projectId?: string };
    if (!event.projectId || event.projectId === projectId) void load();
  });

  const togglePin = async (deployment: PageDeployment) => {
    try {
      await api.pinPageDeployment(projectId, deployment.id, !deployment.pinned);
      setDeployments((current) =>
        pinnedFirst(
          current.map((item) =>
            item.id === deployment.id ? { ...item, pinned: !item.pinned } : item
          )
        )
      );
    } catch (error) {
      toastApiError(error, "Failed to update Deployment");
    }
  };

  const remove = async (deployment: PageDeployment) => {
    if (
      !(await confirm({
        title: "Delete Deployment",
        description: `Delete immutable Deployment ${deployment.publicSlug}? Protected Deployments explain the exact Tag or Route that still references them.`,
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.deletePageDeployment(projectId, deployment.id);
      toast.success("Deployment deleted");
      await load();
    } catch (error) {
      toastApiError(error, "Failed to delete Deployment");
    }
  };

  const columns: SimpleTableColumn<PageDeployment>[] = [
    {
      id: "hash",
      header: "Deployment",
      className: "w-[30%]",
      render: (deployment) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">{deployment.publicSlug}</span>
          {deployment.pinned && (
            <Badge variant="outline" size="inline">
              Pinned
            </Badge>
          )}
          {deployment.expiresAt && (
            <Badge
              variant="warning"
              size="inline"
              title={formatPageExpiry(deployment.expiresAt) ?? undefined}
            >
              Expires
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      className: "w-[16%]",
      render: (deployment) => (
        <Badge variant={pageStatusVariant(deployment.status)}>
          {pageStatusLabel(deployment.status)}
        </Badge>
      ),
    },
    {
      id: "created",
      header: "Created",
      className: "w-[22%]",
      render: (deployment) => (
        <RelativeTime value={deployment.createdAt} className="whitespace-nowrap" />
      ),
    },
    {
      id: "preview",
      header: "Preview",
      className: "w-[22%]",
      cellClassName: "pr-8",
      render: (deployment) => {
        const url = pagePreviewUrl(deployment.previewHostname);
        if (!url) return <Badge variant="secondary">Unavailable</Badge>;
        return (
          <div className="min-w-0" onClick={(event) => event.stopPropagation()}>
            <a
              className="block truncate text-primary underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {deployment.previewHostname}
            </a>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-[10%]",
      render: (deployment) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void togglePin(deployment)}
              aria-label={deployment.pinned ? "Unpin Deployment" : "Pin Deployment"}
              title={deployment.pinned ? "Unpin Deployment" : "Pin Deployment"}
            >
              {deployment.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </Button>
          )}
          {canManage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void remove(deployment)}
              aria-label="Delete Deployment"
              title="Delete Deployment"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const selectedPreviewUrl =
    previewsEnabled && selectedDeployment
      ? pagePreviewUrl(selectedDeployment.previewHostname)
      : null;

  return (
    <>
      <PanelShell
        icon={<PackageOpen className="h-4 w-4" />}
        title="Deployments"
        description="Immutable static artifacts and their preview publication status."
      >
        <SimpleTable
          columns={previewsEnabled ? columns : columns.filter((column) => column.id !== "preview")}
          rows={deployments}
          getRowKey={(deployment) => deployment.id}
          loading={loading}
          loadingMessage="Loading Deployments"
          emptyMessage="No Deployments yet. Use the resumable webhook API to upload a static artifact."
          tableClassName="table-fixed"
          onRowClick={openDetails}
        />
      </PanelShell>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent
          className="sm:max-w-lg"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.currentTarget.dataset.state === "closed"
            ) {
              setSelectedDeployment(null);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Deployment Details</DialogTitle>
          </DialogHeader>
          <DialogDescription>{selectedDeployment?.publicSlug}</DialogDescription>
          {selectedDeployment && (
            <PanelShell>
              <SettingsControlRow title="Status" controlsClassName="sm:min-w-0">
                <Badge variant={pageStatusVariant(selectedDeployment.status)}>
                  {pageStatusLabel(selectedDeployment.status)}
                </Badge>
              </SettingsControlRow>
              <SettingsControlRow title="Created" controlsClassName="sm:min-w-0">
                <RelativeTime value={selectedDeployment.createdAt} className="text-sm" />
              </SettingsControlRow>
              <SettingsControlRow title="Artifact" controlsClassName="sm:min-w-0">
                <span className="text-right text-sm">
                  {formatPageBytes(selectedDeployment.compressedSizeBytes)} compressed ·{" "}
                  {selectedDeployment.fileCount.toLocaleString()} files
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Source" controlsClassName="sm:min-w-0">
                <span className="min-w-0 truncate text-right text-sm">
                  {selectedDeployment.sourceMetadata.mergeRequest ??
                    selectedDeployment.sourceMetadata.commitSha ??
                    selectedDeployment.sourceMetadata.ref ??
                    "Static artifact"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow
                title="Expiry"
                description="Expired Deployments are deleted with their previews and files."
                controlsClassName="sm:min-w-0"
              >
                <span className="text-sm">
                  {formatPageExpiry(selectedDeployment.expiresAt) ?? "Never"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Requested Tag" controlsClassName="sm:min-w-0">
                <span className="text-sm">{selectedDeployment.requestedTag ?? "None"}</span>
              </SettingsControlRow>
              {previewsEnabled && (
                <SettingsControlRow title="Preview" controlsClassName="sm:min-w-0">
                  {selectedPreviewUrl ? (
                    <div className="flex min-w-0 items-center gap-1">
                      <a
                        className="truncate text-sm text-primary underline"
                        href={selectedPreviewUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {selectedDeployment.previewHostname}
                      </a>
                      <CopyButton
                        value={selectedPreviewUrl}
                        label="immutable preview URL"
                        className="h-auto w-auto bg-transparent p-0 text-muted-foreground hover:bg-transparent hover:text-primary"
                        iconClassName="h-3 w-3"
                      />
                    </div>
                  ) : (
                    <Badge variant="secondary">Unavailable</Badge>
                  )}
                </SettingsControlRow>
              )}
              {selectedDeployment.failureMessage && (
                <SettingsControlRow title="Failure" controlsClassName="sm:min-w-0">
                  <span className="text-right text-sm">{selectedDeployment.failureMessage}</span>
                </SettingsControlRow>
              )}
            </PanelShell>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
