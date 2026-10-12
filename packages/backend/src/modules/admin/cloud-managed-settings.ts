import type { GeneralSettings, GeneralSettingsUpdate } from '@/modules/settings/general-settings.service.js';
import {
  normalizeHostPortTarget,
  normalizeIpPortTarget,
  normalizePublicUrl,
} from '@/modules/settings/general-settings.service.js';

/**
 * Addresses the cloud set up on a managed installation: the public URL and the gRPC targets nodes enrol with. On a
 * managed installation only the system (enrolment file, setup, restore) changes them; Settings, the API and MCP may
 * resubmit them unchanged.
 */
const CLOUD_MANAGED_FIELDS = [
  ['publicUrl', 'the public URL', normalizePublicUrl],
  ['gatewayGrpcPublicTarget', 'the gRPC public target', normalizeHostPortTarget],
  ['gatewayGrpcLocalIp', 'the gRPC local IP', normalizeIpPortTarget],
] as const;

export const CLOUD_MANAGED_SETTINGS_MESSAGE =
  'This Opfield installation is managed by the cloud; its public URL and gRPC addresses cannot be changed here.';

/** Whether the update carries any of the cloud-managed addresses (changed or not). */
export function touchesCloudManagedSettings(input: GeneralSettingsUpdate | undefined): boolean {
  return !!input && CLOUD_MANAGED_FIELDS.some(([key]) => input[key] !== undefined);
}

/** The cloud-managed addresses the update would change; values resubmitted unchanged are not listed. */
export function findCloudManagedChanges(
  input: GeneralSettingsUpdate | undefined,
  current: Pick<GeneralSettings, 'publicUrl' | 'gatewayGrpcPublicTarget' | 'gatewayGrpcLocalIp'>
): string[] {
  if (!input) return [];
  const changes: string[] = [];
  for (const [key, label, normalize] of CLOUD_MANAGED_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    let next: string | null;
    try {
      next = normalize(value);
    } catch {
      // Not a valid value, so certainly not the current one.
      changes.push(label);
      continue;
    }
    if (next !== current[key]) changes.push(label);
  }
  return changes;
}
