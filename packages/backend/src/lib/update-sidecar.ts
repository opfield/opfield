import { LEGACY_UPDATE_SIDECAR_NAME } from '@/lib/legacy-compat.js';

/** Marks the container that runs an Opfield self-update, so it is removed once it has finished. */
export const UPDATE_SIDECAR_LABEL = 'net.opfield.role';
export const UPDATE_SIDECAR_ROLE = 'opfield-update-sidecar';
// legacy-name: legacy update sidecars — started by releases before 2.12.1; only cleaned up — remove once no
// supported update starts from a version before 2.12.1.
export const LEGACY_UPDATE_SIDECAR_ROLE = LEGACY_UPDATE_SIDECAR_NAME;
/** The update sidecar roles of this release and the earlier ones. */
export const UPDATE_SIDECAR_ROLES: readonly string[] = [UPDATE_SIDECAR_ROLE, LEGACY_UPDATE_SIDECAR_ROLE];

/** Whether a listed container is a labelled update sidecar that still runs. */
export function isRunningLabelledUpdateSidecar(item: { State: string; Labels?: Record<string, string> }): boolean {
  const role = item.Labels?.[UPDATE_SIDECAR_LABEL];
  return item.State === 'running' && role !== undefined && UPDATE_SIDECAR_ROLES.includes(role);
}
