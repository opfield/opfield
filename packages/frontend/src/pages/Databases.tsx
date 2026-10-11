import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Database as DatabaseIcon,
  DatabaseZap,
  FolderPlus,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import {
  type CreateFolderChoices,
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import {
  DATABASE_TYPE_LABELS,
  databaseTypeLabel,
  KEY_VALUE_TYPE_DESCRIPTION,
  managedDatabaseVersionLabel,
} from "@/lib/database-type";
import { refreshDynamicScopes } from "@/lib/live-scopes";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { databaseRoute } from "@/lib/resource-routes";
import {
  estimateMoreTagsWidth,
  estimateResourceTagWidth,
  parseResourceTag,
  resourceTagBadgeProps,
} from "@/lib/resource-tags";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  DatabaseConnection,
  DatabaseType,
  ManagedDatabase,
  ManagedDatabaseCatalogEntry,
  ManagedDatabaseCreateInput,
  Node,
} from "@/types";
import {
  buildDatabasePayload,
  canCreateDatabase,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
} from "./database-detail/DatabaseConnectionForm";
import {
  canDeployManagedDatabase,
  type ManagedDatabaseCapacity,
  managedDatabaseCapacity,
  minimumManagedDatabaseMemoryMb,
} from "./database-detail/managed-database-capacity";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

const MANAGED_DATABASE_PROVISION_TIMEOUT_MS = 120_000;
const MANAGED_DATABASE_PROVISION_INTERVAL_MS = 750;
const DATABASE_NODE_APPEARANCE_CACHE_KEY = "databases:nodes";

type DatabaseChangedPayload = {
  id?: string;
  action?: string;
  healthStatus?: DatabaseConnection["healthStatus"];
  sampledAt?: string;
};

export function applyDatabaseHealthSample(
  rows: DatabaseConnection[],
  payload: DatabaseChangedPayload
): DatabaseConnection[] {
  if (!payload.id || payload.action !== "health.sampled") return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (row.id !== payload.id) return row;
    changed = true;
    return {
      ...row,
      ...(payload.healthStatus ? { healthStatus: payload.healthStatus } : {}),
      ...(payload.sampledAt ? { lastHealthCheckAt: payload.sampledAt } : {}),
    };
  });
  return changed ? next : rows;
}

export function canRenderDatabaseRowsWithNodeAppearance(
  rows: DatabaseConnection[],
  nodes: Node[]
): boolean {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return rows.every((row) => !row.managed || nodeIds.has(row.managed.nodeId));
}
const DIALOG_PAYLOAD_CLEAR_DELAY_MS = 260;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForManagedDatabaseReady(id: string): Promise<ManagedDatabase> {
  const deadline = Date.now() + MANAGED_DATABASE_PROVISION_TIMEOUT_MS;
  let current = await api.getManagedDatabase(id);
  while (current.status !== "ready" && current.status !== "error" && Date.now() < deadline) {
    await delay(MANAGED_DATABASE_PROVISION_INTERVAL_MS);
    current = await api.getManagedDatabase(id);
  }
  if (current.status === "ready" || current.status === "error") return current;
  throw new Error("Managed database is still starting. Check its status from the databases list.");
}

const DEFAULT_MANAGED_DATABASE_VERSIONS: Record<DatabaseType, string[]> = {
  postgres: ["18.4", "18.3", "17.10", "17.8", "16.14", "16.10", "15.18", "15.14", "14.23", "14.19"],
  redis: ["9.1.3"],
  clickhouse: [
    "26.7.1.1315",
    "26.6.2.81",
    "26.5.6.64",
    "26.4.5.143",
    "26.3.17.56",
    "25.8.28.1",
    "25.3.8.23",
    "24.8.14.39",
    "24.3.18.7",
  ],
};

const MANAGED_DATABASE_FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function catalogVersions(catalog: ManagedDatabaseCatalogEntry[], type: DatabaseType): string[] {
  return (
    catalog.find((entry) => entry.type === type)?.versions ??
    DEFAULT_MANAGED_DATABASE_VERSIONS[type]
  );
}

function defaultManagedDraft(
  catalog: ManagedDatabaseCatalogEntry[] = []
): ManagedDatabaseCreateInput {
  return {
    name: "",
    type: "postgres",
    version: catalogVersions(catalog, "postgres")[0]!,
    nodeId: "",
    storageSizeGb: 10,
    cpuCores: 1,
    memoryMb: 1024,
    swapMb: 0,
    tags: [],
    publishTcp: false,
    tlsEnabled: true,
  };
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

function formatHealthLabel(status: DatabaseConnection["healthStatus"] | "paused"): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function DatabaseTagSummary({ tags, type }: { tags: string[]; type: DatabaseConnection["type"] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typeRef = useRef<HTMLSpanElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [typeWidth, setTypeWidth] = useState<number | null>(null);
  const parsedTags = useMemo(() => tags.map(parseResourceTag), [tags]);
  const visibleCount = useMemo(() => {
    if (parsedTags.length <= 2 && containerWidth === null) return parsedTags.length;
    if (containerWidth === null || containerWidth <= 0) return Math.min(2, parsedTags.length);

    const gapWidth = 8;
    const availableWidth = Math.max(0, containerWidth - (typeWidth ?? 0) - gapWidth);
    let usedWidth = 0;
    let count = 0;

    for (let index = 0; index < parsedTags.length; index += 1) {
      const remaining = parsedTags.length - index - 1;
      const tagWidth = estimateResourceTagWidth(parsedTags[index]!);
      const moreWidth = remaining > 0 ? estimateMoreTagsWidth(remaining) + gapWidth : 0;
      const nextWidth = usedWidth + (count > 0 ? gapWidth : 0) + tagWidth;
      if (nextWidth + moreWidth > availableWidth) break;
      usedWidth = nextWidth;
      count += 1;
    }

    return Math.max(1, count);
  }, [containerWidth, parsedTags, typeWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const typeBadge = typeRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(container.getBoundingClientRect().width);
      if (typeBadge) setTypeWidth(typeBadge.getBoundingClientRect().width);
    });
    observer.observe(container);
    if (typeBadge) observer.observe(typeBadge);
    return () => observer.disconnect();
  }, []);

  const visibleTags = parsedTags.slice(0, visibleCount);
  const hiddenTags = parsedTags.slice(visibleCount);

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center justify-end gap-2">
      {visibleTags.map((tag, index) => {
        const badge = resourceTagBadgeProps(tag.color);
        return (
          <Badge
            key={`${tag.raw}:${index}`}
            variant={badge.variant}
            className={cn("max-w-[180px]", badge.className)}
            title={tag.raw}
          >
            {tag.label}
          </Badge>
        );
      })}
      {hiddenTags.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="shrink-0">
              +{hiddenTags.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="flex flex-wrap gap-1.5">
              {hiddenTags.map((tag, index) => {
                const badge = resourceTagBadgeProps(tag.color);
                return (
                  <Badge
                    key={`${tag.raw}:${visibleCount + index}`}
                    variant={badge.variant}
                    className={cn("max-w-[180px]", badge.className)}
                  >
                    {tag.label}
                  </Badge>
                );
              })}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      <span ref={typeRef} className="inline-flex shrink-0">
        <Badge variant="outline" className="uppercase">
          {databaseTypeLabel(type)}
        </Badge>
      </span>
    </div>
  );
}

export function ManagedDatabaseCreateForm({
  draft,
  nodes,
  catalog,
  capacity,
  step,
  onChange,
  folderId = "",
  folderChoices = { allowRoot: true, folders: [], defaultFolderId: "" },
  foldersLoading = false,
  onFolderChange,
}: {
  draft: ManagedDatabaseCreateInput;
  nodes: Node[];
  catalog: ManagedDatabaseCatalogEntry[];
  capacity: ManagedDatabaseCapacity;
  step: 1 | 2 | 3;
  onChange: (draft: ManagedDatabaseCreateInput) => void;
  folderId?: string;
  /** Destinations the caller may create in (see `getCreateFolderChoices`). */
  folderChoices?: CreateFolderChoices;
  foldersLoading?: boolean;
  onFolderChange?: (folderId: string) => void;
}) {
  const set = <K extends keyof ManagedDatabaseCreateInput>(
    key: K,
    value: ManagedDatabaseCreateInput[K]
  ) => onChange({ ...draft, [key]: value });
  const [resourceInputs, setResourceInputs] = useState(() => ({
    storageSizeGb: String(draft.storageSizeGb),
    cpuCores: String(draft.cpuCores),
    memoryMb: String(draft.memoryMb),
    swapMb: String(draft.swapMb),
  }));
  const [tagsInput, setTagsInput] = useState(() => (draft.tags ?? []).join(", "));
  const setResourceInput = (
    key: "storageSizeGb" | "cpuCores" | "memoryMb" | "swapMb",
    value: string
  ) => {
    setResourceInputs((current) => ({ ...current, [key]: value }));
    set(key, value === "" ? 0 : Number(value));
  };
  const versions = catalogVersions(catalog, draft.type);
  // The folder list loads when the create dialog opens.
  useContentLoading(Boolean(onFolderChange) && foldersLoading);

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {step === 1 && (
        <motion.div
          key="managed-database-step-1"
          {...MANAGED_DATABASE_FORM_ANIMATION}
          className="space-y-4"
        >
          <div className="grid gap-4">
            {onFolderChange && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="managed-db-folder">
                  Folder
                </label>
                <CreateFolderSelect
                  id="managed-db-folder"
                  choices={folderChoices}
                  value={folderId}
                  onChange={onFolderChange}
                  loading={foldersLoading}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-db-name">
                Name
              </label>
              <Input
                id="managed-db-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Production database"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={draft.type}
                onValueChange={(value) => {
                  const type = value as DatabaseType;
                  const memoryMb = Math.max(draft.memoryMb, minimumManagedDatabaseMemoryMb(type));
                  setResourceInputs((current) => ({ ...current, memoryMb: String(memoryMb) }));
                  onChange({
                    ...draft,
                    type,
                    version: catalogVersions(catalog, type)[0]!,
                    memoryMb,
                    ...(type === "clickhouse"
                      ? {
                          publishNativeTcp: draft.publishTcp
                            ? (draft.publishNativeTcp ?? true)
                            : false,
                        }
                      : { publishNativeTcp: undefined, publishedNativePort: undefined }),
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="postgres">Postgres</SelectItem>
                  <SelectItem value="redis" description={KEY_VALUE_TYPE_DESCRIPTION}>
                    {DATABASE_TYPE_LABELS.redis}
                  </SelectItem>
                  <SelectItem value="clickhouse">ClickHouse</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-db-node">
                Storage node
              </label>
              <Select value={draft.nodeId} onValueChange={(value) => set("nodeId", value)}>
                <SelectTrigger id="managed-db-node">
                  <SelectValue placeholder="Select node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.displayName || node.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Curated version</label>
              <Select value={draft.version} onValueChange={(value) => set("version", value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((version) => (
                    <SelectItem key={version} value={version}>
                      {draft.type === "redis"
                        ? managedDatabaseVersionLabel({ type: "redis", version, engine: "valkey" })
                        : version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-db-tags">
              Tags
            </label>
            <Input
              id="managed-db-tags"
              value={tagsInput}
              onChange={(event) => {
                const value = event.target.value;
                setTagsInput(value);
                set("tags", parseTags(value));
              }}
              placeholder="team, green:production, analytics"
            />
            <p className="text-xs text-muted-foreground">
              Use color:name for colored tags. Supported colors: blue, red, green, yellow, purple,
              pink, orange, gray.
            </p>
          </div>
        </motion.div>
      )}

      {step === 2 && (
        <motion.div
          key="managed-database-step-2"
          {...MANAGED_DATABASE_FORM_ANIMATION}
          className="space-y-4"
        >
          <ManagedResourceFields
            idPrefix="managed-db"
            values={resourceInputs}
            capacity={capacity}
            onChange={setResourceInput}
            minimumMemoryMb={minimumManagedDatabaseMemoryMb(draft.type)}
            memoryHint={
              draft.type === "clickhouse" ? "ClickHouse requires at least 512 MB. " : undefined
            }
          />
          <PanelShell
            title="Publish TCP port"
            description="Enables direct network connections in addition to secure managed links."
            headerBorder={draft.publishTcp}
            actions={
              <Switch
                checked={draft.publishTcp}
                onChange={(checked) =>
                  onChange({
                    ...draft,
                    publishTcp: checked,
                    ...(checked
                      ? {}
                      : {
                          publishedPort: undefined,
                          publishNativeTcp: false,
                          publishedNativePort: undefined,
                        }),
                  })
                }
                ariaLabel="Publish TCP port"
              />
            }
          >
            <AnimatePresence initial={false} mode="popLayout">
              {draft.publishTcp && (
                <motion.div key="published-tcp-settings" {...MANAGED_DATABASE_FORM_ANIMATION}>
                  <SettingsControlRow
                    title="Published TCP port"
                    description="Leave empty to let Docker allocate a free port. Gateway does not change host firewalls."
                  >
                    <Input
                      id="managed-db-published-port"
                      aria-label="Published TCP port"
                      type="number"
                      min="1"
                      max="65535"
                      value={draft.publishedPort ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        set("publishedPort", value === "" ? undefined : Number(value));
                      }}
                      placeholder="Automatic"
                    />
                  </SettingsControlRow>
                  {draft.type === "clickhouse" && (
                    <>
                      <SettingsControlRow
                        title="Publish native TCP port"
                        description="Expose the ClickHouse native protocol for native clients."
                      >
                        <Switch
                          checked={draft.publishNativeTcp ?? true}
                          onChange={(checked) =>
                            onChange({
                              ...draft,
                              publishNativeTcp: checked,
                              ...(checked ? {} : { publishedNativePort: undefined }),
                            })
                          }
                          ariaLabel="Publish native TCP port"
                        />
                      </SettingsControlRow>
                      {(draft.publishNativeTcp ?? true) && (
                        <SettingsControlRow
                          title="Native TCP port"
                          description="Leave empty to let Docker allocate a free port."
                        >
                          <Input
                            aria-label="Native TCP port"
                            type="number"
                            min="1"
                            max="65535"
                            value={draft.publishedNativePort ?? ""}
                            onChange={(event) => {
                              const value = event.target.value;
                              set("publishedNativePort", value === "" ? undefined : Number(value));
                            }}
                            placeholder="Automatic"
                          />
                        </SettingsControlRow>
                      )}
                    </>
                  )}
                  <SettingsControlRow
                    title="TLS"
                    description="Encrypt direct database traffic. Secure managed links always remain encrypted."
                  >
                    <Switch
                      checked={draft.tlsEnabled ?? true}
                      onChange={(checked) => set("tlsEnabled", checked)}
                      ariaLabel="Enable TLS"
                    />
                  </SettingsControlRow>
                </motion.div>
              )}
            </AnimatePresence>
          </PanelShell>
        </motion.div>
      )}

      {step === 3 && draft.type === "clickhouse" && (
        <motion.div key="managed-database-step-3" {...MANAGED_DATABASE_FORM_ANIMATION}>
          <PanelShell
            title="ClickHouse configuration fragment"
            description="Optional XML configuration. Security, networking and managed data paths remain controlled by Gateway."
            className="bg-background"
            bodyClassName="min-h-0 bg-background"
          >
            <CodeEditor
              value={draft.clickhouseConfigXml ?? ""}
              onChange={(value) => set("clickhouseConfigXml", value || undefined)}
              language="xml"
              height="min(42dvh, 440px)"
              bordered={false}
              showGutterBorder={false}
            />
          </PanelShell>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Databases(props: Parameters<typeof DatabasesContent>[0] = {}) {
  return (
    <LicenseFeatureBoundary
      feature="external-database-connections"
      capability="Database connections"
    >
      <DatabasesContent {...props} />
    </LicenseFeatureBoundary>
  );
}

function DatabasesContent({
  embedded = false,
  managedNodeId,
}: {
  embedded?: boolean;
  managedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const userScopes = useAuthStore((state) => state.user?.scopes);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "postgres" | "clickhouse" | "redis">("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const databaseCacheKey = useMemo(
    () =>
      managedNodeId
        ? `databases:managed-node:${managedNodeId}:${search}:${typeFilter}:${healthFilter}`
        : `databases:list:${search}:${typeFilter}:${healthFilter}`,
    [healthFilter, managedNodeId, search, typeFilter]
  );
  const initialListState = useRef<{
    rows: DatabaseConnection[];
    nodes: Node[];
    loading: boolean;
  } | null>(null);
  if (!initialListState.current) {
    const cachedRows = embedded
      ? undefined
      : (api.getCached<DatabaseConnection[]>("databases:list::all:all") ??
        api.getCached<DatabaseConnection[]>("databases:list"));
    const cachedNodes = api.getCached<Node[]>(DATABASE_NODE_APPEARANCE_CACHE_KEY) ?? [];
    const canRenderCachedRows =
      !embedded &&
      cachedRows !== undefined &&
      canRenderDatabaseRowsWithNodeAppearance(cachedRows, cachedNodes);
    initialListState.current = {
      rows: canRenderCachedRows ? cachedRows : [],
      nodes: cachedNodes,
      loading: embedded || !canRenderCachedRows,
    };
  }
  const [rows, setRows] = useState<DatabaseConnection[]>(initialListState.current.rows);
  const [loading, setLoading] = useState(initialListState.current.loading);
  const [createOpen, setCreateOpen] = useState(false);
  const [managedCreateOpen, setManagedCreateOpen] = useState(false);
  const [managedNodeRequiredOpen, setManagedNodeRequiredOpen] = useState(false);
  const [managedCreateStep, setManagedCreateStep] = useState<1 | 2 | 3>(1);
  const [managedCreateSession, setManagedCreateSession] = useState(0);
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(null));
  const [folderId, setFolderId] = useState("");
  const [managedDraft, setManagedDraft] = useState<ManagedDatabaseCreateInput>(defaultManagedDraft);
  const [managedCatalog, setManagedCatalog] = useState<ManagedDatabaseCatalogEntry[]>([]);
  const [databaseNodes, setDatabaseNodes] = useState<Node[]>(initialListState.current.nodes);
  const [databaseNodesLoaded, setDatabaseNodesLoaded] = useState(
    initialListState.current.nodes.length > 0
  );
  const [saving, setSaving] = useState(false);
  const [managedSaving, setManagedSaving] = useState(false);
  const [managedProvisioning, setManagedProvisioning] = useState<{ phase: "waiting" } | null>(null);
  const [managedProvisioningError, setManagedProvisioningError] = useState<{
    databaseConnectionId: string;
    error: string;
  } | null>(null);
  const [managedProvisioningErrorOpen, setManagedProvisioningErrorOpen] = useState(false);
  const managedProvisioningErrorOpenTimerRef = useRef<number | null>(null);
  const managedProvisioningErrorClearTimerRef = useRef<number | null>(null);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const databaseFolders = useResourceFolderStore((state) => state.foldersByType.database);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.database);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  // Same destination rule as the create routes: folder-scoped creators only get their folders,
  // node-scoped creators any folder on that node (managed databases).
  const connectionFolderChoices = useMemo(
    () => getCreateFolderChoices(userScopes ?? [], "databases:create", databaseFolders),
    [databaseFolders, userScopes]
  );

  useEffect(() => {
    if (createOpen || managedCreateOpen) void fetchFolders("database");
  }, [createOpen, fetchFolders, managedCreateOpen]);

  const openConnectionCreate = () => {
    if (requireLicenseFeature("external-database-connections", "External database connections"))
      setCreateOpen(true);
  };

  const openManagedCreate = useCallback(() => {
    if (!requireLicenseFeature("managed-databases", "Managed databases")) return;
    if (databaseNodesLoaded && databaseNodes.length === 0) {
      setManagedNodeRequiredOpen(true);
      return;
    }
    setManagedDraft(defaultManagedDraft(managedCatalog));
    setManagedCreateStep(1);
    setManagedCreateSession((session) => session + 1);
    setManagedProvisioning(null);
    setManagedCreateOpen(true);
  }, [databaseNodes.length, databaseNodesLoaded, managedCatalog]);

  const closeManagedCreate = useCallback(() => {
    if (managedProvisioning?.phase === "waiting") return;
    setManagedCreateOpen(false);
  }, [managedProvisioning]);

  const showManagedProvisioningError = useCallback(
    (failure: { databaseConnectionId: string; error: string }) => {
      setManagedCreateOpen(false);
      if (managedProvisioningErrorOpenTimerRef.current !== null) {
        window.clearTimeout(managedProvisioningErrorOpenTimerRef.current);
      }
      managedProvisioningErrorOpenTimerRef.current = window.setTimeout(() => {
        if (managedProvisioningErrorClearTimerRef.current !== null) {
          window.clearTimeout(managedProvisioningErrorClearTimerRef.current);
          managedProvisioningErrorClearTimerRef.current = null;
        }
        setManagedProvisioningError(failure);
        setManagedProvisioningErrorOpen(true);
        managedProvisioningErrorOpenTimerRef.current = null;
      }, 250);
    },
    []
  );

  const closeManagedProvisioningError = useCallback(() => {
    setManagedProvisioningErrorOpen(false);
    if (managedProvisioningErrorClearTimerRef.current !== null) {
      window.clearTimeout(managedProvisioningErrorClearTimerRef.current);
    }
    managedProvisioningErrorClearTimerRef.current = window.setTimeout(() => {
      setManagedProvisioningError(null);
      managedProvisioningErrorClearTimerRef.current = null;
    }, DIALOG_PAYLOAD_CLEAR_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (managedProvisioningErrorOpenTimerRef.current !== null) {
        window.clearTimeout(managedProvisioningErrorOpenTimerRef.current);
      }
      if (managedProvisioningErrorClearTimerRef.current !== null) {
        window.clearTimeout(managedProvisioningErrorClearTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!(location.state as { createManagedDatabase?: boolean } | null)?.createManagedDatabase) {
      return;
    }
    openManagedCreate();
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, openManagedCreate]);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      const cachedRows = api.getCached<DatabaseConnection[]>(databaseCacheKey);
      const cachedNodes = api.getCached<Node[]>(DATABASE_NODE_APPEARANCE_CACHE_KEY) ?? [];
      if (cachedRows && canRenderDatabaseRowsWithNodeAppearance(cachedRows, cachedNodes)) {
        setDatabaseNodes(cachedNodes);
        setDatabaseNodesLoaded(true);
        setRows(cachedRows);
        setLoading(false);
      } else if (!background) {
        setRows([]);
        setLoading(true);
      }

      const nodesRequest = listManagedDatabaseCandidateNodes().catch(() => null);
      // Rows are server-filtered; this lets row actions catch up with folder grants too.
      void refreshDynamicScopes();
      if (!embedded) {
        void api
          .listManagedDatabaseCatalog()
          .then(setManagedCatalog)
          .catch(() => undefined);
      }

      try {
        let data: DatabaseConnection[];
        if (managedNodeId) {
          const managed = await api.listManagedDatabases();
          const managedRows = await Promise.all(
            managed
              .filter(
                (database) => database.nodeId === managedNodeId && database.databaseConnectionId
              )
              .map((database) => api.getDatabase(database.databaseConnectionId))
          );
          data = managedRows.filter(
            (database) =>
              (!search || database.name.toLowerCase().includes(search.toLowerCase())) &&
              (typeFilter === "all" || database.type === typeFilter) &&
              (healthFilter === "all" || database.healthStatus === healthFilter)
          );
        } else {
          const result = await api.listDatabases({
            limit: 200,
            search: search || undefined,
            type: typeFilter === "all" ? undefined : typeFilter,
            healthStatus: healthFilter === "all" ? undefined : healthFilter,
          });
          data = result.data;
        }

        const nodes = await nodesRequest;
        if (nodes) {
          api.setCache(DATABASE_NODE_APPEARANCE_CACHE_KEY, nodes);
          setDatabaseNodes(nodes);
          setDatabaseNodesLoaded(true);
        }
        api.setCache(databaseCacheKey, data);
        if (search === "" && typeFilter === "all" && healthFilter === "all") {
          api.setCache("databases:list", data);
        }
        setRows(data);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to load databases");
      } finally {
        setLoading(false);
      }
    },
    [databaseCacheKey, embedded, healthFilter, managedNodeId, search, typeFilter]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("database.changed", (rawPayload) => {
    const payload = rawPayload as DatabaseChangedPayload;
    if (payload.action === "health.sampled") {
      setRows((currentRows) => {
        const nextRows = applyDatabaseHealthSample(currentRows, payload);
        if (nextRows === currentRows) return currentRows;
        api.setCache(databaseCacheKey, nextRows);
        if (search === "" && typeFilter === "all" && healthFilter === "all") {
          api.setCache("databases:list", nextRows);
        }
        return nextRows;
      });
      return;
    }
    void load({ background: true });
  });

  useRealtime("database.folder.changed", () => {
    void load({ background: true });
  });

  useRealtime(hasScopedAccess("nodes:details") ? "node.changed" : null, () => {
    void listManagedDatabaseCandidateNodes()
      .then((nodes) => {
        api.setCache(DATABASE_NODE_APPEARANCE_CACHE_KEY, nodes);
        setDatabaseNodes(nodes);
        setDatabaseNodesLoaded(true);
      })
      .catch(() => undefined);
  });

  const canCreate = !embedded && hasScopedAccess("databases:create");
  const canManageSomeFolders = useCanManageSomeFolders("databases:folders:manage");
  const canManageFolders = !embedded && canManageSomeFolders;

  // The server already filters the list by view grants, including folder grants that cover
  // resources created after the cached scopes were loaded; row actions keep their own checks.
  const filtered = rows;

  const managedVersions = useMemo(
    () => catalogVersions(managedCatalog, managedDraft.type),
    [managedCatalog, managedDraft.type]
  );
  const databaseNodeById = useMemo(
    () => new Map(databaseNodes.map((node) => [node.id, node])),
    [databaseNodes]
  );
  const deployableDatabaseNodes = useMemo(
    () => databaseNodes.filter((node) => node.status === "online" && node.isConnected),
    [databaseNodes]
  );
  const selectedDeployableDatabaseNode = useMemo(
    () => deployableDatabaseNodes.find((node) => node.id === managedDraft.nodeId),
    [deployableDatabaseNodes, managedDraft.nodeId]
  );
  const managedCapacity = useMemo(
    () => managedDatabaseCapacity(selectedDeployableDatabaseNode),
    [selectedDeployableDatabaseNode]
  );
  const managedFolderChoices = useMemo(
    () =>
      getCreateFolderChoices(
        userScopes ?? [],
        "databases:create",
        databaseFolders,
        managedDraft.nodeId || undefined
      ),
    [databaseFolders, managedDraft.nodeId, userScopes]
  );
  const canDeployManaged = useMemo(
    () =>
      !!selectedDeployableDatabaseNode &&
      canDeployManagedDatabase(managedDraft, managedVersions, managedCapacity),
    [managedCapacity, managedDraft, managedVersions, selectedDeployableDatabaseNode]
  );
  const managedCreateStepCount = managedDraft.type === "clickhouse" ? 3 : 2;
  const managedCreateStepLabel =
    managedCreateStep === 1
      ? "Database"
      : managedCreateStep === 2
        ? "Resources & network"
        : "Configuration";
  const canContinueManagedCreate =
    managedCreateStep === 1
      ? managedDraft.name.trim().length > 0 &&
        isCreateFolderAllowed(managedFolderChoices, folderId) &&
        deployableDatabaseNodes.some((node) => node.id === managedDraft.nodeId) &&
        managedVersions.includes(managedDraft.version)
      : canDeployManaged;

  const save = async () => {
    setSaving(true);
    try {
      const created = await api.createDatabase({
        ...buildDatabasePayload(draft),
        folderId: folderId || null,
      });
      toast.success("Database connection created");
      setCreateOpen(false);
      setDraft(draftFromConnection(null));
      setFolderId("");
      navigate(databaseRoute(created.slug, "overview"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create database connection");
    } finally {
      setSaving(false);
    }
  };

  const saveManaged = async () => {
    if (!canDeployManaged) {
      toast.error("Complete the managed database settings with valid resource limits");
      return;
    }
    setManagedSaving(true);
    setManagedProvisioning({ phase: "waiting" });
    let created: ManagedDatabase | null = null;
    try {
      created = await api.createManagedDatabase({
        ...managedDraft,
        folderId: folderId || null,
        publishNativeTcp: managedDraft.publishTcp ? managedDraft.publishNativeTcp : false,
        publishedNativePort: managedDraft.publishTcp ? managedDraft.publishedNativePort : undefined,
      });
      const provisioned = await waitForManagedDatabaseReady(created.id);
      if (provisioned.status !== "ready") {
        showManagedProvisioningError({
          databaseConnectionId: provisioned.databaseConnectionId,
          error: provisioned.lastError ?? "Managed database provisioning failed",
        });
        return;
      }
      toast.success("Managed database is ready");
      closeManagedCreate();
      setManagedDraft(defaultManagedDraft(managedCatalog));
      setFolderId("");
      const database = await api.getDatabase(created.databaseConnectionId);
      navigate(databaseRoute(database.slug, "overview"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create managed database";
      if (created) {
        showManagedProvisioningError({
          databaseConnectionId: created.databaseConnectionId,
          error: message,
        });
      } else {
        setManagedProvisioning(null);
        if (!handleLicenseApiError(error, "Managed databases")) toast.error(message);
      }
    } finally {
      setManagedSaving(false);
    }
  };

  const openFailedManagedDatabase = async (databaseConnectionId: string) => {
    try {
      const database = await api.getDatabase(databaseConnectionId);
      closeManagedProvisioningError();
      navigate(databaseRoute(database.slug, "overview"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to open managed database");
    }
  };

  const columns = useMemo<ResourceListColumn<DatabaseConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "38%",
        renderCell: (row) => {
          const Icon = row.managed ? DatabaseZap : DatabaseIcon;
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          const iconClassNames = nodeIconClassNames(node?.appearanceColor);

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Icon className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.host}:{row.port}
                  {row.databaseName ? ` · ${row.databaseName}` : ""}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "tags",
        label: "Tags",
        width: "34%",
        align: "right",
        renderCell: (row) => <DatabaseTagSummary tags={row.tags} type={row.type} />,
      },
      {
        id: "lastCheck",
        label: "Last Check",
        width: "14%",
        align: "center",
        renderCell: (row) => (
          <Badge variant="outline">
            <RelativeTime value={row.lastHealthCheckAt} fallback="Never" />
          </Badge>
        ),
      },
      {
        id: "health",
        label: "Health",
        width: "14%",
        align: "center",
        renderCell: (row) => {
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          if (node && (node.status !== "online" || !node.isConnected)) {
            return <Badge variant="secondary">Unavailable</Badge>;
          }
          const status = row.managed?.status === "paused" ? "paused" : row.healthStatus;
          return (
            <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>{formatHealthLabel(status)}</Badge>
          );
        },
      },
    ],
    [databaseNodeById]
  );

  return (
    <PageTransition>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <PageHeader
            leading={<LiteModeBackButton />}
            title="Databases"
            description="Manage and deploy databases"
            actions={
              <ResponsiveHeaderActions
                reservedContentWidth={160}
                actions={[
                  {
                    label: "Refresh",
                    icon: <RefreshCw className="h-4 w-4" />,
                    onClick: () => void load(),
                  },
                  ...(canManageFolders && createFolderAction
                    ? [
                        {
                          label: "Add Folder",
                          icon: <FolderPlus className="h-4 w-4" />,
                          onClick: createFolderAction,
                        },
                      ]
                    : []),
                  ...(canCreate
                    ? [
                        {
                          label: "Deploy managed database",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: openManagedCreate,
                        },
                        {
                          label: "Connect existing database",
                          icon: <Plus className="h-4 w-4" />,
                          onClick: openConnectionCreate,
                        },
                      ]
                    : []),
                ]}
              >
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void load()}
                  title="Refresh"
                  aria-label="Refresh databases"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderAction?.()}>
                    <FolderPlus className="h-4 w-4" />
                    Add Folder
                  </Button>
                )}
                {canCreate && (
                  <Button variant="outline" onClick={openConnectionCreate}>
                    <Plus className="h-4 w-4" />
                    Connect existing
                  </Button>
                )}
                {canCreate && (
                  <Button onClick={openManagedCreate}>
                    <Plus className="h-4 w-4" />
                    Deploy database
                  </Button>
                )}
              </ResponsiveHeaderActions>
            }
          />
        )}

        <FolderedResourceList<DatabaseConnection>
          resourceType="database"
          realtimeChannel="database.folder.changed"
          resources={filtered}
          columns={columns}
          search={{
            placeholder: "Search databases...",
            search,
            onSearchChange: setSearch,
            onSearchSubmit: () => void load(),
            hasActiveFilters: search !== "" || typeFilter !== "all" || healthFilter !== "all",
            onReset: () => {
              setSearch("");
              setTypeFilter("all");
              setHealthFilter("all");
            },
            filters: (
              <>
                <Select
                  value={typeFilter}
                  onValueChange={(value) => setTypeFilter(value as typeof typeFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="postgres">Postgres</SelectItem>
                    <SelectItem value="clickhouse">ClickHouse</SelectItem>
                    <SelectItem value="redis">{DATABASE_TYPE_LABELS.redis}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={healthFilter}
                  onValueChange={(value) => setHealthFilter(value as typeof healthFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All health states</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="degraded">Degraded</SelectItem>
                    <SelectItem value="offline">Offline</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ),
          }}
          loading={loading || authLoading}
          loadingLabel="Loading databases..."
          emptyState={
            <EmptyState
              message="No databases yet. Connect an existing database or deploy a managed instance."
              {...(canCreate
                ? { actionLabel: "Connect existing database", onAction: openConnectionCreate }
                : {})}
              hasActiveFilters={search !== "" || typeFilter !== "all" || healthFilter !== "all"}
              onReset={() => {
                setSearch("");
                setTypeFilter("all");
                setHealthFilter("all");
              }}
            />
          }
          minWidth={920}
          canManageFolders={canManageFolders}
          canViewItem={(row) => hasScope("databases:view") || hasScope(`databases:view:${row.id}`)}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(row) => row.name}
          onItemClick={(row) => navigate(databaseRoute(row.slug, "overview"))}
          onRefresh={() => load()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      {!embedded && (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add Database</DialogTitle>
            </DialogHeader>
            <AnimatedHeight>
              <ContentLoading loading={foldersLoading} />
              <SettingsControlRow title="Folder" description="Optional organization folder">
                <CreateFolderSelect
                  choices={connectionFolderChoices}
                  value={folderId}
                  onChange={setFolderId}
                  loading={foldersLoading}
                />
              </SettingsControlRow>
              <DatabaseConnectionForm draft={draft} onChange={setDraft} />
            </AnimatedHeight>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void save()}
                pending={saving}
                disabled={
                  !canCreateDatabase(draft) ||
                  !isCreateFolderAllowed(connectionFolderChoices, folderId)
                }
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {!embedded && (
        <Dialog
          open={managedCreateOpen}
          onOpenChange={(open) => {
            if (open) openManagedCreate();
            else closeManagedCreate();
          }}
        >
          <DialogContent
            className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
            onEscapeKeyDown={(event) => {
              if (managedProvisioning?.phase === "waiting") event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (managedProvisioning?.phase === "waiting") event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>Deploy Managed Database</DialogTitle>
              <DialogDescription>
                Step {managedCreateStep} of {managedCreateStepCount} — {managedCreateStepLabel}
              </DialogDescription>
            </DialogHeader>
            <AnimatedHeight>
              <ManagedDatabaseCreateForm
                key={managedCreateSession}
                draft={managedDraft}
                nodes={deployableDatabaseNodes}
                catalog={managedCatalog}
                capacity={managedCapacity}
                step={managedCreateStep}
                onChange={setManagedDraft}
                folderId={folderId}
                folderChoices={managedFolderChoices}
                foldersLoading={foldersLoading}
                onFolderChange={setFolderId}
              />
            </AnimatedHeight>
            <DialogFooter>
              {managedCreateStep === 1 ? (
                <>
                  <Button variant="outline" onClick={closeManagedCreate} disabled={managedSaving}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => setManagedCreateStep(2)}
                    disabled={managedSaving || !canContinueManagedCreate}
                  >
                    Next <ArrowRight className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setManagedCreateStep((step) => (step - 1) as 1 | 2 | 3)}
                    disabled={managedSaving}
                  >
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                  {managedCreateStep < managedCreateStepCount ? (
                    <Button
                      onClick={() => setManagedCreateStep(3)}
                      disabled={managedSaving || !canContinueManagedCreate}
                    >
                      Next <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void saveManaged()}
                      pending={managedSaving}
                      disabled={!canDeployManaged}
                    >
                      Deploy database
                    </Button>
                  )}
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {!embedded && (
        <Dialog open={managedNodeRequiredOpen} onOpenChange={setManagedNodeRequiredOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Connect a Node First</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Managed databases run on a connected node. Add a node first, then return here to
              deploy your database.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setManagedNodeRequiredOpen(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setManagedNodeRequiredOpen(false);
                  navigate("/nodes");
                }}
              >
                Open Nodes <ArrowRight className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {!embedded && (
        <Dialog
          open={managedProvisioningErrorOpen}
          onOpenChange={(open) => {
            if (open) setManagedProvisioningErrorOpen(true);
            else closeManagedProvisioningError();
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Database Provisioning Failed</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{managedProvisioningError?.error}</p>
            <DialogFooter>
              <Button variant="outline" onClick={closeManagedProvisioningError}>
                Close
              </Button>
              <Button
                onClick={() =>
                  managedProvisioningError &&
                  void openFailedManagedDatabase(managedProvisioningError.databaseConnectionId)
                }
              >
                Open database
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}

import { ContentLoading } from "@/components/common/ContentLoading";
import { LicenseFeatureBoundary } from "@/components/license/LicenseFeatureBoundary";
