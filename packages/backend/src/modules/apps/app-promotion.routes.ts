import { z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { appRoute, jsonBody, okJson, pathParamSchema, UnknownDataResponseSchema } from '@/lib/openapi.js';
import { AppPromotionService } from './app-promotion.service.js';
import { type AppsRouter, appActor } from './app-route-helpers.js';

const TAGS = ['Apps'];
const AppParams = pathParamSchema('id');
const PromotionParams = pathParamSchema('id', 'promotionId');

export const PromotionPreviewBodySchema = z
  .object({ sourceEnvironmentId: z.string().uuid(), targetEnvironmentId: z.string().uuid() })
  .strict();
export const PromotionExecuteBodySchema = z
  .object({
    sourceEnvironmentId: z.string().uuid(),
    targetEnvironmentId: z.string().uuid(),
    items: z.array(z.string().min(1).max(600)).min(1).max(200),
    previewDigest: z.string().min(1).max(128),
  })
  .strict();
export const PromotionListQuerySchema = z.object({ environmentId: z.string().uuid().optional() });

export const previewAppPromotionRoute = appRoute({
  method: 'post',
  path: '/{id}/promotions/preview',
  tags: TAGS,
  summary: 'Preview a promotion between environments',
  description:
    'What the target environment would run so that it runs exactly what the source runs: per paired member (same name, or the name without a trailing -<environment>) the image digest, Git build, Compose revision (services with Changed/Same and path-level YAML changes) or Pages artifact, from (target now) and to (source). Items already the same are marked same; members without a counterpart are listed in unpaired ("not in <target>"). Nothing is rebuilt; variables, secrets, databases and storage are never promoted. Execute with the previewDigest it returns. apps:promote on the target environment.',
  request: { params: AppParams, ...jsonBody(PromotionPreviewBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const executeAppPromotionRoute = appRoute({
  method: 'post',
  path: '/{id}/promotions',
  tags: TAGS,
  summary: 'Promote between environments',
  description:
    'Runs the selected items (pairKey from the preview) one after another in the background: containers are recreated and deployments blue-green deployed with the source image by digest, Compose projects get a new revision of the source YAML with pinned images (their own variables kept) and are applied, Pages projects activate a copy of the source artifact. Each item succeeds or fails on its own; nothing is rolled back. Refused with 409 PROMOTION_PREVIEW_STALE when what runs changed since the preview, and 409 APP_ISOLATED while the target is isolated. apps:promote on the target environment.',
  request: { params: AppParams, ...jsonBody(PromotionExecuteBodySchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const listAppPromotionsRoute = appRoute({
  method: 'get',
  path: '/{id}/promotions',
  tags: TAGS,
  summary: 'Recent promotions',
  description:
    'The last 20 promotions into environments you can view (or into one environment), newest first, with per-item status.',
  request: { params: AppParams, query: PromotionListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAppPromotionRoute = appRoute({
  method: 'get',
  path: '/{id}/promotions/{promotionId}',
  tags: TAGS,
  summary: 'Promotion status',
  description: 'A promotion with per-item status (pending, running, succeeded, failed, skipped), from/to and errors.',
  request: { params: PromotionParams },
  responses: okJson(UnknownDataResponseSchema),
});

export function registerAppPromotionRoutes(router: AppsRouter): void {
  const service = () => container.resolve(AppPromotionService);

  router.openapi(previewAppPromotionRoute, async (c) => {
    const body = PromotionPreviewBodySchema.parse(await c.req.json());
    const data = await service().preview(
      appActor(c),
      c.req.param('id')!,
      body.sourceEnvironmentId,
      body.targetEnvironmentId
    );
    return c.json({ data });
  });

  router.openapi(executeAppPromotionRoute, async (c) => {
    const body = PromotionExecuteBodySchema.parse(await c.req.json());
    return c.json({ data: await service().execute(appActor(c), c.req.param('id')!, body) });
  });

  router.openapi(listAppPromotionsRoute, async (c) => {
    const query = PromotionListQuerySchema.parse(c.req.query());
    return c.json({ data: await service().list(appActor(c).scopes, c.req.param('id')!, query.environmentId) });
  });

  router.openapi(getAppPromotionRoute, async (c) => {
    return c.json({
      data: await service().get(appActor(c).scopes, c.req.param('id')!, c.req.param('promotionId')!),
    });
  });
}
