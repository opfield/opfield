import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuditRequestContext {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  auditEmitted?: boolean;
  /** The account a sign-in request acts for, before its session exists (the fallback entry's user). */
  subjectUserId?: string;
  mcp?: AuditMcpContext;
  impersonation?: AuditImpersonationContext;
}

export interface AuditImpersonationContext {
  actorUserId: string;
  subjectUserId: string;
  subjectEmail: string;
  subjectName: string | null;
}

export interface AuditMcpContext {
  toolName: string;
  category: string;
  arguments: Record<string, unknown>;
  tokenId?: string;
  tokenPrefix?: string;
  authType?: string;
  clientId?: string;
}

const storage = new AsyncLocalStorage<AuditRequestContext>();

export function runWithAuditRequestContext<T>(context: AuditRequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/**
 * Runs work that is not part of the current request (a shared timer, a pull or a queue several requests feed) without
 * its audit context, so the rows that work writes do not carry the IP, user agent, token and tool arguments of
 * whichever request happened to start it.
 */
export function runOutsideAuditRequestContext<T>(callback: () => T): T {
  return storage.exit(callback);
}

export function getAuditRequestContext(): AuditRequestContext | undefined {
  return storage.getStore();
}

export function markAuditEmitted(): void {
  const context = storage.getStore();
  if (context) {
    context.auditEmitted = true;
  }
}

export function setAuditMcpContext(mcp: AuditMcpContext): void {
  const context = storage.getStore();
  if (context) {
    context.mcp = mcp;
  }
}

export function setAuditImpersonationContext(impersonation: AuditImpersonationContext): void {
  const context = storage.getStore();
  if (context) {
    context.impersonation = impersonation;
  }
}

/** Names the account a sign-in request acts for, so its audit entry carries that user rather than none. */
export function setAuditSubjectUser(userId: string): void {
  const context = storage.getStore();
  if (context) {
    context.subjectUserId = userId;
  }
}
