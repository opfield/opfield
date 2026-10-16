import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
export type PageDeploymentProtectionReason = 'pinned' | 'tag' | 'route' | 'publication' | 'replica' | 'migration';
export interface PageRetentionRunResult {
  itemsCleaned: number;
  spaceFreedBytes: number;
  protectedOverLimit: number;
}
export interface PageRetentionRuntimeAdapter {
  cleanupRetainedDeployment(deploymentId: string): Promise<void>;
}
export interface PageDeploymentExpiryResult {
  expired: number;
  tagsCleared: number;
  skipped: Array<{ deploymentId: string; reason: 'route' | 'publication' | 'protected' }>;
}
export class PageRetentionService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService, _store: PageArtifactStore) {}
  setEventBus(_eventBus: EventBusService): void {}
  setRuntimeAdapter(_adapter: PageRetentionRuntimeAdapter): void {}
  async assertCanAcceptDeployment(_projectId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async setPinned(
    _projectId: string,
    _deploymentId: string,
    _pinned: boolean,
    _userId: string
  ): Promise<{
    id: string;
    pinned: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async deleteDeployment(_projectId: string, _deploymentId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async runAll(): Promise<PageRetentionRunResult> {
    return { itemsCleaned: 0, spaceFreedBytes: 0, protectedOverLimit: 0 };
  }
  async runProject(_projectId: string): Promise<PageRetentionRunResult> {
    return commercialModuleUnavailable();
  }
  async expireDeployments(_now?: Date): Promise<PageDeploymentExpiryResult> {
    return commercialModuleUnavailable();
  }
  async sweepNodeReleases(): Promise<number> {
    return commercialModuleUnavailable();
  }
}
