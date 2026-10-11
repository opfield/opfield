import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
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
import { motion } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Folder,
  Network,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  Children,
  type ComponentPropsWithoutRef,
  forwardRef,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  SimpleTable,
  type SimpleTableColumn,
  type SimpleTableRowRenderProps,
} from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import { InferenceProviderConnectDialog } from "./InferenceProviderConnectDialog";
import { InferenceProviderDialog } from "./InferenceProviderDialog";
import { connectionIdentity, formatWorstQuota, HealthBadge } from "./inference-provider-ui";

const PROVIDER_CATALOG_CACHE_KEY = "req:/api/inference/providers/catalog";
const PROVIDER_CONNECTIONS_CACHE_KEY = "req:/api/inference/providers/connections";

interface ProviderGroupRow {
  kind: "group";
  id: string;
  providerId: string;
  connections: InferenceProviderConnection[];
}

interface ProviderConnectionRow {
  kind: "connection";
  id: string;
  connection: InferenceProviderConnection;
  grouped: boolean;
  collapsed: boolean;
}

type ProviderTableRow = ProviderGroupRow | ProviderConnectionRow;

export function reorderProviderConnections(
  connections: InferenceProviderConnection[],
  activeId: string,
  overId: string
) {
  const active = connections.find((connection) => connection.id === activeId);
  const over = connections.find((connection) => connection.id === overId);
  if (!active || !over || active.providerId !== over.providerId || active.id === over.id) {
    return connections;
  }
  const siblings = connections.filter((connection) => connection.providerId === active.providerId);
  const oldIndex = siblings.findIndex((connection) => connection.id === activeId);
  const newIndex = siblings.findIndex((connection) => connection.id === overId);
  if (oldIndex < 0 || newIndex < 0) return connections;
  const reordered = arrayMove(siblings, oldIndex, newIndex).map((connection, routingOrder) => ({
    ...connection,
    routingOrder,
  }));
  let siblingIndex = 0;
  return connections.map((connection) =>
    connection.providerId === active.providerId ? reordered[siblingIndex++]! : connection
  );
}

export function groupProviderConnections(
  connections: InferenceProviderConnection[],
  collapsedProviderIds: ReadonlySet<string> = new Set()
): ProviderTableRow[] {
  const groups = new Map<string, InferenceProviderConnection[]>();
  for (const connection of connections) {
    groups.set(connection.providerId, [...(groups.get(connection.providerId) ?? []), connection]);
  }
  return [...groups.entries()].flatMap(([providerId, providerConnections]) => {
    if (providerConnections.length === 1) {
      const connection = providerConnections[0]!;
      return [
        { kind: "connection", id: connection.id, connection, grouped: false, collapsed: false },
      ];
    }
    const group: ProviderGroupRow = {
      kind: "group",
      id: `provider-group:${providerId}`,
      providerId,
      connections: providerConnections,
    };
    return [
      group,
      ...providerConnections.map(
        (connection): ProviderConnectionRow => ({
          kind: "connection",
          id: connection.id,
          connection,
          grouped: true,
          collapsed: collapsedProviderIds.has(providerId),
        })
      ),
    ];
  });
}

export function InferenceProvidersPanel({
  onConnectionsChanged,
  refreshToken = 0,
}: {
  onConnectionsChanged?: () => void;
  refreshToken?: number;
}) {
  const canManage = useAuthStore((state) => state.hasScope("inference:providers:manage"));
  const cachedCatalog = api.getCached<InferenceProviderCatalogItem[]>(
    PROVIDER_CATALOG_CACHE_KEY,
    Number.POSITIVE_INFINITY
  );
  const cachedConnections = api.getCached<InferenceProviderConnection[]>(
    PROVIDER_CONNECTIONS_CACHE_KEY,
    Number.POSITIVE_INFINITY
  );
  const hasCachedData = cachedCatalog !== undefined && cachedConnections !== undefined;
  const [catalog, setCatalog] = useState<InferenceProviderCatalogItem[]>(cachedCatalog ?? []);
  const [connections, setConnections] = useState<InferenceProviderConnection[]>(
    cachedConnections ?? []
  );
  const [loading, setLoading] = useState(!hasCachedData);
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverlayWidth, setDragOverlayWidth] = useState<number | null>(null);
  const [dragOverlayColumnWidths, setDragOverlayColumnWidths] = useState<number[]>([]);
  const [collapsedProviderIds, setCollapsedProviderIds] = useState<Set<string>>(() => new Set());
  const initializedRef = useRef(hasCachedData);
  useContentLoading(loading);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const providers = useMemo(
    () => new Map(catalog.map((provider) => [provider.id, provider])),
    [catalog]
  );
  const selectedConnection = connections.find((connection) => connection.id === selectedId) ?? null;
  const selectedProvider = selectedConnection
    ? (providers.get(selectedConnection.providerId) ?? null)
    : null;
  const rows = useMemo(
    () => groupProviderConnections(connections, collapsedProviderIds),
    [collapsedProviderIds, connections]
  );
  const sortableConnectionIds = rows.flatMap((row) =>
    row.kind === "connection" && row.grouped && !row.collapsed ? [row.id] : []
  );
  const activeDragConnection = activeDragId
    ? (connections.find((connection) => connection.id === activeDragId) ?? null)
    : null;
  const hasReorderableGroups = connections.some(
    (connection, index) =>
      connections.findIndex((candidate) => candidate.providerId === connection.providerId) !== index
  );

  const toggleProviderGroup = (providerId: string) => {
    setCollapsedProviderIds((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const load = useCallback(
    async ({ showLoading = !initializedRef.current }: { showLoading?: boolean } = {}) => {
      if (showLoading) setLoading(true);
      try {
        const [nextCatalog, nextConnections] = await Promise.all([
          api.listInferenceProviderCatalog(),
          api.listInferenceProviderConnections(),
        ]);
        setCatalog(nextCatalog);
        setConnections(nextConnections);
        initializedRef.current = true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load inference providers");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void refreshToken;
    void load();
  }, [load, refreshToken]);

  const changed = async () => {
    await load({ showLoading: false });
    onConnectionsChanged?.();
  };

  const connected = async () => {
    // The settings page owns the controlled dialog state. Close it before the
    // background catalog refresh so a successful connection cannot leave the
    // reset form visible while provider data is reloaded.
    setConnectOpen(false);
    await changed();
  };

  const syncConnection = async (connection: InferenceProviderConnection) => {
    setSyncingId(connection.id);
    try {
      const synced = await api.syncInferenceProvider(connection.id);
      await changed();
      // The sync endpoint records a failed sync on the connection and still answers 200.
      if (synced.syncStatus === "error") {
        toast.error(
          synced.syncLastError
            ? `Provider sync failed: ${synced.syncLastError}`
            : "Provider sync failed"
        );
      } else {
        toast.success("Provider synchronized");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Provider sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const reorderConnections = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || reordering) return;
    const previous = connections;
    const next = reorderProviderConnections(previous, String(active.id), String(over.id));
    if (next === previous) return;
    const changedOrders = next.filter(
      (connection) =>
        previous.find((candidate) => candidate.id === connection.id)?.routingOrder !==
        connection.routingOrder
    );
    setConnections(next);
    setReordering(true);
    try {
      const results = await Promise.allSettled(
        changedOrders.map((connection) =>
          api.updateInferenceProvider(connection.id, { routingOrder: connection.routingOrder })
        )
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await changed();
      toast.success("Provider order updated");
    } catch (error) {
      setConnections(previous);
      await load({ showLoading: false });
      toast.error(error instanceof Error ? error.message : "Failed to update provider order");
    } finally {
      setReordering(false);
    }
  };

  const startReorder = ({ active }: DragStartEvent) => {
    const activeId = String(active.id);
    const sourceRow = [
      ...document.querySelectorAll<HTMLTableRowElement>("tr[data-provider-row-id]"),
    ].find((row) => row.dataset.providerRowId === activeId);
    setActiveDragId(activeId);
    setDragOverlayWidth(active.rect.current.initial?.width ?? null);
    setDragOverlayColumnWidths(
      sourceRow ? [...sourceRow.cells].map((cell) => cell.getBoundingClientRect().width) : []
    );
  };

  const finishReorder = (event: DragEndEvent) => {
    setActiveDragId(null);
    setDragOverlayWidth(null);
    setDragOverlayColumnWidths([]);
    void reorderConnections(event);
  };

  const cancelReorder = () => {
    setActiveDragId(null);
    setDragOverlayWidth(null);
    setDragOverlayColumnWidths([]);
  };

  const columns: SimpleTableColumn<ProviderTableRow>[] = [
    {
      id: "provider",
      header: "Provider",
      className: "w-[29%]",
      cellClassName: "w-[29%]",
      render: (row) => {
        if (row.kind === "group") {
          const provider = providers.get(row.providerId);
          const collapsed = collapsedProviderIds.has(row.providerId);
          const label = provider?.label ?? row.providerId;
          return (
            <Button
              variant="ghost"
              className="h-auto w-max max-w-none justify-start gap-2 p-0 font-normal hover:bg-transparent"
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleProviderGroup(row.providerId);
              }}
            >
              {collapsed ? <ChevronRight /> : <ChevronDown />}
              <Folder />
              <span className="whitespace-nowrap font-medium">{label}</span>
              <Badge variant="secondary" size="inline">
                {row.connections.length}
              </Badge>
            </Button>
          );
        }
        if (row.grouped) {
          const provider = providers.get(row.connection.providerId);
          return (
            <div className="flex items-center gap-2 pl-6">
              <CornerDownRight
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {provider?.label ?? row.connection.providerId}
                </p>
                <p className="text-xs text-muted-foreground">
                  {provider?.subscription ? "Subscription" : "API"}
                </p>
              </div>
            </div>
          );
        }
        const provider = providers.get(row.connection.providerId);
        return (
          <div>
            <p className="font-medium">{provider?.label ?? row.connection.providerId}</p>
            <p className="text-xs text-muted-foreground">
              {provider?.subscription ? "Subscription" : "API"}
            </p>
          </div>
        );
      },
    },
    {
      id: "account",
      header: "Account / key",
      className: "w-[19%]",
      cellClassName: "w-[19%]",
      render: (row) =>
        row.kind === "connection" ? (
          <div>
            <p>{row.connection.name}</p>
            <p className="text-xs text-muted-foreground">{connectionIdentity(row.connection)}</p>
          </div>
        ) : null,
    },
    {
      id: "health",
      header: "Health",
      className: "w-[13%]",
      cellClassName: "w-[13%]",
      render: (row) =>
        row.kind === "connection" ? (
          <HealthBadge status={row.connection.enabled ? row.connection.status : "disabled"} />
        ) : null,
    },
    {
      id: "quota",
      header: "Quota / balance",
      className: "w-[18%]",
      cellClassName: "w-[18%]",
      render: (row) => (row.kind === "connection" ? formatWorstQuota([row.connection]) : null),
    },
    {
      id: "sync",
      header: "Last sync",
      className: "w-[12%]",
      cellClassName: "w-[12%]",
      render: (row) =>
        row.kind === "connection" ? (
          <RelativeTime value={row.connection.lastSyncedAt} fallback="Never" />
        ) : null,
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      className: "w-[9%]",
      cellClassName: "w-[9%]",
      render: (row) =>
        canManage && row.kind === "connection" ? (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => void syncConnection(row.connection)}
              pending={syncingId === row.connection.id}
              aria-label={`Sync ${row.connection.name}`}
              title={`Sync ${row.connection.name}`}
            >
              <RefreshCw />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PanelShell
        icon={<Network className="h-4 w-4" />}
        title="Providers"
        description="Connected accounts and API credentials. Sequential follows connection order; Balanced weights new threads by remaining quota."
        actions={
          canManage ? (
            <Button onClick={() => setConnectOpen(true)}>
              <Plus />
              Connect provider
            </Button>
          ) : null
        }
      >
        {canManage && hasReorderableGroups ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={startReorder}
            onDragEnd={finishReorder}
            onDragCancel={cancelReorder}
          >
            <SortableContext items={sortableConnectionIds} strategy={verticalListSortingStrategy}>
              <SimpleTable
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.id}
                loading={loading}
                emptyMessage="No inference providers connected"
                onRowClick={(row) => {
                  if (row.kind === "group") toggleProviderGroup(row.providerId);
                  else setSelectedId(row.connection.id);
                }}
                rowClassName={(row) =>
                  row.kind === "group" ? "bg-muted/40" : row.grouped ? "bg-card" : undefined
                }
                rowRenderer={(props) => (
                  <ProviderTableRowRenderer {...props} disabled={reordering} sortable />
                )}
                tableClassName="table-fixed min-w-[860px]"
              />
            </SortableContext>
            {typeof document !== "undefined" &&
              createPortal(
                <DragOverlay dropAnimation={null} style={{ zIndex: 100 }}>
                  {activeDragConnection ? (
                    <ProviderDragOverlayRow
                      connection={activeDragConnection}
                      provider={providers.get(activeDragConnection.providerId)}
                      width={dragOverlayWidth}
                      columnWidths={dragOverlayColumnWidths}
                    />
                  ) : null}
                </DragOverlay>,
                document.body
              )}
          </DndContext>
        ) : (
          <SimpleTable
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            loading={loading}
            emptyMessage="No inference providers connected"
            onRowClick={(row) => {
              if (row.kind === "group") toggleProviderGroup(row.providerId);
              else setSelectedId(row.connection.id);
            }}
            rowClassName={(row) =>
              row.kind === "group" ? "bg-muted/40" : row.grouped ? "bg-card" : undefined
            }
            rowRenderer={(props) => (
              <ProviderTableRowRenderer {...props} disabled={reordering} sortable={false} />
            )}
            tableClassName="table-fixed min-w-[860px]"
          />
        )}
      </PanelShell>
      <InferenceProviderConnectDialog
        open={connectOpen}
        catalog={catalog}
        onOpenChange={setConnectOpen}
        onConnected={connected}
      />
      <InferenceProviderDialog
        open={selectedConnection !== null}
        connection={selectedConnection}
        provider={selectedProvider}
        canManage={canManage}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onChanged={changed}
      />
    </>
  );
}

function ProviderTableRowRenderer({
  row,
  className,
  onClick,
  children,
  disabled,
  sortable,
}: SimpleTableRowRenderProps<ProviderTableRow> & { disabled: boolean; sortable: boolean }) {
  if (row.kind !== "connection" || !row.grouped) {
    return (
      <tr className={className} onClick={onClick}>
        {children}
      </tr>
    );
  }
  if (!sortable) {
    return (
      <AnimatedProviderRow row={row} className={className} onClick={onClick}>
        {children}
      </AnimatedProviderRow>
    );
  }
  return (
    <SortableProviderRow
      row={row}
      className={className}
      onClick={onClick}
      disabled={disabled || row.collapsed}
    >
      {children}
    </SortableProviderRow>
  );
}

function SortableProviderRow({
  row,
  className,
  onClick,
  children,
  disabled,
}: Omit<SimpleTableRowRenderProps<ProviderConnectionRow>, "index" | "interactive"> & {
  disabled: boolean;
}) {
  const sortable = useSortable({
    id: row.id,
    disabled,
    data: { providerId: row.connection.providerId },
  });
  return (
    <AnimatedProviderRow
      ref={sortable.setNodeRef}
      row={row}
      data-provider-row-id={row.id}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        className,
        "touch-none cursor-grab active:cursor-grabbing",
        sortable.isDragging && "bg-accent opacity-30"
      )}
      onClick={onClick}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      {children}
    </AnimatedProviderRow>
  );
}

const AnimatedProviderRow = forwardRef<
  HTMLTableRowElement,
  Omit<ComponentPropsWithoutRef<"tr">, "children"> & {
    row: ProviderConnectionRow;
    children: ReactNode;
  }
>(function AnimatedProviderRow({ row, children, ...props }, ref) {
  const [collapsedComplete, setCollapsedComplete] = useState(row.collapsed);

  useEffect(() => {
    if (!row.collapsed) setCollapsedComplete(false);
  }, [row.collapsed]);

  return (
    <tr
      {...props}
      ref={ref}
      aria-hidden={row.collapsed || undefined}
      style={{
        ...props.style,
        display: row.collapsed && collapsedComplete ? "none" : undefined,
      }}
      className={cn(
        props.className,
        "transition-colors duration-200",
        row.collapsed && "pointer-events-none border-transparent"
      )}
    >
      {Children.map(children, (child) => {
        if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return child;
        return (
          <td key={child.key} className={cn(child.props.className, "py-0")}>
            <motion.div
              initial={false}
              animate={{ height: row.collapsed ? 0 : "auto", opacity: row.collapsed ? 0 : 1 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              className="overflow-hidden"
              onAnimationComplete={() => {
                if (row.collapsed) setCollapsedComplete(true);
              }}
            >
              <div className="py-3">{child.props.children}</div>
            </motion.div>
          </td>
        );
      })}
    </tr>
  );
});

function ProviderDragOverlayRow({
  connection,
  provider,
  width,
  columnWidths,
}: {
  connection: InferenceProviderConnection;
  provider: InferenceProviderCatalogItem | undefined;
  width: number | null;
  columnWidths: number[];
}) {
  return (
    <div
      className="max-w-[calc(100vw-2rem)] overflow-hidden border border-border bg-card shadow-lg"
      style={{ width: width ?? 860 }}
    >
      <table className="w-full table-fixed text-sm">
        {columnWidths.length > 0 && (
          <colgroup>
            {columnWidths.map((columnWidth, index) => (
              <col key={index} style={{ width: columnWidth }} />
            ))}
          </colgroup>
        )}
        <tbody>
          <tr>
            <td className="px-4 py-3 align-middle">
              <div className="flex items-center gap-2 pl-6">
                <CornerDownRight
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="truncate font-medium">{provider?.label ?? connection.providerId}</p>
                  <p className="text-xs text-muted-foreground">
                    {provider?.subscription ? "Subscription" : "API"}
                  </p>
                </div>
              </div>
            </td>
            <td className="px-4 py-3 align-middle">
              <div className="min-w-0">
                <p className="truncate">{connection.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {connectionIdentity(connection)}
                </p>
              </div>
            </td>
            <td className="px-4 py-3 align-middle">
              <HealthBadge status={connection.enabled ? connection.status : "disabled"} />
            </td>
            <td className="px-4 py-3 align-middle">{formatWorstQuota([connection])}</td>
            <td className="px-4 py-3 align-middle">
              <RelativeTime value={connection.lastSyncedAt} fallback="Never" />
            </td>
            <td className="px-4 py-3 text-right align-middle">
              <div className="flex justify-end">
                <Button variant="outline" size="icon" tabIndex={-1}>
                  <RefreshCw />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
