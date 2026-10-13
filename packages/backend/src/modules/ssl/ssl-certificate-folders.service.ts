import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { sslCertificateFolders, sslCertificates } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type {
  MoveResourceFolderInput,
  MoveResourcesToFolderInput,
  ReorderResourcesInput,
} from '@/modules/resource-folders/resource-folder.schemas.js';
import { FolderedResourceService, type FolderMoveAccess } from '@/modules/resource-folders/resource-folder.service.js';
import type { FolderManageAccess } from '@/modules/resource-folders/resource-folder-access.js';

export class SSLCertificateFolderService extends FolderedResourceService {
  constructor(
    private readonly database: DrizzleClient,
    auditService: AuditService
  ) {
    super(database, auditService, {
      folderTable: sslCertificateFolders,
      resourceTable: sslCertificates,
      resourceName: 'SSL certificate',
      resourcePlural: 'SSL certificates',
      auditResourceType: 'ssl_certificate_folder',
      auditMovedResourceType: 'ssl_certificate',
      eventName: 'ssl.cert.folder.changed',
    });
  }

  override async moveResourcesToFolder(input: MoveResourcesToFolderInput, userId: string) {
    await this.assertCertificatesMovable(input.ids);
    return super.moveResourcesToFolder(input, userId);
  }

  override async reorderResources(input: ReorderResourcesInput) {
    await this.assertCertificatesMovable(input.items.map((item) => item.id));
    return super.reorderResources(input);
  }

  override async moveFolder(
    id: string,
    input: MoveResourceFolderInput,
    userId: string,
    access: FolderMoveAccess | null,
    manage?: FolderManageAccess
  ) {
    await this.assertFolderTreeMovable(id);
    return super.moveFolder(id, input, userId, access, manage);
  }

  override async deleteFolder(id: string, userId: string) {
    await this.assertFolderTreeMovable(id);
    return super.deleteFolder(id, userId);
  }

  private async assertCertificatesMovable(ids: string[]) {
    const [systemCertificate] = await this.database
      .select({ id: sslCertificates.id })
      .from(sslCertificates)
      .where(and(inArray(sslCertificates.id, ids), eq(sslCertificates.isSystem, true)))
      .limit(1);
    if (systemCertificate) {
      throw new AppError(409, 'SSL_SYSTEM_CERT_FOLDER_LOCKED', 'System certificate placement cannot be changed');
    }
  }

  private async assertFolderTreeMovable(folderId: string) {
    const tree = await this.getFolderTree({ includeAllFolders: true });
    const flattenSubtree = (node: (typeof tree)[number]): string[] => [
      node.id,
      ...node.children.flatMap(flattenSubtree),
    ];
    const findFolderIds = (nodes: typeof tree): string[] => {
      for (const node of nodes) {
        if (node.id === folderId) return flattenSubtree(node);
        const nested = findFolderIds(node.children);
        if (nested.length > 0) return nested;
      }
      return [];
    };
    const folderIds = findFolderIds(tree);
    if (folderIds.length === 0) return;
    const [systemCertificate] = await this.database
      .select({ id: sslCertificates.id })
      .from(sslCertificates)
      .where(and(inArray(sslCertificates.folderId, folderIds), eq(sslCertificates.isSystem, true)))
      .limit(1);
    if (systemCertificate) {
      throw new AppError(
        409,
        'SSL_SYSTEM_CERT_FOLDER_LOCKED',
        'Folders containing system certificates cannot be moved or deleted'
      );
    }
  }
}
