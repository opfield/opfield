import { createHash, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { accessServiceTokens } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { scheduleAccessPolicySync } from './access-policy-sync.js';
import type { CreateAccessServiceTokenInput, UpdateAccessServiceTokenInput } from './access-signin.schemas.js';

type ServiceTokenRow = typeof accessServiceTokens.$inferSelect;

function toView(row: ServiceTokenRow) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    expiresAt: row.expiresAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Credentials scripts send instead of signing in (Opfield-Access-Client-Id and -Secret). Only the SHA-256 of the
 * secret is kept; the secret is returned once, on create. An access list lets a token in through an Include
 * service_token rule naming its id.
 */
export class AccessServiceTokenService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService?: Pick<AuditService, 'log'>
  ) {}

  async list() {
    const rows = await this.db.select().from(accessServiceTokens).orderBy(asc(accessServiceTokens.name));
    return rows.map(toView);
  }

  async get(id: string) {
    return toView(await this.require(id));
  }

  async create(input: CreateAccessServiceTokenInput, userId: string | null) {
    const clientId = `${randomBytes(16).toString('hex')}.access`;
    const clientSecret = randomBytes(32).toString('hex');
    const [row] = await this.db
      .insert(accessServiceTokens)
      .values({
        name: input.name,
        clientId,
        secretSha256: createHash('sha256').update(clientSecret).digest('hex'),
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: userId,
      })
      .returning();
    scheduleAccessPolicySync();
    await this.auditService?.log({
      userId,
      action: 'access_service_token.create',
      resourceType: 'access_service_token',
      resourceId: row.id,
      details: { name: row.name, clientId, expiresAt: row.expiresAt },
    });
    return { ...toView(row), clientSecret };
  }

  async update(id: string, input: UpdateAccessServiceTokenInput, userId: string | null) {
    await this.require(id);
    const [row] = await this.db
      .update(accessServiceTokens)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }),
      })
      .where(eq(accessServiceTokens.id, id))
      .returning();
    if (input.expiresAt !== undefined) scheduleAccessPolicySync();
    await this.auditService?.log({
      userId,
      action: 'access_service_token.update',
      resourceType: 'access_service_token',
      resourceId: id,
      details: { name: row.name, expiresAt: row.expiresAt },
    });
    return toView(row);
  }

  async delete(id: string, userId: string | null): Promise<void> {
    const existing = await this.require(id);
    await this.db.delete(accessServiceTokens).where(eq(accessServiceTokens.id, id));
    scheduleAccessPolicySync();
    await this.auditService?.log({
      userId,
      action: 'access_service_token.delete',
      resourceType: 'access_service_token',
      resourceId: id,
      details: { name: existing.name, clientId: existing.clientId },
    });
  }

  private async require(id: string): Promise<ServiceTokenRow> {
    const [row] = await this.db.select().from(accessServiceTokens).where(eq(accessServiceTokens.id, id)).limit(1);
    if (!row) throw new AppError(404, 'ACCESS_SERVICE_TOKEN_NOT_FOUND', 'Service token not found');
    return row;
  }
}
