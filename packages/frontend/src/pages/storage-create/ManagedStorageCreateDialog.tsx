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
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "@/components/common/CreateFolderSelect";
import { ManagedResourceFields } from "@/components/common/ManagedResourceFields";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SwitchCard } from "@/components/common/SwitchCard";
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
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import {
  isManagedStorageCandidateNode,
  listManagedDatabaseCandidateNodes,
} from "@/lib/managed-database-nodes";
import { storageRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import { useResourceFolderStore } from "@/stores/resource-folders";
import type {
  AvailabilityPreflightInput,
  ManagedObjectStorage,
  ManagedObjectStorageCatalogEntry,
  ManagedObjectStorageCreateInput,
  Node,
} from "@/types";
import {
  canDeployManagedStorage,
  type ManagedStorageCapacity,
  managedStorageClusterCapacity,
} from "../storage-detail/managed-storage-capacity";
import {
  catalogEngineVersions,
  MANAGED_STORAGE_CREATE_ENGINE,
  MANAGED_STORAGE_ENGINE_LABELS,
  managedStorageMinimumMemoryMb,
} from "../storage-detail/managed-storage-engine";

const MANAGED_STORAGE_PROVISION_TIMEOUT_MS = 120_000;
const MANAGED_STORAGE_PROVISION_INTERVAL_MS = 750;

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function waitForManagedObjectStorageReady(id: string): Promise<ManagedObjectStorage> {
  const deadline = Date.now() + MANAGED_STORAGE_PROVISION_TIMEOUT_MS;
  let current = await api.getManagedObjectStorage(id);
  while (current.status !== "ready" && current.status !== "error" && Date.now() < deadline) {
    await delay(MANAGED_STORAGE_PROVISION_INTERVAL_MS);
    current = await api.getManagedObjectStorage(id);
  }
  if (current.status === "ready" || current.status === "error") return current;
  throw new Error("Managed storage is still starting. Check its status from the storage list.");
}

const MANAGED_STORAGE_FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

/** Versions of the engine new clusters run; the wizard only offers catalog keys. */
function catalogStorageVersions(catalog: ManagedObjectStorageCatalogEntry[]): string[] {
  return catalogEngineVersions(catalog, MANAGED_STORAGE_CREATE_ENGINE);
}

const MANAGED_STORAGE_MINIMUM_MEMORY_MB = managedStorageMinimumMemoryMb(
  MANAGED_STORAGE_CREATE_ENGINE
);

export function defaultManagedStorageDraft(
  catalog: ManagedObjectStorageCatalogEntry[] = []
): ManagedObjectStorageCreateInput {
  return {
    engine: MANAGED_STORAGE_CREATE_ENGINE,
    name: "",
    version: catalogStorageVersions(catalog)[0] ?? "",
    nodeId: "",
    storageSizeGb: 10,
    cpuCores: 1,
    memoryMb: 1024,
    swapMb: 0,
    publishedPort: 9000,
    publishS3: false,
    relayEnabled: true,
    tlsEnabled: true,
    tags: [],
  };
}

function parseStorageTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

export function ManagedObjectStorageCreateForm({
  draft,
  nodes,
  catalog,
  capacity,
  step,
  onChange,
  beforeFields,
  nodeLocked = false,
  nodeHint,
  serversField,
}: {
  draft: ManagedObjectStorageCreateInput;
  nodes: Node[];
  catalog: ManagedObjectStorageCatalogEntry[];
  capacity: ManagedStorageCapacity;
  /** 1 storage, 2 resources, 3 network access; any other value shows none. */
  step: number;
  onChange: (draft: ManagedObjectStorageCreateInput) => void;
  /** Shown first on step 1 (the App, Environment and Folder fields of the dialog). */
  beforeFields?: ReactNode;
  /** Opened from an app with one allowed node: the node is fixed. */
  nodeLocked?: boolean;
  /** Shown under the node field (which nodes the app environment allows). */
  nodeHint?: string | null;
  /** Shown after the node field: one server or several (availability). */
  serversField?: ReactNode;
}) {
  const set = <K extends keyof ManagedObjectStorageCreateInput>(
    key: K,
    value: ManagedObjectStorageCreateInput[K]
  ) => onChange({ ...draft, [key]: value });
  const [resourceInputs, setResourceInputs] = useState(() => ({
    storageSizeGb: String(draft.storageSizeGb),
    cpuCores: String(draft.cpuCores),
    memoryMb: String(draft.memoryMb),
    swapMb: String(draft.swapMb),
    publishedPort: String(draft.publishedPort),
  }));
  const setResourceInput = (
    key: "storageSizeGb" | "cpuCores" | "memoryMb" | "swapMb" | "publishedPort",
    value: string
  ) => {
    setResourceInputs((current) => ({ ...current, [key]: value }));
    set(key, value === "" ? 0 : Number(value));
  };
  const [tagsInput, setTagsInput] = useState(() => (draft.tags ?? []).join(", "));
  const versions = catalogStorageVersions(catalog);
  const engineLabel = MANAGED_STORAGE_ENGINE_LABELS[MANAGED_STORAGE_CREATE_ENGINE];

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {step === 1 && (
        <motion.div
          key="managed-storage-step-1"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <div className="grid gap-4">
            {beforeFields}
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-storage-name">
                Name
              </label>
              <Input
                id="managed-storage-name"
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Production storage"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-storage-node">
                Storage node
              </label>
              <Select
                value={draft.nodeId}
                onValueChange={(value) => set("nodeId", value)}
                disabled={nodeLocked}
              >
                <SelectTrigger id="managed-storage-node">
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
              {nodes.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No Storage-capable nodes available — enroll or update a Storage node first, then
                  it appears here.
                </p>
              )}
            </div>
            {serversField}
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="managed-storage-version">
                Engine version
              </label>
              <Select value={draft.version} onValueChange={(value) => set("version", value)}>
                <SelectTrigger id="managed-storage-version">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((version) => (
                    <SelectItem key={version} value={version}>
                      {engineLabel} {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {versions.length > 0
                  ? `New storage runs ${engineLabel}.`
                  : `The storage catalog lists no ${engineLabel} version yet. Refresh the page and try again.`}
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-tags">
              Tags
            </label>
            <Input
              id="managed-storage-tags"
              value={tagsInput}
              onChange={(event) => {
                setTagsInput(event.target.value);
                set("tags", parseStorageTags(event.target.value));
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
          key="managed-storage-step-2"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <ManagedResourceFields
            idPrefix="managed-storage"
            values={resourceInputs}
            capacity={{
              storageSizeGb: capacity.maxStorageGb,
              cpuCores: capacity.maxCpuCores || undefined,
              memoryMb: capacity.maxMemoryMb || undefined,
              swapMb: capacity.maxSwapMb || undefined,
            }}
            onChange={setResourceInput}
            minimumStorageGb={1}
            minimumMemoryMb={MANAGED_STORAGE_MINIMUM_MEMORY_MB}
            memoryHint={`${engineLabel} requires at least ${MANAGED_STORAGE_MINIMUM_MEMORY_MB} MB. `}
          />
          {capacity.maxStorageGb === undefined && (
            <p role="status" className="text-sm text-muted-foreground">
              Storage-root capacity is unavailable. Update the Storage node daemon, wait for its
              next health report, then reopen this wizard.
            </p>
          )}
        </motion.div>
      )}
      {step === 3 && (
        <motion.div
          key="managed-storage-step-3"
          {...MANAGED_STORAGE_FORM_ANIMATION}
          className="space-y-4"
        >
          <PanelShell
            title="Publish S3 endpoint"
            description="Expose a host port in addition to private access."
            headerBorder={draft.publishS3 ?? false}
            actions={
              <Switch
                checked={draft.publishS3 ?? false}
                onChange={(enabled) => set("publishS3", enabled)}
                ariaLabel="Publish S3 endpoint"
              />
            }
          >
            {draft.publishS3 && (
              <SettingsControlRow title="S3 API port">
                <Input
                  id="managed-storage-publishedPort"
                  aria-label="S3 API port"
                  type="number"
                  min="1"
                  max={65535}
                  disabled={!draft.publishS3}
                  value={resourceInputs.publishedPort}
                  onChange={(event) => setResourceInput("publishedPort", event.target.value)}
                />
              </SettingsControlRow>
            )}
          </PanelShell>
          <SwitchCard
            label="TLS"
            description="Encrypt the S3 endpoint with a certificate from the Opfield Storage CA."
            checked={draft.tlsEnabled ?? false}
            onCheckedChange={(enabled) => set("tlsEnabled", enabled)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const isDeployableNode = (node: Node) => node.status === "online" && node.isConnected;

/**
 * Deploy Managed Storage, with the provisioning wait and its failure dialog (Retry). Stays
 * mounted; `open` drives it and each opening starts a new draft. With `appContext` (opened from
 * an app): locked App field, environment select, only the environment's allowed storage nodes,
 * created in the environment's folder; without `onCreated` it opens the new storage when ready.
 */
export function ManagedStorageCreateDialog({
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
  /** The managed storage catalog the caller already loaded; loaded on open when omitted. */
  catalog?: ManagedObjectStorageCatalogEntry[];
  appContext?: AppCreateContext;
  /** Called with the new managed storage id instead of opening it. */
  onCreated?: (managedStorageId: string) => void;
}) {
  const navigate = useNavigate();
  const userScopes = useAuthStore((state) => state.user?.scopes);
  const storageFolders = useResourceFolderStore((state) => state.foldersByType.storage);
  const foldersLoading = useResourceFolderStore((state) => state.loadingByType.storage);
  const fetchFolders = useResourceFolderStore((state) => state.fetchFolders);
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(
    appContext,
    open
  );
  const [loadedNodes, setLoadedNodes] = useState<Node[] | null>(null);
  const [loadedCatalog, setLoadedCatalog] = useState<ManagedObjectStorageCatalogEntry[]>([]);
  const catalog = catalogProp ?? loadedCatalog;
  const [step, setStep] = useState(1);
  const [session, setSession] = useState(0);
  const [draft, setDraft] = useState<ManagedObjectStorageCreateInput>(defaultManagedStorageDraft);
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
    managedStorageId: string;
    error: string;
  } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retainedProvisioningError = useRetainedDialogValue(
    provisioningError,
    provisioningError !== null
  );
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const wasOpen = useRef(false);

  // Each opening starts a new draft (on the catalog the dialog has at that moment).
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(defaultManagedStorageDraft(catalogRef.current));
      setFolderId("");
      setServers("single");
      setAvailabilityDraft(EMPTY_AVAILABILITY_DRAFT);
      setStep(1);
      setSession((current) => current + 1);
      setProvisioning(null);
      if (!appContext) void fetchFolders("storage");
    }
    wasOpen.current = open;
  }, [appContext, fetchFolders, open]);

  useEffect(() => {
    if (!open || nodesProp) return;
    let cancelled = false;
    void listManagedDatabaseCandidateNodes(100)
      .then((nodes) => {
        if (!cancelled) setLoadedNodes(nodes.filter(isManagedStorageCandidateNode));
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
      .listManagedObjectStorageCatalog()
      .then((next) => {
        if (!cancelled) setLoadedCatalog(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalogProp, open]);

  const versions = useMemo(() => catalogStorageVersions(catalog), [catalog]);
  // The catalog can arrive after the wizard opened; keep the draft on a catalog version.
  useEffect(() => {
    setDraft((current) =>
      versions.includes(current.version) ? current : { ...current, version: versions[0] ?? "" }
    );
  }, [versions]);

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

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === draft.nodeId),
    [draft.nodeId, nodes]
  );
  const capacity = useMemo(
    () => managedStorageClusterCapacity({ nodeId: draft.nodeId }, nodes),
    [draft.nodeId, nodes]
  );
  const placementFolderId = appContext ? appPlacementFolderId(environment, "storage") : null;
  // Same destination rules as the create routes: folder-scoped creators only get their
  // folders; node-scoped creators any folder on that node.
  const folderChoices = useMemo(
    () =>
      appContext
        ? APP_FOLDER_CHOICES
        : getCreateFolderChoices(
            userScopes ?? [],
            "storage:create",
            storageFolders,
            draft.nodeId || undefined
          ),
    [appContext, draft.nodeId, storageFolders, userScopes]
  );
  const destinationAllowed = appContext
    ? canCreateInFolder(
        userScopes ?? [],
        "storage:create",
        placementFolderId,
        draft.nodeId || undefined
      )
    : isCreateFolderAllowed(folderChoices, folderId);
  const canDeploy =
    !!selectedNode && !noAllowedNode && canDeployManagedStorage(draft, versions, capacity);
  const several = servers === "several";
  const stepCount = several ? 4 : 3;
  const stepLabel = { 1: "Storage", 2: "Resources", 3: "Network access", 4: "Availability" }[
    Math.min(step, stepCount) as 1 | 2 | 3 | 4
  ];
  const availabilityReady =
    !!availabilityCheck.result &&
    !availabilityCheck.pending &&
    availabilityCheck.result.blockers.length === 0;
  const manualPair = several && availabilityCheck.result?.mode === "manual";
  const canContinue =
    step === 1
      ? draft.name.trim().length > 0 &&
        !noAllowedNode &&
        destinationAllowed &&
        nodes.some((node) => node.id === draft.nodeId) &&
        versions.includes(draft.version)
      : step === 3
        ? canDeploy
        : canDeployManagedStorage({ ...draft, publishedPort: 9000 }, versions, capacity);
  const createFolderId = (appContext ? placementFolderId : folderId) || null;
  const runAvailabilityPreflight = useCallback(
    (input: AvailabilityPreflightInput) =>
      api.preflightAvailabilityForCreate("storage", {
        ...input,
        version: draft.version,
        storageSizeGb: draft.storageSizeGb,
        folderId: createFolderId,
      }),
    [createFolderId, draft.storageSizeGb, draft.version]
  );

  const close = useCallback(() => {
    if (provisioning?.phase === "waiting") return;
    onOpenChange(false);
    setProvisioning(null);
  }, [onOpenChange, provisioning]);

  const showProvisioningError = useCallback(
    (failure: { managedStorageId: string; error: string }) => {
      onOpenChange(false);
      setProvisioning(null);
      window.setTimeout(() => setProvisioningError(failure), 250);
    },
    [onOpenChange]
  );

  const openStorage = async (objectStorageConnectionId: string) => {
    const connection = await api.getObjectStorage(objectStorageConnectionId);
    navigate(storageRoute(connection.slug, "browser"));
  };

  const save = async () => {
    if (!canDeploy) {
      toast.error("Complete the managed storage settings with valid resource limits");
      return;
    }
    setSaving(true);
    setProvisioning({ phase: "waiting" });
    let created: ManagedObjectStorage | null = null;
    try {
      created = await api.createManagedObjectStorage({
        ...draft,
        folderId: createFolderId,
        ...(several
          ? { availability: availabilityInputOf(draft.nodeId, availabilityDraft, "seaweedfs") }
          : {}),
      });
      rememberAppCreation(appContext, environment);
      if (created.availabilityError) {
        toast.warning(`Created on one server: ${created.availabilityError}`);
      }
      const provisioned = await waitForManagedObjectStorageReady(created.id);
      if (provisioned.status !== "ready" || !provisioned.objectStorageConnectionId) {
        onCreated?.(provisioned.id);
        showProvisioningError({
          managedStorageId: provisioned.id,
          error: provisioned.lastError ?? "Managed storage provisioning failed",
        });
        return;
      }
      toast.success("Managed storage is ready");
      onOpenChange(false);
      setProvisioning(null);
      if (onCreated) {
        onCreated(provisioned.id);
        return;
      }
      await openStorage(provisioned.objectStorageConnectionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create managed storage";
      if (created) {
        onCreated?.(created.id);
        showProvisioningError({ managedStorageId: created.id, error: message });
      } else {
        setProvisioning(null);
        if (!handleLicenseApiError(error, "Managed storage")) toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const retryProvisioning = async () => {
    if (!provisioningError) return;
    setRetrying(true);
    try {
      const retried = await api.retryManagedObjectStorageProvisioning(
        provisioningError.managedStorageId
      );
      const provisioned = await waitForManagedObjectStorageReady(retried.id);
      if (provisioned.status !== "ready" || !provisioned.objectStorageConnectionId) {
        setProvisioningError({
          managedStorageId: provisioned.id,
          error: provisioned.lastError ?? "Managed storage provisioning failed",
        });
        return;
      }
      toast.success("Managed storage is ready");
      setProvisioningError(null);
      if (onCreated) {
        onCreated(provisioned.id);
        return;
      }
      await openStorage(provisioned.objectStorageConnectionId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to retry provisioning");
    } finally {
      setRetrying(false);
    }
  };

  const stepOneFields =
    step === 1 ? (
      <>
        {appContext && (
          <AppEnvironmentFields
            context={appContext}
            environmentId={environmentId}
            onEnvironmentChange={setEnvironmentId}
            disabled={saving}
          />
        )}
        {!noAllowedNode && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="managed-storage-folder">
              Folder
            </label>
            <CreateFolderSelect
              id="managed-storage-folder"
              choices={folderChoices}
              value={appContext ? "" : folderId}
              onChange={setFolderId}
              loading={!appContext && foldersLoading}
            />
          </div>
        )}
      </>
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
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
          onEscapeKeyDown={(event) => {
            if (provisioning?.phase === "waiting") event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (provisioning?.phase === "waiting") event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Deploy Managed Storage</DialogTitle>
            <DialogDescription>
              Step {step} of {stepCount} — {stepLabel}
            </DialogDescription>
          </DialogHeader>
          <AnimatedHeight>
            <ContentLoading loading={!appContext && foldersLoading} />
            {noAllowedNode && appContext && environment ? (
              <div className="space-y-4">
                {stepOneFields}
                <NoAllowedNodeNotice
                  context={appContext}
                  environment={environment}
                  nodeKind="storage"
                  resourceKind="Storage"
                  onNavigate={() => onOpenChange(false)}
                />
              </div>
            ) : (
              <ManagedObjectStorageCreateForm
                key={session}
                draft={draft}
                nodes={nodes}
                catalog={catalog}
                capacity={capacity}
                step={step}
                onChange={setDraft}
                beforeFields={stepOneFields}
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
            {step === 4 && several && draft.nodeId ? (
              <AvailabilityCreateSection
                engine="seaweedfs"
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
                    {manualPair ? "Create replicated pair (manual failover)" : "Deploy storage"}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={provisioningError !== null}
        onOpenChange={(next) => !next && setProvisioningError(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Storage Provisioning Failed</DialogTitle>
            <DialogDescription>
              What the node reported, and the options for recovering this cluster.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{retainedProvisioningError?.error}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProvisioningError(null)}
              disabled={retrying}
            >
              Close
            </Button>
            <Button onClick={() => void retryProvisioning()} pending={retrying}>
              Retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
