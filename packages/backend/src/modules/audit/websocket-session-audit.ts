import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { hasTokenPrefix } from '@/lib/token-prefixes.js';
import type { WebSocketAuthResult, WebSocketCredential } from '@/modules/auth/websocket-auth.js';
import { AuditService } from './audit.service.js';
import { getAuditRequestContext, runWithAuditRequestContext } from './audit-request-context.js';

const logger = createChildLogger('WebSocketSessionAudit');

/** Client address of a websocket, read from the upgrade request's audit context. */
export interface WebSocketAuditOrigin {
  ipAddress?: string;
  userAgent?: string;
}

/** Call while the upgrade request is handled: websocket events later run outside its audit context. */
export function captureWebSocketAuditOrigin(): WebSocketAuditOrigin {
  const context = getAuditRequestContext();
  return { ipAddress: context?.ipAddress, userAgent: context?.userAgent };
}

/** How the websocket authenticated: the browser session, an API token or an OAuth (MCP) token. */
function credentialKind(credential: WebSocketCredential | null): string | undefined {
  if (!credential) return undefined;
  if (credential.type === 'session') return 'session';
  return hasTokenPrefix(credential.value, 'oauthAccess') ? 'oauth' : 'api_token';
}

/**
 * Audit an interactive session (a node root shell, a docker exec) opening or closing. The row names the impersonating
 * administrator as its actor with the impersonated user in its details, as the request audit context does for HTTP.
 */
export function auditWebSocketSession(
  origin: WebSocketAuditOrigin,
  auth: Pick<WebSocketAuthResult, 'user' | 'impersonation'>,
  credential: WebSocketCredential | null,
  entry: { action: string; resourceType: string; resourceId?: string; details?: Record<string, unknown> }
): void {
  const impersonation = auth.impersonation
    ? {
        actorUserId: auth.impersonation.actor.id,
        subjectUserId: auth.impersonation.subject.id,
        subjectEmail: auth.impersonation.subject.email,
        subjectName: auth.impersonation.subject.name,
      }
    : undefined;
  runWithAuditRequestContext({ ...origin, impersonation }, () =>
    container
      .resolve(AuditService)
      .log(
        {
          userId: auth.user.id,
          ...entry,
          details: { ...entry.details, credential: credentialKind(credential) },
        },
        { markRequest: false }
      )
      .catch((error: unknown) => {
        logger.warn('Could not audit a websocket session', {
          action: entry.action,
          error: error instanceof Error ? error.message : String(error),
        });
      })
  );
}
