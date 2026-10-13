export type DockerGpuAttachmentMode = 'none' | 'managed' | 'external';

/**
 * Safe GPU metadata exposed to the browser. Docker host paths and runtime IDs
 * remain daemon-owned implementation details; callers may only reuse `deviceIds`.
 */
export interface DockerGpuAttachment {
  mode: DockerGpuAttachmentMode;
  deviceIds: string[];
  reason?: string;
}

export interface DockerGpuInventoryDevice {
  id: string;
  vendor: string;
  renderNode?: string;
}

/** True only for Docker daemons that explicitly understand Opfield GPU config. */
export function hasDockerGpuV1Capability(value: unknown): boolean {
  const capabilities = record(value);
  if (!capabilities) return false;
  if (capabilities.dockerGpuV1 === true || capabilities.docker_gpu_v1 === true) return true;
  return unknownArray(capabilities.capabilities).some((capability) => capability === 'docker_gpu_v1');
}

const EXTERNAL_GPU_ATTACHMENT_REASON = 'This container uses a GPU mapping that Opfield cannot safely modify.';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function inventoryDevice(value: unknown): DockerGpuInventoryDevice | null {
  const item = record(value);
  if (!item) return null;
  const id = stringValue(item.id ?? item.Id);
  const vendor = stringValue(item.vendor ?? item.Vendor).toLowerCase();
  if (!id || !vendor) return null;
  const renderNode = stringValue(item.renderNode ?? item.RenderNode);
  return { id, vendor, ...(renderNode ? { renderNode } : {}) };
}

function gpuDirectDevicePath(path: string): boolean {
  return (
    path === '/dev/kfd' ||
    path.startsWith('/dev/nvidia') ||
    /^\/dev\/dri\/(?:renderD|card)\d+$/.test(path) ||
    path.startsWith('/dev/vfio') ||
    path.startsWith('/dev/mdev')
  );
}

function gpuDeviceRequest(request: Record<string, unknown>): boolean {
  const driver = stringValue(request.Driver ?? request.driver).toLowerCase();
  const deviceIds = stringArray(request.DeviceIDs ?? request.deviceIds)
    .join(' ')
    .toLowerCase();
  const capabilityRows = unknownArray(request.Capabilities ?? request.capabilities);
  const capabilities = capabilityRows.flatMap((row) => stringArray(row)).map((item) => item.toLowerCase());
  return (
    driver === 'nvidia' ||
    driver.includes('nvidia') ||
    capabilities.includes('gpu') ||
    /(?:nvidia|amd|intel|gpu)/.test(deviceIds)
  );
}

/**
 * Docker CLI's ordinary `--gpus device=<UUID>` request is serialized with an
 * empty Driver. It is safe to manage only in its exact default form: explicit
 * device IDs, the single `gpu` capability, no driver options, and no count
 * selector. Any broader request remains read-only instead of being guessed.
 */
function defaultNvidiaDeviceRequest(request: Record<string, unknown>, runtimeIds: string[]): boolean {
  if (runtimeIds.length === 0) return false;

  const capabilityRows = unknownArray(request.Capabilities ?? request.capabilities).map((row) =>
    stringArray(row).map((capability) => capability.toLowerCase())
  );
  if (capabilityRows.length !== 1 || capabilityRows[0].length !== 1 || capabilityRows[0][0] !== 'gpu') {
    return false;
  }

  const options = record(request.Options ?? request.options);
  if (options && Object.keys(options).length > 0) return false;

  const count = request.Count ?? request.count;
  return count === undefined || count === null || Number(count) === 0;
}

function normalizedAttachment(value: unknown): DockerGpuAttachment | null {
  const item = record(value);
  const mode = stringValue(item?.mode);
  if (mode !== 'none' && mode !== 'managed' && mode !== 'external') return null;
  const deviceIds = stringArray(item?.deviceIds);
  const reason = stringValue(item?.reason);
  return { mode, deviceIds, ...(reason ? { reason } : {}) };
}

/**
 * Translate Docker's heterogeneous GPU host configuration into a narrow,
 * Opfield-owned attachment. A mapping only becomes manageable when it can be
 * resolved against the node's reported physical inventory. Everything else is
 * explicitly read-only instead of being guessed from host paths.
 */
export function deriveDockerGpuAttachment(inspect: unknown, inventoryInput: unknown[] = []): DockerGpuAttachment {
  const inspectRecord = record(inspect);
  if (!inspectRecord) return { mode: 'none', deviceIds: [] };

  const inventory = inventoryInput.map(inventoryDevice).filter((item): item is DockerGpuInventoryDevice => !!item);
  const nvidiaByRuntimeId = new Map<string, DockerGpuInventoryDevice>();
  const byRenderNode = new Map<string, DockerGpuInventoryDevice>();
  for (const device of inventory) {
    if (device.vendor === 'nvidia' && device.id.startsWith('nvidia:')) {
      nvidiaByRuntimeId.set(device.id.slice('nvidia:'.length), device);
    }
    if (device.renderNode) byRenderNode.set(device.renderNode, device);
  }

  const host = record(inspectRecord.HostConfig ?? inspectRecord.hostConfig) ?? {};
  const selected = new Set<string>();
  let external = false;
  let sawGPU = false;
  let sawKFD = false;
  let sawAMDRenderNode = false;

  if (stringValue(host.Runtime ?? host.runtime).toLowerCase() === 'nvidia') {
    sawGPU = true;
    external = true;
  }

  for (const candidate of unknownArray(host.DeviceRequests ?? host.deviceRequests)) {
    const request = record(candidate);
    if (!request || !gpuDeviceRequest(request)) continue;
    sawGPU = true;
    const driver = stringValue(request.Driver ?? request.driver).toLowerCase();
    const runtimeIds = stringArray(request.DeviceIDs ?? request.deviceIds);
    const managedNvidiaRequest =
      (driver === 'nvidia' || driver === '') && defaultNvidiaDeviceRequest(request, runtimeIds);
    if (!managedNvidiaRequest) {
      external = true;
      continue;
    }
    for (const runtimeId of runtimeIds) {
      const matched = nvidiaByRuntimeId.get(runtimeId);
      if (!matched) {
        external = true;
        continue;
      }
      selected.add(matched.id);
    }
  }

  for (const candidate of unknownArray(host.Devices ?? host.devices)) {
    const mapping = record(candidate);
    const hostPath = stringValue(mapping?.PathOnHost ?? mapping?.pathOnHost);
    if (!gpuDirectDevicePath(hostPath)) continue;
    sawGPU = true;
    if (hostPath === '/dev/kfd') {
      sawKFD = true;
      continue;
    }
    const matched = byRenderNode.get(hostPath);
    if (!matched) {
      external = true;
      continue;
    }
    selected.add(matched.id);
    if (matched.vendor === 'amd') sawAMDRenderNode = true;
  }

  // Opfield's AMD mapping consists of a render node plus KFD. A partial or
  // mismatched mapping is not safe to replace, even if one path was known.
  if (sawKFD && !sawAMDRenderNode) external = true;
  if (sawAMDRenderNode && !sawKFD) external = true;

  if (external) {
    return { mode: 'external', deviceIds: [...selected], reason: EXTERNAL_GPU_ATTACHMENT_REASON };
  }
  if (selected.size > 0) return { mode: 'managed', deviceIds: [...selected] };
  return sawGPU
    ? { mode: 'external', deviceIds: [], reason: EXTERNAL_GPU_ATTACHMENT_REASON }
    : { mode: 'none', deviceIds: [] };
}

/** Use the durable normalized attachment when an inspect was already decorated. */
export function dockerGpuAttachmentFromInspect(inspect: unknown): DockerGpuAttachment {
  const inspectRecord = record(inspect);
  const attached = normalizedAttachment(inspectRecord?.gpuAttachment);
  return attached ?? deriveDockerGpuAttachment(inspect);
}

export function hasRequestedGpuChange(config: Record<string, unknown>): boolean {
  return Object.hasOwn(config, 'gpu');
}
