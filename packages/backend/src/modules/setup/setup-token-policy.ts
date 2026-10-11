import { count, eq, inArray, isNull, not, or } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor, DrizzleTransaction } from '@/db/client.js';
import { settings, users } from '@/db/schema/index.js';

const GATEWAY_SYSTEM_OIDC_SUBJECT = 'system:gateway-setup';
const SETUP_COMPLETED_AT_KEY = 'setup:completed_at';
const SETUP_FORCED_OPEN_KEY = 'setup:forced_open';

function isForcedOpenValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

export class SetupTokenPolicyService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly installerBootstrapEnabled = false
  ) {}

  async isGatewayConfigured(executor: DrizzleExecutor = this.db): Promise<boolean> {
    const [{ count: userCount }] = await executor
      .select({ count: count() })
      .from(users)
      .where(or(isNull(users.oidcSubject), not(eq(users.oidcSubject, GATEWAY_SYSTEM_OIDC_SUBJECT))));

    return Number(userCount) > 0;
  }

  async isSetupApiEnabled(): Promise<boolean> {
    return !(await this.isSetupComplete());
  }

  async ensureSetupStarted(): Promise<void> {
    if (await this.isForcedOpen()) return;
    if (await this.getTimestampSetting(SETUP_COMPLETED_AT_KEY)) return;

    if (await this.isGatewayConfigured()) {
      await this.markSetupComplete();
      return;
    }

    // Only an explicit fresh-install bootstrap may expose the wizard on an
    // empty database. This keeps legacy/manual deployments from reopening
    // setup merely because their user table happens to be empty.
    if (this.installerBootstrapEnabled) {
      await this.upsertSetting(SETUP_FORCED_OPEN_KEY, 'true');
      return;
    }
    await this.markSetupComplete();
  }

  /** Read on every request (host and setup guards): both markers in one query. */
  async isSetupComplete(): Promise<boolean> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [SETUP_FORCED_OPEN_KEY, SETUP_COMPLETED_AT_KEY]));
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    if (isForcedOpenValue(value(SETUP_FORCED_OPEN_KEY))) return false;
    return Boolean(parseTimestamp(value(SETUP_COMPLETED_AT_KEY)));
  }

  async markSetupComplete(): Promise<void> {
    await this.db.transaction((tx) => this.markSetupCompleteIn(tx));
  }

  /** Marks setup complete in the caller's transaction (with the administrator it creates, all or nothing). */
  async markSetupCompleteIn(tx: DrizzleTransaction): Promise<void> {
    const completedAt = new Date().toISOString();
    await tx
      .insert(settings)
      .values({ key: SETUP_COMPLETED_AT_KEY, value: completedAt, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: completedAt, updatedAt: new Date() },
      });
    await tx.delete(settings).where(eq(settings.key, SETUP_FORCED_OPEN_KEY));
  }

  async reopenSetup(): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, SETUP_COMPLETED_AT_KEY));
    await this.upsertSetting(SETUP_FORCED_OPEN_KEY, 'true');
  }

  private async isForcedOpen(): Promise<boolean> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETUP_FORCED_OPEN_KEY))
      .limit(1);
    return isForcedOpenValue(row?.value);
  }

  private async getTimestampSetting(key: string): Promise<Date | null> {
    const [row] = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return parseTimestamp(row?.value);
  }

  private async upsertSetting(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}
