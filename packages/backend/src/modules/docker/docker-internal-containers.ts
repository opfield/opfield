import {
  LEGACY_MANAGED_CLICKHOUSE_LABEL,
  LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL,
  LEGACY_MANAGED_SERVICE_LABEL,
  MANAGED_CLICKHOUSE_LABEL,
  MANAGED_CLICKHOUSE_OWNER_LABEL,
  MANAGED_SERVICE_LABEL,
} from '@/foundation/opfield-names.js';
import { labelString } from './docker-managed-labels.js';

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value !== '';
}
const SANDBOX_LABEL = 'net.opfield.sandbox';
// legacy-name: the legacy sandbox marker of sandbox containers created before 2.12.1 — remove once no installation runs one
const INTERNAL_MARKERS = new Set(['secure-link-connector', 'backup-runner', 'backup-redis-stage', 'connector-cleanup']);

function containerLabels(container: Record<string, any>): Record<string, unknown> {
  return container?.Config?.Labels ?? container?.Labels ?? container?.labels ?? {};
}

/**
 * Opfield-owned implementation containers must remain available to internal
 * reconciliation, but must not be exposed as user-managed Docker resources.
 */
export function isOpfieldInternalContainer(container: Record<string, any>): boolean {
  const labels = containerLabels(container);
  return (
    INTERNAL_MARKERS.has(labelString(labels, 'managed')) ||
    // Backup runners carry storage credentials in their config while a run is active.
    labelString(labels, 'backup-run-id') !== '' ||
    labelString(labels, 'managed-database.connector') === 'true' ||
    labelString(labels, 'managed-storage.connector') === 'true' ||
    labelString(labels, 'internal-workload') === 'managed-storage-connector' ||
    (labels[MANAGED_CLICKHOUSE_LABEL] === 'clickhouse' && nonEmpty(labels[MANAGED_CLICKHOUSE_OWNER_LABEL])) ||
    // legacy-name: the labels of a local ClickHouse and of Compose services created before 2.12.1.
    (labels[LEGACY_MANAGED_CLICKHOUSE_LABEL] === 'clickhouse' &&
      nonEmpty(labels[LEGACY_MANAGED_CLICKHOUSE_OWNER_LABEL])) ||
    nonEmpty(labels[MANAGED_SERVICE_LABEL]) ||
    nonEmpty(labels[LEGACY_MANAGED_SERVICE_LABEL]) ||
    labels[SANDBOX_LABEL] === 'true' ||
    labels[LEGACY_SANDBOX_LABEL] === 'true' ||
    labelString(labels, 'availability.managed') === 'true'
  );
}

export function filterOpfieldInternalContainers<T extends Record<string, any>>(containers: T[]): T[] {
  return containers.filter((container) => !isOpfieldInternalContainer(container));
}

export function assertUserContainerAccessible(container: Record<string, any> | null | undefined): void {
  if (container && isOpfieldInternalContainer(container)) {
    throw new AppError(404, 'OPFIELD_INTERNAL_CONTAINER', 'Container not found');
  }
}

export async function inspectUserContainer(
  inspector: { inspectContainer(nodeId: string, containerId: string): Promise<any> },
  nodeId: string,
  containerId: string
) {
  const data = await inspector.inspectContainer(nodeId, containerId);
  assertUserContainerAccessible(data);
  return data;
}

import { LEGACY_SANDBOX_LABEL } from '@/lib/legacy-compat.js';
import { AppError } from '@/middleware/error-handler.js';
