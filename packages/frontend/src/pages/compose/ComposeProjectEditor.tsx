import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { flattenFolderTree } from "@/components/common/scope-list-helpers";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastApiError } from "@/lib/api-error-toast";
import { createClientUuid } from "@/lib/client-id";
import { canAdoptComposeProject, hasComposeProjectScope } from "@/lib/compose-access";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { dockerComposeProjectRoute } from "@/lib/resource-routes";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type { DockerComposeProject, Node } from "@/types";
import { RepositorySourceFields } from "../docker-deploy/RepositorySourceFields";
import { useDockerSourceRepositories } from "../docker-deploy/useDockerSourceRepositories";
import { composeRevisionResumeSignature } from "./compose-adoption-resume";

const DEFAULT_YAML = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

const SOURCE_MODE_ANIMATION = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15, ease: [0.25, 0.1, 0.25, 1] as const },
};

function nodeSupportsCompose(node: Node | undefined) {
  const capabilities = node?.capabilities as Record<string, unknown> | undefined;
  const advertised = Array.isArray(capabilities?.capabilities) ? capabilities.capabilities : [];
  return capabilities?.dockerComposeV1 === true || advertised.includes("docker_compose_v1");
}

function parseVariables(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Variables must be a JSON object");
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
}

export function ComposeProjectEditor({
  onClose,
  defaultNodeId,
  projectIdOverride,
  adoptionOverride,
  compactRevision,
  appContext,
  onCreated,
}: {
  onClose?: () => void;
  defaultNodeId?: string;
  projectIdOverride?: string;
  adoptionOverride?: boolean;
  compactRevision?: boolean;
  /**
   * A new project opened from an app: locked App field, environment select, only the
   * environment's allowed Docker nodes, created in the environment's placement folder.
   */
  appContext?: AppCreateContext;
  /** A new project was created (from an app the editor then closes instead of navigating). */
  onCreated?: () => void;
} = {}) {
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>();
  const projectId = projectIdOverride ?? routeProjectId;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasScopedAccess, user } = useAuthStore();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [project, setProject] = useState<DockerComposeProject | null>(null);
  const [nodeId, setNodeId] = useState(defaultNodeId ?? "");
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const fromApp = !!appContext && !projectIdOverride && !routeProjectId;
  const appEnvironment = useAppEnvironmentChoice(fromApp ? appContext : null);
  const environment = appEnvironment.environment;
  // From an app the folder field shows only the root; the environment's folder is sent instead.
  const destinationFolderId = fromApp ? appPlacementFolderId(environment, "compose") : folderId;
  const [destinationFolders, setDestinationFolders] = useState<
    Array<{ id: string; label: string }>
  >([]);
  const [yaml, setYaml] = useState(DEFAULT_YAML);
  const [variablesText, setVariablesText] = useState("{}");
  const [sourceMode, setSourceMode] = useState<"yaml" | "repository">("yaml");
  // A repository source needs Git push-to-deploy; without it only Compose YAML is offered.
  const planIncludesGitDeploy = usePlanIncludes("git-push-to-deploy");
  const [sourceConnectorId, setSourceConnectorId] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceBranch, setSourceBranch] = useState("main");
  const [sourceComposeFilePath, setSourceComposeFilePath] = useState("compose.yaml");
  const [sourceAutoBuild, setSourceAutoBuild] = useState(true);
  const [sourceAutoDeploy, setSourceAutoDeploy] = useState(true);
  const [adoptionResume, setAdoptionResume] = useState<{
    revisionId: string;
    idempotencyKey: string;
    inputSignature: string;
  } | null>(null);
  const [loading, setLoading] = useState(!!projectId);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  // Existing projects keep their folder; only a new project lists destination folders.
  const [foldersLoaded, setFoldersLoaded] = useState(!!projectId);
  useContentLoading(loading || !nodesLoaded || !foldersLoaded);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const adoption =
    adoptionOverride ||
    project?.managementState === "external" ||
    searchParams.get("adopt") === "1";
  const editing = !!projectId && !adoption;
  const canSubmit = projectId
    ? adoption
      ? canAdoptComposeProject(user?.scopes ?? [], nodeId, projectId)
      : hasComposeProjectScope(user?.scopes ?? [], "docker:compose:manage", nodeId, projectId)
    : !!nodeId &&
      canCreateInFolder(user?.scopes ?? [], "docker:compose:create", destinationFolderId, nodeId);
  useEffect(() => {
    if (projectId || fromApp) {
      if (fromApp) setFoldersLoaded(true);
      return;
    }
    let cancelled = false;
    void api
      .listDockerFolders("compose")
      .then((tree) => {
        if (!cancelled)
          setDestinationFolders(
            flattenFolderTree(tree, "docker-compose").filter((folder) =>
              canCreateInFolder(user?.scopes ?? [], "docker:compose:create", folder.id, nodeId)
            )
          );
      })
      .catch(() => {
        if (!cancelled) setDestinationFolders([]);
      })
      .finally(() => {
        if (!cancelled) setFoldersLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fromApp, projectId, nodeId, user?.scopes]);
  // A new project for a folder-only creator: the root is never offered, so preselect their only folder
  // (from YAML or a Git source alike) and drop a folder the selected node no longer allows.
  useEffect(() => {
    if (projectId || fromApp || !foldersLoaded) return;
    const rootAllowed = canCreateInFolder(
      user?.scopes ?? [],
      "docker:compose:create",
      null,
      nodeId || undefined
    );
    if (folderId && !destinationFolders.some((folder) => folder.id === folderId)) {
      setFolderId(
        !rootAllowed && destinationFolders.length === 1 ? destinationFolders[0]!.id : null
      );
    } else if (!folderId && !rootAllowed && destinationFolders.length === 1) {
      setFolderId(destinationFolders[0]!.id);
    }
  }, [destinationFolders, folderId, foldersLoaded, fromApp, nodeId, projectId, user?.scopes]);
  const repositoryCreation = !projectId && planIncludesGitDeploy && sourceMode === "repository";
  const {
    connectorOptions: sourceConnectorOptions,
    repositories: sourceRepositories,
    loadErrors: sourceLoadErrors,
    repositoriesLoading: sourceRepositoriesLoading,
    repositoriesHint: sourceRepositoriesHint,
    onRepositorySearch: onSourceRepositorySearch,
  } = useDockerSourceRepositories(repositoryCreation, sourceConnectorId);

  useEffect(() => {
    loadVisibleDockerNodes(
      user?.scopes ?? [],
      projectId ? ["docker:compose:view"] : ["docker:compose:view", "docker:compose:create"],
      hasScopedAccess("nodes:details")
    )
      .then((available) => {
        setNodes(available);
        if (!projectId) {
          const composeNodes = available.filter((node) => nodeSupportsCompose(node));
          const currentNodeIsAvailable = composeNodes.some((node) => node.id === nodeId);
          if (!currentNodeIsAvailable) {
            setNodeId(composeNodes.length === 1 ? composeNodes[0].id : "");
          }
        } else if (!nodeId && available.length === 1) {
          setNodeId(available[0].id);
        }
      })
      .catch(() => toast.error("Failed to load Docker nodes"))
      .finally(() => setNodesLoaded(true));
  }, [hasScopedAccess, nodeId, projectId, user?.scopes]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    api
      .listDockerComposeProjects()
      .then((projects) => projects.find((candidate) => candidate.id === projectId) ?? null)
      .then(async (summary) =>
        summary ? api.getDockerComposeProject(summary.nodeId, summary.id) : null
      )
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) throw new Error("Compose project not found");
        setProject(loaded);
        setNodeId(loaded.nodeId);
        setName(loaded.name);
        if (loaded.activeRevision) {
          setYaml(loaded.activeRevision.sourceYaml);
          setVariablesText(JSON.stringify(loaded.activeRevision.variables ?? {}, null, 2));
        }
      })
      .catch((error) => toastApiError(error, "Failed to load Compose project"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selectedNode = nodes.find((node) => node.id === nodeId);
  const supportsCompose = nodeSupportsCompose(selectedNode);
  const composeNodes = useMemo(
    () => (projectId ? nodes : nodes.filter((node) => nodeSupportsCompose(node))),
    [nodes, projectId]
  );
  // From an app: only the Docker nodes the environment allows.
  const selectableNodes = useMemo(
    () => (fromApp ? allowedAppNodes(environment, composeNodes) : composeNodes),
    [composeNodes, environment, fromApp]
  );
  const appNodeLocked = fromApp && selectableNodes.length === 1;
  const noAllowedNode = fromApp && !!environment && nodesLoaded && selectableNodes.length === 0;
  useEffect(() => {
    if (!fromApp || !nodesLoaded) return;
    if (selectableNodes.length === 1) {
      if (nodeId !== selectableNodes[0]!.id) setNodeId(selectableNodes[0]!.id);
    } else if (nodeId && !selectableNodes.some((node) => node.id === nodeId)) {
      setNodeId("");
    }
  }, [fromApp, nodeId, nodesLoaded, selectableNodes]);

  const input = useCallback(() => {
    const variables = parseVariables(variablesText);
    return {
      projectName: name.trim(),
      yaml,
      variables,
      secretKeys: project?.activeRevision?.secretKeys ?? [],
      secretValues: {},
    };
  }, [name, project?.activeRevision?.secretKeys, variablesText, yaml]);

  const validate = useCallback(
    async (notify = true) => {
      if (!nodeId || !name.trim() || !yaml.trim())
        throw new Error("Project name, node, and YAML are required");
      const values = input();
      setValidating(true);
      try {
        const result = await api.validateDockerComposeProject(nodeId, values);
        if (notify) {
          if (result.valid) {
            toast.success("Configuration is valid");
          } else {
            const firstDiagnostic = result.diagnostics[0];
            toast.error("Configuration is invalid", {
              description: firstDiagnostic
                ? `${firstDiagnostic.path ? `${firstDiagnostic.path}: ` : ""}${firstDiagnostic.message}${
                    result.diagnostics.length > 1 ? ` · ${result.diagnostics.length - 1} more` : ""
                  }`
                : undefined,
            });
          }
        }
        return result;
      } finally {
        setValidating(false);
      }
    },
    [input, name, nodeId, yaml]
  );

  const save = async () => {
    if (!requireLicenseFeature("compose-applications", "Compose projects")) return;
    if (repositoryCreation && !requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")) {
      return;
    }
    if (!canSubmit) {
      toast.error(
        adoption
          ? "Compose create and manage access are required to adopt this project"
          : "You do not have permission to apply this Compose configuration"
      );
      return;
    }
    if (!supportsCompose) {
      toast.error("Select a Docker node with Compose runtime available");
      return;
    }
    setSaving(true);
    try {
      if (repositoryCreation) {
        if (!name.trim() || !sourceConnectorId || !sourceProjectId || !sourceBranch.trim()) {
          throw new Error("Project name, repository, and branch are required");
        }
        if (!sourceComposeFilePath.trim()) throw new Error("Compose file path is required");
        const created = await api.createDockerComposeSourceProject(nodeId, {
          folderId: destinationFolderId,
          projectName: name.trim(),
          source: {
            connectorId: sourceConnectorId,
            projectId: sourceProjectId,
            branch: sourceBranch.trim(),
            dockerfilePath: "Dockerfile",
            contextPath: ".",
            composeFilePath: sourceComposeFilePath.trim(),
            composeVariables: {},
            composeSecretKeys: [],
            autoBuild: sourceAutoBuild,
            autoDeploy: sourceAutoDeploy,
            buildArgs: {},
            buildSecretNames: [],
            policy: { vulnerabilityThreshold: "critical" },
          },
        });
        toast.success(created.build ? "Compose created and build queued" : "Compose created");
        if (created.firstBuildWaiting) toast.info(created.firstBuildWaiting.message);
        if (created.initialBuildError)
          toast.warning(
            `${created.initialBuildError.message} You can adjust Source settings and retry Build now.`
          );
        if (fromApp) {
          rememberAppCreation(appContext, environment);
          onCreated?.();
          onClose?.();
          return;
        }
        navigate(dockerComposeProjectRoute(created.project.id, "source"), { replace: true });
        return;
      }
      const values = input();
      const result = await validate(false);
      if (!result.valid) throw new Error("Fix validation errors before applying");
      let targetProjectId = projectId;
      let revisionId: string | undefined;
      let idempotencyKey = createClientUuid();
      let completionMessage = "Compose project created; Pull & Apply started";
      const inputSignature = composeRevisionResumeSignature(values);
      if (!projectId) {
        const created = await api.createDockerComposeProject(nodeId, {
          ...values,
          folderId: destinationFolderId,
        });
        targetProjectId = created.project.id;
        revisionId = created.revision.id;
      } else if (adoptionResume?.inputSignature === inputSignature) {
        revisionId = adoptionResume.revisionId;
        idempotencyKey = adoptionResume.idempotencyKey;
        completionMessage = "Compose adopted; Pull & Apply retried";
      } else if (adoptionResume) {
        const revision = await api.createDockerComposeRevision(nodeId, projectId, values);
        revisionId = revision.id;
        setAdoptionResume(null);
        completionMessage = "Revision saved; Pull & Apply started";
      } else if (adoption) {
        const prepared = await api.adoptDockerComposeProject(nodeId, projectId, values);
        revisionId = prepared.revision.id;
        const resume = { revisionId, idempotencyKey, inputSignature };
        setAdoptionResume(resume);
        completionMessage = "Compose adopted; Pull & Apply started";
      } else {
        const revision = await api.createDockerComposeRevision(nodeId, projectId, values);
        revisionId = revision.id;
        completionMessage = "Revision saved; Pull & Apply started";
      }
      if (!targetProjectId || !revisionId) throw new Error("Compose revision was not created");
      await api.startDockerComposeOperation(nodeId, targetProjectId, "pull_apply", {
        revisionId,
        idempotencyKey,
      });
      toast.success(completionMessage);
      if (!projectId) {
        rememberAppCreation(fromApp ? appContext : null, environment);
        onCreated?.();
      }
      if (onClose) onClose();
      else navigate(dockerComposeProjectRoute(targetProjectId), { replace: true });
    } catch (error) {
      if (
        !handleLicenseApiError(
          error,
          repositoryCreation ? "Git push-to-deploy" : "Compose projects"
        )
      )
        toastApiError(error, "Failed to apply Compose project");
    } finally {
      setSaving(false);
    }
  };

  // The enclosing dialog shows its loader until the project is loaded.
  if (loading) return null;

  if (compactRevision && editing) {
    return (
      <div className="flex min-h-0 flex-col gap-4">
        <div className="h-[min(48dvh,560px)] min-h-48 overflow-hidden border border-border">
          <CodeEditor
            value={yaml}
            onChange={setYaml}
            language="yaml"
            minHeight="0"
            height="100%"
            bordered={false}
          />
        </div>
        <DialogFooter className="pt-1">
          <Button variant="outline" onClick={onClose} disabled={validating || saving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void validate().catch((error) => toast.error(error.message))}
            pending={validating}
            disabled={saving}
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            Validate
          </Button>
          <Button onClick={() => void save()} pending={saving} disabled={validating || !canSubmit}>
            <Save className="mr-1 h-4 w-4" />
            Apply
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (onClose) {
    const yamlPanel = (
      <PanelShell
        title="Compose YAML"
        description="Images are required; build, host paths, privileged and swarm-only fields are rejected."
        bodyClassName="h-[min(32dvh,440px)] min-h-40 overflow-hidden"
      >
        <CodeEditor
          value={yaml}
          onChange={setYaml}
          language="yaml"
          minHeight="0"
          height="100%"
          bordered={false}
        />
      </PanelShell>
    );

    return (
      <div className="flex min-h-0 flex-col gap-4">
        {fromApp && appContext && (
          <AppEnvironmentFields
            context={appContext}
            environmentId={appEnvironment.environmentId}
            onEnvironmentChange={appEnvironment.setEnvironmentId}
            disabled={saving}
          />
        )}
        {noAllowedNode && appContext && environment ? (
          <NoAllowedNodeNotice
            context={appContext}
            environment={environment}
            nodeKind="Docker"
            resourceKind="Compose projects"
            onNavigate={onClose}
          />
        ) : !projectId ? (
          <Tabs
            value={sourceMode}
            onValueChange={(value) => setSourceMode(value as "yaml" | "repository")}
            className="flex min-h-0 flex-col gap-4"
          >
            <div
              className={
                planIncludesGitDeploy
                  ? "grid gap-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]"
                  : "grid gap-4 md:grid-cols-2"
              }
            >
              {planIncludesGitDeploy && (
                <div className="space-y-1.5">
                  <span className="block text-sm font-medium">Source type</span>
                  <TabsList className="grid h-9 w-full grid-cols-2">
                    <TabsTrigger value="yaml" className="h-full px-3 py-0">
                      Compose YAML
                    </TabsTrigger>
                    <TabsTrigger value="repository" className="h-full px-3 py-0">
                      Repository
                    </TabsTrigger>
                  </TabsList>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor="compose-name-modal" className="text-sm font-medium">
                  Project name
                </label>
                <Input
                  id="compose-name-modal"
                  value={name}
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                  placeholder="my-project"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target node</label>
                <Select
                  value={nodeId}
                  onValueChange={setNodeId}
                  disabled={
                    appNodeLocked ||
                    (!fromApp &&
                      !!defaultNodeId &&
                      selectableNodes.some((node) => node.id === defaultNodeId))
                  }
                >
                  <SelectTrigger aria-label="Target node">
                    <SelectValue placeholder="Select node" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {fromApp && environment && selectableNodes.length > 0 && (
              <p className="-mt-2 text-xs text-muted-foreground">
                {allowedNodesHint(environment, selectableNodes.length, "Docker")}
              </p>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Folder</label>
              <Select
                value={fromApp ? "__root__" : (folderId ?? "__root__")}
                onValueChange={(value) => setFolderId(value === "__root__" ? null : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a destination folder" />
                </SelectTrigger>
                <SelectContent>
                  {(fromApp ||
                    canCreateInFolder(
                      user?.scopes ?? [],
                      "docker:compose:create",
                      null,
                      nodeId
                    )) && <SelectItem value="__root__">No folder</SelectItem>}
                  {(fromApp ? [] : destinationFolders).map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {folder.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <AnimatedHeight>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.div key={sourceMode} {...SOURCE_MODE_ANIMATION} className="overflow-hidden">
                  {sourceMode === "yaml" ? (
                    yamlPanel
                  ) : (
                    <div>
                      <RepositorySourceFields
                        loadErrors={sourceLoadErrors}
                        repositoriesLoading={sourceRepositoriesLoading}
                        repositoriesHint={sourceRepositoriesHint}
                        onRepositorySearch={onSourceRepositorySearch}
                        connectorId={sourceConnectorId}
                        connectorOptions={sourceConnectorOptions}
                        repositories={sourceRepositories}
                        repositoryOptions={sourceRepositories.map((repository) => ({
                          value: repository.projectId,
                          label: repository.fullPath,
                          keywords: `${repository.name} ${repository.fullPath}`,
                        }))}
                        projectId={sourceProjectId}
                        branch={sourceBranch}
                        dockerfilePath="Dockerfile"
                        contextPath="."
                        composeFilePath={sourceComposeFilePath}
                        autoBuild={sourceAutoBuild}
                        autoDeploy={sourceAutoDeploy}
                        onConnectorChange={(value) => {
                          setSourceConnectorId(value);
                          setSourceProjectId("");
                        }}
                        onProjectChange={setSourceProjectId}
                        onBranchChange={setSourceBranch}
                        onDockerfilePathChange={() => {}}
                        onContextPathChange={() => {}}
                        onComposeFilePathChange={setSourceComposeFilePath}
                        onAutoBuildChange={setSourceAutoBuild}
                        onAutoDeployChange={setSourceAutoDeploy}
                      />
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </AnimatedHeight>
          </Tabs>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="compose-name-modal" className="text-sm font-medium">
                  Project name
                </label>
                <Input id="compose-name-modal" value={name} disabled />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target node</label>
                <Select value={nodeId} disabled>
                  <SelectTrigger>
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
              </div>
            </div>
            {yamlPanel}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={validating || saving}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void validate().catch((error) => toast.error(error.message))}
            pending={validating}
            disabled={saving || repositoryCreation || noAllowedNode}
          >
            <CheckCircle2 className="mr-1 h-4 w-4" />
            Validate
          </Button>
          <Button
            onClick={() => void save()}
            pending={saving}
            disabled={validating || !canSubmit || noAllowedNode}
          >
            <Save className="mr-1 h-4 w-4" />
            {repositoryCreation
              ? "Create and build"
              : adoption
                ? "Adopt & Apply"
                : editing
                  ? "Apply"
                  : "Deploy"}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return null;
}
