import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type {
  CreatePageProjectInput,
  MigratePageProjectInput,
  PageProjectListQuery,
  UpdatePageProjectInput,
} from './page-project.schemas.js';
import type { PageRetentionService } from './retention/page-retention.service.js';
export interface PageProjectRuntimeAdapter {
  stageProjectMigration(projectId: string, targetNodeId: string): Promise<void>;
  cleanupProjectNode(projectId: string, nodeId: string): Promise<void>;
  refreshProjectFallback(projectId: string): Promise<void>;
  disableProjectPreviews(projectId: string): Promise<void>;
}
export interface PageProjectPreviewRotation {
  /** Old preview hostnames revoked on the Project node (deny vhosts). */
  revokedHostnames: number;
  /** Hostnames whose revocation is retried by reconciliation (node unreachable). */
  cleanupPendingHostnames: number;
  /** New preview links that could not be published yet; reconciliation retries them. */
  republishFailures: number;
}
export interface PageProjectRouteRuntimeAdapter {
  reconcileAdditionalRouteHost(hostId: string): Promise<void>;
}
export class PageProjectService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setEventBus(_eventBus: EventBusService): void {}
  setRetentionService(_retentionService: PageRetentionService): void {}
  setRuntimeAdapter(_runtimeAdapter: PageProjectRuntimeAdapter): void {}
  setRouteRuntimeAdapter(_routeRuntimeAdapter: PageProjectRouteRuntimeAdapter): void {}
  async list(
    query: PageProjectListQuery,
    _options?: {
      allowedIds?: string[];
    }
  ): Promise<{
    data: {
      deploymentCount: number;
      tagCount: number;
      routeCount: number;
      primaryDomain: string;
      id: string;
      name: string;
      description: string | null;
      folderId: string | null;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
      createdById: string;
      slug: string;
      previewHash: string;
      accessListId: string | null;
      updatedById: string | null;
      appearanceColor: string | null;
      nodeId: string | null;
      storageUsedBytes: number;
      migrationError: string | null;
      previewsEnabled: boolean;
      spaFallback: boolean;
      fallbackUrl: string | null;
      migrationSourceNodeId: string | null;
      migrationTargetNodeId: string | null;
      migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
      migrationGeneration: number;
      maxDeployments: number;
      storageQuotaBytes: number;
      nextDeploymentSequence: number;
    }[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    return { data: [], pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 } };
  }
  async get(_id: string): Promise<{
    deploymentCount: number;
    tagCount: number;
    routeCount: number;
    primaryDomain: string;
    id: string;
    name: string;
    description: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    slug: string;
    previewHash: string;
    accessListId: string | null;
    updatedById: string | null;
    appearanceColor: string | null;
    nodeId: string | null;
    storageUsedBytes: number;
    migrationError: string | null;
    previewsEnabled: boolean;
    spaFallback: boolean;
    fallbackUrl: string | null;
    migrationSourceNodeId: string | null;
    migrationTargetNodeId: string | null;
    migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
    migrationGeneration: number;
    maxDeployments: number;
    storageQuotaBytes: number;
    nextDeploymentSequence: number;
  }> {
    return commercialModuleUnavailable();
  }
  async getBySlug(_slug: string): Promise<{
    deploymentCount: number;
    tagCount: number;
    routeCount: number;
    primaryDomain: string;
    id: string;
    name: string;
    description: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    slug: string;
    previewHash: string;
    accessListId: string | null;
    updatedById: string | null;
    appearanceColor: string | null;
    nodeId: string | null;
    storageUsedBytes: number;
    migrationError: string | null;
    previewsEnabled: boolean;
    spaFallback: boolean;
    fallbackUrl: string | null;
    migrationSourceNodeId: string | null;
    migrationTargetNodeId: string | null;
    migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
    migrationGeneration: number;
    maxDeployments: number;
    storageQuotaBytes: number;
    nextDeploymentSequence: number;
  }> {
    return commercialModuleUnavailable();
  }
  async create(
    _input: CreatePageProjectInput,
    _userId: string
  ): Promise<{
    deploymentCount: number;
    tagCount: number;
    routeCount: number;
    primaryDomain: string;
    id: string;
    name: string;
    description: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    slug: string;
    previewHash: string;
    accessListId: string | null;
    updatedById: string | null;
    appearanceColor: string | null;
    nodeId: string | null;
    storageUsedBytes: number;
    migrationError: string | null;
    previewsEnabled: boolean;
    spaFallback: boolean;
    fallbackUrl: string | null;
    migrationSourceNodeId: string | null;
    migrationTargetNodeId: string | null;
    migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
    migrationGeneration: number;
    maxDeployments: number;
    storageQuotaBytes: number;
    nextDeploymentSequence: number;
  }> {
    return commercialModuleUnavailable();
  }
  /** Nginx nodes a Project can be placed on; `folderId` (an app environment) narrows them to the nodes it allows. */
  async placementOptions(_options?: { allowedNodeIds?: string[]; folderId?: string | null }): Promise<
    {
      pagesCapable: boolean;
      id: string;
      displayName: string | null;
      hostname: string;
      status: 'pending' | 'error' | 'online' | 'offline';
    }[]
  > {
    return [];
  }
  async migrate(
    _id: string,
    _input: MigratePageProjectInput,
    _userId: string
  ): Promise<{
    deploymentCount: number;
    tagCount: number;
    routeCount: number;
    primaryDomain: string;
    id: string;
    name: string;
    description: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    slug: string;
    previewHash: string;
    accessListId: string | null;
    updatedById: string | null;
    appearanceColor: string | null;
    nodeId: string | null;
    storageUsedBytes: number;
    migrationError: string | null;
    previewsEnabled: boolean;
    spaFallback: boolean;
    fallbackUrl: string | null;
    migrationSourceNodeId: string | null;
    migrationTargetNodeId: string | null;
    migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
    migrationGeneration: number;
    maxDeployments: number;
    storageQuotaBytes: number;
    nextDeploymentSequence: number;
  }> {
    return commercialModuleUnavailable();
  }
  async reconcileMigrations(): Promise<number> {
    return 0;
  }
  async update(
    _id: string,
    _input: UpdatePageProjectInput,
    _userId: string
  ): Promise<{
    deploymentCount: number;
    tagCount: number;
    routeCount: number;
    primaryDomain: string;
    id: string;
    name: string;
    description: string | null;
    folderId: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    slug: string;
    previewHash: string;
    accessListId: string | null;
    updatedById: string | null;
    appearanceColor: string | null;
    nodeId: string | null;
    storageUsedBytes: number;
    migrationError: string | null;
    previewsEnabled: boolean;
    spaFallback: boolean;
    fallbackUrl: string | null;
    migrationSourceNodeId: string | null;
    migrationTargetNodeId: string | null;
    migrationStatus: 'failed' | 'cleanup_pending' | 'staging' | null;
    migrationGeneration: number;
    maxDeployments: number;
    storageQuotaBytes: number;
    nextDeploymentSequence: number;
  }> {
    return commercialModuleUnavailable();
  }
  async delete(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async rotatePreviewHash(
    _id: string,
    _userId: string
  ): Promise<{
    project: Awaited<ReturnType<PageProjectService['get']>>;
    rotation: PageProjectPreviewRotation;
  }> {
    return commercialModuleUnavailable();
  }
}
