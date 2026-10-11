import { Check, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { ExternalSshConnector } from "@/types/integrations";
import { ExternalSshConnectorDialog } from "./ExternalSshConnectorDialog";

const CACHE_KEY = "settings:ssh-connectors";

export function ExternalSshIntegrationsSection() {
  const hasScope = useAuthStore((state) => state.hasScope);
  const canManage = hasScope("integrations:ssh:manage");
  const canView = canManage || hasScope("integrations:ssh:view");
  const cached = api.getCached<ExternalSshConnector[]>(CACHE_KEY);
  const [connectors, setConnectors] = useState<ExternalSshConnector[]>(() => cached ?? []);
  const [initialLoadComplete, setInitialLoadComplete] = useState(!canView || cached !== undefined);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<ExternalSshConnector | null>(null);
  const displayedEditingConnector = useRetainedDialogValue(
    editingConnector,
    editingConnector !== null
  );
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const refresh = useCallback(async () => {
    if (!canView) return;
    try {
      const data = await api.listExternalSshConnectors();
      api.setCache(CACHE_KEY, data);
      setConnectors(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load SSH connectors");
    } finally {
      setInitialLoadComplete(true);
    }
  }, [canView]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("integration.connector.changed", () => {
    void refresh();
  });

  const testConnector = async (connector: ExternalSshConnector) => {
    setTestingId(connector.id);
    try {
      await api.testExternalSshConnector(connector.id);
      toast.success(`SSH connection to ${connector.name} passed`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "SSH connection test failed");
    } finally {
      setTestingId(null);
    }
  };

  const deleteConnector = async (connector: ExternalSshConnector) => {
    const ok = await confirm({
      title: "Delete SSH Connector",
      description: `Delete "${connector.name}" and its encrypted credential?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(connector.id);
    try {
      await api.deleteExternalSshConnector(connector.id);
      toast.success("SSH connector deleted");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete SSH connector");
    } finally {
      setDeletingId(null);
    }
  };

  const syncConnector = async (connector: ExternalSshConnector) => {
    setSyncingId(connector.id);
    try {
      await api.syncExternalSshConnector(connector.id);
      toast.success(`SSH connector ${connector.name} synchronized`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "SSH connector sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const openEdit = (connector: ExternalSshConnector) => {
    setEditingConnector(connector);
    setEditName(connector.name);
  };

  const saveEdit = async () => {
    if (!editingConnector || !editName.trim()) return;
    setSavingEdit(true);
    try {
      await api.updateExternalSshConnector(editingConnector.id, editName.trim());
      toast.success("SSH connector saved");
      setEditingConnector(null);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save SSH connector");
    } finally {
      setSavingEdit(false);
    }
  };

  useContentLoading(canView && !initialLoadComplete);

  if (!canView || !initialLoadComplete) return null;

  const connectorNames = new Map(connectors.map((connector) => [connector.id, connector.name]));

  return (
    <>
      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        title="External SSH Integrations"
        description="Encrypted credentials for external servers only. Gateway and managed nodes use their dedicated tools."
        actions={
          canManage ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              Add connector
            </Button>
          ) : null
        }
      >
        {connectors.length ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <SshConnectorRow
                key={connector.id}
                connector={connector}
                jumpConnectorName={
                  connector.jumpConnectorId
                    ? (connectorNames.get(connector.jumpConnectorId) ?? "Unknown jump server")
                    : null
                }
                canManage={canManage}
                testing={testingId === connector.id}
                syncing={syncingId === connector.id}
                deleting={deletingId === connector.id}
                onOpen={canManage ? () => openEdit(connector) : undefined}
                onTest={() => void testConnector(connector)}
                onSync={() => void syncConnector(connector)}
                onDelete={() => void deleteConnector(connector)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message="No external SSH connectors configured."
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? () => setOpen(true) : undefined}
            embedded
          />
        )}
      </PanelShell>
      <ExternalSshConnectorDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
          void refresh();
        }}
      />
      <Dialog
        open={editingConnector !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !savingEdit) setEditingConnector(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>SSH Connector</DialogTitle>
            <DialogDescription>
              Rename this connector. Connection and credential details stay unchanged.
            </DialogDescription>
          </DialogHeader>
          {displayedEditingConnector ? (
            <PanelShell
              title="Connector"
              description="Display name used across Gateway."
              icon={<KeyRound className="h-4 w-4" />}
            >
              <SettingsControlRow title="Connector name">
                <Input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  autoFocus
                />
              </SettingsControlRow>
              <SettingsControlRow title="Connection">
                <span className="text-sm text-muted-foreground">
                  {displayedEditingConnector.username}@{displayedEditingConnector.host}:
                  {displayedEditingConnector.port}
                </span>
              </SettingsControlRow>
            </PanelShell>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingConnector(null)}
              disabled={savingEdit}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveEdit()}
              disabled={!editName.trim()}
              pending={savingEdit}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SshConnectorRow({
  connector,
  jumpConnectorName,
  canManage,
  testing,
  syncing,
  deleting,
  onOpen,
  onTest,
  onSync,
  onDelete,
}: {
  connector: ExternalSshConnector;
  jumpConnectorName: string | null;
  canManage: boolean;
  testing: boolean;
  syncing: boolean;
  deleting: boolean;
  onOpen?: () => void;
  onTest: () => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 p-4 transition-colors lg:flex-row lg:items-center lg:justify-between",
        onOpen && "cursor-pointer hover:bg-accent/50"
      )}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-muted">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{connector.name}</p>
            <Badge variant={connector.enabled ? "secondary" : "outline"} size="inline">
              {connector.enabled ? "enabled" : "disabled"}
            </Badge>
            <Badge variant="outline" size="inline">
              {connector.authMethod === "password" ? "password" : "generated key"}
            </Badge>
            <Badge
              variant={connector.testStatus === "error" ? "destructive" : "outline"}
              size="inline"
            >
              {connector.testStatus}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {connector.username}@{connector.host}:{connector.port}
            {jumpConnectorName ? ` · via ${jumpConnectorName}` : " · Direct connection"}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Host fingerprint {connector.hostFingerprint}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {connector.testedAt ? (
              <>
                Tested <RelativeTime value={connector.testedAt} />
              </>
            ) : (
              "Never tested"
            )}
            {connector.testLastError ? ` · ${connector.testLastError}` : ""}
          </p>
        </div>
      </div>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-2 lg:self-center">
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onTest();
            }}
            disabled={syncing}
            pending={testing}
            title="Test connector"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onSync();
            }}
            disabled={testing}
            pending={syncing}
            title="Sync connector"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            pending={deleting}
            title="Delete connector"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
