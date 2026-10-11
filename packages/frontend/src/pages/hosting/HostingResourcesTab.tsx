import {
  EllipsisVertical,
  Loader2,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { HostingResizeDialog } from "@/components/nodes/HostingResizeDialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { createClientUuid } from "@/lib/client-id";
import { performHostingAction } from "@/lib/hosting-intents";
import { hostingNodeLabel, hostingOperationPending, hostingPowerLabel } from "@/lib/hosting-status";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  HostingAction,
  HostingActionInput,
  HostingCatalog,
  HostingConnector,
  HostingOperation,
  HostingResource,
} from "@/types/hosting";

export interface HostingResourcesTabProps {
  connector: HostingConnector;
  catalog?: HostingCatalog | null;
  resources: HostingResource[];
  operations: HostingOperation[];
  loading?: boolean;
  onInstall?: (resource: HostingResource) => void;
  onChanged?: () => void;
}
const LABELS: Record<HostingOperation["action"], string> = {
  create: "Create VM",
  install: "Install Opfield",
  topup: "Top-up",
  start: "Power on",
  shutdown: "Shutdown",
  reboot: "Reboot",
  resize: "Resize",
  delete: "Destroy provider resource",
  recover: "Restart daemon",
  snapshot_create: "Create snapshot",
  snapshot_delete: "Delete snapshot",
  snapshot_restore: "Restore snapshot",
};
const TERMINAL = new Set<HostingOperation["phase"]>(["ready", "failed"]);
type HostingResourceRow =
  | { id: string; resource: HostingResource }
  | { id: string; operation: HostingOperation };
const MENU_ACTIONS = [
  { action: "start" as const, label: "Power on", Icon: Power, confirm: false },
  { action: "shutdown" as const, label: "Shutdown", Icon: Power, confirm: true },
  { action: "reboot" as const, label: "Reboot", Icon: RotateCcw, confirm: true },
  { action: "recover" as const, label: "Restart daemon", Icon: RotateCcw, confirm: true },
];

function variant(state: string): "success" | "secondary" | "warning" | "destructive" {
  if (state === "running") return "success";
  if (state === "stopped") return "secondary";
  if (state === "unknown") return "destructive";
  return "warning";
}
function latest(
  resource: HostingResource,
  operations: HostingOperation[]
): HostingOperation | null {
  return (
    operations
      .filter((item) => item.resourceId === resource.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}
function scopeAction(action: HostingAction): "power" | "resize" | "delete" | "recover" {
  return action === "start" || action === "shutdown" || action === "reboot" ? "power" : action;
}
function menuItem(
  action: string,
  label: string,
  Icon: typeof Power,
  disabled: boolean,
  onSelect: () => void
) {
  return (
    <DropdownMenuItem key={action} disabled={disabled} onSelect={onSelect}>
      <Icon />
      {label}
    </DropdownMenuItem>
  );
}
function nameCell(resource: HostingResource): ReactNode {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{resource.name}</p>
      <p className="truncate text-xs text-muted-foreground">
        {resource.kind.toUpperCase()} · seen <RelativeTime value={resource.observedAt} />
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {resource.cpu ?? "—"} vCPU · {resource.memoryMb ?? "—"} MB · {resource.diskGb ?? "—"} GB
      </p>
    </div>
  );
}
/** Providers with numeric location IDs (CloudBlast) are shown by their catalog name. */
function locationName(location: string | undefined, catalog?: HostingCatalog | null): string {
  if (!location) return "—";
  return catalog?.locations.find((item) => item.id === location)?.name ?? location;
}
function providerCell(resource: HostingResource, catalog?: HostingCatalog | null): ReactNode {
  return (
    <div className="min-w-0">
      <span className="block truncate">{locationName(resource.location, catalog)}</span>
      <code className="block truncate text-xs">{resource.remoteId}</code>
    </div>
  );
}
function stateCell(resource: HostingResource, operation?: HostingOperation | null): ReactNode {
  const state = hostingPowerLabel(resource, operation);
  return (
    <div>
      <Badge variant={variant(state)} size="inline">
        {state}
      </Badge>
      <p className="mt-1 text-xs text-muted-foreground">{resource.origin}</p>
    </div>
  );
}
function bindingCell(resource: HostingResource, operation: HostingOperation | null): ReactNode {
  return (
    <div className="min-w-0">
      {(operation || resource.nodes.length > 0) && (
        <Badge
          size="inline"
          variant={
            operation?.phase === "failed"
              ? "destructive"
              : hostingOperationPending(operation)
                ? "warning"
                : resource.nodes.some((node) => node.status === "online")
                  ? "success"
                  : "secondary"
          }
        >
          {operation && (hostingOperationPending(operation) || operation.phase === "failed")
            ? hostingNodeLabel(operation)
            : (resource.nodes[0]?.status ?? "Pending")}
        </Badge>
      )}
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {resource.nodes.length
          ? resource.nodes.map((node) => `${node.name} · ${node.type}`).join(", ")
          : (operation?.node?.name ??
            (hostingOperationPending(operation) ? "Node setup" : "Unbound"))}
      </p>
    </div>
  );
}

export function HostingResourcesTab({
  connector,
  catalog,
  resources,
  operations,
  loading,
  onInstall,
  onChanged,
}: HostingResourcesTabProps) {
  const { hasScope, hasScopedAccess } = useAuthStore();
  const [localOperations, setLocalOperations] = useState<Record<string, HostingOperation>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<{
    resource: HostingResource;
    operation: HostingOperation;
  } | null>(null);
  const displayedRetry = useRetainedDialogValue(retryTarget, Boolean(retryTarget));
  const [retrySsh, setRetrySsh] = useState("");
  const [sshOptions, setSshOptions] = useState<Array<{ value: string; label: string }>>([]);
  // The retry target whose SSH connections have loaded; the dialog opens with them.
  const [sshLoadedFor, setSshLoadedFor] = useState<typeof retryTarget>(null);
  const sshOptionsLoading =
    !!retryTarget && hasScope("integrations:ssh:use") && sshLoadedFor !== retryTarget;
  useEffect(() => {
    if (!retryTarget) return;
    let cancelled = false;
    setRetrySsh("");
    setSshOptions([]);
    if (hasScope("integrations:ssh:use")) {
      void api
        .listExternalSshConnectors()
        .then((items) => {
          if (!cancelled)
            setSshOptions(items.map((item) => ({ value: item.id, label: item.name })));
        })
        .catch((error) => {
          if (!cancelled)
            toast.error(error instanceof Error ? error.message : "Could not load SSH connections");
        })
        .finally(() => {
          if (!cancelled) setSshLoadedFor(retryTarget);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [retryTarget, hasScope]);
  const [resizeResource, setResizeResource] = useState<HostingResource | null>(null);
  const operationFor = (resource: HostingResource) => {
    const remote = latest(resource, operations);
    const local = localOperations[resource.id];
    return !local || (remote && remote.updatedAt > local.updatedAt) ? remote : local;
  };
  const managed = (resource: HostingResource) =>
    resource.origin === "created" || resource.origin === "adopted";
  const canAction = (resource: HostingResource, action: HostingAction) => {
    const scope = scopeAction(action);
    const actionAllowed =
      hasScope(`hosting:resources:${scope}`) ||
      hasScope(`hosting:resources:${scope}:${resource.id}`);
    const nodesVisible = resource.nodes.every(
      (node) =>
        hasScope(`nodes:details:${node.id}`) &&
        hasScope(`${action === "delete" ? "nodes:delete" : "nodes:manage"}:${node.id}`)
    );
    return (
      managed(resource) &&
      connector.enabled &&
      !resource.missingSince &&
      actionAllowed &&
      nodesVisible &&
      resource.capabilities[action]?.available === true
    );
  };
  const reconcile = async (operation: HostingOperation) => {
    setPending(`reconcile:${operation.id}`);
    try {
      const next = await api.reconcileHostingOperation(operation.id);
      if (next.resourceId)
        setLocalOperations((current) => ({ ...current, [next.resourceId!]: next }));
      toast[next.phase === "unknown" ? "warning" : "success"](
        next.phase === "unknown" ? "Waiting for provider confirmation" : "Operation status updated"
      );
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation reconciliation failed");
    } finally {
      setPending(null);
    }
  };
  const retryInstall = async () => {
    if (!retryTarget || pending) return;
    const target = retryTarget;
    setPending(`${target.resource.id}:install`);
    try {
      const operation = await api.retryHostingInstall(target.operation.id, {
        idempotencyKey: createClientUuid(),
        ...(retrySsh ? { sshConnectorId: retrySsh } : {}),
      });
      setLocalOperations((current) => ({ ...current, [target.resource.id]: operation }));
      setRetryTarget((current) => (current === target ? null : current));
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not retry installation");
      onChanged?.();
    } finally {
      setPending(null);
    }
  };
  const dispatch = async (
    resource: HostingResource,
    action: HostingAction,
    extra: Partial<Pick<HostingActionInput, "size" | "cpu" | "memoryMb" | "diskGb">> & {
      confirmedPrice?: { amount: string; currency: string };
    } = {}
  ) => {
    if (pending || !canAction(resource, action)) return;
    if (!resource.incarnation) {
      toast.error("Refresh before managing a resource without an immutable incarnation.");
      return;
    }
    setPending(`${resource.id}:${action}`);
    try {
      const operation = await performHostingAction(resource.id, {
        action,
        expectedIncarnation: resource.incarnation,
        confirmed: true,
        ...extra,
      });
      setLocalOperations((current) => ({ ...current, [resource.id]: operation }));
      if (operation.phase === "unknown") toast.info("Waiting for provider confirmation");
      else if (operation.phase === "failed")
        toast.error(operation.errorMessage || "Provider action failed");
      else toast.success(`${LABELS[action]} requested`);
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Provider action failed");
      onChanged?.();
    } finally {
      setPending(null);
    }
  };
  const confirmAction = async (resource: HostingResource, action: HostingAction) => {
    const description =
      action === "delete"
        ? `${connector.provider === "hostkey" ? "Cancel rental of" : "Permanently destroy"} “${resource.name}” (${resource.remoteId}) and its associated Opfield nodes. Proxmox VMs are shut down first. All hosted roles and workloads are affected: ${resource.nodes.map((node) => node.name).join(", ") || "none"}.`
        : `${LABELS[action]} on provider VM “${resource.name}” (${resource.remoteId})? All hosted roles and workloads are affected: ${resource.nodes.map((node) => node.name).join(", ") || "none"}.${action === "recover" ? " Only the Opfield daemon services will restart; the VM is not rebooted or reinstalled." : ""}`;
    if (
      await confirm({
        title:
          action === "delete" && connector.provider === "hostkey"
            ? "Cancel server rental"
            : LABELS[action],
        description,
        confirmLabel:
          action === "delete" && connector.provider === "hostkey"
            ? "Cancel rental"
            : LABELS[action],
        variant: action === "delete" ? "destructive" : "default",
      })
    )
      await dispatch(resource, action);
  };
  const resourceColumns: SimpleTableColumn<HostingResource>[] = [
    {
      id: "name",
      header: "Name",
      render: nameCell,
    },
    {
      id: "provider",
      header: "Host / provider ID",
      render: (resource) => providerCell(resource, catalog),
    },
    {
      id: "state",
      header: "Power state",
      render: (resource) => stateCell(resource, operationFor(resource)),
    },
    {
      id: "binding",
      header: "Opfield nodes",
      render: (resource) => bindingCell(resource, operationFor(resource)),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (resource) => {
        const currentOperation = operationFor(resource);
        const busy =
          pending?.startsWith(`${resource.id}:`) ||
          (currentOperation && !TERMINAL.has(currentOperation.phase));
        const canMenu =
          MENU_ACTIONS.some(({ action }) => canAction(resource, action)) ||
          canAction(resource, "resize") ||
          canAction(resource, "delete");
        const canInstall =
          Boolean(onInstall) &&
          resource.origin === "discovered" &&
          resource.nodes.length === 0 &&
          connector.enabled &&
          hasScope(`hosting:resources:create:${connector.id}`) &&
          hasScopedAccess("nodes:create") &&
          hasScope(`hosting:resources:recover:${resource.id}`) &&
          (resource.capabilities.bootstrap?.available === true || hasScope("integrations:ssh:use"));
        const canReconcile = currentOperation?.phase === "unknown";
        const canRetry =
          connector.enabled &&
          !resource.missingSince &&
          currentOperation?.phase === "failed" &&
          !!currentOperation.nodeId &&
          ["create", "install"].includes(currentOperation.action) &&
          hasScope(`hosting:resources:recover:${resource.id}`) &&
          hasScope(`nodes:manage:${currentOperation.nodeId}`) &&
          (resource.capabilities.bootstrap.available || hasScope("integrations:ssh:use"));
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Manage ${resource.name}`}
                disabled={
                  pending === `reconcile:${currentOperation?.id}` ||
                  (!canReconcile &&
                    ((!canMenu && !canInstall && !canRetry) ||
                      Boolean(busy) ||
                      !resource.incarnation))
                }
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <EllipsisVertical className="h-4 w-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canReconcile && (
                <DropdownMenuItem onSelect={() => void reconcile(currentOperation)}>
                  <RefreshCw /> Reconcile
                </DropdownMenuItem>
              )}
              {canInstall && !busy && (
                <DropdownMenuItem onSelect={() => onInstall?.(resource)}>
                  <Server />
                  Install Opfield
                </DropdownMenuItem>
              )}
              {canRetry && !busy && (
                <DropdownMenuItem
                  disabled={resource.powerState !== "running"}
                  onSelect={() => setRetryTarget({ resource, operation: currentOperation })}
                >
                  <RotateCcw /> Retry installation
                </DropdownMenuItem>
              )}
              {MENU_ACTIONS.map(({ action, label, Icon, confirm: requiresConfirm }) =>
                menuItem(
                  action,
                  label,
                  Icon,
                  Boolean(busy) || !canAction(resource, action),
                  () =>
                    void (requiresConfirm
                      ? confirmAction(resource, action)
                      : dispatch(resource, action))
                )
              )}
              {menuItem(
                "resize",
                "Resize configuration",
                RefreshCw,
                Boolean(busy) || !canAction(resource, "resize"),
                () => {
                  setResizeResource(resource);
                }
              )}
              <DropdownMenuSeparator />
              {menuItem(
                "delete",
                connector.provider === "hostkey"
                  ? "Cancel server rental"
                  : "Destroy provider resource",
                Trash2,
                Boolean(busy) || !canAction(resource, "delete"),
                () => void confirmAction(resource, "delete")
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  // The accepted node exists before its provider VM does. Keep it visible without
  // inventing a provider resource or exposing power/destruction actions prematurely.
  const awaitingResources = operations.filter(
    (operation) =>
      operation.action === "create" &&
      operation.nodeId &&
      operation.phase !== "ready" &&
      !resources.some(
        (resource) =>
          resource.id === operation.resourceId ||
          resource.nodes.some((node) => node.id === operation.nodeId)
      )
  );
  const rows: HostingResourceRow[] = [
    ...awaitingResources.map((operation) => ({ id: `operation:${operation.id}`, operation })),
    ...resources.map((resource) => ({ id: resource.id, resource })),
  ];
  const columns: SimpleTableColumn<HostingResourceRow>[] = resourceColumns.map((column) => ({
    ...column,
    render: (row) => {
      if ("resource" in row) return column.render(row.resource);
      const operation = row.operation;
      if (column.id === "name")
        return (
          <div className="min-w-0">
            <p className="truncate font-medium">{operation.node?.name ?? "New node"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {operation.node?.type ?? "Opfield node"}
            </p>
          </div>
        );
      if (column.id === "provider")
        return (
          <div className="min-w-0">
            <span className="block truncate">
              {locationName(operation.node?.location, catalog)}
            </span>
            <span className="block text-xs text-muted-foreground">
              {operation.phase === "failed" ? "Creation failed" : "Awaiting provider ID"}
            </span>
          </div>
        );
      if (column.id === "state")
        return (
          <div className="min-w-0">
            <Badge variant={operation.phase === "failed" ? "destructive" : "warning"} size="inline">
              {operation.phase === "failed"
                ? "Failed"
                : operation.phase === "awaiting_payment"
                  ? "Awaiting payment"
                  : "Provisioning"}
            </Badge>
            <p className="mt-1 text-xs text-muted-foreground">
              {operation.phase === "failed" ? "Creation failed" : "Awaiting provider VM"}
            </p>
          </div>
        );
      if (column.id === "binding")
        return (
          <div className="min-w-0">
            <Badge variant={operation.phase === "failed" ? "destructive" : "warning"} size="inline">
              {operation.phase === "failed" ? "Provisioning failed" : hostingNodeLabel(operation)}
            </Badge>
            {operation.errorMessage && (
              <p className="mt-1 text-xs text-muted-foreground">{operation.errorMessage}</p>
            )}
          </div>
        );
      return "—";
    },
  }));

  return (
    <>
      <PanelShell
        title="Virtual machines"
        icon={<Server className="h-4 w-4" />}
        description="Provider inventory and VM actions. Power state does not indicate Opfield daemon availability."
      >
        <SimpleTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          loading={loading}
          emptyMessage="No provider resources found."
        />
      </PanelShell>
      <Dialog open={Boolean(retryTarget)} onOpenChange={(open) => !open && setRetryTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Retry Installation</DialogTitle>
            <DialogDescription>
              Install the daemon again on {displayedRetry?.resource.name}. The existing node and VM
              are reused; no new VM is ordered.
            </DialogDescription>
          </DialogHeader>
          {!displayedRetry?.resource.capabilities.bootstrap.available && (
            <SettingsControlRow
              title="Trusted SSH connection"
              description="Choose a connection to this VM."
            >
              <ContentLoading loading={sshOptionsLoading} />
              <Combobox
                ariaLabel="Retry SSH connection"
                value={retrySsh}
                onValueChange={setRetrySsh}
                options={sshOptions}
              />
            </SettingsControlRow>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRetryTarget(null)}>
              Cancel
            </Button>
            <Button
              pending={pending === `${displayedRetry?.resource.id}:install`}
              disabled={
                Boolean(pending) ||
                (!displayedRetry?.resource.capabilities.bootstrap.available && !retrySsh)
              }
              onClick={() => void retryInstall()}
            >
              Retry installation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <HostingResizeDialog
        resource={resizeResource}
        provider={connector.provider}
        catalog={catalog}
        onClose={() => setResizeResource(null)}
        onChanged={(operation) => {
          if (operation.resourceId)
            setLocalOperations((current) => ({ ...current, [operation.resourceId!]: operation }));
          onChanged?.();
        }}
      />
    </>
  );
}
