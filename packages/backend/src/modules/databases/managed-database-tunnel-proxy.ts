import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';

export type ManagedDatabaseTunnelLane = 'interactive' | 'monitoring';
export interface ManagedDatabaseTunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}

export class ManagedDatabaseTunnelProxy {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(_relayPolicy?: Pick<RelayPolicyService, 'openOpfieldTunnel'>, _appCertificateFingerprint?: string) {}
  setAppCertificateFingerprint(_fingerprint: string): void {}
  async getEndpoint(
    _managedDatabaseId: string,
    _lane?: ManagedDatabaseTunnelLane
  ): Promise<ManagedDatabaseTunnelEndpoint> {
    return commercialModuleUnavailable();
  }
  async disposeDatabase(_managedDatabaseId: string): Promise<void> {}
  async shutdown(): Promise<void> {}
}
