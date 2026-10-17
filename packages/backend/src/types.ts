import type { Context } from 'hono';

export type AuthMethod = 'oidc' | 'password' | 'email_otp' | 'demo_email_otp';

export interface User {
  id: string;
  oidcSubject: string | null;
  authMethod?: AuthMethod;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  groupId: string;
  groupIds?: string[];
  groupNames?: string[];
  groupName: string;
  require2fa?: boolean;
  groupScopes?: string[];
  additionalScopes?: string[];
  scopes: string[];
  /**
   * Live account scopes behind a programmatic caller (API token, OAuth grant, MCP) whose `scopes` are
   * token-bounded. Git repository checks require both sets to cover the repository.
   */
  accountScopes?: string[];
  isBlocked: boolean;
  /**
   * Who blocked the account while it is blocked: an administrator, or the Opfield account (the cloud account removed
   * this person's access; their next sign-in through the Opfield account lifts it). Null while not blocked.
   */
  blockedBy?: 'admin' | 'opfield_account' | null;
  isDeleted?: boolean;
  aiApprovalMode?: 'always-ask' | 'normal' | 'bypass-non-destructive' | 'bypass-everything';
  folderId?: string | null;
  sortOrder?: number;
  /** Admin user payloads: the first sign-in marker and when the account invitation email was sent. */
  lastLoginAt?: string | null;
  invitationSentAt?: string | null;
}

export interface SessionData {
  userId: string;
  user: User;
  publicId?: string;
  authMethod?: AuthMethod;
  accessToken?: string;
  refreshToken?: string;
  csrfToken?: string;
  purpose?: 'user' | 'setup' | 'impersonation';
  setupSessionId?: string;
  impersonation?: {
    actorUserId: string;
    originalSessionId: string;
  };
  createdAt: number;
  lastSeenAt?: number;
  ipAddress?: string;
  userAgent?: string;
  mfaSatisfiedAt?: number;
  mfaGraceExpiresAt?: number;
  expiresAt: number;
}

export interface PublicSession {
  id: string;
  authMethod: AuthMethod;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  mfaSatisfiedAt: number | null;
  isCurrent: boolean;
}

export interface AppEnv {
  Variables: {
    user?: User;
    sessionId?: string;
    effectiveScopes?: string[];
    /** Set by requireDockerContainerScope when a Git source route runs for a container removed outside Opfield. */
    dockerRemovedContainerSource?: boolean;
    isTokenAuth?: boolean;
    authType?: 'session' | 'api-token' | 'oauth-token' | 'inference-token';
    /** Id of the API or OAuth token that authenticated the request. */
    authTokenId?: string;
    impersonation?: {
      actor: User;
      subject: User;
      authorized: boolean;
    };
    inferenceAuth?: {
      tokenId: string;
      tokenPrefix: string;
      rawToken: string;
      /** The request's client address: a token limited to addresses is checked against it again. */
      clientIp?: string;
    };
    inferenceAdapter?: 'anthropic' | 'codex' | 'openai';
    pageDeployAuth?:
      | { kind: 'user'; userId: string; scopes: string[]; tokenPrefix?: string }
      | {
          kind: 'deploy-token';
          token: {
            tokenId: string;
            tokenPrefix: string;
            projectId: string;
            allowedTagPatterns: string[];
            allowUserTag: boolean;
          };
        };
    mcpAuth?: {
      tokenId: string;
      tokenPrefix: string;
      authType?: 'oauth' | 'api-token';
      clientId?: string;
    };
    mcpExtendedCompatibility?: boolean;
    requestId: string;
    /** Whether Opfield setup is complete, read once per request by the host guard. */
    setupComplete?: boolean;
    loggingIngest?: {
      tokenId: string;
      environmentId: string;
      tokenPrefix: string;
      environment: {
        id: string;
        enabled: boolean;
        schemaMode: 'loose' | 'strip' | 'reject';
        retentionDays: number;
        fieldSchema: import('@/db/schema/index.js').LoggingFieldDefinition[];
        rateLimitRequestsPerWindow: number | null;
        rateLimitEventsPerWindow: number | null;
      };
    };
  };
}

export type AuthenticatedContext = Context<AppEnv> & {
  var: {
    user: User;
    sessionId?: string;
    effectiveScopes?: string[];
    isTokenAuth?: boolean;
    authType?: 'session' | 'api-token' | 'oauth-token' | 'inference-token';
    inferenceAuth?: {
      tokenId: string;
      tokenPrefix: string;
      rawToken: string;
      /** The request's client address: a token limited to addresses is checked against it again. */
      clientIp?: string;
    };
    requestId: string;
  };
};

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
