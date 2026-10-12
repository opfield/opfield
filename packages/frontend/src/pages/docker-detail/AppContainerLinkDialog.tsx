import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppEnvironmentFields } from "@/components/apps/AppEnvironmentFields";
import {
  type AppCreateContext,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import { toastApiError } from "@/lib/api-error-toast";
import { hasComposeProjectScope } from "@/lib/compose-access";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { AppMember, ContainerLinkCreateInput, DockerContainer } from "@/types";
import { ContainerLinkDialog, type ContainerLinkSourceOption } from "./ContainerLinkDialog";
import { composeServiceResourceId } from "./container-link-format";

const WORKLOAD_MEMBER_TYPES = new Set<AppMember["type"]>(["container", "deployment", "compose"]);
const NO_SOURCES: ContainerLinkSourceOption[] = [];

/**
 * Add Container Link opened from an app: the source is one of the environment's workloads
 * (containers, deployments and Compose services of that environment); the target can be any
 * workload, as on a workload's own page.
 */
export function AppContainerLinkDialog({
  open,
  onOpenChange,
  context,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: AppCreateContext;
  onCreated?: () => void;
}) {
  const { environment, environmentId, setEnvironmentId } = useAppEnvironmentChoice(context, open);
  const hasScope = useAuthStore((state) => state.hasScope);
  const scopes = useAuthStore((state) => state.user?.scopes);
  const [sources, setSources] = useState<ContainerLinkSourceOption[]>(NO_SOURCES);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [workloads, setWorkloads] = useState<DockerContainer[]>([]);

  useEffect(() => {
    if (!open || !environmentId) return;
    let cancelled = false;
    setSourcesLoading(true);
    setSources(NO_SOURCES);
    void api
      .listAppMembers(context.app.id, environmentId)
      .then(async (members) => {
        const workloadMembers = members.filter(
          (member) =>
            member.environmentId === environmentId && WORKLOAD_MEMBER_TYPES.has(member.type)
        );
        const groups = await Promise.all(
          workloadMembers.map(async (member): Promise<ContainerLinkSourceOption[]> => {
            const nodeId = member.nodeIds[0];
            if (!nodeId) return [];
            if (member.type === "compose") {
              const project = await api
                .getDockerComposeProject(nodeId, member.id)
                .catch(() => null);
              const services = Object.keys(project?.activeRevision?.normalizedModel.services ?? {});
              const canSetEnvironment = hasComposeProjectScope(
                scopes ?? [],
                "docker:compose:manage",
                nodeId,
                member.id
              );
              return services.map((service) => ({
                key: `compose:${nodeId}:${member.id}:${service}`,
                resourceId: composeServiceResourceId(member.id, service),
                label: `${member.name} · ${service}`,
                nodeId,
                type: "compose_service" as const,
                workloadName: member.name,
                canSetEnvironment,
              }));
            }
            return [
              {
                key: `${member.type}:${nodeId}:${member.id}`,
                resourceId: member.id,
                label: member.name,
                nodeId,
                type: member.type === "deployment" ? "deployment" : "container",
                workloadName: member.name,
                canSetEnvironment: hasScope(
                  `docker:containers:environment:${nodeId}/${member.name}`
                ),
              },
            ];
          })
        );
        if (!cancelled) setSources(groups.flat());
      })
      .catch((error) => {
        if (!cancelled) {
          toastApiError(error, "Failed to load the environment");
        }
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context.app.id, environmentId, hasScope, open, scopes]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .listDockerContainerSnapshots()
      .then((next) => {
        if (!cancelled) setWorkloads(next);
      })
      .catch(() => {
        if (!cancelled) setWorkloads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const createLink = async (input: ContainerLinkCreateInput) => {
    try {
      await api.createContainerLink(input);
    } catch (error) {
      if (!handleLicenseApiError(error, "Container links")) {
        toastApiError(error, "Failed to add the container link");
      }
      return false;
    }
    const restarts = Object.values(input.environment ?? {}).some(Boolean);
    toast.success(restarts ? "Container link added — recreating workload" : "Container link added");
    rememberAppCreation(context, environment);
    onCreated?.();
    return true;
  };

  const environmentName = environment?.name ?? "the environment";
  const fields = useMemo(
    () => (
      <AppEnvironmentFields
        context={context}
        environmentId={environmentId}
        onEnvironmentChange={setEnvironmentId}
        hint={`Opened from ${context.app.name}. The link starts at a workload of the environment.`}
      />
    ),
    [context, environmentId, setEnvironmentId]
  );

  return (
    <ContainerLinkDialog
      open={open}
      onOpenChange={onOpenChange}
      sourceNodeId=""
      sourceType="container"
      sources={sources}
      workloadName="The source"
      workloads={workloads}
      canSetEnvironment={false}
      onCreate={createLink}
      beforeFields={fields}
      description={`A workload of ${environmentName} will reach one port of another workload by an alias on a private network.`}
      sourceLabel="Source"
      sourcesLoading={sourcesLoading}
      emptySourcesMessage={`${environmentName} has no container, deployment or Compose project yet.`}
    />
  );
}
