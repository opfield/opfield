import { createHash } from 'node:crypto';

export const GITLAB_AUDIT_ACTIONS = {
  connectorCreate: 'connector.gitlab.create',
  connectorUpdate: 'connector.gitlab.update',
  connectorDelete: 'connector.gitlab.delete',
  connectorTokenRotate: 'connector.gitlab.token.rotate',
  connectorTest: 'connector.gitlab.test',
  connectorSync: 'connector.gitlab.sync',
  connectorAllowlistUpdate: 'connector.gitlab.allowlist.update',
  userCredentialAuthorize: 'connector.gitlab.user_credential.authorize',
  userCredentialDisconnect: 'connector.gitlab.user_credential.disconnect',
  userCredentialInvalidate: 'connector.gitlab.user_credential.invalidate',
  userCredentialRotate: 'connector.gitlab.user_credential.rotate',
  projectSearch: 'connector.gitlab.project.search',
  projectList: 'connector.gitlab.project.list',
  projectSettingsUpdate: 'connector.gitlab.project.settings.update',
  repositoryTree: 'connector.gitlab.repository.tree',
  fileRead: 'connector.gitlab.file.read',
  fileCommit: 'connector.gitlab.file.commit',
  branchCreate: 'connector.gitlab.branch.create',
  branchDelete: 'connector.gitlab.branch.delete',
  ciLint: 'connector.gitlab.ci.lint',
  ciUpdate: 'connector.gitlab.ci.update',
  pipelineRead: 'connector.gitlab.pipeline.read',
  variableList: 'connector.gitlab.variable.list',
  variableUpsert: 'connector.gitlab.variable.upsert',
  variableDelete: 'connector.gitlab.variable.delete',
  webhookManage: 'connector.gitlab.webhook.manage',
  registryDiscover: 'connector.gitlab.registry.discover',
  registryUse: 'connector.gitlab.registry.use',
  deployTokenCreate: 'connector.gitlab.deploy_token.create',
  repositoryClone: 'connector.gitlab.repository.clone',
  groupAncestryUnavailable: 'connector.gitlab.group_ancestry.unavailable',
} as const;

export type GitLabAuditAction = (typeof GITLAB_AUDIT_ACTIONS)[keyof typeof GITLAB_AUDIT_ACTIONS];

export const CLOUDFLARE_AUDIT_ACTIONS = {
  connectorCreate: 'connector.cloudflare.create',
  connectorUpdate: 'connector.cloudflare.update',
  connectorDelete: 'connector.cloudflare.delete',
  connectorTokenRotate: 'connector.cloudflare.token.rotate',
  connectorTest: 'connector.cloudflare.test',
  connectorSync: 'connector.cloudflare.sync',
  zoneList: 'connector.cloudflare.zone.list',
} as const;

export type CloudflareAuditAction = (typeof CLOUDFLARE_AUDIT_ACTIONS)[keyof typeof CLOUDFLARE_AUDIT_ACTIONS];

const SECRET_KEY_RE = /(?:token|secret|password|value|privateKey|private_key|webhookSecret|webhook_secret)/i;
const DIFF_LIKE_KEY_RE = /(?:diff|patch|content)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hashGitLabDiff(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function redactGitLabAuditDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.map((item) => redactGitLabAuditDetails(item, depth + 1));
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      redacted[key] = '[REDACTED]';
      continue;
    }
    if (DIFF_LIKE_KEY_RE.test(key) && !key.toLowerCase().endsWith('hash') && typeof nested === 'string') {
      redacted[`${key}Hash`] = hashGitLabDiff(nested);
      redacted[`${key}Omitted`] = true;
      continue;
    }
    redacted[key] = redactGitLabAuditDetails(nested, depth + 1);
  }
  return redacted;
}

export function buildGitLabFileCommitAuditDetails(input: {
  connectorId: string;
  connectorName?: string | null;
  projectRemoteId?: string | null;
  projectFullPath: string;
  branch: string;
  actionCount: number;
  filePaths: string[];
  commitSha?: string | null;
  diff?: string | null;
}) {
  return redactGitLabAuditDetails({
    connectorId: input.connectorId,
    connectorName: input.connectorName ?? null,
    projectRemoteId: input.projectRemoteId ?? null,
    projectFullPath: input.projectFullPath,
    branch: input.branch,
    actionCount: input.actionCount,
    filePaths: input.filePaths,
    commitSha: input.commitSha ?? null,
    diffHash: input.diff ? hashGitLabDiff(input.diff) : null,
  });
}
