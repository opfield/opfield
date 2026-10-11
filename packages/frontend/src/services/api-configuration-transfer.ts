import type { ApiClientBaseConstructor } from "./api-mixins";

export interface ConfigurationExportSection {
  bytes: number | null;
  available: boolean;
  /** Why an optional section cannot be included. */
  reason?: string;
}

export interface ConfigurationExportEstimate {
  available: boolean;
  unavailableReason: string | null;
  gatewayVersion: string;
  sections: {
    database: ConfigurationExportSection;
    files: ConfigurationExportSection;
    registry: ConfigurationExportSection;
    logs: ConfigurationExportSection;
  };
  /** What the new host keeps from its own installation or asks for during the restore. */
  hostSpecific: string[];
}

export type ConfigurationExportState = "ready" | "running" | "completed" | "failed";

export interface ConfigurationExportProgress {
  id: string;
  state: ConfigurationExportState;
  options: { includeRegistry: boolean; includeLogs: boolean };
  filename: string;
  bytesWritten: number;
  estimatedBytes: number | null;
  currentPart: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ConfigurationExportStart {
  export: ConfigurationExportProgress;
  /** One-time link that streams the encrypted file; needs no auth header. */
  downloadUrl: string;
  expiresAt: string;
}

export type GatewayMoveNodeStateName =
  | "ready"
  | "told"
  | "pending"
  | "offline"
  | "unsupported"
  | "failed";

export interface GatewayMoveNodeState {
  nodeId: string;
  name: string;
  type: string;
  state: GatewayMoveNodeStateName;
  error?: string;
}

export interface GatewayMoveStatus {
  announcement: { address: string; announcedAt: string; userId: string | null } | null;
  currentAddress: string | null;
  nodes: GatewayMoveNodeState[];
}

const BASE = "/system/configuration-export";

export function withConfigurationTransferApi<TBase extends ApiClientBaseConstructor>(Base: TBase) {
  return class ConfigurationTransferApiClient extends Base {
    async getConfigurationExportEstimate(): Promise<ConfigurationExportEstimate> {
      return this.unwrapData(this.request<{ data: ConfigurationExportEstimate }>(BASE));
    }

    async startConfigurationExport(input: {
      passphrase: string;
      includeRegistry: boolean;
      includeLogs: boolean;
    }): Promise<ConfigurationExportStart> {
      return this.unwrapData(
        this.request<{ data: ConfigurationExportStart }>(BASE, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
    }

    async getConfigurationExportProgress(id: string): Promise<ConfigurationExportProgress> {
      return this.unwrapData(
        this.request<{ data: ConfigurationExportProgress }>(`${BASE}/${encodeURIComponent(id)}`)
      );
    }

    async getGatewayMoveStatus(): Promise<GatewayMoveStatus> {
      return this.unwrapData(this.request<{ data: GatewayMoveStatus }>(`${BASE}/move`));
    }

    /** Announces the address nodes move to, or withdraws it with null. */
    async setGatewayMoveAddress(address: string | null): Promise<GatewayMoveStatus> {
      return this.unwrapData(
        this.request<{ data: GatewayMoveStatus }>(`${BASE}/move`, {
          method: "PUT",
          body: JSON.stringify({ address }),
        })
      );
    }
  };
}
