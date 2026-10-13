import { Braces, Code2, Gauge, Plus, Save, ScrollText, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { loggingEnvironmentRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { requireLicenseFeature } from "@/stores/license-paywall";
import type { LoggingEnvironment, LoggingSchema, LoggingSchemaMode } from "@/types";
import { LoggingConnectionInstructionsDialog } from "./LoggingConnectionInstructionsDialog";
import { LoggingExplorer } from "./LoggingExplorer";
import { LoggingSchemaEditor } from "./LoggingSchemaEditor";
import { LoggingTokenPanel } from "./LoggingTokenPanel";
import { isLoggingEnvironmentSettingsDirty, isLoggingSchemaDirty } from "./logging-state";

export type LoggingEnvironmentTab = "logs" | "tokens" | "settings";

export function LoggingSchemaDetail({
  schema,
  loading,
  canEdit,
  canDelete,
  onSave,
  onDelete,
}: {
  schema: LoggingSchema | null;
  loading: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSave: (patch: Partial<LoggingSchema>) => Promise<void>;
  onDelete: (schema: LoggingSchema) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Partial<LoggingSchema>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!schema) return;
    setDraft({
      name: schema.name,
      description: schema.description,
      schemaMode: schema.schemaMode,
      fieldSchema: schema.fieldSchema,
    });
  }, [schema]);

  if (loading) return <DetailPageSkeleton label="Loading logging schema" tabs={3} />;
  if (!schema) {
    return (
      <PageTransition>
        <div className="p-6">
          <EmptyState message="Logging schema not found." />
        </div>
      </PageTransition>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };
  const dirty = isLoggingSchemaDirty(schema, draft);
  // Per block, for the warning border of a changed panel.
  const metadataDirty =
    (draft.name ?? "") !== schema.name || (draft.description ?? null) !== schema.description;
  const behaviorDirty = (draft.schemaMode ?? schema.schemaMode) !== schema.schemaMode;
  const fieldsDirty =
    JSON.stringify(draft.fieldSchema ?? schema.fieldSchema) !== JSON.stringify(schema.fieldSchema);
  const headerActions: ResponsiveHeaderAction[] = [
    ...(canEdit
      ? [
          {
            id: "logging-schema:save",
            label: saving ? "Saving schema" : "Save schema changes",
            icon: <Save className="h-4 w-4" />,
            disabled: saving || !dirty,
            onClick: () => void save(),
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            id: "logging-schema:delete",
            label: "Delete logging schema",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: () => void onDelete(schema),
            destructive: true,
            separatorBefore: canEdit,
          },
        ]
      : []),
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          leading={<PageBackButton onClick={() => navigate("/logging/schemas")} />}
          title={schema.name}
          badges={
            <>
              <Badge variant="secondary" size="inline">
                {draft.schemaMode ?? schema.schemaMode}
              </Badge>
              <Badge variant="outline" size="inline">
                {(draft.fieldSchema ?? schema.fieldSchema).length} fields
              </Badge>
            </>
          }
          description={
            <span className="block truncate">
              {schema.slug} · Updated <RelativeTime value={schema.updatedAt} />
            </span>
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {canEdit && (
                <Button pending={saving} disabled={!dirty} onClick={() => void save()}>
                  <Save />
                  Save Changes
                </Button>
              )}
              {canDelete && (
                <Button variant="destructive" onClick={() => void onDelete(schema)}>
                  <Trash2 />
                  Delete
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SettingsPanel
            title="Metadata"
            description="Reusable schema identity"
            dirty={canEdit && metadataDirty}
          >
            <SettingsTextRow
              label="Name"
              description="Display name used in schema lists"
              value={draft.name ?? ""}
              disabled={!canEdit}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <SettingsTextRow
              label="Description"
              description="Optional operator-facing note"
              value={draft.description ?? ""}
              disabled={!canEdit}
              onChange={(description) => setDraft({ ...draft, description })}
            />
          </SettingsPanel>

          <SettingsPanel
            title="Behavior"
            description="Validation mode for attached environments"
            dirty={canEdit && behaviorDirty}
          >
            <SettingsControlRow
              title="Mode"
              description="Unknown labels and fields are handled during ingest"
            >
              <Select
                disabled={!canEdit}
                value={draft.schemaMode ?? schema.schemaMode}
                onValueChange={(schemaMode) =>
                  setDraft({ ...draft, schemaMode: schemaMode as LoggingSchemaMode })
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reject">Reject</SelectItem>
                  <SelectItem value="strip">Strip</SelectItem>
                  <SelectItem value="loose">Loose</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </SettingsPanel>
        </div>

        <LoggingSchemaEditor
          schema={{
            schemaMode: draft.schemaMode ?? schema.schemaMode,
            fieldSchema: draft.fieldSchema ?? schema.fieldSchema,
          }}
          canEdit={canEdit}
          dirty={canEdit && fieldsDirty}
          onSave={async (patch) => setDraft((current) => ({ ...current, ...patch }))}
        />
      </div>
    </PageTransition>
  );
}

export function LoggingEnvironmentDetail({
  environment,
  schemas,
  loggingEnabled,
  loading,
  activeTab,
  canEdit,
  canDelete,
  canCreateToken,
  canDeleteToken,
  onUpdate,
  onDelete,
}: {
  environment: LoggingEnvironment | null;
  schemas: LoggingSchema[];
  loggingEnabled: boolean;
  loading: boolean;
  activeTab: LoggingEnvironmentTab;
  canEdit: boolean;
  canDelete: boolean;
  canCreateToken: boolean;
  canDeleteToken: boolean;
  onUpdate: (environmentId: string, patch: Partial<LoggingEnvironment>) => Promise<void>;
  onDelete: (environment: LoggingEnvironment) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [settingsDraft, setSettingsDraft] = useState<Partial<LoggingEnvironment>>({});
  const [logsRefreshKey, setLogsRefreshKey] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [connectionInstructionsOpen, setConnectionInstructionsOpen] = useState(false);

  const setTokenDialogOpenGuarded = (nextOpen: boolean) => {
    if (nextOpen && !requireLicenseFeature("structured-logging", "Logging ingest tokens")) return;
    setTokenDialogOpen(nextOpen);
  };

  useEffect(() => {
    if (!environment) return;
    setSettingsDraft(environment);
  }, [environment]);

  if (loading) return <DetailPageSkeleton label="Loading logging environment" tabs={3} />;
  if (!environment) {
    return (
      <PageTransition>
        <div className="p-6">
          <EmptyState message="Logging environment not found." />
        </div>
      </PageTransition>
    );
  }

  const isFullHeightTab = activeTab === "logs";
  const settingsDirty = isLoggingEnvironmentSettingsDirty(environment, settingsDraft);
  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      await onUpdate(environment.id, settingsDraft);
      toast.success("Environment settings saved");
    } finally {
      setSettingsSaving(false);
    }
  };
  const headerActions: ResponsiveHeaderAction[] = [
    {
      id: "logging-environment:connect",
      label: "Connection instructions",
      icon: <Code2 className="h-4 w-4" />,
      onClick: () => setConnectionInstructionsOpen(true),
    },
    ...(activeTab === "logs"
      ? [
          {
            id: "logging-environment:refresh",
            label: "Refresh logs",
            icon: <ScrollText className="h-4 w-4" />,
            disabled: !loggingEnabled,
            onClick: () => setLogsRefreshKey((current) => current + 1),
          },
        ]
      : []),
    ...(activeTab === "tokens" && canCreateToken
      ? [
          {
            id: "logging-environment:new-token",
            label: "Create ingest token",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => setTokenDialogOpenGuarded(true),
          },
        ]
      : []),
    ...(activeTab === "settings" && canEdit
      ? [
          {
            id: "logging-environment:save",
            label: settingsSaving ? "Saving environment" : "Save environment settings",
            icon: <Save className="h-4 w-4" />,
            disabled: !settingsDirty || settingsSaving,
            onClick: () => void saveSettings(),
          },
        ]
      : []),
    ...(activeTab === "settings" && canDelete
      ? [
          {
            id: "logging-environment:delete",
            label: "Delete logging environment",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: () => void onDelete(environment),
            destructive: true,
            separatorBefore: canEdit,
          },
        ]
      : []),
  ];

  return (
    <PageTransition>
      <div
        className={
          isFullHeightTab
            ? "h-full flex flex-col overflow-hidden gap-4 p-6"
            : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate("/logging/environments")} />}
          title={environment.name}
          badges={
            <>
              <Badge variant={environment.enabled ? "success" : "secondary"} size="inline">
                {environment.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge variant="secondary" size="inline">
                {environment.schemaMode}
              </Badge>
            </>
          }
          description={
            <span className="block truncate">
              {environment.slug} · {environment.schemaName ?? "No schema attached"} ·{" "}
              {environment.retentionDays}d retention
            </span>
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              <Button variant="outline" onClick={() => setConnectionInstructionsOpen(true)}>
                <Code2 className="h-4 w-4" />
                Connect
              </Button>
              {activeTab === "logs" && (
                <RefreshButton
                  onClick={() => setLogsRefreshKey((current) => current + 1)}
                  disabled={!loggingEnabled}
                  minDurationMs={1000}
                />
              )}
              {activeTab === "tokens" && canCreateToken && (
                <Button onClick={() => setTokenDialogOpenGuarded(true)}>
                  <Plus className="h-4 w-4" />
                  New Token
                </Button>
              )}
              {activeTab === "settings" && canEdit && (
                <Button
                  pending={settingsSaving}
                  disabled={!settingsDirty}
                  onClick={() => void saveSettings()}
                >
                  <Save />
                  Save Changes
                </Button>
              )}
              {activeTab === "settings" && canDelete && (
                <Button variant="destructive" onClick={() => void onDelete(environment)}>
                  <Trash2 />
                  Delete
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => navigate(loggingEnvironmentRoute(environment.slug, value))}
          className={cn("flex flex-col", isFullHeightTab && "flex-1 min-h-0")}
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="logs" className="gap-1.5">
              Logs
            </TabsTrigger>
            <TabsTrigger value="tokens" className="gap-1.5">
              Tokens
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              Settings
            </TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="flex flex-col flex-1 min-h-0">
            <LoggingExplorer
              environment={environment}
              storageAvailable={loggingEnabled}
              refreshKey={logsRefreshKey}
            />
          </TabsContent>
          <TabsContent value="tokens">
            <LoggingTokenPanel
              environment={environment}
              canDelete={canDeleteToken}
              createDialogOpen={tokenDialogOpen}
              onCreateDialogOpenChange={setTokenDialogOpenGuarded}
            />
          </TabsContent>
          <TabsContent value="settings">
            <LoggingEnvironmentSettings
              environment={environment}
              schemas={schemas}
              canEdit={canEdit}
              draft={settingsDraft}
              onDraftChange={setSettingsDraft}
            />
          </TabsContent>
        </Tabs>
        <LoggingConnectionInstructionsDialog
          open={connectionInstructionsOpen}
          onOpenChange={setConnectionInstructionsOpen}
        />
      </div>
    </PageTransition>
  );
}

function LoggingEnvironmentSettings({
  environment,
  schemas,
  canEdit,
  draft,
  onDraftChange,
}: {
  environment: LoggingEnvironment;
  schemas: LoggingSchema[];
  canEdit: boolean;
  draft: Partial<LoggingEnvironment>;
  onDraftChange: (draft: Partial<LoggingEnvironment>) => void;
}) {
  const selectedSchemaId = draft.schemaId === undefined ? environment.schemaId : draft.schemaId;
  const selectedSchema = schemas.find((schema) => schema.id === selectedSchemaId) ?? null;
  // The same comparisons as isLoggingEnvironmentSettingsDirty, per block.
  const schemaBlockDirty =
    (draft.schemaId === undefined ? environment.schemaId : draft.schemaId) !==
      environment.schemaId || (draft.enabled ?? environment.enabled) !== environment.enabled;
  const ingestBlockDirty = isLoggingEnvironmentSettingsDirty(environment, {
    ...draft,
    schemaId: environment.schemaId,
    enabled: environment.enabled,
  });
  const effectiveSchemaMode = selectedSchema?.schemaMode ?? "loose";

  return (
    <div className="space-y-6 pb-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SettingsPanel
          title="Schema"
          description="Reusable validation attached to this environment"
          icon={<Braces className="h-4 w-4" />}
          dirty={canEdit && schemaBlockDirty}
        >
          <SettingsControlRow
            title="Attached schema"
            description="Reusable labels, fields, and schema mode"
            help="Select a reusable validation schema. No schema accepts events without schema validation and uses Loose mode."
          >
            <Select
              disabled={!canEdit}
              value={draft.schemaId ?? "none"}
              onValueChange={(schemaId) =>
                onDraftChange({ ...draft, schemaId: schemaId === "none" ? null : schemaId })
              }
            >
              <SelectTrigger aria-label="Attached schema" className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No schema</SelectItem>
                {schemas.map((schema) => (
                  <SelectItem key={schema.id} value={schema.id}>
                    {schema.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          <SettingsControlRow
            title="Mode"
            description="Effective unknown-field behavior for this environment"
            help="Inherited from the attached schema. Without a schema, the environment uses Loose mode."
          >
            <Badge variant="secondary">{effectiveSchemaMode}</Badge>
          </SettingsControlRow>
          <SettingsControlRow
            title="Enabled"
            description="Disabled environments reject ingest tokens and hide new writes"
            help="Disabling the environment rejects new ingest requests while keeping already stored events available until retention removes them."
          >
            <Switch
              disabled={!canEdit}
              checked={draft.enabled ?? environment.enabled}
              onChange={(enabled: boolean) => onDraftChange({ ...draft, enabled })}
              ariaLabel="Enabled"
            />
          </SettingsControlRow>
        </SettingsPanel>

        <SettingsPanel
          title="Ingest"
          description="Environment-specific retention and throttles"
          icon={<Gauge className="h-4 w-4" />}
          dirty={canEdit && ingestBlockDirty}
        >
          <SettingsNumberRow
            label="Retention days"
            description="Stored per event and enforced by ClickHouse TTL"
            help="Events older than this number of days are removed by ClickHouse TTL. Lowering the value can make older data expire sooner."
            placeholder="30"
            value={draft.retentionDays ?? environment.retentionDays}
            min={1}
            max={365}
            disabled={!canEdit}
            onChange={(retentionDays) =>
              onDraftChange({
                ...draft,
                retentionDays: retentionDays ?? environment.retentionDays,
              })
            }
          />
          <SettingsNumberRow
            label="Request limit"
            description="Per-window request limit for this environment"
            help="Optional environment-wide request cap for each logging rate-limit window. Leave empty to use the configured per-token request default."
            placeholder="Use token default"
            value={draft.rateLimitRequestsPerWindow ?? ""}
            min={1}
            disabled={!canEdit}
            onChange={(rateLimitRequestsPerWindow) =>
              onDraftChange({ ...draft, rateLimitRequestsPerWindow })
            }
          />
          <SettingsNumberRow
            label="Event limit"
            description="Per-window event limit for this environment"
            help="Optional environment-wide event cap for each logging rate-limit window. Leave empty to use the configured per-token event default."
            placeholder="Use token default"
            value={draft.rateLimitEventsPerWindow ?? ""}
            min={1}
            disabled={!canEdit}
            onChange={(rateLimitEventsPerWindow) =>
              onDraftChange({ ...draft, rateLimitEventsPerWindow })
            }
          />
        </SettingsPanel>
      </div>
    </div>
  );
}

function SettingsPanel({
  title,
  description,
  icon,
  dirty = false,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  /** Unsaved edits in this block: the warning border of a changed panel. */
  dirty?: boolean;
  children: ReactNode;
}) {
  return (
    <PanelShell
      title={title}
      description={description}
      icon={icon}
      dirty={dirty}
      bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
    >
      {children}
    </PanelShell>
  );
}

function SettingsTextRow({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsControlRow title={label} description={description}>
      <Input
        aria-label={label}
        className="w-full sm:w-[260px]"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </SettingsControlRow>
  );
}

function SettingsNumberRow({
  label,
  description,
  help,
  placeholder,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  help?: string;
  placeholder?: string;
  value: number | "";
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <SettingsControlRow title={label} description={description} help={help}>
      <Input
        aria-label={label}
        className="w-full sm:w-[180px]"
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      />
    </SettingsControlRow>
  );
}
