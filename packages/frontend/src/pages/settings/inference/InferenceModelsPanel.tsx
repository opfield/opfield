import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Boxes, GripVertical, Plus, Trash2 } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  SimpleTable,
  type SimpleTableColumn,
  type SimpleTableRowRenderProps,
} from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api-error-toast";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { PermissionGroup, User } from "@/types";
import type {
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
import { InferenceModelDialog } from "./InferenceModelDialog";

type ModelSortable = ReturnType<typeof useSortable>;
const ModelDragHandleContext = createContext<
  Pick<ModelSortable, "attributes" | "listeners" | "setActivatorNodeRef"> | undefined
>(undefined);

export function reorderInferenceModels(models: InferenceModel[], activeId: string, overId: string) {
  const oldIndex = models.findIndex((model) => model.id === activeId);
  const newIndex = models.findIndex((model) => model.id === overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return models;
  return arrayMove(models, oldIndex, newIndex).map((model, sortOrder) => ({
    ...model,
    sortOrder,
  }));
}

export function InferenceModelsPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const canManage = useAuthStore((state) => state.hasScope("inference:models:manage"));
  const canListGroups = useAuthStore((state) => state.hasScope("admin:groups"));
  const canListUsers = useAuthStore((state) => state.hasScope("admin:users"));
  const cachedModels = api.getCached<InferenceModel[]>(
    "req:/api/inference/models",
    Number.POSITIVE_INFINITY
  );
  const cachedConnections = api.getCached<InferenceProviderConnection[]>(
    "req:/api/inference/providers/connections",
    Number.POSITIVE_INFINITY
  );
  const cachedCatalog = api.getCached<InferenceProviderCatalogItem[]>(
    "req:/api/inference/providers/catalog",
    Number.POSITIVE_INFINITY
  );
  const cachedGroups = canListGroups
    ? api.getCached<PermissionGroup[]>("req:/api/admin/groups", Number.POSITIVE_INFINITY)
    : [];
  const cachedUsers = canListUsers
    ? api.getCached<User[]>("req:/api/admin/users", Number.POSITIVE_INFINITY)
    : [];
  const hasCachedData =
    cachedModels !== undefined &&
    cachedConnections !== undefined &&
    cachedCatalog !== undefined &&
    cachedGroups !== undefined &&
    cachedUsers !== undefined;
  const [models, setModels] = useState<InferenceModel[]>(cachedModels ?? []);
  const [connections, setConnections] = useState<InferenceProviderConnection[]>(
    cachedConnections ?? []
  );
  const [catalog, setCatalog] = useState<InferenceProviderCatalogItem[]>(cachedCatalog ?? []);
  const [groups, setGroups] = useState<PermissionGroup[]>(cachedGroups ?? []);
  const [users, setUsers] = useState<User[]>(cachedUsers ?? []);
  const [loading, setLoading] = useState(!hasCachedData);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InferenceModel | null>(null);
  const [reordering, setReordering] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const initializedRef = useRef(hasCachedData);
  useContentLoading(loading);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const providerLabels = new Map(catalog.map((provider) => [provider.id, provider.label]));

  const load = useCallback(
    async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
      if (showLoading) setLoading(true);
      try {
        const [nextModels, nextConnections, nextCatalog] = await Promise.all([
          api.listInferenceModels(),
          api.listInferenceProviderConnections(),
          api.listInferenceProviderCatalog(),
        ]);
        setModels(nextModels);
        setConnections(nextConnections);
        setCatalog(nextCatalog);
        const [nextGroups, nextUsers] = await Promise.all([
          canListGroups ? api.listGroups() : Promise.resolve([]),
          canListUsers ? api.listUsers() : Promise.resolve([]),
        ]);
        setGroups(nextGroups);
        setUsers(nextUsers);
      } catch (error) {
        toastApiError(error, "Failed to load inference models");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [canListGroups, canListUsers]
  );

  useEffect(() => {
    void refreshToken;
    const showLoading = !initializedRef.current;
    initializedRef.current = true;
    void load({ showLoading });
  }, [load, refreshToken]);

  const remove = async (model: InferenceModel) => {
    const accepted = await confirm({
      title: "Delete Inference Model",
      description: `Delete “${model.displayName}” and its provider configuration?`,
      confirmLabel: "Delete",
    });
    if (!accepted) return;
    setDeletingId(model.id);
    try {
      await api.deleteInferenceModel(model.id);
      await load({ showLoading: false });
    } catch (error) {
      toastApiError(error, "Failed to delete model");
    } finally {
      setDeletingId(null);
    }
  };

  const reorderModels = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reordering) return;
    const previous = models;
    const next = reorderInferenceModels(previous, String(active.id), String(over.id));
    if (next === previous) return;
    setModels(next);
    setReordering(true);
    try {
      await api.reorderInferenceModels(
        next.map((model, sortOrder) => ({ id: model.id, sortOrder }))
      );
      await load({ showLoading: false });
      toast.success("Model order updated");
    } catch (error) {
      setModels(previous);
      await load({ showLoading: false });
      toastApiError(error, "Failed to update model order");
    } finally {
      setReordering(false);
    }
  };

  const columns: SimpleTableColumn<InferenceModel>[] = [
    ...(canManage && models.length > 1
      ? [
          {
            id: "reorder",
            header: <span className="sr-only">Order</span>,
            className: "w-10 pr-0",
            cellClassName: "w-10 pr-0",
            render: (model: InferenceModel) => (
              <ModelDragHandle model={model} disabled={reordering} />
            ),
          },
        ]
      : []),
    {
      id: "model",
      header: "Model",
      render: (model) => (
        <div>
          <p className="font-medium">{model.displayName}</p>
          <p className="font-mono text-xs text-muted-foreground">{model.publicId}</p>
        </div>
      ),
    },
    {
      id: "provider",
      header: "Provider",
      render: (model) => {
        const source = model.sources[0];
        if (!source) return "Not configured";
        return (
          <div>
            <p>{providerLabels.get(source.providerId) ?? source.providerId}</p>
            <p className="text-xs text-muted-foreground">
              {source.upstreamModelId} · {model.sources.length} account
              {model.sources.length === 1 ? "" : "s"}
            </p>
          </div>
        );
      },
    },
    {
      id: "capabilities",
      header: "Capabilities",
      render: (model) =>
        Object.entries(model.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(", ") || "text",
    },
    {
      id: "access",
      header: "Access",
      render: (model) =>
        model.accessMode === "everyone"
          ? "Everyone"
          : model.accessMode === "disabled"
            ? "Disabled"
            : `${model.accessSubjects.length} selected`,
    },
    {
      id: "billing",
      header: "Billing",
      render: (model) => (
        <span>
          {model.sources[0]?.sourceType === "api"
            ? "API"
            : `${model.subscriptionMultiplier}× credits`}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      render: (model) => (
        <Badge variant={model.enabled ? "success" : "secondary"} size="inline">
          {model.enabled ? "published" : "disabled"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (model) =>
        canManage ? (
          <div className="flex justify-end" onPointerDown={(event) => event.stopPropagation()}>
            <Button
              variant="outline"
              size="icon"
              aria-label={`Delete ${model.displayName}`}
              pending={deletingId === model.id}
              onClick={(event) => {
                event.stopPropagation();
                void remove(model);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PanelShell
        icon={<Boxes className="h-4 w-4" />}
        title="Models"
        description="Models exposed to users and the provider account group serving each model"
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
              disabled={!connections.length}
            >
              <Plus />
              Add model
            </Button>
          ) : null
        }
      >
        {canManage && models.length > 1 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void reorderModels(event)}
          >
            <SortableContext
              items={models.map((model) => model.id)}
              strategy={verticalListSortingStrategy}
            >
              <ModelTable
                columns={columns}
                models={models}
                loading={loading}
                reordering={reordering}
                hasConnections={connections.length > 0}
                onEdit={(model) => {
                  setEditing(model);
                  setDialogOpen(true);
                }}
                sortable
              />
            </SortableContext>
          </DndContext>
        ) : (
          <ModelTable
            columns={columns}
            models={models}
            loading={loading}
            reordering={reordering}
            hasConnections={connections.length > 0}
            onEdit={
              canManage
                ? (model) => {
                    setEditing(model);
                    setDialogOpen(true);
                  }
                : undefined
            }
          />
        )}
      </PanelShell>
      <InferenceModelDialog
        open={dialogOpen}
        editing={editing}
        connections={connections}
        catalog={catalog}
        groups={groups}
        users={users}
        onOpenChange={setDialogOpen}
        onSaved={() => load({ showLoading: false })}
      />
    </>
  );
}

function ModelTable({
  columns,
  models,
  loading,
  reordering,
  hasConnections,
  onEdit,
  sortable = false,
}: {
  columns: SimpleTableColumn<InferenceModel>[];
  models: InferenceModel[];
  loading: boolean;
  reordering: boolean;
  hasConnections: boolean;
  onEdit?: (model: InferenceModel) => void;
  sortable?: boolean;
}) {
  return (
    <SimpleTable
      columns={columns}
      rows={models}
      getRowKey={(row) => row.id}
      loading={loading}
      emptyMessage={
        hasConnections ? "No inference models published" : "Connect a provider before adding models"
      }
      onRowClick={onEdit}
      rowRenderer={
        sortable ? (props) => <SortableModelRow {...props} disabled={reordering} /> : undefined
      }
    />
  );
}

function SortableModelRow({
  row,
  className,
  onClick,
  children,
  disabled,
}: SimpleTableRowRenderProps<InferenceModel> & { disabled: boolean }) {
  const sortable = useSortable({ id: row.id, disabled });
  return (
    <ModelDragHandleContext.Provider
      value={{
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
      }}
    >
      <tr
        ref={sortable.setNodeRef}
        style={{
          transform: CSS.Transform.toString(sortable.transform),
          transition: sortable.transition,
        }}
        className={cn(
          className,
          "touch-none cursor-grab active:cursor-grabbing",
          sortable.isDragging && "relative z-10 bg-accent opacity-70"
        )}
        onClick={onClick}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        {children}
      </tr>
    </ModelDragHandleContext.Provider>
  );
}

function ModelDragHandle({ model, disabled }: { model: InferenceModel; disabled: boolean }) {
  const sortable = useContext(ModelDragHandleContext);
  if (!sortable) return null;
  return (
    <Button
      ref={sortable.setActivatorNodeRef}
      variant="ghost"
      size="icon"
      className="cursor-grab text-muted-foreground active:cursor-grabbing"
      disabled={disabled}
      aria-label={`Reorder ${model.displayName}`}
      title={`Reorder ${model.displayName}`}
      onClick={(event) => event.stopPropagation()}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical />
    </Button>
  );
}
