import type { DrizzleClient } from '@/db/client.js';
import { accessListFolders, accessLists } from '@/db/schema/index.js';
import { hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

/** Folders of the access list list. */
export class AccessListFolderService extends FolderedResourceService {
  constructor(database: DrizzleClient, auditService: AuditService) {
    super(database, auditService, {
      folderTable: accessListFolders,
      resourceTable: accessLists,
      resourceName: 'access_list',
      resourcePlural: 'access_lists',
      auditResourceType: 'access_list_folder',
      eventName: 'access-list.folder.changed',
    });
  }

  /** Creating needs acl:create broadly or on the destination folder (a folder grant covers its subfolders). */
  async assertCreateFolder(scopes: readonly string[], folderId: string | null | undefined) {
    if (!hasScopeForCreation(scopes, 'acl:create', folderId)) {
      throw new AppError(403, 'FORBIDDEN', 'Missing acl:create for the destination folder');
    }
    await this.assertFolderExists(folderId);
  }
}
