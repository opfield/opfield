import { useCallback, useEffect, useRef, useState } from "react";
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
import { listManagedDatabaseCandidateNodes } from "@/lib/managed-database-nodes";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DockerContainerDetail } from "../DockerContainerDetail";
import { DockerResourceGitTabs } from "./DockerResourceGitTabs";
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
  const [tab, setTab] = useUrlTab(["source", "builds", "environment"], "source", (next) =>
    dockerContainerRoute(nodeSlug, containerName, next)
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
          description="The container will be created by the first successful deployment. You can edit the security policy in Source and retry failed or blocked builds. Runtime actions become available after deployment."
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
            <PendingContainerLinks
              nodeId={nodeId}
              containerName={containerName}
              resourceScope={resourceScope}
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

/**
 * The Environment tab's managed links for a container its first build has not created yet. Links save pending into
 * the reservation and the first build creates the container with them. The container has no environment to edit
 * before then, so only the links are shown.
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
      toast.error(error instanceof Error ? error.message : "Failed to save managed links");
    } finally {
      setSaving(false);
    }
  };

  if (!canLink) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to access environment variables or secrets.
      </div>
    );
  }
  return (
    <div className="space-y-4 pb-6">
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
    </div>
  );
}
