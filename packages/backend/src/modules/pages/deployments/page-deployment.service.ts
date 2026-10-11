export const PAGE_UPLOAD_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import type { PageRetentionService } from '../retention/page-retention.service.js';
import type { ValidatedPageDeployToken } from '../tokens/page-deploy-token.service.js';
import type { CreatePageDeploymentInput, PageDeploymentListQuery } from './page-deployment.schemas.js';
export type PagePreviewLinkStatus = 'ready' | 'pending' | 'unavailable';
export interface PagePreviewLink {
  hostname: string | null;
  url: string | null;
  status: PagePreviewLinkStatus;
  /**
   * Why the link is not ready: publishing, previews_disabled, profile_disabled,
   * label_too_long, label_collision, access_unsupported, not_ready or
   * materialization_failed.
   */
  reason: string | null;
}
export interface PageTagPreviewLink extends PagePreviewLink {
  name: string;
}
export interface PagePublicationLinks {
  preview: PagePreviewLink;
  /** The Tag requested for this Deployment, when one was set or moved. */
  tag: PageTagPreviewLink | null;
  /** The system `latest` Tag when it points at this Deployment. */
  latest: PageTagPreviewLink | null;
}
export interface PageFinalizeOptions {
  /** Overrides the expiry declared at upload start; null clears it. */
  expiresAt?: Date | null;
}
export type PageDeployPrincipal =
  | {
      kind: 'user';
      userId: string;
      scopes: string[];
      tokenPrefix?: string;
    }
  | {
      kind: 'deploy-token';
      token: ValidatedPageDeployToken;
    };
export class PageDeploymentService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _auditService: AuditService,
    _settingsService: GeneralSettingsService,
    _store: PageArtifactStore
  ) {}
  setEventBus(_eventBus: EventBusService): void {}
  setRetentionService(_retentionService: PageRetentionService): void {}
  async create(
    _input: CreatePageDeploymentInput,
    _principal: PageDeployPrincipal
  ): Promise<{
    deployment: {
      credentialType: string | null;
      sourceMetadata: import('@/db/schema/index.js').PageDeploymentSourceMetadata;
      createdAt: string;
      updatedAt: string;
      readyAt: string | null;
      deletedAt: string | null;
      expiresAt: string | null;
      failureMessage: string | null;
      id: string;
      createdById: string | null;
      projectId: string;
      sequence: number;
      status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
      publicSlug: string;
      previewHostname: string | null;
      artifactSha256: string | null;
      compressedSizeBytes: number;
      expandedSizeBytes: number;
      fileCount: number;
      requestedTag: string | null;
      pinned: boolean;
      failureCode: string | null;
    };
    upload: {
      id: string;
      offset: number;
      expiresAt: string;
    } | null;
  }> {
    return commercialModuleUnavailable();
  }
  async appendChunk(
    _uploadId: string,
    _offset: number,
    _bytes: Uint8Array,
    _principal: PageDeployPrincipal
  ): Promise<{
    id: string;
    offset: number;
    complete: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async finalize(
    _uploadId: string,
    _principal: PageDeployPrincipal,
    _options?: PageFinalizeOptions
  ): Promise<{
    deployment: {
      credentialType: string | null;
      sourceMetadata: import('@/db/schema/index.js').PageDeploymentSourceMetadata;
      createdAt: string;
      updatedAt: string;
      readyAt: string | null;
      deletedAt: string | null;
      expiresAt: string | null;
      failureMessage: string | null;
      id: string;
      createdById: string | null;
      projectId: string;
      sequence: number;
      status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
      publicSlug: string;
      previewHostname: string | null;
      artifactSha256: string | null;
      compressedSizeBytes: number;
      expandedSizeBytes: number;
      fileCount: number;
      requestedTag: string | null;
      pinned: boolean;
      failureCode: string | null;
    };
  }> {
    return commercialModuleUnavailable();
  }
  async abortUpload(_uploadId: string, _principal: PageDeployPrincipal, _failureCode?: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cancelUpload(
    _uploadId: string,
    _principal: PageDeployPrincipal
  ): Promise<{
    cancelled: boolean;
    deployment: Awaited<ReturnType<PageDeploymentService['get']>>;
  }> {
    return commercialModuleUnavailable();
  }
  async list(
    _projectId: string,
    _query: PageDeploymentListQuery
  ): Promise<{
    data: {
      credentialType: string | null;
      sourceMetadata: import('@/db/schema/index.js').PageDeploymentSourceMetadata;
      createdAt: string;
      updatedAt: string;
      readyAt: string | null;
      deletedAt: string | null;
      expiresAt: string | null;
      failureMessage: string | null;
      id: string;
      createdById: string | null;
      projectId: string;
      sequence: number;
      status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
      publicSlug: string;
      previewHostname: string | null;
      artifactSha256: string | null;
      compressedSizeBytes: number;
      expandedSizeBytes: number;
      fileCount: number;
      requestedTag: string | null;
      pinned: boolean;
      failureCode: string | null;
    }[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    return commercialModuleUnavailable();
  }
  async get(_deploymentId: string): Promise<{
    credentialType: string | null;
    sourceMetadata: import('@/db/schema/index.js').PageDeploymentSourceMetadata;
    createdAt: string;
    updatedAt: string;
    readyAt: string | null;
    deletedAt: string | null;
    expiresAt: string | null;
    failureMessage: string | null;
    id: string;
    createdById: string | null;
    projectId: string;
    sequence: number;
    status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
    publicSlug: string;
    previewHostname: string | null;
    artifactSha256: string | null;
    compressedSizeBytes: number;
    expandedSizeBytes: number;
    fileCount: number;
    requestedTag: string | null;
    pinned: boolean;
    failureCode: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getForProject(
    _projectId: string,
    _deploymentId: string
  ): Promise<{
    credentialType: string | null;
    sourceMetadata: import('@/db/schema/index.js').PageDeploymentSourceMetadata;
    createdAt: string;
    updatedAt: string;
    readyAt: string | null;
    deletedAt: string | null;
    expiresAt: string | null;
    failureMessage: string | null;
    id: string;
    createdById: string | null;
    projectId: string;
    sequence: number;
    status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
    publicSlug: string;
    previewHostname: string | null;
    artifactSha256: string | null;
    compressedSizeBytes: number;
    expandedSizeBytes: number;
    fileCount: number;
    requestedTag: string | null;
    pinned: boolean;
    failureCode: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async publicationLinks(
    _deploymentId: string,
    _options?: { waitMs?: number; pollMs?: number }
  ): Promise<PagePublicationLinks> {
    return commercialModuleUnavailable();
  }
  /**
   * App promotion: copy a ready deployment's artifact (server-side, same sha256) into a new deployment of another
   * project and move that project's `latest` tag to it. Returns the new deployment and the sequence it replaced.
   */
  async promoteDeployment(
    _sourceDeploymentId: string,
    _targetProjectId: string,
    _userId: string
  ): Promise<{ deploymentId: string; sequence: number; previousSequence: number | null }> {
    return commercialModuleUnavailable();
  }
}
