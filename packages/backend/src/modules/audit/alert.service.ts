import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { alerts } from '@/db/schema/index.js';

@injectable()
export class AlertService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  async getAlerts(dismissed = false) {
    return this.db.query.alerts.findMany({
      where: eq(alerts.dismissed, dismissed),
      orderBy: (alerts, { desc }) => [desc(alerts.createdAt)],
    });
  }

  async dismissAlert(alertId: string): Promise<void> {
    await this.db.update(alerts).set({ dismissed: true }).where(eq(alerts.id, alertId));
  }

  async createAlert(data: {
    type: 'expiry_warning' | 'expiry_critical' | 'ca_expiry' | 'revocation';
    resourceType: string;
    resourceId: string;
    message: string;
  }): Promise<void> {
    // One open alert per resource and kind: a check that fails every day refreshes it instead of adding a row a day.
    const refreshed = await this.db
      .update(alerts)
      .set({ message: data.message, createdAt: new Date() })
      .where(
        and(
          eq(alerts.type, data.type),
          eq(alerts.resourceType, data.resourceType),
          eq(alerts.resourceId, data.resourceId),
          eq(alerts.dismissed, false)
        )
      )
      .returning({ id: alerts.id });
    if (refreshed.length > 0) return;
    await this.db.insert(alerts).values(data);
  }
}
