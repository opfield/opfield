import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { AppPromotionService } from '@/modules/apps/app-promotion.service.js';
import type { AppActor } from '@/modules/apps/apps.service.js';
import type { User } from '@/types.js';
import type { AIToolDefinition } from './ai.types.js';

export const APP_PROMOTION_TOOL_NAMES = new Set(['promote_app_environment']);

export const APP_PROMOTION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'promote_app_environment',
    description:
      'Promote between two environments of an app so the target runs exactly what the source runs (apps:promote on the target environment). preview (appId, sourceEnvironmentId, targetEnvironmentId) lists each paired member (same name, or the name without a trailing -<environment>) with from (target now) and to (source): image digests for containers and deployments (Git builds by artifact digest, never rebuilt), the Compose revision with services Changed/Same and YAML changes, the Pages artifact; same items are marked same, members without a counterpart are unpaired. execute (also items: pairKeys from the preview, previewDigest) runs them one after another in the background; each succeeds or fails on its own; 409 PROMOTION_PREVIEW_STALE if what runs changed since the preview. status (appId, promotionId) shows per-item progress; list (appId, optional environmentId) the recent ones. Variables, secrets, databases and storage are never promoted.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['preview', 'execute', 'status', 'list'] },
        appId: { type: 'string', description: 'App id or slug.' },
        sourceEnvironmentId: { type: 'string', description: 'preview, execute: environment to promote from.' },
        targetEnvironmentId: { type: 'string', description: 'preview, execute: environment to promote into.' },
        items: { type: 'array', items: { type: 'string' }, description: 'execute: pairKey of each item to promote.' },
        previewDigest: { type: 'string', description: 'execute: previewDigest returned by preview.' },
        promotionId: { type: 'string', description: 'status: promotion id.' },
        environmentId: { type: 'string', description: 'list: only promotions into this environment.' },
      },
      required: ['operation', 'appId'],
    },
    destructive: true,
    category: 'Apps',
    requiredScope: 'apps:view',
    invalidateStores: ['apps'],
  },
];

function required(value: unknown, field: string): string {
  if (typeof value === 'string' && value) return value;
  throw new AppError(400, 'VALIDATION_ERROR', `${field} is required`);
}

/** promote_app_environment: the same service calls and checks as the /api/apps promotion routes. */
export async function executeAppPromotionTool(user: User, args: Record<string, unknown>): Promise<unknown> {
  const service = container.resolve(AppPromotionService);
  const actor: AppActor = { userId: user.id, scopes: user.scopes };
  const appId = required(args.appId, 'appId');
  switch (String(args.operation ?? '')) {
    case 'preview':
      return {
        data: await service.preview(
          actor,
          appId,
          required(args.sourceEnvironmentId, 'sourceEnvironmentId'),
          required(args.targetEnvironmentId, 'targetEnvironmentId')
        ),
      };
    case 'execute':
      return {
        data: await service.execute(actor, appId, {
          sourceEnvironmentId: required(args.sourceEnvironmentId, 'sourceEnvironmentId'),
          targetEnvironmentId: required(args.targetEnvironmentId, 'targetEnvironmentId'),
          items: Array.isArray(args.items) ? args.items.filter((item): item is string => typeof item === 'string') : [],
          previewDigest: required(args.previewDigest, 'previewDigest'),
        }),
      };
    case 'status':
      return { data: await service.get(actor.scopes, appId, required(args.promotionId, 'promotionId')) };
    case 'list':
      return {
        data: await service.list(
          actor.scopes,
          appId,
          typeof args.environmentId === 'string' && args.environmentId ? args.environmentId : undefined
        ),
      };
    default:
      throw new AppError(400, 'VALIDATION_ERROR', 'operation must be preview, execute, status or list');
  }
}
