import { AnimatePresence, motion } from "framer-motion";
import { Link2, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
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
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { databaseTypeLabel } from "@/lib/database-type";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { planIncludes } from "@/stores/license-paywall";
import type {
  DatabaseType,
  ManagedDatabase,
  ManagedDatabaseBinding,
  ManagedDatabaseBindingEnvironment,
  ManagedDatabaseBindingTargetType,
  Node,
} from "@/types";
import {
  LINK_REMOVE_BUTTON_CLASS,
  LinkNodeBadge,
  LinkRowTitle,
  LinkStatusBadge,
  useInLinksPanel,
  useLinkSource,
} from "./LinksPanel";

type ConnectionMode = "uri" | "credentials";

interface PendingDatabaseLink {
  id: string;
  managedDatabaseId: string;
  targetResourceId: string;
  environment: ManagedDatabaseBindingEnvironment;
  replacesExistingEnvironment: boolean;
  replacesBindingId?: string;
}

interface PendingDatabaseLinkChanges {
  additions: PendingDatabaseLink[];
  removals: string[];
}

interface DisplayBinding {
  binding: ManagedDatabaseBinding;
  pending: "add" | "remove" | null;
}

export interface ManagedDatabaseLinksSectionHandle {
  applyChanges(options?: {
    replaceExistingEnvironment?: boolean;
    targetEnvironment?: Record<string, string>;
  }): Promise<void>;
}

export interface ManagedDatabaseLinkDraft {
  hasChanges: boolean;
  managedVariableNames: string[];
  pendingAdditionVariableNames: string[];
  replacementVariableNames: string[];
}

const EMPTY_CHANGES: PendingDatabaseLinkChanges = { additions: [], removals: [] };
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

const CREDENTIAL_VARIABLES: Record<
  DatabaseType,
  Array<{ field: keyof ManagedDatabaseBindingEnvironment; label: string; value: string }>
> = {
  postgres: [
    { field: "host", label: "Host variable", value: "POSTGRES_HOST" },
    { field: "port", label: "Port variable", value: "POSTGRES_PORT" },
    { field: "database", label: "Database variable", value: "POSTGRES_DB" },
    { field: "username", label: "Username variable", value: "POSTGRES_USER" },
    { field: "password", label: "Password variable", value: "POSTGRES_PASSWORD" },
  ],
  redis: [
    { field: "host", label: "Host variable", value: "REDIS_HOST" },
    { field: "port", label: "Port variable", value: "REDIS_PORT" },
    { field: "username", label: "Username variable", value: "REDIS_USERNAME" },
    { field: "password", label: "Password variable", value: "REDIS_PASSWORD" },
  ],
  clickhouse: [
    { field: "host", label: "Host variable", value: "CLICKHOUSE_HOST" },
    { field: "port", label: "Port variable", value: "CLICKHOUSE_PORT" },
    { field: "database", label: "Database variable", value: "CLICKHOUSE_DATABASE" },
    { field: "username", label: "Username variable", value: "CLICKHOUSE_USER" },
    { field: "password", label: "Password variable", value: "CLICKHOUSE_PASSWORD" },
  ],
};

function defaultEnvironment(database: ManagedDatabase | undefined, mode: ConnectionMode) {
  if (mode === "uri") {
    return { connectionUri: database?.type === "redis" ? "REDIS_URL" : "DATABASE_URL" };
  }
  if (!database) return {};
  return Object.fromEntries(
    CREDENTIAL_VARIABLES[database.type].map(({ field, value }) => [field, value])
  ) as ManagedDatabaseBindingEnvironment;
}

function hasCompleteEnvironment(
  database: ManagedDatabase | undefined,
  mode: ConnectionMode,
  environment: ManagedDatabaseBindingEnvironment
) {
  const values =
    mode === "uri"
      ? [environment.connectionUri]
      : database
        ? CREDENTIAL_VARIABLES[database.type].map(({ field }) => environment[field])
        : [];
  const trimmed = values.map((value) => value?.trim() ?? "");
  return (
    trimmed.length > 0 &&
    trimmed.every((value) => ENVIRONMENT_VARIABLE.test(value)) &&
    new Set(trimmed).size === trimmed.length
  );
}

function localDraftId() {
  return globalThis.crypto?.randomUUID?.() ?? `database-link-${Date.now()}-${Math.random()}`;
}

function composeServiceTarget(projectId: string, serviceName: string) {
  return `${projectId}:${encodeURIComponent(serviceName)}`;
}

function composeServiceName(projectId: string, targetResourceId: string) {
  const prefix = `${projectId}:`;
  if (!targetResourceId.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(targetResourceId.slice(prefix.length));
  } catch {
    return "";
  }
}

export const ManagedDatabaseLinksSection = forwardRef<
  ManagedDatabaseLinksSectionHandle,
  {
    nodeId: string;
    targetType: ManagedDatabaseBindingTargetType;
    targetResourceId: string;
    containerName: string;
    disabled?: boolean;
    /** Whether the user may create links here; in the shared Links panel the kind is offered only then. */
    canAdd?: boolean;
    /** Why unlinking a saved link is disabled (the app environment is isolated by the kill switch). */
    removeDisabledReason?: string | null;
    existingVariableNames?: string[];
    onInitialLoadingChange?: (loading: boolean) => void;
    onDraftChange?: (draft: ManagedDatabaseLinkDraft) => void;
    onSaveRequested?: () => void;
    onMutationStart?: (transition: "updating" | "recreating") => void;
    onMutationEnd?: () => void;
    onRecreating?: () => void | Promise<void>;
    recreatesRunningWorkload?: boolean;
    composeServices?: Array<{ name: string; existingVariableNames: string[] }>;
    /**
     * A Compose project before its first revision: links are saved pending. Without known services (from the
     * source's Compose file) the service is typed and checked when the first revision lands.
     */
    composeBeforeFirstRevision?: boolean;
  }
>(function ManagedDatabaseLinksSection(
  {
    nodeId,
    targetType,
    targetResourceId,
    containerName,
    disabled = false,
    canAdd = true,
    removeDisabledReason = null,
    existingVariableNames = [],
    onInitialLoadingChange,
    onDraftChange,
    onSaveRequested,
    onMutationStart,
    onMutationEnd,
    onRecreating,
    recreatesRunningWorkload = true,
    composeServices = [],
    composeBeforeFirstRevision = false,
  },
  ref
) {
  const navigate = useNavigate();
  const hasScope = useAuthStore((state) => state.hasScope);
  const [databases, setDatabases] = useState<ManagedDatabase[]>([]);
  const [databaseNodes, setDatabaseNodes] = useState<Node[]>([]);
  const [bindings, setBindings] = useState<ManagedDatabaseBinding[]>([]);
  const [changes, setChanges] = useState<PendingDatabaseLinkChanges>(EMPTY_CHANGES);
  const [selectedDatabaseId, setSelectedDatabaseId] = useState("");
  const [selectedComposeServiceName, setSelectedComposeServiceName] = useState(
    composeServices[0]?.name ?? ""
  );
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("uri");
  const [environment, setEnvironment] = useState<ManagedDatabaseBindingEnvironment>({
    connectionUri: "DATABASE_URL",
  });
  const [loading, setLoading] = useState(true);
  const initialLoading = useInitialLoading(loading);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [noAvailableDatabasesOpen, setNoAvailableDatabasesOpen] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!planIncludes("external-database-connections")) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [nextDatabases, nodeResult] = await Promise.all([
        api.listManagedDatabases(),
        listManagedDatabaseCandidateNodes(),
      ]);
      const results = await Promise.all(
        nextDatabases.map(async (database) =>
          api.listManagedDatabaseBindings(database.id).catch(() => [] as ManagedDatabaseBinding[])
        )
      );
      setDatabases(nextDatabases);
      setDatabaseNodes(nodeResult);
      setBindings(
        results
          .flat()
          .filter(
            (binding) =>
              binding.targetNodeId === nodeId &&
              binding.targetType === targetType &&
              (targetType === "compose_service"
                ? composeServiceName(targetResourceId, binding.targetResourceId) !== ""
                : binding.targetResourceId === targetResourceId)
          )
      );
    } catch (error) {
      toastApiError(error, "Failed to load database links");
    } finally {
      setLoading(false);
    }
  }, [nodeId, targetResourceId, targetType]);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleLoad = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    []
  );

  useRealtime(
    "database.changed",
    (rawPayload) => {
      const payload = rawPayload as
        | {
            resourceKind?: string;
            targetNodeId?: string;
            targetType?: ManagedDatabaseBindingTargetType;
            targetResourceId?: string;
          }
        | undefined;
      if (payload?.resourceKind !== "managed_database_binding") return;
      if (payload.targetNodeId !== nodeId || payload.targetType !== targetType) return;
      const matchesTarget =
        targetType === "compose_service"
          ? payload.targetResourceId?.startsWith(`${targetResourceId}:`)
          : payload.targetResourceId === targetResourceId;
      if (matchesTarget) scheduleLoad();
    },
    { onReconnect: scheduleLoad }
  );

  useEffect(() => {
    onInitialLoadingChange?.(initialLoading);
  }, [initialLoading, onInitialLoadingChange]);

  useRealtime("node.changed", () => {
    void listManagedDatabaseCandidateNodes()
      .then((nodes) => setDatabaseNodes(nodes))
      .catch(() => undefined);
  });

  const displayBindings = useMemo<DisplayBinding[]>(() => {
    const replacedBindingIds = new Set(
      changes.additions.flatMap((addition) =>
        addition.replacesBindingId ? [addition.replacesBindingId] : []
      )
    );
    const kept = bindings.filter((binding) => !replacedBindingIds.has(binding.id));
    // While a save runs, the server row of a new link arrives before the draft is cleared;
    // the saved row replaces its draft instead of showing twice.
    const savedTargets = new Set(
      kept
        .filter((binding) => !changes.removals.includes(binding.id))
        .map((binding) => `${binding.managedDatabaseId}:${binding.targetResourceId}`)
    );
    return [
      ...kept.map((binding) => ({
        binding,
        pending: changes.removals.includes(binding.id) ? ("remove" as const) : null,
      })),
      ...changes.additions
        .filter(
          (addition) =>
            !savedTargets.has(`${addition.managedDatabaseId}:${addition.targetResourceId}`)
        )
        .map((addition) => ({
          binding: {
            id: addition.id,
            managedDatabaseId: addition.managedDatabaseId,
            targetNodeId: nodeId,
            targetType,
            targetResourceId: addition.targetResourceId,
            environment: addition.environment,
            status: "creating" as const,
            lastError: null,
            createdAt: "",
            updatedAt: "",
          },
          pending: "add" as const,
        })),
    ];
  }, [bindings, changes, nodeId, targetType]);
  const linkedTargets = useMemo(
    () =>
      new Set(
        displayBindings
          .filter((entry) => entry.pending !== "remove")
          .map(({ binding }) => `${binding.managedDatabaseId}:${binding.targetResourceId}`)
      ),
    [displayBindings]
  );
  const databaseNodeById = useMemo(
    () => new Map(databaseNodes.map((node) => [node.id, node])),
    [databaseNodes]
  );
  const databaseIsAvailable = useCallback(
    (database: ManagedDatabase) => {
      const node = databaseNodeById.get(database.nodeId);
      return database.status === "ready" && !!node && node.status === "online" && node.isConnected;
    },
    [databaseNodeById]
  );
  // Linking and unlinking change the database's consumers: the API requires databases:bind on
  // the database (the target requirement, environment and secrets, is checked by the caller).
  const canBindDatabase = useCallback(
    (database: ManagedDatabase | undefined) =>
      !!database && hasScope(`databases:bind:${database.databaseConnectionId}`),
    [hasScope]
  );
  // No known services before the first revision: the service name is typed, not picked.
  const composeServiceTyped =
    targetType === "compose_service" && composeBeforeFirstRevision && composeServices.length === 0;
  const selectedTargetResourceId =
    targetType === "compose_service"
      ? selectedComposeServiceName.trim()
        ? composeServiceTarget(targetResourceId, selectedComposeServiceName.trim())
        : ""
      : targetResourceId;
  const available = useMemo(
    () =>
      databases.filter(
        (database) =>
          databaseIsAvailable(database) &&
          canBindDatabase(database) &&
          (selectedTargetResourceId
            ? !linkedTargets.has(`${database.id}:${selectedTargetResourceId}`)
            : composeServiceTyped)
      ),
    [
      canBindDatabase,
      composeServiceTyped,
      databaseIsAvailable,
      databases,
      linkedTargets,
      selectedTargetResourceId,
    ]
  );
  const selected = available.find((database) => database.id === selectedDatabaseId) ?? available[0];
  const hasChanges = changes.additions.length > 0 || changes.removals.length > 0;

  const managedVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          displayBindings
            .filter((entry) => entry.pending !== "remove")
            .flatMap((entry) => Object.values(entry.binding.environment).filter(Boolean))
        )
      ) as string[],
    [displayBindings]
  );
  const pendingAdditionVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          changes.additions.flatMap((addition) =>
            Object.values(addition.environment).filter(Boolean)
          )
        )
      ) as string[],
    [changes.additions]
  );
  const replacementVariableNames = useMemo(
    () =>
      Array.from(
        new Set(
          changes.additions
            .filter((addition) => addition.replacesExistingEnvironment)
            .flatMap((addition) => Object.values(addition.environment).filter(Boolean))
        )
      ) as string[],
    [changes.additions]
  );

  useEffect(() => {
    if (targetType !== "compose_service" || composeServiceTyped) return;
    if (!composeServices.some((service) => service.name === selectedComposeServiceName)) {
      setSelectedComposeServiceName(composeServices[0]?.name ?? "");
    }
  }, [composeServiceTyped, composeServices, selectedComposeServiceName, targetType]);

  useEffect(() => {
    onDraftChange?.({
      hasChanges,
      managedVariableNames,
      pendingAdditionVariableNames,
      replacementVariableNames,
    });
  }, [
    hasChanges,
    managedVariableNames,
    onDraftChange,
    pendingAdditionVariableNames,
    replacementVariableNames,
  ]);

  useEffect(() => {
    if (!selected) {
      setSelectedDatabaseId("");
      return;
    }
    if (!available.some((database) => database.id === selectedDatabaseId)) {
      setSelectedDatabaseId(selected.id);
      setEnvironment(defaultEnvironment(selected, connectionMode));
    }
  }, [available, connectionMode, selected, selectedDatabaseId]);

  const databaseName = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId)?.name ??
    binding.managedDatabaseId;
  const databaseType = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId)?.type ?? "database";
  const databaseForBinding = (binding: ManagedDatabaseBinding) =>
    databases.find((database) => database.id === binding.managedDatabaseId);
  const environmentSummary = (binding: ManagedDatabaseBinding) =>
    Object.values(binding.environment).filter(Boolean).join(", ") || "credentials injected";

  const stageLink = async () => {
    if (
      !selected ||
      !selectedTargetResourceId ||
      !hasCompleteEnvironment(selected, connectionMode, environment)
    )
      return;
    const names = Object.values(environment)
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const targetManagedVariableNames = displayBindings
      .filter(
        (entry) =>
          entry.pending !== "remove" && entry.binding.targetResourceId === selectedTargetResourceId
      )
      .flatMap((entry) => Object.values(entry.binding.environment).filter(Boolean));
    if (names.some((name) => targetManagedVariableNames.includes(name))) {
      toast.error("A managed database link already uses one of these environment variables");
      return;
    }
    const existing = new Set(
      targetType === "compose_service"
        ? (composeServices.find((service) => service.name === selectedComposeServiceName)
            ?.existingVariableNames ?? [])
        : existingVariableNames
    );
    const collisions = names.filter((name) => existing.has(name));
    if (collisions.length > 0) {
      if (targetType === "compose_service") {
        toast.error(
          `${selectedComposeServiceName} already uses ${collisions.join(", ")}. Choose different variable names.`
        );
        return;
      }
      const ok = await confirm({
        title: "Replace Existing Variables?",
        description: `${collisions.join(", ")} already ${collisions.length === 1 ? "exists" : "exist"} on “${containerName}”. The managed database credentials will replace ${collisions.length === 1 ? "it" : "them"} when you save and recreate.`,
        confirmLabel: "Add link",
      });
      if (!ok) return;
    }
    setChanges((current) => ({
      ...current,
      additions: [
        ...current.additions,
        {
          id: localDraftId(),
          managedDatabaseId: selected.id,
          targetResourceId: selectedTargetResourceId,
          replacesExistingEnvironment: collisions.length > 0,
          environment: Object.fromEntries(
            Object.entries(environment)
              .map(([field, value]) => [field, value?.trim()])
              .filter(([, value]) => Boolean(value))
          ) as ManagedDatabaseBindingEnvironment,
        },
      ],
    }));
    setAddOpen(false);
  };

  const stageServiceChange = (entry: DisplayBinding, serviceName: string) => {
    if (targetType !== "compose_service") return;
    const nextTargetResourceId = composeServiceTarget(targetResourceId, serviceName);
    if (entry.binding.targetResourceId === nextTargetResourceId) return;

    const pendingAddition = changes.additions.find((addition) => addition.id === entry.binding.id);
    const replacedBinding = pendingAddition?.replacesBindingId
      ? bindings.find((binding) => binding.id === pendingAddition.replacesBindingId)
      : undefined;
    if (replacedBinding?.targetResourceId === nextTargetResourceId) {
      setChanges((current) => ({
        removals: current.removals.filter((id) => id !== replacedBinding.id),
        additions: current.additions.filter((addition) => addition.id !== entry.binding.id),
      }));
      return;
    }

    const environmentNames = Object.values(entry.binding.environment).filter(
      (value): value is string => Boolean(value)
    );
    const targetEnvironmentNames = new Set(
      composeServices.find((service) => service.name === serviceName)?.existingVariableNames ?? []
    );
    const conflicts = environmentNames.filter((name) => targetEnvironmentNames.has(name));
    if (conflicts.length > 0) {
      toast.error(
        `${serviceName} already uses ${conflicts.join(", ")}. Change the variable names before moving this link.`
      );
      return;
    }

    const duplicate = displayBindings.some(
      (candidate) =>
        candidate.binding.id !== entry.binding.id &&
        candidate.pending !== "remove" &&
        candidate.binding.managedDatabaseId === entry.binding.managedDatabaseId &&
        candidate.binding.targetResourceId === nextTargetResourceId
    );
    if (duplicate) {
      toast.error("This database is already linked to that Compose service");
      return;
    }

    if (entry.pending === "add") {
      setChanges((current) => ({
        ...current,
        additions: current.additions.map((addition) =>
          addition.id === entry.binding.id
            ? { ...addition, targetResourceId: nextTargetResourceId }
            : addition
        ),
      }));
      return;
    }

    setChanges((current) => ({
      removals: current.removals.includes(entry.binding.id)
        ? current.removals
        : [...current.removals, entry.binding.id],
      additions: [
        ...current.additions,
        {
          id: localDraftId(),
          managedDatabaseId: entry.binding.managedDatabaseId,
          targetResourceId: nextTargetResourceId,
          environment: entry.binding.environment,
          replacesExistingEnvironment: false,
          replacesBindingId: entry.binding.id,
        },
      ],
    }));
  };

  const stageUnlink = async (entry: DisplayBinding) => {
    if (entry.pending === "add") {
      setChanges((current) => ({
        removals: current.removals.filter(
          (id) =>
            id !==
            current.additions.find((addition) => addition.id === entry.binding.id)
              ?.replacesBindingId
        ),
        additions: current.additions.filter((addition) => addition.id !== entry.binding.id),
      }));
      return;
    }
    if (entry.pending === "remove") {
      setChanges((current) => ({
        ...current,
        removals: current.removals.filter((id) => id !== entry.binding.id),
      }));
      return;
    }

    const name = databaseName(entry.binding);
    const ok = await confirm({
      title: "Unlink Managed Database",
      description: `Unlink “${name}” from “${containerName}” when you save and recreate this container?`,
      confirmLabel: "Unlink",
    });
    if (!ok) return;
    setChanges((current) => ({
      ...current,
      removals: [...current.removals, entry.binding.id],
    }));
  };

  const applyChanges = useCallback(
    async (options?: {
      replaceExistingEnvironment?: boolean;
      targetEnvironment?: Record<string, string>;
    }) => {
      if (!hasChanges) return;
      const remaining: PendingDatabaseLinkChanges = {
        additions: [...changes.additions],
        removals: [...changes.removals],
      };
      try {
        const createAddition = async (addition: PendingDatabaseLink) => {
          await api.createManagedDatabaseBinding(addition.managedDatabaseId, {
            targetNodeId: nodeId,
            targetType,
            targetResourceId: addition.targetResourceId,
            environment: addition.environment,
            ...(options?.replaceExistingEnvironment ? { replaceExistingEnvironment: true } : {}),
            ...(options?.targetEnvironment ? { targetEnvironment: options.targetEnvironment } : {}),
          });
          remaining.additions = remaining.additions.filter((item) => item.id !== addition.id);
        };

        // A Compose service move targets a different unique binding scope, so establish the
        // replacement first. If the later unlink fails, the database remains reachable and the
        // old link stays staged for removal instead of leaving the workload disconnected.
        for (const addition of changes.additions.filter((item) => item.replacesBindingId)) {
          await createAddition(addition);
        }
        for (const bindingId of changes.removals) {
          const binding = bindings.find((item) => item.id === bindingId);
          if (!binding) continue;
          if (options?.targetEnvironment) {
            await api.deleteManagedDatabaseBinding(binding.managedDatabaseId, binding.id, {
              targetEnvironment: options.targetEnvironment,
            });
          } else {
            await api.deleteManagedDatabaseBinding(binding.managedDatabaseId, binding.id);
          }
          remaining.removals = remaining.removals.filter((id) => id !== bindingId);
        }
        for (const addition of changes.additions.filter((item) => !item.replacesBindingId)) {
          await createAddition(addition);
        }
        setChanges(EMPTY_CHANGES);
        await load();
      } catch (error) {
        setChanges(remaining);
        await load();
        throw error;
      }
    },
    [bindings, changes, hasChanges, load, nodeId, targetType]
  );

  useImperativeHandle(ref, () => ({ applyChanges }), [applyChanges]);

  const save = async () => {
    if (!hasChanges) return;
    const ok = await confirm({
      title: recreatesRunningWorkload ? "Save & Recreate" : "Save",
      description: recreatesRunningWorkload
        ? targetType === "compose_service"
          ? `Apply managed database link changes to “${containerName}”? A new immutable Compose revision will be applied and the service will be recreated.`
          : `Apply managed database link changes to “${containerName}”? The container will be recreated and experience downtime.`
        : `Save managed database link changes for “${containerName}”? They will apply when the workload is started.`,
      confirmLabel: recreatesRunningWorkload ? "Recreate" : "Save",
      variant: "default",
    });
    if (!ok) return;

    setSaving(true);
    onMutationStart?.(recreatesRunningWorkload ? "recreating" : "updating");
    try {
      await applyChanges();
      toast.success(
        !recreatesRunningWorkload
          ? "Managed database links updated"
          : targetType === "compose_service"
            ? "Managed database links updated — applying Compose revision"
            : "Managed database links updated — recreating container"
      );
      void Promise.resolve(onRecreating?.());
    } catch (error) {
      onMutationEnd?.();
      toastApiError(error, "Failed to save managed database links");
    } finally {
      setSaving(false);
    }
  };

  const credentialFields = selected ? CREDENTIAL_VARIABLES[selected.type] : [];
  const openAddDialog = () => {
    if (composeServiceTyped) {
      if (
        !databases.some((database) => databaseIsAvailable(database) && canBindDatabase(database))
      ) {
        setNoAvailableDatabasesOpen(true);
        return;
      }
      setSelectedComposeServiceName("");
      setAddOpen(true);
      return;
    }
    if (targetType === "compose_service") {
      const firstAvailableService = composeServices.find((service) => {
        const serviceTarget = composeServiceTarget(targetResourceId, service.name);
        return databases.some(
          (database) =>
            databaseIsAvailable(database) &&
            canBindDatabase(database) &&
            !linkedTargets.has(`${database.id}:${serviceTarget}`)
        );
      });
      if (!firstAvailableService) {
        setNoAvailableDatabasesOpen(true);
        return;
      }
      setSelectedComposeServiceName(firstAvailableService.name);
      setAddOpen(true);
      return;
    }
    if (available.length === 0) {
      setNoAvailableDatabasesOpen(true);
      return;
    }
    setAddOpen(true);
  };

  useContentLoading(initialLoading);

  // In the shared Links panel this section adds its rows, its add action and its draft there.
  const inLinksPanel = useInLinksPanel();
  const saveDraft = () => (onSaveRequested ? onSaveRequested() : void save());
  useLinkSource("database", {
    rowCount: initialLoading ? 0 : displayBindings.length,
    loading: initialLoading,
    add: canAdd ? { disabled: disabled || loading || saving, open: openAddDialog } : undefined,
    save: {
      dirty: hasChanges,
      saving,
      disabled: disabled || loading,
      label: recreatesRunningWorkload ? "Save & Recreate" : "Save",
      onSave: saveDraft,
    },
  });

  const rows = initialLoading
    ? null
    : displayBindings.map((entry) => {
        const database = databaseForBinding(entry.binding);
        // A staged addition came from the editable list; existing links need databases:bind.
        const canChangeLink = entry.pending === "add" || canBindDatabase(database);
        const databaseNode = database ? databaseNodeById.get(database.nodeId) : undefined;
        const unavailable = !!database && !!databaseNode && !databaseIsAvailable(database);
        // Saved into the workload's configuration; its next start or rollout runs it.
        const awaitingWorkload =
          entry.pending === null &&
          entry.binding.status === "ready" &&
          entry.binding.observedState === "target_applied";
        const reconciling =
          entry.pending === null &&
          entry.binding.status === "ready" &&
          entry.binding.observedState !== undefined &&
          entry.binding.observedState !== "active" &&
          !awaitingWorkload;
        const statusLabel =
          entry.pending === "remove"
            ? "will unlink"
            : entry.pending === "add" || awaitingWorkload
              ? "pending"
              : reconciling
                ? "reconciling"
                : entry.binding.status;
        const statusVariant =
          entry.pending === "remove" || reconciling
            ? "warning"
            : entry.pending === "add" || awaitingWorkload
              ? "secondary"
              : entry.binding.status === "ready"
                ? entry.binding.lastError
                  ? "warning"
                  : "success"
                : entry.binding.status === "error"
                  ? "destructive"
                  : "secondary";
        const statusDetail =
          entry.binding.lastError ??
          (awaitingWorkload
            ? "Saved in the workload's configuration. It takes effect when the workload next starts or finishes its current rollout."
            : reconciling
              ? "Database link migration or runtime reconciliation has not completed yet."
              : entry.binding.status === "ready"
                ? "Database link is ready."
                : entry.binding.status === "creating"
                  ? "Database link is being created."
                  : entry.binding.status === "deleting"
                    ? "Database link is being removed."
                    : "Database link reconciliation failed.");
        return (
          <SettingsControlRow
            key={entry.binding.id}
            title={<LinkRowTitle kind="database">{databaseName(entry.binding)}</LinkRowTitle>}
            description={`${databaseType(entry.binding)} · ${environmentSummary(entry.binding)}`}
          >
            <div className="flex items-center gap-2">
              {targetType === "compose_service" && (
                <Select
                  value={composeServiceName(targetResourceId, entry.binding.targetResourceId)}
                  onValueChange={(serviceName) => stageServiceChange(entry, serviceName)}
                  // A typed service cannot be moved: unlink it and add it again.
                  disabled={
                    disabled ||
                    saving ||
                    entry.pending === "remove" ||
                    !canChangeLink ||
                    composeServiceTyped
                  }
                >
                  <SelectTrigger
                    className="w-44"
                    aria-label={`Compose service for ${databaseName(entry.binding)}`}
                  >
                    <SelectValue placeholder="Select service" />
                  </SelectTrigger>
                  <SelectContent>
                    {(composeServiceTyped
                      ? [
                          {
                            name: composeServiceName(
                              targetResourceId,
                              entry.binding.targetResourceId
                            ),
                          },
                        ]
                      : composeServices
                    ).map((service) => (
                      <SelectItem key={service.name} value={service.name}>
                        {service.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <LinkNodeBadge
                name={databaseNode ? databaseNode.displayName || databaseNode.hostname : null}
                color={databaseNode?.appearanceColor}
              />
              {unavailable && (
                <Badge variant="secondary" size="inline">
                  Unavailable
                </Badge>
              )}
              <LinkStatusBadge label={statusLabel} variant={statusVariant} detail={statusDetail} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={LINK_REMOVE_BUTTON_CLASS}
                disabled={
                  disabled ||
                  saving ||
                  !canChangeLink ||
                  (entry.pending === null && removeDisabledReason !== null)
                }
                onClick={() => void stageUnlink(entry)}
                aria-label={
                  entry.pending === "remove"
                    ? `Keep ${databaseName(entry.binding)} linked`
                    : `Unlink ${databaseName(entry.binding)}`
                }
                title={
                  entry.pending === "remove"
                    ? "Keep link"
                    : entry.pending === null && removeDisabledReason
                      ? removeDisabledReason
                      : "Unlink database"
                }
              >
                {entry.pending === "remove" ? (
                  <Undo2 className="h-4 w-4" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </div>
          </SettingsControlRow>
        );
      });

  return (
    <>
      {inLinksPanel ? (
        rows
      ) : (
        <PanelShell
          title="Managed Database Links"
          icon={<Link2 className="h-4 w-4" />}
          description={
            targetType === "compose_service"
              ? composeBeforeFirstRevision
                ? "Private connections. Saved now and added to the selected services by the project's first revision."
                : "Private connections stored in each selected service's Compose revision."
              : recreatesRunningWorkload
                ? "Private connections. Changes apply with Save & Recreate."
                : "Private connections. Changes apply on next start."
          }
          dirty={hasChanges}
          bodyClassName={displayBindings.length > 0 ? "divide-y divide-border" : undefined}
          actions={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="warning"
                pending={saving}
                disabled={disabled || loading || !hasChanges}
                onClick={saveDraft}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {recreatesRunningWorkload ? "Save & Recreate" : "Save"}
              </Button>
              <Button
                type="button"
                disabled={disabled || loading || saving}
                onClick={openAddDialog}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          }
        >
          {initialLoading ? null : displayBindings.length === 0 ? (
            <EmptyState message="No managed database links" embedded />
          ) : (
            rows
          )}
        </PanelShell>
      )}

      <Dialog open={noAvailableDatabasesOpen} onOpenChange={setNoAvailableDatabasesOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>No Managed Databases Available</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            There are no unlinked ready managed databases on an online databases node for this
            workload. Create a database, then return here to add a private connection.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setNoAvailableDatabasesOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setNoAvailableDatabasesOpen(false);
                navigate("/databases", { state: { createManagedDatabase: true } });
              }}
            >
              <Plus className="h-4 w-4" />
              Create database
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Managed Database Link</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Opfield will inject the selected connection into this workload when you save and
            recreate it.
          </DialogDescription>

          <AnimatedHeight>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={connectionMode} {...FORM_ANIMATION}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {targetType === "compose_service" && (
                    <div className="space-y-1.5 sm:col-span-2">
                      <label className="text-sm font-medium" htmlFor="managed-db-link-service">
                        Compose service
                      </label>
                      {composeServiceTyped ? (
                        <>
                          <Input
                            id="managed-db-link-service"
                            value={selectedComposeServiceName}
                            onChange={(event) => setSelectedComposeServiceName(event.target.value)}
                            placeholder="api"
                            disabled={disabled || saving}
                          />
                          <p className="text-xs text-muted-foreground">
                            Checked when the first revision lands. A link to a service it does not
                            define is marked failed.
                          </p>
                        </>
                      ) : (
                        <Select
                          value={selectedComposeServiceName}
                          onValueChange={setSelectedComposeServiceName}
                          disabled={disabled || saving}
                        >
                          <SelectTrigger id="managed-db-link-service">
                            <SelectValue placeholder="Select service" />
                          </SelectTrigger>
                          <SelectContent>
                            {composeServices.map((service) => (
                              <SelectItem key={service.name} value={service.name}>
                                {service.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="managed-db-link-database">
                      Database
                    </label>
                    <Select
                      value={selected?.id ?? ""}
                      onValueChange={(databaseId) => {
                        const database = available.find((item) => item.id === databaseId);
                        setSelectedDatabaseId(databaseId);
                        setEnvironment(defaultEnvironment(database, connectionMode));
                      }}
                      disabled={disabled || saving}
                    >
                      <SelectTrigger id="managed-db-link-database">
                        <SelectValue aria-label={selected?.name}>{selected?.name}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {available.map((database) => (
                          <SelectItem
                            key={database.id}
                            value={database.id}
                            description={
                              <span className="flex items-center gap-2">
                                <span>{databaseTypeLabel(database.type)}</span>
                                {databaseNodeById.get(database.nodeId) && (
                                  <Badge
                                    variant="secondary"
                                    size="inline"
                                    className={nodeBadgeClassName(
                                      databaseNodeById.get(database.nodeId)?.appearanceColor
                                    )}
                                  >
                                    {databaseNodeById.get(database.nodeId)?.displayName ||
                                      databaseNodeById.get(database.nodeId)?.hostname}
                                  </Badge>
                                )}
                              </span>
                            }
                          >
                            {database.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium" htmlFor="managed-db-link-mode">
                      Inject as
                    </label>
                    <Select
                      value={connectionMode}
                      onValueChange={(value) => {
                        const mode = value as ConnectionMode;
                        setConnectionMode(mode);
                        setEnvironment(defaultEnvironment(selected, mode));
                      }}
                      disabled={disabled || saving}
                    >
                      <SelectTrigger id="managed-db-link-mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="uri">Connection URI</SelectItem>
                        <SelectItem value="credentials">Credential variables</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {connectionMode === "uri" ? (
                    <div className="space-y-1.5 sm:col-span-2">
                      <label className="text-sm font-medium" htmlFor="managed-db-link-uri">
                        Connection URI variable
                      </label>
                      <Input
                        id="managed-db-link-uri"
                        value={environment.connectionUri ?? ""}
                        onChange={(event) =>
                          setEnvironment((current) => ({
                            ...current,
                            connectionUri: event.target.value,
                          }))
                        }
                        placeholder="DATABASE_URL"
                        disabled={disabled || saving}
                      />
                    </div>
                  ) : (
                    credentialFields.map(({ field, label, value }) => (
                      <div key={field} className="space-y-1.5">
                        <label
                          className="text-sm font-medium"
                          htmlFor={`managed-db-link-variable-${field}`}
                        >
                          {label}
                        </label>
                        <Input
                          id={`managed-db-link-variable-${field}`}
                          value={environment[field] ?? ""}
                          onChange={(event) =>
                            setEnvironment((current) => ({
                              ...current,
                              [field]: event.target.value,
                            }))
                          }
                          placeholder={value}
                          disabled={disabled || saving}
                        />
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
          </AnimatedHeight>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                disabled ||
                saving ||
                !hasCompleteEnvironment(selected, connectionMode, environment) ||
                !selectedTargetResourceId
              }
              onClick={() => void stageLink()}
            >
              <Link2 className="h-4 w-4" />
              Add link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
