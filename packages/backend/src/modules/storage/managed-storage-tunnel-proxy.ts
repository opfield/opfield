import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { RelayPolicyService } from '@/services/relay-policy.service.js';
export interface ManagedStorageTunnelEndpoint {
  host: '127.0.0.1';
  port: number;
}
export class ManagedStorageTunnelProxy {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(
    _relayPolicy?: Pick<RelayPolicyService, 'openStorageOpfieldTunnel'> | undefined,
    _appCertificateFingerprint?: string | undefined
  ) {}
  setAppCertificateFingerprint(_fingerprint: string): void {}
  async getEndpoint(_managedStorageId: string): Promise<ManagedStorageTunnelEndpoint> {
    return commercialModuleUnavailable();
  }
  async disposeCluster(_managedStorageId: string): Promise<void> {}
  async shutdown(): Promise<void> {}
}
