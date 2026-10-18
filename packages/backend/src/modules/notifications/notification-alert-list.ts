import { and, count, desc, eq, gte, ilike, inArray, like, lte, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { notificationAlertRules, notificationAlertStates } from '@/db/schema/index.js';
import type { AlertListQuery } from './notification-alert-rule.schemas.js';

/** The text with the LIKE wildcards escaped. */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A LIKE pattern that matches the text literally. */
function containing(text: string): string {
  return `%${literal(text)}%`;
}

/**
 * The alerts that fired, newest first, with their rule: what fires now (status firing) and the history (resolved,
 * kept 30 days). GET /api/notifications/alerts and the MCP tool list_alerts answer with it. `allowedRuleIds`: the rules a
 * caller without broad view may see.
 */
export async function listFiredAlerts(
  db: DrizzleClient,
  query: AlertListQuery,
  options: { allowedRuleIds?: readonly string[] } = {}
) {
  const conditions: SQL[] = [];
  // A caller without broad rule view sees the alerts of the rules granted to it (one by one or by folder).
  if (options.allowedRuleIds) {
    conditions.push(
      options.allowedRuleIds.length > 0
        ? inArray(notificationAlertStates.ruleId, [...options.allowedRuleIds])
        : sql`false`
    );
  }
  if (query.status !== 'all') conditions.push(eq(notificationAlertStates.status, query.status));
  if (query.ruleId) conditions.push(eq(notificationAlertStates.ruleId, query.ruleId));
  if (query.category) conditions.push(eq(notificationAlertRules.category, query.category));
  if (query.severity) conditions.push(eq(notificationAlertStates.severity, query.severity));
  if (query.resourceType) conditions.push(eq(notificationAlertStates.resourceType, query.resourceType));
  if (query.resourceId) {
    // A node's per-disk and per-container alerts key their state "<nodeId>:<mount or name>", a disk several nodes
    // share keys it "disk:<id>" with the node in details, and a container alert keys it by the container's id: the
    // node id, the full key or the resource's name all find them.
    const id = query.resourceId;
    conditions.push(
      or(
        eq(notificationAlertStates.resourceId, id),
        like(notificationAlertStates.resourceId, `${literal(id)}:%`),
        eq(notificationAlertStates.resourceName, id),
        sql`${notificationAlertStates.context}->'node'->>'id' = ${id}`
      )!
    );
  }
  if (query.since) conditions.push(gte(notificationAlertStates.firedAt, query.since));
  if (query.until) conditions.push(lte(notificationAlertStates.firedAt, query.until));
  if (query.search) {
    const pattern = containing(query.search);
    conditions.push(
      or(
        ilike(notificationAlertRules.name, pattern),
        ilike(notificationAlertStates.resourceName, pattern),
        ilike(notificationAlertStates.resourceId, pattern),
        ilike(notificationAlertStates.message, pattern)
      )!
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalRow] = await db
    .select({ count: count() })
    .from(notificationAlertStates)
    .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
    .where(where);
  const rows = await db
    .select({ state: notificationAlertStates, rule: notificationAlertRules })
    .from(notificationAlertStates)
    .innerJoin(notificationAlertRules, eq(notificationAlertRules.id, notificationAlertStates.ruleId))
    .where(where)
    .orderBy(desc(notificationAlertStates.firedAt), desc(notificationAlertStates.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const now = Date.now();
  const total = totalRow?.count ?? 0;
  return {
    data: rows.map(({ state, rule }) => ({
      id: state.id,
      status: state.status,
      severity: state.severity,
      ruleId: rule.id,
      ruleName: rule.name,
      ruleType: rule.type,
      category: rule.category,
      metric: rule.metric,
      eventPattern: rule.eventPattern,
      resourceType: state.resourceType,
      resourceId: state.resourceId,
      // Rows written before 2.12.3 have no name or message.
      resourceName: state.resourceName ?? null,
      message: state.message ?? null,
      firedAt: state.firedAt,
      resolvedAt: state.resolvedAt,
      lastNotifiedAt: state.lastNotifiedAt,
      durationSeconds: Math.max(0, Math.round(((state.resolvedAt?.getTime() ?? now) - state.firedAt.getTime()) / 1000)),
      details: state.context ?? {},
    })),
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.ceil(total / query.limit),
  };
}
