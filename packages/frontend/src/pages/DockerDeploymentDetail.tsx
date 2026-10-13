import { Code2, Pin, Play, RotateCcw, Skull, Square, Trash2, Truck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AppMembershipLink } from "@/components/apps/AppMembership";
import { MemberIsolatedNotice, useMemberIncidentHold } from "@/components/apps/IsolatedNotice";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import {
  HEADER_ACTION_PRIORITY,
  type ResponsiveHeaderAction,
  ResponsiveHeaderActions,
} from "@/components/common/ResponsiveHeaderActions";
import { SwitchCard } from "@/components/common/SwitchCard";
import {
  ALL_AVAILABILITY_INSTANCES,
  AvailabilityInstanceSelect,
} from "@/components/docker/availability/AvailabilityInstanceSelect";
import {
  AvailabilityProgress,
  isAvailabilityReplacing,
} from "@/components/docker/availability/AvailabilityProgress";
import { resolveAvailabilitySurfaceStatus } from "@/components/docker/availability/availability-status";
import { DockerMigrationDialog } from "@/components/docker/DockerMigrationDialog";
import { ImageReference } from "@/components/docker/ImageReference";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeavePage } from "@/hooks/use-navigation-trail";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { toastApiError } from "@/lib/api-error-toast";
import {
  isDockerMigrationOwnedByTab,
  resolveMigrationTarget,
} from "@/lib/docker-migration-navigation";
import { dockerDeploymentRoute } from "@/lib/resource-routes";
import { getReturnNavigationTarget, preserveReturnNavigationState } from "@/lib/return-navigation";
import { deploymentImageOrigin, shortCommitSha } from "@/lib/workload-image-label";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import type {
  DockerAvailabilityPolicy,
  DockerDeployment,
  DockerDeploymentSlot,
  DockerMigration,
  DockerSourceBinding,
  DockerWebhook,
} from "@/types";
import {
  DeploymentConfig,
  DeploymentOverview,
  DeploymentSlots,
  statusVariant,
} from "./docker-deployment-detail/DeploymentPanels";
import { DeploymentSettings } from "./docker-deployment-detail/DeploymentSettings";
import { ConsoleTab } from "./docker-detail/ConsoleTab";
import { DockerResourceGitTabs } from "./docker-detail/DockerResourceGitTabs";
import { EnvironmentTab } from "./docker-detail/EnvironmentTab";
import { FilesTab } from "./docker-detail/FilesTab";
import { buildRolloutBusyReason, type InspectData } from "./docker-detail/helpers";
import { LogsTab } from "./docker-detail/LogsTab";
import { MultiContainerMonitoring } from "./docker-detail/MultiContainerMonitoring";

const MIGRATION_RELOCATION_GRACE_MS = 2_000;

function getActiveSlot(deployment: DockerDeployment | null): DockerDeploymentSlot | null {
  if (!deployment) return null;
  return deployment.slots.find((slot) => slot.slot === deployment.activeSlot) ?? null;
}

type DeploymentSlotName = "blue" | "green";

function resolveAvailabilityActiveSlot(
  identity: Record<string, unknown>,
  fallback: string | null | undefined
): DeploymentSlotName {
  if (identity.activeSlot === "blue" || identity.activeSlot === "green") {
    return identity.activeSlot;
  }

  const slots =
    identity.slots && typeof identity.slots === "object"
      ? (identity.slots as Record<string, unknown>)
      : {};
  const activeContainerId = String(identity.containerId ?? "");
  if (activeContainerId) {
    if (
      activeContainerId === String(identity.blueContainerId ?? "") ||
      activeContainerId === String(slots.blue ?? "")
    ) {
      return "blue";
    }
    if (
      activeContainerId === String(identity.greenContainerId ?? "") ||
      activeContainerId === String(slots.green ?? "")
    ) {
      return "green";
    }
  }

  return fallback === "green" ? "green" : "blue";
}

function isTransitionStatus(status?: string | null) {
  return (
    status === "creating" ||
    status === "deploying" ||
    status === "switching" ||
    status === "starting" ||
    status === "stopping" ||
    status === "restarting" ||
    status === "killing" ||
    status === "removing" ||
    status === "deleting" ||
    status === "rolling_back"
  );
}

function transitionForAction(name: string) {
  if (name.startsWith("switch-")) return "switching";
  if (name.startsWith("stop-")) return "stopping";
  const transitionByAction: Record<string, string> = {
    deploy: "deploying",
    switch: "switching",
    rollback: "rolling_back",
    start: "starting",
    stop: "stopping",
    restart: "restarting",
    kill: "killing",
    remove: "removing",
  };
  return transitionByAction[name];
}

export function DockerDeploymentDetail({
  resolvedNodeId,
  resolvedNodeSlug,
  resolvedDeploymentId,
  resolvedDeploymentName,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
  resolvedDeploymentId?: string;
  resolvedDeploymentName?: string;
} = {}) {
  const params = useParams<{
    nodeId?: string;
    nodeSlug?: string;
    deploymentId?: string;
    deploymentName?: string;
  }>();
  const nodeId = resolvedNodeId ?? params.nodeId ?? "";
  const nodeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.nodeId ?? "";
  const deploymentId = resolvedDeploymentId ?? params.deploymentId ?? "";
  const routeDeploymentName =
    resolvedDeploymentName ?? params.deploymentName ?? params.deploymentId ?? "";
  const navigate = useStableNavigate();
  const location = useLocation();
  const backTarget = getReturnNavigationTarget(location.state, "/docker");
  const leavePage = useLeavePage();
  const leave = useCallback(() => leavePage("/docker"), [leavePage]);
  const { hasScope, hasScopedAccess } = useAuthStore();
  const hasDeploymentScope = (baseScope: string) =>
    !!nodeId && !!deploymentId && hasScope(`${baseScope}:${nodeId}/${deploymentId}`);
  const canManage = hasDeploymentScope("docker:containers:manage");
  const canDelete = hasDeploymentScope("docker:containers:delete");
  const canMigrate = hasDeploymentScope("docker:containers:migrate");
  const canEdit = hasDeploymentScope("docker:containers:edit");
  const canManageWebhooks = hasDeploymentScope("docker:containers:webhooks");
  const canViewContainer = hasDeploymentScope("docker:containers:view");
  const canUseConsole = hasDeploymentScope("docker:containers:console");
  const canReadFiles = hasDeploymentScope("docker:containers:files:read");
  const canWriteFiles = hasDeploymentScope("docker:containers:files:write");
  const canUseEnvironment = hasDeploymentScope("docker:containers:environment");
  // Managed volumes are attached with view access to each volume; docker:containers:mounts
  // covers legacy host binds and keeps the editor open to its holders.
  const canChangeHostBinds = hasDeploymentScope("docker:containers:mounts");
  const canEditMounts = canChangeHostBinds || (canEdit && hasScopedAccess("docker:volumes:view"));

  const [deployment, setDeployment] = useState<DockerDeployment | null>(null);
  // The open incident of the deployment's app environment refuses removing it (and its links).
  const {
    app: memberApp,
    reload: reloadMemberApp,
    hold: incidentHold,
  } = useMemberIncidentHold(deployment?.app);
  const [sourceIdentity, setSourceIdentity] = useState<Pick<
    DockerSourceBinding,
    "id" | "repositoryFullPath" | "deployedCommitSha"
  > | null>(null);
  const [sourceIdentityRevision, setSourceIdentityRevision] = useState(0);
  const [activeInspect, setActiveInspect] = useState<InspectData | null>(null);
  // First answers the header depends on (state badge, lifecycle actions, source line).
  const [activeInspectLoaded, setActiveInspectLoaded] = useState(false);
  const [sourceIdentityLoaded, setSourceIdentityLoaded] = useState(false);
  const planIncludesGitDeploy = usePlanIncludes("git-push-to-deploy");
  const planIncludesMigration = usePlanIncludes("cross-node-migration");
  // Source and Builds need Git push-to-deploy; an already bound source stays manageable.
  const gitTabsVisible = planIncludesGitDeploy || sourceIdentity !== null;
  const [runtimeSlotInspects, setRuntimeSlotInspects] = useState<
    Partial<Record<DeploymentSlotName, InspectData>>
  >({});
  const [webhook, setWebhook] = useState<DockerWebhook | null>(null);
  const [availabilityManaged, setAvailabilityManaged] = useState<boolean | null>(null);
  const [availabilityPolicy, setAvailabilityPolicy] = useState<DockerAvailabilityPolicy | null>(
    null
  );
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [selectedLogsPlacementId, setSelectedLogsPlacementId] = useState(
    ALL_AVAILABILITY_INSTANCES
  );
  const dockerNodes = useDockerStore((state) => state.dockerNodes);
  const [loading, setLoading] = useState(true);
  const [runtimeInspectRequest, setRuntimeInspectRequest] = useState({
    version: 0,
    noCache: true,
  });
  const [action, setAction] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [restoredMigration, setRestoredMigration] = useState<DockerMigration | null>(null);
  const migrationPresent = useDialogPresence(migrationOpen);
  useEffect(() => {
    if (!migrationPresent) setRestoredMigration(null);
  }, [migrationPresent]);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar, updateMeta } =
    usePinnedContainersStore();

  const [activeTab, setActiveTab] = useUrlTab(
    [
      "overview",
      "source",
      "builds",
      "logs",
      "console",
      "files",
      "stats",
      "environment",
      "slots",
      "settings",
      "config",
    ],
    "overview",
    (tab) => dockerDeploymentRoute(nodeSlug, routeDeploymentName, tab)
  );

  const navigationMigration = (location.state as { dockerMigration?: DockerMigration } | null)
    ?.dockerMigration;
  const migrationHandoff =
    restoredMigration ??
    (navigationMigration?.resourceType === "deployment" &&
    navigationMigration.targetNodeId === nodeId &&
    navigationMigration.deploymentId === deploymentId
      ? navigationMigration
      : null);

  const deploymentRef = useRef<DockerDeployment | null>(null);
  const cutoverSeen = useRef(false);
  const availabilityHandoff = useRef(false);
  const removalFallback = useRef<number | null>(null);
  if (migrationHandoff?.cutoverAt) cutoverSeen.current = true;
  const clearRemovalFallback = useCallback(() => {
    if (removalFallback.current === null) return;
    window.clearTimeout(removalFallback.current);
    removalFallback.current = null;
  }, []);
  const scheduleRemovalFallback = useCallback(
    (reason: "removed" | "failed") => {
      if (availabilityHandoff.current || cutoverSeen.current || removalFallback.current !== null)
        return;
      removalFallback.current = window.setTimeout(() => {
        removalFallback.current = null;
        if (availabilityHandoff.current || cutoverSeen.current) return;
        if (reason === "removed") toast.info("Deployment was removed");
        else toast.error("Failed to load deployment");
        leave();
      }, MIGRATION_RELOCATION_GRACE_MS);
    },
    [leave]
  );

  useEffect(() => () => clearRemovalFallback(), [clearRemovalFallback]);

  const handleMigrationCutover = useCallback(
    (migration: DockerMigration) => {
      if (!migration.targetNodeSlug) return;
      cutoverSeen.current = true;
      clearRemovalFallback();
      const pins = usePinnedContainersStore.getState();
      if (pins.isPinnedSidebar(deploymentId)) {
        pins.updateMeta(deploymentId, {
          nodeId: migration.targetNodeId,
          nodeSlug: migration.targetNodeSlug,
          name: migration.resourceName,
          state: deployment?.status,
          kind: "deployment",
          scopeResourceId: deploymentId,
        });
      }
      navigate(dockerDeploymentRoute(migration.targetNodeSlug, migration.resourceName, activeTab), {
        replace: true,
        state: {
          ...preserveReturnNavigationState(location.state),
          ...(isDockerMigrationOwnedByTab(migration.id) ? { dockerMigration: migration } : {}),
        },
      });
    },
    [activeTab, clearRemovalFallback, deployment?.status, deploymentId, location.state, navigate]
  );

  useEffect(() => {
    const incoming = navigationMigration;
    if (
      !incoming ||
      incoming.id === restoredMigration?.id ||
      incoming.resourceType !== "deployment" ||
      incoming.targetNodeId !== nodeId ||
      incoming.deploymentId !== deploymentId
    ) {
      return;
    }
    setRestoredMigration(incoming);
    setMigrationOpen(true);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: preserveReturnNavigationState(location.state),
    });
  }, [deploymentId, location, navigate, navigationMigration, nodeId, restoredMigration?.id]);

  const handleMigrationOpenChange = useCallback((nextOpen: boolean) => {
    setMigrationOpen(nextOpen);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setAvailabilityManaged(false);
      setAvailabilityPolicy(null);
      return;
    }
    let cancelled = false;
    setAvailabilityManaged(null);
    void api
      .getDockerAvailability({ type: "deployment", deploymentId })
      .then((policy) => {
        if (!cancelled) {
          setAvailabilityPolicy(policy);
          setAvailabilityManaged(Boolean(policy && policy.mode !== "single"));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailabilityPolicy(null);
          setAvailabilityManaged(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentId]);

  const refreshAvailability = useCallback(() => {
    if (!deploymentId) return;
    void api
      .getDockerAvailability({ type: "deployment", deploymentId })
      .then((policy) => {
        setAvailabilityPolicy(policy);
        setAvailabilityManaged(Boolean(policy && policy.mode !== "single"));
      })
      .catch(() => {
        setAvailabilityPolicy(null);
        setAvailabilityManaged(false);
      });
  }, [deploymentId]);
  useRealtime("docker.availability.changed", refreshAvailability);
  useRealtime("docker.availability.operation.changed", refreshAvailability);

  const load = useCallback(
    async (noCache = true) => {
      if (!nodeId || !deploymentId) return;
      setLoading(true);
      try {
        const next = await resolveMigrationTarget(!!migrationHandoff?.cutoverAt, () =>
          api.getDockerDeployment(nodeId, deploymentId)
        );
        deploymentRef.current = next;
        availabilityHandoff.current = false;
        setDeployment(next);
        setRuntimeInspectRequest((current) => ({
          version: current.version + 1,
          noCache,
        }));
        setWebhook(next.webhook ?? null);
        if (usePinnedContainersStore.getState().isPinnedSidebar(deploymentId)) {
          updateMeta(deploymentId, {
            nodeId,
            nodeSlug,
            name: next.name,
            state: next._transition ?? next.status,
            kind: "deployment",
            scopeResourceId: deploymentId,
          });
        }
      } catch (err) {
        if (availabilityHandoff.current) return;
        if (migrationHandoff) toast.error("Failed to load deployment");
        else if (deploymentRef.current) scheduleRemovalFallback("failed");
        else {
          toastApiError(err, "Failed to load deployment");
          leave();
        }
      } finally {
        setLoading(false);
      }
    },
    [deploymentId, migrationHandoff, leave, nodeId, nodeSlug, scheduleRemovalFallback, updateMeta]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("docker.migration.changed", (payload) => {
    const event = payload as DockerMigration;
    if (
      !event.cutoverAt ||
      event.resourceType !== "deployment" ||
      event.sourceNodeId !== nodeId ||
      event.deploymentId !== deploymentId
    ) {
      return;
    }
    handleMigrationCutover(event);
  });

  useRealtime("docker.deployment.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      action?: string;
      transition?: string;
      oldName?: string;
      name?: string;
    };
    if (event.nodeId !== nodeId || event.deploymentId !== deploymentId) return;

    if (event.oldName === routeDeploymentName && event.name) {
      navigate(dockerDeploymentRoute(nodeSlug, event.name, activeTab), {
        replace: true,
        state: location.state,
      });
      return;
    }

    if (event.action === "transitioning" && event.transition) {
      setDeployment((current) =>
        current ? { ...current, _transition: event.transition } : current
      );
      return;
    }

    if (event.action === "deleted" || event.action === "removed") {
      scheduleRemovalFallback("removed");
      return;
    }

    void load();
  });

  useRealtime("node.slug.changed", (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== nodeId || event.oldSlug !== nodeSlug || !event.slug) return;
    navigate(dockerDeploymentRoute(event.slug, routeDeploymentName, activeTab), {
      replace: true,
      state: location.state,
    });
  });

  useRealtime("docker.container.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      action?: string;
      transition?: string;
    };
    if (event.nodeId !== nodeId || event.deploymentId !== deploymentId) return;
    if (event.action === "deployment") return;

    if (event.action === "transitioning" && event.transition) {
      setDeployment((current) =>
        current ? { ...current, _transition: event.transition } : current
      );
      return;
    }

    void load();
  });

  useRealtime("docker.health.changed", (payload) => {
    const event = payload as {
      nodeId?: string;
      deploymentId?: string;
      target?: string;
    };
    if (
      event.nodeId !== nodeId ||
      event.target !== "deployment" ||
      event.deploymentId !== deploymentId
    ) {
      return;
    }

    void load();
  });

  useRealtime("docker.snapshot.changed", (payload) => {
    const event = payload as { nodeId?: string; kind?: string };
    if (event.nodeId !== nodeId || event.kind !== "containers") return;
    // The event is emitted after a fresh snapshot has already been stored.
    // Reading it from cache avoids publishing the same event again.
    void load(false);
  });

  const primaryRoute = useMemo(
    () => deployment?.routes.find((route) => route.isPrimary) ?? deployment?.routes[0] ?? null,
    [deployment]
  );
  const active = getActiveSlot(deployment);
  useEffect(() => {
    // Slot switches and realtime build events deliberately retrigger this source lookup.
    void active?.containerId;
    void sourceIdentityRevision;
    if (!nodeId || !deploymentId) {
      setSourceIdentity(null);
      setSourceIdentityLoaded(true);
      return;
    }
    let cancelled = false;
    void api
      .getDockerSource({ kind: "deployment", nodeId, deploymentId })
      .then((source) => {
        if (!cancelled)
          setSourceIdentity(
            source
              ? {
                  id: source.id,
                  repositoryFullPath: source.repositoryFullPath,
                  deployedCommitSha: source.deployedCommitSha,
                }
              : null
          );
      })
      .catch(() => {
        if (!cancelled) setSourceIdentity(null);
      })
      .finally(() => {
        if (!cancelled) setSourceIdentityLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, deploymentId, active?.containerId, sourceIdentityRevision]);
  useRealtime(
    sourceIdentity ? "docker.build.changed" : null,
    (payload) => {
      if ((payload as { sourceBindingId?: string })?.sourceBindingId === sourceIdentity?.id) {
        setSourceIdentityRevision((revision) => revision + 1);
        // A rollout starting or finishing changes whether the deployment is busy.
        void load();
      }
    },
    { onReconnect: () => setSourceIdentityRevision((revision) => revision + 1) }
  );
  const displayImage =
    [availabilityPolicy?.sourceImageReference, active?.image, deployment?.desiredConfig.image].find(
      (image) =>
        image &&
        !/^sha256:[0-9a-f]{64}$/i.test(image) &&
        !/^127\.0\.0\.1:5443\//i.test(image) &&
        !/(^|\/)gateway\/availability\//i.test(image)
    ) ??
    active?.image ??
    deployment?.desiredConfig.image;
  const activeContainerId = active?.containerId ?? "";
  const servingPlacements = useMemo(
    () =>
      (availabilityPolicy?.placements ?? [])
        .filter((placement) => placement.serving && placement.actualState === "serving")
        .sort(
          (left, right) =>
            right.generation - left.generation || left.nodeId.localeCompare(right.nodeId)
        ),
    [availabilityPolicy?.placements]
  );
  const availabilityRuntimePlacement =
    servingPlacements.find((placement) => placement.id === selectedPlacementId) ??
    servingPlacements[0];
  useEffect(() => {
    if (servingPlacements.length === 0) {
      setSelectedPlacementId(null);
      return;
    }
    if (!servingPlacements.some((placement) => placement.id === selectedPlacementId)) {
      setSelectedPlacementId(servingPlacements[0]!.id);
    }
  }, [selectedPlacementId, servingPlacements]);
  const availabilityRuntimeIdentity = useMemo(
    () => availabilityRuntimePlacement?.runtimeIdentity ?? {},
    [availabilityRuntimePlacement?.runtimeIdentity]
  );
  const availabilityRuntimeSlots = useMemo(
    () =>
      availabilityRuntimeIdentity.slots && typeof availabilityRuntimeIdentity.slots === "object"
        ? (availabilityRuntimeIdentity.slots as Record<string, unknown>)
        : {},
    [availabilityRuntimeIdentity.slots]
  );
  const availabilityRuntimeSlot = resolveAvailabilityActiveSlot(
    availabilityRuntimeIdentity,
    deployment?.activeSlot
  );
  const availabilityRuntimeContainerId = String(
    availabilityRuntimeIdentity.containerId ??
      availabilityRuntimeSlots[availabilityRuntimeSlot] ??
      ""
  );
  const runtimeNodeId = availabilityRuntimePlacement?.nodeId || nodeId;
  const runtimeContainerId = availabilityManaged
    ? availabilityRuntimeContainerId
    : activeContainerId;
  const runtimeReplacing = isAvailabilityReplacing(availabilityPolicy);
  useEffect(() => {
    // A refresh request version deliberately retriggers the same inspect target.
    void runtimeInspectRequest.version;
    if (availabilityManaged === null) return;
    if (runtimeReplacing) {
      setActiveInspectLoaded(true);
      return;
    }
    const targetNodeId = availabilityManaged ? runtimeNodeId : nodeId;
    const targetContainerId = availabilityManaged ? runtimeContainerId : activeContainerId;
    if (!targetNodeId || !targetContainerId) {
      setActiveInspect(null);
      setActiveInspectLoaded(true);
      return;
    }
    let cancelled = false;
    void api
      .inspectContainer(targetNodeId, targetContainerId, runtimeInspectRequest.noCache)
      .then((inspect) => {
        if (!cancelled) setActiveInspect(inspect);
      })
      .catch(() => {
        if (!cancelled) setActiveInspect(null);
      })
      .finally(() => {
        if (!cancelled) setActiveInspectLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeContainerId,
    availabilityManaged,
    nodeId,
    runtimeContainerId,
    runtimeInspectRequest.noCache,
    runtimeInspectRequest.version,
    runtimeReplacing,
    runtimeNodeId,
  ]);
  useEffect(() => {
    if (
      !availabilityManaged ||
      isAvailabilityReplacing(availabilityPolicy) ||
      activeTab !== "slots" ||
      !runtimeNodeId
    ) {
      setRuntimeSlotInspects({});
      return;
    }

    const entries = (["blue", "green"] as const).flatMap((slot) => {
      const containerId = String(availabilityRuntimeSlots[slot] ?? "");
      return containerId ? [[slot, containerId] as const] : [];
    });
    if (entries.length === 0) {
      setRuntimeSlotInspects({});
      return;
    }

    let cancelled = false;
    void Promise.all(
      entries.map(async ([slot, containerId]) => {
        try {
          const inspect = await api.inspectContainer(runtimeNodeId, containerId, true);
          return [slot, inspect] as const;
        } catch {
          return null;
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const next: Partial<Record<DeploymentSlotName, InspectData>> = {};
      for (const result of results) {
        if (result) next[result[0]] = result[1];
      }
      setRuntimeSlotInspects(next);
    });

    return () => {
      cancelled = true;
    };
  }, [activeTab, availabilityManaged, availabilityPolicy, availabilityRuntimeSlots, runtimeNodeId]);
  const availabilityLogSources = useMemo(
    () =>
      servingPlacements.flatMap((placement) => {
        const identity = placement.runtimeIdentity ?? {};
        const slots =
          identity.slots && typeof identity.slots === "object"
            ? (identity.slots as Record<string, unknown>)
            : {};
        const slot = resolveAvailabilityActiveSlot(identity, deployment?.activeSlot);
        const placementContainerId = String(identity.containerId ?? slots[slot] ?? "");
        if (!placementContainerId) return [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const title =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return [
          {
            channelId: placement.id,
            title,
            description: `stdout and stderr from ${title}`,
            state: "running",
            downloadFileName: `${routeDeploymentName}-${title}-logs.txt`,
            createWebSocket: (tail: number) =>
              api.createLogStreamWebSocket(placement.nodeId, placementContainerId, tail),
            getLogs: (params: { tail?: number; timestamps?: boolean }) =>
              api.getContainerLogs(placement.nodeId, placementContainerId, params),
            popoutUrl: `/docker/logs/${placement.nodeId}/${placementContainerId}`,
          },
        ];
      }),
    [deployment?.activeSlot, dockerNodes, routeDeploymentName, servingPlacements]
  );
  const monitoringInstances = useMemo(() => {
    if (availabilityManaged && servingPlacements.length > 0) {
      return servingPlacements.flatMap((placement) => {
        const identity = placement.runtimeIdentity ?? {};
        const slots =
          identity.slots && typeof identity.slots === "object"
            ? (identity.slots as Record<string, unknown>)
            : {};
        const slot = resolveAvailabilityActiveSlot(identity, deployment?.activeSlot);
        const placementContainerId = String(identity.containerId ?? slots[slot] ?? "");
        if (!placementContainerId) return [];
        const runtimeNode = dockerNodes.find((candidate) => candidate.id === placement.nodeId);
        const nodeTitle =
          runtimeNode?.displayName ||
          runtimeNode?.hostname ||
          runtimeNode?.slug ||
          placement.nodeId.slice(0, 8);
        return [
          {
            id: placement.id,
            title: nodeTitle,
            description: routeDeploymentName,
            nodeId: placement.nodeId,
            containerId: placementContainerId,
          },
        ];
      });
    }
    const runtimeNode = dockerNodes.find((candidate) => candidate.id === nodeId);
    return runtimeContainerId
      ? [
          {
            id: deploymentId,
            title: routeDeploymentName,
            description: runtimeNode?.displayName || runtimeNode?.hostname || runtimeNode?.slug,
            nodeId,
            containerId: runtimeContainerId,
            data: activeInspect ?? undefined,
          },
        ]
      : [];
  }, [
    activeInspect,
    availabilityManaged,
    deployment?.activeSlot,
    deploymentId,
    dockerNodes,
    nodeId,
    routeDeploymentName,
    runtimeContainerId,
    servingPlacements,
  ]);
  const activeBaseState =
    activeInspect?.State?.Status ?? (activeInspect?.State?.Running ? "running" : active?.status);
  const activeState = activeBaseState ?? "unknown";
  const serviceTransition = deployment?._transition;
  const unavailable = deployment?.availability === "unavailable";
  const serviceBusy = !!serviceTransition || isTransitionStatus(deployment?.status);
  // A pending source deployment rests in `creating` until its first build and
  // stays editable; any other busy state would overwrite a save when it ends.
  const awaitingFirstSourceBuild =
    deployment?.status === "creating" &&
    !serviceTransition &&
    deployment.slots.every((slot) => !slot.containerId && !slot.image);
  // A build rollout owns the deployment from acceptance, before its deploy
  // starts and between deploy and switch; the server refuses saves until then.
  const buildRolloutReason = buildRolloutBusyReason(deployment?._buildRollout, "deployment");
  const settingsBusyReason =
    buildRolloutReason ??
    (serviceBusy && !awaitingFirstSourceBuild
      ? `Deployment is ${(serviceTransition ?? deployment?.status ?? "busy").replaceAll("_", " ")}; wait for it to finish`
      : null);
  const serviceState =
    serviceTransition ??
    (deployment?.status === "ready"
      ? activeState === "unknown"
        ? "running"
        : activeState
      : (deployment?.status ?? activeState));
  const availabilityServing =
    (availabilityPolicy?.placements ?? []).filter(
      (placement) => placement.serving && placement.actualState === "serving"
    ).length ?? 0;
  const availabilityDesired =
    availabilityPolicy?.mode === "replicated" ? availabilityPolicy.desiredReplicaCount : 1;
  const availabilitySurfaceStatus =
    availabilityManaged && availabilityPolicy
      ? resolveAvailabilitySurfaceStatus({
          policyStatus: availabilityPolicy.status,
          operation: availabilityPolicy.latestOperation,
          shouldRun: availabilityPolicy.shouldRun,
          serving: availabilityServing,
          desired: availabilityDesired,
        })
      : null;
  const environmentWorkloadState =
    availabilityManaged && availabilityPolicy
      ? availabilityPolicy.shouldRun
        ? "running"
        : "stopped"
      : activeState;
  const availabilityTransition =
    availabilitySurfaceStatus &&
    ["rolling_out", "starting", "stopping", "restarting"].includes(availabilitySurfaceStatus)
      ? availabilitySurfaceStatus
      : null;
  const logicalServiceState =
    availabilityManaged && availabilityPolicy ? availabilitySurfaceStatus : serviceState;
  const logicalHealthStatus =
    availabilityManaged && availabilityPolicy
      ? !availabilityPolicy.shouldRun
        ? "stopped"
        : availabilityTransition
          ? "online"
          : availabilityServing === 0
            ? "offline"
            : availabilityServing < availabilityDesired
              ? "degraded"
              : "online"
      : deployment?.healthCheck?.healthStatus;
  const canEmergencyKill = !["created", "exited", "offline"].includes(
    String(logicalServiceState).toLowerCase()
  );
  const isRunning = activeState === "running";
  const effectiveIsRunning = availabilityManaged
    ? Boolean(availabilityPolicy?.shouldRun && availabilityServing > 0)
    : isRunning;
  const isStopped = availabilityManaged
    ? !availabilityPolicy?.shouldRun
    : deployment?.status === "stopped" || !isRunning;
  const isTerminalTab = activeTab === "logs" || activeTab === "console";
  const serviceEnv = useMemo(() => {
    return deployment?.desiredConfig.env ?? {};
  }, [deployment?.desiredConfig.env]);
  const drainingSlot = useMemo(
    () =>
      deployment?.slots.find(
        (slot) => slot.slot !== deployment.activeSlot && slot.status === "draining"
      ),
    [deployment]
  );

  const visibleTabs = useMemo(
    () => [
      "overview",
      // Keep the Source and Builds tabs reachable until the bound-source lookup settles.
      ...(gitTabsVisible || !sourceIdentityLoaded ? ["source", "builds"] : []),
      ...(canViewContainer ? ["logs"] : []),
      ...(canUseConsole ? ["console"] : []),
      ...(canReadFiles ? ["files"] : []),
      ...(canViewContainer ? ["stats"] : []),
      ...(canUseEnvironment ? ["environment"] : []),
      "slots",
      ...(canEdit ? ["settings"] : []),
    ],
    [
      canEdit,
      canReadFiles,
      canUseConsole,
      canUseEnvironment,
      canViewContainer,
      gitTabsVisible,
      sourceIdentityLoaded,
    ]
  );

  const isTabDisabled = useCallback(
    (tabName: string) => {
      if (runtimeReplacing && ["console", "files", "logs", "stats"].includes(tabName)) return true;
      if (
        unavailable &&
        !availabilityManaged &&
        ["logs", "console", "files", "stats", "environment", "settings"].includes(tabName)
      ) {
        return true;
      }
      if (!runtimeContainerId) return ["logs", "console", "files", "stats"].includes(tabName);
      return (
        ["console", "files", "stats"].includes(tabName) &&
        (!effectiveIsRunning || (!availabilityManaged && serviceBusy))
      );
    },
    [
      availabilityManaged,
      effectiveIsRunning,
      runtimeContainerId,
      runtimeReplacing,
      serviceBusy,
      unavailable,
    ]
  );

  useEffect(() => {
    if (unavailable && activeTab === "settings" && availabilityManaged === null) return;
    if (availabilityManaged === null && ["logs", "console", "files", "stats"].includes(activeTab)) {
      return;
    }
    if (activeTab === "config") {
      setConfigOpen(true);
      setActiveTab("overview");
      return;
    }
    if (!visibleTabs.includes(activeTab) || isTabDisabled(activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, availabilityManaged, isTabDisabled, setActiveTab, unavailable, visibleTabs]);

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setAction(name);
    const transition = transitionForAction(name);
    if (transition) {
      setDeployment((current) => (current ? { ...current, _transition: transition } : current));
    }
    try {
      await fn();
      await load();
    } catch (err) {
      if (!handleLicenseApiError(err, "Secure Runtime")) {
        toastApiError(err, "Deployment action failed");
      }
      await load().catch(() => {
        if (transition) {
          setDeployment((current) =>
            current?._transition === transition ? { ...current, _transition: undefined } : current
          );
        }
      });
    } finally {
      setAction(null);
    }
  };

  // Saved variables reach the slots only through a rollout, so a serving
  // deployment deploys them; a stopped one picks them up when it starts.
  // Saving needs only environment; without manage the next deploy rolls them out.
  const environmentRollsOut =
    canManage &&
    (environmentWorkloadState === "running" || environmentWorkloadState === "restarting") &&
    deployment?.status !== "creating";
  const saveServiceEnv = useCallback(
    async (env: Record<string, string>) => {
      const next = await api.updateDockerDeployment(nodeId, deploymentId, {
        desiredConfig: { env },
      });
      setDeployment(next);
      setWebhook(next.webhook ?? null);
      if (!environmentRollsOut) return;
      setDeployment((current) => (current ? { ...current, _transition: "deploying" } : current));
      try {
        await api.deployDockerDeployment(nodeId, deploymentId, {});
      } finally {
        await load();
      }
    },
    [deploymentId, environmentRollsOut, load, nodeId]
  );

  const removeDeployment = async () => {
    if (!deployment) return;
    const ok = await confirm({
      title: "Remove Deployment",
      description: `Remove "${deployment.name}"? This will remove the router, slot containers, and deployment network.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    await runAction("remove", async () => {
      await api.deleteDockerDeployment(nodeId, deployment.id);
      usePinnedContainersStore.getState().removePin(deployment.id);
      toast.success("Deployment removed");
      leave();
    });
  };

  const headerDataLoading =
    availabilityManaged === null || !sourceIdentityLoaded || !activeInspectLoaded;

  if (loading && !deployment) return <DetailPageSkeleton label="Loading deployment" tabs={5} />;

  if (!deployment) return null;

  const actionDisabled = !!action || serviceBusy || unavailable || !!buildRolloutReason;
  const deploymentHasGpu = (deployment.desiredConfig.gpu?.deviceIds ?? []).length > 0;
  const migrationDisabledReason = deploymentHasGpu
    ? "GPU-attached deployments cannot be migrated in this version"
    : (buildRolloutReason ??
      (actionDisabled ? "Deployment is unavailable or changing state" : undefined));
  const headerActions: Array<ResponsiveHeaderAction & { actionKey?: string }> = [
    {
      label: "View config",
      icon: <Code2 className="h-4 w-4" />,
      onClick: () => setConfigOpen(true),
      alwaysOverflow: true,
    },
    {
      label: "Pin",
      icon: <Pin className="h-4 w-4" />,
      onClick: () => setPinOpen(true),
    },
    ...(planIncludesMigration && canMigrate && availabilityManaged === false
      ? [
          {
            label: "Migrate",
            icon: <Truck className="h-4 w-4" />,
            onClick: () => {
              if (!requireLicenseFeature("cross-node-migration", "Cross-node migration")) return;
              setMigrationOpen(true);
            },
            disabled: Boolean(migrationDisabledReason),
            disabledReason: migrationDisabledReason,
          },
        ]
      : []),
    ...(isStopped && canManage
      ? [
          {
            label: "Start",
            actionKey: "start",
            icon: <Play className="h-4 w-4" />,
            onClick: () =>
              runAction("start", async () => {
                await api.startDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment started");
              }),
            disabled: actionDisabled,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
        ]
      : []),
    ...(!isStopped && canManage
      ? [
          {
            label: "Stop",
            actionKey: "stop",
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              runAction("stop", async () => {
                await api.stopDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment stopped");
              }),
            disabled: actionDisabled,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
          {
            label: "Restart",
            actionKey: "restart",
            icon: <RotateCcw className="h-4 w-4" />,
            onClick: () =>
              runAction("restart", async () => {
                await api.restartDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment restarted");
              }),
            disabled: actionDisabled,
            priority: HEADER_ACTION_PRIORITY.primary,
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            label: "Rollback",
            actionKey: "rollback",
            icon: <RotateCcw className="h-4 w-4" />,
            onClick: () =>
              runAction("rollback", async () => {
                await api.rollbackDockerDeployment(nodeId, deployment.id);
                toast.success("Rollback started");
              }),
            disabled: actionDisabled,
            separatorBefore: true,
          },
        ]
      : []),
    ...(!isStopped && canManage && drainingSlot?.containerId
      ? [
          {
            label: "Stop draining slot",
            actionKey: `stop-${drainingSlot.slot}`,
            icon: <Square className="h-4 w-4" />,
            onClick: () =>
              runAction(`stop-${drainingSlot.slot}`, async () => {
                await api.stopDockerDeploymentSlot(nodeId, deployment.id, drainingSlot.slot);
                toast.success("Draining slot stopped");
              }),
            disabled: actionDisabled,
          },
        ]
      : []),
    ...(canManage
      ? [
          {
            label: "Kill",
            actionKey: "kill",
            icon: <Skull className="h-4 w-4" />,
            onClick: () =>
              runAction("kill", async () => {
                await api.killDockerDeployment(nodeId, deployment.id);
                toast.success("Deployment killed");
              }),
            disabled: unavailable || !canEmergencyKill,
            destructive: true,
            separatorBefore: !drainingSlot?.containerId,
            priority: HEADER_ACTION_PRIORITY.emergency,
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            label: "Remove",
            actionKey: "remove",
            icon: <Trash2 className="h-4 w-4" />,
            onClick: removeDeployment,
            disabled: actionDisabled || incidentHold.kept !== null,
            disabledReason: incidentHold.kept ?? undefined,
            destructive: true,
            separatorBefore: isStopped || !canManage,
          },
        ]
      : []),
  ];
  return (
    <PageTransition>
      <div
        className={`h-full p-6 flex flex-col gap-4 ${
          isTerminalTab ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        <ContentLoading loading={headerDataLoading} />
        <PageHeader
          className="shrink-0"
          leading={<PageBackButton onClick={() => navigate(backTarget)} />}
          title={deployment.name}
          badges={
            unavailable && !availabilityManaged ? (
              <Badge variant="secondary" size="inline" className="shrink-0">
                Unavailable
              </Badge>
            ) : (
              <>
                <Badge
                  variant={statusVariant(logicalServiceState)}
                  size="inline"
                  className="shrink-0"
                >
                  {String(logicalServiceState).replaceAll("_", " ")}
                </Badge>
                <Badge variant="outline" size="inline" className="shrink-0">
                  blue/green
                </Badge>
              </>
            )
          }
          description={
            sourceIdentity ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{sourceIdentity.repositoryFullPath}</span>
                {sourceIdentity.deployedCommitSha ? (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span className="shrink-0 font-mono">
                      {shortCommitSha(sourceIdentity.deployedCommitSha)}
                    </span>
                  </>
                ) : null}
                <span className="shrink-0">&middot; active {deployment.activeSlot}</span>
                {deployment.app ? (
                  <span className="shrink-0">
                    &middot; <AppMembershipLink app={deployment.app} />
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <ImageReference
                  value={displayImage}
                  {...deploymentImageOrigin(deployment, displayImage)}
                  copyable={false}
                  className="justify-start"
                />
                <span className="shrink-0">&middot; active {deployment.activeSlot}</span>
                {deployment.app ? (
                  <span className="shrink-0">
                    &middot; <AppMembershipLink app={deployment.app} />
                  </span>
                ) : null}
              </span>
            )
          }
          actions={
            <ResponsiveHeaderActions actions={headerActions}>
              {headerActions.map((headerAction) => {
                const pending = !!headerAction.actionKey && action === headerAction.actionKey;
                return (
                  <Button
                    key={headerAction.label}
                    variant="outline"
                    size={headerAction.label === "Pin" ? "icon" : "default"}
                    disabled={headerAction.disabled}
                    pending={pending}
                    title={
                      headerAction.disabled
                        ? (headerAction.disabledReason ?? buildRolloutReason ?? undefined)
                        : undefined
                    }
                    onClick={headerAction.onClick}
                  >
                    {pending ? null : headerAction.icon}
                    {headerAction.label === "Pin" ? null : headerAction.label}
                  </Button>
                );
              })}
            </ResponsiveHeaderActions>
          }
        />

        <MemberIsolatedNotice
          app={deployment.app}
          memberApp={memberApp}
          onChanged={reloadMemberApp}
        />

        {deployment.healthCheck?.enabled && (
          <HealthBars
            history={deployment.healthCheck.healthHistory}
            currentStatus={logicalHealthStatus ?? deployment.healthCheck.healthStatus}
          />
        )}

        <AvailabilityProgress policy={availabilityPolicy} />
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="overview" className="gap-1.5">
              Overview
            </TabsTrigger>
            {gitTabsVisible && (
              <TabsTrigger value="source" className="gap-1.5">
                Source
              </TabsTrigger>
            )}
            {gitTabsVisible && (
              <TabsTrigger value="builds" className="gap-1.5">
                Builds
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="logs" disabled={isTabDisabled("logs")} className="gap-1.5">
                Logs
              </TabsTrigger>
            )}
            {canUseConsole && (
              <TabsTrigger value="console" disabled={isTabDisabled("console")} className="gap-1.5">
                Console
              </TabsTrigger>
            )}
            {canReadFiles && (
              <TabsTrigger value="files" disabled={isTabDisabled("files")} className="gap-1.5">
                Files
              </TabsTrigger>
            )}
            {canViewContainer && (
              <TabsTrigger value="stats" disabled={isTabDisabled("stats")} className="gap-1.5">
                Monitoring
              </TabsTrigger>
            )}
            {canUseEnvironment && (
              <TabsTrigger value="environment" className="gap-1.5">
                Environment
              </TabsTrigger>
            )}
            <TabsTrigger value="slots" className="gap-1.5">
              Slots
            </TabsTrigger>
            {canEdit && (
              <TabsTrigger value="settings" className="gap-1.5">
                Settings
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="overview" className="pb-0">
            <DeploymentOverview
              deployment={deployment}
              active={active}
              serviceState={serviceState}
              activeState={activeState}
              primaryRoute={primaryRoute}
              sourceImageReference={availabilityPolicy?.sourceImageReference}
            />
          </TabsContent>
          <TabsContent value="source" className="pb-6">
            <DockerResourceGitTabs
              target={{ kind: "deployment", nodeId, deploymentId }}
              view="source"
            />
          </TabsContent>
          <TabsContent value="builds" className="flex min-h-0 flex-1 flex-col pb-0">
            <DockerResourceGitTabs
              target={{ kind: "deployment", nodeId, deploymentId }}
              view="builds"
            />
          </TabsContent>
          {canViewContainer &&
            !runtimeReplacing &&
            availabilityManaged !== null &&
            runtimeContainerId &&
            (!unavailable || Boolean(availabilityManaged)) && (
              <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 pb-0">
                {availabilityManaged && servingPlacements.length > 1 ? (
                  <LogsTab
                    {...(selectedLogsPlacementId === ALL_AVAILABILITY_INSTANCES
                      ? { sources: availabilityLogSources }
                      : {
                          source:
                            availabilityLogSources.find(
                              (source) => source.channelId === selectedLogsPlacementId
                            ) ?? availabilityLogSources[0]!,
                        })}
                    headerActions={
                      <AvailabilityInstanceSelect
                        placements={servingPlacements}
                        nodes={dockerNodes}
                        value={selectedLogsPlacementId}
                        onValueChange={setSelectedLogsPlacementId}
                        includeAll
                      />
                    }
                  />
                ) : (
                  <LogsTab
                    nodeId={runtimeNodeId}
                    containerId={runtimeContainerId}
                    containerState={activeState}
                    inspectData={activeInspect ?? undefined}
                  />
                )}
              </TabsContent>
            )}
          {canUseConsole &&
            !runtimeReplacing &&
            availabilityManaged !== null &&
            runtimeContainerId &&
            (!unavailable || Boolean(availabilityManaged)) && (
              <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
                <ConsoleTab
                  nodeId={runtimeNodeId}
                  containerId={runtimeContainerId}
                  scopeResourceId={deploymentId}
                  scopeNodeId={nodeId}
                  headerActions={
                    servingPlacements.length > 1 ? (
                      <AvailabilityInstanceSelect
                        placements={servingPlacements}
                        nodes={dockerNodes}
                        value={availabilityRuntimePlacement?.id ?? servingPlacements[0]!.id}
                        onValueChange={setSelectedPlacementId}
                      />
                    ) : undefined
                  }
                />
              </TabsContent>
            )}
          {canReadFiles &&
            !runtimeReplacing &&
            availabilityManaged !== null &&
            runtimeContainerId &&
            (!unavailable || Boolean(availabilityManaged)) && (
              <TabsContent value="files" className="pb-0">
                <FilesTab
                  nodeId={runtimeNodeId}
                  containerId={runtimeContainerId}
                  scopeResourceId={deploymentId}
                  scopeNodeId={nodeId}
                  canWrite={canWriteFiles}
                  headerActions={
                    servingPlacements.length > 1 ? (
                      <AvailabilityInstanceSelect
                        placements={servingPlacements}
                        nodes={dockerNodes}
                        value={availabilityRuntimePlacement?.id ?? servingPlacements[0]!.id}
                        onValueChange={setSelectedPlacementId}
                      />
                    ) : undefined
                  }
                />
              </TabsContent>
            )}
          {canViewContainer &&
            availabilityManaged !== null &&
            runtimeContainerId &&
            (!unavailable || Boolean(availabilityManaged)) && (
              <TabsContent value="stats" className="pb-0">
                <MultiContainerMonitoring instances={monitoringInstances} />
              </TabsContent>
            )}
          {canUseEnvironment && (!unavailable || Boolean(availabilityManaged)) && (
            <TabsContent value="environment" className="pb-0">
              <EnvironmentTab
                nodeId={nodeId}
                containerId={deployment.id}
                containerName={deployment.name}
                scopeResourceId={deploymentId}
                containerState={environmentWorkloadState}
                serviceEnv={serviceEnv}
                onSaveServiceEnv={saveServiceEnv}
                serviceSaveLabel={environmentRollsOut ? "Save & Deploy" : "Save"}
                serviceSaveDescription={
                  environmentRollsOut
                    ? "Environment changes deploy to the standby slot, and traffic switches once it is healthy. Continue?"
                    : undefined
                }
                databaseTargetType="deployment"
                databaseTargetResourceId={deploymentId}
                linkRemovalDisabledReason={incidentHold.kept}
              />
            </TabsContent>
          )}
          <TabsContent value="slots" className="pb-0">
            <DeploymentSlots
              deployment={deployment}
              nodeId={nodeId}
              action={action}
              serviceBusy={serviceBusy || unavailable}
              runAction={runAction}
              canManage={canManage && !unavailable}
              activeSlotOverride={availabilityManaged ? availabilityRuntimeSlot : undefined}
              slotInspects={availabilityManaged ? runtimeSlotInspects : undefined}
              sourceImageReference={availabilityPolicy?.sourceImageReference}
            />
          </TabsContent>
          {canEdit && (!unavailable || availabilityManaged) && (
            <TabsContent value="settings" className="pb-0">
              <DeploymentSettings
                deployment={deployment}
                nodeId={nodeId}
                action={action}
                webhook={webhook}
                setWebhook={setWebhook}
                onHealthCheckSaved={(healthCheck) =>
                  setDeployment((current) => (current ? { ...current, healthCheck } : current))
                }
                canEditMounts={canEditMounts}
                canChangeHostBinds={canChangeHostBinds}
                availabilityManaged={Boolean(availabilityManaged)}
                availabilitySourceImageReference={availabilityPolicy?.sourceImageReference}
                busyReason={settingsBusyReason}
                canManageWebhooks={canManageWebhooks}
                runAction={runAction}
                onAvailabilityDisableQueued={({ nodeSlug: survivorNodeSlug }) => {
                  availabilityHandoff.current = true;
                  clearRemovalFallback();
                  navigate(
                    dockerDeploymentRoute(survivorNodeSlug, routeDeploymentName, "settings"),
                    { replace: true }
                  );
                }}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-4xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Deployment Configuration</DialogTitle>
          </DialogHeader>
          <DeploymentConfig deployment={deployment} editorHeight="min(60dvh, 640px)" />
        </DialogContent>
      </Dialog>
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pin Deployment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SwitchCard
              label="Add to dashboard"
              description="Show compact status on the dashboard"
              checked={isPinnedDashboard(deployment.id)}
              onCheckedChange={() => {
                toggleDashboard(deployment.id, {
                  nodeId,
                  nodeSlug,
                  name: deployment.name,
                  state: deployment._transition ?? deployment.status,
                  kind: "deployment",
                  scopeResourceId: deployment.id,
                });
                usePinnedContainersStore.getState().invalidate();
              }}
            />
            <SwitchCard
              label="Add to sidebar"
              description="Quick access link in the sidebar"
              checked={isPinnedSidebar(deployment.id)}
              onCheckedChange={() => {
                toggleSidebar(deployment.id, {
                  nodeId,
                  nodeSlug,
                  name: deployment.name,
                  state: deployment._transition ?? deployment.status,
                  kind: "deployment",
                  scopeResourceId: deployment.id,
                });
                usePinnedContainersStore.getState().invalidate();
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <DockerMigrationDialog
        open={migrationOpen}
        onOpenChange={handleMigrationOpenChange}
        onCutover={handleMigrationCutover}
        initialMigration={restoredMigration}
        resource={{
          type: "deployment",
          nodeId,
          deploymentId: deployment.id,
          displayName: deployment.name,
          sourceState: isStopped ? "stopped" : "running",
        }}
      />
    </PageTransition>
  );
}
