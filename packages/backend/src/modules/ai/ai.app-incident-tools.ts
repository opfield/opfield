import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { AppIncidentService } from '@/modules/apps/app-isolation.service.js';
import type { AppActor } from '@/modules/apps/apps.service.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';

export const APP_INCIDENT_TOOL_NAMES = new Set(['manage_app_incident']);

export const APP_INCIDENT_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_app_incident',
    description:
      'Shut down / start an app, or isolate it with the kill switch / turn the kill switch off, per environment (environmentIds; apps:operate on each) or for every environment (omit environmentIds; apps:operate on the app). shutdown: running containers, deployments and Compose projects stop, managed databases and storage pause, routes and Pages routes show the maintenance page; start restores exactly what the shutdown stopped (left alone if changed by hand meanwhile); while shut down, deleting or unbinding members, renames, migration and Compose down answer 409 APP_INCIDENT_ACTIVE, and an isolated app or environment is not shut down (409 APP_ISOLATED: release first). isolate (confirmName = the app name): routes of the environment and routes whose upstream is a member show the maintenance page without team access, container links and database/storage bindings touching a member are suspended, Secure Links to members close, direct database/storage publications are suspended, every member container loses its networks (host-network containers stop); members are frozen until release: every change, delete and unbind answers 409 APP_ISOLATED (reads, logs, console, stop/restart/start still work). release restores every recorded item from its prior state. Both run in the background: status lists the incidents with their items (pending/applied/failed/restored/restore_failed/gone; detail says what a restored or gone item could not put back as it was, e.g. a network removed meanwhile); preview (kind shutdown or isolation) counts what would change without changing anything.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['shutdown', 'start', 'isolate', 'release', 'status', 'preview'] },
        appId: { type: 'string', description: 'App id or slug.' },
        environmentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Environments to act on; omit for every environment of the app.',
        },
        confirmName: { type: 'string', description: 'isolate: the app name, typed to confirm.' },
        kind: { type: 'string', enum: ['shutdown', 'isolation'], description: 'preview: which action to preview.' },
      },
      required: ['operation', 'appId'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps'],
  },
];

function environmentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** manage_app_incident: the same service calls and checks as the /api/apps incident routes. */
export async function executeAppIncidentTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  const service = container.resolve(AppIncidentService);
  const actor: AppActor = { userId: user.id, scopes: user.scopes };
  const appId = typeof args.appId === 'string' && args.appId ? args.appId : null;
  if (!appId) throw new AppError(400, 'VALIDATION_ERROR', 'appId is required');
  const envs = environmentIds(args.environmentIds);
  switch (String(args.operation ?? '')) {
    case 'shutdown':
      return { data: await service.shutdown(actor, appId, envs) };
    case 'start':
      return { data: await service.start(actor, appId, envs) };
    case 'isolate':
      return { data: await service.isolate(actor, appId, envs, String(args.confirmName ?? '')) };
    case 'release':
      return { data: await service.release(actor, appId, envs) };
    case 'status':
      return { data: await service.list(actor.scopes, appId) };
    case 'preview': {
      const kind = args.kind === 'isolation' ? 'isolation' : args.kind === 'shutdown' ? 'shutdown' : null;
      if (!kind) throw new AppError(400, 'VALIDATION_ERROR', 'kind (shutdown or isolation) is required for preview');
      return { data: await service.preview(actor, appId, kind, envs) };
    }
    default:
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'operation must be shutdown, start, isolate, release, status or preview'
      );
  }
}
