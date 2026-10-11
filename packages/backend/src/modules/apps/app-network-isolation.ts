import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes } from '@/db/schema/index.js';
import type { CommandResult } from '@/grpc/generated/types.js';
import { AppError } from '@/middleware/error-handler.js';
import { nodeReportsCapability } from '@/modules/ingress-groups/ingress-group-routing.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

/** Advertised by docker daemons that run the network_isolate and network_restore container actions. */
export const DOCKER_NETWORK_ISOLATION_CAPABILITY = 'docker_network_isolation_v1';

/** The daemon's error for a container on the host's or another container's network stack. */
const HOST_NETWORK_PREFIX = 'HOST_NETWORK:';

/** The user configuration of one network endpoint a container was disconnected from. */
export interface IsolatedEndpoint {
  networkId: string;
  networkName: string;
  aliases: string[];
  ipv4Address: string | null;
  ipv6Address: string | null;
  linkLocalIps: string[];
  links: string[];
  driverOpts: Record<string, string>;
  macAddress: string | null;
  gwPriority: number | null;
}

export interface NetworkIsolateResult {
  networkMode: string;
  endpoints: IsolatedEndpoint[];
}

export interface NetworkRestoreResult {
  restored: string[];
  failed: Array<{ networkName: string; networkId: string; error: string }>;
}

type IsolationDispatch = Pick<NodeDispatchService, 'isolateContainerNetworks' | 'restoreContainerNetworks'>;

/** Detaches a container from every Docker network and puts it back exactly as it was. */
export class AppNetworkIsolation {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dispatch: IsolationDispatch
  ) {}

  /** Whether the node's docker daemon reports DOCKER_NETWORK_ISOLATION_CAPABILITY. */
  async supports(nodeId: string): Promise<boolean> {
    const [node] = await this.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    return nodeReportsCapability(node?.capabilities, DOCKER_NETWORK_ISOLATION_CAPABILITY);
  }

  async isolate(nodeId: string, container: string): Promise<NetworkIsolateResult> {
    await this.assertSupported(nodeId);
    const result = await this.dispatch.isolateContainerNetworks(nodeId, container);
    if (!result.success) {
      const error = result.error || 'Network isolation failed';
      if (error.startsWith(HOST_NETWORK_PREFIX)) {
        throw new AppError(409, 'HOST_NETWORK', error.slice(HOST_NETWORK_PREFIX.length).trim());
      }
      throw new AppError(502, 'NETWORK_ISOLATION_FAILED', error);
    }
    const detail = parseDetail(result, 'NETWORK_ISOLATION_FAILED');
    return {
      networkMode: str(detail.networkMode),
      endpoints: Array.isArray(detail.endpoints) ? detail.endpoints.map(normalizeEndpoint) : [],
    };
  }

  async restore(nodeId: string, container: string, endpoints: IsolatedEndpoint[]): Promise<NetworkRestoreResult> {
    await this.assertSupported(nodeId);
    const result = await this.dispatch.restoreContainerNetworks(nodeId, container, endpoints.map(toDaemonEndpoint));
    if (!result.success) {
      throw new AppError(502, 'NETWORK_RESTORE_FAILED', result.error || 'Network restore failed');
    }
    const detail = parseDetail(result, 'NETWORK_RESTORE_FAILED');
    return {
      restored: strings(detail.restored),
      failed: Array.isArray(detail.failed)
        ? detail.failed.map((entry) => {
            const failure = record(entry);
            return {
              networkName: str(failure.networkName),
              networkId: str(failure.networkId),
              error: str(failure.error),
            };
          })
        : [],
    };
  }

  private async assertSupported(nodeId: string) {
    if (!(await this.supports(nodeId))) {
      throw new AppError(409, 'NODE_UPDATE_REQUIRED', 'Update the node to isolate containers');
    }
  }
}

function parseDetail(result: CommandResult, code: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(result.detail || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new AppError(502, code, 'Docker daemon returned an invalid network isolation response');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeEndpoint(value: unknown): IsolatedEndpoint {
  const endpoint = record(value);
  const driverOpts: Record<string, string> = {};
  for (const [key, option] of Object.entries(record(endpoint.driverOpts))) {
    if (typeof option === 'string') driverOpts[key] = option;
  }
  return {
    networkId: str(endpoint.networkId),
    networkName: str(endpoint.networkName),
    aliases: strings(endpoint.aliases),
    ipv4Address: optionalStr(endpoint.ipv4Address),
    ipv6Address: optionalStr(endpoint.ipv6Address),
    linkLocalIps: strings(endpoint.linkLocalIps),
    links: strings(endpoint.links),
    driverOpts,
    macAddress: optionalStr(endpoint.macAddress),
    gwPriority:
      typeof endpoint.gwPriority === 'number' && Number.isInteger(endpoint.gwPriority) ? endpoint.gwPriority : null,
  };
}

/** The daemon's wire shape: empty strings and 0 instead of null. */
function toDaemonEndpoint(endpoint: IsolatedEndpoint) {
  return {
    networkId: endpoint.networkId,
    networkName: endpoint.networkName,
    aliases: endpoint.aliases,
    ipv4Address: endpoint.ipv4Address ?? '',
    ipv6Address: endpoint.ipv6Address ?? '',
    linkLocalIps: endpoint.linkLocalIps,
    links: endpoint.links,
    driverOpts: endpoint.driverOpts,
    macAddress: endpoint.macAddress ?? '',
    gwPriority: endpoint.gwPriority ?? 0,
  };
}
