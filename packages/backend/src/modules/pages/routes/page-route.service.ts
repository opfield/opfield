import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { IngressMoveIssue } from '@/modules/proxy/ingress-move-issues.js';
import type { CreateProxyHostInput } from '@/modules/proxy/proxy.schemas.js';
import type { PageNodeRuntimeService } from '../runtime/page-node-runtime.service.js';
import type {
  PageRuntimeConfigPublicationRequest,
  PageRuntimeConfigService,
} from '../runtime-config/page-runtime-config.service.js';
import type { PageTagActivationRequest } from '../tags/page-tag.service.js';
export interface AdditionalPageRoutePublicationAdapter {
  stageTagPublication(request: PageTagActivationRequest): Promise<Record<string, unknown>>;
  rollbackTagPublication?(request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void>;
  publishRuntimeConfig?(request: PageRuntimeConfigPublicationRequest): Promise<Record<string, unknown>>;
  rollbackRuntimeConfig?(
    request: PageRuntimeConfigPublicationRequest,
    progress: Record<string, unknown>
  ): Promise<void>;
}
export interface PageRouteNodeMigration {
  routeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  deploymentId: string;
  previousIncludePath: string | null;
  targetIncludePath: string;
  generation: number;
}
export class PageRouteService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _runtime: PageNodeRuntimeService,
    _auditService: AuditService,
    _runtimeConfig: PageRuntimeConfigService
  ) {}
  setAdditionalRoutePublicationAdapter(_adapter: AdditionalPageRoutePublicationAdapter): void {}
  async validateCreate(_input: CreateProxyHostInput): Promise<{
    projectId: string;
    tagId: string;
  }> {
    return commercialModuleUnavailable();
  }
  /** Materialises a new Pages route on its node, or on every member of its ingress group (a node list). */
  async activateNewHost(
    _proxyHostId: string,
    _nodes: string | readonly string[],
    _projectId: string,
    _tagId: string
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  /** A route staged for a node move renders only for the include path its staging recorded (stagedIncludePath). */
  async getRenderConfig(
    _proxyHostId: string,
    _options?: { stagedIncludePath?: string }
  ): Promise<{
    includePath: string;
    spaFallback: boolean;
    fallbackUrl: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getIncludePath(_proxyHostId: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  /** What would stop or follow a move of this Pages route to another node, each with the action that clears it. */
  async migrationIssues(
    _proxyHostId: string,
    _sourceNodeId: string | null,
    _targetNodeId: string
  ): Promise<IngressMoveIssue[]> {
    return commercialModuleUnavailable();
  }
  async getTarget(_proxyHostId: string): Promise<{
    projectId: string;
    tagId: string;
    deploymentId: string | null;
    status: 'failed' | 'pending' | 'ready' | 'staging' | 'capability_missing';
    generation: number;
    lastErrorCode: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async reconcile(): Promise<void> {}
  async removeHost(
    _proxyHostId: string,
    _nodes: string | readonly string[] | null,
    _abandonOfflineNode?: boolean
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async publishRuntimeConfig(_request: PageRuntimeConfigPublicationRequest): Promise<void> {
    return commercialModuleUnavailable();
  }
  async claimFailedCreateCleanup(_proxyHostId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async stageNodeMigration(
    _proxyHostId: string,
    _sourceNodeId: string,
    _targetNodeId: string
  ): Promise<PageRouteNodeMigration> {
    return commercialModuleUnavailable();
  }
  async commitNodeMigration(_migration: PageRouteNodeMigration): Promise<void> {
    return commercialModuleUnavailable();
  }
  async rollbackNodeMigration(_migration: PageRouteNodeMigration): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupMigratedSource(_proxyHostId: string, _sourceNodeId: string, _connected: boolean): Promise<void> {
    return commercialModuleUnavailable();
  }
  /**
   * A Pages route on an ingress group: materialises its active deployment and runtime config on nodes that start
   * serving it and removes them from nodes that stop serving it.
   */
  async syncServingNodes(_proxyHostId: string, _addedNodeIds: string[], _removedNodeIds: string[]): Promise<void> {
    return commercialModuleUnavailable();
  }
  async retarget(_proxyHostId: string, _projectId: string, _tagId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async stage(_request: PageTagActivationRequest): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async rollback(_request: PageTagActivationRequest, _progress: Record<string, unknown>): Promise<void> {
    return commercialModuleUnavailable();
  }
}
