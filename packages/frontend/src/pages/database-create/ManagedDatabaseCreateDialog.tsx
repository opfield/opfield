import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AppEnvironmentFields,
  allowedNodesHint,
  NoAllowedNodeNotice,
} from "@/components/apps/AppEnvironmentFields";
import {
  APP_FOLDER_CHOICES,
  type AppCreateContext,
  allowedAppNodes,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import {
  AvailabilityCreateSection,
  type AvailabilityDraft,
  type AvailabilityPreflightState,
  availabilityInputOf,
  EMPTY_AVAILABILITY_DRAFT,
} from "@/components/availability-sets/AvailabilityCreateSection";
import {
  type AvailabilityServers,
  AvailabilityServersSelect,
} from "@/components/availability-sets/AvailabilityServersSelect";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import {
  type CreateFolderChoices,
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { toastApiError } from "@/lib/api-error-toast";
import {
  DATABASE_TYPE_LABELS,
  KEY_VALUE_TYPE_DESCRIPTION,
  managedDatabaseVersionLabel,
} from "@/lib/database-type";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { databaseRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  AvailabilityPreflightInput,
  DatabaseType,
  ManagedDatabase,
  ManagedDatabaseCatalogEntry,
  ManagedDatabaseCreateInput,
  Node,
} from "@/types";
import {
  canDeployManagedDatabase,
  type ManagedDatabaseCapacity,
  managedDatabaseCapacity,
  minimumManagedDatabaseMemoryMb,
} from "../database-detail/managed-database-capacity";

const MANAGED_DATABASE_PROVISION_TIMEOUT_MS = 120_000;
const MANAGED_DATABASE_PROVISION_INTERVAL_MS = 750;
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
  redis: ["9.1.2"],
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

export function defaultManagedDraft(
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
  beforeFields,
  nodeLocked = false,
  nodeHint,
  serversField,
}: {
  draft: ManagedDatabaseCreateInput;
  nodes: Node[];
  catalog: ManagedDatabaseCatalogEntry[];
  capacity: ManagedDatabaseCapacity;
  /** 1 database, 2 resources & network, 3 ClickHouse configuration; any other value shows none. */
  step: number;
  onChange: (draft: ManagedDatabaseCreateInput) => void;
  folderId?: string;
  /** Destinations the caller may create in (see `getCreateFolderChoices`). */
  folderChoices?: CreateFolderChoices;
  foldersLoading?: boolean;
  onFolderChange?: (folderId: string) => void;
  /** Shown first on step 1 (the App and Environment of a database created from an app). */
  beforeFields?: ReactNode;
  /** Opened from an app with one allowed node: the node is fixed. */
  nodeLocked?: boolean;
  /** Shown under the node field (which nodes the app environment allows). */
  nodeHint?: string | null;
  /** Shown after the node field: one server or several (availability). */
  serversField?: ReactNode;
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
            {beforeFields}
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
              <Select
                value={draft.nodeId}
                onValueChange={(value) => set("nodeId", value)}
                disabled={nodeLocked}
              >
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
              {nodeHint && <p className="text-xs text-muted-foreground">{nodeHint}</p>}
            </div>
            {serversField}
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
                    description="Leave empty to let Docker allocate a free port. Opfield does not change host firewalls."
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
            description="Optional XML configuration. Security, networking and managed data paths remain controlled by Opfield."
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

const isDeployableNode = (node: Node) => node.status === "online" && node.isConnected;

type CreateStep = "database" | "resources" | "config" | "availability";

/**
 * Deploy Managed Database, with the provisioning wait and its failure dialog. Stays mounted;
 * `open` drives it and each opening starts a new draft. With `appContext` (opened from an app):
 * locked App field, environment select, only the environment's allowed storage nodes, created in
 * the environment's folder; without `onCreated` it opens the new database when it is ready.
 */
export function ManagedDatabaseCreateDialog({
  open,
  onOpenChange,
  nodes: nodesProp,
  catalog: catalogProp,
  appContext,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deployable candidate nodes the caller already loaded; loaded on open when omitted. */
  nodes?: Node[];
  /** The managed database catalog the caller already loaded; loaded on open when omitted. */
  catalog?: ManagedDatabaseCatalogEntry[];
  appContext?: AppCreateContext;
  /** Called with the new database connection id instead of opening it. */
  onCreated?: (databaseConnectionId: string) => void;
}) {
  const navigate = useNavigate();
  const userScopes = useAuthStore((state) => state.user?.scopes);
  const databaseFolders = useResourceFolderStore((state) => state.foldersByType.database);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.database);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  const [loadedNodes, setLoadedNodes] = useState<Node[] | null>(null);
  const [loadedCatalog, setLoadedCatalog] = useState<ManagedDatabaseCatalogEntry[]>([]);
  const catalog = catalogProp ?? loadedCatalog;
  const [step, setStep] = useState(1);
  const [session, setSession] = useState(0);
  const [draft, setDraft] = useState<ManagedDatabaseCreateInput>(defaultManagedDraft);
  const [servers, setServers] = useState<AvailabilityServers>("single");
  const [availabilityDraft, setAvailabilityDraft] =
    useState<AvailabilityDraft>(EMPTY_AVAILABILITY_DRAFT);
  const [availabilityCheck, setAvailabilityCheck] = useState<AvailabilityPreflightState>({
    result: null,
    pending: false,
  });
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState<{ phase: "waiting" } | null>(null);
  const [provisioningError, setProvisioningError] = useState<{
    databaseConnectionId: string;
    error: string;
  } | null>(null);
  const [provisioningErrorOpen, setProvisioningErrorOpen] = useState(false);
  const errorOpenTimerRef = useRef<number | null>(null);
  const errorClearTimerRef = useRef<number | null>(null);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const wasOpen = useRef(false);

  // Each opening starts a new draft (on the catalog the dialog has at that moment).
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(defaultManagedDraft(catalogRef.current));
      setServers("single");
      setAvailabilityDraft(EMPTY_AVAILABILITY_DRAFT);
      setStep(1);
      setSaving(false);
      setSession((current) => current + 1);
      setProvisioning(null);
      setFolderId("");
      if (!appContext) void fetchFolders("database");
    }
    wasOpen.current = open;
  }, [appContext, fetchFolders, open]);

  useEffect(() => {
    if (!open || nodesProp) return;
    let cancelled = false;
    void listManagedDatabaseCandidateNodes()
      .then((nodes) => {
        if (!cancelled) setLoadedNodes(nodes);
      })
      .catch(() => {
        if (!cancelled) setLoadedNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nodesProp, open]);

  useEffect(() => {
    if (!open || catalogProp) return;
    let cancelled = false;
    void api
      .listManagedDatabaseCatalog()
      .then((next) => {
        if (cancelled) return;
        setLoadedCatalog(next);
        // A draft opened before the catalog arrived moves to a catalog version.
        setDraft((current) =>
          catalogVersions(next, current.type).includes(current.version)
            ? current
            : { ...current, version: catalogVersions(next, current.type)[0]! }
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalogProp, open]);

  const deployableNodes = useMemo(
    () => nodesProp ?? (loadedNodes ?? []).filter(isDeployableNode),
    [loadedNodes, nodesProp]
  );
  const nodesLoaded = !!nodesProp || loadedNodes !== null;
  // From an app: only the storage nodes the environment allows.
  const nodes = useMemo(
    () => (appContext ? allowedAppNodes(environment, deployableNodes) : deployableNodes),
    [appContext, deployableNodes, environment]
  );
  const appNodeLocked = !!appContext && nodes.length === 1;
  const noAllowedNode = !!appContext && !!environment && nodesLoaded && nodes.length === 0;
  useEffect(() => {
    if (!open || !appContext || !nodesLoaded) return;
    setDraft((current) => {
      if (appNodeLocked) {
        return current.nodeId === nodes[0]!.id ? current : { ...current, nodeId: nodes[0]!.id };
      }
      return current.nodeId && !nodes.some((node) => node.id === current.nodeId)
        ? { ...current, nodeId: "" }
        : current;
    });
  }, [appContext, appNodeLocked, nodes, nodesLoaded, open]);

  const placementFolderId = appContext ? appPlacementFolderId(environment, "databases") : null;
  const versions = useMemo(() => catalogVersions(catalog, draft.type), [catalog, draft.type]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === draft.nodeId),
    [draft.nodeId, nodes]
  );
  const capacity = useMemo(() => managedDatabaseCapacity(selectedNode), [selectedNode]);
  // Same destination rule as the create routes: folder-scoped creators only get their folders,
  // node-scoped creators any folder on that node.
  const folderChoices = useMemo(
    () =>
      appContext
        ? APP_FOLDER_CHOICES
        : getCreateFolderChoices(
            userScopes ?? [],
            "databases:create",
            databaseFolders,
            draft.nodeId || undefined
          ),
    [appContext, databaseFolders, draft.nodeId, userScopes]
  );
  const destinationAllowed = appContext
    ? canCreateInFolder(
        userScopes ?? [],
        "databases:create",
        placementFolderId,
        draft.nodeId || undefined
      )
    : isCreateFolderAllowed(folderChoices, folderId);
  const canDeploy =
    !!selectedNode && !noAllowedNode && canDeployManagedDatabase(draft, versions, capacity);
  const several = servers === "several";
  const steps: CreateStep[] = [
    "database",
    "resources",
    ...(draft.type === "clickhouse" ? (["config"] as const) : []),
    ...(several ? (["availability"] as const) : []),
  ];
  const stepCount = steps.length;
  const stepKind: CreateStep = steps[Math.min(step, stepCount) - 1] ?? "database";
  const formStep =
    stepKind === "database" ? 1 : stepKind === "resources" ? 2 : stepKind === "config" ? 3 : 0;
  const stepLabel = {
    database: "Database",
    resources: "Resources & network",
    config: "Configuration",
    availability: "Availability",
  }[stepKind];
  const availabilityReady =
    !!availabilityCheck.result &&
    !availabilityCheck.pending &&
    availabilityCheck.result.blockers.length === 0;
  const manualPair = several && availabilityCheck.result?.mode === "manual";
  const canContinue =
    stepKind === "database"
      ? draft.name.trim().length > 0 &&
        !noAllowedNode &&
        destinationAllowed &&
        nodes.some((node) => node.id === draft.nodeId) &&
        versions.includes(draft.version)
      : stepKind === "availability"
        ? canDeploy && availabilityReady
        : canDeploy;
  const createFolderId = (appContext ? placementFolderId : folderId) || null;
  const runAvailabilityPreflight = useCallback(
    (input: AvailabilityPreflightInput) =>
      api.preflightAvailabilityForCreate("database", {
        ...input,
        type: draft.type,
        version: draft.version,
        tlsEnabled: draft.tlsEnabled,
        storageSizeGb: draft.storageSizeGb,
        folderId: createFolderId,
      }),
    [createFolderId, draft.storageSizeGb, draft.tlsEnabled, draft.type, draft.version]
  );

  const close = useCallback(() => {
    if (provisioning?.phase === "waiting") return;
    onOpenChange(false);
  }, [onOpenChange, provisioning]);

  const showProvisioningError = useCallback(
    (failure: { databaseConnectionId: string; error: string }) => {
      onOpenChange(false);
      if (errorOpenTimerRef.current !== null) window.clearTimeout(errorOpenTimerRef.current);
      errorOpenTimerRef.current = window.setTimeout(() => {
        if (errorClearTimerRef.current !== null) {
          window.clearTimeout(errorClearTimerRef.current);
          errorClearTimerRef.current = null;
        }
        setProvisioningError(failure);
        setProvisioningErrorOpen(true);
        errorOpenTimerRef.current = null;
      }, 250);
    },
    [onOpenChange]
  );

  const closeProvisioningError = useCallback(() => {
    setProvisioningErrorOpen(false);
    if (errorClearTimerRef.current !== null) window.clearTimeout(errorClearTimerRef.current);
    errorClearTimerRef.current = window.setTimeout(() => {
      setProvisioningError(null);
      errorClearTimerRef.current = null;
    }, DIALOG_PAYLOAD_CLEAR_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (errorOpenTimerRef.current !== null) window.clearTimeout(errorOpenTimerRef.current);
      if (errorClearTimerRef.current !== null) window.clearTimeout(errorClearTimerRef.current);
    },
    []
  );

  const save = async () => {
    if (!canDeploy) {
      toast.error("Complete the managed database settings with valid resource limits");
      return;
    }
    setSaving(true);
    setProvisioning({ phase: "waiting" });
    let created: ManagedDatabase | null = null;
    let closed = false;
    try {
      created = await api.createManagedDatabase({
        ...draft,
        folderId: createFolderId,
        publishNativeTcp: draft.publishTcp ? draft.publishNativeTcp : false,
        publishedNativePort: draft.publishTcp ? draft.publishedNativePort : undefined,
        ...(several
          ? { availability: availabilityInputOf(draft.nodeId, availabilityDraft, draft.type) }
          : {}),
      });
      rememberAppCreation(appContext, environment);
      if (created.availabilityError) {
        toast.warning(`Created on one server: ${created.availabilityError}`);
      }
      const provisioned = await waitForManagedDatabaseReady(created.id);
      if (provisioned.status !== "ready") {
        onCreated?.(provisioned.databaseConnectionId);
        showProvisioningError({
          databaseConnectionId: provisioned.databaseConnectionId,
          error: provisioned.lastError ?? "Managed database provisioning failed",
        });
        return;
      }
      toast.success("Managed database is ready");
      setProvisioning(null);
      closed = true;
      onOpenChange(false);
      if (onCreated) {
        onCreated(created.databaseConnectionId);
        return;
      }
      const database = await api.getDatabase(created.databaseConnectionId);
      navigate(databaseRoute(database.slug, "overview"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create managed database";
      if (created) {
        onCreated?.(created.databaseConnectionId);
        showProvisioningError({
          databaseConnectionId: created.databaseConnectionId,
          error: message,
        });
      } else {
        setProvisioning(null);
        if (!handleLicenseApiError(error, "Managed databases")) toast.error(message);
      }
    } finally {
      if (!closed) setSaving(false);
    }
  };

  const openFailedDatabase = async (databaseConnectionId: string) => {
    try {
      const database = await api.getDatabase(databaseConnectionId);
      closeProvisioningError();
      navigate(databaseRoute(database.slug, "overview"));
    } catch (error) {
      toastApiError(error, "Failed to open managed database");
    }
  };

  const appFields = appContext ? (
    <AppEnvironmentFields
      context={appContext}
      environmentId={environmentId}
      onEnvironmentChange={setEnvironmentId}
      disabled={saving}
    />
  ) : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
          onEscapeKeyDown={(event) => {
            if (provisioning?.phase === "waiting") event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (provisioning?.phase === "waiting") event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Deploy Managed Database</DialogTitle>
            <DialogDescription>
              Step {step} of {stepCount} — {stepLabel}
            </DialogDescription>
          </DialogHeader>
          <AnimatedHeight>
            {noAllowedNode && appContext && environment ? (
              <div className="space-y-4">
                {appFields}
                <NoAllowedNodeNotice
                  context={appContext}
                  environment={environment}
                  nodeKind="storage"
                  resourceKind="Databases"
                  onNavigate={() => onOpenChange(false)}
                />
              </div>
            ) : (
              <ManagedDatabaseCreateForm
                key={session}
                draft={draft}
                nodes={nodes}
                catalog={catalog}
                capacity={capacity}
                step={formStep}
                onChange={setDraft}
                folderId={appContext ? "" : folderId}
                folderChoices={folderChoices}
                foldersLoading={!appContext && foldersLoading}
                onFolderChange={setFolderId}
                beforeFields={appFields}
                nodeLocked={appNodeLocked}
                nodeHint={
                  appContext && environment && nodes.length > 0
                    ? allowedNodesHint(environment, nodes.length, "storage")
                    : null
                }
                serversField={
                  <AvailabilityServersSelect
                    value={servers}
                    onChange={setServers}
                    disabled={saving}
                  />
                }
              />
            )}
            {stepKind === "availability" && draft.nodeId ? (
              <AvailabilityCreateSection
                engine={draft.type}
                originNodeId={draft.nodeId}
                nodes={nodes}
                value={availabilityDraft}
                onChange={setAvailabilityDraft}
                runPreflight={runAvailabilityPreflight}
                onPreflight={setAvailabilityCheck}
                disabled={saving}
              />
            ) : null}
          </AnimatedHeight>
          <DialogFooter>
            {step === 1 ? (
              <>
                <Button variant="outline" onClick={close} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={() => setStep(2)} disabled={saving || !canContinue}>
                  Next <ArrowRight className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setStep((current) => Math.max(1, current - 1))}
                  disabled={saving}
                >
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                {step < stepCount ? (
                  <Button
                    onClick={() => setStep((current) => current + 1)}
                    disabled={saving || !canContinue}
                  >
                    Next <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    onClick={() => void save()}
                    pending={saving}
                    disabled={!canDeploy || (several && !availabilityReady)}
                  >
                    {manualPair ? "Create replicated pair (manual failover)" : "Deploy database"}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={provisioningErrorOpen}
        onOpenChange={(next) => {
          if (next) setProvisioningErrorOpen(true);
          else closeProvisioningError();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Database Provisioning Failed</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{provisioningError?.error}</p>
          <DialogFooter>
            <Button variant="outline" onClick={closeProvisioningError}>
              Close
            </Button>
            <Button
              onClick={() =>
                provisioningError && void openFailedDatabase(provisioningError.databaseConnectionId)
              }
            >
              Open database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
