import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DockerContainerDetail } from "../DockerContainerDetail";
import { DockerResourceGitTabs } from "./DockerResourceGitTabs";
import { EnvironmentTab } from "./EnvironmentTab";
import type { InspectData } from "./helpers";
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
import { PendingContainerVolumes } from "./PendingContainerVolumes";

export async function resolveContainerOrPendingSource(
  nodeId: string,
  containerName: string
): Promise<InspectData> {
  try {
    return (await api.inspectContainerByName(nodeId, containerName)) as InspectData;
  } catch (error) {
    // A dedicated scoped endpoint proves a persisted reservation. Runtime
    // inspection itself must never invent a container for mutation callers.
    const pending = await api
      .getPendingDockerSourceContainer(nodeId, containerName)
      .catch(() => null);
    if (!pending?.pendingSourceBuild) throw error;
    return { ...pending, Id: pending.sourceBindingId, Name: `/${pending.containerName}` };
  }
}

/** A persisted source reservation, not a Docker runtime or an HA placement. */
export function DockerPendingContainerDetail({
  nodeId,
  nodeSlug,
  containerName,
  snapshot,
  pageContextToken,
}: {
  nodeId: string;
  nodeSlug: string;
  containerName: string;
  snapshot: InspectData;
  pageContextToken?: number | null;
}) {
  const navigate = useStableNavigate();
  const [runtime, setRuntime] = useState<InspectData | null>(null);
  const [pending, setPending] = useState(snapshot);
  const { hasScope } = useAuthStore();
  const resourceScope = `${nodeId}/${snapshot.scopeResourceId}`;
  const canEdit = hasScope(`docker:containers:edit:${resourceScope}`);
  const canBuild = hasScope(`docker:containers:manage:${resourceScope}`);
  const [tab, setTab] = useUrlTab(
    ["source", "builds", "environment", "volumes"],
    "source",
    (next) => dockerContainerRoute(nodeSlug, containerName, next)
  );
  const refresh = useCallback(async () => {
    try {
      const next = (await api.inspectContainerByName(nodeId, containerName, true)) as InspectData;
      if (!next.pendingSourceBuild) setRuntime(next);
    } catch {
      // Initial build failures leave Source and its failed-build history usable.
      const next = await api
        .getPendingDockerSourceContainer(nodeId, containerName)
        .catch(() => null);
      if (next) setPending(next);
    }
  }, [nodeId, containerName]);
  useEffect(() => {
    if (runtime) return;
    let active = true;
    const timer = setInterval(() => {
      if (active && !document.hidden) void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh, runtime]);
  useRealtime(
    runtime ? null : "docker.build.changed",
    (payload) => {
      if ((payload as { sourceBindingId?: string })?.sourceBindingId === snapshot.sourceBindingId)
        void refresh();
    },
    { onReconnect: () => void refresh() }
  );

  if (runtime)
    return (
      <DockerContainerDetail
        resolvedNodeId={nodeId}
        resolvedNodeSlug={nodeSlug}
        resolvedContainerName={containerName}
        resolvedContainerId={String(runtime.Id ?? runtime.id)}
        resolvedContainer={runtime}
        pageContextToken={pageContextToken}
      />
    );

  return (
    <PageTransition>
      <div className="h-full p-6 flex flex-col gap-4 overflow-y-auto">
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate("/docker/containers")} />}
          title={containerName}
          badges={
            <Badge
              variant={pending.latestBuild?.status === "failed" ? "warning" : "secondary"}
              size="inline"
              className="shrink-0"
            >
              {pending.latestBuild?.status === "failed" ? "Build failed" : "Awaiting deployment"}
            </Badge>
          }
        />
        <PanelShell
          className="shrink-0"
          title="Resource created"
          description={
            pending.latestBuild?.status === "failed" && pending.state
              ? pending.state
              : "The container will be created by the first successful deployment. You can edit the security policy in Source and retry failed or blocked builds. Runtime actions become available after deployment."
          }
        />
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="source" className="gap-1.5">
              Source
            </TabsTrigger>
            <TabsTrigger value="builds" className="gap-1.5">
              Builds
            </TabsTrigger>
            <TabsTrigger value="environment" className="gap-1.5">
              Environment
            </TabsTrigger>
            <TabsTrigger value="volumes" className="gap-1.5">
              Volumes
            </TabsTrigger>
          </TabsList>
          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId, containerName }}
              view="source"
              pendingContainer
              canEdit={canEdit}
              canBuild={canBuild}
            />
          </TabsContent>
          <TabsContent value="builds" className="flex min-h-0 flex-1 flex-col pb-0">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId, containerName }}
              view="builds"
              canEdit={canEdit}
              canBuild={canBuild}
            />
          </TabsContent>
          <TabsContent value="environment">
            <div className="space-y-4 pb-6">
              <PendingContainerLinks
                nodeId={nodeId}
                containerName={containerName}
                resourceScope={resourceScope}
              />
              <PendingContainerEnvironment
                nodeId={nodeId}
                containerName={containerName}
                scopeResourceId={String(snapshot.scopeResourceId ?? "")}
              />
            </div>
          </TabsContent>
          <TabsContent value="volumes" className="pb-6">
            <PendingContainerVolumes
              nodeId={nodeId}
              containerName={containerName}
              scopeResourceId={String(snapshot.scopeResourceId ?? "")}
              volumes={pending.initialConfig?.volumes}
              onSaved={(volumes) =>
                setPending((current) => ({
                  ...current,
                  initialConfig: { ...current.initialConfig, volumes },
                }))
              }
            />
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}

const NO_DATABASE_LINK_CHANGES: ManagedDatabaseLinkDraft = {
  hasChanges: false,
  managedVariableNames: [],
  pendingAdditionVariableNames: [],
  replacementVariableNames: [],
};
const NO_STORAGE_LINK_CHANGES: ManagedStorageLinkDraft = {
  hasChanges: false,
  managedVariableNames: [],
  pendingAdditionVariableNames: [],
};

/** `KEY=value` entries as a record. */
function envRecord(entries: string[]): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      return separator >= 0 ? [entry.slice(0, separator), entry.slice(separator + 1)] : [entry, ""];
    })
  );
}

/**
 * The environment variables and secrets of a container its first build has not created yet: saved under its
 * reserved name, and the first build creates and starts the container with them. The editors of the Environment
 * tab, saving without a recreate.
 */
function PendingContainerEnvironment({
  nodeId,
  containerName,
  scopeResourceId,
}: {
  nodeId: string;
  containerName: string;
  scopeResourceId: string;
}) {
  const { hasScope } = useAuthStore();
  const canEdit = hasScope(`docker:containers:environment:${nodeId}/${scopeResourceId}`);
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let active = true;
    if (!canEdit) {
      setEnv({});
      return;
    }
    void api
      .getContainerEnv(nodeId, containerName)
      .then((entries) => {
        if (active) setEnv(envRecord(entries));
      })
      .catch((error) => toastApiError(error, "Failed to fetch environment"));
    return () => {
      active = false;
    };
  }, [canEdit, nodeId, containerName]);
  const secretApi = useMemo(
    () => ({
      list: () => api.listDockerSecrets(nodeId, containerName),
      create: (key: string, value: string) =>
        api.createDockerSecret(nodeId, containerName, key, value),
      update: (id: string, value: string) =>
        api.updateDockerSecret(nodeId, containerName, id, value),
      delete: (id: string) => api.deleteDockerSecret(nodeId, containerName, id),
    }),
    [nodeId, containerName]
  );
  if (!env) return null;
  return (
    <EnvironmentTab
      nodeId={nodeId}
      containerId={containerName}
      containerName={containerName}
      scopeResourceId={scopeResourceId}
      serviceEnv={env}
      onSaveServiceEnv={async (next) => {
        // Without the environment permission only the secrets (saved before this) change.
        if (!canEdit) return;
        const removeEnv = Object.keys(env).filter((key) => !Object.hasOwn(next, key));
        await api.updateContainerEnv(
          nodeId,
          containerName,
          next,
          removeEnv.length > 0 ? removeEnv : undefined
        );
        setEnv(next);
      }}
      secretApi={secretApi}
      environmentDescription="Applied when the first build creates the container"
      secretsDescription="Applied when the first build creates the container"
      serviceSaveLabel="Save"
      serviceSaveDescription="Environment changes are saved and apply when the first build creates the container. Continue?"
      flushBottom
    />
  );
}

/**
 * The Environment tab's managed links for a container its first build has not created yet. Links save pending into
 * the reservation and the first build creates the container with them.
 */
function PendingContainerLinks({
  nodeId,
  containerName,
  resourceScope,
}: {
  nodeId: string;
  containerName: string;
  resourceScope: string;
}) {
  const { hasScope, hasScopedAccess } = useAuthStore();
  // The link API requires the container's environment and secrets permissions, as on the Environment tab.
  const canLink =
    hasScope(`docker:containers:environment:${resourceScope}`) &&
    hasScope(`docker:containers:secrets:${resourceScope}`);
  const canViewStorage = hasScopedAccess("storage:view");
  const canManageStorage = hasScopedAccess("storage:bind");
  const canManageStorageCluster = useCallback(
    (connectionId: string | null) =>
      hasScope("storage:bind") || Boolean(connectionId && hasScope(`storage:bind:${connectionId}`)),
    [hasScope]
  );
  const [hasDatabaseNode, setHasDatabaseNode] = useState(false);
  const [saving, setSaving] = useState(false);
  const databaseLinksRef = useRef<ManagedDatabaseLinksSectionHandle>(null);
  const storageLinksRef = useRef<ManagedStorageLinksSectionHandle>(null);
  const [databaseDraft, setDatabaseDraft] = useState(NO_DATABASE_LINK_CHANGES);
  const [storageDraft, setStorageDraft] = useState(NO_STORAGE_LINK_CHANGES);

  useEffect(() => {
    if (!canLink) return;
    let active = true;
    void listManagedDatabaseCandidateNodes(1)
      .then((nodes) => {
        if (active) setHasDatabaseNode(nodes.length > 0);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [canLink]);

  const save = async () => {
    if (saving || (!databaseDraft.hasChanges && !storageDraft.hasChanges)) return;
    const ok = await confirm({
      title: "Save",
      description: `Save managed link changes for “${containerName}”? They apply when the first build creates the container.`,
      confirmLabel: "Save",
    });
    if (!ok) return;
    setSaving(true);
    try {
      if (databaseDraft.hasChanges) await databaseLinksRef.current?.applyChanges();
      if (storageDraft.hasChanges) await storageLinksRef.current?.applyChanges();
      toast.success("Managed links saved — they apply when the first build creates the container");
    } catch (error) {
      toastApiError(error, "Failed to save managed links");
    } finally {
      setSaving(false);
    }
  };

  // The environment editors below say when the caller may not see the environment.
  if (!canLink) return null;
  return (
    <LinksPanel
      description="Private connections to managed databases and managed storage. They apply when the first build creates the container."
      onSave={() => void save()}
    >
      {hasDatabaseNode && (
        <ManagedDatabaseLinksSection
          ref={databaseLinksRef}
          nodeId={nodeId}
          targetType="container"
          targetResourceId={containerName}
          containerName={containerName}
          disabled={saving}
          existingVariableNames={storageDraft.managedVariableNames}
          onDraftChange={setDatabaseDraft}
          onSaveRequested={() => void save()}
          recreatesRunningWorkload={false}
        />
      )}
      {canViewStorage && (
        <ManagedStorageLinksSection
          ref={storageLinksRef}
          nodeId={nodeId}
          targetType="container"
          targetResourceId={containerName}
          containerName={containerName}
          canManage={canManageStorage}
          canManageCluster={canManageStorageCluster}
          disabled={saving}
          existingVariableNames={databaseDraft.managedVariableNames}
          onDraftChange={setStorageDraft}
          onSaveRequested={() => void save()}
          recreatesRunningWorkload={false}
        />
      )}
    </LinksPanel>
  );
}
