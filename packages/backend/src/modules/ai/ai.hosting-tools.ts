import { z } from 'zod';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  CreateHostingConnectorSchema,
  DiscoverHostingConnectorSchema,
  HostingActionSchema,
  HostingAdoptSchema,
  HostingProvisionSchema,
  UpdateHostingConnectorSchema,
} from '@/modules/hosting/hosting.schemas.js';
import { HostingConnectorsService } from '@/modules/hosting/hosting-connectors.service.js';
import { HostingFirewallService } from '@/modules/hosting/hosting-firewall.service.js';
import { HostingFirewallUpdateSchema } from '@/modules/hosting/hosting-firewall.types.js';
import { HostingInventoryService } from '@/modules/hosting/hosting-inventory.service.js';
import { HostingManagementService } from '@/modules/hosting/hosting-management.service.js';
import { HostingOperationsService } from '@/modules/hosting/hosting-operations.service.js';
import { HostingProvisioningService } from '@/modules/hosting/hosting-provisioning.service.js';
import { HostingSnapshotInputSchema } from '@/modules/hosting/hosting-snapshots.service.js';
import type { User } from '@/types.js';

export const HOSTING_TOOL_NAMES = new Set(['manage_hosting']);

/** Same body schema as POST /hosting/operations/:id/retry-install. */
const RetryInstallSchema = z
  .object({ idempotencyKey: z.string().uuid(), sshConnectorId: z.string().uuid().optional() })
  .strict();

const SnapshotFolderOperationSchema = z.enum([
  'create',
  'rename',
  'delete',
  'reorder-folders',
  'move-resources',
  'reorder-resources',
]);

const uuid = (value: unknown, label: string) => {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new AppError(400, 'INVALID_AI_TOOL_ARGUMENT', `${label} must be a UUID`);
  return parsed.data;
};

/**
 * provision carries the account inside input, like POST /hosting/operations. A top-level connectorId is taken
 * as input.connectorId when input has none, and refused when it names another account, never silently dropped.
 */
function provisionBody(args: Record<string, unknown>, input: unknown): unknown {
  if (args.connectorId === undefined) return input;
  const connectorId = uuid(args.connectorId, 'connectorId');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const body = input as Record<string, unknown>;
  if (body.connectorId === undefined) return { ...body, connectorId };
  if (body.connectorId !== connectorId)
    throw new AppError(
      400,
      'INVALID_AI_TOOL_ARGUMENT',
      'connectorId and input.connectorId name different hosting accounts; pass the account once, inside input'
    );
  return body;
}

/**
 * Hosting routes delegate every permission check to the hosting services,
 * which receive the acting user with its effective scopes. The tool passes
 * the same user, so scope, folder, adoption-authority, and billing checks are
 * identical to the REST API.
 */
export async function executeHostingTool(user: User, toolName: string, args: Record<string, unknown>) {
  if (toolName !== 'manage_hosting') throw new Error(`Unsupported hosting tool: ${toolName}`);
  const operation = typeof args.operation === 'string' ? args.operation : '';
  const input = args.input ?? {};
  const connectors = () => container.resolve(HostingConnectorsService);
  const inventory = () => container.resolve(HostingInventoryService);
  const provisioning = () => container.resolve(HostingProvisioningService);
  const operations = () => container.resolve(HostingOperationsService);
  const management = () => container.resolve(HostingManagementService);
  const firewall = () => container.resolve(HostingFirewallService);
  const connectorId = () => uuid(args.connectorId, 'connectorId');
  const nodeId = () => uuid(args.nodeId, 'nodeId');
  const operationId = () => uuid(args.operationId, 'operationId');
  const resourceId = () => uuid(args.resourceId, 'resourceId');

  switch (operation) {
    // ── Hosting accounts (/api/integrations/hosting) ──
    case 'connector_list':
      return connectors().list(user);
    case 'connector_get': {
      const service = connectors();
      return service.safe(await service.get(connectorId(), user));
    }
    case 'connector_configuration':
      return connectors().configuration(connectorId(), user);
    case 'connector_preview':
      return connectors().preview(CreateHostingConnectorSchema.parse(input), user);
    case 'connector_discover':
      return connectors().discover(DiscoverHostingConnectorSchema.parse(input), user);
    case 'connector_create':
      return connectors().create(CreateHostingConnectorSchema.parse(input), user);
    case 'connector_update':
      return connectors().update(connectorId(), UpdateHostingConnectorSchema.parse(input), user);
    case 'connector_delete':
      return connectors().remove(connectorId(), user);
    case 'connector_test':
      return connectors().test(connectorId(), user);
    case 'connector_sync':
      return inventory().sync(connectorId(), user);
    case 'catalog':
      return provisioning().catalog(connectorId(), user);
    case 'resources':
      return inventory().resources(connectorId(), user);
    case 'adoption_candidates':
      return inventory().adoptionCandidates(connectorId(), user);
    case 'adopt':
      return inventory().adoptNode(connectorId(), HostingAdoptSchema.parse(input), user);
    case 'operations_list':
      return operations().list(connectorId(), user);
    case 'account_summary':
      return inventory().accountSummary(connectorId(), user);
    // ── Hosted nodes and operations (/api/hosting) ──
    case 'node_bindings':
      return inventory().nodeBindings(user);
    case 'node_get':
      return inventory().nodeProjection(nodeId(), user);
    case 'node_firewall_get':
      return firewall().get(nodeId(), user);
    case 'node_firewall_update':
      return firewall().update(nodeId(), HostingFirewallUpdateSchema.parse(input), user);
    case 'provision':
      return provisioning().create(HostingProvisionSchema.parse(provisionBody(args, input)), user);
    case 'operation_get':
      return operations().get(operationId(), user);
    case 'operation_reconcile':
      return operations().reconcileNow(operationId(), user);
    case 'operation_retry_install':
      return provisioning().retryInstall(operationId(), RetryInstallSchema.parse(input), user);
    case 'resource_action':
      return management().action(resourceId(), HostingActionSchema.parse(input), user);
    case 'snapshots_list':
      return management().snapshots.view(resourceId(), user);
    case 'snapshot_folders':
      return management().snapshots.folders(resourceId(), user);
    case 'snapshot_action':
      return management().snapshots.action(resourceId(), HostingSnapshotInputSchema.parse(input), user);
    case 'snapshot_folder_action':
      return management().snapshots.folderAction(
        resourceId(),
        user,
        SnapshotFolderOperationSchema.parse(args.folderOperation),
        input,
        args.folderId === undefined ? undefined : uuid(args.folderId, 'folderId')
      );
    default:
      throw new AppError(400, 'INVALID_AI_TOOL_OPERATION', `Unsupported hosting operation: ${operation}`);
  }
}
