import { AnimatePresence, motion } from "framer-motion";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_DOCKER_RUNTIME_DESCRIPTION,
  getSecureDockerRuntimeDescription,
} from "@/lib/docker-runtime-profile";
import { requireLicenseFeature, usePlanIncludes } from "@/stores/license-paywall";
import type {
  DockerBuildAdmissionStatus,
  DockerBuildSourceRepository,
  DockerRegistry,
  DockerRuntimeProfile,
} from "@/types";
import { ImageSourceFields } from "./ImageSourceFields";
import { RepositorySourceFields } from "./RepositorySourceFields";
import type { DockerDeployMode, DockerDeploySourceMode, DockerRestartPolicy } from "./types";
import type { SourcePickerErrors } from "./useDockerSourceRepositories";

const FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

interface DockerDeployFormFieldsProps {
  /** Option lists the form opens with are still loading; the dialog waits for them. */
  loading?: boolean;
  availableRegistries: DockerRegistry[];
  checkingSourceAdmission: boolean;
  deployImage: string;
  deployLocalImages: string[];
  deployMode: DockerDeployMode;
  deployName: string;
  deployNodeId: string;
  deployFolderId?: string | null;
  folderOptions?: ComboboxOption[];
  onDeployFolderIdChange?: (value: string | null) => void;
  deployRegistryId: string;
  deployRestart: DockerRestartPolicy;
  deployRuntimeProfile: DockerRuntimeProfile;
  drainSeconds: string;
  healthPath: string;
  imageOptions: ComboboxOption[];
  nodeOptions: ComboboxOption[];
  /** Opened from an app with one allowed node: the node is fixed. */
  nodeLocked?: boolean;
  /** Shown under the node field (which nodes the app environment allows). */
  nodeHint?: string | null;
  registryOptions: ComboboxOption[];
  routeContainerPort: string;
  routeHostPort: string;
  secureRuntimeAvailable: boolean;
  secureRuntimeCanBeConfigured: boolean;
  sourceAdmission: DockerBuildAdmissionStatus | null;
  sourceAutoBuild: boolean;
  sourceAutoDeploy: boolean;
  sourceBranch: string;
  sourceConnectorId: string;
  sourceConnectorOptions: ComboboxOption[];
  sourceContextPath: string;
  sourceDockerfilePath: string;
  sourceLoadErrors?: SourcePickerErrors;
  sourceRepositoriesLoading?: boolean;
  sourceRepositoriesHint?: string | null;
  onSourceRepositorySearch?: (query: string) => void;
  sourceMode: DockerDeploySourceMode;
  sourceProjectId: string;
  sourceRepositories: DockerBuildSourceRepository[];
  sourceRepositoryOptions: ComboboxOption[];
  onDeployImageChange: (value: string) => void;
  onDeployModeChange: (value: DockerDeployMode) => void;
  onDeployNameChange: (value: string) => void;
  onDeployNodeIdChange: (value: string) => void;
  onDeployRegistryIdChange: (value: string) => void;
  onDeployRestartChange: (value: DockerRestartPolicy) => void;
  onDeployRuntimeProfileChange: (value: DockerRuntimeProfile) => void;
  onDrainSecondsChange: (value: string) => void;
  onHealthPathChange: (value: string) => void;
  onRouteContainerPortChange: (value: string) => void;
  onRouteHostPortChange: (value: string) => void;
  onSecureRuntimeSetupOpen: () => void;
  onSourceAutoBuildChange: (value: boolean) => void;
  onSourceAutoDeployChange: (value: boolean) => void;
  onSourceBranchChange: (value: string) => void;
  onSourceConnectorIdChange: (value: string) => void;
  onSourceContextPathChange: (value: string) => void;
  onSourceDockerfilePathChange: (value: string) => void;
  onSourceModeChange: (value: DockerDeploySourceMode) => void;
  onSourceProjectIdChange: (value: string) => void;
}

export function DockerDeployFormFields(props: DockerDeployFormFieldsProps) {
  const {
    availableRegistries,
    checkingSourceAdmission,
    deployImage,
    deployLocalImages,
    deployMode,
    deployName,
    deployNodeId,
    deployRegistryId,
    deployRestart,
    deployRuntimeProfile,
    drainSeconds,
    healthPath,
    imageOptions,
    nodeOptions,
    registryOptions,
    routeContainerPort,
    routeHostPort,
    secureRuntimeAvailable,
    secureRuntimeCanBeConfigured,
    sourceAdmission,
    sourceAutoBuild,
    sourceAutoDeploy,
    sourceBranch,
    sourceConnectorId,
    sourceConnectorOptions,
    sourceContextPath,
    sourceDockerfilePath,
    sourceLoadErrors,
    sourceMode,
    sourceProjectId,
    sourceRepositories,
    sourceRepositoryOptions,
  } = props;
  useContentLoading(Boolean(props.loading));
  // Options the plan lacks are hidden; a field left with one choice is hidden too.
  const repositorySourceAvailable = usePlanIncludes("git-push-to-deploy");
  const blueGreenAvailable = usePlanIncludes("blue-green");
  const secureRuntimeLicensed = usePlanIncludes("secure-runtime");

  return (
    <AnimatedHeight>
      <div className="space-y-4">
        {repositorySourceAvailable && (
          <Tabs
            value={sourceMode}
            onValueChange={(value) => props.onSourceModeChange(value as DockerDeploySourceMode)}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="repository">Repository</TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {blueGreenAvailable && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Resource type</label>
            <Select
              value={deployMode}
              onValueChange={(value) => {
                if (
                  value === "deployment" &&
                  !requireLicenseFeature("blue-green", "Blue/green deployments")
                )
                  return;
                props.onDeployModeChange(value as DockerDeployMode);
              }}
            >
              <SelectTrigger aria-label="Resource type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="container"
                  description="Run a single container from an image or repository."
                >
                  Container
                </SelectItem>
                <SelectItem
                  value="deployment"
                  description="Deploy revisions with health checks and controlled traffic switching."
                >
                  Blue/green
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <AnimatePresence initial={false} mode="popLayout">
          <motion.div key={`${sourceMode}:${deployMode}`} className="space-y-4" {...FORM_ANIMATION}>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Node <span className="text-destructive">*</span>
              </label>
              <Combobox
                value={deployNodeId}
                options={nodeOptions}
                onValueChange={props.onDeployNodeIdChange}
                placeholder="Select a node"
                searchPlaceholder="Search nodes..."
                emptyMessage="No nodes found."
                disabled={props.nodeLocked}
                ariaLabel="Node"
              />
              {props.nodeHint && <p className="text-xs text-muted-foreground">{props.nodeHint}</p>}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Folder</label>
              <Combobox
                value={
                  props.deployFolderId ??
                  (props.folderOptions?.some((option) => option.value === "__root__")
                    ? "__root__"
                    : "")
                }
                options={props.folderOptions ?? []}
                onValueChange={(value) =>
                  props.onDeployFolderIdChange?.(value === "__root__" ? null : value)
                }
                placeholder="Select a destination folder"
                searchPlaceholder="Search folders..."
                emptyMessage="No authorized folders found."
              />
            </div>

            {sourceMode === "repository" && deployNodeId && checkingSourceAdmission && (
              <p className="text-sm text-muted-foreground">Checking build capacity…</p>
            )}
            {sourceMode === "repository" && deployNodeId && sourceAdmission?.ready === false && (
              <p className="text-sm text-destructive" role="alert">
                {sourceAdmission.message}
              </p>
            )}

            {secureRuntimeLicensed && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Runtime</label>
                <Select
                  value={deployRuntimeProfile}
                  onValueChange={(value) => {
                    if (value === "secure") {
                      if (!secureRuntimeAvailable) {
                        if (secureRuntimeCanBeConfigured) props.onSecureRuntimeSetupOpen();
                        return;
                      }
                      if (!requireLicenseFeature("secure-runtime", "Secure Runtime")) return;
                    }
                    props.onDeployRuntimeProfileChange(value as DockerRuntimeProfile);
                  }}
                  disabled={!deployNodeId}
                >
                  <SelectTrigger aria-label="Runtime">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default" description={DEFAULT_DOCKER_RUNTIME_DESCRIPTION}>
                      Default
                    </SelectItem>
                    <SelectItem
                      value="secure"
                      disabled={!secureRuntimeAvailable && !secureRuntimeCanBeConfigured}
                      description={getSecureDockerRuntimeDescription(secureRuntimeAvailable)}
                    >
                      Secure
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {sourceMode === "repository" ? (
              <RepositorySourceFields
                loadErrors={sourceLoadErrors}
                repositoriesLoading={props.sourceRepositoriesLoading}
                repositoriesHint={props.sourceRepositoriesHint}
                onRepositorySearch={props.onSourceRepositorySearch}
                connectorId={sourceConnectorId}
                connectorOptions={sourceConnectorOptions}
                repositories={sourceRepositories}
                repositoryOptions={sourceRepositoryOptions}
                projectId={sourceProjectId}
                branch={sourceBranch}
                dockerfilePath={sourceDockerfilePath}
                contextPath={sourceContextPath}
                autoBuild={sourceAutoBuild}
                autoDeploy={sourceAutoDeploy}
                onConnectorChange={props.onSourceConnectorIdChange}
                onProjectChange={props.onSourceProjectIdChange}
                onBranchChange={props.onSourceBranchChange}
                onDockerfilePathChange={props.onSourceDockerfilePathChange}
                onContextPathChange={props.onSourceContextPathChange}
                onAutoBuildChange={props.onSourceAutoBuildChange}
                onAutoDeployChange={props.onSourceAutoDeployChange}
              />
            ) : (
              <ImageSourceFields
                availableRegistries={availableRegistries}
                deployImage={deployImage}
                deployLocalImages={deployLocalImages}
                deployNodeId={deployNodeId}
                deployRegistryId={deployRegistryId}
                imageOptions={imageOptions}
                registryOptions={registryOptions}
                onImageChange={props.onDeployImageChange}
                onRegistryChange={props.onDeployRegistryIdChange}
              />
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {deployMode === "deployment" ? "Deployment Name" : "Container Name"}{" "}
                  {deployMode === "container" && sourceMode === "image" && (
                    <span className="text-muted-foreground font-normal">(optional)</span>
                  )}
                </label>
                <Input
                  value={deployName}
                  onChange={(event) => props.onDeployNameChange(event.target.value)}
                  placeholder={deployMode === "deployment" ? "my-app" : "my-container"}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Restart Policy</label>
                <Select
                  value={deployRestart}
                  onValueChange={(value) =>
                    props.onDeployRestartChange(value as DockerRestartPolicy)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">No</SelectItem>
                    <SelectItem value="always">Always</SelectItem>
                    <SelectItem value="unless-stopped">Unless Stopped</SelectItem>
                    <SelectItem value="on-failure">On Failure</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {deployMode === "deployment" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Host Port</label>
                    <Input
                      inputMode="numeric"
                      value={routeHostPort}
                      onChange={(event) => props.onRouteHostPortChange(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Container Port</label>
                    <Input
                      inputMode="numeric"
                      value={routeContainerPort}
                      onChange={(event) => props.onRouteContainerPortChange(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Health Path</label>
                    <Input
                      value={healthPath}
                      onChange={(event) => props.onHealthPathChange(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Drain Seconds</label>
                    <Input
                      inputMode="numeric"
                      value={drainSeconds}
                      onChange={(event) => props.onDrainSecondsChange(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </AnimatedHeight>
  );
}
