import { Check, Cloud, Globe2, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { CLOUDFLARE_API_TOKEN_URL } from "@/lib/cloudflare";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { CloudflareConnector, CloudflareConnectorSettings } from "@/types/integrations";

const DEFAULT_SETTINGS: CloudflareConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  defaultTtl: 1,
  defaultProxied: true,
};

const CAPABILITY_LABELS: Record<string, string> = {
  apiReachable: "API",
  tokenActive: "Token",
  zonesRead: "Zones",
  dnsRead: "DNS read",
  dnsEdit: "DNS edit",
};

function mergeSettings(
  settings?: Partial<CloudflareConnectorSettings>
): CloudflareConnectorSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}

function emptyForm() {
  return {
    name: "",
    token: "",
    enabled: true,
    settings: DEFAULT_SETTINGS,
  };
}

export function CloudflareIntegrationsSection() {
  const { hasScope } = useAuthStore();
  const canManage = hasScope("integrations:cloudflare:manage");
  const canView = canManage || hasScope("integrations:cloudflare:view");
  const [connectors, setConnectors] = useState<CloudflareConnector[]>(
    () => api.getCached<CloudflareConnector[]>("settings:cloudflare-connectors") ?? []
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    () =>
      !canView ||
      api.getCached<CloudflareConnector[]>("settings:cloudflare-connectors") !== undefined
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<CloudflareConnector | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);

  const loadConnectors = useCallback(async () => {
    if (!canView) return;
    try {
      const data = await api.listCloudflareConnectors();
      api.setCache("settings:cloudflare-connectors", data ?? []);
      setConnectors(data ?? []);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load Cloudflare integrations"
      );
    } finally {
      setInitialLoadComplete(true);
    }
  }, [canView]);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  useRealtime("integration.connector.changed", () => {
    void loadConnectors();
  });

  const openCreateDialog = () => {
    setEditingConnector(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEditDialog = async (connector: CloudflareConnector) => {
    setDialogOpen(true);
    setEditingConnector(connector);
    setLoadingDetail(true);
    try {
      const detail = await api.getCloudflareConnector(connector.id);
      setEditingConnector(detail);
      setForm({
        name: detail.name,
        token: "",
        enabled: detail.enabled,
        settings: mergeSettings(detail.settings),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load Cloudflare connector");
      setDialogOpen(false);
    } finally {
      setLoadingDetail(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
  };

  const updateSettings = (patch: Partial<CloudflareConnectorSettings>) => {
    setForm((current) => ({
      ...current,
      settings: mergeSettings({ ...current.settings, ...patch }),
    }));
  };

  const canSaveConnector =
    Boolean(form.name.trim()) && Boolean(editingConnector || form.token.trim());

  const validateForm = () => {
    if (!form.name.trim()) {
      toast.error("Connector name is required");
      return false;
    }
    if (!editingConnector && !form.token.trim()) {
      toast.error("Cloudflare API token is required");
      return false;
    }
    return true;
  };

  const testConnectionForDialog = async () => {
    if (!validateForm()) return false;
    setTestingConnection(true);
    try {
      if (editingConnector && !form.token.trim()) {
        const connector = await api.testCloudflareConnector(editingConnector.id);
        setEditingConnector(connector);
      } else {
        await api.previewCloudflareConnectorTest({ token: form.token.trim() });
      }
      toast.success("Cloudflare connection test passed");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cloudflare connection test failed");
      return false;
    } finally {
      setTestingConnection(false);
    }
  };

  const saveConnector = async () => {
    if (!validateForm()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        enabled: form.enabled,
        settings: form.settings,
      };
      if (editingConnector) {
        let updated = editingConnector;
        const settingsChanged = Object.entries(payload.settings).some(
          ([key, value]) =>
            editingConnector.settings[key as keyof CloudflareConnectorSettings] !== value
        );
        const detailsChanged =
          payload.name !== editingConnector.name ||
          payload.enabled !== editingConnector.enabled ||
          settingsChanged;
        if (form.token.trim()) {
          updated = await api.rotateCloudflareConnectorToken(
            editingConnector.id,
            form.token.trim()
          );
        }
        if (detailsChanged) {
          updated = await api.updateCloudflareConnector(editingConnector.id, payload);
        }
        setEditingConnector(updated);
        toast.success("Cloudflare connector saved");
      } else {
        await api.createCloudflareConnector({ ...payload, token: form.token.trim() });
        toast.success("Cloudflare connector created");
      }
      closeDialog();
      void loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Cloudflare connector");
    } finally {
      setSaving(false);
    }
  };

  const testConnector = async (connector: CloudflareConnector) => {
    setTestingId(connector.id);
    try {
      await api.testCloudflareConnector(connector.id);
      toast.success("Cloudflare connector test passed");
      void loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cloudflare connector test failed");
    } finally {
      setTestingId(null);
    }
  };

  const syncConnector = async (connector: CloudflareConnector) => {
    setSyncingId(connector.id);
    try {
      await api.syncCloudflareConnector(connector.id);
      toast.success("Cloudflare zones synced");
      void loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cloudflare sync failed");
    } finally {
      setSyncingId(null);
    }
  };

  const deleteConnector = async (connector: CloudflareConnector) => {
    const ok = await confirm({
      title: "Delete Cloudflare Connector",
      description: `Delete "${connector.name}" and its synced Cloudflare zone data?`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeletingId(connector.id);
    try {
      await api.deleteCloudflareConnector(connector.id);
      toast.success("Cloudflare connector deleted");
      void loadConnectors();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete Cloudflare connector");
    } finally {
      setDeletingId(null);
    }
  };

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  return (
    <>
      <PanelShell
        icon={<Cloud className="h-4 w-4" />}
        title="Cloudflare Integrations"
        description="System connectors for Cloudflare DNS-backed domains."
        actions={
          canManage ? (
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              Add connector
            </Button>
          ) : null
        }
      >
        {connectors.length > 0 ? (
          <div className="divide-y divide-border">
            {connectors.map((connector) => (
              <CloudflareConnectorRow
                key={connector.id}
                connector={connector}
                canManage={canManage}
                testing={testingId === connector.id}
                syncing={syncingId === connector.id || connector.syncStatus === "running"}
                deleting={deletingId === connector.id}
                onOpen={canManage ? () => void openEditDialog(connector) : undefined}
                onTest={() => void testConnector(connector)}
                onSync={() => void syncConnector(connector)}
                onDelete={() => void deleteConnector(connector)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            message="No Cloudflare connectors configured."
            actionLabel={canManage ? "Add connector" : undefined}
            onAction={canManage ? openCreateDialog : undefined}
            embedded
          />
        )}
      </PanelShell>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {editingConnector ? "Cloudflare Connector" : "Add Cloudflare Connector"}
            </DialogTitle>
            <DialogDescription>
              Configure the system API token used for Gateway-managed DNS records.
            </DialogDescription>
          </DialogHeader>

          {loadingDetail ? (
            // Reports the connector detail load to the dialog, which opens once it is ready.
            // One body child either way, so the dialog body keeps its layout.
            <ContentLoading loading />
          ) : (
            <div className="space-y-4">
              <div className="space-y-4">
                <Field label="Name">
                  <Input
                    value={form.name}
                    disabled={!canManage}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Production Cloudflare"
                  />
                </Field>
              </div>

              <Field label={editingConnector ? "Token" : "API Token"}>
                <p className="mb-2 text-xs text-muted-foreground">
                  Required Cloudflare token permissions: Zone:Read plus DNS:Read and DNS:Edit for
                  the zones Gateway should manage.
                </p>
                <div className="flex min-w-0 border border-input bg-background">
                  <Input
                    value={form.token}
                    disabled={!canManage}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, token: event.target.value }))
                    }
                    placeholder={editingConnector?.tokenMasked ?? "Cloudflare API token"}
                    type="password"
                    className="h-9 min-w-0 flex-1 rounded-none border-0 bg-transparent focus-visible:ring-0"
                  />
                  <Button
                    variant="ghost"
                    className="shrink-0 rounded-none border-l border-border bg-muted px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => void testConnectionForDialog()}
                    disabled={!editingConnector && !form.token.trim()}
                    pending={testingConnection}
                  >
                    Test Connection
                  </Button>
                </div>
                <a
                  href={CLOUDFLARE_API_TOKEN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex text-sm font-medium text-[color:var(--color-link)] hover:underline focus-visible:outline-none focus-visible:underline"
                >
                  Create API token →
                </a>
              </Field>

              <PanelShell
                title="DNS Defaults"
                description="Applied when a domain does not override them."
                icon={<SlidersHorizontal className="h-4 w-4" />}
              >
                <SettingsControlRow
                  title="Auto Sync"
                  description="Refresh Cloudflare zones in the background"
                >
                  <Select
                    value={String(form.settings.autoSyncIntervalSeconds)}
                    disabled={!canManage || !form.settings.autoSyncEnabled}
                    onValueChange={(value) =>
                      updateSettings({ autoSyncIntervalSeconds: Number(value) })
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="300">Every 5 minutes</SelectItem>
                      <SelectItem value="900">Every 15 minutes</SelectItem>
                      <SelectItem value="3600">Every hour</SelectItem>
                      <SelectItem value="86400">Daily</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsControlRow>
                <SettingsControlRow
                  title="Auto Sync Enabled"
                  description="Run scheduled zone syncs"
                >
                  <Switch
                    checked={form.settings.autoSyncEnabled}
                    disabled={!canManage}
                    onChange={(checked) => updateSettings({ autoSyncEnabled: checked })}
                  />
                </SettingsControlRow>
                <SettingsControlRow
                  title="TTL"
                  description="Cloudflare automatic TTL uses 1"
                  help="1 delegates TTL to Cloudflare Automatic. Other values are seconds and become the default for records without an explicit TTL."
                >
                  <Input
                    type="number"
                    value={form.settings.defaultTtl}
                    disabled={!canManage}
                    onChange={(event) =>
                      updateSettings({ defaultTtl: Number(event.target.value) || 1 })
                    }
                    className="w-48"
                  />
                </SettingsControlRow>
                <SettingsControlRow
                  title="Proxied"
                  description="Create records behind Cloudflare proxy by default"
                >
                  <Switch
                    checked={form.settings.defaultProxied}
                    disabled={!canManage}
                    onChange={(checked) => updateSettings({ defaultProxied: checked })}
                  />
                </SettingsControlRow>
              </PanelShell>

              {editingConnector && (
                <PanelShell
                  title="Synced Zones"
                  description="Read-only zones available to domain autodetection."
                  icon={<Globe2 className="h-4 w-4" />}
                >
                  {editingConnector.zones?.length ? (
                    <div className="divide-y divide-border">
                      {editingConnector.zones.map((zone) => (
                        <div key={zone.id} className="flex items-center justify-between px-3 py-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{zone.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {zone.accountName ?? "Cloudflare"} &middot; {zone.status ?? "unknown"}
                            </p>
                          </div>
                          <Badge variant="outline" size="inline">
                            {zone.remoteId}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="px-3 py-3 text-sm text-muted-foreground">No zones synced yet.</p>
                  )}
                </PanelShell>
              )}
            </div>
          )}

          <DialogFooter className="mt-4 shrink-0">
            <Button variant="ghost" onClick={closeDialog} disabled={saving}>
              {canManage ? "Cancel" : "Close"}
            </Button>
            {canManage && (
              <Button
                onClick={() => void saveConnector()}
                disabled={loadingDetail || !canSaveConnector}
                pending={saving}
              >
                {editingConnector ? "Save" : "Create Connector"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CloudflareConnectorRow({
  connector,
  canManage,
  testing,
  syncing,
  deleting,
  onOpen,
  onTest,
  onSync,
  onDelete,
}: {
  connector: CloudflareConnector;
  canManage: boolean;
  testing: boolean;
  syncing: boolean;
  deleting: boolean;
  onOpen?: () => void;
  onTest: () => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const lastSync = connector.syncFinishedAt ? (
    <>
      Synced <RelativeTime value={connector.syncFinishedAt} />
    </>
  ) : (
    "Never synced"
  );
  const zoneCount = connector.zones?.length ?? 0;
  const enabledCapabilities = useMemo(
    () =>
      Object.entries(connector.capabilities)
        .filter(([, value]) => value)
        .map(([key]) => CAPABILITY_LABELS[key] ?? key),
    [connector.capabilities]
  );

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
          <Cloud className="h-4 w-4 text-muted-foreground" />
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
              {zoneCount} zones
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {lastSync}
            {connector.testedAt && (
              <>
                {" · Tested "}
                <RelativeTime value={connector.testedAt} />
              </>
            )}
            {connector.tokenMasked ? ` · Token ${connector.tokenMasked}` : ""}
            {connector.syncLastError ? ` · ${connector.syncLastError}` : ""}
          </p>
          {enabledCapabilities.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {enabledCapabilities.map((label) => (
                <Badge key={label} variant="outline" size="inline">
                  {label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      {canManage && (
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
            title="Sync zones"
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
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
