import { Link2, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { api } from "@/services/api";
import type {
  ManagedObjectStorage,
  ManagedStorageBinding,
  ManagedStorageBindingEnvironment,
  ManagedStorageBindingTargetType,
} from "@/types";
import { ManagedStorageLinkDialog } from "./ManagedStorageLinkDialog";

type PendingStorageLink = {
  id: string;
  clusterId: string;
  environment: ManagedStorageBindingEnvironment;
  buckets: string[];
};

type PendingStorageLinkChanges = {
  additions: PendingStorageLink[];
  removals: Array<{ clusterId: string; bindingId: string }>;
};

type DisplayBinding = {
  cluster: ManagedObjectStorage;
  binding: ManagedStorageBinding;
  pending: "add" | "remove" | null;
};

export interface ManagedStorageLinksSectionHandle {
  applyChanges(options?: { targetEnvironment?: Record<string, string> }): Promise<void>;
}

export interface ManagedStorageLinkDraft {
  hasChanges: boolean;
  managedVariableNames: string[];
  pendingAdditionVariableNames: string[];
}

const EMPTY_CHANGES: PendingStorageLinkChanges = { additions: [], removals: [] };

function localDraftId() {
  return globalThis.crypto?.randomUUID?.() ?? `storage-link-${Date.now()}-${Math.random()}`;
}

function environmentNames(environment: ManagedStorageBindingEnvironment) {
  return Object.values(environment)
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
}

export const ManagedStorageLinksSection = forwardRef<
  ManagedStorageLinksSectionHandle,
  {
    nodeId: string;
    targetType: ManagedStorageBindingTargetType;
    targetResourceId: string;
    containerName: string;
    canManage: boolean;
    canManageCluster?: (connectionId: string | null) => boolean;
    disabled?: boolean;
    /** Why unlinking a saved link is disabled (the app environment is isolated or shut down). */
    removeDisabledReason?: string | null;
    existingVariableNames?: string[];
    onInitialLoadingChange?: (loading: boolean) => void;
    onDraftChange?: (draft: ManagedStorageLinkDraft) => void;
    onSaveRequested?: () => void;
    onMutationStart?: (transition: "updating" | "recreating") => void;
    onMutationEnd?: () => void;
    onRecreating?: () => void | Promise<void>;
    recreatesRunningWorkload?: boolean;
  }
>(function ManagedStorageLinksSection(
  {
    nodeId,
    targetType,
    targetResourceId,
    containerName,
    canManage,
    canManageCluster,
    disabled,
    removeDisabledReason = null,
    existingVariableNames = [],
    onInitialLoadingChange,
    onDraftChange,
    onSaveRequested,
    onMutationStart,
    onMutationEnd,
    onRecreating,
    recreatesRunningWorkload = false,
  },
  ref
) {
  const [clusters, setClusters] = useState<ManagedObjectStorage[]>([]);
  const [bindings, setBindings] = useState<
    Array<{ clusterId: string; binding: ManagedStorageBinding }>
  >([]);
  const [changes, setChanges] = useState<PendingStorageLinkChanges>(EMPTY_CHANGES);
  const [loading, setLoading] = useState(true);
  // Reloads after a save keep the current rows; only the first load holds the tab.
  const initialLoading = useInitialLoading(loading);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const managedClusters = await api.listManagedObjectStorages();
      const bindingResults = await Promise.all(
        managedClusters.map(async (cluster) => ({
          clusterId: cluster.id,
          bindings: await api.listManagedStorageBindings(cluster.id),
        }))
      );
      setClusters(managedClusters);
      setBindings(
        bindingResults.flatMap(({ clusterId, bindings: clusterBindings }) =>
          clusterBindings
            .filter(
              (binding) =>
                binding.targetNodeId === nodeId &&
                binding.targetType === targetType &&
                binding.targetResourceId === targetResourceId
            )
            .map((binding) => ({ clusterId, binding }))
        )
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load managed storage links");
    } finally {
      setLoading(false);
    }
  }, [nodeId, targetResourceId, targetType]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onInitialLoadingChange?.(initialLoading);
  }, [initialLoading, onInitialLoadingChange]);

  const displayBindings = useMemo<DisplayBinding[]>(() => {
    const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    const existing = bindings.flatMap(({ clusterId, binding }) => {
      const cluster = clusterById.get(clusterId);
      if (!cluster) return [];
      const pending: DisplayBinding["pending"] = changes.removals.some(
        (removal) => removal.clusterId === clusterId && removal.bindingId === binding.id
      )
        ? "remove"
        : null;
      return [{ cluster, binding, pending }];
    });
    const additions = changes.additions.flatMap((addition) => {
      const cluster = clusterById.get(addition.clusterId);
      if (!cluster) return [];
      return [
        {
          cluster,
          binding: {
            id: addition.id,
            clusterId: addition.clusterId,
            targetNodeId: nodeId,
            targetType,
            targetResourceId,
            connectorAlias: "pending",
            environment: addition.environment,
            buckets: addition.buckets,
            accessKeyId: null,
            status: "creating" as const,
            lastError: null,
            createdAt: "",
            updatedAt: "",
          },
          pending: "add" as const,
        },
      ];
    });
    return [...existing, ...additions];
  }, [bindings, changes, clusters, nodeId, targetResourceId, targetType]);

  const hasChanges = changes.additions.length > 0 || changes.removals.length > 0;
  const managedVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          displayBindings
            .filter((entry) => entry.pending !== "remove")
            .flatMap((entry) => environmentNames(entry.binding.environment))
        )
      ),
    [displayBindings]
  );
  const pendingAdditionVariableNames = useMemo(
    () =>
      Array.from(
        new Set(changes.additions.flatMap((addition) => environmentNames(addition.environment)))
      ),
    [changes.additions]
  );

  useEffect(() => {
    onDraftChange?.({ hasChanges, managedVariableNames, pendingAdditionVariableNames });
  }, [hasChanges, managedVariableNames, onDraftChange, pendingAdditionVariableNames]);

  const availableClusters = useMemo(
    () =>
      clusters.filter(
        (cluster) =>
          cluster.status === "ready" &&
          (canManageCluster?.(cluster.objectStorageConnectionId) ?? canManage) &&
          !displayBindings.some(
            (entry) => entry.pending !== "remove" && entry.cluster.id === cluster.id
          )
      ),
    [clusters, displayBindings, canManage, canManageCluster]
  );

  const openAddDialog = () => {
    if (availableClusters.length === 0) {
      toast.error("No ready managed storage clusters are available to link");
      return;
    }
    setAddOpen(true);
  };

  const stageLink = ({
    clusterId,
    buckets,
    environment,
  }: {
    clusterId: string;
    buckets: string[];
    environment: ManagedStorageBindingEnvironment;
  }) => {
    const selectedCluster = availableClusters.find((cluster) => cluster.id === clusterId);
    if (!selectedCluster) return;

    const names = environmentNames(environment);
    const existing = new Set(existingVariableNames);
    const managed = new Set(managedVariableNames);
    const collisions = names.filter((name) => existing.has(name) || managed.has(name));
    if (collisions.length > 0) {
      toast.error(
        `Choose different variable names: ${collisions.join(", ")} are already managed or in use`
      );
      return;
    }

    setChanges((current) => ({
      ...current,
      additions: [
        ...current.additions,
        {
          id: localDraftId(),
          clusterId: selectedCluster.id,
          environment: Object.fromEntries(
            Object.entries(environment)
              .map(([field, value]) => [field, value?.trim()])
              .filter(([, value]) => Boolean(value))
          ) as ManagedStorageBindingEnvironment,
          buckets,
        },
      ],
    }));
    setAddOpen(false);
  };

  const stageUnlink = (entry: DisplayBinding) => {
    if (entry.pending === "add") {
      setChanges((current) => ({
        ...current,
        additions: current.additions.filter((addition) => addition.id !== entry.binding.id),
      }));
      return;
    }
    if (entry.pending === "remove") {
      setChanges((current) => ({
        ...current,
        removals: current.removals.filter(
          (removal) =>
            removal.clusterId !== entry.cluster.id || removal.bindingId !== entry.binding.id
        ),
      }));
      return;
    }
    setChanges((current) => ({
      ...current,
      removals: [...current.removals, { clusterId: entry.cluster.id, bindingId: entry.binding.id }],
    }));
  };

  const applyChanges = useCallback(
    async (options?: { targetEnvironment?: Record<string, string> }) => {
      if (!hasChanges) return;
      const remaining: PendingStorageLinkChanges = {
        additions: [...changes.additions],
        removals: [...changes.removals],
      };
      try {
        for (const removal of changes.removals) {
          await api.deleteManagedStorageBinding(removal.clusterId, removal.bindingId, {
            targetEnvironment: options?.targetEnvironment,
          });
          remaining.removals = remaining.removals.filter(
            (item) => item.clusterId !== removal.clusterId || item.bindingId !== removal.bindingId
          );
        }
        for (const addition of changes.additions) {
          await api.createManagedStorageBinding(addition.clusterId, {
            targetNodeId: nodeId,
            targetType,
            targetResourceId,
            environment: addition.environment,
            buckets: addition.buckets,
            targetEnvironment: options?.targetEnvironment,
          });
          remaining.additions = remaining.additions.filter((item) => item.id !== addition.id);
        }
        setChanges(EMPTY_CHANGES);
        await load();
      } catch (error) {
        setChanges(remaining);
        await load();
        throw error;
      }
    },
    [changes, hasChanges, load, nodeId, targetResourceId, targetType]
  );

  useImperativeHandle(ref, () => ({ applyChanges }), [applyChanges]);

  const save = async () => {
    if (!hasChanges) return;
    setSaving(true);
    onMutationStart?.(recreatesRunningWorkload ? "recreating" : "updating");
    try {
      await applyChanges();
      toast.success(
        recreatesRunningWorkload
          ? "Managed storage links updated — recreating workload"
          : "Managed storage links updated"
      );
      void Promise.resolve(onRecreating?.());
    } catch (error) {
      onMutationEnd?.();
      toast.error(error instanceof Error ? error.message : "Failed to save managed storage links");
    } finally {
      setSaving(false);
    }
  };

  useContentLoading(initialLoading);

  return (
    <>
      <PanelShell
        title="Managed Storage Links"
        icon={<Link2 className="h-4 w-4" />}
        description={
          recreatesRunningWorkload
            ? "Private object-storage connections. Changes apply with Save & Recreate."
            : "Private object-storage connections. Changes apply when the workload is started."
        }
        dirty={hasChanges}
        bodyClassName={displayBindings.length > 0 ? "divide-y divide-border" : undefined}
        actions={
          <div className="flex items-center gap-2">
            {canManage && (
              <Button
                type="button"
                variant="warning"
                pending={saving}
                disabled={disabled || loading || !hasChanges}
                onClick={() => (onSaveRequested ? onSaveRequested() : void save())}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {recreatesRunningWorkload ? "Save & Recreate" : "Save"}
              </Button>
            )}
            {canManage && (
              <Button
                type="button"
                disabled={disabled || loading || saving}
                onClick={openAddDialog}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            )}
          </div>
        }
      >
        {initialLoading ? null : displayBindings.length === 0 ? (
          <EmptyState message="No managed storage links" embedded />
        ) : (
          displayBindings.map((entry) => {
            // Saved into the workload's configuration; its next start or rollout runs it.
            const awaitingWorkload =
              entry.pending === null &&
              entry.binding.status === "ready" &&
              entry.binding.observedState === "target_applied";
            const status =
              entry.pending === "remove"
                ? "will unlink"
                : entry.pending === "add" || awaitingWorkload
                  ? "pending"
                  : entry.binding.status;
            const badgeVariant =
              entry.pending === "remove"
                ? "warning"
                : entry.pending === "add" || awaitingWorkload
                  ? "secondary"
                  : entry.binding.status === "ready"
                    ? entry.binding.lastError
                      ? "warning"
                      : "success"
                    : entry.binding.status === "error"
                      ? "destructive"
                      : "secondary";
            const statusDetail =
              entry.binding.lastError ??
              (awaitingWorkload
                ? "Saved in the workload's configuration. It takes effect when the workload next starts or finishes its current rollout."
                : entry.binding.status === "ready"
                  ? "Storage link is ready."
                  : entry.binding.status === "creating"
                    ? "Storage link is being created."
                    : entry.binding.status === "deleting"
                      ? "Storage link is being removed."
                      : "Storage link failed.");
            const description = [
              entry.binding.buckets.join(", "),
              environmentNames(entry.binding.environment).join(", "),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <SettingsControlRow
                key={entry.binding.id}
                title={entry.cluster.name}
                description={description || "Storage credentials injected"}
              >
                <div className="flex items-center gap-2">
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant={badgeVariant} tabIndex={0}>
                          {status}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-sm">
                        {entry.pending === "add"
                          ? "Created when the changes are saved."
                          : entry.pending === "remove"
                            ? "Removed when the changes are saved."
                            : statusDetail}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {canManage &&
                    (canManageCluster?.(entry.cluster.objectStorageConnectionId) ?? true) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title={
                          entry.pending === "remove"
                            ? "Keep link"
                            : entry.pending === null && removeDisabledReason
                              ? removeDisabledReason
                              : "Unlink storage"
                        }
                        disabled={
                          disabled ||
                          saving ||
                          (entry.pending === null && removeDisabledReason !== null)
                        }
                        onClick={() => stageUnlink(entry)}
                      >
                        {entry.pending === "remove" ? (
                          <Undo2 className="h-4 w-4" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                </div>
              </SettingsControlRow>
            );
          })
        )}
      </PanelShell>

      <ManagedStorageLinkDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        clusters={availableClusters}
        containerName={containerName}
        onStage={stageLink}
      />
    </>
  );
});
