import { LEGACY_LABEL_PREFIX } from "../../../backend/src/lib/legacy-compat";
/**
 * Labels Opfield puts on the Docker objects it manages. Docker daemons of 2.12.1 and later write `net.opfield.<rest>`
 * and move an object to those keys when they next recreate it; objects created earlier still carry
 * LEGACY_LABEL_PREFIX<rest>. Readers take the `net.opfield.` key first.
 */
export const OPFIELD_LABEL_PREFIX = "net.opfield.";
// legacy-name: pre-2.12.1 Docker labels — remove once every node reports none
export { LEGACY_LABEL_PREFIX };

type Labels = Record<string, string | undefined> | null | undefined;

/** Both keys of a managed label, the current one first (`deployment.id` → `net.opfield.deployment.id`, …). */
export function managedLabelKeys(suffix: string): [string, string] {
  return [`${OPFIELD_LABEL_PREFIX}${suffix}`, `${LEGACY_LABEL_PREFIX}${suffix}`];
}

/** A managed label's value: the `net.opfield.` key when set, else the previous key. */
export function managedLabel(labels: Labels, suffix: string): string | undefined {
  if (!labels) return undefined;
  for (const key of managedLabelKeys(suffix)) {
    const value = labels[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Whether `key` is the managed label `suffix` under either name. */
export function isManagedLabelKey(key: string, suffix: string): boolean {
  return managedLabelKeys(suffix).includes(key);
}

/** Whether `key` is a managed label under `prefix` (`availability.` …) under either name. */
export function hasManagedLabelPrefix(key: string, prefix: string): boolean {
  return managedLabelKeys(prefix).some((start) => key.startsWith(start));
}
