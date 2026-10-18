import 'reflect-metadata';
// The schema barrel first: loading the folder services alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { DatabaseFolderService } from '@/modules/databases/database-folders.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingEnvironmentFolderService } from '@/modules/logging/logging-environment-folders.service.js';
import { LoggingSchemaFolderService } from '@/modules/logging/logging-schema-folders.service.js';
import {
  NotificationAlertRuleFolderService,
  NotificationWebhookFolderService,
} from '@/modules/notifications/notification-folders.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { PageProjectFolderService } from '@/modules/pages/page-project-folder.service.js';
import { PageProfileService } from '@/modules/pages/profile/page-profile.service.js';
import type { User } from '@/types.js';
import { executeFolderTool } from './ai.folder-tools.js';

const TEAM = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PARENTS: Record<string, string | null> = { [TEAM]: null, [SUB]: TEAM, [OTHER]: null };

const FAMILIES = [
  { resourceType: 'databases', manageScope: 'databases:folders:manage', service: DatabaseFolderService },
  { resourceType: 'storage', manageScope: 'storage:folders:manage', service: ObjectStorageFolderService },
  { resourceType: 'pages', manageScope: 'pages:folders:manage', service: PageProjectFolderService },
  {
    resourceType: 'logging_environments',
    manageScope: 'logs:environments:folders:manage',
    service: LoggingEnvironmentFolderService,
  },
  { resourceType: 'logging_schemas', manageScope: 'logs:schemas:folders:manage', service: LoggingSchemaFolderService },
  {
    resourceType: 'notification_alert_rules',
    manageScope: 'notifications:alerts:folders:manage',
    service: NotificationAlertRuleFolderService,
  },
  {
    resourceType: 'notification_webhooks',
    manageScope: 'notifications:webhooks:folders:manage',
    service: NotificationWebhookFolderService,
  },
] as const;

function setup(family: (typeof FAMILIES)[number]) {
  const service = {
    createFolder: vi.fn().mockResolvedValue({ id: SUB }),
    updateFolder: vi.fn().mockResolvedValue({ id: SUB }),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    moveFolder: vi.fn().mockResolvedValue({ id: SUB }),
    reorderFolders: vi.fn().mockResolvedValue(undefined),
    getFolderParentIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, PARENTS[id] ?? null]))),
  };
  container.registerInstance(family.service as never, service);
  container.registerInstance(LicensePolicyService, {
    requireFeature: vi.fn().mockResolvedValue(undefined),
    requireFeatureForExistingRuntime: vi.fn().mockResolvedValue(undefined),
  } as never);
  container.registerInstance(PageProfileService, { requireEnabled: vi.fn().mockResolvedValue(undefined) } as never);
  // A grant on TEAM as folder-scopes.ts expands it: TEAM and its subfolder SUB.
  const scopes = [`${family.manageScope}:folder/${TEAM}`, `${family.manageScope}:folder/${SUB}`];
  const user = { id: 'user-1', scopes } as unknown as User;
  const run = (args: Record<string, unknown>) =>
    executeFolderTool(user, 'manage_resource_folder', { resourceType: family.resourceType, ...args });
  return { service, scopes, run };
}

afterEach(() => {
  container.reset();
});

describe.each(FAMILIES)('manage_resource_folder for $resourceType with folder-limited management', (family) => {
  it('creates, renames, reorders and deletes only inside the granted folder', async () => {
    const { service, run } = setup(family);

    await expect(run({ operation: 'create', name: 'Edge', parentId: TEAM })).resolves.toEqual({ id: SUB });
    await expect(run({ operation: 'create', name: 'Edge' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(run({ operation: 'create', name: 'Edge', parentId: OTHER })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(service.createFolder).toHaveBeenCalledTimes(1);

    await expect(run({ operation: 'update', folderId: SUB, name: 'Renamed' })).resolves.toEqual({ id: SUB });
    await expect(run({ operation: 'update', folderId: TEAM, name: 'Renamed' })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(run({ operation: 'delete', folderId: TEAM })).rejects.toMatchObject({ statusCode: 403 });
    expect(service.deleteFolder).not.toHaveBeenCalled();
    await expect(run({ operation: 'reorder_folders', items: [{ id: TEAM, sortOrder: 0 }] })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('hands the move check for the old and new parent to the service', async () => {
    const { service, scopes, run } = setup(family);

    await run({ operation: 'move_folder', folderId: SUB, parentId: OTHER });

    expect(service.moveFolder).toHaveBeenCalledWith(SUB, { parentId: OTHER }, 'user-1', expect.any(Object), {
      scopes,
      manageScope: family.manageScope,
    });
  });
});
