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
  'This Opfield installation is managed by the cloud; its addresses, TLS and network trust cannot be changed here.';

interface NetworkTrust {
  clientIpSource: string;
  trustedProxyCidrs: string[];
  trustCloudflareHeaders: boolean;
}

/**
 * How the console is reached on a managed installation besides its addresses: its own TLS and which proxies it
 * trusts for the client address. Values resubmitted unchanged are not listed.
 */
export async function findCloudManagedTransportChanges(
  input: { webTlsEnabled?: boolean; networkSecurity?: Partial<NetworkTrust> },
  current: { tlsEnabled: () => Promise<boolean>; networkSecurity: () => Promise<NetworkTrust> }
): Promise<string[]> {
  const changes: string[] = [];
  if (input.webTlsEnabled !== undefined && input.webTlsEnabled !== (await current.tlsEnabled())) {
    changes.push('web TLS');
  }
  const network = input.networkSecurity;
  if (network) {
    const now = await current.networkSecurity();
    const cidrs = (values: string[]) =>
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .join(',');
    if (
      (network.clientIpSource !== undefined && network.clientIpSource !== now.clientIpSource) ||
      (network.trustCloudflareHeaders !== undefined && network.trustCloudflareHeaders !== now.trustCloudflareHeaders) ||
      (network.trustedProxyCidrs !== undefined && cidrs(network.trustedProxyCidrs) !== cidrs(now.trustedProxyCidrs))
    ) {
      changes.push('network trust');
    }
  }
  return changes;
}

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
