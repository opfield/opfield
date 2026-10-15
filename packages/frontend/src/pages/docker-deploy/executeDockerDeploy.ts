import type { NavigateFunction } from "react-router-dom";
import { toast } from "sonner";
import { dockerContainerRoute, dockerDeploymentRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useDockerStore } from "@/stores/docker";
import type {
  ContainerCreateConfig,
  DockerRuntimeProfile,
  DockerSourceContainerVolume,
  Node,
} from "@/types";
import type { DockerDeployMode, DockerDeploySourceMode, DockerRestartPolicy } from "./types";

interface ExecuteDockerDeployOptions {
  availableNodes: Node[];
  closeDeploy: () => void;
  deployImage: string;
  deployLocalImages: string[];
  deployMode: DockerDeployMode;
  deployName: string;
  deployNodeId: string;
  deployFolderId?: string | null;
  deployRegistryId: string;
  deployRestart: DockerRestartPolicy;
  deployRuntimeProfile: DockerRuntimeProfile;
  drainSeconds: string;
  healthPath: string;
  navigate: NavigateFunction;
  onDeployed?: (containerId?: string) => void;
  routeContainerPort: string;
  routeHostPort: string;
  sourceAutoBuild: boolean;
  sourceAutoDeploy: boolean;
  sourceBranch: string;
  sourceConnectorId: string;
  sourceContextPath: string;
  sourceDockerfilePath: string;
  sourceMode: DockerDeploySourceMode;
  sourceProjectId: string;
  /** A container from a repository: saved with it and applied when its first build creates and starts it. */
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  volumes?: DockerSourceContainerVolume[];
}

const INTERNAL_DOCKER_REGISTRY_ID = "gateway-internal-registry";

export function deployCredentialRegistryId(registryId: string): string | undefined {
  const value = registryId.trim();
  return value && value !== INTERNAL_DOCKER_REGISTRY_ID ? value : undefined;
}

function getNodeSlug(nodeId: string, availableNodes: Node[]) {
  return (
    useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug ||
    availableNodes.find((node) => node.id === nodeId)?.slug
  );
}

export async function executeDockerDeploy({
  availableNodes,
  closeDeploy,
  deployImage,
  deployLocalImages,
  deployMode,
  deployName,
  deployNodeId,
  deployFolderId,
  deployRegistryId,
  deployRestart,
  deployRuntimeProfile,
  drainSeconds,
  healthPath,
  navigate,
  onDeployed,
  routeContainerPort,
  routeHostPort,
  sourceAutoBuild,
  sourceAutoDeploy,
  sourceBranch,
  sourceConnectorId,
  sourceContextPath,
  sourceDockerfilePath,
  sourceMode,
  sourceProjectId,
  env,
  secrets,
  volumes,
}: ExecuteDockerDeployOptions) {
  const credentialRegistryId = deployCredentialRegistryId(deployRegistryId);

  if (sourceMode === "repository") {
    const result = await api.createDockerSourceResource(deployNodeId, {
      source: {
        connectorId: sourceConnectorId,
        projectId: sourceProjectId,
        branch: sourceBranch.trim(),
        dockerfilePath: sourceDockerfilePath.trim(),
        contextPath: sourceContextPath.trim(),
        autoBuild: sourceAutoBuild,
        autoDeploy: sourceAutoDeploy,
        buildArgs: {},
        buildSecretNames: [],
        policy: {},
      },
      resource:
        deployMode === "deployment"
          ? {
              kind: "deployment",
              folderId: deployFolderId,
              name: deployName.trim(),
              restartPolicy: deployRestart === "no" ? "unless-stopped" : deployRestart,
              runtimeProfile: deployRuntimeProfile,
              routes: [
                {
                  hostPort: Number(routeHostPort),
                  containerPort: Number(routeContainerPort),
                  isPrimary: true,
                },
              ],
              health: {
                path: healthPath || "/",
                statusMin: 200,
                statusMax: 399,
                timeoutSeconds: 5,
                intervalSeconds: 5,
                successThreshold: 2,
                startupGraceSeconds: 5,
                deployTimeoutSeconds: 300,
              },
              drainSeconds: Number(drainSeconds) || 0,
            }
          : {
              kind: "container",
              folderId: deployFolderId,
              name: deployName.trim(),
              restartPolicy: deployRestart,
              runtimeProfile: deployRuntimeProfile,
              ...(env && Object.keys(env).length > 0 ? { env } : {}),
              ...(secrets && Object.keys(secrets).length > 0 ? { secrets } : {}),
              ...(volumes && volumes.length > 0 ? { volumes } : {}),
            },
    });
    toast.success(result.build ? "Resource created and build queued" : "Resource created");
    if (result.firstBuildWaiting) toast.info(result.firstBuildWaiting.message);
    if (result.initialBuildError)
      toast.warning(
        `${result.initialBuildError.message} You can adjust Source settings and retry Build now.`
      );
    closeDeploy();
    onDeployed?.(result.target.kind === "deployment" ? result.target.deploymentId : undefined);
    const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
    if (nodeSlug) {
      navigate(
        result.target.kind === "deployment"
          ? dockerDeploymentRoute(nodeSlug, deployName.trim(), "source")
          : dockerContainerRoute(nodeSlug, deployName.trim(), "source")
      );
    }
    return;
  }

  let imageRef = deployImage.trim();
  if (!deployLocalImages.includes(imageRef)) {
    toast.info(`Pulling "${imageRef}"...`);
    // The deploy destination authorizes this pull, so a folder-only creator needs no image pull scope.
    const pullResult = await api.pullImageSync(deployNodeId, imageRef, credentialRegistryId, {
      folderId: deployFolderId ?? null,
    });
    imageRef = pullResult.imageRef;
  }

  if (deployMode === "deployment") {
    const deployment = await api.createDockerDeployment(deployNodeId, {
      folderId: deployFolderId,
      name: deployName.trim(),
      image: imageRef,
      registryId: credentialRegistryId,
      restartPolicy: deployRestart === "no" ? "unless-stopped" : deployRestart,
      routes: [
        {
          hostPort: Number(routeHostPort),
          containerPort: Number(routeContainerPort),
          isPrimary: true,
        },
      ],
      health: {
        path: healthPath || "/",
        statusMin: 200,
        statusMax: 399,
        timeoutSeconds: 5,
        intervalSeconds: 5,
        successThreshold: 2,
        startupGraceSeconds: 5,
        deployTimeoutSeconds: 300,
      },
      drainSeconds: Number(drainSeconds) || 0,
      runtimeProfile: deployRuntimeProfile,
    });
    toast.success("Deployment created");
    closeDeploy();
    onDeployed?.(deployment.id);
    const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
    if (nodeSlug) navigate(dockerDeploymentRoute(nodeSlug, deployment.name));
    return;
  }

  const config: ContainerCreateConfig = {
    folderId: deployFolderId,
    image: imageRef,
    registryId: credentialRegistryId,
    restartPolicy: deployRestart,
    runtimeProfile: deployRuntimeProfile,
  };
  if (deployName.trim()) config.name = deployName.trim();
  const result = await api.createContainer(deployNodeId, config);
  toast.success("Container deployed");
  closeDeploy();
  const newId = (result as any)?.id ?? (result as any)?.Id;
  onDeployed?.(newId);
  if (!newId) return;

  const inspect = await api.inspectContainer(deployNodeId, newId).catch(() => null);
  const canonicalName = String(
    (inspect as any)?.Name ??
      (inspect as any)?.name ??
      (result as any)?.Name ??
      (result as any)?.name ??
      ""
  ).replace(/^\/+/, "");
  const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
  if (canonicalName && nodeSlug) navigate(dockerContainerRoute(nodeSlug, canonicalName));
}
