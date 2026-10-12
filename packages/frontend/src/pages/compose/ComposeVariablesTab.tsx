import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { createClientUuid } from "@/lib/client-id";
import { api } from "@/services/api";
import { usePlanIncludes } from "@/stores/license-paywall";
import type { DockerComposeProject } from "@/types";
import { ContainerLinksSection } from "../docker-detail/ContainerLinksSection";
import { EnvironmentTab } from "../docker-detail/EnvironmentTab";
import { LinksPanel } from "../docker-detail/LinksPanel";
import { ManagedDatabaseLinksSection } from "../docker-detail/ManagedDatabaseLinksSection";

export function ComposeVariablesTab({
  project,
  canManage,
  onApplied,
  linkRemovalDisabledReason = null,
}: {
  project: DockerComposeProject;
  canManage: boolean;
  onApplied: () => void | Promise<void>;
  /** Why removing links is disabled (the project's app environment is isolated by the kill switch). */
  linkRemovalDisabledReason?: string | null;
}) {
  const activeRevision = project.activeRevision;
  // A Git project before its first revision takes links pending; its services come from the Compose file the
  // source resolved, when Gateway has one.
  const beforeFirstRevision = !activeRevision && project.managementState === "managed";
  const [sourceServiceNames, setSourceServiceNames] = useState<string[]>([]);
  useEffect(() => {
    if (!beforeFirstRevision) return;
    let active = true;
    void api
      .getDockerSource({
        kind: "compose_project",
        nodeId: project.nodeId,
        composeProjectId: project.id,
      })
      .then((source) => {
        if (active) setSourceServiceNames(source?.composeServiceNames ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [beforeFirstRevision, project.id, project.nodeId]);
  const serviceNames = useMemo(
    () =>
      activeRevision
        ? Object.keys(activeRevision.normalizedModel.services ?? {})
        : sourceServiceNames,
    [activeRevision, sourceServiceNames]
  );
  const recreatesRunningProject = project.status === "running" || project.status === "degraded";
  // Each link kind needs its plan feature; without it the section (and its loads) is skipped.
  const managedDatabaseLinksEnabled = usePlanIncludes("external-database-connections");
  const containerLinksEnabled =
    usePlanIncludes("container-links") && !!activeRevision && serviceNames.length > 0;
  const secretApi = useMemo(
    () => ({
      list: () => api.listDockerComposeSecrets(project.nodeId, project.id),
      create: (key: string, value: string) =>
        api.createDockerComposeSecret(project.nodeId, project.id, key, value),
      update: (id: string, value: string) =>
        api.updateDockerComposeSecret(project.nodeId, project.id, id, value),
      delete: (id: string) => api.deleteDockerComposeSecret(project.nodeId, project.id, id),
    }),
    [project.id, project.nodeId]
  );

  const saveVariables = async (variables: Record<string, string>) => {
    if (!activeRevision) throw new Error("No active Compose revision");
    const secrets = await secretApi.list();
    const revision = await api.createDockerComposeRevision(project.nodeId, project.id, {
      yaml: activeRevision.sourceYaml,
      variables,
      secretKeys: secrets.map((secret) => secret.key),
    });
    if (recreatesRunningProject) {
      await api.startDockerComposeOperation(project.nodeId, project.id, "pull_apply", {
        revisionId: revision.id,
        idempotencyKey: createClientUuid(),
      });
      toast.success("Variables saved in a new revision and Pull & Apply started");
    } else {
      toast.success("Variables saved as a new inactive revision");
    }
    await onApplied();
  };

  return (
    <div className="space-y-4 pb-6">
      {(managedDatabaseLinksEnabled || containerLinksEnabled) && (
        <LinksPanel
          description={
            beforeFirstRevision
              ? "Private connections to managed databases and other containers. Database links are saved now and added to the selected services by the project's first revision."
              : "Private connections to managed databases and other containers, stored in each selected service's Compose revision."
          }
        >
          {managedDatabaseLinksEnabled && (
            <ManagedDatabaseLinksSection
              nodeId={project.nodeId}
              targetType="compose_service"
              targetResourceId={project.id}
              containerName={project.name}
              disabled={(!beforeFirstRevision && serviceNames.length === 0) || !canManage}
              canAdd={canManage}
              removeDisabledReason={linkRemovalDisabledReason}
              recreatesRunningWorkload={recreatesRunningProject}
              composeBeforeFirstRevision={beforeFirstRevision}
              composeServices={serviceNames.map((name) => ({
                name,
                existingVariableNames: Object.keys(
                  activeRevision?.normalizedModel.services[name]?.environment ?? {}
                ),
              }))}
            />
          )}

          {containerLinksEnabled && (
            <ContainerLinksSection
              nodeId={project.nodeId}
              type="compose_service"
              resourceId={project.id}
              workloadName={project.name}
              services={serviceNames}
              canManage={canManage}
              canSetEnvironment={canManage}
              removeDisabledReason={linkRemovalDisabledReason}
              onApplied={onApplied}
            />
          )}
        </LinksPanel>
      )}

      {activeRevision ? (
        <EnvironmentTab
          nodeId={project.nodeId}
          containerId={project.id}
          containerName={project.name}
          serviceEnv={activeRevision.variables ?? {}}
          onSaveServiceEnv={saveVariables}
          canEditOverride={canManage}
          canManageSecretsOverride={canManage}
          secretApi={secretApi}
          environmentDescription="Saved as immutable Compose revision variables"
          secretsDescription="Encrypted at rest — supplied to Compose interpolation during apply"
          serviceSaveLabel={recreatesRunningProject ? "Save & Recreate" : "Save"}
          serviceSaveDescription={
            recreatesRunningProject
              ? "Saving variables creates and applies a new immutable revision. Running services will be recreated and experience brief downtime. Continue?"
              : "Saving variables creates a new immutable revision for this stopped project."
          }
          flushBottom
        />
      ) : beforeFirstRevision ? (
        <PanelShell
          title="Variables"
          description="Available once the first revision lands."
          bodyClassName="p-6 text-sm text-muted-foreground"
        >
          The first build creates the project's first revision from its Git source.
        </PanelShell>
      ) : (
        <PanelShell
          title="Variables"
          description="Adopt the project before managing variables and secrets."
          bodyClassName="p-6 text-sm text-muted-foreground"
        >
          External projects do not have an Opfield-owned revision yet.
        </PanelShell>
      )}
    </div>
  );
}
