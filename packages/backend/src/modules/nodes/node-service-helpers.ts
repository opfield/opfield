import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';

export function createNodeFileOperationContext(
  nodeDispatch: NodeDispatchService,
  auditService: AuditService,
  eventBus?: EventBusService
) {
  return { nodeDispatch, auditService, eventBus, parseResult: parseNodeCommandResult };
}

export function isNonEmptyAddressSubset(addresses: string[], allowedAddresses: string[]): boolean {
  const allowed = new Set(allowedAddresses);
  return addresses.length > 0 && addresses.every((address) => allowed.has(address));
}

export function orderedAddressesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

/**
 * Whether a node's last health report shows it working (the rule of its health history): a Docker node whose engine
 * cannot start containers, or an nginx node whose nginx is stopped or whose configuration is invalid, is degraded.
 */
export function nodeReportHealthy(
  type: string | null | undefined,
  report:
    | { nginxRunning?: boolean; configValid?: boolean; dockerEngine?: { available?: boolean } | null }
    | null
    | undefined
): boolean {
  if (!report) return true;
  return type === 'nginx'
    ? report.nginxRunning !== false && report.configValid !== false
    : report.dockerEngine?.available !== false;
}

/**
 * The node's health next to its connection status (rc.3 O-A1): `status` says whether the node is connected; `health`
 * is `degraded` while a connected node reports a problem (Docker Engine cannot start containers, nginx stopped or its
 * configuration invalid), `healthy` otherwise, and null while the node is not online.
 */
export function nodeHealth(
  type: string | null | undefined,
  status: string,
  report: unknown
): 'healthy' | 'degraded' | null {
  if (status !== 'online') return null;
  return nodeReportHealthy(type, report as Parameters<typeof nodeReportHealthy>[1]) ? 'healthy' : 'degraded';
}

export function stripNodeHealthHistory<T extends { healthHistory?: unknown }>(node: T): Omit<T, 'healthHistory'> {
  const { healthHistory: _healthHistory, ...rest } = node;
  return rest;
}

export function parseNodeCommandResult(result: { success: boolean; error?: string; detail?: string }) {
  if (!result.success) {
    // The daemon's own user may not open the path (a daemon that runs without root): a refusal, not a daemon failure.
    if (/permission denied|operation not permitted/i.test(result.error ?? '')) {
      throw new AppError(
        403,
        'NODE_FILE_PERMISSION_DENIED',
        `The node's daemon has no permission for this path: ${result.error}`
      );
    }
    // A path that does not exist (for example a file deleted while its editor was open) is a 404, not a daemon failure.
    if (/no such file or directory/i.test(result.error ?? '')) {
      throw new AppError(404, 'NODE_FILE_NOT_FOUND', `The path does not exist on the node: ${result.error}`);
    }
    throw new AppError(502, 'DISPATCH_ERROR', result.error || 'Command failed on daemon');
  }
  try {
    return result.detail ? JSON.parse(result.detail) : null;
  } catch {
    return result.detail;
  }
}
