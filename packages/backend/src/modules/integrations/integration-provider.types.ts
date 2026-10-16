import type {
  IntegrationAllowlistEntryType,
  IntegrationConnectorCapabilities,
  IntegrationProvider,
} from '@/db/schema/index.js';

export interface VcsConnectorAuth {
  token: string;
  baseUrl: string;
}

export interface VcsConnectorIdentity {
  id: string;
  provider: IntegrationProvider;
  name: string;
  baseUrl: string;
}

export interface VcsUserTokenIdentity {
  userId: string;
  username: string;
  scopes: string[];
  expiresAt: Date | null;
}

/** Metadata of the access token a connector or user credential authenticates with. */
export interface VcsTokenDescription {
  scopes: string[];
  expiresAt: Date | null;
  createdAt: Date | null;
}

export interface VcsRotatedToken {
  token: string;
  scopes: string[];
  expiresAt: Date | null;
}

export interface VcsProjectAccess {
  project: VcsProjectRef;
  accessLevel: number | null;
}

export interface VcsBranchAccess {
  exists: boolean;
  canPush: boolean;
  commitSha?: string | null;
}

export interface VcsProjectRef {
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl?: string | null;
  visibility?: string | null;
  defaultBranch?: string | null;
  archived?: boolean;
}

/** A GitLab group (or namespace) by its stable ID. */
export interface VcsGroupRef {
  id: string;
  fullPath: string;
  name: string;
  /** The parent group ID; null for a top-level group. */
  parentId: string | null;
}

/** The namespace a project lives in: a group (with its parent) or a user namespace. */
export interface VcsProjectNamespace {
  id: string;
  kind: 'group' | 'user';
  fullPath: string;
  parentId: string | null;
}

/** A project as the scope picker shows it. */
export interface VcsProjectScopeRef {
  id: string;
  pathWithNamespace: string;
  name: string;
}

export interface VcsScopeTargetSearchResult {
  groups: VcsGroupRef[];
  projects: VcsProjectScopeRef[];
  /** False when the page bound cut a listing: more groups or projects match than were read. */
  complete?: boolean;
}

export interface VcsAllowlistSearchResult {
  entryType: IntegrationAllowlistEntryType;
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl?: string | null;
}

export interface VcsTreeEntry {
  path: string;
  name: string;
  type: 'tree' | 'blob' | 'commit';
  size?: number | null;
  mode?: string | null;
  id?: string | null;
}

export interface VcsFileReadRequest {
  project: VcsProjectRef;
  path: string;
  ref?: string;
  offset?: number;
  length?: number;
}

export interface VcsFileReadResult {
  path: string;
  ref: string;
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  offset: number;
  bytesRead: number;
  truncated: boolean;
  nextOffset?: number | null;
  blobId?: string | null;
  commitId?: string | null;
}

export interface VcsCommitFileChange {
  action: 'create' | 'update' | 'delete' | 'move';
  path: string;
  previousPath?: string;
  content?: string;
  encoding?: 'text' | 'base64';
}

export interface VcsCommitRequest {
  project: VcsProjectRef;
  branch: string;
  commitMessage: string;
  changes: VcsCommitFileChange[];
  startBranch?: string;
}

export interface VcsCommitResult {
  commitSha: string;
  webUrl?: string | null;
}

export interface VcsCiLintResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  mergedYaml?: string | null;
}

export interface VcsPipelineRef {
  id: number;
  iid?: number | null;
  ref?: string | null;
  sha?: string | null;
  status?: string | null;
  source?: string | null;
  webUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface VcsPipelineJobRef {
  id: number;
  name: string;
  stage?: string | null;
  status?: string | null;
  ref?: string | null;
  webUrl?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface VcsJobLogResult {
  jobId: number;
  output: string;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
}

export interface VcsProjectVariableRef {
  key: string;
  variableType?: string | null;
  protected?: boolean;
  masked?: boolean;
  raw?: boolean;
  environmentScope?: string | null;
  description?: string | null;
}

export interface VcsProjectVariableInput {
  key: string;
  value: string;
  variableType?: 'env_var' | 'file';
  protected?: boolean;
  masked?: boolean;
  raw?: boolean;
  environmentScope?: string;
  description?: string;
}

export interface VcsProjectWebhookRef {
  id: number;
  url: string;
  pushEvents?: boolean;
  mergeRequestsEvents?: boolean;
  tagPushEvents?: boolean;
  jobEvents?: boolean;
  pipelineEvents?: boolean;
  enableSslVerification?: boolean;
  createdAt?: string | null;
}

export interface VcsProjectWebhookInput {
  id?: number;
  url: string;
  token?: string;
  pushEvents?: boolean;
  mergeRequestsEvents?: boolean;
  tagPushEvents?: boolean;
  jobEvents?: boolean;
  pipelineEvents?: boolean;
  enableSslVerification?: boolean;
}

export interface VcsRegistryRepositoryRef {
  id: string;
  name: string;
  path?: string | null;
  location?: string | null;
  tagsCount?: number | null;
}

export interface VcsDeployTokenInput {
  name: string;
  scopes: string[];
  expiresAt?: string;
}

export interface VcsDeployTokenResult {
  id: number | string;
  name: string;
  username: string;
  token: string;
  scopes: string[];
  expiresAt?: string | null;
}

export interface VcsArchiveResult {
  filename: string;
  contentType: string | null;
  bytes: Buffer;
}

export interface VcsArchiveStream {
  filename: string;
  contentType: string | null;
  chunks: AsyncIterable<Buffer>;
}

export interface VcsRegistryRef {
  remoteRegistryId?: string | null;
  projectRemoteId?: string | null;
  projectFullPath?: string | null;
  registryUrl: string;
  name: string;
}

export interface VcsRegistryDiscoverySkippedProject {
  remoteId: string;
  fullPath: string;
  reason: 'forbidden' | 'not_found';
}

export interface VcsRegistryDiscoveryResult {
  registries: VcsRegistryRef[];
  skippedProjects: VcsRegistryDiscoverySkippedProject[];
}

export interface VcsProjectSettingsInput {
  containerRegistryAccessLevel?: 'enabled' | 'private' | 'disabled';
}

export interface VcsProjectSettingsResult {
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl?: string | null;
  containerRegistryAccessLevel?: string | null;
}

export interface ConnectorProvider {
  provider: IntegrationProvider;
  testConnection(auth: VcsConnectorAuth): Promise<IntegrationConnectorCapabilities>;
  searchAllowlist(auth: VcsConnectorAuth, query: string): Promise<VcsAllowlistSearchResult[]>;
  listProjects(auth: VcsConnectorAuth): Promise<VcsProjectRef[]>;
  listRegistries(auth: VcsConnectorAuth, projects?: VcsProjectRef[]): Promise<VcsRegistryDiscoveryResult>;
}

export interface VcsConnectorProvider extends ConnectorProvider {
  validateUserToken(auth: VcsConnectorAuth): Promise<VcsUserTokenIdentity>;
  /** Scopes and expiry of the authenticating token, or null when the provider does not report them. */
  describeToken?(auth: VcsConnectorAuth): Promise<VcsTokenDescription | null>;
  /** Replace the authenticating token with a new one (the old one is revoked by the provider). */
  rotateToken?(auth: VcsConnectorAuth, expiresAt: Date): Promise<VcsRotatedToken>;
  /** Revoke the authenticating token. */
  revokeToken?(auth: VcsConnectorAuth): Promise<void>;
  /** The project's namespace, used to resolve group-qualified scopes; null when the project is not visible. */
  getProjectNamespace?(auth: VcsConnectorAuth, projectId: string): Promise<VcsProjectNamespace | null>;
  /**
   * Every ancestor group of a project (its namespace group and all parents), even those the credential cannot
   * read one by one; null when the project is not visible.
   */
  getProjectAncestorGroups?(auth: VcsConnectorAuth, projectId: string): Promise<VcsGroupRef[] | null>;
  /** One group by ID or full path; null when it does not exist or is not visible. */
  getGroup?(auth: VcsConnectorAuth, groupId: string): Promise<VcsGroupRef | null>;
  /** One project by ID or full path for scope labels; null when it does not exist or is not visible. */
  getProjectScopeRef?(auth: VcsConnectorAuth, projectId: string): Promise<VcsProjectScopeRef | null>;
  /**
   * Groups and projects matching a search (a name, or part of a full path such as `team/sub`), for the scope
   * picker, reading at most `maxPages` pages of each listing.
   */
  searchScopeTargets?(
    auth: VcsConnectorAuth,
    query: string,
    limit: number,
    maxPages?: number
  ): Promise<VcsScopeTargetSearchResult>;
  getProjectAccess(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectAccess>;
  getBranchAccess(auth: VcsConnectorAuth, project: VcsProjectRef, branch: string): Promise<VcsBranchAccess>;
  createBranch(auth: VcsConnectorAuth, project: VcsProjectRef, branch: string, ref: string): Promise<void>;
  /** Deletes a branch; providers without it cannot delete branches. */
  deleteBranch?(auth: VcsConnectorAuth, project: VcsProjectRef, branch: string): Promise<void>;
  listTree(auth: VcsConnectorAuth, project: VcsProjectRef, path: string, ref?: string): Promise<VcsTreeEntry[]>;
  readFile(auth: VcsConnectorAuth, request: VcsFileReadRequest): Promise<VcsFileReadResult>;
  commitFiles(auth: VcsConnectorAuth, request: VcsCommitRequest): Promise<VcsCommitResult>;
  lintCiConfig(auth: VcsConnectorAuth, project: VcsProjectRef, content: string): Promise<VcsCiLintResult>;
  listPipelines(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    limit?: number
  ): Promise<VcsPipelineRef[]>;
  getPipeline(auth: VcsConnectorAuth, project: VcsProjectRef, pipelineId: number): Promise<VcsPipelineRef>;
  listPipelineJobs(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    pipelineId: number,
    limit?: number
  ): Promise<VcsPipelineJobRef[]>;
  getJobLog(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    jobId: number,
    limitBytes: number
  ): Promise<VcsJobLogResult>;
  listProjectVariables(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectVariableRef[]>;
  setProjectVariable(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectVariableInput
  ): Promise<VcsProjectVariableRef>;
  deleteProjectVariable(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    key: string,
    environmentScope?: string
  ): Promise<void>;
  listProjectWebhooks(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsProjectWebhookRef[]>;
  createOrUpdateProjectWebhook(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectWebhookInput
  ): Promise<VcsProjectWebhookRef>;
  deleteProjectWebhook(auth: VcsConnectorAuth, project: VcsProjectRef, hookId: number): Promise<void>;
  listRegistryRepositories(auth: VcsConnectorAuth, project: VcsProjectRef): Promise<VcsRegistryRepositoryRef[]>;
  createDeployToken(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsDeployTokenInput
  ): Promise<VcsDeployTokenResult>;
  updateProjectSettings(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    input: VcsProjectSettingsInput
  ): Promise<VcsProjectSettingsResult>;
  downloadRepositoryArchive(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    options?: { maxBytes?: number; timeoutMs?: number }
  ): Promise<VcsArchiveResult>;
  streamRepositoryArchive(
    auth: VcsConnectorAuth,
    project: VcsProjectRef,
    ref?: string,
    options?: { maxBytes?: number; timeoutMs?: number }
  ): Promise<VcsArchiveStream>;
}
