import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { AppActivityService } from '@/modules/apps/app-activity.service.js';
import { AppMaintenanceAccessService } from '@/modules/apps/app-maintenance-access.js';
import { AppMembersService } from '@/modules/apps/app-members.service.js';
import { AppNodesService } from '@/modules/apps/app-nodes.service.js';
import { AppOverviewService } from '@/modules/apps/app-overview.service.js';
import { AppVariablesService } from '@/modules/apps/app-variables.service.js';
import { AppActivityQuerySchema } from '@/modules/apps/apps.docs.js';
import {
  CreateAppEnvironmentSchema,
  CreateAppSchema,
  PatchAppSecretsSchema,
  PlaceAppMembersSchema,
  SetAppVariablesSchema,
  UpdateAppEnvironmentSchema,
  UpdateAppSchema,
} from '@/modules/apps/apps.schemas.js';
import { type AppActor, AppsService } from '@/modules/apps/apps.service.js';
import type { User } from '@/types.js';

export const APP_TOOL_NAMES = new Set([
  'list_apps',
  'get_app',
  'manage_app',
  'manage_app_environment',
  'manage_app_members',
  'manage_app_variables',
  'get_app_overview',
  'get_app_activity',
]);

function requiredString(value: unknown, field: string, operation: string): string {
  if (typeof value === 'string' && value) return value;
  throw new AppError(400, 'VALIDATION_ERROR', `${field} is required for ${operation}`);
}

/** list_apps, get_app, manage_app, manage_app_environment: the same service calls and checks as /api/apps. */
export async function executeAppTool(user: User, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const service = container.resolve(AppsService);
  const actor: AppActor = { userId: user.id, scopes: user.scopes };
  switch (toolName) {
    case 'list_apps':
      return { data: await service.list(actor.scopes) };
    case 'get_app':
      return service.get(actor.scopes, requiredString(args.appId, 'appId', 'get_app'));
    case 'manage_app':
      return manageApp(service, actor, args);
    case 'manage_app_environment':
      return manageEnvironment(service, actor, args);
    case 'manage_app_members':
      return manageMembers(service, actor, args);
    case 'manage_app_variables':
      return manageVariables(actor, args);
    case 'get_app_activity': {
      const query = AppActivityQuerySchema.parse({
        page: args.page,
        limit: args.limit,
        environmentId: typeof args.environmentId === 'string' && args.environmentId ? args.environmentId : undefined,
      });
      return container
        .resolve(AppActivityService)
        .list(actor.scopes, requiredString(args.appId, 'appId', 'get_app_activity'), query);
    }
    case 'get_app_overview':
      return container
        .resolve(AppOverviewService)
        .overview(
          actor.scopes,
          requiredString(args.appId, 'appId', 'get_app_overview'),
          args.range === '24h' ? '24h' : '1h'
        );
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unknown app tool: ${toolName}`);
  }
}

async function manageApp(service: AppsService, actor: AppActor, args: Record<string, unknown>) {
  const operation = String(args.operation ?? '');
  switch (operation) {
    case 'create':
      return service.create(
        actor,
        CreateAppSchema.parse({
          name: args.name,
          ...(args.description !== undefined ? { description: args.description } : {}),
        })
      );
    case 'update': {
      const input = UpdateAppSchema.parse({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.maintenanceOverride !== undefined ? { maintenanceOverride: args.maintenanceOverride } : {}),
      });
      return service.update(actor, requiredString(args.appId, 'appId', operation), input);
    }
    case 'remove_logo':
      return service.removeLogo(actor, requiredString(args.appId, 'appId', operation));
    case 'delete':
      await service.delete(actor, requiredString(args.appId, 'appId', operation));
      return { success: true };
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unsupported app operation: ${operation}`);
  }
}

async function manageEnvironment(service: AppsService, actor: AppActor, args: Record<string, unknown>) {
  const operation = String(args.operation ?? '');
  const appId = requiredString(args.appId, 'appId', operation);
  const environmentId = () => requiredString(args.environmentId, 'environmentId', operation);
  switch (operation) {
    case 'create':
      return service.createEnvironment(actor, appId, CreateAppEnvironmentSchema.parse({ name: args.name }));
    case 'rename':
      return service.updateEnvironment(
        actor,
        appId,
        environmentId(),
        UpdateAppEnvironmentSchema.parse({ name: args.name })
      );
    case 'mark_production':
      return service.updateEnvironment(actor, appId, environmentId(), { isProduction: true });
    case 'set_maintenance':
      if (typeof args.enabled !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', 'enabled is required');
      return service.updateEnvironment(actor, appId, environmentId(), { maintenanceEnabled: args.enabled });
    case 'delete':
      await service.deleteEnvironment(actor, appId, environmentId());
      return { success: true };
    case 'create_access_code':
      return container
        .resolve(AppMaintenanceAccessService)
        .issue(actor, appId, typeof args.environmentId === 'string' && args.environmentId ? args.environmentId : null);
    case 'list_nodes':
      return container.resolve(AppNodesService).list(actor, appId, environmentId());
    case 'allow_node':
      return container
        .resolve(AppNodesService)
        .allow(actor, appId, environmentId(), requiredString(args.nodeId, 'nodeId', operation));
    case 'remove_node':
      return container
        .resolve(AppNodesService)
        .remove(actor, appId, environmentId(), requiredString(args.nodeId, 'nodeId', operation));
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unsupported environment operation: ${operation}`);
  }
}

async function manageMembers(service: AppsService, actor: AppActor, args: Record<string, unknown>) {
  const operation = String(args.operation ?? '');
  switch (operation) {
    case 'list':
      return {
        data: await service.listMembers(
          actor.scopes,
          requiredString(args.appId, 'appId', operation),
          typeof args.environmentId === 'string' && args.environmentId ? args.environmentId : undefined
        ),
      };
    case 'place':
      return container
        .resolve(AppMembersService)
        .place(actor, PlaceAppMembersSchema.parse({ target: args.target ?? null, members: args.members }));
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unsupported members operation: ${operation}`);
  }
}

async function manageVariables(actor: AppActor, args: Record<string, unknown>) {
  const operation = String(args.operation ?? '');
  const appId = requiredString(args.appId, 'appId', operation);
  const environmentId = requiredString(args.environmentId, 'environmentId', operation);
  const variables = container.resolve(AppVariablesService);
  switch (operation) {
    case 'get':
      return variables.get(actor, appId, environmentId);
    case 'set_variables':
      return variables.setVariables(
        actor,
        appId,
        environmentId,
        SetAppVariablesSchema.parse({ variables: args.variables ?? [] }).variables
      );
    case 'set_secrets':
      return variables.patchSecrets(
        actor,
        appId,
        environmentId,
        PatchAppSecretsSchema.parse({ set: args.secrets ?? {} })
      );
    case 'delete_secrets':
      return variables.patchSecrets(
        actor,
        appId,
        environmentId,
        PatchAppSecretsSchema.parse({ delete: args.keys ?? [] })
      );
    case 'workload_task':
      return variables.workloadTask(actor, appId, environmentId, requiredString(args.taskId, 'taskId', operation));
    default:
      throw new AppError(400, 'VALIDATION_ERROR', `Unsupported variables operation: ${operation}`);
  }
}
