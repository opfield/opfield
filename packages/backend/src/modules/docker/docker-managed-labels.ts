/**
 * Keys of the labels Opfield puts on the Docker objects it manages on a node (containers, networks, volumes).
 *
 * Docker daemons that advertise `opfield_labels_v1` write `net.opfield.<rest>`, read both namespaces and move an
 * object to the new keys when they next recreate it. Older daemons write and read only `wiolett.gateway.<rest>`
 * (`com.wiolett.gateway.managed-volume*` on volumes). So readers accept both keys, the `net.opfield.` one winning,
 * and writers use the namespace of the node they write to.
 */
export const OPFIELD_LABELS_CAPABILITY = 'opfield_labels_v1';
export const OPFIELD_LABEL_PREFIX = 'net.opfield.';
// legacy-name: pre-2.12.1 labels — remove once every node reports none
export const LEGACY_LABEL_PREFIX = 'wiolett.gateway.';
// legacy-name: pre-2.12.1 labels — remove once every node reports none
const LEGACY_VOLUME_LABEL_PREFIX = 'com.wiolett.gateway.';
const MANAGED_VOLUME_SUFFIX = 'managed-volume';

export type DockerLabels = Record<string, unknown> | null | undefined;

/** The `net.opfield.` key of a managed label (`deployment.id` → `net.opfield.deployment.id`). */
export function opfieldLabelKey(suffix: string): string {
  return `${OPFIELD_LABEL_PREFIX}${suffix}`;
}

/** The key a 2.12.0 daemon reads for a managed label. */
// legacy-name: pre-2.12.1 labels — remove once every node reports none
export function legacyLabelKey(suffix: string): string {
  return suffix.startsWith(MANAGED_VOLUME_SUFFIX)
    ? `${LEGACY_VOLUME_LABEL_PREFIX}${suffix}`
    : `${LEGACY_LABEL_PREFIX}${suffix}`;
}

/** The key of a managed label in the namespace the node writes. */
export function managedLabelKey(suffix: string, opfield: boolean): string {
  return opfield ? opfieldLabelKey(suffix) : legacyLabelKey(suffix);
}

/** A managed label's value: the `net.opfield.` key when set, else the legacy key. */
export function labelValue(labels: DockerLabels, suffix: string): unknown {
  if (!labels || typeof labels !== 'object') return undefined;
  const value = labels[opfieldLabelKey(suffix)];
  if (value !== undefined) return value;
  // legacy-name: pre-2.12.1 labels — remove once every node reports none
  return labels[legacyLabelKey(suffix)];
}

/** A managed label's value as a string ('' when absent or not a string). */
export function labelString(labels: DockerLabels, suffix: string): string {
  const value = labelValue(labels, suffix);
  return typeof value === 'string' ? value : '';
}

/** Whether the node's daemon writes `net.opfield.` labels (its registration advertises `opfield_labels_v1`). */
export function nodeWritesOpfieldLabels(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const list = Array.isArray(capabilities) ? capabilities : (capabilities as { capabilities?: unknown }).capabilities;
  return Array.isArray(list) && list.includes(OPFIELD_LABELS_CAPABILITY);
}
