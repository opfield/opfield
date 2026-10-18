import { inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  notificationAlertRuleFolders,
  notificationAlertRules,
  notificationWebhookFolders,
  notificationWebhooks,
} from '@/db/schema/index.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  MoveResourcesToFolderInput,
  ReorderResourcesInput,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

/** Folders of the alert rule list. Built-in rules stay in the read-only built-in group and never move. */
export class NotificationAlertRuleFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: notificationAlertRuleFolders,
      resourceTable: notificationAlertRules,
      resourceName: 'notification_alert_rule',
      resourcePlural: 'notification_alert_rules',
      auditResourceType: 'notification_alert_rule_folder',
      eventName: 'notification.alert-rule.folder.changed',
    });
  }

  /** Creating in a folder needs notifications:alerts:manage there (broadly or as a folder grant), like a move. */
  async assertCreateFolder(scopes: readonly string[], folderId: string | null | undefined) {
    if (!hasScopeForCreation(scopes, 'notifications:alerts:manage', folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing notifications:alerts:manage for the destination folder');
    }
    await this.assertFolderExists(folderId);
  }

  override async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    await this.assertCustom(input.ids);
    return super.moveResourcesToFolder(input, userId);
  }

  override async reorderResources(input: ReorderResourcesInput) {
    await this.assertCustom(input.items.map((item) => item.id));
    return super.reorderResources(input);
  }

  private async assertCustom(ids: readonly string[]) {
    const rows = await this.database
      .select({ id: notificationAlertRules.id, isBuiltin: notificationAlertRules.isBuiltin })
      .from(notificationAlertRules)
      .where(inArray(notificationAlertRules.id, [...ids]));
    if (rows.length !== new Set(ids).size) throw new AppError(404, 'NOT_FOUND', 'Alert rule not found');
    if (rows.some((row) => row.isBuiltin)) {
      throw new AppError(400, 'BUILTIN_ALERT_RULE_FOLDER_LOCKED', 'Built-in alert rules cannot be placed in folders');
    }
  }
}

/** Folders of the notification webhook list. */
export class NotificationWebhookFolderService extends FolderedResourceService {
  constructor(database: DrizzleClient, auditService: AuditService) {
    super(database, auditService, {
      folderTable: notificationWebhookFolders,
      resourceTable: notificationWebhooks,
      resourceName: 'notification_webhook',
      resourcePlural: 'notification_webhooks',
      auditResourceType: 'notification_webhook_folder',
      eventName: 'notification.webhook.folder.changed',
    });
  }

  /** Creating in a folder needs notifications:webhooks:manage there (broadly or as a folder grant), like a move. */
  async assertCreateFolder(scopes: readonly string[], folderId: string | null | undefined) {
    if (!hasScopeForCreation(scopes, 'notifications:webhooks:manage', folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing notifications:webhooks:manage for the destination folder');
    }
    await this.assertFolderExists(folderId);
  }
}
