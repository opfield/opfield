import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  FileCode2,
  GitBranch,
  Hammer,
  History,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type { DockerBuildSecret, DockerSourceBinding, DockerSourceTarget } from "@/types";
import { RepositorySourceFields } from "../docker-deploy/RepositorySourceFields";
import { useDockerSourceRepositories } from "../docker-deploy/useDockerSourceRepositories";
import { EnvTextDialog, envTextErrorLines, parseEnvText } from "./EnvTextDialog";

interface DockerGitSourcePanelProps {
  target?: DockerSourceTarget;
  source?: DockerSourceBinding | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSourceChange?: (source: DockerSourceBinding | null) => void;
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
  canEdit?: boolean;
  canBuild?: boolean;
  pendingContainer?: boolean;
}

type VulnerabilityThreshold = "critical" | "high" | "medium" | "low" | "none" | "disabled";
type PackageManager = "npm" | "pnpm" | "yarn";
type NodeVersion = "20" | "22" | "24";

/** Editable settings of a connected source. */
interface SourceSettings {
  branch: string;
  applicationRoot: string;
  autoBuild: boolean;
  dockerfilePath: string;
  contextPath: string;
  composeFilePath: string;
  autoDeploy: boolean;
  vulnerabilityThreshold: VulnerabilityThreshold;
  vulnerabilityScope: "all" | "application";
  packageManager: PackageManager;
  packageManagerVersion: string;
  nodeVersion: NodeVersion;
  buildScript: string;
  artifactDirectory: string;
  publishTag: string;
  buildVariables: Record<string, string>;
}

type SettingsSection = "repository" | "build" | "variables";

/**
 * Each section saves only its own settings. Repository: where the code comes from and when it
 * builds. Build: how it is built, checked and shipped. Variables: the Pages Build Variables.
 */
const SECTION_SETTINGS: Record<SettingsSection, Array<keyof SourceSettings>> = {
  repository: ["branch", "applicationRoot", "autoBuild"],
  build: [
    "dockerfilePath",
    "contextPath",
    "composeFilePath",
    "autoDeploy",
    "vulnerabilityThreshold",
    "vulnerabilityScope",
    "packageManager",
    "packageManagerVersion",
    "nodeVersion",
    "buildScript",
    "artifactDirectory",
    "publishTag",
  ],
  variables: ["buildVariables"],
};

const SECTION_SAVED: Record<SettingsSection, string> = {
  repository: "Repository settings updated",
  build: "Build settings updated",
  variables: "Build Variables updated",
};

function sourceSettings(source: DockerSourceBinding | null | undefined): SourceSettings {
  return {
    branch: source?.branch ?? "main",
    applicationRoot: source?.applicationRoot || ".",
    autoBuild: source?.autoBuild ?? true,
    dockerfilePath: source?.dockerfilePath ?? "Dockerfile",
    contextPath: source?.contextPath ?? ".",
    composeFilePath: source?.composeFilePath ?? "compose.yaml",
    autoDeploy: source?.autoDeploy ?? true,
    vulnerabilityThreshold: source?.policy?.vulnerabilityThreshold ?? "critical",
    vulnerabilityScope: source?.policy?.vulnerabilityScope ?? "all",
    packageManager: source?.packageManager ?? "npm",
    packageManagerVersion: source?.packageManagerVersion ?? "",
    nodeVersion: source?.nodeVersion ?? "24",
    buildScript: source?.buildScript ?? "build",
    artifactDirectory: source?.artifactDirectory ?? "dist",
    publishTag: source?.publishTag ?? "production",
    buildVariables: source?.buildArgs ?? {},
  };
}

const SETTING_KEYS = Object.keys(sourceSettings(null)) as Array<keyof SourceSettings>;

function sameSetting(
  left: SourceSettings[keyof SourceSettings],
  right: SourceSettings[keyof SourceSettings]
) {
  return typeof left === "object" ? JSON.stringify(left) === JSON.stringify(right) : left === right;
}

const CONNECT_STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function commitBadge(sha: string | null, empty: string) {
  return sha ? (
    <Badge variant="outline" className="max-w-full font-mono">
      {sha.slice(0, 12)}
    </Badge>
  ) : (
    <span className="text-sm text-muted-foreground">{empty}</span>
  );
}

export function DockerGitSourcePanel({
  target,
  source: suppliedSource,
  loading: suppliedLoading,
  error,
  onRetry,
  onSourceChange,
  composeVariables = {},
  composeSecretKeys = [],
  canEdit = true,
  canBuild = true,
  pendingContainer = false,
}: DockerGitSourcePanelProps) {
  const navigate = useNavigate();
  const [source, setSource] = useState<DockerSourceBinding | null>(suppliedSource ?? null);
  const [loading, setLoading] = useState(suppliedSource === undefined);
  const [savingSection, setSavingSection] = useState<SettingsSection | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildWorkerRequiredOpen, setBuildWorkerRequiredOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (connectError) connectErrorRef.current?.scrollIntoView({ block: "nearest" });
  }, [connectError]);
  const [settings, setSettings] = useState<SourceSettings>(() => sourceSettings(suppliedSource));
  // The saved settings the draft was last reconciled with.
  const reconciledRef = useRef<{ sourceId: string; settings: SourceSettings } | null>(null);
  const [variableDialogOpen, setVariableDialogOpen] = useState(false);
  const [variableName, setVariableName] = useState("");
  const [variableValue, setVariableValue] = useState("");
  const [variablesTextOpen, setVariablesTextOpen] = useState(false);
  const [variablesText, setVariablesText] = useState("");
  const [buildSecrets, setBuildSecrets] = useState<DockerBuildSecret[]>(() =>
    (suppliedSource?.buildSecretNames ?? []).map((name, index) => ({
      id: `source-secret-${index}`,
      name,
      createdAt: suppliedSource?.createdAt ?? new Date(0).toISOString(),
      updatedAt: suppliedSource?.updatedAt ?? new Date(0).toISOString(),
    }))
  );
  // The source whose Build Secrets are listed, so the first list is waited for instead of popping in.
  const [buildSecretsLoadedFor, setBuildSecretsLoadedFor] = useState<string | null>(null);
  const [deletingSecretName, setDeletingSecretName] = useState<string | null>(null);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretSaving, setSecretSaving] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectStep, setConnectStep] = useState<1 | 2>(1);
  const connectPresent = useDialogPresence(connectOpen);
  // Reset once the close animation has played, so the closing dialog keeps its content.
  useEffect(() => {
    if (!connectPresent) setConnectStep(1);
  }, [connectPresent]);
  const [connecting, setConnecting] = useState(false);
  const [connectorId, setConnectorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [connectBranch, setConnectBranch] = useState("main");
  const [connectDockerfilePath, setConnectDockerfilePath] = useState("Dockerfile");
  const [connectContextPath, setConnectContextPath] = useState(".");
  const [connectComposeFilePath, setConnectComposeFilePath] = useState("compose.yaml");
  const [connectAutoBuild, setConnectAutoBuild] = useState(true);
  const [connectAutoDeploy, setConnectAutoDeploy] = useState(true);
  const [connectApplicationRoot, setConnectApplicationRoot] = useState(".");
  const [connectPackageManager, setConnectPackageManager] = useState<"npm" | "pnpm" | "yarn">(
    "npm"
  );
  const [connectPackageManagerVersion, setConnectPackageManagerVersion] = useState("");
  const [connectNodeVersion, setConnectNodeVersion] = useState<"20" | "22" | "24">("24");
  const [connectBuildScript, setConnectBuildScript] = useState("");
  const [connectArtifactDirectory, setConnectArtifactDirectory] = useState("dist");
  const [connectPublishTag, setConnectPublishTag] = useState("production");
  const [discoveryScripts, setDiscoveryScripts] = useState<Record<string, string>>({});
  const [discoveryManagers, setDiscoveryManagers] = useState<Array<"npm" | "pnpm" | "yarn">>([]);
  const [discovering, setDiscovering] = useState(false);
  const targetKind = target?.kind;
  const targetNodeId = target?.nodeId;
  const targetResourceId =
    target?.kind === "container"
      ? target.containerName
      : target?.kind === "deployment"
        ? target.deploymentId
        : target?.kind === "compose_project"
          ? target.composeProjectId
          : target?.pageProjectId;
  const composeTarget = target?.kind === "compose_project";
  const pagesTarget = target?.kind === "pages_project";
  // Vulnerability scanning and its admission policy follow the plan map (Business).
  const scanningInPlan = usePlanIncludes("security-scanning");
  const {
    connectorOptions,
    connectorsLoading,
    repositories,
    repositoriesLoading,
    loadErrors,
    repositoriesHint,
    onRepositorySearch,
  } = useDockerSourceRepositories(connectOpen, connectorId, target);
  const sourceId = source?.id;
  const listedSourceId = (suppliedSource === undefined ? source : suppliedSource)?.id;
  useContentLoading(
    Boolean(suppliedLoading ?? loading) ||
      (!!listedSourceId && buildSecretsLoadedFor !== listedSourceId)
  );

  useEffect(() => {
    if (suppliedSource !== undefined) {
      setSource(suppliedSource);
    }
  }, [suppliedSource]);

  useEffect(() => {
    if (
      suppliedSource !== undefined ||
      !targetKind ||
      !targetResourceId ||
      ((targetKind === "container" || targetKind === "compose_project") && !targetNodeId)
    )
      return;
    const sourceTarget: DockerSourceTarget =
      targetKind === "container"
        ? { kind: "container", nodeId: targetNodeId!, containerName: targetResourceId }
        : targetKind === "deployment"
          ? { kind: "deployment", nodeId: targetNodeId, deploymentId: targetResourceId }
          : targetKind === "compose_project"
            ? { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId }
            : { kind: "pages_project", nodeId: targetNodeId, pageProjectId: targetResourceId };
    setLoading(true);
    void api
      .getDockerSource(sourceTarget)
      .then(setSource)
      .catch((error) => toastApiError(error, "Failed to load repository source"))
      .finally(() => setLoading(false));
  }, [suppliedSource, targetKind, targetNodeId, targetResourceId]);

  useEffect(() => {
    if (
      !sourceId ||
      !targetKind ||
      !targetResourceId ||
      ((targetKind === "container" || targetKind === "compose_project") && !targetNodeId)
    )
      return;
    const sourceTarget: DockerSourceTarget =
      targetKind === "container"
        ? { kind: "container", nodeId: targetNodeId!, containerName: targetResourceId }
        : targetKind === "deployment"
          ? { kind: "deployment", nodeId: targetNodeId, deploymentId: targetResourceId }
          : targetKind === "compose_project"
            ? { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId }
            : { kind: "pages_project", nodeId: targetNodeId, pageProjectId: targetResourceId };
    void api
      .listDockerBuildSecrets(sourceTarget)
      .then(setBuildSecrets)
      .catch((error) => toastApiError(error, "Failed to load Build Secrets"))
      .finally(() => setBuildSecretsLoadedFor(sourceId));
  }, [sourceId, targetKind, targetNodeId, targetResourceId]);

  useEffect(() => {
    const previous = reconciledRef.current;
    reconciledRef.current = source
      ? { sourceId: source.id, settings: sourceSettings(source) }
      : null;
    if (!source) return;
    const next = sourceSettings(source);
    // A refreshed source (a saved section, Sync now, a reload) replaces every setting the
    // operator has not changed; edits of the other sections stay unsaved.
    setSettings((current) =>
      previous?.sourceId === source.id
        ? (Object.fromEntries(
            SETTING_KEYS.map((key) => [
              key,
              sameSetting(current[key], previous.settings[key]) ? next[key] : current[key],
            ])
          ) as unknown as SourceSettings)
        : next
    );
  }, [source]);

  const savedSettings = useMemo(() => sourceSettings(source), [source]);
  const sectionDirty = (section: SettingsSection) =>
    Boolean(source) &&
    SECTION_SETTINGS[section].some((key) => !sameSetting(settings[key], savedSettings[key]));
  const dirtySections: Record<SettingsSection, boolean> = {
    repository: sectionDirty("repository"),
    build: sectionDirty("build"),
    variables: sectionDirty("variables"),
  };
  const dirty = dirtySections.repository || dirtySections.build || dirtySections.variables;
  const updateSetting = <Key extends keyof SourceSettings>(key: Key, value: SourceSettings[Key]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  /** The saved settings with one section's edits applied. */
  const sectionSettings = (section: SettingsSection): SourceSettings => ({
    ...savedSettings,
    ...(Object.fromEntries(
      SECTION_SETTINGS[section].map((key) => [key, settings[key]])
    ) as Partial<SourceSettings>),
  });

  const settingsInvalid = (next: SourceSettings) =>
    !next.branch.trim() ||
    (composeTarget
      ? !next.composeFilePath.trim()
      : pagesTarget
        ? !next.applicationRoot.trim() ||
          !next.buildScript.trim() ||
          !next.artifactDirectory.trim() ||
          !next.publishTag.trim()
        : !next.dockerfilePath.trim() || !next.contextPath.trim());

  const saveSection = async (section: SettingsSection) => {
    if (!canEdit || !target || !source) return;
    const next = sectionSettings(section);
    if (settingsInvalid(next)) return;
    setSavingSection(section);
    try {
      const updated = await api.upsertDockerSource(target, {
        connectorId: source.connectorId,
        projectId: source.projectId,
        branch: next.branch.trim(),
        dockerfilePath: next.dockerfilePath.trim(),
        contextPath: next.contextPath.trim(),
        composeFilePath: composeTarget ? next.composeFilePath.trim() : undefined,
        composeVariables: source.composeVariables,
        composeSecretKeys: source.composeSecretKeys,
        autoBuild: next.autoBuild,
        autoDeploy: next.autoDeploy,
        buildArgs: pagesTarget ? next.buildVariables : source.buildArgs,
        buildSecretNames: source.buildSecretNames,
        applicationRoot: pagesTarget ? next.applicationRoot.trim() : undefined,
        packageManager: pagesTarget ? next.packageManager : undefined,
        packageManagerVersion:
          pagesTarget && next.packageManagerVersion.trim()
            ? next.packageManagerVersion.trim()
            : undefined,
        nodeVersion: pagesTarget ? next.nodeVersion : undefined,
        buildScript: pagesTarget ? next.buildScript.trim() : undefined,
        artifactDirectory: pagesTarget ? next.artifactDirectory.trim() : undefined,
        publishTag: pagesTarget ? next.publishTag.trim() : undefined,
        policy: {
          ...source.policy,
          vulnerabilityThreshold: pagesTarget ? "none" : next.vulnerabilityThreshold,
          vulnerabilityScope: next.vulnerabilityScope,
        },
      });
      // The saved section takes the server's values (trimmed); the other sections keep their edits.
      const saved = sourceSettings(updated);
      setSettings((current) => ({
        ...current,
        ...(Object.fromEntries(
          SECTION_SETTINGS[section].map((key) => [key, saved[key]])
        ) as Partial<SourceSettings>),
      }));
      setSource(updated);
      onSourceChange?.(updated);
      toast.success(SECTION_SAVED[section]);
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to update repository settings");
      }
    } finally {
      setSavingSection(null);
    }
  };

  const openConnect = () => {
    if (!canEdit) return;
    if (!requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")) return;
    setConnectStep(1);
    setConnectError(null);
    setConnectOpen(true);
  };

  const connectSource = async () => {
    if (!canEdit) return;
    if (!target || !connectorId || !projectId || !connectBranch.trim()) return;
    if (composeTarget && !connectComposeFilePath.trim()) return;
    if (
      pagesTarget &&
      (!connectApplicationRoot.trim() ||
        !connectBuildScript.trim() ||
        !connectArtifactDirectory.trim() ||
        !connectPublishTag.trim())
    )
      return;
    setConnecting(true);
    setConnectError(null);
    try {
      const connected = await api.upsertDockerSource(target, {
        connectorId,
        projectId,
        branch: connectBranch.trim(),
        dockerfilePath: connectDockerfilePath.trim() || "Dockerfile",
        contextPath: connectContextPath.trim() || ".",
        composeFilePath: composeTarget ? connectComposeFilePath.trim() : undefined,
        composeVariables: composeTarget ? composeVariables : undefined,
        composeSecretKeys: composeTarget ? composeSecretKeys : undefined,
        autoBuild: connectAutoBuild,
        autoDeploy: connectAutoDeploy,
        buildArgs: {},
        buildSecretNames: [],
        applicationRoot: pagesTarget ? connectApplicationRoot.trim() : undefined,
        packageManager: pagesTarget ? connectPackageManager : undefined,
        packageManagerVersion:
          pagesTarget && connectPackageManagerVersion.trim()
            ? connectPackageManagerVersion.trim()
            : undefined,
        nodeVersion: pagesTarget ? connectNodeVersion : undefined,
        buildScript: pagesTarget ? connectBuildScript.trim() : undefined,
        artifactDirectory: pagesTarget ? connectArtifactDirectory.trim() : undefined,
        publishTag: pagesTarget ? connectPublishTag.trim() : undefined,
        policy: { vulnerabilityThreshold: pagesTarget ? "none" : "critical" },
      });
      setSource(connected);
      onSourceChange?.(connected);
      setConnectOpen(false);
      toast.success("Repository connected");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        setConnectError(error instanceof Error ? error.message : "Failed to connect repository");
      }
    } finally {
      setConnecting(false);
    }
  };

  const clearPagesBuildDiscovery = () => {
    setDiscoveryScripts({});
    setDiscoveryManagers([]);
    setConnectBuildScript("");
    setConnectPackageManagerVersion("");
  };

  const discoverPagesBuild = async (): Promise<boolean> => {
    if (!pagesTarget || !target || !connectorId || !projectId || !connectBranch.trim()) {
      return false;
    }
    setDiscovering(true);
    try {
      const discovery = await api.discoverPagesBuild(target.pageProjectId, {
        connectorId,
        projectId,
        branch: connectBranch.trim(),
        applicationRoot: connectApplicationRoot.trim() || ".",
      });
      setDiscoveryScripts(discovery.scripts);
      setDiscoveryManagers(discovery.packageManagers);
      if (discovery.preferredPackageManager) {
        setConnectPackageManager(discovery.preferredPackageManager);
      }
      setConnectPackageManagerVersion(discovery.packageManagerVersion ?? "");
      const scriptNames = Object.keys(discovery.scripts);
      setConnectBuildScript(
        discovery.scripts.build ? "build" : scriptNames.length === 1 ? scriptNames[0]! : ""
      );
      toast.success("package.json loaded");
      return true;
    } catch (error) {
      clearPagesBuildDiscovery();
      toastApiError(error, "Failed to inspect package.json");
      return false;
    } finally {
      setDiscovering(false);
    }
  };

  const continuePagesConnect = async () => {
    if (await discoverPagesBuild()) setConnectStep(2);
  };

  const saveBuildVariable = () => {
    const name = variableName.trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      toast.error("Variable name must be a valid environment variable name");
      return;
    }
    updateSetting("buildVariables", { ...settings.buildVariables, [name]: variableValue });
    setVariableDialogOpen(false);
  };

  // "Edit as text" works on a copy; Apply replaces the draft list, Save Build Variables stores it.
  const openBuildVariablesText = () => {
    setVariablesText(
      Object.entries(settings.buildVariables)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join("\n")
    );
    setVariablesTextOpen(true);
  };
  const applyBuildVariablesText = () => {
    updateSetting(
      "buildVariables",
      Object.fromEntries(parseEnvText(variablesText).map(({ key, value }) => [key, value]))
    );
    setVariablesTextOpen(false);
  };
  const variablesTextPresent = useDialogPresence(variablesTextOpen);
  const variablesTextErrorLines = variablesTextPresent ? envTextErrorLines(variablesText) : [];

  const removeBuildVariable = (name: string) => {
    const next = { ...settings.buildVariables };
    delete next[name];
    updateSetting("buildVariables", next);
  };

  const saveBuildSecret = async () => {
    if (!canEdit) return;
    const name = secretName.trim();
    if (!name || !secretValue || !source) return;
    if (pagesTarget && name.startsWith("VITE_")) {
      toast.error("VITE_* values are public build variables, not Build Secrets");
      return;
    }
    setSecretSaving(true);
    try {
      const saved = target ? await api.upsertDockerBuildSecret(target, name, secretValue) : null;
      if (!saved) return;
      setBuildSecrets((current) =>
        [...current.filter((secret) => secret.name !== saved.name), saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setSource((current) =>
        current
          ? {
              ...current,
              buildSecretNames: [
                ...current.buildSecretNames.filter((candidate) => candidate !== saved.name),
                saved.name,
              ].sort(),
            }
          : current
      );
      setSecretDialogOpen(false);
      toast.success("Build Secret saved");
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to save Build Secret");
      }
    } finally {
      setSecretSaving(false);
    }
  };

  const removeBuildSecret = async (name: string) => {
    if (!canEdit) return;
    const accepted = await confirm({
      title: "Delete Build Secret",
      description: `Delete ${name}? Builds that mount this secret will fail until it is added again.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!accepted) return;
    setDeletingSecretName(name);
    try {
      if (target) await api.deleteDockerBuildSecret(target, name);
      setBuildSecrets((current) => current.filter((secret) => secret.name !== name));
      setSource((current) =>
        current
          ? {
              ...current,
              buildSecretNames: current.buildSecretNames.filter((candidate) => candidate !== name),
            }
          : current
      );
      toast.success("Build Secret removed");
    } catch (error) {
      toastApiError(error, "Failed to remove Build Secret");
    } finally {
      setDeletingSecretName(null);
    }
  };

  const openBuildSecretDialog = (name = "") => {
    setSecretName(name);
    setSecretValue("");
    setSecretDialogOpen(true);
  };

  const triggerBuild = async () => {
    if (!canBuild) return;
    if (!source) return;
    if (!target) return;
    setBuilding(true);
    try {
      await api.createDockerSourceBuild(target, { force: true });
      toast.success("Build queued");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "NO_BUILD_WORKER_AVAILABLE") {
        setBuildWorkerRequiredOpen(true);
        return;
      }
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to queue build");
      }
    } finally {
      setBuilding(false);
    }
  };

  /** Checks the branch for new commits now; the server queues the automatic build of a new head. */
  const syncSource = async () => {
    if (!canBuild || !target || !source) return;
    setSyncing(true);
    try {
      const result = await api.syncDockerSource(target);
      setSource(result.source);
      onSourceChange?.(result.source);
      const head = result.source.desiredCommitSha?.slice(0, 8);
      if (result.build) {
        toast.success(
          result.changed ? `New commit ${head} found, build queued` : `Build queued for ${head}`
        );
      } else if (result.changed) {
        toast.success(
          result.source.autoBuild
            ? `New commit ${head} found`
            : `New commit ${head} found. Automatic builds are off; use Build now to build it.`
        );
      } else {
        toast.success(head ? `Repository is up to date at ${head}` : "Repository is up to date");
      }
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to sync repository");
      }
    } finally {
      setSyncing(false);
    }
  };

  const disconnectSource = async () => {
    if (!canEdit) return;
    if (!target || !source) return;
    const accepted = await confirm({
      title: "Disconnect Repository",
      description: pendingContainer
        ? "This container has not been deployed yet. Disconnecting removes the pending container and its creation settings. To change the Dockerfile or build settings, cancel and edit Source instead."
        : "Stop repository polling, webhooks, builds, and automatic deployment for this resource? Existing runtime state and build history are preserved.",
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!accepted) return;
    setDisconnecting(true);
    try {
      await api.removeDockerSource(target);
      setSource(null);
      onSourceChange?.(null);
      setBuildSecrets([]);
      toast.success("Repository disconnected");
      if (pendingContainer) navigate("/docker/containers", { replace: true });
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to disconnect repository");
      }
    } finally {
      setDisconnecting(false);
    }
  };

  if (suppliedLoading ?? loading) {
    // The first load keeps the tab hidden; a retry keeps the panel header in place.
    return (
      <PanelShell
        icon={<GitBranch className="h-4 w-4" />}
        title="Repository"
        description="Loading repository delivery settings…"
      />
    );
  }

  if (error && !source) {
    return (
      <PanelShell
        icon={<GitBranch className="h-4 w-4" />}
        title="Repository"
        description="Repository delivery settings could not be loaded."
      >
        <EmptyState message={error} actionLabel="Retry" onAction={onRetry} embedded />
      </PanelShell>
    );
  }

  if (!source) {
    const repositorySourceFields = (
      <RepositorySourceFields
        loading={connectorsLoading}
        loadErrors={loadErrors}
        repositoriesLoading={repositoriesLoading}
        repositoriesHint={repositoriesHint}
        onRepositorySearch={onRepositorySearch}
        connectorId={connectorId}
        connectorOptions={connectorOptions}
        repositories={repositories}
        repositoryOptions={repositories.map((repository) => ({
          value: repository.projectId,
          label: repository.fullPath,
          keywords: `${repository.name} ${repository.fullPath}`,
        }))}
        projectId={projectId}
        branch={connectBranch}
        dockerfilePath={connectDockerfilePath}
        contextPath={connectContextPath}
        composeFilePath={composeTarget ? connectComposeFilePath : undefined}
        pages={pagesTarget}
        autoBuild={connectAutoBuild}
        autoDeploy={connectAutoDeploy}
        onConnectorChange={(value) => {
          setConnectorId(value);
          setProjectId("");
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onProjectChange={(value) => {
          setProjectId(value);
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onBranchChange={(value) => {
          setConnectBranch(value);
          if (pagesTarget) clearPagesBuildDiscovery();
        }}
        onDockerfilePathChange={setConnectDockerfilePath}
        onContextPathChange={setConnectContextPath}
        onComposeFilePathChange={composeTarget ? setConnectComposeFilePath : undefined}
        onAutoBuildChange={setConnectAutoBuild}
        onAutoDeployChange={setConnectAutoDeploy}
      />
    );

    const pagesBuildFields = (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Package manager</label>
          <Select
            value={connectPackageManager}
            onValueChange={(value) => setConnectPackageManager(value as "npm" | "pnpm" | "yarn")}
          >
            <SelectTrigger aria-label="Package manager">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(discoveryManagers.length > 0
                ? discoveryManagers
                : (["npm", "pnpm", "yarn"] as const)
              ).map((manager) => (
                <SelectItem key={manager} value={manager}>
                  {manager}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Node.js</label>
          <Select
            value={connectNodeVersion}
            onValueChange={(value) => setConnectNodeVersion(value as "20" | "22" | "24")}
          >
            <SelectTrigger aria-label="Node.js version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">Node.js 20</SelectItem>
              <SelectItem value="22">Node.js 22</SelectItem>
              <SelectItem value="24">Node.js 24</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Build script</label>
          <Select value={connectBuildScript} onValueChange={setConnectBuildScript}>
            <SelectTrigger aria-label="Build script">
              <SelectValue placeholder="Select build script" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(discoveryScripts).map(([name, command]) => (
                <SelectItem key={name} value={name} description={command}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pages-artifact-directory">
            Artifact directory
          </label>
          <Input
            id="pages-artifact-directory"
            value={connectArtifactDirectory}
            onChange={(event) => setConnectArtifactDirectory(event.target.value)}
            placeholder="dist"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="pages-publish-tag">
            Publish Tag
          </label>
          <Input
            id="pages-publish-tag"
            value={connectPublishTag}
            onChange={(event) => setConnectPublishTag(event.target.value)}
            placeholder="production"
          />
        </div>
      </div>
    );

    return (
      <>
        <PanelShell
          icon={<GitBranch className="h-4 w-4" />}
          title="Repository"
          description="Build and deploy this resource directly from a Git repository."
          actions={
            canEdit ? (
              <Button type="button" onClick={openConnect}>
                <Plus className="h-4 w-4" />
                Connect repository
              </Button>
            ) : undefined
          }
        >
          <EmptyState
            message={
              pagesTarget
                ? "No repository connected. This Project continues to accept manual Deployments."
                : "No repository connected. This resource continues to use its configured image."
            }
            actionLabel={canEdit ? "Connect repository" : undefined}
            onAction={canEdit ? openConnect : undefined}
            embedded
          />
        </PanelShell>
        <Dialog
          open={connectOpen}
          onOpenChange={(open) => {
            setConnectOpen(open);
          }}
        >
          <DialogContent className={pagesTarget ? "sm:max-w-lg" : "sm:max-w-2xl"}>
            <DialogHeader>
              <DialogTitle>Connect Repository</DialogTitle>
              <DialogDescription>
                {pagesTarget
                  ? connectStep === 1
                    ? "Choose the repository and application root for this Pages Project."
                    : "Configure how Opfield builds and publishes the Pages artifact."
                  : composeTarget
                    ? "Build every Compose service that declares build and apply the project only after all artifacts pass policy."
                    : "Build and deploy this Docker resource from an allowlisted repository."}
              </DialogDescription>
            </DialogHeader>
            {pagesTarget ? (
              <AnimatedHeight>
                <AnimatePresence initial={false} mode="popLayout">
                  {connectStep === 1 ? (
                    <motion.div
                      key="pages-source-step"
                      {...CONNECT_STEP_ANIMATION}
                      className="space-y-4"
                    >
                      {repositorySourceFields}
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium" htmlFor="pages-application-root">
                          Application root
                        </label>
                        <Input
                          id="pages-application-root"
                          value={connectApplicationRoot}
                          onChange={(event) => {
                            setConnectApplicationRoot(event.target.value);
                            clearPagesBuildDiscovery();
                          }}
                          placeholder="."
                        />
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div key="pages-build-step" {...CONNECT_STEP_ANIMATION}>
                      {pagesBuildFields}
                    </motion.div>
                  )}
                </AnimatePresence>
              </AnimatedHeight>
            ) : (
              repositorySourceFields
            )}
            {connectError && (
              <p ref={connectErrorRef} role="alert" className="text-sm text-destructive">
                {connectError}
              </p>
            )}
            <DialogFooter>
              {pagesTarget && connectStep === 1 ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setConnectOpen(false)}
                    disabled={discovering}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void continuePagesConnect()}
                    pending={discovering}
                    disabled={
                      !connectorId ||
                      !projectId ||
                      !connectBranch.trim() ||
                      !connectApplicationRoot.trim()
                    }
                  >
                    {discovering ? (
                      "Loading package.json…"
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (pagesTarget) setConnectStep(1);
                      else setConnectOpen(false);
                    }}
                    disabled={connecting}
                  >
                    {pagesTarget ? (
                      <>
                        <ArrowLeft className="h-4 w-4" />
                        Back
                      </>
                    ) : (
                      "Cancel"
                    )}
                  </Button>
                  <Button
                    onClick={() => void connectSource()}
                    pending={connecting}
                    disabled={
                      !connectorId ||
                      !projectId ||
                      !connectBranch.trim() ||
                      (composeTarget && !connectComposeFilePath.trim()) ||
                      (pagesTarget &&
                        (!connectBuildScript ||
                          !connectApplicationRoot.trim() ||
                          !connectArtifactDirectory.trim() ||
                          !connectPublishTag.trim()))
                    }
                  >
                    Connect
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  const lastSync = source.lastWebhookAt ?? source.lastResolvedAt;
  // Two sections share a row on wide screens; the controls stay narrow enough for half the content width.
  const controlWidth = "sm:w-56";
  // Side by side, both sections sit on the same row tracks (CSS subgrid): the header and up to
  // five rows, so every left/right pair of rows lines up whatever its text wraps to.
  const pairedPanel = "xl:row-span-6 xl:grid xl:grid-rows-subgrid";
  const pairedBody = "xl:row-span-5 xl:grid xl:grid-rows-subgrid";
  const saveButton = (section: SettingsSection, label: string) =>
    canEdit ? (
      <Button
        aria-label={label}
        onClick={() => void saveSection(section)}
        pending={savingSection === section}
        disabled={
          savingSection !== null ||
          !dirtySections[section] ||
          settingsInvalid(sectionSettings(section))
        }
      >
        <Save className="h-4 w-4" />
        Save
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-y-0">
        <PanelShell
          icon={<GitBranch className="h-4 w-4" />}
          title="Repository"
          description="Where the code comes from and when it builds."
          dirty={dirtySections.repository}
          className={pairedPanel}
          bodyClassName={pairedBody}
          actions={
            canBuild || canEdit ? (
              <div className="flex items-center gap-2">
                {canBuild && (
                  <Button
                    variant="outline"
                    onClick={() => void syncSource()}
                    pending={syncing}
                    disabled={dirtySections.repository}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Sync now
                  </Button>
                )}
                {saveButton("repository", "Save repository settings")}
              </div>
            ) : undefined
          }
        >
          <SettingsControlRow
            title="Repository"
            description="Allowlisted project from the Git provider."
            help="The repository Opfield checks out for every build of this resource. Access comes from the selected Git integration."
          >
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{source.repositoryFullPath}</span>
            </span>
          </SettingsControlRow>
          <SettingsControlRow
            title="Git integration"
            description="Credentials used for unattended checkout."
            help="The saved Git provider connection Opfield uses to read the repository, resolve commits, receive webhooks, and download source code without an interactive login."
          >
            <Badge variant="secondary">{source.provider} integration</Badge>
          </SettingsControlRow>
          <SettingsControlRow
            title="Branch"
            description="Opfield follows new commits on this branch."
            help="Opfield watches this branch for new commits. Automatic builds use its latest accepted commit; manual builds also start from this branch."
          >
            <Input
              value={settings.branch}
              onChange={(event) => updateSetting("branch", event.target.value)}
              className={controlWidth}
              placeholder="main"
              disabled={!canEdit}
            />
          </SettingsControlRow>
          {pagesTarget && (
            <SettingsControlRow
              title="Application root"
              description="Directory holding package.json in the repo."
              help="The builder changes into this directory before installing dependencies and running the build script. Use a repository-relative path such as . or apps/web."
            >
              <Input
                value={settings.applicationRoot}
                onChange={(event) => updateSetting("applicationRoot", event.target.value)}
                className={controlWidth}
                placeholder="."
                disabled={!canEdit}
              />
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="Automatic builds"
            description="Build each new commit found on the branch."
            help="When enabled, Opfield queues a build as soon as a webhook, the poll or Sync now finds a new commit on the branch. When disabled, the repository stays connected and builds start only from Build now."
          >
            <Switch
              checked={settings.autoBuild}
              onChange={(value) => updateSetting("autoBuild", value)}
              ariaLabel="Automatic builds"
              disabled={!canEdit}
            />
          </SettingsControlRow>
        </PanelShell>

        <PanelShell
          icon={<Hammer className="h-4 w-4" />}
          title="Build"
          description={
            pagesTarget
              ? "How the Pages artifact is built and published."
              : "How it is built, checked and rolled out."
          }
          dirty={dirtySections.build}
          className={pairedPanel}
          bodyClassName={pairedBody}
          actions={
            canBuild || canEdit ? (
              <div className="flex items-center gap-2">
                {canBuild && (
                  <Button
                    variant="outline"
                    onClick={() => void triggerBuild()}
                    pending={building}
                    disabled={dirty}
                  >
                    <Play className="h-4 w-4" />
                    Build now
                  </Button>
                )}
                {saveButton("build", "Save build settings")}
              </div>
            ) : undefined
          }
        >
          {composeTarget ? (
            <SettingsControlRow
              title="Compose file"
              description="Compose file path from the repository root."
              help="The Compose file Opfield reads to find every service that declares build. All of them are built before the project is applied."
            >
              <Input
                value={settings.composeFilePath}
                onChange={(event) => updateSetting("composeFilePath", event.target.value)}
                className={controlWidth}
                placeholder="compose.yaml"
                disabled={!canEdit}
              />
            </SettingsControlRow>
          ) : pagesTarget ? (
            <>
              <SettingsControlRow
                title="Package manager"
                description="Installs dependencies and runs the script."
                help="Opfield uses this tool for dependency installation and to run the selected package.json build script inside the isolated builder."
              >
                <Select
                  value={settings.packageManager}
                  onValueChange={(value) =>
                    updateSetting("packageManager", value as PackageManager)
                  }
                  disabled={!canEdit}
                >
                  <SelectTrigger className={controlWidth} aria-label="Package manager">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="npm">npm</SelectItem>
                    <SelectItem value="pnpm">pnpm</SelectItem>
                    <SelectItem value="yarn">yarn</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsControlRow>
              <SettingsControlRow
                title="Node.js"
                description="Node.js runtime of the isolated builder."
                help="The Node.js major version available while dependencies are installed and the Pages application is built. It does not control the browser runtime."
              >
                <Select
                  value={settings.nodeVersion}
                  onValueChange={(value) => updateSetting("nodeVersion", value as NodeVersion)}
                  disabled={!canEdit}
                >
                  <SelectTrigger className={controlWidth} aria-label="Node.js version">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">Node.js 20</SelectItem>
                    <SelectItem value="22">Node.js 22</SelectItem>
                    <SelectItem value="24">Node.js 24</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsControlRow>
              <SettingsControlRow
                title="Build script"
                description="package.json script run after the install."
                help="The script name from package.json scripts, without the package-manager command. For example, enter build for npm run build."
              >
                <Input
                  value={settings.buildScript}
                  onChange={(event) => updateSetting("buildScript", event.target.value)}
                  className={controlWidth}
                  placeholder="build"
                  disabled={!canEdit}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Artifact directory"
                description="Output folder to publish, from the app root."
                help="The build output Opfield packages and serves as the Pages deployment, relative to the Application root. Typical values are dist, build, or out."
              >
                <Input
                  value={settings.artifactDirectory}
                  onChange={(event) => updateSetting("artifactDirectory", event.target.value)}
                  className={controlWidth}
                  placeholder="dist"
                  disabled={!canEdit}
                />
              </SettingsControlRow>
              <SettingsControlRow
                title="Publish Tag"
                description="Pages Tag that each successful build moves."
                help="After a successful build, Opfield publishes the new immutable deployment to this existing Tag. Routes and runtime configuration can target the Tag by name."
              >
                <Input
                  value={settings.publishTag}
                  onChange={(event) => updateSetting("publishTag", event.target.value)}
                  className={controlWidth}
                  placeholder="production"
                  disabled={!canEdit}
                />
              </SettingsControlRow>
            </>
          ) : (
            <SettingsControlRow
              title="Dockerfile and context"
              description="Paths from the repository root."
            >
              <div className="grid w-full gap-2 sm:grid-cols-2">
                <SettingsInlineControl label="Dockerfile">
                  <Input
                    value={settings.dockerfilePath}
                    onChange={(event) => updateSetting("dockerfilePath", event.target.value)}
                    placeholder="Dockerfile"
                    disabled={!canEdit}
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Build context">
                  <Input
                    value={settings.contextPath}
                    onChange={(event) => updateSetting("contextPath", event.target.value)}
                    placeholder="."
                    disabled={!canEdit}
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
          )}
          {!pagesTarget && scanningInPlan && (
            <SettingsControlRow
              title="Vulnerability policy"
              description="Lowest severity that blocks a deployment."
            >
              <Select
                value={settings.vulnerabilityThreshold}
                onValueChange={(value) =>
                  updateSetting("vulnerabilityThreshold", value as VulnerabilityThreshold)
                }
                disabled={!canEdit}
              >
                <SelectTrigger className={controlWidth} aria-label="Vulnerability policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[min(var(--container-md),var(--radix-select-content-available-width))]">
                  <SelectItem value="critical" description="Block critical findings.">
                    Critical
                  </SelectItem>
                  <SelectItem value="high" description="Block high and critical findings.">
                    High
                  </SelectItem>
                  <SelectItem
                    value="medium"
                    description="Block medium, high, and critical findings."
                  >
                    Medium
                  </SelectItem>
                  <SelectItem value="low" description="Block every known vulnerability severity.">
                    Low
                  </SelectItem>
                  <SelectItem
                    value="none"
                    description="Report findings without blocking deployment."
                  >
                    Report only
                  </SelectItem>
                  <SelectItem
                    value="disabled"
                    description="Skip vulnerability scanning and SBOM generation. Requires an updated Build Worker."
                  >
                    Disabled
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          )}
          {!pagesTarget && scanningInPlan && (
            <SettingsControlRow
              title="Vulnerability scope"
              description="Packages that can block a deployment."
            >
              <Select
                value={settings.vulnerabilityScope}
                onValueChange={(value) =>
                  updateSetting("vulnerabilityScope", value as "all" | "application")
                }
                disabled={!canEdit}
              >
                <SelectTrigger className={controlWidth} aria-label="Vulnerability scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[min(var(--container-md),var(--radix-select-content-available-width))]">
                  <SelectItem
                    value="all"
                    description="Apply the severity threshold to all packages in the image."
                  >
                    All packages
                  </SelectItem>
                  <SelectItem
                    value="application"
                    description="System packages are report-only. Application dependencies, runtime binaries and unclassified packages still count."
                  >
                    Application dependencies
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          )}
          {!pagesTarget && (
            <SettingsControlRow
              title="Automatic deployment"
              description="Roll out each approved artifact once built."
            >
              <Switch
                checked={settings.autoDeploy}
                onChange={(value) => updateSetting("autoDeploy", value)}
                ariaLabel="Automatic deployment"
                disabled={!canEdit}
              />
            </SettingsControlRow>
          )}
        </PanelShell>
      </div>

      {pagesTarget && (
        <PanelShell
          icon={<Braces className="h-4 w-4" />}
          title="Build Variables"
          description="Build-time environment values. VITE_* values are embedded in the published client bundle."
          dirty={dirtySections.variables}
          actions={
            canEdit ? (
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={openBuildVariablesText}>
                  <FileCode2 className="h-4 w-4" />
                  Edit as text
                </Button>
                <Button
                  onClick={() => {
                    setVariableName("");
                    setVariableValue("");
                    setVariableDialogOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Add variable
                </Button>
                {saveButton("variables", "Save Build Variables")}
              </div>
            ) : undefined
          }
        >
          {Object.keys(settings.buildVariables).length === 0 ? (
            <EmptyState message="No Build Variables configured." embedded />
          ) : (
            Object.entries(settings.buildVariables)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, value]) => (
                <SettingsControlRow
                  key={name}
                  title={name}
                  description={
                    name.startsWith("VITE_")
                      ? "Public in the built client bundle."
                      : "Build-time environment variable."
                  }
                  onClick={
                    canEdit
                      ? () => {
                          setVariableName(name);
                          setVariableValue(value);
                          setVariableDialogOpen(true);
                        }
                      : undefined
                  }
                >
                  {canEdit && (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setVariableName(name);
                          setVariableValue(value);
                          setVariableDialogOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeBuildVariable(name);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </SettingsControlRow>
              ))
          )}
        </PanelShell>
      )}

      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        title="Build Secrets"
        description={
          pagesTarget
            ? "Encrypted write-only values exposed to dependency installation and the selected build script. Use only with trusted repository code."
            : "Encrypted values exposed only through explicit BuildKit secret mounts."
        }
        actions={
          canEdit ? (
            <Button onClick={() => openBuildSecretDialog()}>
              <Plus className="h-4 w-4" />
              Add secret
            </Button>
          ) : undefined
        }
      >
        {buildSecrets.length === 0 ? (
          <EmptyState message="No Build Secrets configured." embedded />
        ) : (
          buildSecrets.map((secret) => (
            <SettingsControlRow
              key={secret.id}
              title={secret.name}
              description="Value is write-only and never returned by the API."
              onClick={canEdit ? () => openBuildSecretDialog(secret.name) : undefined}
            >
              {canEdit && (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Replace ${secret.name}`}
                    title={`Replace ${secret.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      openBuildSecretDialog(secret.name);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${secret.name}`}
                    pending={deletingSecretName === secret.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeBuildSecret(secret.name);
                    }}
                  >
                    {deletingSecretName !== secret.name && <Trash2 className="h-4 w-4" />}
                  </Button>
                </div>
              )}
            </SettingsControlRow>
          ))
        )}
      </PanelShell>

      <PanelShell
        icon={<History className="h-4 w-4" />}
        title="Delivery status"
        description="Resolved and currently deployed repository revisions."
      >
        <SettingsControlRow
          title="Desired commit"
          description="Newest accepted commit resolved from the configured branch."
        >
          {commitBadge(source.desiredCommitSha, "No revision resolved")}
        </SettingsControlRow>
        <SettingsControlRow
          title="Deployed commit"
          description={
            pagesTarget
              ? "Commit of the last build published to the Publish Tag."
              : "Commit currently running on this resource."
          }
        >
          {commitBadge(source.deployedCommitSha, "No build deployed")}
        </SettingsControlRow>
        <SettingsControlRow
          title="Update detection"
          description="Opfield-managed trigger used to discover new commits."
        >
          {/* Gateway polls only sources that build automatically; the rest wait for a webhook or Sync now. */}
          <Badge variant="secondary">
            {source.webhookConfiguredAt
              ? source.autoBuild
                ? "Webhook + polling"
                : "Webhook"
              : source.autoBuild
                ? "Polling"
                : "Manual"}
          </Badge>
        </SettingsControlRow>
        <SettingsControlRow
          title="Repository sync"
          description="Last successful provider event or repository reconciliation."
        >
          {source.lastPollError ? (
            <span className="text-sm text-destructive">Sync requires attention</span>
          ) : lastSync ? (
            <RelativeTime value={lastSync} className="text-sm" />
          ) : (
            <span className="text-sm text-muted-foreground">Waiting for first update</span>
          )}
        </SettingsControlRow>
        <SettingsControlRow
          title="Build inputs"
          description="Non-secret arguments and protected secrets supplied to the build."
        >
          <span className="text-right text-sm">
            <span className="block">
              {countLabel(Object.keys(source.buildArgs).length, "argument")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {countLabel(source.buildSecretNames.length, "protected secret")}
            </span>
          </span>
        </SettingsControlRow>
      </PanelShell>

      {canEdit && (
        <PanelShell
          icon={<AlertTriangle className="h-4 w-4" />}
          title="Destructive actions"
          description="These actions stop delivery from the repository."
        >
          <SettingsControlRow
            title="Disconnect repository"
            description={
              pendingContainer
                ? "Removes this pending container and its creation settings."
                : "Stops polling, webhooks, builds and automatic deployment. Runtime state and build history are kept."
            }
          >
            <Button
              variant="destructive"
              pending={disconnecting}
              onClick={() => void disconnectSource()}
            >
              <Trash2 className="h-4 w-4" />
              Disconnect repository
            </Button>
          </SettingsControlRow>
        </PanelShell>
      )}

      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {buildSecrets.some((secret) => secret.name === secretName) ? "Replace" : "Add"} Build
              Secret
            </DialogTitle>
            <DialogDescription>
              {pagesTarget
                ? "The value is exposed only to the isolated build process. VITE_* names are public and must use Build Variables."
                : "Use the same ID in the Dockerfile with RUN --mount=type=secret. Existing values cannot be revealed."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-secret-name">
                Secret ID
              </label>
              <Input
                id="build-secret-name"
                value={secretName}
                onChange={(event) => setSecretName(event.target.value)}
                placeholder="NPM_TOKEN"
                disabled={buildSecrets.some((secret) => secret.name === secretName)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-secret-value">
                Value
              </label>
              <Input
                id="build-secret-value"
                type="password"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSecretDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveBuildSecret()}
              pending={secretSaving}
              disabled={!secretName.trim() || !secretValue}
            >
              Save secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EnvTextDialog
        open={variablesTextOpen}
        onOpenChange={setVariablesTextOpen}
        title="Edit Build Variables"
        description="One NAME=value per line. Apply puts them in the list; Save Build Variables stores them."
        value={variablesText}
        onValueChange={setVariablesText}
        errorLines={variablesTextErrorLines}
        applyDisabled={variablesTextErrorLines.length > 0}
        onApply={applyBuildVariablesText}
      />
      <Dialog open={variableDialogOpen} onOpenChange={setVariableDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {Object.hasOwn(settings.buildVariables, variableName) ? "Edit" : "Add"} Build Variable
            </DialogTitle>
            <DialogDescription>
              Build Variables are readable configuration. VITE_* values are embedded in the static
              client bundle.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-variable-name">
                Name
              </label>
              <Input
                id="build-variable-name"
                value={variableName}
                onChange={(event) => setVariableName(event.target.value)}
                placeholder="VITE_API_URL"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="build-variable-value">
                Value
              </label>
              <Input
                id="build-variable-value"
                value={variableValue}
                onChange={(event) => setVariableValue(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVariableDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveBuildVariable} disabled={!variableName.trim()}>
              Save variable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={buildWorkerRequiredOpen} onOpenChange={setBuildWorkerRequiredOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a Build Worker First</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Repository builds run on a connected Build Worker. Add a Build Worker node first, then
            return here to queue the build.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuildWorkerRequiredOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setBuildWorkerRequiredOpen(false);
                navigate("/nodes");
              }}
            >
              Open Nodes <ArrowRight className="h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
