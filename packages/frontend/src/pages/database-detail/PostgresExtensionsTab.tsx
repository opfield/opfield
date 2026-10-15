import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  DatabaseConnection,
  ManagedPostgresExtension,
  ManagedPostgresExtensionCategory,
  ManagedPostgresExtensions,
} from "@/types";

export function postgresExtensionsCacheKey(databaseId: string) {
  return `database:${databaseId}:postgres-extensions`;
}

const CATEGORIES: Array<[ManagedPostgresExtensionCategory, string]> = [
  ["ai_search", "AI & search"],
  ["geo", "Geo"],
  ["scheduling_partitioning", "Scheduling & partitioning"],
  ["observability_tuning", "Observability & tuning"],
  ["data_types", "Data types"],
  ["text_search", "Text search"],
  ["foreign_data", "Foreign data"],
  ["maintenance", "Maintenance"],
  ["other", "Other"],
];

type ExtensionAction = "enable" | "disable" | "update";

const ACTION_LABELS: Record<ExtensionAction, string> = {
  enable: "Enabling",
  disable: "Disabling",
  update: "Updating",
};

function statusLabel(extension: ManagedPostgresExtension): string | null {
  switch (extension.status) {
    case "enabled":
      return `Enabled v${extension.installedVersion}`;
    case "update_available":
      return `Update to v${extension.availableVersion}`;
    case "available":
      return extension.availableVersion ? `Available v${extension.availableVersion}` : "Available";
    case "needs_bundle":
      return `Download ${formatBytes(extension.bundleSizeBytes)}`;
    case "needs_image_update":
      return "Needs image update";
    case "unavailable":
      return "Not in this version";
    default:
      return null;
  }
}

/** What the confirm dialog of a change says: the download and the restart it brings. */
function changeDescription(
  extension: ManagedPostgresExtension,
  action: ExtensionAction,
  databaseName: string,
  volume: ManagedPostgresExtensions["volume"]
): string {
  const restart =
    (action === "enable" && extension.restartToEnable) ||
    (action === "disable" && extension.restartToDisable)
      ? " The database restarts."
      : "";
  if (action === "update") {
    return `Update ${extension.name} to v${extension.availableVersion} in ${databaseName}?`;
  }
  if (action === "disable") {
    return `Disable ${extension.name}? Objects that depend on it block this.${restart}`;
  }
  const download =
    extension.status === "needs_bundle"
      ? ` Downloads ${formatBytes(extension.bundleSizeBytes)} into the database storage${
          volume ? ` (${formatBytes(volume.freeBytes)} free)` : ""
        }.`
      : "";
  return `Enable ${extension.name} in ${databaseName}?${download}${restart}`;
}

export function PostgresExtensionsTab({
  database,
  canManage,
}: {
  database: DatabaseConnection;
  canManage: boolean;
}) {
  const managedId = database.managed?.id ?? "";
  const cacheKey = postgresExtensionsCacheKey(database.id);
  const [state, setState] = useState<ManagedPostgresExtensions | null>(
    () => api.getCached<ManagedPostgresExtensions>(cacheKey) ?? null
  );
  const [loading, setLoading] = useState(
    () => api.getCached<ManagedPostgresExtensions>(cacheKey) === undefined
  );
  const [search, setSearch] = useState("");
  const [pendingExtension, setPendingExtension] = useState<string | null>(null);
  const [updatingImage, setUpdatingImage] = useState(false);
  useContentLoading(loading);

  const apply = useCallback(
    (next: ManagedPostgresExtensions) => {
      api.setCache(cacheKey, next);
      setState(next);
    },
    [cacheKey]
  );

  const load = useCallback(async () => {
    try {
      apply(await api.listManagedDatabaseExtensions(managedId));
    } catch (error) {
      toastApiError(error, "Failed to load PostgreSQL extensions");
    } finally {
      setLoading(false);
    }
  }, [apply, managedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A change that waits for a restart or a download continues on the server.
  useRealtime("database.changed", (payload) => {
    if ((payload as { managedDatabaseId?: string }).managedDatabaseId === managedId) void load();
  });
  useEffect(() => {
    if (!state?.pending) return;
    const timer = window.setTimeout(() => void load(), 5000);
    return () => window.clearTimeout(timer);
  }, [load, state]);

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = (state?.extensions ?? []).filter(
      (extension) =>
        !query ||
        extension.name.toLowerCase().includes(query) ||
        extension.description.toLowerCase().includes(query)
    );
    return CATEGORIES.map(([category, label]) => ({
      label,
      extensions: visible.filter((extension) => extension.category === category),
    })).filter((group) => group.extensions.length > 0);
  }, [search, state]);

  const enabledCount = (state?.extensions ?? []).filter(
    (extension) => extension.installedVersion !== null
  ).length;
  const busy = pendingExtension !== null || !!state?.pending || updatingImage;

  const change = async (extension: ManagedPostgresExtension, action: ExtensionAction) => {
    if (!canManage || busy) return;
    const confirmed = await confirm({
      title: `${action === "enable" ? "Enable" : action === "disable" ? "Disable" : "Update"} Extension`,
      description: changeDescription(extension, action, database.name, state?.volume ?? null),
      confirmLabel: action === "enable" ? "Enable" : action === "disable" ? "Disable" : "Update",
      variant: action === "disable" ? "destructive" : "default",
    });
    if (!confirmed) return;
    setPendingExtension(extension.name);
    try {
      const next = await api.changeManagedDatabaseExtension(managedId, extension.name, action);
      apply(next);
      if (!next.pending) toast.success(`${extension.name} ${action}d`);
    } catch (error) {
      toastApiError(error, `Failed to ${action} ${extension.name}`);
    } finally {
      setPendingExtension(null);
    }
  };

  const updateImage = async () => {
    if (!canManage || busy) return;
    const confirmed = await confirm({
      title: "Update Image",
      description: `Move ${database.name} to Opfield's PostgreSQL ${state?.version ?? ""} image? It adds the extensions. The data stays; the database restarts once.`,
      confirmLabel: "Update",
    });
    if (!confirmed) return;
    setUpdatingImage(true);
    try {
      await api.updateManagedDatabase(managedId, { imageUpdate: true });
      toast.success("Image update started");
      await load();
    } catch (error) {
      toastApiError(error, "Failed to update the image");
    } finally {
      setUpdatingImage(false);
    }
  };

  const renderRow = (extension: ManagedPostgresExtension) => {
    const status = statusLabel(extension);
    const enabled = extension.installedVersion !== null;
    const canEnable = extension.status === "available" || extension.status === "needs_bundle";
    const waiting = pendingExtension === extension.name || state?.pending?.name === extension.name;
    return (
      <SettingsControlRow
        key={extension.name}
        title={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="truncate">{extension.name}</span>
            {status ? (
              <Badge variant={enabled ? "success" : "outline"} size="inline">
                {status}
              </Badge>
            ) : null}
            {extension.preloadLibraries.length > 0 ? (
              <Badge variant="outline" size="inline">
                Restart
              </Badge>
            ) : null}
          </span>
        }
        description={
          extension.notes ? `${extension.description} ${extension.notes}` : extension.description
        }
      >
        {extension.status === "update_available" ? (
          <Button
            variant="outline"
            pending={waiting}
            disabled={!canManage || busy}
            onClick={() => void change(extension, "update")}
          >
            Update
          </Button>
        ) : null}
        {enabled ? (
          <Button
            variant="outline"
            pending={waiting && extension.status !== "update_available"}
            disabled={!canManage || busy}
            onClick={() => void change(extension, "disable")}
          >
            Disable
          </Button>
        ) : canEnable ? (
          <Button
            pending={waiting}
            disabled={!canManage || busy}
            onClick={() => void change(extension, "enable")}
          >
            Enable
          </Button>
        ) : null}
      </SettingsControlRow>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {state?.daemonUpdateRequired ? (
        <Notice tone="warning" title="Daemon update required">
          Update the database daemon on this node to manage extensions.
        </Notice>
      ) : null}
      {state?.imageUpdateAvailable ? (
        <Notice
          tone="info"
          title="Image update available — adds the extensions"
          actions={
            canManage ? (
              <NoticeAction
                tone="info"
                onClick={() => void updateImage()}
                pending={updatingImage}
                disabled={busy}
              >
                Update image
              </NoticeAction>
            ) : undefined
          }
        >
          The data stays; the database restarts once.
        </Notice>
      ) : null}
      {state?.pending ? (
        <Notice tone="info" title={`${ACTION_LABELS[state.pending.action]} ${state.pending.name}`}>
          The database applies the restart or download first. This continues on its own.
        </Notice>
      ) : state?.lastError ? (
        <Notice
          tone="destructive"
          title={`Could not ${state.lastError.action} ${state.lastError.name}`}
        >
          {state.lastError.message} <RelativeTime value={state.lastError.failedAt} />
        </Notice>
      ) : null}
      <PanelShell
        className="flex min-h-0 flex-1 flex-col"
        title="Extensions"
        description={`PostgreSQL extensions Opfield offers for this database. Extensions marked Restart restart it when turned on or off. ${enabledCount} enabled.`}
        bodyClassName="flex min-h-0 flex-1 flex-col"
      >
        <div className="relative border-b border-border">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search PostgreSQL extensions"
            className="h-10 border-0 bg-background pl-9 focus-visible:ring-0"
            placeholder="Search extensions..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? null : groups.length === 0 ? (
            <EmptyState message="No PostgreSQL extensions match your search." embedded />
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                {group.extensions.map(renderRow)}
              </div>
            ))
          )}
        </div>
      </PanelShell>
    </div>
  );
}
