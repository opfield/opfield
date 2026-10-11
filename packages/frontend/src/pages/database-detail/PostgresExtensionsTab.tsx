import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { DatabaseConnection, ManagedPostgresExtension } from "@/types";

export function postgresExtensionsCacheKey(databaseId: string) {
  return `database:${databaseId}:postgres-extensions`;
}

export function PostgresExtensionsTab({
  database,
  canManage,
}: {
  database: DatabaseConnection;
  canManage: boolean;
}) {
  const cacheKey = postgresExtensionsCacheKey(database.id);
  const [extensions, setExtensions] = useState<ManagedPostgresExtension[]>(
    () => api.getCached<ManagedPostgresExtension[]>(cacheKey) ?? []
  );
  const [loading, setLoading] = useState(
    () => api.getCached<ManagedPostgresExtension[]>(cacheKey) === undefined
  );
  const [search, setSearch] = useState("");
  const [pendingExtension, setPendingExtension] = useState<string | null>(null);
  useContentLoading(loading);

  const load = useCallback(async () => {
    const cached = api.getCached<ManagedPostgresExtension[]>(cacheKey);
    if (cached) {
      setExtensions(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.listManagedPostgresExtensions(database.id);
      api.setCache(cacheKey, next);
      setExtensions(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load PostgreSQL extensions");
    } finally {
      setLoading(false);
    }
  }, [cacheKey, database.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredExtensions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return extensions;
    return extensions.filter(
      (extension) =>
        extension.name.toLowerCase().includes(query) ||
        extension.comment?.toLowerCase().includes(query)
    );
  }, [extensions, search]);

  const enabledCount = extensions.filter((extension) => extension.installedVersion).length;

  const enable = async (extension: ManagedPostgresExtension) => {
    if (!canManage || pendingExtension) return;
    const confirmed = await confirm({
      title: "Enable PostgreSQL Extension",
      description: `Enable ${extension.name} in ${database.name}? PostgreSQL will create this extension's database objects.`,
      confirmLabel: "Enable",
    });
    if (!confirmed) return;

    setPendingExtension(extension.name);
    try {
      const next = await api.enableManagedPostgresExtension(database.id, extension.name);
      api.setCache(cacheKey, next);
      setExtensions(next);
      toast.success(`${extension.name} enabled`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to enable PostgreSQL extension");
    } finally {
      setPendingExtension(null);
    }
  };

  const disable = async (extension: ManagedPostgresExtension) => {
    if (!canManage || pendingExtension) return;
    const confirmed = await confirm({
      title: "Disable PostgreSQL Extension",
      description: `Disable ${extension.name}? Gateway will not use CASCADE and will refuse if database objects depend on it.`,
      confirmLabel: "Disable",
      variant: "destructive",
    });
    if (!confirmed) return;

    setPendingExtension(extension.name);
    try {
      const next = await api.disableManagedPostgresExtension(database.id, extension.name);
      api.setCache(cacheKey, next);
      setExtensions(next);
      toast.success(`${extension.name} disabled`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to disable PostgreSQL extension"
      );
    } finally {
      setPendingExtension(null);
    }
  };

  return (
    <PanelShell
      className="flex min-h-0 flex-col"
      title="PostgreSQL Extensions"
      description={`Extensions bundled with PostgreSQL ${database.managed?.version ?? ""} that Gateway can safely enable or disable. Enabling creates database objects; disabling never uses CASCADE. ${enabledCount} enabled.`}
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
        {loading ? null : filteredExtensions.length === 0 ? (
          <EmptyState message="No PostgreSQL extensions match your search." embedded />
        ) : (
          filteredExtensions.map((extension) => {
            const enabled = extension.installedVersion !== null;
            const waiting = pendingExtension === extension.name;
            return (
              <SettingsControlRow
                key={extension.name}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{extension.name}</span>
                    <Badge variant="outline" size="inline">
                      v{extension.installedVersion ?? extension.defaultVersion}
                    </Badge>
                  </span>
                }
                description={extension.comment}
              >
                <Button
                  variant={enabled ? "outline" : "default"}
                  pending={waiting}
                  disabled={!canManage || pendingExtension !== null}
                  onClick={() => void (enabled ? disable(extension) : enable(extension))}
                >
                  {enabled ? "Disable" : "Enable"}
                </Button>
              </SettingsControlRow>
            );
          })
        )}
      </div>
    </PanelShell>
  );
}
