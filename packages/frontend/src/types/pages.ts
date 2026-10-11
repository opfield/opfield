import type { AppMembershipRef } from "./apps";
import type { Domain } from "./domains";
import type { Node, NodeAppearanceColor } from "./nodes";
import type { SSLCertificate } from "./ssl";

export type PageDeploymentStatus =
  | "uploading"
  | "validating"
  | "stored"
  | "staging"
  | "ready"
  | "failed"
  | "cleaning"
  | "deleted";

export interface PageDeploymentSourceMetadata {
  provider?: string;
  repository?: string;
  commitSha?: string;
  ref?: string;
  mergeRequest?: string;
  actor?: string;
  [key: string]: string | undefined;
}

export interface PageDeployment {
  id: string;
  projectId: string;
  sequence: number;
  publicSlug: string;
  previewHostname: string | null;
  status: PageDeploymentStatus;
  artifactSha256: string | null;
  compressedSizeBytes: number;
  expandedSizeBytes: number;
  fileCount: number;
  sourceMetadata: PageDeploymentSourceMetadata;
  requestedTag: string | null;
  pinned: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  deletedAt: string | null;
  /** Optional; maintenance deletes the Deployment with its previews and files after it. */
  expiresAt?: string | null;
  credentialType: "deploy-token" | "user" | null;
}

export type PagePreviewLinkStatus = "ready" | "pending" | "unavailable";

export interface PagePreviewLink {
  hostname: string | null;
  url: string | null;
  status: PagePreviewLinkStatus;
  reason: string | null;
}

export interface PageDeploymentUploadCreated {
  deployment: PageDeployment;
  upload: {
    id: string;
    offset: number;
    expiresAt: string;
  };
}

export interface PageTagDeploymentSummary {
  id: string;
  sequence: number;
  publicSlug: string;
  status: PageDeploymentStatus;
}

export interface PageTag {
  id: string;
  projectId: string;
  name: string;
  system: boolean;
  generation: number;
  deployment: PageTagDeploymentSummary | null;
  /** Stable `<project hash>-<tag>` preview link that follows the Tag. */
  preview?: PagePreviewLink;
  createdAt: string;
  updatedAt: string;
}

export interface PageTagMoveResult {
  changed: boolean;
  activationId?: string;
  generation?: number;
}

export interface PageProject {
  /** Set when the resource is a member of an app environment. */
  app?: AppMembershipRef | null;
  id: string;
  name: string;
  slug: string;
  /** Random prefix of every Tag preview link; rotating it replaces every preview link. */
  previewHash?: string;
  /** Access list protecting every preview host of the Project. */
  accessListId?: string | null;
  description: string | null;
  appearanceColor: NodeAppearanceColor | null;
  spaFallback: boolean;
  previewsEnabled: boolean;
  fallbackUrl: string | null;
  nodeId: string | null;
  migrationSourceNodeId: string | null;
  migrationTargetNodeId: string | null;
  migrationStatus: "staging" | "cleanup_pending" | "failed" | null;
  migrationGeneration: number;
  migrationError: string | null;
  folderId: string | null;
  sortOrder: number;
  maxDeployments: number;
  storageQuotaBytes: number;
  storageUsedBytes: number;
  nextDeploymentSequence: number;
  deploymentCount: number;
  tagCount: number;
  routeCount: number;
  primaryDomain: string | null;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PageDeployToken {
  id: string;
  projectId: string;
  name: string;
  tokenPrefix: string;
  allowedTagPatterns: string[];
  allowUserTag: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface PageDeployTokenCreated extends PageDeployToken {
  token: string;
}

export interface PageProjectFolderTreeNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  depth: number;
  createdAt: string;
  updatedAt: string;
  children: PageProjectFolderTreeNode[];
}

export interface PageProfileIsolation {
  gatewayHost: string;
  pagesHost: string;
  gatewayRegistrableDomain: string | null;
  pagesRegistrableDomain: string | null;
  same: boolean;
  overrideRequired: boolean;
  overrideCurrent: boolean;
}

export interface PageProfile {
  id: string;
  enabled: boolean;
  status:
    | "disabled"
    | "pending"
    | "ready"
    | "degraded"
    | "capability_missing"
    | "migration_pending";
  domainId: string | null;
  nodeId: string | null;
  certificateId: string | null;
  labelTemplate: string;
  overrideSameRegistrableDomain: boolean;
  overrideAcknowledgedById: string | null;
  overrideAcknowledgedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  domain: Pick<Domain, "id" | "domain" | "dnsStatus" | "nginxNodeId"> | null;
  node:
    | (Pick<Node, "id" | "displayName" | "hostname" | "status"> & { pagesCapable: boolean })
    | null;
  certificate: Pick<SSLCertificate, "id" | "name" | "domainNames" | "status" | "notAfter"> | null;
  isolation: PageProfileIsolation | null;
}

export interface PageProfileOptions {
  domains: Array<{
    id: string;
    domain: string;
    dnsStatus: string;
    nginxNodeId: string | null;
    isolation: Pick<
      PageProfileIsolation,
      "gatewayHost" | "pagesHost" | "gatewayRegistrableDomain" | "pagesRegistrableDomain" | "same"
    >;
  }>;
  nodes: Array<{
    id: string;
    displayName: string | null;
    hostname: string;
    status: string;
    pagesCapable: boolean;
  }>;
  certificates: Array<{
    id: string;
    name: string;
    domainNames: string[];
    status: string;
    notAfter: string | null;
  }>;
}

export type PageRuntimeConfigValue = Record<string, unknown>;

export interface PageRuntimeConfigRecord {
  id: string;
  projectId: string;
  tagId: string | null;
  source: string;
  value?: PageRuntimeConfigValue;
  generation: number;
  updatedAt: string;
  updatedById: string | null;
}

export interface PageRuntimeConfigTag {
  id: string;
  name: string;
  system: boolean;
  hasOverride: boolean;
  inherited?: boolean;
  override?: PageRuntimeConfigRecord | null;
  effective?: PageRuntimeConfigRecord;
}

export interface PageRuntimeConfigsResponse {
  default: PageRuntimeConfigRecord;
  overrides: PageRuntimeConfigRecord[];
  tags: PageRuntimeConfigTag[];
}

export interface UpdatePageRuntimeConfigRequest {
  source: string;
  expectedGeneration: number;
}

export interface CreatePageProjectRequest {
  name: string;
  nodeId: string;
  description?: string | null;
  folderId?: string | null;
  maxDeployments?: number;
  storageQuotaBytes?: number;
}

export interface PageProjectPlacementOption {
  id: string;
  displayName: string | null;
  hostname: string;
  status: string;
  pagesCapable: boolean;
}

export interface UpdatePageProjectRequest {
  name?: string;
  description?: string | null;
  appearanceColor?: NodeAppearanceColor | null;
  spaFallback?: boolean;
  previewsEnabled?: boolean;
  fallbackUrl?: string | null;
  maxDeployments?: number;
  storageQuotaBytes?: number;
  accessListId?: string | null;
}

export interface PageProjectPreviewRotation {
  project: PageProject;
  rotation: {
    revokedHostnames: number;
    cleanupPendingHostnames: number;
    republishFailures: number;
  };
}

export interface ConfigurePageProfileRequest {
  enabled: true;
  domainId: string;
  nodeId?: string;
  certificateId: string;
  labelTemplate: string;
  acknowledgeSameRegistrableDomain: boolean;
}

export interface CreatePageDeployTokenRequest {
  name: string;
  allowedTagPatterns: string[];
  allowUserTag: boolean;
  expiresAt?: string | null;
}
