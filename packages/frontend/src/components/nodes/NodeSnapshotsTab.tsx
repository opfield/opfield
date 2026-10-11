import { Camera, FolderPlus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { createClientUuid } from "@/lib/client-id";
import { formatHostingAmount } from "@/lib/hosting-money";
import {
  hostingOperationPending,
  hostingSnapshotBadgeVariant,
  hostingSnapshotLabel,
  isStaleHostingOperation,
  isStaleHostingSnapshotRevision,
} from "@/lib/hosting-status";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import type {
  HostingOperation,
  HostingSnapshotAction,
  HostingSnapshotChangedEvent,
  HostingSnapshotEventOperation,
  HostingSnapshotsView,
  HostingVmSnapshot,
} from "@/types/hosting";

type SnapshotRow = HostingVmSnapshot;

function normalizeSnapshot(snapshot: HostingVmSnapshot): HostingVmSnapshot {
  const entityId = snapshot.entityId ?? snapshot.id;
  const providerSnapshotId =
    snapshot.providerSnapshotId ?? (snapshot.entityId ? null : snapshot.id);
  return {
    ...snapshot,
    id: providerSnapshotId ?? entityId,
    entityId,
    providerSnapshotId,
    operationId: snapshot.operationId ?? null,
    error: snapshot.error ?? null,
    includeRam: snapshot.includeRam ?? false,
    revision: snapshot.revision ?? new Date(0).toISOString(),
    status: snapshot.status ?? (snapshot.ready ? "ready" : "pending"),
    layoutId: entityId,
  };
}

function snapshotIsActive(snapshot: HostingVmSnapshot): boolean {
  return snapshot.status === "pending" || snapshot.status === "deleting";
}

function snapshotIsDeletable(snapshot: HostingVmSnapshot): boolean {
  return snapshot.status === "ready" || snapshot.status === "failed";
}

function optimisticSnapshot(
  entityId: string,
  name: string,
  includeRam: boolean
): HostingVmSnapshot {
  return normalizeSnapshot({
    id: entityId,
    entityId,
    providerSnapshotId: null,
    status: "pending",
    operationId: null,
    error: null,
    includeRam,
    revision: new Date(0).toISOString(),
    name,
    createdAt: null,
    fingerprint: "",
    sizeGb: null,
    minDiskGb: null,
    ready: false,
  });
}

function mergeSnapshot(
  current: HostingVmSnapshot | undefined,
  incoming: HostingVmSnapshot
): HostingVmSnapshot {
  if (current && isStaleHostingSnapshotRevision(current.revision, incoming.revision))
    return current;
  const merged = {
    ...current,
    ...incoming,
  } as HostingVmSnapshot;
  if (!("monthlyCost" in incoming) && current) merged.monthlyCost = current.monthlyCost;
  if (!("storageRate" in incoming) && current) merged.storageRate = current.storageRate;
  return normalizeSnapshot(merged);
}

function mergeLoadedSnapshots(
  current: HostingVmSnapshot[],
  incoming: HostingVmSnapshot[],
  tombstones: Map<string, string>
): HostingVmSnapshot[] {
  const incomingByEntity = new Map(
    incoming.map((snapshot) => [snapshot.entityId ?? snapshot.id, snapshot])
  );
  const merged = incoming
    .map((snapshot) =>
      mergeSnapshot(
        current.find((item) => item.entityId === (snapshot.entityId ?? snapshot.id)),
        snapshot
      )
    )
    .filter((snapshot) => {
      const deletedRevision = tombstones.get(snapshot.entityId);
      if (!deletedRevision) return true;
      if (isStaleHostingSnapshotRevision(snapshot.revision, deletedRevision)) return false;
      tombstones.delete(snapshot.entityId);
      return true;
    });
  for (const snapshot of current) {
    if (!incomingByEntity.has(snapshot.entityId) && !["ready", "deleted"].includes(snapshot.status))
      merged.push(snapshot);
  }
  return merged.filter((snapshot) => snapshot.status !== "deleted");
}

function snapshotFromEvent(event: HostingSnapshotChangedEvent): HostingVmSnapshot {
  return normalizeSnapshot(event.snapshot);
}

function isDefiniteMutationRejection(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}

export function NodeSnapshotsTab({
  resourceId,
  mutationLocked = false,
  onOperationChange,
}: {
  resourceId: string;
  mutationLocked?: boolean;
  onOperationChange?: (operation: Pick<HostingOperation, "action" | "phase"> | null) => void;
}) {
  const authKey = useAuthStore(accessContextKey);
  const [view, setView] = useState<HostingSnapshotsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [includeRam, setIncludeRam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [localOperation, setLocalOperation] = useState<
    HostingOperation | HostingSnapshotEventOperation | null
  >(null);
  const generation = useRef(0);
  const deletedRevisions = useRef(new Map<string, string>());
  const clientOnlyEntities = useRef(new Set<string>());
  const reconcileClientEntities = useRef(new Set<string>());
  const eventGeneration = useRef(0);
  const notificationRef = useRef("");
  const sending = useRef(false);
  const restoreEntityId = useRef<string | null>(null);
  const context = useRef({ resourceId, authKey, mutationLocked });
  context.current = { resourceId, authKey, mutationLocked };
  const onOperationChangeRef = useRef(onOperationChange);
  onOperationChangeRef.current = onOperationChange;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const current = ++generation.current;
    const beforeEvents = eventGeneration.current;
    setLoading(true);
    try {
      const next = await api.getHostingSnapshots(resourceId);
      if (
        current !== generation.current ||
        beforeEvents !== eventGeneration.current ||
        authKey !== accessContextKey(useAuthStore.getState())
      )
        return;
      if (next.resourceId !== resourceId)
        throw new Error("The VM identity changed. Reopen this node.");
      setView((currentView) => {
        const previous =
          currentView?.resourceId === resourceId && currentView.incarnation === next.incarnation
            ? currentView
            : null;
        let operation = next.operation;
        if (
          currentView?.resourceId === resourceId &&
          currentView.incarnation === next.incarnation
        ) {
          if (!next.operation) operation = currentView.operation;
          else if (
            currentView.operation &&
            isStaleHostingOperation(currentView.operation, next.operation)
          )
            operation = currentView.operation;
        }
        const snapshots = previous
          ? mergeLoadedSnapshots(
              previous.snapshots.filter((snapshot) => {
                if (!reconcileClientEntities.current.has(snapshot.entityId)) return true;
                reconcileClientEntities.current.delete(snapshot.entityId);
                clientOnlyEntities.current.delete(snapshot.entityId);
                return next.snapshots.some((incoming) => incoming.entityId === snapshot.entityId);
              }),
              next.snapshots,
              deletedRevisions.current
            )
          : next.snapshots
              .map(normalizeSnapshot)
              .filter((snapshot) => !deletedRevisions.current.has(snapshot.entityId));
        return {
          ...next,
          snapshots,
          operation,
          busy:
            !!next.busy ||
            (!!operation && hostingOperationPending(operation)) ||
            snapshots.some(snapshotIsActive),
        };
      });
      setError(null);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "Could not load snapshots");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [authKey, resourceId]);
  useEffect(() => {
    setView(null);
    setCreateOpen(false);
    setDetailsId(null);
    setIncludeRam(false);
    setLocalOperation(null);
    restoreEntityId.current = null;
    deletedRevisions.current.clear();
    clientOnlyEntities.current.clear();
    reconcileClientEntities.current.clear();
    eventGeneration.current++;
    onOperationChangeRef.current?.(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useRealtime(resourceId ? "hosting.snapshot.folder.changed" : null, (payload) => {
    const event = payload as { resourceId?: string; incarnation?: string };
    if (event.resourceId === resourceId && (!view || event.incarnation === view.incarnation))
      void load();
  });
  useRealtime(
    resourceId ? "hosting.snapshot.changed" : null,
    (payload) => {
      const event = payload as Partial<HostingSnapshotChangedEvent>;
      const currentAuthKey = accessContextKey(useAuthStore.getState());
      if (
        currentAuthKey !== authKey ||
        event.resourceId !== resourceId ||
        !event.incarnation ||
        !event.snapshot ||
        (view && event.incarnation !== view.incarnation)
      )
        return;
      if (!view) {
        eventGeneration.current++;
        void load();
        return;
      }
      const incoming = snapshotFromEvent(event as HostingSnapshotChangedEvent);
      clientOnlyEntities.current.delete(incoming.entityId);
      reconcileClientEntities.current.delete(incoming.entityId);
      eventGeneration.current++;
      const previousSnapshot = view.snapshots.find(
        (snapshot) => snapshot.entityId === incoming.entityId
      );
      if (
        incoming.status === "failed" &&
        incoming.error &&
        incoming.error !== previousSnapshot?.error
      ) {
        toast.error(incoming.error, { id: `snapshot:${incoming.entityId}:${incoming.revision}` });
      }
      setView((current) => {
        if (
          !current ||
          current.resourceId !== resourceId ||
          current.incarnation !== event.incarnation
        )
          return current;
        const eventOperation = event.operation
          ? isStaleHostingOperation(current.operation, event.operation)
            ? current.operation
            : event.operation
          : current.operation;
        const existing = current.snapshots.find(
          (snapshot) => snapshot.entityId === incoming.entityId
        );
        const staleRow =
          existing && isStaleHostingSnapshotRevision(existing.revision, incoming.revision);
        const tombstone = deletedRevisions.current.get(incoming.entityId);
        const staleDeleted =
          tombstone && isStaleHostingSnapshotRevision(tombstone, incoming.revision);
        const snapshots =
          staleRow || staleDeleted
            ? current.snapshots
            : incoming.status === "deleted"
              ? current.snapshots.filter((snapshot) => snapshot.entityId !== incoming.entityId)
              : [
                  ...current.snapshots.filter(
                    (snapshot) => snapshot.entityId !== incoming.entityId
                  ),
                  mergeSnapshot(existing, incoming),
                ];
        if (!staleRow && !staleDeleted && incoming.status === "deleted")
          deletedRevisions.current.set(incoming.entityId, incoming.revision);
        else if (!staleRow && !staleDeleted && deletedRevisions.current.has(incoming.entityId))
          deletedRevisions.current.delete(incoming.entityId);
        return {
          ...current,
          snapshots,
          busy: event.operation
            ? !!eventOperation && hostingOperationPending(eventOperation)
            : current.busy,
          operation: event.operation ? eventOperation : current.operation,
        };
      });
      if (
        event.operation?.action === "snapshot_restore" &&
        !isStaleHostingOperation(view.operation, event.operation)
      ) {
        const pending = hostingOperationPending(event.operation);
        setLocalOperation(event.operation);
        if (!pending) restoreEntityId.current = null;
        onOperationChangeRef.current?.(pending ? event.operation : null);
      }
    },
    { onReconnect: () => void load() }
  );
  const active =
    !!view?.busy ||
    (!!localOperation && hostingOperationPending(localOperation)) ||
    (!!view?.operation && hostingOperationPending(view.operation)) ||
    !!view?.snapshots.some(snapshotIsActive);
  const activeRef = useRef(active);
  activeRef.current = active;
  const awaitingReadModel =
    !!view?.supported &&
    !!view.readModel &&
    (view.readModel.refreshStatus !== "success" || view.readModel.availability !== "available");
  const canSubmitSnapshot =
    !!view?.canCreate &&
    !!name.trim() &&
    !busy &&
    !mutationLocked &&
    !active &&
    (!includeRam || (view?.provider === "proxmox" && view.powerState === "running"));
  const restoreRequiresShutdown = view?.provider !== "proxmox" && view?.powerState !== "stopped";
  const notification = error || view?.readModel?.lastError || "";
  useEffect(() => {
    if (notification && notificationRef.current !== notification)
      toast.error(notification, { id: `snapshots:${resourceId}` });
    notificationRef.current = notification;
  }, [notification, resourceId]);
  const run = async (action: HostingSnapshotAction, snapshot?: SnapshotRow) => {
    if (!view || view.resourceId !== resourceId || sending.current || mutationLocked || active)
      return;
    let restoreSubmitted = false;
    const isCurrent = () =>
      mounted.current &&
      context.current.resourceId === resourceId &&
      context.current.authKey === authKey &&
      accessContextKey(useAuthStore.getState()) === authKey &&
      (restoreSubmitted || !context.current.mutationLocked);
    sending.current = true;
    setBusy(true);
    setError(null);
    let entityId: string | undefined;
    try {
      if (
        action !== "snapshot_create" &&
        !(await confirm({
          title: action === "snapshot_restore" ? "Restore VM snapshot" : "Delete snapshot",
          description:
            action === "snapshot_restore"
              ? `Replace all current VM disk data with “${snapshot!.name}”? All Gateway roles and workloads on this VM are affected. Data written after the snapshot will be lost.${view.provider === "proxmox" ? " Proxmox stops the VM as part of rollback, interrupting running workloads, and requests a restart if it was running. Snapshots containing RAM can also start the VM." : ""}${view.provider === "hostkey" ? " HOSTKEY also deletes snapshots newer than the selected snapshot." : ""}`
              : `Permanently delete snapshot “${snapshot!.name}”? This cannot be undone.`,
          confirmLabel: action === "snapshot_restore" ? "Restore snapshot" : "Delete snapshot",
          variant: "destructive",
        }))
      )
        return;
      if (!isCurrent() || activeRef.current) return;
      entityId = action === "snapshot_create" ? createClientUuid() : undefined;
      const pendingRestore =
        action === "snapshot_restore"
          ? ({
              id: createClientUuid(),
              connectorId: null,
              resourceId,
              nodeId: null,
              action,
              phase: "pending",
              errorCode: null,
              errorMessage: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: null,
              result: snapshot ? { snapshotEntityId: snapshot.entityId } : null,
            } satisfies HostingOperation)
          : null;
      if (action === "snapshot_create" && entityId) {
        clientOnlyEntities.current.add(entityId);
        const optimistic = optimisticSnapshot(entityId, name.trim(), includeRam);
        setView((current) =>
          current ? { ...current, snapshots: [optimistic, ...current.snapshots] } : current
        );
        setCreateOpen(false);
      }
      if (action === "snapshot_delete" && snapshot) {
        setView((current) =>
          current
            ? {
                ...current,
                snapshots: current.snapshots.map((item) =>
                  item.entityId === snapshot.entityId
                    ? { ...item, status: "deleting", revision: new Date(0).toISOString() }
                    : item
                ),
              }
            : current
        );
      }
      if (pendingRestore && snapshot) {
        restoreSubmitted = true;
        restoreEntityId.current = snapshot.entityId;
        setLocalOperation(pendingRestore);
        onOperationChange?.(pendingRestore);
      }
      const operation = await api.hostingSnapshotAction(resourceId, {
        action,
        idempotencyKey: entityId ?? createClientUuid(),
        expectedIncarnation: view.incarnation,
        confirmed: true,
        ...(snapshot
          ? {
              snapshotEntityId: snapshot.entityId,
              ...(snapshot.providerSnapshotId ? { snapshotId: snapshot.providerSnapshotId } : {}),
              ...(snapshot.fingerprint && /^[a-f0-9]{64}$/.test(snapshot.fingerprint)
                ? { snapshotFingerprint: snapshot.fingerprint }
                : {}),
            }
          : { name: name.trim(), ...(view.provider === "proxmox" ? { includeRam } : {}) }),
      });
      if (!isCurrent()) return;
      if (entityId) clientOnlyEntities.current.delete(entityId);
      setView((current) => {
        if (!current) return current;
        if (!entityId && !snapshot) return { ...current, operation };
        const canonicalEntityId = operation.result?.snapshotEntityId ?? entityId;
        return {
          ...current,
          snapshots: current.snapshots.map((item) =>
            item.entityId === (entityId ?? snapshot?.entityId)
              ? {
                  ...item,
                  entityId: canonicalEntityId ?? item.entityId,
                  id: item.providerSnapshotId ?? canonicalEntityId ?? item.entityId,
                  layoutId: canonicalEntityId ?? item.entityId,
                  operationId: operation.id,
                }
              : item
          ),
          operation: isStaleHostingOperation(current.operation, operation)
            ? current.operation
            : operation,
        };
      });
      if (action === "snapshot_restore" && restoreEntityId.current) {
        setLocalOperation((current) =>
          isStaleHostingOperation(current, operation) ? current : operation
        );
        onOperationChange?.(operation);
      }
    } catch (e) {
      if (isCurrent()) {
        if (isDefiniteMutationRejection(e)) {
          setView((current) => {
            if (!current) return current;
            if (action === "snapshot_create" && entityId) {
              clientOnlyEntities.current.delete(entityId);
              return {
                ...current,
                snapshots: current.snapshots.filter((item) => item.entityId !== entityId),
              };
            }
            if (action === "snapshot_delete" && snapshot) {
              return {
                ...current,
                snapshots: current.snapshots.map((item) =>
                  item.entityId === snapshot.entityId ? snapshot : item
                ),
              };
            }
            return action === "snapshot_restore" ? { ...current, operation: null } : current;
          });
          if (action === "snapshot_restore") {
            setLocalOperation(null);
            restoreEntityId.current = null;
            onOperationChange?.(null);
          }
        } else {
          if (entityId && clientOnlyEntities.current.has(entityId))
            reconcileClientEntities.current.add(entityId);
          void load();
        }
        setError(e instanceof Error ? e.message : "Snapshot operation failed");
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  // Inventory observations must not turn an accepted delete back into a ready row.
  const snapshots = (view?.snapshots ?? []).map((snapshot) => {
    const operation = view?.operation;
    if (
      operation?.action === "snapshot_delete" &&
      hostingOperationPending(operation) &&
      (snapshot.operationId === operation.id ||
        ("result" in operation && operation.result?.snapshotEntityId === snapshot.entityId))
    )
      return { ...snapshot, status: "deleting" as const };
    return snapshot;
  });
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.entityId === detailsId);
  const details = useRetainedDialogValue(selectedSnapshot, !!selectedSnapshot);
  const columns: ResourceListColumn<SnapshotRow>[] = [
    {
      id: "name",
      label: "Snapshot",
      width: "30%",
      renderCell: (s) => (
        <p className="truncate font-medium" title={s.name}>
          {s.name}
        </p>
      ),
    },
    {
      id: "created",
      label: "Created",
      renderCell: (s) => <RelativeTime value={s.createdAt} />,
    },
    {
      id: "size",
      label: "Size",
      renderCell: (s) =>
        s.sizeGb === null
          ? "—"
          : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(s.sizeGb)} GB`,
    },
    ...(["digitalocean", "hetzner", "cloudblast"].includes(view?.provider ?? "")
      ? [
          {
            id: "cost",
            label: "Est. monthly storage",
            renderCell: (s: SnapshotRow) =>
              s.monthlyCost
                ? `${formatHostingAmount(s.monthlyCost.amount)} ${s.monthlyCost.currency} / month`
                : "—",
          },
        ]
      : []),
    {
      id: "status",
      label: "Status",
      renderCell: (s) => (
        <Badge variant={hostingSnapshotBadgeVariant(s.status)}>
          {hostingSnapshotLabel(s.status)}
        </Badge>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      width: "7rem",
      align: "right",
      renderCell: (s) => (
        <div className="flex items-center justify-end" onClick={(event) => event.stopPropagation()}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={restoreRequiresShutdown ? 0 : undefined}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Restore"
                    title="Restore snapshot"
                    disabled={
                      !view?.canRestore || s.status !== "ready" || busy || mutationLocked || active
                    }
                    onClick={() => void run("snapshot_restore", s)}
                  >
                    <RotateCcw />
                  </Button>
                </span>
              </TooltipTrigger>
              {restoreRequiresShutdown && (
                <TooltipContent>
                  Shut down the VM before restoring this snapshot. Creating snapshots does not
                  require a shutdown.
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${s.name}`}
            title="Delete snapshot"
            disabled={
              !view?.canDelete || !snapshotIsDeletable(s) || busy || mutationLocked || active
            }
            onClick={() => void run("snapshot_delete", s)}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];
  return (
    <>
      <PanelShell
        title="Snapshots"
        icon={<Camera className="h-4 w-4" />}
        description="Create and organize VM snapshots. Snapshots can be created while the VM is running. Storage charges may apply."
        headerActionsClassName="max-w-full flex-wrap"
        wrapHeader
        actions={
          <>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh snapshots"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw />
            </Button>
            {view?.canManageFolders && (
              <Button
                variant="outline"
                disabled={!createFolderAction || busy}
                onClick={() => createFolderAction?.()}
              >
                <FolderPlus />
                Add Folder
              </Button>
            )}
            <Button
              disabled={!view?.canCreate || busy || mutationLocked || active}
              onClick={() => {
                setName("");
                setIncludeRam(false);
                setCreateOpen(true);
              }}
            >
              <Camera />
              Create snapshot
            </Button>
          </>
        }
      >
        {view && !view.supported ? (
          <EmptyState
            embedded
            message={view.reason ?? "Snapshots are not supported for this VM."}
          />
        ) : (
          <FolderedResourceList<SnapshotRow>
            embedded
            key={`${resourceId}:${authKey}`}
            resourceType={`hosting-snapshot:${resourceId}`}
            realtimeChannel="hosting.snapshot.folder.changed"
            columns={columns}
            resources={snapshots
              .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
              .filter((s) => s.status !== "deleted")
              .map((s) => ({ ...s, id: s.entityId, layoutId: s.entityId }))}
            search={{
              search,
              onSearchChange: setSearch,
              placeholder: "Search snapshots...",
              hasActiveFilters: !!search,
              onReset: () => setSearch(""),
            }}
            loading={loading}
            loadingLabel="Loading snapshots..."
            emptyState={
              <EmptyState
                embedded
                message={awaitingReadModel ? "Waiting for snapshot inventory" : "No snapshots yet"}
                hasActiveFilters={!!search}
                onReset={() => setSearch("")}
              />
            }
            canManageFolders={!!view?.canManageFolders && !busy}
            canReorganizeItem={() => !!view?.canManageFolders && !busy}
            getResourceLabel={(s) => s.name}
            onItemClick={(s) => setDetailsId(s.entityId)}
            onRefresh={load}
            onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
          />
        )}
      </PanelShell>
      <Dialog open={!!selectedSnapshot} onOpenChange={(open) => !open && setDetailsId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Snapshot Details</DialogTitle>
            <DialogDescription>VM snapshot information.</DialogDescription>
          </DialogHeader>
          {details && (
            <div className="divide-y divide-border border border-border">
              <DetailRow label="Name" value={<span className="break-all">{details.name}</span>} />
              <DetailRow
                label="Status"
                value={
                  <Badge variant={hostingSnapshotBadgeVariant(details.status)}>
                    {hostingSnapshotLabel(details.status)}
                  </Badge>
                }
              />
              <DetailRow
                label="Provider ID"
                value={<span className="break-all">{details.providerSnapshotId ?? "—"}</span>}
              />
              <DetailRow label="Created" value={<RelativeTime value={details.createdAt} />} />
              <DetailRow
                label="Size"
                value={
                  details.sizeGb === null
                    ? "—"
                    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(details.sizeGb)} GB`
                }
              />
              <DetailRow
                label="Minimum disk"
                value={details.minDiskGb === null ? "—" : `${details.minDiskGb} GB`}
              />
              {view?.provider === "proxmox" && (
                <DetailRow label="RAM included" value={details.includeRam ? "Yes" : "No"} />
              )}
              {["digitalocean", "hetzner", "cloudblast"].includes(view?.provider ?? "") && (
                <DetailRow
                  label="Est. monthly storage"
                  value={
                    details.monthlyCost
                      ? `${formatHostingAmount(details.monthlyCost.amount)} ${details.monthlyCost.currency} / month`
                      : "—"
                  }
                />
              )}
              {details.error && (
                <DetailRow
                  label="Error"
                  value={<span className="break-all">{details.error}</span>}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!busy) setCreateOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create VM Snapshot</DialogTitle>
            <DialogDescription>
              Save the VM disk state while it keeps running. Pause application writes for consistent
              data. Attached volumes may be excluded.
              {view?.provider !== "proxmox" && " Provider storage charges may apply."}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Snapshot name"
            placeholder="Snapshot name"
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (canSubmitSnapshot) void run("snapshot_create");
              }
            }}
            disabled={busy}
          />
          {view?.provider === "proxmox" && (
            <CheckboxCard
              label="Include RAM"
              description={
                view.powerState === "running"
                  ? "Save memory and device state as well as disks. Uses additional storage and may briefly pause the VM."
                  : "The VM must be running to capture its memory."
              }
              checked={includeRam}
              onCheckedChange={setIncludeRam}
              disabled={busy || (view.powerState !== "running" && !includeRam)}
            />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              pending={busy}
              disabled={!canSubmitSnapshot}
              onClick={() => void run("snapshot_create")}
            >
              Create snapshot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
