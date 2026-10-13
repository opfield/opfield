import type { DrizzleClient } from '@/db/client.js';
import { appFolders, apps } from '@/db/schema/index.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

/** Realtime channel of the Apps list folder tree. */
export const APP_FOLDER_EVENT_CHANNEL = 'apps.folder.changed';

/**
 * Folders of the Apps list: they hold apps, like route or database folders hold theirs. Not the hidden folders an
 * app keeps its members in (AppFolderService).
 */
export class AppListFolderService extends FolderedResourceService {
  constructor(db: DrizzleClient, auditService: AuditService) {
    super(db, auditService, {
      folderTable: appFolders,
      resourceTable: apps,
      resourceName: 'app',
      resourcePlural: 'apps',
      auditResourceType: 'app_folder',
      eventName: APP_FOLDER_EVENT_CHANNEL,
    });
  }
}
