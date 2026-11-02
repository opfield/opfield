import { AppError } from '@/middleware/error-handler.js';
import type {
  HostingActionRequest,
  HostingCapabilities,
  HostingProvider,
  HostingResourceSnapshot,
} from './hosting-provider.types.js';
import { hostingRecoveryScript } from './hosting-recovery-script.js';

/**
 * What a hosting action needs from the VM, read from one observation of it. The request checks the stored snapshot so
 * the caller gets the 4xx at once; the worker checks the live read before it dispatches. Both use these rules.
 */
export interface HostingActionTarget {
  provider: HostingProvider;
  live: HostingResourceSnapshot;
  bound: Array<{ nodeId: string; type: string }>;
  /** Whether the provider adapter has a guest channel for recovery. */
  canBootstrap: boolean;
}

export type HostingResizeStopScope = 'always' | 'cpu_memory';

/** A Proxmox container grows its disk online; every other resize (CPU/RAM, QEMU VMs, cloud sizes) needs a stop. */
function growsDiskOnline(provider: HostingProvider, kind: HostingResourceSnapshot['kind']) {
  return provider === 'proxmox' && kind === 'ct';
}

/** Whether a resize needs the guest stopped while it is not, and why. Null when it does not or the guest is stopped. */
export function hostingResizeStopRequirement(
  provider: HostingProvider,
  resource: Pick<HostingResourceSnapshot, 'kind' | 'powerState'>
): { scope: HostingResizeStopScope; reason: string } | null {
  if (resource.powerState === 'stopped') return null;
  if (growsDiskOnline(provider, resource.kind))
    return {
      scope: 'cpu_memory',
      reason: 'Changing CPU or memory needs the container shut down. Growing the disk works while it runs.',
    };
  return { scope: 'always', reason: 'Shut down the VM before resizing it.' };
}

function withPowerState(capabilities: HostingCapabilities, powerState: HostingResourceSnapshot['powerState']) {
  if (powerState === 'running' && capabilities.start.available)
    return { ...capabilities, start: { available: false, reason: 'The VM is already running' } };
  if (powerState !== 'stopped') return capabilities;
  const stopped = { available: false, reason: 'The VM is stopped' };
  return {
    ...capabilities,
    ...(capabilities.shutdown.available ? { shutdown: stopped } : {}),
    ...(capabilities.reboot.available ? { reboot: stopped } : {}),
  };
}

/**
 * The capabilities as shown to users: a resize that needs a stop says so and stays available, and a power action the
 * VM is already in the state of is not offered (assertHostingPowerAction refuses it).
 */
export function advertisedHostingCapabilities(
  provider: HostingProvider,
  resource: HostingResourceSnapshot
): HostingCapabilities {
  const capabilities = withPowerState(resource.capabilities, resource.powerState);
  if (!capabilities.resize.available) return capabilities;
  const stop = hostingResizeStopRequirement(provider, resource);
  if (!stop) return capabilities;
  return { ...capabilities, resize: { ...capabilities.resize, reason: stop.reason, stopRequired: stop.scope } };
}

function assertResize(target: HostingActionTarget, input: HostingActionRequest) {
  const { provider, live } = target;
  if (input.diskGb !== undefined && (live.diskGb === null || input.diskGb < live.diskGb))
    throw new AppError(400, 'HOSTING_DISK_SHRINK_UNSUPPORTED', 'Shrinking disks is not supported');
  if (live.powerState === 'stopped') return;
  if (growsDiskOnline(provider, live.kind)) {
    const changesCpuMemory =
      (input.cpu !== undefined && input.cpu !== live.cpu) ||
      (input.memoryMb !== undefined && input.memoryMb !== live.memoryMb);
    if (!changesCpuMemory) return;
    throw new AppError(
      409,
      'HOSTING_VM_MUST_STOP',
      'Shut down the container before changing CPU or memory. Growing the disk works while it runs.'
    );
  }
  throw new AppError(409, 'HOSTING_VM_MUST_STOP', 'Shut down the VM before resizing');
}

/** Whether destroying this VM first shuts it down (Proxmox only: it refuses to destroy a running guest). */
export function hostingDeleteStopsFirst(provider: HostingProvider, live: HostingResourceSnapshot): boolean {
  return provider === 'proxmox' && live.powerState !== 'stopped';
}

/** Refuses an action the VM's current state or bindings make impossible, before anything is sent to the provider. */
export function assertHostingActionPreconditions(target: HostingActionTarget, input: HostingActionRequest): void {
  const { live } = target;
  if (input.action === 'resize') assertResize(target, input);
  if (input.action === 'recover') {
    if (!target.canBootstrap || !live.capabilities.recover.available)
      throw new AppError(409, 'HOSTING_RECOVERY_UNAVAILABLE', 'No independent daemon recovery channel is available');
    if (live.powerState !== 'running')
      throw new AppError(409, 'HOSTING_VM_STOPPED', 'Start the VM before restarting its daemon');
    if (!target.bound.length)
      throw new AppError(409, 'HOSTING_NODE_BINDING_REQUIRED', 'No Opfield node is associated with this VM');
    // Throws when a role has no known service restart.
    hostingRecoveryScript(target.bound.map((binding) => binding.type));
  }
  if (
    input.action === 'delete' &&
    hostingDeleteStopsFirst(target.provider, live) &&
    !live.capabilities.shutdown.available
  )
    throw new AppError(
      403,
      'HOSTING_STOP_UNAVAILABLE',
      live.capabilities.shutdown.reason ?? 'VM shutdown permission is required before destruction'
    );
}

/** Request time only: a power action the VM is already in the state of is refused instead of sent. */
export function assertHostingPowerAction(live: HostingResourceSnapshot, input: HostingActionRequest): void {
  if (input.action === 'start' && live.powerState === 'running')
    throw new AppError(409, 'HOSTING_VM_RUNNING', 'The VM is already running');
  if ((input.action === 'shutdown' || input.action === 'reboot') && live.powerState === 'stopped')
    throw new AppError(409, 'HOSTING_VM_STOPPED', 'The VM is stopped');
}
