import type { DrizzleClient } from '@/db/client.js';
import { loggingEnvironmentFolders, loggingEnvironments } from '@/db/schema/index.js';
import { assertAppDestination } from '@/modules/apps/app-placement-guard.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { FolderedResourceService } from '@/modules/resource-folders/resource-folder.service.js';

export class LoggingEnvironmentFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: loggingEnvironmentFolders,
      resourceTable: loggingEnvironments,
      resourceName: 'logging_environment',
      resourcePlural: 'logging_environments',
      auditResourceType: 'logging_environment_folder',
      eventName: 'logging.environment.changed',
    });
  }

  /** A create into an app environment folder is refused while the environment is isolated by the kill switch. */
  override async assertFolderExists(id: string | null | undefined): Promise<void> {
    await super.assertFolderExists(id);
    await assertAppDestination(this.database, 'logging', id);
  }
}
