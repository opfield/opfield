/**
 * Unified scope definitions for group and user-specific permissions.
 * Both session users (via group membership) and API tokens use these scopes.
 *
 * Naming convention: domain:resource:action[:qualifier]
 * Resource-scopable scopes support suffixes: e.g. docker:containers:view:node-uuid
 */

export const ALL_SCOPES = [
  'storage:view',
  'storage:create',
  'storage:edit',
  'storage:delete',
  'storage:credentials:reveal',
  'storage:credentials:use',
  'storage:iam',
  'storage:objects:read',
  'storage:objects:write',
  'storage:objects:admin',
  'storage:folders:manage',
  // Link a workload to managed storage (a bucket-scoped key of its own); issuing access keys stays storage:iam.
  'storage:bind',
  'databases:backups:view',
  'databases:backups:manage',
  'databases:backups:run',
  'databases:backups:restore',
  'nodes:backups:execute',

  // ── PKI: Certificate Authorities ─────────────────────────────────
  'pki:ca:view',
  'pki:ca:create:root',
  'pki:ca:create:intermediate',
  'pki:ca:edit',
  'pki:ca:export',
  'pki:ca:revoke:root',
  'pki:ca:revoke:intermediate',
  'pki:ca:folders:manage',
  // ── PKI: Certificates ────────────────────────────────────────────
  'pki:cert:view',
  'pki:cert:issue',
  'pki:cert:revoke',
  'pki:cert:export',
  // Lets nginx serve the certificate on a Route; the private key never reaches the caller. Implied by export.
  'pki:cert:deploy',
  'pki:cert:folders:manage',
  // ── PKI: Certificate Templates ───────────────────────────────────
  'pki:templates:view',
  'pki:templates:create',
  'pki:templates:edit',
  'pki:templates:delete',
  'pki:templates:folders:manage',
  // ── Domains ──────────────────────────────────────────────────────
  'domains:view',
  'domains:create',
  'domains:edit',
  'domains:delete',
  'domains:folders:manage',
  // ── Ingress Routes (proxy-host API resources) ────────────────────
  'proxy:view',
  'proxy:create',
  'proxy:edit',
  'proxy:delete',
  'proxy:raw:read',
  'proxy:raw:write',
  'proxy:advanced',
  'proxy:unrestricted',
  'proxy:maintenance:bypass',
  'proxy:folders:manage',
  // ── Pages ─────────────────────────────────────────────────────────
  'pages:view',
  'pages:create',
  'pages:edit',
  'pages:delete',
  'pages:deploy',
  'pages:deployments:manage',
  'pages:tags:manage',
  'pages:tokens:manage',
  'pages:folders:manage',
  'pages:settings:view',
  'pages:settings:edit',
  // ── Proxy Templates ──────────────────────────────────────────────
  'proxy:templates:view',
  'proxy:templates:manage',
  'proxy:templates:folders:manage',
  // ── SSL Certificates ─────────────────────────────────────────────
  'ssl:cert:view',
  'ssl:cert:issue',
  // Renews, reissues, and completes the ACME challenge of an existing certificate. Implied by issue.
  'ssl:cert:renew',
  'ssl:cert:folders:manage',
  'ssl:cert:delete',
  // ── Access Control Lists ─────────────────────────────────────────
  'acl:view',
  'acl:create',
  'acl:edit',
  'acl:delete',
  // ── Nodes ────────────────────────────────────────────────────────
  'nodes:details',
  'nodes:create',
  'nodes:rename',
  'nodes:delete',
  'nodes:manage',
  'nodes:config:view',
  'nodes:logs',
  'nodes:console',
  'nodes:files:read',
  'nodes:files:write',
  'nodes:lock',
  'nodes:folders:manage',
  // ── Ingress Groups ───────────────────────────────────────────────
  // Groups live in node folders: both scopes are broad or limited to a node folder (`folder/<id>`).
  'ingress:groups:view',
  'ingress:groups:manage',
  // ── Apps ─────────────────────────────────────────────────────────
  // Qualifiers: `<appId>` (whole app) and `env/<envId>` (view, env:manage, promote, operate); create is broad only.
  'apps:view',
  'apps:create',
  'apps:edit',
  'apps:delete',
  'apps:env:manage',
  'apps:promote',
  'apps:operate',
  // ── Administration ───────────────────────────────────────────────
  'admin:users',
  'admin:users:impersonate',
  'admin:users:folders:manage',
  'admin:groups',
  'admin:groups:folders:manage',
  'admin:audit',
  'audit:siem:view',
  'audit:siem:manage',
  'admin:system',
  'admin:details:certificates',
  'admin:update',
  'admin:alerts',
  // ── Gateway Settings ─────────────────────────────────────────────
  'settings:opfield:view',
  'settings:opfield:edit',
  // ── Integrations: Git providers (GitLab, GitHub, generic Git) ────
  // Every Git provider uses the same verbs: view connectors, manage (and sync) them, use the
  // connector's system credential, and read or write repository content (files, CI, variables,
  // secrets, webhooks, registry).
  'integrations:gitlab:view',
  'integrations:gitlab:manage',
  'integrations:gitlab:use',
  'integrations:gitlab:repo:read',
  'integrations:gitlab:repo:write',
  'integrations:gitlab:sandbox:clone',
  'integrations:github:view',
  'integrations:github:manage',
  'integrations:github:use',
  'integrations:github:repo:read',
  'integrations:github:repo:write',
  'integrations:git:view',
  'integrations:git:manage',
  'integrations:git:use',
  'integrations:git:repo:read',
  'integrations:git:repo:write',
  // ── Integrations: external SSH ───────────────────────────────────
  'integrations:ssh:view',
  'integrations:ssh:manage',
  'integrations:ssh:use',
  // ── Integrations: Cloudflare ─────────────────────────────────────
  'integrations:cloudflare:view',
  'integrations:cloudflare:manage',
  'integrations:cloudflare:sync',
  // Hosting account access is separate from VM control and account finances.
  'integrations:hosting:view',
  'integrations:hosting:manage',
  'hosting:resources:view',
  'hosting:resources:create',
  'hosting:resources:power',
  'hosting:resources:resize',
  'hosting:snapshots:view',
  'hosting:snapshots:create',
  'hosting:snapshots:delete',
  'hosting:snapshots:restore',
  'hosting:snapshots:folders:manage',
  'hosting:resources:delete',
  'hosting:resources:recover',
  'hosting:billing:view',
  'hosting:billing:topup',
  // ── Housekeeping ─────────────────────────────────────────────────
  'housekeeping:view',
  'housekeeping:run',
  'housekeeping:configure',
  // ── Gateway diagnostics ──────────────────────────────────────────
  // Gateway's own state (host, process, database, cache, stack containers, background jobs, API
  // latency and its history) and, separately, the logs of Gateway's own containers.
  'diagnostics:view',
  'diagnostics:logs',
  // ── Licensing ────────────────────────────────────────────────────
  'license:view',
  'license:manage',
  // ── Features ─────────────────────────────────────────────────────
  'ai:workspace:use',
  'feat:ai:use',
  'feat:ai:configure',
  'ai:skills:manage',
  'ai:sandbox:use',
  'ai:sandbox:tier:medium',
  'ai:sandbox:tier:high',
  'ai:sandbox:manage',
  'mcp:use',
  // ── Inference ────────────────────────────────────────────────────
  'inference:providers:view',
  'inference:providers:manage',
  'inference:models:manage',
  'inference:limits:manage',
  'inference:usage:view',
  // ── Docker: Containers ───────────────────────────────────────────
  'docker:containers:view',
  'docker:containers:create',
  'docker:containers:edit',
  'docker:containers:manage',
  'docker:containers:environment',
  // Target of a container link: lets other workloads reach one port of this container or deployment privately.
  'docker:containers:link',
  'docker:containers:delete',
  'docker:containers:console',
  'docker:containers:files:read',
  'docker:containers:files:write',
  'docker:containers:export',
  'docker:containers:secrets',
  'docker:containers:webhooks',
  'docker:containers:mounts',
  'docker:containers:migrate',
  'docker:availability:manage',
  // Folders for containers, deployments, Compose projects, networks, volumes, and images.
  'docker:folders:manage',
  // ── Docker: Compose Projects ─────────────────────────────────────
  'docker:compose:view',
  'docker:compose:create',
  'docker:compose:manage',
  'docker:compose:delete',
  // ── Docker: Images ───────────────────────────────────────────────
  'docker:images:view',
  'docker:images:pull',
  'docker:images:delete',
  // ── Docker: Volumes ──────────────────────────────────────────────
  'docker:volumes:view',
  'docker:volumes:create',
  'docker:volumes:edit',
  'docker:volumes:delete',
  'docker:volumes:export',
  'docker:volumes:files:read',
  'docker:volumes:files:write',
  // ── Docker: Networks ─────────────────────────────────────────────
  'docker:networks:view',
  'docker:networks:create',
  'docker:networks:edit',
  'docker:networks:delete',
  // ── Docker: Registries ───────────────────────────────────────────
  'docker:registries:view',
  'docker:registries:create',
  'docker:registries:edit',
  'docker:registries:delete',
  // Legacy: internal registry access belongs to API tokens now (modules/tokens/token-registry-access.ts). A user who
  // holds these still lets their tokens pull or push the repositories they cover without access to any workload.
  'docker:registries:internal:pull',
  'docker:registries:internal:push',
  // ── Docker: Tasks ────────────────────────────────────────────────
  'docker:tasks',
  'docker:tasks:manage',
  // ── Databases ────────────────────────────────────────────────────
  'databases:view',
  'databases:create',
  'databases:edit',
  'databases:delete',
  'databases:query:read',
  'databases:query:write',
  'databases:query:admin',
  'databases:credentials:reveal',
  'databases:folders:manage',
  // Link a workload to a managed database (a database identity of its own) without editing the database.
  'databases:bind',
  // ── Notifications ────────────────────────────────────────────────
  'notifications:alerts:view',
  'notifications:alerts:manage',
  'notifications:webhooks:view',
  'notifications:webhooks:manage',
  // ── External Logging ─────────────────────────────────────────────
  'logs:environments:view',
  'logs:environments:create',
  'logs:environments:edit',
  'logs:environments:delete',
  'logs:environments:folders:manage',
  'logs:tokens:view',
  'logs:tokens:create',
  'logs:tokens:delete',
  'logs:schemas:view',
  'logs:schemas:create',
  'logs:schemas:edit',
  'logs:schemas:delete',
  'logs:schemas:folders:manage',
  'logs:read',
  // ── Status Page ──────────────────────────────────────────────────
  'status-page:view',
  'status-page:manage',
  'status-page:incidents:create',
  'status-page:incidents:update',
  'status-page:incidents:resolve',
  'status-page:incidents:delete',
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/**
 * AI Workspace chat, skills, sandbox, and the MCP account gate.
 * `feat:ai:use` is not here: it gates Gateway Inference (a resource, including personal `gwi_` keys).
 */
export const USER_ONLY_SCOPES = [
  'ai:workspace:use',
  'feat:ai:configure',
  'ai:skills:manage',
  'ai:sandbox:use',
  'ai:sandbox:tier:medium',
  'ai:sandbox:tier:high',
  'ai:sandbox:manage',
  'mcp:use',
] as const;
/**
 * Scopes that API tokens and OAuth grants (REST and MCP) can never carry. Programmatic access may do
 * everything a user can do with Gateway resources; only browser- or identity-bound capabilities stay
 * here. Every other scope is delegable and stays bounded by the owner's live permissions.
 */
export const PROGRAMMATIC_DENIED_BASE_SCOPES = [
  ...USER_ONLY_SCOPES,
  // Impersonation turns the caller's browser session into another user's session.
  'admin:users:impersonate',
  // Clones into the AI sandbox working copy and additionally requires the user-only ai:sandbox:use.
  'integrations:gitlab:sandbox:clone',
] as const;

export const PROGRAMMATIC_DENIED_SCOPE_SET = new Set<string>(PROGRAMMATIC_DENIED_BASE_SCOPES);

export const API_TOKEN_SCOPES = ALL_SCOPES.filter((scope) => !PROGRAMMATIC_DENIED_SCOPE_SET.has(scope));

/** Gateway MCP delegates exactly the API token scopes; `mcp:use` is the user-account gate, never a grant. */
export const MCP_TOKEN_SCOPES = API_TOKEN_SCOPES.filter((scope) => scope !== 'mcp:use');

/** System-admin group: every scope including admin:system (protected) */
