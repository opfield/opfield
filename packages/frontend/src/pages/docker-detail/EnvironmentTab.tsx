import { FileCode2, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRealtime } from "@/hooks/use-realtime";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { DockerSecret, ManagedDatabaseBindingTargetType } from "@/types";
import { ContainerLinksSection } from "./ContainerLinksSection";
import { EnvTextDialog, parseEnvText } from "./EnvTextDialog";
import { LinksPanel } from "./LinksPanel";
import {
  type ManagedDatabaseLinkDraft,
  ManagedDatabaseLinksSection,
  type ManagedDatabaseLinksSectionHandle,
} from "./ManagedDatabaseLinksSection";
import {
  type ManagedStorageLinkDraft,
  ManagedStorageLinksSection,
  type ManagedStorageLinksSectionHandle,
} from "./ManagedStorageLinksSection";
import { readReplacedContainer } from "./replaced-container";
import { type SecretRow, SecretsSection } from "./SecretsSection";

const EMPTY_DATABASE_LINK_DRAFT: ManagedDatabaseLinkDraft = {
  hasChanges: false,
  managedVariableNames: [],
  pendingAdditionVariableNames: [],
  replacementVariableNames: [],
};

const EMPTY_STORAGE_LINK_DRAFT: ManagedStorageLinkDraft = {
  hasChanges: false,
  managedVariableNames: [],
  pendingAdditionVariableNames: [],
};

export function EnvironmentTab({
  nodeId,
  containerId,
  containerName,
  scopeResourceId,
  containerState,
  disabled,
  managedLinksDisabled,
  linkRemovalDisabledReason = null,
  onMutationStart,
  onMutationEnd,
  onRecreating,
  serviceEnv,
  onSaveServiceEnv,
  canEditOverride,
  canManageSecretsOverride,
  secretApi,
  environmentDescription,
  secretsDescription,
  serviceSaveLabel,
  serviceSaveDescription,
  databaseTargetType = "container",
  databaseTargetResourceId,
  flushBottom = false,
}: {
  nodeId: string;
  containerId: string;
  containerName?: string;
  scopeResourceId?: string;
  containerState?: string;
  disabled?: boolean;
  /** Managed links may stay editable while the rest is locked (a build rollout picks them up). */
  managedLinksDisabled?: boolean;
  /** Why removing links and bindings is disabled (the app environment is isolated by the kill switch). */
  linkRemovalDisabledReason?: string | null;
  onMutationStart?: (transition: "updating" | "recreating") => void;
  onMutationEnd?: () => void;
  onRecreating?: () => void | Promise<void>;
  serviceEnv?: Record<string, string>;
  onSaveServiceEnv?: (env: Record<string, string>) => Promise<void>;
  canEditOverride?: boolean;
  canManageSecretsOverride?: boolean;
  secretApi?: {
    list: () => Promise<DockerSecret[]>;
    create: (key: string, value: string) => Promise<DockerSecret>;
    update: (id: string, value: string) => Promise<DockerSecret>;
    delete: (id: string) => Promise<void>;
  };
  environmentDescription?: string;
  secretsDescription?: string;
  serviceSaveLabel?: string;
  serviceSaveDescription?: string;
  databaseTargetType?: ManagedDatabaseBindingTargetType;
  databaseTargetResourceId?: string;
  flushBottom?: boolean;
}) {
  const { hasScope, hasScopedAccess } = useAuthStore();
  const invalidate = useDockerStore((s) => s.invalidate);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [originalEnv, setOriginalEnv] = useState<string[]>([]);
  // "Edit as text" works on a copy in a dialog; the table stays the draft.
  const [textEditorOpen, setTextEditorOpen] = useState(false);
  const [rawText, setRawText] = useState("");

  // Secrets state — edited locally, flushed to DB on recreate
  const [secretRows, setSecretRows] = useState<SecretRow[]>([]);
  const [deletedSecrets, setDeletedSecrets] = useState<Map<string, string>>(new Map());
  const [hasDatabaseNode, setHasDatabaseNode] = useState(false);
  const [databaseNodeLoading, setDatabaseNodeLoading] = useState(true);
  const [databaseLinksLoading, setDatabaseLinksLoading] = useState(true);
  const databaseLinksRef = useRef<ManagedDatabaseLinksSectionHandle>(null);
  const [databaseLinkDraft, setDatabaseLinkDraft] =
    useState<ManagedDatabaseLinkDraft>(EMPTY_DATABASE_LINK_DRAFT);
  const [storageLinksLoading, setStorageLinksLoading] = useState(true);
  const storageLinksRef = useRef<ManagedStorageLinksSectionHandle>(null);
  const [storageLinkDraft, setStorageLinkDraft] =
    useState<ManagedStorageLinkDraft>(EMPTY_STORAGE_LINK_DRAFT);
  const envContainerIdRef = useRef(containerId);
  const envRequestGenerationRef = useRef(0);
  const envMutationInProgressRef = useRef(false);

  const scopeSuffix = `${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`;
  // Environment edits the variables and lists the secret keys; secrets reveals and edits the values.
  const canEdit = canEditOverride ?? hasScope(`docker:containers:environment:${scopeSuffix}`);
  const canManageSecrets =
    canManageSecretsOverride ?? hasScope(`docker:containers:secrets:${scopeSuffix}`);
  // Any link change on a deployment rolls it out (manage), and saving links here also sends the
  // environment draft, which rewrites its config (edit). The binding API gates both, in addition
  // to environment and secrets.
  const canChangeManagedLinks =
    databaseTargetType !== "deployment" ||
    (hasScope(`docker:containers:edit:${scopeSuffix}`) &&
      hasScope(`docker:containers:manage:${scopeSuffix}`));
  // A crash-looping (restarting) workload is recreated running, like a running one.
  const recreatesRunningContainer = containerState === "running" || containerState === "restarting";
  const linksDisabled = managedLinksDisabled ?? disabled;
  const resolvedServiceSaveLabel =
    serviceSaveLabel ?? (recreatesRunningContainer ? "Save & Recreate" : "Save");
  const isServiceEnv = !!onSaveServiceEnv;
  const managedDatabaseLinksEnabled = !isServiceEnv || Boolean(databaseTargetResourceId);
  const resolvedDatabaseTargetResourceId = databaseTargetResourceId ?? containerName ?? "";
  const storageTargetType =
    databaseTargetType === "container" || databaseTargetType === "deployment"
      ? databaseTargetType
      : null;
  const resolvedStorageTargetResourceId =
    storageTargetType === "deployment" ? (databaseTargetResourceId ?? "") : (containerName ?? "");
  const canViewManagedStorage = hasScopedAccess("storage:view");
  const canManageManagedStorage = hasScopedAccess("storage:bind");
  const canManageStorageCluster = useCallback(
    (connectionId: string | null) =>
      hasScope("storage:bind") || Boolean(connectionId && hasScope(`storage:bind:${connectionId}`)),
    [hasScope]
  );
  const managedStorageLinksEnabled =
    managedDatabaseLinksEnabled &&
    canViewManagedStorage &&
    Boolean(storageTargetType) &&
    Boolean(resolvedStorageTargetResourceId);
  // Container links work on containers and deployments; a Compose service links from the project's Variables tab.
  const containerLinksEnabled =
    managedDatabaseLinksEnabled &&
    Boolean(storageTargetType) &&
    Boolean(resolvedStorageTargetResourceId) &&
    Boolean(containerName) &&
    hasScope(`docker:containers:view:${scopeSuffix}`);
  const canManageContainerLinks = hasScope(`docker:containers:edit:${scopeSuffix}`);
  const serviceEnvSignature = useMemo(() => JSON.stringify(serviceEnv ?? {}), [serviceEnv]);
  const managedDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.managedVariableNames),
    [databaseLinkDraft.managedVariableNames]
  );
  const pendingDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.pendingAdditionVariableNames),
    [databaseLinkDraft.pendingAdditionVariableNames]
  );
  const managedStorageVariableNames = useMemo(
    () => new Set(storageLinkDraft.managedVariableNames),
    [storageLinkDraft.managedVariableNames]
  );
  const pendingStorageVariableNames = useMemo(
    () => new Set(storageLinkDraft.pendingAdditionVariableNames),
    [storageLinkDraft.pendingAdditionVariableNames]
  );
  const managedLinkVariableNames = useMemo(
    () => new Set([...managedDatabaseVariableNames, ...managedStorageVariableNames]),
    [managedDatabaseVariableNames, managedStorageVariableNames]
  );
  const replacementDatabaseVariableNames = useMemo(
    () => new Set(databaseLinkDraft.replacementVariableNames),
    [databaseLinkDraft.replacementVariableNames]
  );
  const activeManagedLinkVariableNames = useMemo(
    () =>
      new Set(
        [...managedLinkVariableNames].filter(
          (name) =>
            !pendingDatabaseVariableNames.has(name) && !pendingStorageVariableNames.has(name)
        )
      ),
    [managedLinkVariableNames, pendingDatabaseVariableNames, pendingStorageVariableNames]
  );

  // Runtime inspection includes values injected by Managed Database Links.
  // Those values are projections owned by the link editor, not user-authored
  // environment variables. Remove them from the editable draft as soon as the
  // binding metadata arrives so credentials are not exposed or accidentally
  // deleted by an unrelated environment save.
  useEffect(() => {
    if (activeManagedLinkVariableNames.size === 0) return;
    const isManagedEntry = (entry: string) => {
      const separator = entry.indexOf("=");
      const key = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
      return activeManagedLinkVariableNames.has(key);
    };

    setEnvVars((current) => {
      const next = current.filter((entry) => !activeManagedLinkVariableNames.has(entry.key.trim()));
      return next.length === current.length ? current : next;
    });
    setOriginalEnv((current) => {
      const next = current.filter((entry) => !isManagedEntry(entry));
      return next.length === current.length ? current : next;
    });
  }, [activeManagedLinkVariableNames]);

  const fetchEnv = useCallback(async () => {
    if (envMutationInProgressRef.current || disabled) return;
    const targetContainerId = envContainerIdRef.current;
    const requestGeneration = ++envRequestGenerationRef.current;
    const isCurrentRequest = () =>
      requestGeneration === envRequestGenerationRef.current &&
      targetContainerId === envContainerIdRef.current;
    setIsLoading((current) => (isServiceEnv ? current : true));
    try {
      if (isServiceEnv) {
        const secretsData =
          canManageSecrets || canEdit
            ? secretApi
              ? await secretApi.list()
              : await api.listDockerDeploymentSecrets(nodeId, targetContainerId)
            : [];
        const serviceEnvRecord = JSON.parse(serviceEnvSignature) as Record<string, string>;
        const entries = Object.entries(serviceEnvRecord).map(([key, value]) => `${key}=${value}`);
        const parsed = entries.map((entry) => {
          const idx = entry.indexOf("=");
          return { key: entry.slice(0, idx), value: entry.slice(idx + 1) };
        });
        if (!isCurrentRequest()) return;
        setEnvVars(parsed);
        setOriginalEnv(entries);
        setSecretRows(
          (secretsData ?? [])
            .filter((s: DockerSecret) => !s.system)
            .map((s: DockerSecret) => ({
              id: s.id,
              key: s.key,
              value: s.value,
              dirty: false,
            }))
        );
        setDeletedSecrets(new Map());
        return;
      }

      // Right after a recreate the tab can still hold the replaced container's ID: the replacement is read quietly
      // by the container's name until the page switches to its ID.
      const {
        value: [data, secretsData],
      } = await readReplacedContainer(
        targetContainerId,
        containerName,
        (readContainerId) =>
          Promise.all([
            canEdit ? api.getContainerEnv(nodeId, readContainerId) : Promise.resolve([]),
            canManageSecrets || canEdit
              ? api.listDockerSecrets(nodeId, readContainerId)
              : Promise.resolve([]),
          ]),
        async (name) => {
          const replacement = await api.inspectContainerByName(nodeId, name, true);
          return String(replacement.Id ?? replacement.id ?? "") || undefined;
        }
      );
      if (!isCurrentRequest()) return;

      if (canEdit) {
        const parsed = (data ?? []).map((entry: string) => {
          const idx = entry.indexOf("=");
          return idx >= 0
            ? { key: entry.slice(0, idx), value: entry.slice(idx + 1) }
            : { key: entry, value: "" };
        });
        setEnvVars(parsed);
        setOriginalEnv(data ?? []);
      } else {
        setEnvVars([]);
        setOriginalEnv([]);
      }

      if (canManageSecrets || canEdit) {
        const rows: SecretRow[] = (secretsData ?? [])
          .filter((s: DockerSecret) => !s.system)
          .map((s: DockerSecret) => ({
            id: s.id,
            key: s.key,
            value: s.value,
            dirty: false,
          }));
        setSecretRows(rows);
        setDeletedSecrets(new Map());
      } else {
        setSecretRows([]);
        setDeletedSecrets(new Map());
      }
    } catch (err) {
      if (isCurrentRequest()) {
        toast.error(err instanceof Error ? err.message : "Failed to fetch environment");
      }
    } finally {
      if (isCurrentRequest()) setIsLoading(false);
    }
  }, [
    canEdit,
    canManageSecrets,
    containerName,
    nodeId,
    isServiceEnv,
    serviceEnvSignature,
    secretApi,
    disabled,
  ]);

  useEffect(() => {
    envContainerIdRef.current = containerId;
    fetchEnv();
    return () => {
      envRequestGenerationRef.current++;
    };
  }, [containerId, fetchEnv]);

  useEffect(
    () => () => {
      envRequestGenerationRef.current++;
    },
    []
  );

  useRealtime(
    isServiceEnv ? null : "docker.container.changed",
    (payload) => {
      const event = payload as {
        nodeId?: string;
        id?: string;
        oldId?: string;
        name?: string;
        action?: string;
        toolName?: string;
        operation?: string;
      };
      if (event.nodeId !== nodeId) return;
      const matchesContainer = containerName
        ? !event.name || event.name === containerName
        : event.id === containerId || event.oldId === containerId;
      if (!matchesContainer) return;

      if (event.action === "recreated" && event.id) {
        if (event.id !== containerId) return;
        envContainerIdRef.current = event.id;
        void fetchEnv();
        return;
      }
      if (event.action?.startsWith("secret")) {
        void fetchEnv();
        return;
      }
      if (
        event.action === "tool-invalidated" &&
        event.toolName === "manage_docker_container_config" &&
        event.operation !== "update_env"
      ) {
        envContainerIdRef.current = event.id || containerId;
        void fetchEnv();
      }
    },
    { onReconnect: fetchEnv }
  );

  useEffect(() => {
    if (
      !managedDatabaseLinksEnabled ||
      !canEdit ||
      !canManageSecrets ||
      !containerName ||
      !resolvedDatabaseTargetResourceId
    ) {
      setHasDatabaseNode(false);
      setDatabaseNodeLoading(false);
      setDatabaseLinksLoading(false);
      return;
    }

    let cancelled = false;
    setDatabaseNodeLoading(true);
    setDatabaseLinksLoading(true);
    void listManagedDatabaseCandidateNodes(1)
      .then((result) => {
        if (!cancelled) {
          const available = result.length > 0;
          setHasDatabaseNode(available);
          if (!available) setDatabaseLinksLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasDatabaseNode(false);
          setDatabaseLinksLoading(false);
        }
      })
      .finally(() => {
        if (!cancelled) setDatabaseNodeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    canEdit,
    canManageSecrets,
    containerName,
    managedDatabaseLinksEnabled,
    resolvedDatabaseTargetResourceId,
  ]);

  useEffect(() => {
    if (activeManagedLinkVariableNames.size === 0) return;
    setSecretRows((current) =>
      current.filter((row) => !activeManagedLinkVariableNames.has(row.key.trim()))
    );
  }, [activeManagedLinkVariableNames]);

  const existingVariableNames = useMemo(() => {
    const environmentKeys = envVars.map((entry) => entry.key.trim()).filter(Boolean);
    return [...environmentKeys, ...secretRows.map((row) => row.key.trim()).filter(Boolean)];
  }, [envVars, secretRows]);

  const handleDatabaseLinkDraftChange = useCallback((draft: ManagedDatabaseLinkDraft) => {
    setDatabaseLinkDraft(draft);
  }, []);
  const handleStorageLinkDraftChange = useCallback((draft: ManagedStorageLinkDraft) => {
    setStorageLinkDraft(draft);
  }, []);

  // ── Env handlers ─────────────────────────────────────────────────

  const validateRaw = useCallback(
    (text: string): number[] => {
      const errors = new Set<number>();
      const lines = text.split("\n");
      const keyLines = new Map<string, number[]>();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith("#")) continue;
        const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
        const eqIdx = stripped.indexOf("=");
        if (eqIdx < 1) {
          errors.add(i + 1);
          continue;
        }
        const key = stripped.slice(0, eqIdx);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          errors.add(i + 1);
        } else {
          if (managedLinkVariableNames.has(key) && !replacementDatabaseVariableNames.has(key)) {
            errors.add(i + 1);
          }
          const existing = keyLines.get(key) ?? [];
          existing.push(i + 1);
          keyLines.set(key, existing);
        }
      }
      for (const lineNums of keyLines.values()) {
        if (lineNums.length > 1) for (const ln of lineNums) errors.add(ln);
      }
      return Array.from(errors).sort((a, b) => a - b);
    },
    [managedLinkVariableNames, replacementDatabaseVariableNames]
  );

  const openTextEditor = () => {
    setRawText(visibleEnvRows.map(({ entry }) => `${entry.key}=${entry.value}`).join("\n"));
    setTextEditorOpen(true);
  };

  // Apply replaces the editable rows; rows hidden while a database link takes them over stay.
  const applyText = () => {
    const parsed = parseEnvText(rawText);
    setEnvVars((current) => [
      ...current.filter((entry) => replacementDatabaseVariableNames.has(entry.key.trim())),
      ...parsed,
    ]);
    setTextEditorOpen(false);
  };

  const updateVar = (idx: number, field: "key" | "value", val: string) => {
    setEnvVars((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: val };
      return updated;
    });
  };

  const addVar = () => setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  const removeVar = (idx: number) => setEnvVars((prev) => prev.filter((_, i) => i !== idx));

  // ── Save handler ─────────────────────────────────────────────────

  const handleSave = async () => {
    // With only the links editable, a save carries link changes and no environment edits.
    if (isSaving || (disabled && (linksDisabled || hasChanges))) return;
    const vars = visibleEnvRows.map(({ entry }) => entry);

    const savingDatabaseLinks = databaseLinkDraft.hasChanges;
    const savingStorageLinks = storageLinkDraft.hasChanges;
    const savingManagedLinks = savingDatabaseLinks || savingStorageLinks;
    const ok = await confirm({
      title: onSaveServiceEnv
        ? resolvedServiceSaveLabel
        : savingManagedLinks || recreatesRunningContainer
          ? "Save & Recreate"
          : canEdit
            ? "Save"
            : "Save Secrets",
      description: onSaveServiceEnv
        ? (serviceSaveDescription ??
          (recreatesRunningContainer
            ? "Environment changes will recreate the running workload and may cause brief downtime. Continue?"
            : "Environment changes will be saved and apply when the workload is started."))
        : savingManagedLinks
          ? "Managed links and environment changes will be applied together. The container will be recreated and experience brief downtime. Continue?"
          : canEdit
            ? recreatesRunningContainer
              ? "Updating environment variables will recreate the container. The container will experience brief downtime. Continue?"
              : "Updating environment variables will save the new container configuration. The container will remain stopped. Continue?"
            : "Secret changes will be stored, but without environment permission they will only apply after the container is recreated. Continue?",
      confirmLabel: onSaveServiceEnv
        ? resolvedServiceSaveLabel === "Save & Recreate"
          ? "Recreate"
          : resolvedServiceSaveLabel === "Save & Deploy"
            ? "Deploy"
            : "Save"
        : savingManagedLinks || recreatesRunningContainer
          ? "Recreate"
          : "Save",
    });
    if (!ok) return;

    setIsSaving(true);
    envMutationInProgressRef.current = true;
    envRequestGenerationRef.current++;
    onMutationStart?.(savingManagedLinks || recreatesRunningContainer ? "recreating" : "updating");
    try {
      // 1. Flush secret changes to DB
      if (hasSecretsChanges) {
        // Delete removed secrets
        for (const id of deletedSecrets.keys()) {
          if (secretApi) {
            await secretApi.delete(id);
          } else if (onSaveServiceEnv) {
            await api.deleteDockerDeploymentSecret(nodeId, containerId, id);
          } else {
            await api.deleteDockerSecret(nodeId, containerId, id);
          }
        }
        // Create/update secrets
        for (const row of secretRows) {
          if (
            !row.key.trim() ||
            !row.dirty ||
            replacementDatabaseVariableNames.has(row.key.trim())
          ) {
            continue;
          }
          if (row.id) {
            // Existing secret with new value
            if (secretApi) {
              await secretApi.update(row.id, row.value);
            } else if (onSaveServiceEnv) {
              await api.updateDockerDeploymentSecret(nodeId, containerId, row.id, row.value);
            } else {
              await api.updateDockerSecret(nodeId, containerId, row.id, row.value);
            }
          } else {
            // New secret
            if (secretApi) {
              await secretApi.create(row.key.trim(), row.value);
            } else if (onSaveServiceEnv) {
              await api.createDockerDeploymentSecret(
                nodeId,
                containerId,
                row.key.trim(),
                row.value
              );
            } else {
              await api.createDockerSecret(nodeId, containerId, row.key.trim(), row.value);
            }
          }
        }
        const refreshedSecrets = secretApi
          ? await secretApi.list()
          : onSaveServiceEnv
            ? await api.listDockerDeploymentSecrets(nodeId, containerId)
            : canManageSecrets || canEdit
              ? await api.listDockerSecrets(nodeId, containerId)
              : [];
        setSecretRows(
          refreshedSecrets
            .filter((s: DockerSecret) => !s.system)
            .map((s: DockerSecret) => ({
              id: s.id,
              key: s.key,
              value: s.value,
              dirty: false,
            }))
        );
        setDeletedSecrets(new Map());
      }

      const newEnv: Record<string, string> = {};
      for (const entry of vars) {
        const key = entry.key.trim();
        if (key && !managedLinkVariableNames.has(key)) newEnv[key] = entry.value;
      }

      if (onSaveServiceEnv && savingManagedLinks) {
        const replaceExistingEnvironment = databaseLinkDraft.replacementVariableNames.length > 0;
        if (savingDatabaseLinks) {
          await databaseLinksRef.current?.applyChanges({
            replaceExistingEnvironment,
            targetEnvironment: newEnv,
          });
        }
        if (savingStorageLinks) {
          await storageLinksRef.current?.applyChanges({ targetEnvironment: newEnv });
        }
        const entries = Object.entries(newEnv).map(([key, value]) => `${key}=${value}`);
        setOriginalEnv(entries);
        toast.success("Environment and managed links updated");
        invalidate("containers", "tasks");
        void Promise.resolve(onRecreating?.()).catch(() => undefined);
        return;
      }

      if (onSaveServiceEnv) {
        await onSaveServiceEnv(newEnv);
        const entries = Object.entries(newEnv).map(([key, value]) => `${key}=${value}`);
        setOriginalEnv(entries);
        toast.success("Environment updated");
        onMutationEnd?.();
        return;
      }

      if (savingDatabaseLinks) {
        const replaceExistingEnvironment = databaseLinkDraft.replacementVariableNames.length > 0;
        await databaseLinksRef.current?.applyChanges({
          replaceExistingEnvironment,
          targetEnvironment: newEnv,
        });
      }
      if (savingStorageLinks) {
        await storageLinksRef.current?.applyChanges({ targetEnvironment: newEnv });
      } else if (!savingDatabaseLinks && canEdit && (hasEnvChanges || hasSecretsChanges)) {
        const newKeys = new Set(Object.keys(newEnv));
        const removeEnv = [
          ...originalEnv.map((entry) => entry.split("=")[0]).filter((key) => !newKeys.has(key)),
          ...deletedSecrets.values(),
        ].filter((key, index, keys) => key && keys.indexOf(key) === index);
        await api.updateContainerEnv(
          nodeId,
          containerId,
          newEnv,
          removeEnv.length > 0 ? removeEnv : undefined
        );
      }

      if (canEdit || savingManagedLinks) {
        const entries = Object.entries(newEnv).map(([key, value]) => `${key}=${value}`);
        setEnvVars(Object.entries(newEnv).map(([key, value]) => ({ key, value })));
        setOriginalEnv(entries);
        setIsLoading(false);
        toast.success(
          savingManagedLinks || recreatesRunningContainer
            ? "Environment and managed links updated — recreating container"
            : "Environment updated"
        );
        invalidate("containers", "tasks");
        // updateContainerEnv recreates the workload asynchronously. Fetching
        // with this component's old container ID races Docker's removal and
        // surfaces a spurious "container inspect" daemon error. The detail
        // page switches to the replacement ID from its recreate event, which
        // re-runs fetchEnv through the containerId dependency.
        void Promise.resolve(onRecreating?.()).catch(() => undefined);
      } else {
        toast.success("Secrets updated — changes will apply on next container recreate");
        onMutationEnd?.();
      }
    } catch (err) {
      onMutationEnd?.();
      toast.error(err instanceof Error ? err.message : "Failed to update environment");
    } finally {
      envMutationInProgressRef.current = false;
      setIsSaving(false);
    }
  };

  const initialLoading =
    isLoading ||
    databaseNodeLoading ||
    (hasDatabaseNode && databaseLinksLoading) ||
    (managedStorageLinksEnabled && canEdit && canManageSecrets && storageLinksLoading);
  // The tab stays hidden until the environment and its link sections have loaded; later
  // refreshes update in place.
  useContentLoading(initialLoading);

  // ── Derived state ────────────────────────────────────────────────

  if (!canEdit && !canManageSecrets) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to access environment variables or secrets.
      </div>
    );
  }

  const invalidKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const visibleEnvRows = envVars
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !replacementDatabaseVariableNames.has(entry.key.trim()));
  // The text editor's rules: invalid, duplicate and link-owned names are marked; a name a
  // pending link addition will take over stays applicable so the save can replace it.
  const textErrorLines = textEditorOpen ? validateRaw(rawText) : [];
  const rawManagedOnlyErrorLines = new Set<number>();
  const rawActiveManagedErrorLines = new Set<number>();
  if (textEditorOpen) {
    const keyLines = new Map<string, number[]>();
    rawText.split("\n").forEach((line, index) => {
      const stripped = line.trim().replace(/^export\s+/, "");
      const separator = stripped.indexOf("=");
      const key = separator > 0 ? stripped.slice(0, separator).trim() : "";
      if (key && invalidKeyPattern.test(key)) {
        keyLines.set(key, [...(keyLines.get(key) ?? []), index + 1]);
      }
    });
    for (const [key, lines] of keyLines) {
      if (
        managedLinkVariableNames.has(key) &&
        !replacementDatabaseVariableNames.has(key) &&
        lines.length === 1
      ) {
        rawManagedOnlyErrorLines.add(lines[0]!);
        if (activeManagedLinkVariableNames.has(key)) rawActiveManagedErrorLines.add(lines[0]!);
      }
    }
  }

  // Build a unified key map across both user-editable sections. Managed names
  // are styled as conflicts too, but pending link additions remain saveable so
  // the confirmed save can replace the collided value.
  const allKeyLocations = new Map<string, { envIndices: number[]; secretIndices: number[] }>();
  envVars.forEach((entry, index) => {
    const key = entry.key.trim();
    if (!key || replacementDatabaseVariableNames.has(key)) return;
    const location = allKeyLocations.get(key) ?? { envIndices: [], secretIndices: [] };
    location.envIndices.push(index);
    allKeyLocations.set(key, location);
  });
  secretRows.forEach((row, index) => {
    const key = row.key.trim();
    if (!key || replacementDatabaseVariableNames.has(key)) return;
    const location = allKeyLocations.get(key) ?? { envIndices: [], secretIndices: [] };
    location.secretIndices.push(index);
    allKeyLocations.set(key, location);
  });

  const duplicateKeyIndices = new Set<number>();
  const duplicateSecretIndices = new Set<number>();
  const managedEnvCollisionIndices = new Set<number>();
  const managedSecretCollisionIndices = new Set<number>();
  const activeManagedEnvCollisionIndices = new Set<number>();
  const activeManagedSecretCollisionIndices = new Set<number>();

  for (const [, location] of allKeyLocations) {
    if (location.envIndices.length + location.secretIndices.length > 1) {
      for (const index of location.envIndices) duplicateKeyIndices.add(index);
      for (const index of location.secretIndices) duplicateSecretIndices.add(index);
    }
  }
  envVars.forEach((entry, index) => {
    const key = entry.key.trim();
    if (!managedLinkVariableNames.has(key) || replacementDatabaseVariableNames.has(key)) return;
    managedEnvCollisionIndices.add(index);
    if (activeManagedLinkVariableNames.has(key)) activeManagedEnvCollisionIndices.add(index);
  });
  secretRows.forEach((row, index) => {
    const key = row.key.trim();
    if (!managedLinkVariableNames.has(key) || replacementDatabaseVariableNames.has(key)) return;
    managedSecretCollisionIndices.add(index);
    if (activeManagedLinkVariableNames.has(key)) activeManagedSecretCollisionIndices.add(index);
    if (key && !invalidKeyPattern.test(key)) duplicateSecretIndices.add(index);
  });

  const hasEnvTableErrors =
    visibleEnvRows.some(
      ({ entry }) => !entry.key.trim() || !invalidKeyPattern.test(entry.key.trim())
    ) || duplicateKeyIndices.size > 0;
  const hasSecretErrors =
    secretRows
      .filter((row) => !replacementDatabaseVariableNames.has(row.key.trim()))
      .some((row) => !row.key.trim() || !invalidKeyPattern.test(row.key.trim())) ||
    duplicateSecretIndices.size > 0;
  const hasActiveManagedConflicts =
    activeManagedEnvCollisionIndices.size > 0 || activeManagedSecretCollisionIndices.size > 0;
  const hasErrors = hasEnvTableErrors || hasSecretErrors || hasActiveManagedConflicts;
  const textBlocked =
    textErrorLines.some((line) => !rawManagedOnlyErrorLines.has(line)) ||
    rawActiveManagedErrorLines.size > 0;

  // Env changes
  const currentEnvStr = visibleEnvRows.map(({ entry }) => `${entry.key}=${entry.value}`).join("\n");
  const originalEnvStr = originalEnv
    .filter((entry) => !replacementDatabaseVariableNames.has(entry.split("=")[0]!))
    .join("\n");
  const hasEnvChanges = currentEnvStr !== originalEnvStr;

  // Secret changes
  const hasSecretsChanges =
    deletedSecrets.size > 0 ||
    secretRows.some((row) => !replacementDatabaseVariableNames.has(row.key.trim()) && row.dirty);
  const hasChanges = hasEnvChanges || hasSecretsChanges;
  const hasCombinedChanges =
    hasChanges || databaseLinkDraft.hasChanges || storageLinkDraft.hasChanges;

  const showDatabaseLinks = Boolean(
    managedDatabaseLinksEnabled && canEdit && canManageSecrets && containerName && hasDatabaseNode
  );
  const showStorageLinks = Boolean(
    managedStorageLinksEnabled && canEdit && canManageSecrets && containerName
  );

  return (
    <div className={`${flushBottom ? "" : "pb-6 "}space-y-4`}>
      {(showDatabaseLinks || showStorageLinks || containerLinksEnabled) && (
        <LinksPanel
          description={
            recreatesRunningContainer
              ? "Private connections to managed databases, managed storage and other containers. Database and storage changes apply with Save & Recreate."
              : "Private connections to managed databases, managed storage and other containers. Database and storage changes apply on next start."
          }
          onSave={() => void handleSave()}
        >
          {showDatabaseLinks && containerName && (
            <ManagedDatabaseLinksSection
              ref={databaseLinksRef}
              nodeId={nodeId}
              targetType={databaseTargetType}
              targetResourceId={resolvedDatabaseTargetResourceId}
              containerName={containerName}
              disabled={linksDisabled || isSaving || hasErrors || !canChangeManagedLinks}
              canAdd={canChangeManagedLinks}
              removeDisabledReason={linkRemovalDisabledReason}
              existingVariableNames={[...existingVariableNames, ...managedStorageVariableNames]}
              onInitialLoadingChange={setDatabaseLinksLoading}
              onDraftChange={handleDatabaseLinkDraftChange}
              onSaveRequested={() => void handleSave()}
              recreatesRunningWorkload={recreatesRunningContainer}
            />
          )}

          {showStorageLinks && containerName && (
            <ManagedStorageLinksSection
              ref={storageLinksRef}
              nodeId={nodeId}
              targetType={storageTargetType!}
              targetResourceId={resolvedStorageTargetResourceId}
              containerName={containerName}
              canManage={canManageManagedStorage}
              canManageCluster={canManageStorageCluster}
              disabled={linksDisabled || isSaving || hasErrors || !canChangeManagedLinks}
              removeDisabledReason={linkRemovalDisabledReason}
              existingVariableNames={[...existingVariableNames, ...managedDatabaseVariableNames]}
              onInitialLoadingChange={setStorageLinksLoading}
              onDraftChange={handleStorageLinkDraftChange}
              onSaveRequested={() => void handleSave()}
              recreatesRunningWorkload={recreatesRunningContainer}
            />
          )}

          {containerLinksEnabled && (
            <ContainerLinksSection
              nodeId={nodeId}
              type={storageTargetType!}
              resourceId={resolvedStorageTargetResourceId}
              workloadName={containerName!}
              canManage={canManageContainerLinks}
              canSetEnvironment={canEdit}
              disabled={linksDisabled || isSaving}
              removeDisabledReason={linkRemovalDisabledReason}
              onMutationStart={onMutationStart}
              onMutationEnd={onMutationEnd}
              onRecreating={onRecreating}
            />
          )}
        </LinksPanel>
      )}

      <fieldset
        disabled={disabled || isSaving}
        className={`space-y-4 ${disabled || isSaving ? "pointer-events-none opacity-60" : ""}`}
      >
        {canEdit && (
          <PanelShell
            title="Environment Variables"
            description={
              environmentDescription ??
              (onSaveServiceEnv
                ? "Saved to deployment configuration"
                : "Changes will recreate the container")
            }
            actions={
              <>
                {canEdit && (
                  <Button variant="ghost" size="icon" onClick={addVar} title="Add variable">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button variant="ghost" onClick={openTextEditor}>
                  <FileCode2 className="h-3.5 w-3.5" />
                  Edit as text
                </Button>
                {canEdit && (
                  <Button
                    variant="warning"
                    onClick={handleSave}
                    pending={isSaving}
                    disabled={!hasCombinedChanges || hasErrors}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {onSaveServiceEnv
                      ? resolvedServiceSaveLabel
                      : databaseLinkDraft.hasChanges ||
                          storageLinkDraft.hasChanges ||
                          recreatesRunningContainer
                        ? "Save & Recreate"
                        : "Save"}
                  </Button>
                )}
              </>
            }
          >
            {visibleEnvRows.length > 0 && (
              <div className="grid grid-cols-[1fr_1fr] border-b border-border bg-header text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <div className="px-3 py-2">Key</div>
                <div className="px-3 py-2 border-l border-border">Value</div>
              </div>
            )}
            <div>
              {visibleEnvRows.map(({ entry: env, index: idx }) => (
                <div
                  key={idx}
                  className="grid grid-cols-[1fr_1fr] border-b border-border last:border-b-0"
                >
                  <Input
                    value={env.key}
                    onChange={(e) => updateVar(idx, "key", e.target.value)}
                    className={`h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                      duplicateKeyIndices.has(idx) ||
                      managedEnvCollisionIndices.has(idx) ||
                      (env.key.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.key.trim()))
                        ? "bg-destructive/10 text-destructive"
                        : ""
                    }`}
                    placeholder="KEY"
                  />
                  <div className="flex items-center border-l border-border">
                    <Input
                      value={env.value}
                      onChange={(e) => updateVar(idx, "value", e.target.value)}
                      className="h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring flex-1 min-w-0"
                      placeholder="value"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 rounded-none border-l border-border"
                      onClick={() => removeVar(idx)}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {visibleEnvRows.length === 0 && (
              <EmptyState
                message="No environment variables."
                actionLabel="Add one"
                onAction={addVar}
                embedded
              />
            )}
          </PanelShell>
        )}

        {(canManageSecrets || canEdit) && (
          <SecretsSection
            canManageSecrets={canManageSecrets}
            onSave={!canEdit ? handleSave : undefined}
            saveButtonLabel="Save"
            saveDisabled={isSaving || !hasCombinedChanges || hasErrors}
            isSaving={isSaving}
            secretRows={secretRows}
            setSecretRows={setSecretRows}
            setDeletedSecrets={setDeletedSecrets}
            duplicateSecretIndices={
              new Set([...duplicateSecretIndices, ...managedSecretCollisionIndices])
            }
            invalidKeyPattern={invalidKeyPattern}
            hiddenKeys={replacementDatabaseVariableNames}
            description={secretsDescription}
          />
        )}
      </fieldset>

      <EnvTextDialog
        open={textEditorOpen}
        onOpenChange={setTextEditorOpen}
        title="Edit environment variables"
        description="One KEY=value per line. Apply puts them in the table; they are stored when you save."
        value={rawText}
        onValueChange={setRawText}
        errorLines={textErrorLines}
        applyDisabled={textBlocked}
        onApply={applyText}
      />
    </div>
  );
}
