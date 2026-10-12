import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AppEnvironmentFields,
  allowedNodesHint,
  NoAllowedNodeNotice,
} from "@/components/apps/AppEnvironmentFields";
import {
  type AppCreateContext,
  allowedAppNodes,
  appPlacementFolderId,
  rememberAppCreation,
  useAppEnvironmentChoice,
} from "@/components/apps/app-create-context";
import type { ComboboxOption } from "@/components/common/Combobox";
import { flattenFolderTree } from "@/components/common/scope-list-helpers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import {
  type DockerRuntimeProfile,
  type DockerRuntimeStatus,
  isNodeIncompatible,
  type Node,
} from "@/types";
import { DockerDeployFormFields } from "./docker-deploy/DockerDeployFormFields";
import { executeDockerDeploy } from "./docker-deploy/executeDockerDeploy";
import { SecureRuntimeSetupDialog } from "./docker-deploy/SecureRuntimeSetupDialog";
import type {
  DockerDeployMode,
  DockerDeploySourceMode,
  DockerRestartPolicy,
} from "./docker-deploy/types";
import { useDockerDeployData } from "./docker-deploy/useDockerDeployData";

const EMPTY_DOCKER_NODES: Node[] = [];
const ROOT_FOLDER_OPTIONS: ComboboxOption[] = [{ value: "__root__", label: "No folder" }];
const noNavigate = () => undefined;

interface DockerDeployDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected node ID (e.g. from the current node filter) */
  nodeId?: string;
  /** Extra list of docker nodes to show in the node selector */
  dockerNodes?: Node[];
  /** Called after a successful deploy; receives the new container ID if available */
  onDeployed?: (containerId?: string) => void;
  /**
   * Opened from an app: locked App field, environment select, only the environment's allowed
   * Docker nodes, created in the environment's placement folder. Stays on the app after deploy.
   */
  appContext?: AppCreateContext;
}

export function DockerDeployDialog({
  open,
  onOpenChange,
  nodeId,
  dockerNodes = EMPTY_DOCKER_NODES,
  onDeployed,
  appContext,
}: DockerDeployDialogProps) {
  const navigate = useNavigate();
  const appEnvironment = useAppEnvironmentChoice(appContext, open);
  const environment = appEnvironment.environment;
  const { hasScope } = useAuthStore();
  const effectiveScopes = useAuthStore((state) => state.user?.scopes ?? []);
  const [creationNodes, setCreationNodes] = useState<Node[]>([]);
  const [creationNodesLoaded, setCreationNodesLoaded] = useState(false);
  useEffect(() => {
    if (!open) {
      setCreationNodesLoaded(false);
      return;
    }
    let cancelled = false;
    void loadVisibleDockerNodes(effectiveScopes, ["docker:containers:create"], false)
      .then((nodes) => {
        if (!cancelled) setCreationNodes(nodes);
      })
      .catch(() => {
        if (!cancelled) setCreationNodes([]);
      })
      .finally(() => {
        if (!cancelled) setCreationNodesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, effectiveScopes]);
  const [deployFolderId, setDeployFolderId] = useState<string | null>(null);
  const [loadedFolderOptions, setFolderOptions] = useState<ComboboxOption[]>([]);
  const [loadedFolderOptionsReady, setFolderOptionsLoaded] = useState(false);
  // From an app the folder field shows only the root; the environment's folder is sent instead.
  const folderOptions = appContext ? ROOT_FOLDER_OPTIONS : loadedFolderOptions;
  const folderOptionsLoaded = appContext ? true : loadedFolderOptionsReady;
  const destinationFolderId = appContext
    ? appPlacementFolderId(environment, "containers")
    : deployFolderId;

  const [deployNodeId, setDeployNodeId] = useState<string>("");
  const [deployImage, setDeployImage] = useState("");
  const [deployRegistryId, setDeployRegistryId] = useState("");
  const [deployName, setDeployName] = useState("");
  const [deployRestart, setDeployRestart] = useState<DockerRestartPolicy>("no");
  const [deploying, setDeploying] = useState(false);
  const [deployMode, setDeployMode] = useState<DockerDeployMode>("container");
  const [sourceMode, setSourceMode] = useState<DockerDeploySourceMode>("image");
  const [sourceConnectorId, setSourceConnectorId] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceBranch, setSourceBranch] = useState("main");
  const [sourceDockerfilePath, setSourceDockerfilePath] = useState("Dockerfile");
  const [sourceContextPath, setSourceContextPath] = useState(".");
  const [sourceAutoBuild, setSourceAutoBuild] = useState(true);
  const [sourceAutoDeploy, setSourceAutoDeploy] = useState(true);
  const [routeHostPort, setRouteHostPort] = useState("8080");
  const [routeContainerPort, setRouteContainerPort] = useState("80");
  const [healthPath, setHealthPath] = useState("/");
  const [drainSeconds, setDrainSeconds] = useState("30");
  const [deployRuntimeProfile, setDeployRuntimeProfile] = useState<DockerRuntimeProfile>("default");
  const [secureRuntimeSetupOpen, setSecureRuntimeSetupOpen] = useState(false);
  const storeDockerNodes = useDockerStore((state) => state.dockerNodes);
  const allNodes = useMemo(() => {
    return [
      ...new Map(
        [...dockerNodes, ...creationNodes, ...storeDockerNodes].map((node) => [node.id, node])
      ).values(),
    ];
  }, [dockerNodes, storeDockerNodes, creationNodes]);
  const permittedNodes = useMemo(
    () =>
      allNodes.filter(
        (node) =>
          !isNodeIncompatible(node) &&
          (canCreateInFolder(
            effectiveScopes,
            "docker:containers:create",
            destinationFolderId,
            node.id
          ) ||
            effectiveScopes.some((scope) => scope.startsWith("docker:containers:create:folder/")))
      ),
    [allNodes, effectiveScopes, destinationFolderId]
  );
  // From an app: only the Docker nodes the environment allows.
  const availableNodes = useMemo(
    () => (appContext ? allowedAppNodes(environment, permittedNodes) : permittedNodes),
    [appContext, environment, permittedNodes]
  );
  const appNodeLocked = !!appContext && availableNodes.length === 1;
  const noAllowedNode =
    !!appContext &&
    !!environment &&
    creationNodesLoaded &&
    allowedAppNodes(
      environment,
      allNodes.filter((node) => !isNodeIncompatible(node))
    ).length === 0;
  useEffect(() => {
    if (!open || appContext) {
      setFolderOptionsLoaded(false);
      return;
    }
    let cancelled = false;
    void api
      .listDockerFolders("container")
      .then((tree) => {
        if (cancelled) return;
        const allowed = flattenFolderTree(tree, "docker").filter((folder) =>
          canCreateInFolder(effectiveScopes, "docker:containers:create", folder.id, deployNodeId)
        );
        setFolderOptions([
          ...(canCreateInFolder(effectiveScopes, "docker:containers:create", null, deployNodeId)
            ? [{ value: "__root__", label: "No folder" }]
            : []),
          ...allowed.map((folder) => ({ value: folder.id, label: folder.label })),
        ]);
      })
      .catch(() => {
        if (!cancelled) setFolderOptions([]);
      })
      .finally(() => {
        if (!cancelled) setFolderOptionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appContext, effectiveScopes, deployNodeId]);
  const {
    checkingSourceAdmission,
    initialLoading: deployDataLoading,
    deployLocalImages,
    deployPullableImages,
    registries,
    sourceAdmission,
    sourceConnectorOptions,
    sourceLoadErrors,
    sourceRepositories,
    sourceRepositoriesLoading,
    sourceRepositoriesHint,
    onSourceRepositorySearch,
  } = useDockerDeployData({
    allNodes,
    deployNodeId,
    hasScope,
    open,
    sourceConnectorId,
    sourceMode,
  });
  const selectedDeployNode = useMemo(
    () => allNodes.find((node) => node.id === deployNodeId),
    [allNodes, deployNodeId]
  );
  const secureRuntimeStatus = selectedDeployNode?.capabilities?.dockerRuntimeStatus as
    | DockerRuntimeStatus
    | undefined;
  const secureRuntimeAvailable = secureRuntimeStatus?.state === "healthy";
  const secureRuntimeCanBeConfigured = Boolean(
    selectedDeployNode &&
      !secureRuntimeAvailable &&
      (secureRuntimeStatus?.remoteInstallable ||
        secureRuntimeStatus?.state === "installable" ||
        secureRuntimeStatus?.state === "installing" ||
        secureRuntimeStatus?.state === "failed")
  );
  const initialNodeLocked = !!(
    nodeId && allNodes.find((candidate) => candidate.id === nodeId)?.serviceCreationLocked
  );
  const availableRegistries = useMemo(
    () =>
      registries.filter(
        (registry) => registry.scope === "global" || registry.nodeId === deployNodeId
      ),
    [deployNodeId, registries]
  );
  const nodeOptions = useMemo<ComboboxOption[]>(
    () =>
      availableNodes.map((node) => ({
        value: node.id,
        label: node.displayName || node.hostname,
        keywords: [node.hostname, node.slug].filter(Boolean).join(" "),
        disabled: node.serviceCreationLocked,
      })),
    [availableNodes]
  );
  const registryOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "__default__", label: "Docker Hub" },
      ...availableRegistries.map((registry) => ({
        value: registry.id,
        label: registry.name,
        keywords: [registry.url, registry.scope === "node" ? "this node" : "global"]
          .filter(Boolean)
          .join(" "),
      })),
    ],
    [availableRegistries]
  );
  const imageOptions = useMemo<ComboboxOption[]>(
    () => [
      ...deployLocalImages.map((image) => ({
        value: image,
        label: image,
        keywords: "local on this node",
      })),
      ...deployPullableImages.map((image) => ({
        value: image,
        label: image,
        keywords: "remote available to pull",
      })),
    ],
    [deployLocalImages, deployPullableImages]
  );
  const sourceRepositoryOptions = useMemo<ComboboxOption[]>(
    () =>
      sourceRepositories.map((repository) => ({
        value: repository.projectId,
        label: repository.fullPath,
        keywords: [repository.name, repository.webUrl].filter(Boolean).join(" "),
      })),
    [sourceRepositories]
  );

  const resetDeployForm = useCallback(() => {
    setDeployNodeId(initialNodeLocked ? "" : nodeId || "");
    setDeployImage("");
    setDeployRegistryId("");
    setDeployName("");
    setDeployFolderId(null);
    setDeployRestart("no");
    setDeployMode("container");
    setSourceMode("image");
    setSourceConnectorId("");
    setSourceProjectId("");
    setSourceBranch("main");
    setSourceDockerfilePath("Dockerfile");
    setSourceContextPath(".");
    setSourceAutoBuild(true);
    setSourceAutoDeploy(true);
    setRouteHostPort("8080");
    setRouteContainerPort("80");
    setHealthPath("/");
    setDrainSeconds("30");
    setDeployRuntimeProfile("default");
  }, [initialNodeLocked, nodeId]);

  useEffect(() => {
    if (open) resetDeployForm();
  }, [open, resetDeployForm]);

  useEffect(() => {
    if (!open || !deployNodeId) return;
    const selectedNode = availableNodes.find((node) => node.id === deployNodeId);
    if (!selectedNode || selectedNode.serviceCreationLocked) setDeployNodeId("");
  }, [availableNodes, deployNodeId, open]);

  // From an app with exactly one allowed Docker node, that node is the destination.
  useEffect(() => {
    if (!open || !appNodeLocked) return;
    const only = availableNodes[0]!;
    if (only.id !== deployNodeId && !only.serviceCreationLocked) {
      setDeployNodeId(only.id);
      setDeployImage("");
      setDeployRegistryId("");
      setDeployRuntimeProfile("default");
    }
  }, [appNodeLocked, availableNodes, deployNodeId, open]);

  // A folder-only creator is never offered the root: preselect their only folder, for image and Git
  // source deployments alike, and drop a choice the selected node no longer allows.
  useEffect(() => {
    if (!open || appContext || !folderOptionsLoaded) return;
    const folders = folderOptions.filter((option) => option.value !== "__root__");
    const rootAllowed = folderOptions.some((option) => option.value === "__root__");
    if (deployFolderId && !folders.some((option) => option.value === deployFolderId)) {
      setDeployFolderId(!rootAllowed && folders.length === 1 ? folders[0]!.value : null);
    } else if (!deployFolderId && !rootAllowed && folders.length === 1) {
      setDeployFolderId(folders[0]!.value);
    }
  }, [appContext, deployFolderId, folderOptions, folderOptionsLoaded, open]);

  const closeDeploy = () => {
    onOpenChange(false);
    setSecureRuntimeSetupOpen(false);
  };

  const handleDeploy = async () => {
    if (deploying || !deployNodeId || noAllowedNode) return;
    if (
      !canCreateInFolder(
        effectiveScopes,
        "docker:containers:create",
        destinationFolderId,
        deployNodeId
      )
    ) {
      toast.error("Select an authorized destination folder");
      return;
    }
    if (sourceMode === "image" && !deployImage.trim()) return;
    if (
      sourceMode === "repository" &&
      (!sourceConnectorId ||
        !sourceProjectId ||
        !sourceBranch.trim() ||
        !sourceDockerfilePath.trim() ||
        !sourceContextPath.trim() ||
        !deployName.trim())
    )
      return;
    if (allNodes.find((n) => n.id === deployNodeId)?.serviceCreationLocked) {
      toast.error("Node is locked for new service creation");
      return;
    }
    if (deployMode === "deployment" && !deployName.trim()) return;
    if (
      sourceMode === "repository" &&
      !requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")
    )
      return;
    if (
      deployMode === "deployment" &&
      !requireLicenseFeature("blue-green", "Blue/green deployments")
    )
      return;
    if (
      deployRuntimeProfile === "secure" &&
      !requireLicenseFeature("secure-runtime", "Secure Runtime")
    )
      return;
    setDeploying(true);
    try {
      await executeDockerDeploy({
        availableNodes,
        closeDeploy,
        deployImage,
        deployLocalImages,
        deployMode,
        deployName,
        deployNodeId,
        deployFolderId: destinationFolderId,
        deployRegistryId,
        deployRestart,
        deployRuntimeProfile,
        drainSeconds,
        healthPath,
        navigate: appContext ? noNavigate : navigate,
        onDeployed: (id) => {
          rememberAppCreation(appContext, environment);
          onDeployed?.(id);
        },
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
      });
    } catch (err) {
      if (
        !handleLicenseApiError(
          err,
          sourceMode === "repository" ? "Git push-to-deploy" : "Container deployment"
        )
      ) {
        toastApiError(err, "Failed to deploy");
      }
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={closeDeploy}>
      <DialogContent
        className="sm:max-w-lg"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            resetDeployForm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Deploy</DialogTitle>
          <DialogDescription>Create a container or a blue/green deployment.</DialogDescription>
        </DialogHeader>

        {appContext && (
          <AppEnvironmentFields
            context={appContext}
            environmentId={appEnvironment.environmentId}
            onEnvironmentChange={appEnvironment.setEnvironmentId}
            disabled={deploying}
          />
        )}

        {noAllowedNode && appContext && environment ? (
          <NoAllowedNodeNotice
            context={appContext}
            environment={environment}
            nodeKind="Docker"
            resourceKind="Containers"
            onNavigate={closeDeploy}
          />
        ) : (
          <DockerDeployFormFields
            loading={open && (!creationNodesLoaded || !folderOptionsLoaded || deployDataLoading)}
            availableRegistries={availableRegistries}
            checkingSourceAdmission={checkingSourceAdmission}
            deployImage={deployImage}
            deployLocalImages={deployLocalImages}
            deployMode={deployMode}
            deployName={deployName}
            deployNodeId={deployNodeId}
            deployFolderId={deployFolderId}
            folderOptions={folderOptions}
            onDeployFolderIdChange={setDeployFolderId}
            deployRegistryId={deployRegistryId}
            deployRestart={deployRestart}
            deployRuntimeProfile={deployRuntimeProfile}
            drainSeconds={drainSeconds}
            healthPath={healthPath}
            imageOptions={imageOptions}
            nodeOptions={nodeOptions}
            nodeLocked={appNodeLocked}
            nodeHint={
              appContext && environment && availableNodes.length > 0
                ? allowedNodesHint(environment, availableNodes.length, "Docker")
                : null
            }
            registryOptions={registryOptions}
            routeContainerPort={routeContainerPort}
            routeHostPort={routeHostPort}
            secureRuntimeAvailable={secureRuntimeAvailable}
            secureRuntimeCanBeConfigured={secureRuntimeCanBeConfigured}
            sourceAdmission={sourceAdmission}
            sourceAutoBuild={sourceAutoBuild}
            sourceAutoDeploy={sourceAutoDeploy}
            sourceBranch={sourceBranch}
            sourceConnectorId={sourceConnectorId}
            sourceConnectorOptions={sourceConnectorOptions}
            sourceContextPath={sourceContextPath}
            sourceDockerfilePath={sourceDockerfilePath}
            sourceLoadErrors={sourceLoadErrors}
            sourceRepositoriesLoading={sourceRepositoriesLoading}
            sourceRepositoriesHint={sourceRepositoriesHint}
            onSourceRepositorySearch={onSourceRepositorySearch}
            sourceMode={sourceMode}
            sourceProjectId={sourceProjectId}
            sourceRepositories={sourceRepositories}
            sourceRepositoryOptions={sourceRepositoryOptions}
            onDeployImageChange={setDeployImage}
            onDeployModeChange={setDeployMode}
            onDeployNameChange={setDeployName}
            onDeployNodeIdChange={(value) => {
              setDeployNodeId(value);
              setDeployImage("");
              setDeployRegistryId("");
              setDeployRuntimeProfile("default");
            }}
            onDeployRegistryIdChange={setDeployRegistryId}
            onDeployRestartChange={setDeployRestart}
            onDeployRuntimeProfileChange={setDeployRuntimeProfile}
            onDrainSecondsChange={setDrainSeconds}
            onHealthPathChange={setHealthPath}
            onRouteContainerPortChange={setRouteContainerPort}
            onRouteHostPortChange={setRouteHostPort}
            onSecureRuntimeSetupOpen={() => setSecureRuntimeSetupOpen(true)}
            onSourceAutoBuildChange={setSourceAutoBuild}
            onSourceAutoDeployChange={setSourceAutoDeploy}
            onSourceBranchChange={setSourceBranch}
            onSourceConnectorIdChange={(value) => {
              setSourceConnectorId(value);
              setSourceProjectId("");
            }}
            onSourceContextPathChange={setSourceContextPath}
            onSourceDockerfilePathChange={setSourceDockerfilePath}
            onSourceModeChange={setSourceMode}
            onSourceProjectIdChange={setSourceProjectId}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={closeDeploy}>
            Cancel
          </Button>
          <Button
            onClick={handleDeploy}
            pending={deploying}
            disabled={
              !deployNodeId ||
              noAllowedNode ||
              !canCreateInFolder(
                effectiveScopes,
                "docker:containers:create",
                destinationFolderId,
                deployNodeId
              ) ||
              (sourceMode === "image"
                ? !deployImage.trim()
                : !sourceConnectorId ||
                  !sourceProjectId ||
                  !sourceBranch.trim() ||
                  !sourceDockerfilePath.trim() ||
                  !sourceContextPath.trim() ||
                  !deployName.trim()) ||
              (deployMode === "deployment" &&
                (!deployName.trim() || !Number(routeHostPort) || !Number(routeContainerPort)))
            }
          >
            {sourceMode === "repository" ? "Create and build" : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <SecureRuntimeSetupDialog
        open={secureRuntimeSetupOpen}
        onOpenChange={setSecureRuntimeSetupOpen}
        onOpenNodeSettings={() => {
          const nodeSlug = selectedDeployNode?.slug;
          if (!nodeSlug) return;
          closeDeploy();
          navigate(nodeRoute(nodeSlug, "details"));
        }}
      />
    </Dialog>
  );
}
