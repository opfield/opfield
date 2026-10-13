import { FolderPlus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { MoveToAppDialog } from "@/components/apps/MoveToAppDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { withoutAppMembers } from "@/lib/app-members";
import { loggingEnvironmentRoute, loggingSchemaRoute } from "@/lib/resource-routes";
import { scopeMatches } from "@/lib/scope-utils";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { useSystemConfigStore } from "@/stores/system-config";
import type { LoggingEnvironment, LoggingSchema, LoggingSchemaMode } from "@/types";
import { LoggingEnvironmentDetail, LoggingSchemaDetail } from "./logging/LoggingDetails";
import { LoggingEnvironmentDialog } from "./logging/LoggingEnvironmentDialog";
import { LoggingEnvironmentsTab, LoggingSchemasTab } from "./logging/LoggingTabs";

const TOP_TABS = [
  { value: "environments", label: "Environments" },
  { value: "schemas", label: "Schemas" },
] as const;

const ENV_TABS = ["logs", "tokens", "settings"] as const;

export function Logging({
  resolvedResourceId,
  resolvedResourceSlug,
  resolvedSection,
}: {
  resolvedResourceId?: string;
  resolvedResourceSlug?: string;
  resolvedSection?: "environments" | "schemas";
} = {}) {
  const params = useParams<{
    section?: string;
    id?: string;
    environmentSlug?: string;
    schemaSlug?: string;
    tab?: string;
  }>();
  const section = resolvedSection ?? params.section;
  const id = resolvedResourceId ?? params.id;
  const routeSlug =
    resolvedResourceSlug ?? params.environmentSlug ?? params.schemaSlug ?? params.id ?? "";
  const tab = params.tab;
  const navigate = useNavigate();
  const { user, hasAnyScope, hasScopedAccess } = useAuthStore();
  const isEnvironmentDetail = section === "environments" && !!id;
  const isSchemaDetail = section === "schemas" && !!id;
  // Same rules as the list routes: any view, read or create grant (resource, folder or broad)
  // opens the list; a granted but empty folder lists as empty instead of failing.
  const canAccessEnvironments =
    hasScopedAccess("logs:environments:view") ||
    hasScopedAccess("logs:read") ||
    hasScopedAccess("logs:environments:create");
  const userScopes = user?.scopes ?? [];
  const canListSchemas =
    hasScopedAccess("logs:schemas:view") || hasScopedAccess("logs:schemas:create");
  const canAccessSchemas = canListSchemas;
  const canViewSchemaDetails = hasAnyScope("logs:schemas:view");
  const loggingEnabled = useSystemConfigStore((s) => s.config.features.loggingEnabled);
  const canViewSelectedSchema =
    isSchemaDetail && !!id && scopeMatches(userScopes, `logs:schemas:view:${id}`);
  const [environments, setEnvironments] = useState<LoggingEnvironment[]>(() =>
    canAccessEnvironments ? (api.getCached<LoggingEnvironment[]>("logging:environments") ?? []) : []
  );
  const [schemas, setSchemas] = useState<LoggingSchema[]>(() =>
    canListSchemas ? (api.getCached<LoggingSchema[]>("logging:schemas") ?? []) : []
  );
  const [environmentSearch, setEnvironmentSearch] = useState("");
  const [schemaSearch, setSchemaSearch] = useState("");
  const [environmentsLoading, setEnvironmentsLoading] = useState(
    () =>
      canAccessEnvironments &&
      api.getCached<LoggingEnvironment[]>("logging:environments") === undefined
  );
  const [schemasLoading, setSchemasLoading] = useState(
    () =>
      (canListSchemas || canViewSelectedSchema) &&
      api.getCached<LoggingSchema[]>("logging:schemas") === undefined
  );
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [moveToAppEnvironment, setMoveToAppEnvironment] = useState<LoggingEnvironment | null>(null);
  const shownMoveToAppEnvironment = useRetainedDialogValue(
    moveToAppEnvironment,
    moveToAppEnvironment !== null
  );
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false);
  const [createEnvironmentFolderAction, setCreateEnvironmentFolderAction] = useState<
    (() => void) | null
  >(null);
  const [createSchemaFolderAction, setCreateSchemaFolderAction] = useState<(() => void) | null>(
    null
  );

  const openEnvironmentCreate = () => {
    if (!requireLicenseFeature("structured-logging", "Logging environments")) return;
    setEnvironmentDialogOpen(true);
  };

  const openSchemaCreate = () => {
    if (!requireLicenseFeature("structured-logging", "Logging schemas")) return;
    setSchemaDialogOpen(true);
  };

  const visibleTopTabs = useMemo(
    () =>
      TOP_TABS.filter((item) => {
        if (item.value === "environments") return canAccessEnvironments;
        return canAccessSchemas;
      }),
    [canAccessEnvironments, canAccessSchemas]
  );
  const defaultTopTab = canAccessEnvironments ? "environments" : "schemas";
  const requestedTopTab =
    TOP_TABS.some((item) => item.value === section) && !isEnvironmentDetail && !isSchemaDetail
      ? section!
      : defaultTopTab;
  const topTab = visibleTopTabs.some((item) => item.value === requestedTopTab)
    ? requestedTopTab
    : defaultTopTab;
  const activeEnvironmentTab = ENV_TABS.includes(tab as any) ? tab! : "logs";
  const visibleEnvironments = canAccessEnvironments ? environments : [];
  const visibleSchemas = canListSchemas || canViewSelectedSchema ? schemas : [];
  const selectedEnvironment =
    visibleEnvironments.find((environment) => environment.id === id) ?? null;
  const selectedSchema = visibleSchemas.find((schema) => schema.id === id) ?? null;

  // Creation may be granted on a folder only; the dialog then offers just those folders.
  const canCreateEnvironment = hasScopedAccess("logs:environments:create");
  const canManageEnvironmentFolders = useCanManageSomeFolders("logs:environments:folders:manage");
  const canCreateSchema = hasScopedAccess("logs:schemas:create");
  const canManageSchemaFolders = useCanManageSomeFolders("logs:schemas:folders:manage");
  const canEditEnvironment =
    !!selectedEnvironment && hasAnyScope(`logs:environments:edit:${selectedEnvironment.id}`);
  const canDeleteEnvironment =
    !!selectedEnvironment && hasAnyScope(`logs:environments:delete:${selectedEnvironment.id}`);
  // Token grants may come from an environment folder; they arrive resolved per environment.
  const canCreateToken =
    !!selectedEnvironment && hasAnyScope(`logs:tokens:create:${selectedEnvironment.id}`);
  const canDeleteToken =
    !!selectedEnvironment && hasAnyScope(`logs:tokens:delete:${selectedEnvironment.id}`);
  const canEditSchema = !!selectedSchema && hasAnyScope(`logs:schemas:edit:${selectedSchema.id}`);
  const canDeleteSchema =
    !!selectedSchema && hasAnyScope(`logs:schemas:delete:${selectedSchema.id}`);

  const load = useCallback(async () => {
    const cachedEnvironments = api.getCached<LoggingEnvironment[]>("logging:environments");
    const cachedSchemas = api.getCached<LoggingSchema[]>("logging:schemas");
    if (canAccessEnvironments && cachedEnvironments) setEnvironments(cachedEnvironments);
    if (!canAccessEnvironments) setEnvironments([]);
    if (canListSchemas && cachedSchemas) setSchemas(cachedSchemas);
    if (!canListSchemas && !canViewSelectedSchema) setSchemas([]);
    setEnvironmentsLoading(canAccessEnvironments && cachedEnvironments === undefined);
    setSchemasLoading((canListSchemas || canViewSelectedSchema) && cachedSchemas === undefined);
    try {
      const [environmentList, schemaList] = await Promise.all([
        canAccessEnvironments ? api.listLoggingEnvironments() : Promise.resolve([]),
        canListSchemas
          ? api.listLoggingSchemas()
          : canViewSelectedSchema
            ? api.getLoggingSchema(id).then((schema) => [schema])
            : Promise.resolve([]),
      ]);
      if (canAccessEnvironments) api.setCache("logging:environments", environmentList);
      if (canListSchemas) api.setCache("logging:schemas", schemaList);
      setEnvironments(environmentList);
      setSchemas(schemaList);
    } catch (error) {
      toastApiError(error, "Failed to load logging");
    } finally {
      setEnvironmentsLoading(false);
      setSchemasLoading(false);
    }
  }, [canAccessEnvironments, canListSchemas, canViewSelectedSchema, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(isEnvironmentDetail ? "logging.environment.changed" : null, (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== id) return;
    if (event.oldSlug === routeSlug && event.slug) {
      navigate(loggingEnvironmentRoute(event.slug, activeEnvironmentTab), { replace: true });
      return;
    }
    void load();
  });

  useRealtime(isSchemaDetail ? "logging.schema.changed" : null, (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== id) return;
    if (event.oldSlug === routeSlug && event.slug) {
      navigate(loggingSchemaRoute(event.slug), { replace: true });
      return;
    }
    void load();
  });

  // App members live on their app's page; the list keeps them only for their detail pages.
  const filteredEnvironments = useMemo(() => {
    const needle = environmentSearch.trim().toLowerCase();
    const listed = withoutAppMembers(visibleEnvironments);
    if (!needle) return listed;
    return listed.filter(
      (environment) =>
        environment.name.toLowerCase().includes(needle) ||
        environment.slug.toLowerCase().includes(needle) ||
        (environment.schemaName ?? "").toLowerCase().includes(needle)
    );
  }, [environmentSearch, visibleEnvironments]);

  const filteredSchemas = useMemo(() => {
    const needle = schemaSearch.trim().toLowerCase();
    if (!needle) return visibleSchemas;
    return visibleSchemas.filter(
      (schema) =>
        schema.name.toLowerCase().includes(needle) || schema.slug.toLowerCase().includes(needle)
    );
  }, [schemaSearch, visibleSchemas]);

  const createEnvironment = async (data: Partial<LoggingEnvironment>) => {
    const created = await api.createLoggingEnvironment({
      ...data,
      schemaId: data.schemaId ?? null,
      schemaMode: data.schemaId ? "reject" : "loose",
      fieldSchema: [],
      retentionDays: data.retentionDays ?? 30,
    });
    toast.success("Logging environment created");
    await load();
    navigate(loggingEnvironmentRoute(created.slug, "logs"));
  };

  const updateEnvironment = async (environmentId: string, patch: Partial<LoggingEnvironment>) => {
    const updated = await api.updateLoggingEnvironment(environmentId, patch);
    setEnvironments((current) =>
      current.map((environment) => (environment.id === updated.id ? updated : environment))
    );
    api.setCache(
      "logging:environments",
      (api.getCached<LoggingEnvironment[]>("logging:environments") ?? environments).map(
        (environment) => (environment.id === updated.id ? updated : environment)
      )
    );
    if (updated.id === id && updated.slug !== routeSlug) {
      navigate(loggingEnvironmentRoute(updated.slug, activeEnvironmentTab), { replace: true });
    }
  };

  const createSchema = async (data: Partial<LoggingSchema>) => {
    const created = await api.createLoggingSchema(data);
    setSchemas((current) => {
      const next = [...current, created].sort((a, b) => a.name.localeCompare(b.name));
      api.setCache("logging:schemas", next);
      return next;
    });
    toast.success("Logging schema created");
    if (hasAnyScope(`logs:schemas:view:${created.id}`)) {
      navigate(loggingSchemaRoute(created.slug));
    } else {
      navigate("/logging/schemas");
    }
  };

  const updateSchema = async (schemaId: string, data: Partial<LoggingSchema>) => {
    const updated = await api.updateLoggingSchema(schemaId, data);
    setSchemas((current) => {
      const next = current.map((schema) => (schema.id === updated.id ? updated : schema));
      api.setCache("logging:schemas", next);
      return next;
    });
    toast.success("Logging schema updated");
    if (updated.id === id && updated.slug !== routeSlug) {
      navigate(loggingSchemaRoute(updated.slug), { replace: true });
    }
  };

  const deleteSchema = async (schema: LoggingSchema) => {
    if (
      !(await confirm({
        title: "Delete Logging Schema",
        description: `Delete ${schema.name}? Environments using it will keep running without an attached schema.`,
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    ) {
      return false;
    }
    await api.deleteLoggingSchema(schema.id);
    toast.success("Logging schema deleted");
    await load();
    return true;
  };

  if (isEnvironmentDetail) {
    return (
      <LoggingEnvironmentDetail
        environment={selectedEnvironment}
        schemas={schemas}
        loggingEnabled={loggingEnabled}
        loading={environmentsLoading}
        activeTab={activeEnvironmentTab as (typeof ENV_TABS)[number]}
        canEdit={canEditEnvironment}
        canDelete={canDeleteEnvironment}
        canCreateToken={canCreateToken}
        canDeleteToken={canDeleteToken}
        onUpdate={updateEnvironment}
        onDelete={async (environment) => {
          await api.deleteLoggingEnvironment(environment.id);
          toast.success("Logging environment deleted");
          await load();
          navigate("/logging/environments", { replace: true });
        }}
      />
    );
  }

  if (isSchemaDetail) {
    return (
      <LoggingSchemaDetail
        schema={selectedSchema}
        loading={schemasLoading}
        canEdit={canEditSchema}
        canDelete={canDeleteSchema}
        onSave={(patch) => updateSchema(id!, patch)}
        onDelete={async (schema) => {
          const deleted = await deleteSchema(schema);
          if (deleted) navigate("/logging/schemas", { replace: true });
          return deleted;
        }}
      />
    );
  }

  const activeTabLoading =
    topTab === "environments" ? environmentsLoading : topTab === "schemas" ? schemasLoading : false;

  return (
    <PageTransition>
      <div className={cn("h-full overflow-y-auto p-6 space-y-4", topTab === "schemas" && "pb-3")}>
        <PageHeader
          className="shrink-0"
          leading={<LiteModeBackButton />}
          title="Logging"
          description="Manage external log environments and reusable schemas"
          actions={
            <ResponsiveHeaderActions
              actions={[
                { label: "Refresh", onClick: load, disabled: activeTabLoading },
                ...(topTab === "environments" && canCreateEnvironment
                  ? [
                      {
                        label: "Create Environment",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: openEnvironmentCreate,
                      },
                    ]
                  : []),
                ...(topTab === "environments" && canManageEnvironmentFolders
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: () => createEnvironmentFolderAction?.(),
                      },
                    ]
                  : []),
                ...(topTab === "schemas" && canCreateSchema
                  ? [
                      {
                        label: "Create Schema",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: openSchemaCreate,
                      },
                    ]
                  : []),
                ...(topTab === "schemas" && canManageSchemaFolders
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: () => createSchemaFolderAction?.(),
                      },
                    ]
                  : []),
              ]}
            >
              <RefreshButton onClick={load} disabled={activeTabLoading} />
              {topTab === "environments" && canManageEnvironmentFolders && (
                <Button variant="outline" onClick={() => createEnvironmentFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {topTab === "environments" && canCreateEnvironment && (
                <Button onClick={openEnvironmentCreate}>
                  <Plus />
                  Create Environment
                </Button>
              )}
              {topTab === "schemas" && canManageSchemaFolders && (
                <Button variant="outline" onClick={() => createSchemaFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {topTab === "schemas" && canCreateSchema && (
                <Button onClick={openSchemaCreate}>
                  <Plus />
                  Create Schema
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <Tabs
          value={topTab}
          onValueChange={(value) => navigate(`/logging/${value}`, { replace: true })}
          className="flex flex-col"
        >
          <TabsList className="shrink-0">
            {visibleTopTabs.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="gap-1.5">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="environments">
            <LoggingEnvironmentsTab
              environments={filteredEnvironments}
              search={environmentSearch}
              loading={environmentsLoading}
              canCreate={canCreateEnvironment}
              canManageFolders={canManageEnvironmentFolders}
              onSearchChange={setEnvironmentSearch}
              onCreate={openEnvironmentCreate}
              onOpen={(environment) => navigate(loggingEnvironmentRoute(environment.slug, "logs"))}
              onRefresh={load}
              onCreateFolderRef={(fn) => setCreateEnvironmentFolderAction(() => fn)}
              canMoveToApp={(environment) =>
                hasAnyScope(`logs:environments:edit:${environment.id}`)
              }
              onMoveToApp={setMoveToAppEnvironment}
            />
          </TabsContent>

          <TabsContent value="schemas">
            <LoggingSchemasTab
              schemas={filteredSchemas}
              search={schemaSearch}
              loading={schemasLoading}
              canCreate={canCreateSchema}
              canManageFolders={canManageSchemaFolders}
              canEdit={(schema) => hasAnyScope(`logs:schemas:edit:${schema.id}`)}
              canDelete={(schema) => hasAnyScope(`logs:schemas:delete:${schema.id}`)}
              canOpen={(schema) =>
                canViewSchemaDetails || hasAnyScope(`logs:schemas:view:${schema.id}`)
              }
              onSearchChange={setSchemaSearch}
              onCreate={openSchemaCreate}
              onOpen={(schema) => navigate(loggingSchemaRoute(schema.slug))}
              onDelete={deleteSchema}
              onRefresh={load}
              onCreateFolderRef={(fn) => setCreateSchemaFolderAction(() => fn)}
            />
          </TabsContent>
        </Tabs>

        <MoveToAppDialog
          open={moveToAppEnvironment !== null}
          onOpenChange={(open) => {
            if (!open) setMoveToAppEnvironment(null);
          }}
          members={
            shownMoveToAppEnvironment ? [{ type: "logging", id: shownMoveToAppEnvironment.id }] : []
          }
          resourceLabel={shownMoveToAppEnvironment?.name ?? "the logging environment"}
          onMoved={() => void load()}
        />
        <LoggingEnvironmentDialog
          open={environmentDialogOpen}
          environment={null}
          onOpenChange={setEnvironmentDialogOpen}
          onSave={createEnvironment}
        />
        <LoggingSchemaDialog
          open={schemaDialogOpen}
          onOpenChange={setSchemaDialogOpen}
          onSave={createSchema}
        />
      </div>
    </PageTransition>
  );
}

function LoggingSchemaDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: Partial<LoggingSchema>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [schemaMode, setSchemaMode] = useState<LoggingSchemaMode>("reject");
  const [fieldSchema, setFieldSchema] = useState<LoggingSchema["fieldSchema"]>([]);
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const folders = useResourceFolderStore((state) => state.foldersByType["logging-schema"]);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType["logging-schema"]);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const scopes = useAuthStore((state) => state.user?.scopes);
  const folderChoices = useMemo(
    () => getCreateFolderChoices(scopes ?? [], "logs:schemas:create", folders),
    [folders, scopes]
  );

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setSchemaMode("reject");
    setFieldSchema([]);
    setFolderId("");
    void fetchFolders("logging-schema");
  }, [fetchFolders, open]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        name,
        description: description || null,
        folderId: folderId || null,
        schemaMode,
        fieldSchema,
      });
      onOpenChange(false);
    } catch (error) {
      setSaving(false);
      if (!handleLicenseApiError(error, "Logging schemas")) {
        toastApiError(error, "Failed to create logging schema");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Logging Schema</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Audit Events"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Folder</span>
            <CreateFolderSelect
              choices={folderChoices}
              value={folderId}
              onChange={setFolderId}
              loading={foldersLoading}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Description</span>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional description"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Mode</span>
            <Select
              value={schemaMode}
              onValueChange={(value) => setSchemaMode(value as LoggingSchemaMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reject">Reject</SelectItem>
                <SelectItem value="strip">Strip</SelectItem>
                <SelectItem value="loose">Loose</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            pending={saving}
            disabled={!name.trim() || !isCreateFolderAllowed(folderChoices, folderId)}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
