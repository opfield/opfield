import { Check, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRealtime } from "@/hooks/use-realtime";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { HOSTING_PROVIDER_LABELS, type HostingConnector } from "@/types/hosting";
import { HostingConnectorDialog } from "../hosting/HostingConnectorDialog";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function HostingIntegrationsSection({
  title = "Hosting Integrations",
  onConnectorsChange,
}: {
  title?: string;
  onConnectorsChange?: (connectors: HostingConnector[]) => void;
} = {}) {
  const { hasScopedAccess, hasScope } = useAuthStore();
  const canView = hasScopedAccess("integrations:hosting:view");
  const canManage = hasScope("integrations:hosting:manage");
  const navigate = useStableNavigate();
  const location = useLocation();
  const [connectors, setConnectors] = useState<HostingConnector[]>([]);
  // The first load settles once; later loads (retry, realtime) update in place.
  const [initialLoadSettled, setInitialLoadSettled] = useState(false);
  const loading = canView && !initialLoadSettled;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<HostingConnector | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const initialLoadComplete = useRef(false);
  useContentLoading(loading);
  const navigationHighlighted = useScrollToNavigationTarget("hosting-integrations", !loading, {
    block: "center",
    highlightDurationMs: 2200,
  });

  const loadConnectors = useCallback(async () => {
    if (!canView) return;
    const generation = ++loadGeneration.current;
    try {
      const result = (await api.listHostingConnectors()) ?? [];
      if (generation !== loadGeneration.current) return;
      setLoadError(null);
      setConnectors(result);
      initialLoadComplete.current = true;
      onConnectorsChange?.(result);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      const message = errorMessage(error, "Failed to load hosting integrations.");
      if (!initialLoadComplete.current) setLoadError(message);
      toast.error(message);
    } finally {
      if (generation === loadGeneration.current) setInitialLoadSettled(true);
    }
  }, [canView, onConnectorsChange]);

  useEffect(() => {
    void loadConnectors();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadConnectors]);

  useRealtime(
    canView ? "integration.connector.changed" : null,
    () => {
      void loadConnectors();
    },
    { onReconnect: loadConnectors }
  );

  if (!canView) return null;

  const openCreateDialog = () => {
    setEditingConnector(null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingConnector(null);
  };

  const testConnector = async (connector: HostingConnector) => {
    setTestingId(connector.id);
    try {
      await api.testHostingConnector(connector.id);
      toast.success(`${connector.name} connection test passed`);
      void loadConnectors();
    } catch (error) {
      toast.error(errorMessage(error, "Hosting connection test failed."));
    } finally {
      setTestingId(null);
    }
  };

  const syncConnector = async (connector: HostingConnector) => {
    setSyncingId(connector.id);
    try {
      await api.syncHostingConnector(connector.id);
      toast.success(`${connector.name} resources synced`);
      void loadConnectors();
    } catch (error) {
      toast.error(errorMessage(error, "Hosting resource sync failed."));
    } finally {
      setSyncingId(null);
    }
  };

  const deleteConnector = async (connector: HostingConnector) => {
    const confirmed = await confirm({
      title: "Delete Hosting Connector",
      description: `Disconnect “${connector.name}”? Provider VMs, Gateway nodes and their identity bindings are retained. No rental is cancelled.`,
      confirmLabel: "Delete connector",
    });
    if (!confirmed) return;

    setDeletingId(connector.id);
    try {
      await api.deleteHostingConnector(connector.id);
      toast.success("Hosting connector deleted");
      void loadConnectors();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete hosting connector."));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <PanelShell
        id="hosting-integrations"
        className={cn(navigationHighlighted && "navigation-target-ripple")}
        icon={<Server className="h-4 w-4" />}
        title={title}
        description="Connect provider inventory, VM management and supported account finances."
        actions={
          canManage ? (
            <Button onClick={openCreateDialog}>
              <Plus />
              Add connector
            </Button>
          ) : undefined
        }
      >
        {loading ? null : loadError ? (
          <EmptyState
            message={loadError}
            actionLabel="Retry"
            onAction={() => void loadConnectors()}
            embedded
          />
        ) : !connectors.length ? (
          <EmptyState
            message="No hosting connectors configured."
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? openCreateDialog : undefined}
            embedded
          />
        ) : (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <div
                key={connector.id}
                className="flex flex-col gap-3 p-4 transition-colors lg:flex-row lg:items-center lg:justify-between cursor-pointer hover:bg-accent/50"
                role="link"
                tabIndex={0}
                aria-label={`Open ${connector.name}`}
                onClick={() =>
                  navigate(`/hosting/${connector.id}`, {
                    state: createReturnNavigationState(location),
                  })
                }
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || event.key !== "Enter") return;
                  event.preventDefault();
                  navigate(`/hosting/${connector.id}`, {
                    state: createReturnNavigationState(location),
                  });
                }}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
                    <Server className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{connector.name}</p>
                      <Badge variant={connector.enabled ? "secondary" : "outline"} size="inline">
                        {connector.enabled ? "enabled" : "disabled"}
                      </Badge>
                      <Badge
                        variant={connector.syncStatus === "error" ? "destructive" : "outline"}
                        size="inline"
                      >
                        {connector.syncStatus}
                      </Badge>
                      <Badge variant="outline" size="inline">
                        {HOSTING_PROVIDER_LABELS[connector.provider]}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connector.syncedAt ? (
                        <>
                          Synced <RelativeTime value={connector.syncedAt} />
                        </>
                      ) : (
                        "Never synced"
                      )}
                      {connector.testedAt && (
                        <>
                          {" · Tested "}
                          <RelativeTime value={connector.testedAt} />
                        </>
                      )}
                      {connector.syncLastError ? ` · ${connector.syncLastError}` : ""}
                    </p>
                  </div>
                </div>
                {hasScope(`integrations:hosting:manage:${connector.id}`) && (
                  <div className="flex shrink-0 items-center gap-2 lg:self-center">
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Test ${connector.name}`}
                      pending={testingId === connector.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void testConnector(connector);
                      }}
                    >
                      <Check />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Sync ${connector.name}`}
                      disabled={connector.syncStatus === "running"}
                      pending={syncingId === connector.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void syncConnector(connector);
                      }}
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`Disconnect ${connector.name}`}
                      pending={deletingId === connector.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteConnector(connector);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelShell>
      <HostingConnectorDialog
        open={dialogOpen}
        connector={editingConnector}
        onClose={closeDialog}
        onSaved={() => void loadConnectors()}
      />
    </>
  );
}
