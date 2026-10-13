import { container } from '@/container.js';
import { getResourceScopedIds } from '@/lib/permissions.js';
import { AdminUserFolderService } from '@/modules/admin/admin-user-folders.service.js';
import { APP_SCOPES } from '@/modules/apps/app-access.js';
import { AppListFolderService } from '@/modules/apps/app-list-folders.service.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { DomainFolderService } from '@/modules/domains/domain-folders.service.js';
import { PermissionGroupFolderService } from '@/modules/groups/permission-group-folders.service.js';
import type { LicenseFeature } from '@/modules/license/license-policy.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import { NodeFolderService } from '@/modules/nodes/node-folders.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { visiblePageProjectIds } from '@/modules/pages/page-project-access.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import {
  CAFolderService,
  CertificateFolderService,
  PkiTemplateFolderService,
} from '@/modules/pki/pki-folders.service.js';
import { NginxTemplateFolderService } from '@/modules/proxy/nginx-template-folders.service.js';
import type { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';
import { SSLCertificateFolderService } from '@/modules/ssl/ssl-certificate-folders.service.js';
import type { GenericFolderResourceType } from './ai.folder-tool-types.js';

export type GenericFolderConfig = {
  service: FolderedResourceService;
  viewScope: string;
  manageScope: string;
  /** Other scopes that list folders; held broadly they list every folder, like the HTTP folder list route. */
  listScopes?: string[];
  /** Per-resource scope a whole-folder move must hold for every moved resource and the destination. */
  moveEditScope: string;
  /** Scope the HTTP move-resources route requires on every moved resource and on the destination. */
  resourceMoveScope: string;
  /** Replaces the per-resource move and reorder check (and the destination check) of the HTTP routes. */
  authorizePlacement?: (scopes: readonly string[], ids: readonly string[]) => Promise<void>;
  /** Creation scope that also lets the HTTP folder list route show every folder. */
  createScope?: string;
  /** Per-resource scope the HTTP reorder route requires on every reordered resource. */
  reorderItemScope?: string;
  /** Resource ids visible to a caller without broad view access; defaults to viewScope grants. */
  visibleResourceIds?: (scopes: string[]) => string[] | undefined;
};

/** License feature of a folder family, checked with the same classes as its folder routes. */
export function folderLicenseFeature(resourceType: GenericFolderResourceType): LicenseFeature | null {
  switch (resourceType) {
    case 'logging_environments':
    case 'logging_schemas':
      return 'structured-logging';
    case 'databases':
      return 'external-database-connections';
    case 'storage':
      return 'storage-connections';
    case 'pages':
      return 'pages';
    case 'pki_cas':
    case 'pki_certificates':
    case 'pki_templates':
      return 'internal-pki';
    default:
      return null;
  }
}

export function genericFolderConfig(resourceType: GenericFolderResourceType): GenericFolderConfig {
  switch (resourceType) {
    case 'nodes':
      return {
        service: container.resolve(NodeFolderService),
        viewScope: 'nodes:details',
        manageScope: 'nodes:folders:manage',
        moveEditScope: 'nodes:rename',
        resourceMoveScope: 'nodes:rename',
        createScope: 'nodes:create',
      };
    case 'databases':
      return {
        service: container.resolve(DatabaseFolderService),
        viewScope: 'databases:view',
        manageScope: 'databases:folders:manage',
        moveEditScope: 'databases:edit',
        resourceMoveScope: 'databases:edit',
        createScope: 'databases:create',
      };
    case 'storage':
      return {
        service: container.resolve(ObjectStorageFolderService),
        viewScope: 'storage:view',
        manageScope: 'storage:folders:manage',
        moveEditScope: 'storage:edit',
        resourceMoveScope: 'storage:edit',
        createScope: 'storage:create',
      };
    case 'domains':
      return {
        service: container.resolve(DomainFolderService),
        viewScope: 'domains:view',
        manageScope: 'domains:folders:manage',
        moveEditScope: 'domains:edit',
        resourceMoveScope: 'domains:edit',
        createScope: 'domains:create',
      };
    case 'ssl_certificates':
      return {
        service: container.resolve(SSLCertificateFolderService),
        viewScope: 'ssl:cert:view',
        manageScope: 'ssl:cert:folders:manage',
        moveEditScope: 'ssl:cert:issue',
        resourceMoveScope: 'ssl:cert:issue',
        createScope: 'ssl:cert:issue',
      };
    case 'logging_environments':
      return {
        service: container.resolve(LoggingEnvironmentFolderService),
        viewScope: 'logs:environments:view',
        manageScope: 'logs:environments:folders:manage',
        moveEditScope: 'logs:environments:edit',
        resourceMoveScope: 'logs:environments:edit',
        createScope: 'logs:environments:create',
      };
    case 'logging_schemas':
      return {
        service: container.resolve(LoggingSchemaFolderService),
        viewScope: 'logs:schemas:view',
        manageScope: 'logs:schemas:folders:manage',
        moveEditScope: 'logs:schemas:edit',
        resourceMoveScope: 'logs:schemas:edit',
        createScope: 'logs:schemas:create',
      };
    case 'admin_users':
      return {
        service: container.resolve(AdminUserFolderService),
        viewScope: 'admin:users',
        manageScope: 'admin:users:folders:manage',
        moveEditScope: 'admin:users',
        resourceMoveScope: 'admin:users',
        reorderItemScope: 'admin:users',
      };
    case 'permission_groups':
      return {
        service: container.resolve(PermissionGroupFolderService),
        viewScope: 'admin:groups',
        manageScope: 'admin:groups:folders:manage',
        moveEditScope: 'admin:groups',
        resourceMoveScope: 'admin:groups',
        reorderItemScope: 'admin:groups',
      };
    case 'pages':
      return {
        service: container.resolve(PageProjectFolderService),
        viewScope: 'pages:view',
        manageScope: 'pages:folders:manage',
        moveEditScope: 'pages:edit',
        resourceMoveScope: 'pages:edit',
        createScope: 'pages:create',
        reorderItemScope: 'pages:edit',
        visibleResourceIds: (scopes) => visiblePageProjectIds(scopes) ?? [],
      };
    case 'apps':
      // Folders of the Apps list hold apps; an app's members keep their own hidden folders.
      return {
        service: container.resolve(AppListFolderService),
        viewScope: 'apps:view',
        manageScope: 'apps:folders:manage',
        listScopes: ['apps:create'],
        moveEditScope: 'apps:edit',
        resourceMoveScope: 'apps:edit',
        createScope: 'apps:create',
        reorderItemScope: 'apps:edit',
        visibleResourceIds: (scopes) => [
          ...new Set(
            APP_SCOPES.filter((scope) => scope !== 'apps:create').flatMap((scope) =>
              getResourceScopedIds(scopes, scope)
            )
          ),
        ],
      };
    case 'pki_cas':
      // A folder holds whole hierarchies: only root CAs move, their intermediates follow.
      return {
        service: container.resolve(CAFolderService),
        viewScope: 'pki:ca:view',
        manageScope: 'pki:ca:folders:manage',
        listScopes: ['pki:cert:issue'],
        moveEditScope: 'pki:ca:edit',
        resourceMoveScope: 'pki:ca:edit',
        reorderItemScope: 'pki:ca:edit',
        visibleResourceIds: (scopes) => [
          ...new Set([
            ...getResourceScopedIds(scopes, 'pki:ca:view'),
            ...getResourceScopedIds(scopes, 'pki:cert:issue'),
          ]),
        ],
      };
    case 'pki_certificates': {
      // Certificates have no edit scope: placing one needs pki:cert:issue on its issuing CA.
      const service = container.resolve(CertificateFolderService);
      return {
        service,
        viewScope: 'pki:cert:view',
        manageScope: 'pki:cert:folders:manage',
        moveEditScope: 'pki:cert:issue',
        resourceMoveScope: 'pki:cert:issue',
        authorizePlacement: (scopes, ids) => service.assertPlacementAccess(scopes, ids),
      };
    }
    case 'pki_templates':
      return {
        service: container.resolve(PkiTemplateFolderService),
        viewScope: 'pki:templates:view',
        manageScope: 'pki:templates:folders:manage',
        moveEditScope: 'pki:templates:edit',
        resourceMoveScope: 'pki:templates:edit',
        reorderItemScope: 'pki:templates:edit',
      };
    case 'nginx_templates':
      return {
        service: container.resolve(NginxTemplateFolderService),
        viewScope: 'proxy:templates:view',
        manageScope: 'proxy:templates:folders:manage',
        moveEditScope: 'proxy:templates:manage',
        resourceMoveScope: 'proxy:templates:manage',
        createScope: 'proxy:templates:manage',
        reorderItemScope: 'proxy:templates:manage',
      };
  }
}
