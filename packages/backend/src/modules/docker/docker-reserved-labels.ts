import {
  LEGACY_COM_LABEL_PREFIX,
  LEGACY_LABEL_PREFIX,
  LEGACY_NET_LABEL_PREFIX,
  LEGACY_SANDBOX_LABEL,
} from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';

/**
 * Label namespaces Opfield and Docker Compose read to place, group or hide a container. A caller who
 * sets one can move a container out of its folder (a Compose project label re-homes it into that
 * project's root-level system folder) or hide it from every user (Opfield implementation markers), so
 * user-supplied labels never carry them.
 */
const RESERVED_DOCKER_LABEL_PREFIXES = [
  'com.docker.compose.',
  'net.opfield.',
  // The pre-Opfield namespaces stay reserved for good: containers created before the rename still carry them and
  // older daemons still read them, so a user must never forge one on an object.
  LEGACY_LABEL_PREFIX,
  LEGACY_NET_LABEL_PREFIX,
  LEGACY_COM_LABEL_PREFIX,
] as const;
const RESERVED_DOCKER_LABELS = new Set([LEGACY_SANDBOX_LABEL]);

export function isReservedDockerLabel(key: string): boolean {
  return RESERVED_DOCKER_LABELS.has(key) || RESERVED_DOCKER_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Reserved labels a caller asks to add or change; `current` holds the container's labels (none for a new one). */
export function changedReservedDockerLabels(
  requested: Record<string, string> | undefined,
  current: Record<string, unknown> = {}
): string[] {
  return Object.entries(requested ?? {})
    .filter(([key, value]) => isReservedDockerLabel(key) && current[key] !== value)
    .map(([key]) => key);
}

export function reservedDockerLabelsMessage(keys: readonly string[]): string {
  return `Labels ${keys.join(', ')} are reserved for Opfield and Docker Compose`;
}

export function assertNoReservedDockerLabelChanges(
  requested: Record<string, string> | undefined,
  current?: Record<string, unknown>
): void {
  const keys = changedReservedDockerLabels(requested, current);
  if (keys.length > 0) throw new AppError(400, 'RESERVED_DOCKER_LABEL', reservedDockerLabelsMessage(keys));
}

/** Docker daemons that drop reserved labels when duplicating a container advertise this capability. */
export const DOCKER_DUPLICATE_LABEL_FILTER_CAPABILITY = 'docker_duplicate_label_filter_v1';

/** Daemon-owned data describing the copied configuration itself; a duplicate keeps it. */
const DUPLICATE_KEPT_LABELS = new Set([
  'net.opfield.archive.image.reference',
  'net.opfield.gpu.group-ids',
  'net.opfield.gpu.group-ids-version',
  // legacy-name: LEGACY_LABEL_PREFIX* labels — remove once every node reports none
  `${LEGACY_LABEL_PREFIX}archive.image.reference`,
  `${LEGACY_LABEL_PREFIX}gpu.group-ids`,
  `${LEGACY_LABEL_PREFIX}gpu.group-ids-version`,
]);

/** Reserved labels of a source container that a duplicate must not inherit. */
export function reservedLabelsDroppedOnDuplicate(labels: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(labels ?? {}).filter((key) => isReservedDockerLabel(key) && !DUPLICATE_KEPT_LABELS.has(key));
}

export function hasDuplicateLabelFilterCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const list = (capabilities as { capabilities?: unknown }).capabilities;
  return Array.isArray(list) && list.includes(DOCKER_DUPLICATE_LABEL_FILTER_CAPABILITY);
}

/**
 * A duplicate is a new user workload: it must not inherit the labels that place, group or hide a container (a
 * Compose project label would move it into that project's root-level folder). Daemons with the label filter drop
 * them; older daemons copy every label, so duplicating such a container there is refused.
 */
export function assertDuplicateDropsReservedLabels(
  sourceLabels: Record<string, unknown> | null | undefined,
  nodeCapabilities: unknown
): void {
  const reserved = reservedLabelsDroppedOnDuplicate(sourceLabels);
  if (reserved.length === 0 || hasDuplicateLabelFilterCapability(nodeCapabilities)) return;
  throw new AppError(
    409,
    'UNSUPPORTED_DAEMON',
    `This container carries labels reserved for Opfield and Docker Compose (${reserved.join(', ')}) that this ` +
      'Docker daemon would copy into the duplicate. Update the Docker daemon before duplicating it.'
  );
}
