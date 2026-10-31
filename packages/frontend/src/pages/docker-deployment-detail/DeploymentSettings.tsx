import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { AvailabilitySection } from "@/components/docker/availability/AvailabilitySection";
import { DockerHealthCheckSection } from "@/components/docker/DockerHealthCheckSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stripRegistryHostFromImageName } from "@/lib/docker-image-ref";
import {
  type DockerRuntimeCapacity,
  loadDockerRuntimeCapacity,
  UNKNOWN_DOCKER_RUNTIME_CAPACITY,
} from "@/lib/docker-runtime-capacity";
import {
  DEFAULT_DOCKER_RUNTIME_DESCRIPTION,
  getSecureDockerRuntimeDescription,
} from "@/lib/docker-runtime-profile";
import { formatShellWords, parseShellWords } from "@/lib/shell-words";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { requireLicenseFeature, usePlanIncludes } from "@/stores/license-paywall";
import {
  type DockerDeployment,
  type DockerHealthCheck,
  type DockerRuntimeProfile,
  type DockerWebhook,
  gpuDeviceLabel,
  type NodeGpuDevice,
} from "@/types";
import { formatBytes } from "../docker-detail/helpers";
import { LabelsSection } from "../docker-detail/LabelsSection";
import { type PortMapping, PortMappingsSection } from "../docker-detail/PortMappingsSection";
import { type RuntimeFieldErrors, RuntimeSection } from "../docker-detail/RuntimeSection";
import { WebhookSection } from "../docker-detail/SettingsTab";
import {
  ensureManagedMountVolumes,
  type MountEntry,
  serializeMounts,
  VolumeMountsSection,
} from "../docker-detail/VolumeMountsSection";

const EMPTY_GPU_DEVICE_IDS: string[] = [];

function splitImageRef(imageRef: string) {
  const digestIndex = imageRef.indexOf("@");
  if (digestIndex >= 0) {
    return { imageName: imageRef, tag: "" };
  }

  const lastColon = imageRef.lastIndexOf(":");
  const lastSlash = imageRef.lastIndexOf("/");
  if (lastColon === -1 || lastSlash > lastColon) {
    return { imageName: imageRef, tag: "" };
  }

  return { imageName: imageRef.slice(0, lastColon), tag: imageRef.slice(lastColon + 1) };
}

function joinImageRef(imageName: string, tag: string) {
  return tag.trim() ? `${imageName}:${tag.trim()}` : imageName;
}

function parseOptionalNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeMounts(mounts: unknown): MountEntry[] {
  if (!Array.isArray(mounts)) return [];
  return mounts.map((mount) => {
    const value = mount as Partial<MountEntry>;
    return {
      hostPath: value.hostPath ?? "",
      containerPath: value.containerPath ?? "",
      name: value.name ?? "",
      readOnly: value.readOnly ?? false,
      existing: true,
    };
  });
}

function normalizeLabels(labels: unknown): Array<{ key: string; value: string }> {
  return Object.entries((labels ?? {}) as Record<string, string>).map(([key, value]) => ({
    key,
    value,
  }));
}

function normalizeGpuDeviceIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function DeploymentSettings({
  deployment,
  nodeId,
  action,
  webhook,
  setWebhook,
  onHealthCheckSaved,
  canEditMounts,
  canChangeHostBinds,
  availabilityManaged = false,
  canManageWebhooks,
  runAction,
  onAvailabilityDisableQueued,
  availabilitySourceImageReference,
  busyReason = null,
}: {
  deployment: DockerDeployment;
  nodeId: string;
  action: string | null;
  webhook: DockerWebhook | null;
  setWebhook: (webhook: DockerWebhook | null) => void;
  onHealthCheckSaved: (healthCheck: DockerHealthCheck) => void;
  canEditMounts: boolean;
  canChangeHostBinds: boolean;
  availabilityManaged?: boolean;
  canManageWebhooks: boolean;
  runAction: (name: string, fn: () => Promise<void>) => Promise<void>;
  onAvailabilityDisableQueued?: (survivor: { nodeId: string; nodeSlug: string }) => void;
  availabilitySourceImageReference?: string | null;
  /** Set while the server reports a running operation that would overwrite a save. */
  busyReason?: string | null;
}) {
  // Same gate as the Availability routes: docker:availability:manage on this deployment (folder grants resolve to it).
  const canManageAvailability = useAuthStore((state) =>
    state.hasScope(`docker:availability:manage:${nodeId}/${deployment.id}`)
  );
  const initialEntrypoint = useMemo(
    () => formatShellWords((deployment.desiredConfig as any).entrypoint ?? []),
    [deployment.desiredConfig]
  );
  const initialCommand = useMemo(
    () => formatShellWords((deployment.desiredConfig as any).command ?? []),
    [deployment.desiredConfig]
  );
  const initialWorkingDir = (deployment.desiredConfig as any).workingDir ?? "";
  const initialUser = (deployment.desiredConfig as any).user ?? "";
  const initialPorts = useMemo(
    () =>
      deployment.routes.map((route) => ({
        hostPort: String(route.hostPort),
        containerPort: String(route.containerPort),
        protocol: "tcp" as const,
      })),
    [deployment.routes]
  );
  const initialReadinessRouteIndex = useMemo(() => {
    const index = deployment.routes.findIndex((route) => route.isPrimary);
    return index >= 0 ? index : 0;
  }, [deployment.routes]);
  const initialMounts = useMemo(
    () => normalizeMounts((deployment.desiredConfig as any).mounts),
    [deployment.desiredConfig]
  );
  const initialLabels = useMemo(
    () => normalizeLabels((deployment.desiredConfig as any).labels),
    [deployment.desiredConfig]
  );
  const runtime = ((deployment.desiredConfig as any).runtime ?? {}) as Record<string, any>;
  const desiredGpuDeviceIds = deployment.desiredConfig.gpu?.deviceIds ?? EMPTY_GPU_DEVICE_IDS;
  const savedRuntimeProfile = deployment.desiredConfig.runtimeProfile ?? "default";
  // The runtime choice needs Secure Runtime; a deployment already on it keeps the choice.
  const secureRuntimeLicensed = usePlanIncludes("secure-runtime");
  const runtimeChoiceVisible = secureRuntimeLicensed || savedRuntimeProfile === "secure";
  const initialGpuDeviceIds = useMemo(
    () => normalizeGpuDeviceIds(desiredGpuDeviceIds),
    [desiredGpuDeviceIds]
  );
  const editableImageReference = useMemo(() => {
    const configuredImage = deployment.desiredConfig.image;
    const sourceImage = availabilitySourceImageReference?.trim();
    if (
      sourceImage &&
      !/^sha256:[0-9a-f]{64}$/i.test(sourceImage) &&
      !/^127\.0\.0\.1:5443\//i.test(sourceImage)
    ) {
      return sourceImage;
    }
    const activeImage = deployment.slots
      .find((slot) => slot.slot === deployment.activeSlot)
      ?.image?.trim();
    if (
      /^sha256:[0-9a-f]{64}$/i.test(configuredImage) &&
      activeImage &&
      !/^sha256:/i.test(activeImage)
    ) {
      return activeImage;
    }
    return availabilityManaged && activeImage ? activeImage : configuredImage;
  }, [
    availabilityManaged,
    availabilitySourceImageReference,
    deployment.activeSlot,
    deployment.desiredConfig.image,
    deployment.slots,
  ]);
  const desiredImageParts = useMemo(
    () => splitImageRef(editableImageReference),
    [editableImageReference]
  );
  const deploymentBaseline = useMemo(
    () => ({
      imageName: desiredImageParts.imageName,
      imageTag: desiredImageParts.tag,
      entrypoint: initialEntrypoint,
      command: initialCommand,
      workingDir: initialWorkingDir,
      user: initialUser,
      ports: JSON.stringify(initialPorts),
      readinessRouteIndex: initialReadinessRouteIndex,
      mounts: serializeMounts(initialMounts),
      labels: JSON.stringify(initialLabels),
      restartPolicy: deployment.desiredConfig.restartPolicy ?? "unless-stopped",
      maxRetries: String(runtime.maxRetries ?? 0),
      memoryMB: runtime.memoryMB ? String(runtime.memoryMB) : "",
      memSwapMB: runtime.memSwapMB ? String(runtime.memSwapMB) : "",
      cpuCount: runtime.cpuCount ? String(runtime.cpuCount) : "",
      cpuShares: runtime.cpuShares ? String(runtime.cpuShares) : "",
      pidsLimit: runtime.pidsLimit ? String(runtime.pidsLimit) : "",
      drainSeconds: String(deployment.drainSeconds),
      gpuDeviceIds: JSON.stringify(initialGpuDeviceIds),
      runtimeProfile: savedRuntimeProfile,
    }),
    [
      deployment.desiredConfig.restartPolicy,
      deployment.drainSeconds,
      desiredImageParts.imageName,
      desiredImageParts.tag,
      initialCommand,
      initialEntrypoint,
      initialLabels,
      initialMounts,
      initialPorts,
      initialReadinessRouteIndex,
      initialGpuDeviceIds,
      initialUser,
      initialWorkingDir,
      runtime.cpuCount,
      runtime.cpuShares,
      runtime.maxRetries,
      runtime.memSwapMB,
      runtime.memoryMB,
      runtime.pidsLimit,
      savedRuntimeProfile,
    ]
  );
  const [imageTag, setImageTag] = useState(desiredImageParts.tag);
  const [entrypoint, setEntrypoint] = useState(initialEntrypoint);
  const [command, setCommand] = useState(initialCommand);
  const [workingDir, setWorkingDir] = useState(initialWorkingDir);
  const [user, setUser] = useState(initialUser);
  const [ports, setPorts] = useState<PortMapping[]>(initialPorts);
  const [readinessRouteIndex, setReadinessRouteIndex] = useState(initialReadinessRouteIndex);
  const [mounts, setMounts] = useState<MountEntry[]>(initialMounts);
  const [labels, setLabels] = useState<Array<{ key: string; value: string }>>(initialLabels);
  const [restartPolicy, setRestartPolicy] = useState(
    deployment.desiredConfig.restartPolicy ?? "unless-stopped"
  );
  const [maxRetries, setMaxRetries] = useState(String(runtime.maxRetries ?? 0));
  const [memoryMB, setMemoryMB] = useState(runtime.memoryMB ? String(runtime.memoryMB) : "");
  const [memSwapMB, setMemSwapMB] = useState(runtime.memSwapMB ? String(runtime.memSwapMB) : "");
  const [cpuCount, setCpuCount] = useState(runtime.cpuCount ? String(runtime.cpuCount) : "");
  const [cpuShares, setCpuShares] = useState(runtime.cpuShares ? String(runtime.cpuShares) : "");
  const [pidsLimit, setPidsLimit] = useState(runtime.pidsLimit ? String(runtime.pidsLimit) : "");
  const [drainSeconds, setDrainSeconds] = useState(String(deployment.drainSeconds));
  const [gpuDeviceIds, setGpuDeviceIds] = useState(initialGpuDeviceIds);
  const [runtimeProfile, setRuntimeProfile] = useState<DockerRuntimeProfile>(savedRuntimeProfile);
  const [secureRuntimeAvailable, setSecureRuntimeAvailable] = useState(
    savedRuntimeProfile === "secure"
  );
  const [gpuDevices, setGpuDevices] = useState<NodeGpuDevice[]>([]);
  const [gpuInventoryLoaded, setGpuInventoryLoaded] = useState(false);
  const [runtimeCapacity, setRuntimeCapacity] = useState<DockerRuntimeCapacity>(
    UNKNOWN_DOCKER_RUNTIME_CAPACITY
  );
  const [runtimeCapacityLoaded, setRuntimeCapacityLoaded] = useState(false);
  // The GPU panel only exists on nodes that report GPUs; wait for the inventory and limits.
  useContentLoading(!gpuInventoryLoaded || !runtimeCapacityLoaded);
  const previousDeploymentBaselineRef = useRef(deploymentBaseline);
  const inputCell =
    "h-9 text-xs font-mono border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  useEffect(() => {
    let cancelled = false;
    void loadDockerRuntimeCapacity(nodeId)
      .then((capacity) => {
        if (!cancelled) setRuntimeCapacity(capacity);
      })
      .finally(() => {
        if (!cancelled) setRuntimeCapacityLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  useEffect(() => {
    let cancelled = false;
    setGpuInventoryLoaded(false);
    void api
      .getNode(nodeId)
      .then((node) => {
        if (cancelled) return;
        setGpuDevices(node.liveHealthReport?.gpuDevices ?? node.lastHealthReport?.gpuDevices ?? []);
        setSecureRuntimeAvailable(
          (
            (node.capabilities as Record<string, any>)?.dockerRuntimeStatus as
              | { state?: string }
              | undefined
          )?.state === "healthy" || savedRuntimeProfile === "secure"
        );
      })
      .catch(() => {
        if (!cancelled) setGpuDevices([]);
      })
      .finally(() => {
        if (!cancelled) setGpuInventoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId, savedRuntimeProfile]);

  useEffect(() => {
    const previous = previousDeploymentBaselineRef.current;
    const formMatchesPrevious =
      imageTag === previous.imageTag &&
      entrypoint === previous.entrypoint &&
      command === previous.command &&
      workingDir === previous.workingDir &&
      user === previous.user &&
      JSON.stringify(ports) === previous.ports &&
      readinessRouteIndex === previous.readinessRouteIndex &&
      serializeMounts(mounts) === previous.mounts &&
      JSON.stringify(labels) === previous.labels &&
      restartPolicy === previous.restartPolicy &&
      maxRetries === previous.maxRetries &&
      memoryMB === previous.memoryMB &&
      memSwapMB === previous.memSwapMB &&
      cpuCount === previous.cpuCount &&
      cpuShares === previous.cpuShares &&
      pidsLimit === previous.pidsLimit &&
      drainSeconds === previous.drainSeconds &&
      JSON.stringify(gpuDeviceIds) === previous.gpuDeviceIds &&
      runtimeProfile === previous.runtimeProfile;

    previousDeploymentBaselineRef.current = deploymentBaseline;

    if (!formMatchesPrevious) return;
    setImageTag(deploymentBaseline.imageTag);
    setEntrypoint(deploymentBaseline.entrypoint);
    setCommand(deploymentBaseline.command);
    setWorkingDir(deploymentBaseline.workingDir);
    setUser(deploymentBaseline.user);
    setPorts(initialPorts);
    setReadinessRouteIndex(deploymentBaseline.readinessRouteIndex);
    setMounts(initialMounts);
    setLabels(initialLabels);
    setRestartPolicy(deploymentBaseline.restartPolicy);
    setMaxRetries(deploymentBaseline.maxRetries);
    setMemoryMB(deploymentBaseline.memoryMB);
    setMemSwapMB(deploymentBaseline.memSwapMB);
    setCpuCount(deploymentBaseline.cpuCount);
    setCpuShares(deploymentBaseline.cpuShares);
    setPidsLimit(deploymentBaseline.pidsLimit);
    setDrainSeconds(deploymentBaseline.drainSeconds);
    setGpuDeviceIds(initialGpuDeviceIds);
    setRuntimeProfile(savedRuntimeProfile);
  }, [
    command,
    cpuCount,
    cpuShares,
    deploymentBaseline,
    drainSeconds,
    entrypoint,
    gpuDeviceIds,
    imageTag,
    initialGpuDeviceIds,
    initialLabels,
    initialMounts,
    initialPorts,
    labels,
    maxRetries,
    memoryMB,
    memSwapMB,
    mounts,
    pidsLimit,
    ports,
    readinessRouteIndex,
    restartPolicy,
    runtimeProfile,
    savedRuntimeProfile,
    user,
    workingDir,
  ]);

  const nextImage = joinImageRef(deploymentBaseline.imageName, imageTag);
  const imageTagLocked = deploymentBaseline.imageName.includes("@");
  const executionChanged =
    nextImage !== editableImageReference ||
    entrypoint !== initialEntrypoint ||
    command !== initialCommand ||
    workingDir !== initialWorkingDir ||
    user !== initialUser;
  const portsChanged = JSON.stringify(ports) !== JSON.stringify(initialPorts);
  const selectedReadinessRouteIndex =
    ports.length > 0 ? Math.min(readinessRouteIndex, ports.length - 1) : 0;
  const mountsChanged = serializeMounts(mounts) !== serializeMounts(initialMounts);
  const labelsChanged = JSON.stringify(labels) !== JSON.stringify(initialLabels);
  const drainChanged = drainSeconds !== String(deployment.drainSeconds);
  const gpuChanged = JSON.stringify(gpuDeviceIds) !== deploymentBaseline.gpuDeviceIds;
  const runtimeProfileChanged = runtimeProfile !== savedRuntimeProfile;
  const effectiveGpuDeviceIds = runtimeProfile === "secure" ? [] : gpuDeviceIds;
  const effectiveGpuChanged =
    JSON.stringify(effectiveGpuDeviceIds) !== deploymentBaseline.gpuDeviceIds;
  const settingsChanged =
    executionChanged ||
    portsChanged ||
    mountsChanged ||
    labelsChanged ||
    drainChanged ||
    effectiveGpuChanged ||
    runtimeProfileChanged;
  const executionCardChanged = executionChanged || drainChanged || runtimeProfileChanged;
  // A saved workload change reaches the slots only through a rollout; routes and
  // drain apply to the router. A pending source deployment waits for its first build.
  const saveRollsOut =
    (executionChanged ||
      mountsChanged ||
      labelsChanged ||
      effectiveGpuChanged ||
      runtimeProfileChanged) &&
    deployment.status !== "creating";
  const runtimeChanged =
    restartPolicy !== (deployment.desiredConfig.restartPolicy ?? "unless-stopped") ||
    maxRetries !== String(runtime.maxRetries ?? 0) ||
    memoryMB !== (runtime.memoryMB ? String(runtime.memoryMB) : "") ||
    memSwapMB !== (runtime.memSwapMB ? String(runtime.memSwapMB) : "") ||
    cpuCount !== (runtime.cpuCount ? String(runtime.cpuCount) : "") ||
    cpuShares !== (runtime.cpuShares ? String(runtime.cpuShares) : "") ||
    pidsLimit !== (runtime.pidsLimit ? String(runtime.pidsLimit) : "");

  const runtimeValidationError = useMemo(() => {
    const parsedMemoryMB = parseOptionalNumber(memoryMB);
    if (Number.isNaN(parsedMemoryMB) || (parsedMemoryMB !== null && parsedMemoryMB < 0)) {
      return "Memory limit must be a non-negative number.";
    }

    const parsedSwapMB = memSwapMB === "-1" ? -1 : parseOptionalNumber(memSwapMB);
    if (
      Number.isNaN(parsedSwapMB) ||
      (parsedSwapMB !== null && parsedSwapMB !== -1 && parsedSwapMB < 0)
    ) {
      return "Swap must be -1 or a non-negative number.";
    }

    const parsedCpuCount = parseOptionalNumber(cpuCount);
    if (Number.isNaN(parsedCpuCount) || (parsedCpuCount !== null && parsedCpuCount < 0)) {
      return "CPU limit must be a non-negative number.";
    }

    if ((parsedSwapMB === -1 || (parsedSwapMB ?? 0) > 0) && !parsedMemoryMB) {
      return "Set a memory limit before configuring swap.";
    }

    const maxMemoryMB =
      runtimeCapacity.maxMemoryBytes && runtimeCapacity.maxMemoryBytes > 0
        ? runtimeCapacity.maxMemoryBytes / 1048576
        : null;
    if (maxMemoryMB && parsedMemoryMB !== null && parsedMemoryMB > maxMemoryMB) {
      return `Memory limit cannot exceed node memory (${formatBytes(runtimeCapacity.maxMemoryBytes ?? 0)}).`;
    }

    const maxSwapMB =
      runtimeCapacity.maxSwapBytes !== null && runtimeCapacity.maxSwapBytes >= 0
        ? runtimeCapacity.maxSwapBytes / 1048576
        : null;
    if (
      maxSwapMB !== null &&
      parsedSwapMB !== null &&
      parsedSwapMB !== -1 &&
      parsedSwapMB > maxSwapMB
    ) {
      return `Swap cannot exceed node swap (${formatBytes(runtimeCapacity.maxSwapBytes ?? 0)}).`;
    }

    if (
      runtimeCapacity.maxCpuCount &&
      parsedCpuCount !== null &&
      parsedCpuCount > runtimeCapacity.maxCpuCount
    ) {
      return `CPU limit cannot exceed node CPU capacity (${runtimeCapacity.maxCpuCount} cores).`;
    }

    return null;
  }, [cpuCount, memSwapMB, memoryMB, runtimeCapacity]);
  const runtimeFieldErrors = useMemo<RuntimeFieldErrors>(() => {
    const fieldErrors: RuntimeFieldErrors = {};
    const parsedMemoryMB = parseOptionalNumber(memoryMB);
    if (Number.isNaN(parsedMemoryMB) || (parsedMemoryMB !== null && parsedMemoryMB < 0)) {
      fieldErrors.memoryMB = true;
    }

    const parsedSwapMB = memSwapMB === "-1" ? -1 : parseOptionalNumber(memSwapMB);
    if (
      Number.isNaN(parsedSwapMB) ||
      (parsedSwapMB !== null && parsedSwapMB !== -1 && parsedSwapMB < 0)
    ) {
      fieldErrors.memSwapMB = true;
    }

    const parsedCpuCount = parseOptionalNumber(cpuCount);
    if (Number.isNaN(parsedCpuCount) || (parsedCpuCount !== null && parsedCpuCount < 0)) {
      fieldErrors.cpuCount = true;
    }

    if ((parsedSwapMB === -1 || (parsedSwapMB ?? 0) > 0) && !parsedMemoryMB) {
      fieldErrors.memoryMB = true;
      fieldErrors.memSwapMB = true;
    }

    const maxMemoryMB =
      runtimeCapacity.maxMemoryBytes && runtimeCapacity.maxMemoryBytes > 0
        ? runtimeCapacity.maxMemoryBytes / 1048576
        : null;
    if (maxMemoryMB && parsedMemoryMB !== null && parsedMemoryMB > maxMemoryMB) {
      fieldErrors.memoryMB = true;
    }

    const maxSwapMB =
      runtimeCapacity.maxSwapBytes !== null && runtimeCapacity.maxSwapBytes >= 0
        ? runtimeCapacity.maxSwapBytes / 1048576
        : null;
    if (
      maxSwapMB !== null &&
      parsedSwapMB !== null &&
      parsedSwapMB !== -1 &&
      parsedSwapMB > maxSwapMB
    ) {
      fieldErrors.memSwapMB = true;
    }

    if (
      runtimeCapacity.maxCpuCount &&
      parsedCpuCount !== null &&
      parsedCpuCount > runtimeCapacity.maxCpuCount
    ) {
      fieldErrors.cpuCount = true;
    }

    return fieldErrors;
  }, [cpuCount, memSwapMB, memoryMB, runtimeCapacity]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RuntimeSection
          canEdit
          appliesLive={false}
          restartPolicy={restartPolicy}
          setRestartPolicy={setRestartPolicy}
          maxRetries={maxRetries}
          setMaxRetries={setMaxRetries}
          memoryMB={memoryMB}
          setMemoryMB={setMemoryMB}
          memSwapMB={memSwapMB}
          setMemSwapMB={setMemSwapMB}
          cpuCount={cpuCount}
          setCpuCount={setCpuCount}
          cpuShares={cpuShares}
          setCpuShares={setCpuShares}
          pidsLimit={pidsLimit}
          setPidsLimit={setPidsLimit}
          maxMemoryBytes={runtimeCapacity.maxMemoryBytes}
          maxSwapBytes={runtimeCapacity.maxSwapBytes}
          maxCpuCount={runtimeCapacity.maxCpuCount}
          runtimeValidationError={runtimeValidationError}
          runtimeFieldErrors={runtimeFieldErrors}
          hasRuntimeChanges={runtimeChanged}
          liveLoading={action === "update-runtime"}
          applyDisabled={!!action || !!busyReason}
          onApply={() =>
            runAction("update-runtime", async () => {
              await api.updateDockerDeployment(nodeId, deployment.id, {
                desiredConfig: {
                  restartPolicy,
                  runtime: { maxRetries, memoryMB, memSwapMB, cpuCount, cpuShares, pidsLimit },
                },
              });
              toast.success("Runtime settings updated");
            })
          }
        />

        <PanelShell
          title="Execution"
          description={
            busyReason ??
            (deployment.status === "creating"
              ? "Saved to deployment configuration"
              : "Workload changes deploy to the standby slot")
          }
          dirty={executionCardChanged}
          bodyClassName="divide-y divide-border"
          actions={
            <Button
              variant="warning"
              pending={action === "update-execution" || action === "deploy"}
              disabled={!!action || !!busyReason || !settingsChanged || !nextImage.trim()}
              title={busyReason ?? undefined}
              onClick={() => {
                if (
                  savedRuntimeProfile !== "secure" &&
                  runtimeProfile === "secure" &&
                  !requireLicenseFeature("secure-runtime", "Secure Runtime")
                )
                  return;
                void runAction(saveRollsOut ? "deploy" : "update-execution", async () => {
                  const labelMap: Record<string, string> = {};
                  for (const label of labels) {
                    if (label.key.trim()) labelMap[label.key.trim()] = label.value;
                  }
                  if (mountsChanged) {
                    await ensureManagedMountVolumes(nodeId, mounts, initialMounts);
                  }
                  await api.updateDockerDeployment(nodeId, deployment.id, {
                    desiredConfig: {
                      image: nextImage,
                      entrypoint: entrypoint.trim() ? parseShellWords(entrypoint.trim()) : [],
                      command: command.trim() ? parseShellWords(command.trim()) : [],
                      workingDir,
                      user,
                      mounts: mounts.map(({ hostPath, containerPath, name, readOnly }) => ({
                        hostPath,
                        containerPath,
                        name,
                        readOnly,
                      })),
                      labels: labelMap,
                      ...(runtimeProfileChanged ? { runtimeProfile } : {}),
                      ...(effectiveGpuChanged ? { gpu: { deviceIds: effectiveGpuDeviceIds } } : {}),
                    },
                    routes: ports
                      .filter((port) => port.hostPort && port.containerPort)
                      .map((port, index) => ({
                        hostPort: Number(port.hostPort),
                        containerPort: Number(port.containerPort),
                        isPrimary: index === selectedReadinessRouteIndex,
                      })),
                    drainSeconds: Number(drainSeconds),
                  });
                  if (saveRollsOut) {
                    await api.deployDockerDeployment(nodeId, deployment.id, {});
                    toast.success("New configuration deployed");
                  } else {
                    toast.success("Service configuration updated");
                  }
                });
              }}
            >
              {action !== "update-execution" && action !== "deploy" && (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {saveRollsOut ? "Save & Deploy" : "Save"}
            </Button>
          }
        >
          <SettingsControlRow title="Image and Tag" description="Deployment image reference">
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Image">
                <Input
                  value={stripRegistryHostFromImageName(deploymentBaseline.imageName)}
                  disabled
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Tag">
                <Input
                  value={imageTag}
                  onChange={(e) => setImageTag(e.target.value)}
                  placeholder={imageTagLocked ? "digest" : "latest"}
                  disabled={imageTagLocked}
                  style={
                    nextImage !== editableImageReference
                      ? { borderColor: "var(--color-warning)" }
                      : undefined
                  }
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          {runtimeChoiceVisible && (
            <SettingsControlRow title="Runtime" description="Container isolation profile">
              <SettingsInlineControl label="Profile">
                <Select
                  value={runtimeProfile}
                  onValueChange={(value) => {
                    if (
                      value === "secure" &&
                      savedRuntimeProfile !== "secure" &&
                      !requireLicenseFeature("secure-runtime", "Secure Runtime")
                    )
                      return;
                    setRuntimeProfile(value as DockerRuntimeProfile);
                  }}
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
                      disabled={!secureRuntimeAvailable}
                      description={getSecureDockerRuntimeDescription(secureRuntimeAvailable)}
                    >
                      Secure
                    </SelectItem>
                  </SelectContent>
                </Select>
              </SettingsInlineControl>
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="Drain and Entrypoint"
            description="Rollout and process startup"
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Drain Seconds">
                <Input
                  inputMode="numeric"
                  value={drainSeconds}
                  onChange={(event) => setDrainSeconds(event.target.value)}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Entrypoint">
                <Input
                  value={entrypoint}
                  onChange={(e) => setEntrypoint(e.target.value)}
                  placeholder="/docker-entrypoint.sh"
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="Working Directory and User"
            description="Application process context"
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Working Directory">
                <Input
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="/app"
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="User">
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          <SettingsControlRow title="Command" description="Command override">
            <SettingsInlineControl label="Command">
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="nginx -g daemon off;"
              />
            </SettingsInlineControl>
          </SettingsControlRow>
        </PanelShell>
      </div>

      {canManageAvailability && (
        <AvailabilitySection
          resource={{ type: "deployment", deploymentId: deployment.id }}
          canManage={!action}
          onDisableQueued={onAvailabilityDisableQueued}
        />
      )}

      {savedRuntimeProfile !== "secure" &&
        (!gpuInventoryLoaded || gpuDevices.length > 0 || gpuDeviceIds.length > 0) && (
          <PanelShell title="GPU" description="Applies to both blue/green slots" dirty={gpuChanged}>
            {!gpuInventoryLoaded ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">Loading node GPU inventory…</p>
            ) : gpuDevices.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No GPUs are currently reported by this node.
              </p>
            ) : (
              <>
                <div>
                  {gpuDevices.map((gpu) => {
                    const checked = gpuDeviceIds.includes(gpu.id);
                    const disabled = !!action || (!gpu.attachable && !checked);
                    return (
                      <label
                        key={gpu.id}
                        className={`flex min-w-0 items-center gap-2 border-b border-border px-4 py-3 text-sm last:border-b-0 ${disabled ? "opacity-60" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          className="form-checkbox shrink-0"
                          checked={checked}
                          disabled={disabled}
                          onChange={() =>
                            setGpuDeviceIds((current) =>
                              normalizeGpuDeviceIds(
                                checked
                                  ? current.filter((deviceId) => deviceId !== gpu.id)
                                  : [...current, gpu.id]
                              )
                            )
                          }
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{gpuDeviceLabel(gpu)}</span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {gpu.attachable
                              ? `Shared physical device · ${gpu.id}`
                              : gpu.unavailableReason || "Unavailable for container attachment"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  {gpuDeviceIds.length > 0
                    ? `${gpuDeviceIds.length} physical GPU${gpuDeviceIds.length === 1 ? "" : "s"} selected`
                    : "No GPU selected"}
                </p>
              </>
            )}
          </PanelShell>
        )}

      <PortMappingsSection
        canEdit
        ports={ports}
        setPorts={setPorts}
        portsChanged={portsChanged}
        inputCell={inputCell}
        showProtocol={false}
        showBindAddress={false}
      />

      {!availabilityManaged && (
        <VolumeMountsSection
          nodeId={nodeId}
          canEdit={canEditMounts}
          canChangeHostBinds={canChangeHostBinds}
          mounts={mounts}
          setMounts={setMounts}
          mountsChanged={mountsChanged}
          inputCell={inputCell}
        />
      )}

      <LabelsSection
        canEdit
        labels={labels}
        setLabels={setLabels}
        labelsChanged={labelsChanged}
        inputCell={inputCell}
      />

      <DockerHealthCheckSection
        nodeId={nodeId}
        target="deployment"
        deploymentId={deployment.id}
        initialHealthCheck={deployment.healthCheck ?? null}
        disabled={!!action}
        onSaved={onHealthCheckSaved}
      />

      <WebhookSection
        nodeId={nodeId}
        target="deployment"
        deploymentId={deployment.id}
        initialWebhook={webhook}
        onWebhookChange={setWebhook}
        disabled={!!action}
        allowWebhook={canManageWebhooks}
        allowCleanup
      />
    </div>
  );
}
