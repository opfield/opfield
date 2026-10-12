import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import {
  SettingsControlRow,
  SettingsHelpTitle,
  SettingsInlineControl,
} from "@/components/common/SettingsControlRow";
import { AvailabilitySection } from "@/components/docker/availability/AvailabilitySection";
import { DockerHealthCheckSection } from "@/components/docker/DockerHealthCheckSection";
import { GpuSettingsSection, normalizeGpuDeviceIds } from "@/components/docker/GpuSettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api-error-toast";
import {
  GATEWAY_ARCHIVE_IMAGE_REFERENCE_LABEL,
  resolveContainerImageReference,
} from "@/lib/docker-image-ref";
import {
  DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS,
  deriveDockerPortBindAddressOptions,
} from "@/lib/docker-port-bindings";
import {
  type DockerRuntimeCapacity,
  deriveDockerRuntimeCapacity,
  UNKNOWN_DOCKER_RUNTIME_CAPACITY,
} from "@/lib/docker-runtime-capacity";
import {
  DEFAULT_DOCKER_RUNTIME_DESCRIPTION,
  getSecureDockerRuntimeDescription,
  normalizeDockerRuntimeProfile,
} from "@/lib/docker-runtime-profile";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type { DockerHealthCheck, DockerRuntimeProfile } from "@/types";
import type { InspectData } from "./helpers";
import { LabelsSection } from "./LabelsSection";
import { type NetworkEntry, NetworksSection, readAttachedNetworks } from "./NetworksSection";
import { type PortMapping, PortMappingsSection } from "./PortMappingsSection";
import { type RuntimeFieldErrors, RuntimeSection } from "./RuntimeSection";
import { buildRuntimePayloadFromForm, type RuntimeFormValues } from "./runtime-payload";
import { buildRecreatePayloadFromForm, type RecreateBaseline } from "./settings-payload";
import {
  ensureManagedMountVolumes,
  type MountEntry,
  serializeMounts,
  VolumeMountsSection,
} from "./VolumeMountsSection";
import { WebhookSection } from "./WebhookSection";

export { buildRecreatePayloadFromForm } from "./settings-payload";
export { WebhookSection } from "./WebhookSection";

const EMPTY_GPU_ATTACHMENT = { mode: "none" as const, deviceIds: [] };
const GATEWAY_GPU_GROUP_IDS_LABEL = "wiolett.gateway.gpu.group-ids";
const GATEWAY_GPU_GROUP_IDS_VERSION_LABEL = "wiolett.gateway.gpu.group-ids-version";

function parseOptionalNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sameRuntimeBaseline(a: RuntimeFormValues, b: RuntimeFormValues) {
  return (
    a.restartPolicy === b.restartPolicy &&
    a.maxRetries === b.maxRetries &&
    a.memoryMB === b.memoryMB &&
    a.memSwapMB === b.memSwapMB &&
    a.cpuCount === b.cpuCount &&
    a.cpuShares === b.cpuShares &&
    a.pidsLimit === b.pidsLimit
  );
}

function sameRecreateBaseline(a: RecreateBaseline, b: RecreateBaseline) {
  return (
    a.imageName === b.imageName &&
    a.imageTag === b.imageTag &&
    a.ports === b.ports &&
    a.mounts === b.mounts &&
    a.entrypoint === b.entrypoint &&
    a.command === b.command &&
    a.stopTimeout === b.stopTimeout &&
    a.workingDir === b.workingDir &&
    a.user === b.user &&
    a.hostname === b.hostname &&
    a.labels === b.labels &&
    a.gpuDeviceIds === b.gpuDeviceIds &&
    a.runtimeProfile === b.runtimeProfile
  );
}

function serializeNetworks(networks: NetworkEntry[]) {
  return JSON.stringify(
    networks
      .map((network) => network.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  );
}

function validateNetworkDraft(networks: NetworkEntry[]) {
  if (networks.some((network) => !network.name && !network.networkId)) {
    return "Select a network before saving.";
  }

  if (networks.some((network) => !network.name)) return "Selected network is unavailable.";

  const names = networks.map((network) => network.name).filter(Boolean);
  if (new Set(names).size !== names.length) {
    return "Each network can only be attached once.";
  }

  return null;
}

function deriveCurrentNanoCPUs(hostConfig: Record<string, any>): number {
  const nanoCPUs = Number(hostConfig.NanoCPUs ?? 0);
  if (Number.isFinite(nanoCPUs) && nanoCPUs > 0) return nanoCPUs;

  const cpuQuota = Number(hostConfig.CPUQuota ?? 0);
  const cpuPeriod = Number(hostConfig.CPUPeriod ?? 0);
  if (Number.isFinite(cpuQuota) && Number.isFinite(cpuPeriod) && cpuQuota > 0 && cpuPeriod > 0) {
    return Math.round((cpuQuota / cpuPeriod) * 1e9);
  }

  return 0;
}

// ── Component ────────────────────────────────────────────────────

export function SettingsTab({
  nodeId,
  containerId,
  scopeResourceId,
  data,
  onMutationStart,
  onMutationEnd,
  onRecreating,
  onRefresh,
  onHealthCheckSaved,
  transition,
  readOnly,
  availabilityManaged = false,
  logicalContainerName,
  imageReferenceOverride,
  onAvailabilityDisableQueued,
}: {
  nodeId: string;
  containerId: string;
  scopeResourceId?: string;
  data: InspectData;
  onMutationStart?: (transition: "updating" | "recreating") => void;
  onMutationEnd?: () => void;
  onRecreating?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onHealthCheckSaved?: (healthCheck: DockerHealthCheck) => void;
  transition?: string;
  readOnly?: boolean;
  availabilityManaged?: boolean;
  logicalContainerName?: string;
  imageReferenceOverride?: string | null;
  onAvailabilityDisableQueued?: (survivor: { nodeId: string; nodeSlug: string }) => void;
}) {
  const { hasScope, hasScopedAccess } = useAuthStore();
  const invalidate = useDockerStore((s) => s.invalidate);
  const scopeSuffix = `${nodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`;
  const canEdit = !readOnly && hasScope(`docker:containers:edit:${scopeSuffix}`);
  // Managed volumes are attached with view access to each volume; docker:containers:mounts
  // covers legacy host binds and keeps the editor open to its holders.
  const canChangeHostBinds = !readOnly && hasScope(`docker:containers:mounts:${scopeSuffix}`);
  const canEditMounts = canChangeHostBinds || (!readOnly && hasScopedAccess("docker:volumes:view"));
  const canManageNetworks = !readOnly && canEdit && hasScopedAccess("docker:networks:edit");
  const canListNetworks = !readOnly && hasScopedAccess("docker:networks:view");
  const recreatesRunningContainer =
    (data.State?.Status ?? (data.State?.Running ? "running" : "stopped")) === "running";
  const gpuAttachment = data.gpuAttachment ?? EMPTY_GPU_ATTACHMENT;
  const attachedGpuDeviceIds = gpuAttachment.deviceIds;
  const initialGpuDeviceIds = useMemo(
    () => (gpuAttachment.mode === "managed" ? normalizeGpuDeviceIds(attachedGpuDeviceIds) : []),
    [attachedGpuDeviceIds, gpuAttachment.mode]
  );

  // ── Live settings state (no recreation) ──
  const hostConfig = data.HostConfig ?? {};
  const savedRuntimeName = String(hostConfig.Runtime ?? "");
  const savedRuntimeProfile = normalizeDockerRuntimeProfile(savedRuntimeName);
  // Secure is offered with Secure Runtime only; a container already on it (or on a legacy runtime) keeps the choice.
  const secureRuntimeLicensed = usePlanIncludes("secure-runtime");
  const secureRuntimeOptionVisible = secureRuntimeLicensed || savedRuntimeProfile === "secure";
  const runtimeChoiceVisible = secureRuntimeOptionVisible || savedRuntimeProfile === "legacy";
  const currentRestartPolicy = hostConfig.RestartPolicy?.Name ?? "no";
  const currentMaxRetries = hostConfig.RestartPolicy?.MaximumRetryCount ?? 0;
  const currentMemory = hostConfig.Memory ?? 0;
  const currentMemoryReservation = hostConfig.MemoryReservation ?? 0;
  const currentMemSwap = hostConfig.MemorySwap ?? 0;
  const currentNanoCPUs = deriveCurrentNanoCPUs(hostConfig as Record<string, any>);
  const currentCpuShares = hostConfig.CpuShares ?? 0;
  const currentPidsLimit = hostConfig.PidsLimit ?? 0;

  const initMem = currentMemory > 0 ? String(Math.round(currentMemory / 1048576)) : "";
  const initMemoryReservation =
    currentMemoryReservation > 0 ? String(Math.round(currentMemoryReservation / 1048576)) : "";
  const currentSwap =
    currentMemSwap === -1
      ? -1
      : currentMemSwap > 0
        ? Math.max(0, currentMemSwap - currentMemory)
        : 0;
  const initSwap =
    currentSwap === -1 ? "-1" : currentSwap > 0 ? String(Math.round(currentSwap / 1048576)) : "";
  const initCpu = currentNanoCPUs > 0 ? String(currentNanoCPUs / 1e9) : "";
  const initShares = currentCpuShares > 0 ? String(currentCpuShares) : "";
  const initPids = currentPidsLimit > 0 ? String(currentPidsLimit) : "";

  const runtimeServerBaseline: RuntimeFormValues = useMemo(
    () => ({
      restartPolicy: currentRestartPolicy,
      maxRetries: String(currentMaxRetries),
      memoryMB: initMem,
      memSwapMB: initSwap,
      cpuCount: initCpu,
      cpuShares: initShares,
      pidsLimit: initPids,
    }),
    [currentRestartPolicy, currentMaxRetries, initMem, initSwap, initCpu, initShares, initPids]
  );

  const [restartPolicy, setRestartPolicy] = useState(runtimeServerBaseline.restartPolicy);
  const [maxRetries, setMaxRetries] = useState(runtimeServerBaseline.maxRetries);
  const [memoryMB, setMemoryMB] = useState(runtimeServerBaseline.memoryMB);
  const [memSwapMB, setMemSwapMB] = useState(runtimeServerBaseline.memSwapMB);
  const [cpuCount, setCpuCount] = useState(runtimeServerBaseline.cpuCount);
  const [cpuShares, setCpuShares] = useState(runtimeServerBaseline.cpuShares);
  const [pidsLimit, setPidsLimit] = useState(runtimeServerBaseline.pidsLimit);
  const [liveLoading, setLiveLoading] = useState(false);
  const [runtimeCapacity, setRuntimeCapacity] = useState<DockerRuntimeCapacity>(
    UNKNOWN_DOCKER_RUNTIME_CAPACITY
  );
  const [secureRuntimeAvailable, setSecureRuntimeAvailable] = useState(
    savedRuntimeProfile === "secure"
  );
  const [bindAddressOptions, setBindAddressOptions] = useState(
    DEFAULT_DOCKER_PORT_BIND_ADDRESS_OPTIONS
  );
  // Node capacity, Secure Runtime and bind addresses shape the form the tab opens with.
  const [nodeInfoLoaded, setNodeInfoLoaded] = useState(false);
  useContentLoading(!nodeInfoLoaded);

  // Baseline snapshot — updated after successful live apply
  const baselineRef = useRef<RuntimeFormValues>(runtimeServerBaseline);
  const previousRuntimeServerBaselineRef = useRef<RuntimeFormValues>(runtimeServerBaseline);

  // ── Recreate settings state ──
  const portBindings = (hostConfig.PortBindings ?? {}) as Record<
    string,
    Array<{ HostIp?: string; HostIP?: string; HostPort: string }> | null
  >;
  const initialPorts = useMemo(() => {
    const ports: PortMapping[] = [];
    for (const [containerPort, bindings] of Object.entries(portBindings)) {
      if (!bindings) continue;
      const [port, proto] = containerPort.split("/");
      for (const binding of bindings) {
        ports.push({
          hostIp: binding.HostIp || binding.HostIP || "0.0.0.0",
          hostPort: binding.HostPort ?? "",
          containerPort: port,
          protocol: (proto as "tcp" | "udp") ?? "tcp",
        });
      }
    }
    return ports;
  }, [portBindings]);

  const initialMounts = useMemo(
    () =>
      (
        (data.Mounts ?? []) as Array<{
          Type: string;
          Source: string;
          Destination: string;
          Name?: string;
          RW: boolean;
        }>
      ).map((mount) => ({
        hostPath: mount.Type === "bind" ? mount.Source : "",
        containerPath: mount.Destination,
        name: mount.Type === "volume" ? (mount.Name ?? mount.Source) : "",
        readOnly: !mount.RW,
        existing: true,
      })),
    [data.Mounts]
  );
  const initialNetworks = useMemo(
    () =>
      readAttachedNetworks(
        data.NetworkSettings?.Networks as Record<string, Record<string, unknown>>
      ),
    [data.NetworkSettings?.Networks]
  );

  const config = data.Config ?? {};
  const containerName = useMemo(
    () => logicalContainerName || ((data.Name ?? "") as string).replace(/^\//, ""),
    [data.Name, logicalContainerName]
  );
  const configLabels = (config.Labels ?? {}) as Record<string, string>;
  const currentImage = imageReferenceOverride || resolveContainerImageReference(data);
  const { imageName: parsedImageName, tag: parsedTag } = useMemo(() => {
    if (currentImage.includes("@")) {
      return { imageName: currentImage, tag: "" };
    }
    const lastColon = currentImage.lastIndexOf(":");
    const lastSlash = currentImage.lastIndexOf("/");
    if (lastColon === -1 || lastSlash > lastColon) {
      return { imageName: currentImage, tag: "" };
    }
    return { imageName: currentImage.slice(0, lastColon), tag: currentImage.slice(lastColon + 1) };
  }, [currentImage]);

  const [imageName, setImageName] = useState(parsedImageName);
  const [imageTag, setImageTag] = useState(parsedTag);
  const imageNameChanged = imageName !== parsedImageName;
  const imageTagChanged = imageTag !== parsedTag;
  const imageTagLocked = imageName.includes("@");

  const initialEntrypoint = (config.Entrypoint ?? []) as string[];
  const initialCmd = (config.Cmd ?? []) as string[];
  const initialStopTimeout =
    typeof config.StopTimeout === "number" && Number.isFinite(config.StopTimeout)
      ? String(config.StopTimeout)
      : "20";
  const initialWorkdir = (config.WorkingDir ?? "") as string;
  const initialUser = (config.User ?? "") as string;
  const initialHostname = (config.Hostname ?? "") as string;
  const initialLabels = Object.fromEntries(
    Object.entries(configLabels).filter(
      ([key]) =>
        key !== GATEWAY_ARCHIVE_IMAGE_REFERENCE_LABEL &&
        key !== GATEWAY_GPU_GROUP_IDS_LABEL &&
        key !== GATEWAY_GPU_GROUP_IDS_VERSION_LABEL &&
        !key.startsWith("wiolett.gateway.availability.")
    )
  );

  const [ports, setPorts] = useState<PortMapping[]>(initialPorts);
  const [mounts, setMounts] = useState<MountEntry[]>(initialMounts);
  const [networks, setNetworks] = useState<NetworkEntry[]>(initialNetworks);
  const [entrypoint, setEntrypoint] = useState(initialEntrypoint.join(" "));
  const [command, setCommand] = useState(initialCmd.join(" "));
  const [stopTimeout, setStopTimeout] = useState(initialStopTimeout);
  const [workingDir, setWorkingDir] = useState(initialWorkdir);
  const [user, setUser] = useState(initialUser);
  const [hostname, setHostname] = useState(initialHostname);
  const [labels, setLabels] = useState<Array<{ key: string; value: string }>>(
    Object.entries(initialLabels).map(([key, value]) => ({ key, value }))
  );
  const [gpuDeviceIds, setGpuDeviceIds] = useState(initialGpuDeviceIds);
  const [runtimeProfile, setRuntimeProfile] = useState<"default" | "secure" | "legacy">(
    savedRuntimeProfile
  );
  const gpuDraftTouchedRef = useRef(false);
  const [recreateLoading, setRecreateLoading] = useState(false);
  const networkBaseline = useMemo(() => serializeNetworks(initialNetworks), [initialNetworks]);

  const recreateBaseline = useMemo(
    () => ({
      imageName: parsedImageName,
      imageTag: parsedTag,
      ports: JSON.stringify(initialPorts),
      mounts: serializeMounts(initialMounts),
      entrypoint: initialEntrypoint.join(" "),
      command: initialCmd.join(" "),
      stopTimeout: initialStopTimeout,
      workingDir: initialWorkdir,
      user: initialUser,
      hostname: initialHostname,
      labels: JSON.stringify(Object.entries(initialLabels).map(([k, v]) => ({ key: k, value: v }))),
      gpuDeviceIds: JSON.stringify(initialGpuDeviceIds),
      runtimeProfile: savedRuntimeProfile,
    }),
    [
      initialCmd,
      initialEntrypoint,
      initialHostname,
      initialLabels,
      initialMounts,
      initialPorts,
      initialStopTimeout,
      initialUser,
      initialWorkdir,
      initialGpuDeviceIds,
      savedRuntimeProfile,
      parsedImageName,
      parsedTag,
    ]
  );
  const previousRecreateBaselineRef = useRef(recreateBaseline);
  const previousNetworkBaselineRef = useRef(networkBaseline);
  const networkBaselineRef = useRef(networkBaseline);
  const networkBaselineEntriesRef = useRef<NetworkEntry[]>(initialNetworks);

  useEffect(() => {
    const previous = previousRuntimeServerBaselineRef.current;
    const baselineChanged = !sameRuntimeBaseline(previous, runtimeServerBaseline);
    const formMatchesPrevious =
      restartPolicy === previous.restartPolicy &&
      maxRetries === previous.maxRetries &&
      memoryMB === previous.memoryMB &&
      memSwapMB === previous.memSwapMB &&
      cpuCount === previous.cpuCount &&
      cpuShares === previous.cpuShares &&
      pidsLimit === previous.pidsLimit;

    baselineRef.current = runtimeServerBaseline;
    previousRuntimeServerBaselineRef.current = runtimeServerBaseline;

    if (!baselineChanged || !formMatchesPrevious) return;
    setRestartPolicy(runtimeServerBaseline.restartPolicy);
    setMaxRetries(runtimeServerBaseline.maxRetries);
    setMemoryMB(runtimeServerBaseline.memoryMB);
    setMemSwapMB(runtimeServerBaseline.memSwapMB);
    setCpuCount(runtimeServerBaseline.cpuCount);
    setCpuShares(runtimeServerBaseline.cpuShares);
    setPidsLimit(runtimeServerBaseline.pidsLimit);
  }, [
    cpuCount,
    cpuShares,
    maxRetries,
    memoryMB,
    memSwapMB,
    pidsLimit,
    restartPolicy,
    runtimeServerBaseline,
  ]);

  useEffect(() => {
    const previous = previousRecreateBaselineRef.current;
    const baselineChanged = !sameRecreateBaseline(previous, recreateBaseline);
    const nonGpuFormMatchesPrevious =
      imageName === previous.imageName &&
      imageTag === previous.imageTag &&
      JSON.stringify(ports) === previous.ports &&
      serializeMounts(mounts) === previous.mounts &&
      entrypoint === previous.entrypoint &&
      command === previous.command &&
      stopTimeout === previous.stopTimeout &&
      workingDir === previous.workingDir &&
      user === previous.user &&
      hostname === previous.hostname &&
      JSON.stringify(labels) === previous.labels;
    const runtimeProfileMatchesPrevious = runtimeProfile === previous.runtimeProfile;
    const gpuDraftMatchesPrevious = JSON.stringify(gpuDeviceIds) === previous.gpuDeviceIds;

    previousRecreateBaselineRef.current = recreateBaseline;

    if (!baselineChanged || !nonGpuFormMatchesPrevious) return;
    setImageName(parsedImageName);
    setImageTag(parsedTag);
    setPorts(initialPorts);
    setMounts(initialMounts);
    setEntrypoint(initialEntrypoint.join(" "));
    setCommand(initialCmd.join(" "));
    setStopTimeout(initialStopTimeout);
    setWorkingDir(initialWorkdir);
    setUser(initialUser);
    setHostname(initialHostname);
    setLabels(Object.entries(initialLabels).map(([key, value]) => ({ key, value })));
    if (!gpuDraftTouchedRef.current && gpuDraftMatchesPrevious) {
      setGpuDeviceIds(initialGpuDeviceIds);
    }
    if (runtimeProfileMatchesPrevious) setRuntimeProfile(savedRuntimeProfile);
  }, [
    command,
    entrypoint,
    gpuDeviceIds,
    hostname,
    initialGpuDeviceIds,
    parsedImageName,
    imageTag,
    imageName,
    initialCmd,
    initialEntrypoint,
    initialHostname,
    initialLabels,
    initialMounts,
    initialPorts,
    initialStopTimeout,
    initialUser,
    initialWorkdir,
    labels,
    mounts,
    parsedTag,
    ports,
    recreateBaseline,
    stopTimeout,
    user,
    workingDir,
    runtimeProfile,
    savedRuntimeProfile,
  ]);

  useEffect(() => {
    const previous = previousNetworkBaselineRef.current;
    const currentDraft = serializeNetworks(networks);
    const baselineChanged = previous !== networkBaseline;
    const formMatchesPrevious = currentDraft === previous;

    previousNetworkBaselineRef.current = networkBaseline;
    networkBaselineRef.current = networkBaseline;
    networkBaselineEntriesRef.current = initialNetworks;

    if (!baselineChanged || !formMatchesPrevious) return;
    setNetworks(initialNetworks);
  }, [initialNetworks, networkBaseline, networks]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getNode(nodeId)
      .then((node) => {
        if (cancelled) return;
        setRuntimeCapacity(deriveDockerRuntimeCapacity(node));
        setSecureRuntimeAvailable(
          (
            (node.capabilities as Record<string, any>)?.dockerRuntimeStatus as
              | { state?: string }
              | undefined
          )?.state === "healthy" || savedRuntimeProfile === "secure"
        );
        setBindAddressOptions(deriveDockerPortBindAddressOptions(node));
        setNodeInfoLoaded(true);
      })
      .catch(async () => {
        let node = null;
        try {
          const nodes = await api.listNodes({ type: "docker", limit: 100 });
          node = nodes.data.find((candidate) => candidate.id === nodeId) ?? null;
        } catch {
          // Keep the safe defaults when neither node endpoint is available.
        }
        if (cancelled) return;
        setRuntimeCapacity(deriveDockerRuntimeCapacity(node));
        setSecureRuntimeAvailable(
          (
            (node?.capabilities as Record<string, any> | undefined)?.dockerRuntimeStatus as
              | { state?: string }
              | undefined
          )?.state === "healthy" || savedRuntimeProfile === "secure"
        );
        setBindAddressOptions(deriveDockerPortBindAddressOptions(node));
        setNodeInfoLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [nodeId, savedRuntimeProfile]);

  const runtimeValidation = useMemo(() => {
    const fieldErrors: RuntimeFieldErrors = {};
    const messages: string[] = [];
    const addError = (field: keyof RuntimeFieldErrors, message: string) => {
      fieldErrors[field] = true;
      messages.push(message);
    };

    const parsedMemoryMB = parseOptionalNumber(memoryMB);
    if (Number.isNaN(parsedMemoryMB) || (parsedMemoryMB !== null && parsedMemoryMB < 0)) {
      addError("memoryMB", "Memory limit must be a non-negative number.");
    }

    const parsedSwapMB = memSwapMB === "-1" ? -1 : parseOptionalNumber(memSwapMB);
    if (
      Number.isNaN(parsedSwapMB) ||
      (parsedSwapMB !== null && parsedSwapMB !== -1 && parsedSwapMB < 0)
    ) {
      addError("memSwapMB", "Swap must be -1 or a non-negative number.");
    }

    const parsedCpuCount = parseOptionalNumber(cpuCount);
    if (Number.isNaN(parsedCpuCount) || (parsedCpuCount !== null && parsedCpuCount < 0)) {
      addError("cpuCount", "CPU limit must be a non-negative number.");
    }

    if ((parsedSwapMB === -1 || (parsedSwapMB ?? 0) > 0) && !parsedMemoryMB) {
      fieldErrors.memoryMB = true;
      fieldErrors.memSwapMB = true;
      messages.push("Set a memory limit before configuring swap.");
    }

    const maxMemoryMB =
      runtimeCapacity.maxMemoryBytes && runtimeCapacity.maxMemoryBytes > 0
        ? runtimeCapacity.maxMemoryBytes / 1048576
        : null;
    if (maxMemoryMB && parsedMemoryMB !== null && parsedMemoryMB > maxMemoryMB) {
      addError(
        "memoryMB",
        `Memory limit cannot exceed node memory (${formatBytes(runtimeCapacity.maxMemoryBytes ?? 0)}).`
      );
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
      addError(
        "memSwapMB",
        `Swap cannot exceed node swap (${formatBytes(runtimeCapacity.maxSwapBytes ?? 0)}).`
      );
    }

    if (
      runtimeCapacity.maxCpuCount &&
      parsedCpuCount !== null &&
      parsedCpuCount > runtimeCapacity.maxCpuCount
    ) {
      addError(
        "cpuCount",
        `CPU limit cannot exceed node CPU capacity (${runtimeCapacity.maxCpuCount} cores).`
      );
    }

    return { message: messages[0] ?? null, fieldErrors };
  }, [cpuCount, memSwapMB, memoryMB, runtimeCapacity]);
  const runtimeValidationError = runtimeValidation.message;
  const runtimeFieldErrors = runtimeValidation.fieldErrors;

  const executionValidationError = useMemo(() => {
    const parsedStopTimeout = parseOptionalNumber(stopTimeout);
    if (
      Number.isNaN(parsedStopTimeout) ||
      parsedStopTimeout === null ||
      !Number.isInteger(parsedStopTimeout) ||
      parsedStopTimeout < 0 ||
      parsedStopTimeout > 300
    ) {
      return "Stop grace must be a whole number from 0 to 300 seconds.";
    }
    return null;
  }, [stopTimeout]);

  const buildRuntimePayload = useCallback(() => {
    return buildRuntimePayloadFromForm(
      {
        restartPolicy,
        maxRetries,
        memoryMB,
        memSwapMB,
        cpuCount,
        cpuShares,
        pidsLimit,
      },
      baselineRef.current
    );
  }, [restartPolicy, maxRetries, memoryMB, memSwapMB, cpuCount, cpuShares, pidsLimit]);

  // ── Live update handler ──
  const handleLiveUpdate = useCallback(async () => {
    setLiveLoading(true);
    onMutationStart?.("updating");
    try {
      if (runtimeValidationError) {
        onMutationEnd?.();
        toast.error(runtimeValidationError);
        return;
      }

      const payload = buildRuntimePayload();
      if (!payload) {
        onMutationEnd?.();
        toast.info("No changes to apply");
        return;
      }

      await api.liveUpdateContainer(nodeId, containerId, payload);
      toast.success(
        recreatesRunningContainer
          ? "Settings applied (no restart needed)"
          : "Container runtime configuration saved"
      );
      if (recreatesRunningContainer) {
        invalidate("containers", "tasks");
        await Promise.resolve(onRefresh?.());
        onMutationEnd?.();
      } else {
        invalidate("containers", "tasks");
        await Promise.resolve(onRefresh?.());
        onMutationEnd?.();
      }

      // Update baseline so hasRuntimeChanges becomes false immediately
      baselineRef.current = {
        restartPolicy,
        maxRetries,
        memoryMB,
        memSwapMB,
        cpuCount,
        cpuShares,
        pidsLimit,
      };
    } catch (err) {
      onMutationEnd?.();
      toastApiError(err, "Failed to apply settings");
    } finally {
      setLiveLoading(false);
    }
  }, [
    buildRuntimePayload,
    containerId,
    invalidate,
    maxRetries,
    memoryMB,
    memSwapMB,
    nodeId,
    onRefresh,
    pidsLimit,
    recreatesRunningContainer,
    restartPolicy,
    cpuCount,
    cpuShares,
    onMutationEnd,
    onMutationStart,
    runtimeValidationError,
  ]);

  // ── Track recreate changes per section ──
  const portsChanged = JSON.stringify(ports) !== recreateBaseline.ports;
  const mountsChanged = serializeMounts(mounts) !== recreateBaseline.mounts;
  const execChanged =
    entrypoint !== recreateBaseline.entrypoint ||
    command !== recreateBaseline.command ||
    stopTimeout !== recreateBaseline.stopTimeout ||
    workingDir !== recreateBaseline.workingDir ||
    user !== recreateBaseline.user ||
    hostname !== recreateBaseline.hostname;
  const labelsChanged = JSON.stringify(labels) !== recreateBaseline.labels;
  const gpuChanged = JSON.stringify(gpuDeviceIds) !== recreateBaseline.gpuDeviceIds;
  const runtimeProfileChanged = runtimeProfile !== recreateBaseline.runtimeProfile;
  const effectiveGpuDeviceIds = runtimeProfile === "secure" ? [] : gpuDeviceIds;
  const effectiveGpuChanged =
    JSON.stringify(effectiveGpuDeviceIds) !== recreateBaseline.gpuDeviceIds;
  const networkValidationError = useMemo(() => validateNetworkDraft(networks), [networks]);
  const networksChanged = serializeNetworks(networks) !== networkBaselineRef.current;
  const hasConfigRecreateChanges =
    portsChanged ||
    mountsChanged ||
    execChanged ||
    labelsChanged ||
    imageNameChanged ||
    imageTagChanged ||
    effectiveGpuChanged ||
    runtimeProfileChanged;
  const hasRecreateChanges = hasConfigRecreateChanges || networksChanged;

  // ── Track runtime changes against baseline ──
  const b = baselineRef.current;
  const hasRuntimeChanges =
    restartPolicy !== b.restartPolicy ||
    maxRetries !== b.maxRetries ||
    memoryMB !== b.memoryMB ||
    memSwapMB !== b.memSwapMB ||
    cpuCount !== b.cpuCount ||
    cpuShares !== b.cpuShares ||
    pidsLimit !== b.pidsLimit;

  const applyNetworkChanges = useCallback(async () => {
    const baseline = networkBaselineEntriesRef.current;
    const baselineByName = new Map(baseline.map((network) => [network.name, network]));
    const nextByName = new Map(networks.map((network) => [network.name, network]));

    const removed = baseline.filter((network) => !nextByName.has(network.name));
    const added = networks.filter((network) => !baselineByName.has(network.name));

    for (const network of removed) {
      await api.disconnectContainerFromNetwork(
        nodeId,
        network.networkId || network.name,
        containerId
      );
    }
    for (const network of added) {
      await api.connectContainerToNetwork(nodeId, network.networkId || network.name, containerId);
    }

    const appliedBaseline = serializeNetworks(networks);
    networkBaselineRef.current = appliedBaseline;
    previousNetworkBaselineRef.current = appliedBaseline;
    networkBaselineEntriesRef.current = networks;
  }, [containerId, networks, nodeId]);
  const saveRequiresRecreate = hasConfigRecreateChanges && recreatesRunningContainer;

  // ── Recreate handler ──
  const handleRecreate = useCallback(async () => {
    if (
      savedRuntimeProfile !== "secure" &&
      runtimeProfile === "secure" &&
      !requireLicenseFeature("secure-runtime", "Secure Runtime")
    )
      return;
    if (hasConfigRecreateChanges) {
      const ok = await confirm({
        title: saveRequiresRecreate ? "Save & Recreate" : "Save",
        description: saveRequiresRecreate
          ? "This will stop and recreate the container with the new configuration. The container will experience downtime. Continue?"
          : "This will save the new container configuration. The container will remain stopped. Continue?",
        confirmLabel: saveRequiresRecreate ? "Recreate" : "Save",
      });
      if (!ok) return;
    }

    setRecreateLoading(true);
    if (hasConfigRecreateChanges) {
      onMutationStart?.("recreating");
    }
    try {
      if (hasRuntimeChanges && runtimeValidationError) {
        if (hasConfigRecreateChanges) onMutationEnd?.();
        toast.error(runtimeValidationError);
        setRecreateLoading(false);
        return;
      }
      if (executionValidationError) {
        if (hasConfigRecreateChanges) onMutationEnd?.();
        toast.error(executionValidationError);
        setRecreateLoading(false);
        return;
      }
      if (networksChanged && networkValidationError) {
        if (hasConfigRecreateChanges) onMutationEnd?.();
        toast.error(networkValidationError);
        setRecreateLoading(false);
        return;
      }

      if (networksChanged) {
        await applyNetworkChanges();
      }

      if (!hasConfigRecreateChanges) {
        invalidate("containers", "networks");
        await Promise.resolve(onRefresh?.());
        toast.success("Networks saved");
        setRecreateLoading(false);
        return;
      }

      const payload = buildRecreatePayloadFromForm({
        parsedImageName: imageName,
        imageTag,
        imageTagChanged: imageNameChanged || imageTagChanged,
        portsChanged,
        ports,
        mountsChanged,
        mounts,
        entrypoint,
        command,
        stopTimeout,
        workingDir,
        user,
        hostname,
        labelsChanged,
        labels,
        gpuChanged: effectiveGpuChanged,
        gpuDeviceIds: effectiveGpuDeviceIds,
        runtimeProfileChanged,
        runtimeProfile: runtimeProfile as DockerRuntimeProfile,
        hasRuntimeChanges,
        runtimePayload: buildRuntimePayload(),
        recreateBaseline,
      });

      if (mountsChanged) await ensureManagedMountVolumes(nodeId, mounts, initialMounts);
      await api.recreateWithConfig(nodeId, containerId, payload);
      gpuDraftTouchedRef.current = false;
      toast.success(
        recreatesRunningContainer ? "Recreating container..." : "Container configuration saved"
      );
      invalidate("containers", "tasks");
      // Trigger an immediate no-cache refresh and keep the UI locked until
      // the detail view has observed the updated container state.
      await Promise.resolve(onRecreating?.());
      setRecreateLoading(false);
    } catch (err) {
      onMutationEnd?.();
      if (!handleLicenseApiError(err, "Secure Runtime")) {
        toastApiError(err, "Failed to recreate container");
      }
      setRecreateLoading(false);
    }
  }, [
    command,
    containerId,
    entrypoint,
    executionValidationError,
    hostname,
    imageTag,
    imageTagChanged,
    imageName,
    imageNameChanged,
    applyNetworkChanges,
    invalidate,
    labels,
    labelsChanged,
    effectiveGpuChanged,
    effectiveGpuDeviceIds,
    runtimeProfileChanged,
    runtimeProfile,
    mounts,
    mountsChanged,
    initialMounts,
    nodeId,
    networkValidationError,
    networksChanged,
    onRecreating,
    onRefresh,
    ports,
    portsChanged,
    buildRuntimePayload,
    hasConfigRecreateChanges,
    hasRuntimeChanges,
    recreateBaseline,
    recreatesRunningContainer,
    runtimeValidationError,
    saveRequiresRecreate,
    savedRuntimeProfile,
    stopTimeout,
    user,
    workingDir,
    onMutationEnd,
    onMutationStart,
  ]);

  // ── Shared input styles ──
  const inputCell =
    "h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  return (
    <fieldset
      disabled={recreateLoading || !!transition}
      className={`space-y-6 pb-6 ${recreateLoading || !!transition ? "pointer-events-none opacity-60" : ""}`}
    >
      {/* ─── Runtime Settings + Execution (side by side) ────────── */}
      <div className="grid grid-cols-1 gap-6 min-[1044px]:grid-cols-2">
        <RuntimeSection
          canEdit={canEdit}
          appliesLive={recreatesRunningContainer}
          restartPolicy={restartPolicy}
          setRestartPolicy={setRestartPolicy}
          maxRetries={maxRetries}
          setMaxRetries={setMaxRetries}
          memoryMB={memoryMB}
          setMemoryMB={setMemoryMB}
          memoryReservationMB={readOnly ? initMemoryReservation : undefined}
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
          hasRuntimeChanges={hasRuntimeChanges}
          liveLoading={liveLoading}
          onApply={handleLiveUpdate}
        />

        <PanelShell
          title={
            <SettingsHelpTitle
              label="Execution"
              help="Container creation settings that Docker cannot change in place. Saving recreates the container with the same managed identity and the updated configuration."
            />
          }
          description="Requires container recreation"
          dirty={
            execChanged ||
            imageNameChanged ||
            imageTagChanged ||
            effectiveGpuChanged ||
            runtimeProfileChanged
          }
          bodyClassName="divide-y divide-border"
          actions={
            canEdit ? (
              <Button
                variant="warning"
                onClick={handleRecreate}
                pending={recreateLoading}
                disabled={
                  !hasRecreateChanges ||
                  (!!networkValidationError && networksChanged) ||
                  !!executionValidationError ||
                  (hasRuntimeChanges && !!runtimeValidationError)
                }
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {saveRequiresRecreate ? "Save & Recreate" : "Save"}
              </Button>
            ) : null
          }
        >
          <SettingsControlRow
            title="Image and Tag"
            description="Container image reference"
            help="Image selects the repository; Tag selects the version. Changing either pulls and recreates the container. Digest-pinned images keep their immutable digest instead of an editable Tag."
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Image">
                <Input
                  value={imageName}
                  onChange={(event) => setImageName(event.target.value)}
                  disabled={!availabilityManaged}
                  style={imageNameChanged ? { borderColor: "var(--color-warning)" } : undefined}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Tag">
                <Input
                  value={imageTag}
                  onChange={(e) => setImageTag(e.target.value)}
                  placeholder={imageTagLocked ? "digest" : "latest"}
                  disabled={!canEdit || imageTagLocked}
                  style={imageTagChanged ? { borderColor: "var(--color-warning)" } : undefined}
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          {runtimeChoiceVisible && (
            <SettingsControlRow
              title="Runtime"
              description="Container isolation profile"
              help="Default uses the node's standard Docker runtime. Secure adds stronger isolation when the node and license support it. Changing the profile recreates the container."
            >
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
                  disabled={!canEdit}
                >
                  <SelectTrigger aria-label="Runtime">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {runtimeProfile === "legacy" && (
                      <SelectItem
                        value="legacy"
                        disabled
                        description={`Custom Docker runtime: ${savedRuntimeName}`}
                      >
                        Legacy
                      </SelectItem>
                    )}
                    <SelectItem value="default" description={DEFAULT_DOCKER_RUNTIME_DESCRIPTION}>
                      Default
                    </SelectItem>
                    {secureRuntimeOptionVisible && (
                      <SelectItem
                        value="secure"
                        disabled={!secureRuntimeAvailable}
                        description={getSecureDockerRuntimeDescription(secureRuntimeAvailable)}
                      >
                        Secure
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </SettingsInlineControl>
            </SettingsControlRow>
          )}
          <SettingsControlRow
            title="Working Dir and Entrypoint"
            description="Initial process context"
            help="Working Dir becomes the process current directory. Entrypoint replaces the image ENTRYPOINT and is normally left empty unless the image requires an explicit override."
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Working Dir">
                <Input
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="/app"
                  disabled={!canEdit}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Entrypoint">
                <Input
                  value={entrypoint}
                  onChange={(e) => setEntrypoint(e.target.value)}
                  placeholder="/docker-entrypoint.sh"
                  disabled={!canEdit}
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="User and Hostname"
            description="Container identity"
            help="User overrides the account used to start the process, such as root or 1000:1000. Hostname controls the name visible to applications inside the container."
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="User">
                <Input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="root"
                  disabled={!canEdit}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Hostname">
                <Input
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="container-hostname"
                  disabled={!canEdit}
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
          <SettingsControlRow
            title="Command and Stop Grace"
            description="Command override and shutdown timeout"
            help="Command replaces the image CMD. Stop Grace is how long Docker waits after requesting a graceful shutdown before forcefully terminating the process."
          >
            <div className="grid w-full gap-2 sm:grid-cols-2">
              <SettingsInlineControl label="Command">
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="nginx -g daemon off;"
                  disabled={!canEdit}
                />
              </SettingsInlineControl>
              <SettingsInlineControl label="Stop Grace (s)">
                <Input
                  type="number"
                  min={0}
                  max={300}
                  step={1}
                  value={stopTimeout}
                  onChange={(e) => setStopTimeout(e.target.value)}
                  placeholder="20"
                  disabled={!canEdit}
                  style={
                    stopTimeout !== recreateBaseline.stopTimeout
                      ? { borderColor: "var(--color-warning)" }
                      : undefined
                  }
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
        </PanelShell>
      </div>

      {/* Without docker:availability:manage the block is hidden rather than shown disabled. */}
      {hasScope(`docker:availability:manage:${scopeSuffix}`) && (
        <AvailabilitySection
          resource={{ type: "container", nodeId, containerName }}
          canManage={!readOnly}
          onDisableQueued={onAvailabilityDisableQueued}
        />
      )}

      {savedRuntimeProfile !== "secure" && (
        <GpuSettingsSection
          nodeId={nodeId}
          attachment={gpuAttachment}
          canEdit={canEdit}
          deviceIds={gpuDeviceIds}
          dirty={gpuChanged}
          onDeviceIdsChange={(nextDeviceIds) => {
            gpuDraftTouchedRef.current = true;
            setGpuDeviceIds(nextDeviceIds);
          }}
        />
      )}

      {/* ─── Port Mappings ────────────────────────────────────────── */}
      <PortMappingsSection
        canEdit={canEdit}
        ports={ports}
        setPorts={setPorts}
        portsChanged={portsChanged}
        inputCell={inputCell}
        bindAddressOptions={bindAddressOptions}
      />

      {/* ─── Volume Mounts ────────────────────────────────────────── */}
      {!availabilityManaged && (
        <VolumeMountsSection
          nodeId={nodeId}
          canEdit={canEdit && canEditMounts}
          canChangeHostBinds={canChangeHostBinds}
          mounts={mounts}
          setMounts={setMounts}
          mountsChanged={mountsChanged}
          inputCell={inputCell}
        />
      )}

      {/* ─── Networks ─────────────────────────────────────────────── */}
      <NetworksSection
        nodeId={nodeId}
        networks={networks}
        setNetworks={setNetworks}
        networksChanged={networksChanged}
        canManageNetworks={canManageNetworks && !availabilityManaged}
        canListNetworks={canListNetworks}
      />

      {/* ─── Labels ───────────────────────────────────────────────── */}
      <LabelsSection
        canEdit={canEdit}
        labels={labels}
        setLabels={setLabels}
        labelsChanged={labelsChanged}
        inputCell={inputCell}
      />

      {!readOnly && (
        <DockerHealthCheckSection
          nodeId={nodeId}
          target="container"
          containerName={containerName}
          disabled={!canEdit}
          onSaved={(healthCheck) => {
            onHealthCheckSaved?.(healthCheck);
            invalidate("containers");
          }}
        />
      )}

      {/* ─── Webhook / Image Cleanup ─────────────────────────────── */}
      {(() => {
        if (readOnly) return null;
        const canManageWebhooks =
          hasScope("docker:containers:webhooks") ||
          hasScope(`docker:containers:webhooks:${scopeSuffix}`);
        if (!canManageWebhooks && !canEdit) return null;
        return (
          <WebhookSection
            nodeId={nodeId}
            containerName={containerName}
            allowWebhook={canManageWebhooks}
            allowCleanup={canEdit}
          />
        );
      })()}
    </fieldset>
  );
}
