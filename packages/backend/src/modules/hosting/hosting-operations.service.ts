import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import { hostingFirewalls, hostingOperations, integrationConnectors, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { acquireHostingFirewallLock } from './hosting-firewall-lock.js';
import { assertHostingScope } from './hosting-permissions.js';
import type { HostingOperationAction, HostingOperationPhase } from './hosting-provider.types.js';

export type HostingOperationRow = typeof hostingOperations.$inferSelect;
type OperationPatch = Partial<typeof hostingOperations.$inferInsert>;
export const HOSTING_OPERATION_LEASE_MS = 90_000;
export const HOSTING_TERMINAL_PHASES: HostingOperationPhase[] = ['ready', 'failed'];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  return value;
}
export function hostingRequestHash(
  action: HostingOperationAction,
  actorId: string,
  request: Record<string, unknown>
): string {
  const { idempotencyKey: _key, ...intent } = request;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ action, actorId, request: intent })))
    .digest('hex');
}
export function publicHostingOperation(row: HostingOperationRow) {
  return {
    id: row.id,
    connectorId: row.connectorId,
    resourceId: row.resourceId,
    nodeId: row.nodeId,
    node:
      row.nodeId && typeof row.request?.name === 'string' && typeof row.request.role === 'string'
        ? {
            id: row.nodeId,
            name: row.request.name,
            type: row.request.role,
            location: typeof row.request.location === 'string' ? row.request.location : '',
          }
        : undefined,
    action: row.action,
    phase: row.phase,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    // Only service-authored public results are permitted. Credentials/provider dumps never enter result.
    result: row.result,
  };
}

/** How often one operation sends a provider step again after it failed on a transient provider condition. */
export const HOSTING_TRANSIENT_TASK_RETRIES = 3;

/**
 * The patch that sends the same provider step again after its task failed for a transient reason (a Proxmox lock wait
 * timed out before the task changed anything), or null when the failure is final or the retries are used up. The
 * caller sets the phase that re-dispatches the step; the same VM and request are reused, nothing new is ordered.
 */
export function transientTaskRetry(
  row: Pick<HostingOperationRow, 'result'>,
  task: { transient?: boolean; error?: string }
): OperationPatch | null {
  if (!task.transient) return null;
  const retries = Number(row.result?.transientTaskRetries ?? 0);
  if (!Number.isInteger(retries) || retries >= HOSTING_TRANSIENT_TASK_RETRIES) return null;
  return {
    providerOperation: null,
    dispatchStartedAt: null,
    result: { ...row.result, transientTaskRetries: retries + 1, lastTransientTaskError: task.error ?? null },
  };
}

/** DB state owns intent and progress. HTTP/UI lifetimes do not own provider mutations. */
export class HostingOperationsService {
  private readonly workerId = randomUUID();
  constructor(
    private readonly db: DrizzleClient,
    private readonly events: EventBusService
  ) {}

  async findIntent(input: {
    connectorId: string;
    actorId: string;
    action: HostingOperationAction;
    idempotencyKey: string;
    request: Record<string, unknown>;
  }) {
    const hash = hostingRequestHash(input.action, input.actorId, input.request);
    const [existing] = await this.db
      .select()
      .from(hostingOperations)
      .where(
        and(
          eq(hostingOperations.connectorId, input.connectorId),
          eq(hostingOperations.action, input.action),
          eq(hostingOperations.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (existing) {
      if (existing.requestHash !== hash || existing.actorId !== input.actorId)
        throw new AppError(409, 'HOSTING_INTENT_CONFLICT', 'This request identifier belongs to a different operation');
      return existing;
    }
    const [active] = await this.db
      .select()
      .from(hostingOperations)
      .where(
        and(
          eq(hostingOperations.connectorId, input.connectorId),
          eq(hostingOperations.action, input.action),
          eq(hostingOperations.requestHash, hash),
          notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES)
        )
      )
      .limit(1);
    return active ?? null;
  }

  async reserve(
    input: {
      connectorId: string;
      resourceId?: string;
      actorId: string;
      action: HostingOperationAction;
      idempotencyKey: string;
      request: Record<string, unknown>;
      /** User-supplied intent before service-owned accepted defaults/reservations are attached. */
      intent?: Record<string, unknown>;
    },
    initialize?: (tx: DrizzleTransaction, operationId: string) => Promise<OperationPatch>
  ): Promise<{ operation: HostingOperationRow; created: boolean }> {
    const hash = hostingRequestHash(input.action, input.actorId, input.intent ?? input.request);
    return this.db.transaction(async (tx) => {
      // Same lock order as connector update/delete prevents dispatch against removed credentials.
      const [connector] = await tx
        .select()
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, input.connectorId))
        .for('update');
      if (!connector?.enabled)
        throw new AppError(409, 'HOSTING_CONNECTOR_DISABLED', 'Hosting integration is disabled or removed');
      const [existing] = await tx
        .select()
        .from(hostingOperations)
        .where(
          and(
            eq(hostingOperations.connectorId, input.connectorId),
            eq(hostingOperations.action, input.action),
            eq(hostingOperations.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (existing.requestHash !== hash || existing.actorId !== input.actorId)
          throw new AppError(
            409,
            'HOSTING_INTENT_CONFLICT',
            'This request identifier belongs to a different operation'
          );
        return { operation: existing, created: false };
      }
      const [sameIntent] = await tx
        .select()
        .from(hostingOperations)
        .where(
          and(
            eq(hostingOperations.connectorId, input.connectorId),
            eq(hostingOperations.action, input.action),
            eq(hostingOperations.requestHash, hash),
            notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES)
          )
        )
        .limit(1);
      if (sameIntent) return { operation: sameIntent, created: false };
      if (input.resourceId) {
        // Waits out a firewall synchronization in progress (the periodic observation holds the lock for seconds).
        await acquireHostingFirewallLock(tx, input.resourceId);
        const [firewall] = await tx
          .select()
          .from(hostingFirewalls)
          .where(eq(hostingFirewalls.resourceId, input.resourceId));
        // A VM being deleted does not wait for firewall changes on it: the firewall worker finds it gone.
        if (input.action !== 'delete' && (firewall?.status === 'pending' || firewall?.status === 'applying'))
          throw new AppError(
            409,
            'HOSTING_FIREWALL_BUSY',
            'Wait for firewall changes to finish before changing the VM'
          );
        const [active] = await tx
          .select()
          .from(hostingOperations)
          .where(
            and(
              eq(hostingOperations.resourceId, input.resourceId),
              notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES)
            )
          )
          .limit(1);
        if (active) throw new AppError(409, 'HOSTING_RESOURCE_BUSY', 'Another operation is unresolved for this VM');
      }
      const operationId = randomUUID();
      const initial = initialize ? await initialize(tx, operationId) : {};
      const [operation] = await tx
        .insert(hostingOperations)
        .values({
          ...initial,
          id: operationId,
          connectorId: input.connectorId,
          resourceId: input.resourceId,
          actorId: input.actorId,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          request: initial.request ?? input.request,
          phase: 'pending',
        })
        .returning();
      return { operation, created: true };
    });
  }

  async get(id: string, user: User) {
    const [row] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, id)).limit(1);
    if (!row) throw new AppError(404, 'HOSTING_OPERATION_NOT_FOUND', 'Hosting operation not found');
    if (!row.connectorId) throw new AppError(410, 'HOSTING_CONNECTOR_REMOVED', 'The hosting integration was removed');
    if (row.action === 'topup') assertHostingScope(user.scopes, 'hosting:billing:view', row.connectorId);
    else assertHostingScope(user.scopes, 'integrations:hosting:view', row.connectorId);
    if (row.actorId !== user.id) assertHostingScope(user.scopes, 'integrations:hosting:manage', row.connectorId);
    return publicHostingOperation(row);
  }

  async list(connectorId: string, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:view', connectorId);
    const rows = await this.db
      .select()
      .from(hostingOperations)
      .where(eq(hostingOperations.connectorId, connectorId))
      .orderBy(sql`${hostingOperations.createdAt} DESC`)
      .limit(100);
    const result = [];
    for (const row of rows) {
      try {
        result.push(await this.get(row.id, user));
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
      }
    }
    return result;
  }

  async due(): Promise<HostingOperationRow[]> {
    const now = new Date();
    return this.db
      .select()
      .from(hostingOperations)
      .where(
        and(
          notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES),
          lte(hostingOperations.nextPollAt, now),
          or(isNull(hostingOperations.leaseExpiresAt), lt(hostingOperations.leaseExpiresAt, now))
        )
      )
      .orderBy(asc(hostingOperations.createdAt))
      .limit(10);
  }

  async claim(id: string): Promise<HostingOperationRow | null> {
    const now = new Date();
    const [row] = await this.db
      .update(hostingOperations)
      .set({
        leaseOwner: this.workerId,
        leaseExpiresAt: new Date(now.getTime() + HOSTING_OPERATION_LEASE_MS),
        generation: sql`${hostingOperations.generation} + 1`,
        attempts: sql`${hostingOperations.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(hostingOperations.id, id),
          notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES),
          or(isNull(hostingOperations.leaseExpiresAt), lt(hostingOperations.leaseExpiresAt, now))
        )
      )
      .returning();
    return row ?? null;
  }

  private ownership(row: HostingOperationRow) {
    return and(
      eq(hostingOperations.id, row.id),
      eq(hostingOperations.leaseOwner, this.workerId),
      eq(hostingOperations.generation, row.generation),
      notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES),
      sql`${hostingOperations.leaseExpiresAt} > now()`
    );
  }

  async update(row: HostingOperationRow, patch: OperationPatch): Promise<HostingOperationRow> {
    const [updated] = await this.db
      .update(hostingOperations)
      .set({ ...patch, updatedAt: new Date() })
      .where(this.ownership(row))
      .returning();
    if (!updated) throw new AppError(409, 'HOSTING_OPERATION_LEASE_LOST', 'Hosting operation ownership changed');
    this.publishUpdate(row, updated, patch);
    return updated;
  }
  private publishUpdate(row: HostingOperationRow, updated: HostingOperationRow, patch: OperationPatch) {
    try {
      if (
        patch.phase !== undefined &&
        updated.phase !== row.phase &&
        ['ready', 'failed', 'unknown'].includes(updated.phase) &&
        updated.action !== 'topup'
      )
        this.events.publish('hosting.operation.changed', {
          id: updated.id,
          connectorId: updated.connectorId,
          resourceId: updated.resourceId,
          nodeId: updated.nodeId,
          action: updated.action,
          phase: updated.phase,
          name: typeof updated.request.name === 'string' ? updated.request.name : undefined,
          errorCode: updated.errorCode,
          errorMessage: updated.errorMessage,
        });
    } catch {
      // Publication is post-commit; never demote a durable result because a listener failed.
    }
  }

  async renew(row: HostingOperationRow): Promise<void> {
    await this.update(row, { leaseExpiresAt: new Date(Date.now() + HOSTING_OPERATION_LEASE_MS) });
  }

  /** Write-before-dispatch. A crash after this boundary must reconcile, never repeat a paid request. */
  async dispatch(row: HostingOperationRow, phase: HostingOperationPhase): Promise<HostingOperationRow> {
    const [updated] = await this.db
      .update(hostingOperations)
      .set({
        phase,
        dispatchStartedAt: new Date(),
        result: { ...row.result, dispatchStage: phase },
        updatedAt: new Date(),
      })
      .where(and(this.ownership(row), isNull(hostingOperations.dispatchStartedAt)))
      .returning();
    if (!updated)
      throw new AppError(
        409,
        'HOSTING_DISPATCH_ALREADY_STARTED',
        'This operation must be reconciled before another dispatch'
      );
    return updated;
  }

  async release(row: HostingOperationRow, delayMs = 5000) {
    await this.db
      .update(hostingOperations)
      .set({ leaseOwner: null, leaseExpiresAt: null, nextPollAt: new Date(Date.now() + delayMs) })
      .where(
        and(
          eq(hostingOperations.id, row.id),
          eq(hostingOperations.leaseOwner, this.workerId),
          eq(hostingOperations.generation, row.generation)
        )
      );
    if (row.connectorId)
      this.events.publish('integration.connector.changed', { id: row.connectorId, provider: 'hosting' });
  }

  /** A separate irreversible boundary: an uncertain credit request is never replayed. */
  async dispatchOrderCredit(
    row: HostingOperationRow,
    connector: typeof integrationConnectors.$inferSelect,
    payment: { invoiceId: string; amount: string; currency: string }
  ): Promise<HostingOperationRow> {
    const [updated] = await this.db
      .update(hostingOperations)
      .set({
        result: { ...row.result, creditPayment: { ...payment, startedAt: new Date().toISOString() } },
        updatedAt: new Date(),
      })
      .where(
        and(
          this.ownership(row),
          eq(hostingOperations.action, 'create'),
          eq(hostingOperations.nodeId, row.nodeId!),
          eq(hostingOperations.connectorId, connector.id),
          notInArray(hostingOperations.phase, HOSTING_TERMINAL_PHASES),
          sql`${hostingOperations.result}->'creditPayment' IS NULL`,
          sql`${hostingOperations.providerOperation}->>'invoiceId' = ${payment.invoiceId}`,
          sql`${hostingOperations.bootstrapExpiresAt} > now()`,
          sql`${hostingOperations.encryptedBootstrap} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.id} = ${hostingOperations.nodeId})`,
          sql`EXISTS (SELECT 1 FROM ${integrationConnectors} WHERE ${integrationConnectors.id} = ${connector.id}
        AND ${integrationConnectors.enabled} = true AND date_trunc('milliseconds', ${integrationConnectors.updatedAt}) = ${connector.updatedAt})`
        )
      )
      .returning();
    if (!updated)
      throw new AppError(
        409,
        'HOSTING_CREDIT_DISPATCH_BLOCKED',
        'Order changed or credit payment was already attempted; no repeated payment was sent'
      );
    return updated;
  }

  async finish(
    row: HostingOperationRow,
    phase: 'ready' | 'failed',
    result?: Record<string, unknown>,
    error?: { code: string; message: string },
    finalize?: (tx: DrizzleTransaction, updated: HostingOperationRow) => Promise<void>
  ) {
    const patch: OperationPatch = {
      phase,
      result: result ? { ...row.result, ...result } : row.result,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      encryptedBootstrap: null,
      bootstrapExpiresAt: null,
      completedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + HOSTING_OPERATION_LEASE_MS),
    };
    if (!finalize) return this.update(row, patch);
    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(hostingOperations)
        .set({ ...patch, updatedAt: new Date() })
        .where(this.ownership(row))
        .returning();
      if (!next) throw new AppError(409, 'HOSTING_OPERATION_LEASE_LOST', 'Hosting operation ownership changed');
      await finalize(tx, next);
      return next;
    });
    this.publishUpdate(row, updated, patch);
    return updated;
  }

  /** User may request read-only reconciliation; this does not reset a write boundary. */
  async reconcileNow(id: string, user: User) {
    await this.get(id, user);
    const [row] = await this.db.select().from(hostingOperations).where(eq(hostingOperations.id, id)).limit(1);
    if (row.actorId !== user.id) assertHostingScope(user.scopes, 'integrations:hosting:manage', row.connectorId!);
    if (!HOSTING_TERMINAL_PHASES.includes(row.phase)) {
      await this.db.update(hostingOperations).set({ nextPollAt: new Date() }).where(eq(hostingOperations.id, id));
    }
    return this.get(id, user);
  }
}
