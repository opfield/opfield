import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  CreateResourceFolderSchema,
  MoveResourceFolderSchema,
  MoveResourcesToFolderSchema,
  ReorderResourceFoldersSchema,
  ReorderResourcesSchema,
  UpdateResourceFolderSchema,
} from './resource-folder.schemas.js';

/**
 * The eight folder routes of one foldered resource list, mounted under the resource's own prefix
 * (`/folders`, `/folders/reorder`, `/folders/move-<segment>`, `/folders/reorder-<segment>`, `/folders/{id}`,
 * `/folders/{id}/move`). Register them before the resource's `/{id}` routes.
 */
export function resourceFolderRouteDocs(options: { tag: string; noun: string; plural: string; segment: string }) {
  const { tag, noun, plural, segment } = options;
  return {
    list: appRoute({
      method: 'get',
      path: '/folders',
      tags: [tag],
      summary: `List ${noun} folders`,
      responses: okJson(UnknownDataResponseSchema),
    }),
    create: appRoute({
      method: 'post',
      path: '/folders',
      tags: [tag],
      summary: `Create a ${noun} folder`,
      request: jsonBody(CreateResourceFolderSchema),
      responses: createdJson(UnknownDataResponseSchema),
    }),
    reorderFolders: appRoute({
      method: 'put',
      path: '/folders/reorder',
      tags: [tag],
      summary: `Reorder ${noun} folders`,
      request: jsonBody(ReorderResourceFoldersSchema),
      responses: okJson(UnknownDataResponseSchema),
    }),
    moveResources: appRoute({
      method: 'post',
      path: `/folders/move-${segment}`,
      tags: [tag],
      summary: `Move ${plural} to a folder`,
      request: jsonBody(MoveResourcesToFolderSchema),
      responses: okJson(UnknownDataResponseSchema),
    }),
    reorderResources: appRoute({
      method: 'put',
      path: `/folders/reorder-${segment}`,
      tags: [tag],
      summary: `Reorder ${plural} within a folder`,
      request: jsonBody(ReorderResourcesSchema),
      responses: okJson(UnknownDataResponseSchema),
    }),
    update: appRoute({
      method: 'put',
      path: '/folders/{id}',
      tags: [tag],
      summary: `Rename a ${noun} folder`,
      request: { params: IdParamSchema, ...jsonBody(UpdateResourceFolderSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    moveFolder: appRoute({
      method: 'put',
      path: '/folders/{id}/move',
      tags: [tag],
      summary: `Move a ${noun} folder`,
      request: { params: IdParamSchema, ...jsonBody(MoveResourceFolderSchema) },
      responses: okJson(UnknownDataResponseSchema),
    }),
    delete: appRoute({
      method: 'delete',
      path: '/folders/{id}',
      tags: [tag],
      summary: `Delete a ${noun} folder`,
      request: { params: IdParamSchema },
      responses: okJson(UnknownDataResponseSchema),
    }),
  };
}

export type ResourceFolderRouteDocs = ReturnType<typeof resourceFolderRouteDocs>;

export const caFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Certificate Authorities',
  noun: 'CA',
  plural: 'root CAs',
  segment: 'cas',
});

export const pkiCertificateFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Certificates',
  noun: 'certificate',
  plural: 'certificates',
  segment: 'certificates',
});

export const pkiTemplateFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Templates',
  noun: 'certificate template',
  plural: 'certificate templates',
  segment: 'templates',
});

export const nginxTemplateFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Nginx Templates',
  noun: 'nginx template',
  plural: 'nginx templates',
  segment: 'templates',
});

export const appFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Apps',
  noun: 'app',
  plural: 'apps',
  segment: 'apps',
});

export const notificationAlertRuleFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Notifications',
  noun: 'alert rule',
  plural: 'alert rules',
  segment: 'rules',
});

export const notificationWebhookFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Notifications',
  noun: 'notification webhook',
  plural: 'notification webhooks',
  segment: 'webhooks',
});

export const accessListFolderRouteDocs = resourceFolderRouteDocs({
  tag: 'Access Lists',
  noun: 'access list',
  plural: 'access lists',
  segment: 'access-lists',
});
