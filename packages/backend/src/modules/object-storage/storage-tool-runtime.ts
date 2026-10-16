import { container } from '@/container.js';
import { hasScope, hasScopeBase, hasScopeForCreation } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { directResourceIdsForScopes } from '@/modules/ai/ai.service-helpers.js';
import {
  ManagedAvailabilityAddMemberSchema,
  ManagedAvailabilityDisableSchema,
  ManagedAvailabilityEnableSchema,
  ManagedAvailabilityEventsQuerySchema,
  ManagedAvailabilityMakePrimarySchema,
  ManagedAvailabilityMemberOrderSchema,
  ManagedAvailabilityPreflightSchema,
  ManagedAvailabilitySettingsSchema,
} from '@/modules/databases/databases.schemas.js';
import { decodeComposeServiceTarget } from '@/modules/docker/compose/compose-managed-bindings.js';
import { assertDockerResourceScope } from '@/modules/docker/docker-access.middleware.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import { resolveBindingTargetContainerIdentity } from '@/modules/docker/docker-binding-target-identity.js';
import { BucketQuerySchema } from '@/modules/object-storage/object-storage.docs.js';
import {
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
} from '@/modules/object-storage/object-storage.schemas.js';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { ObjectStorageFolderService } from '@/modules/object-storage/object-storage-folders.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import {
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ImportManagedStorageAccessKeysSchema,
  ManagedStorageAvailabilityCreatePreflightSchema,
  ManagedStorageListQuerySchema,
  MoveManagedStorageBindingSchema,
  RehomeManagedStorageBackupHistorySchema,
  UpdateManagedStorageSchema,
} from '@/modules/storage/managed-storage.schemas.js';
import { ManagedStorageService } from '@/modules/storage/managed-storage.service.js';
import { ManagedStorageBindingsService } from '@/modules/storage/managed-storage-bindings.service.js';
import {
  StartStorageCopyJobSchema,
  StorageCopyJobIdSchema,
  StorageCopyJobListQuerySchema,
} from '@/modules/storage/storage-copy.schemas.js';
import { StorageCopyService } from '@/modules/storage/storage-copy.service.js';
export const storageToolRuntime = {
  container,
  hasScope,
  hasScopeBase,
  hasScopeForCreation,
  AppError,
  hasDockerResourceScope,
  BucketQuerySchema,
  CreateBucketSchema,
  CreateObjectStorageConnectionSchema,
  CreatePrefixSchema,
  DeleteObjectsSchema,
  ListObjectsQuerySchema,
  ObjectMetadataQuerySchema,
  ObjectStorageListQuerySchema,
  PresignObjectSchema,
  UpdateObjectStorageConnectionSchema,
  ObjectStorageService,
  ObjectStorageUploadService,
  ObjectStorageFolderService,
  ObjectStorageMonitoringService,
  CreateManagedStorageAccessKeySchema,
  CreateManagedStorageBindingSchema,
  CreateManagedStorageSchema,
  DeleteManagedStorageBindingSchema,
  ManagedStorageListQuerySchema,
  UpdateManagedStorageSchema,
  ManagedStorageService,
  ManagedStorageBindingsService,
  directResourceIdsForScopes,
  // The workload check of links, which the commercial module runs (binding-target-access.ts there).
  decodeComposeServiceTarget,
  assertDockerResourceScope,
  resolveBindingTargetContainerIdentity,
  MoveManagedStorageBindingSchema,
  ImportManagedStorageAccessKeysSchema,
  RehomeManagedStorageBackupHistorySchema,
  StorageCopyService,
  StartStorageCopyJobSchema,
  StorageCopyJobIdSchema,
  StorageCopyJobListQuerySchema,
  // Availability of managed storage (storage on several servers).
  ManagedStorageAvailabilityCreatePreflightSchema,
  ManagedAvailabilityAddMemberSchema,
  ManagedAvailabilityDisableSchema,
  ManagedAvailabilityEnableSchema,
  ManagedAvailabilityEventsQuerySchema,
  ManagedAvailabilityMakePrimarySchema,
  ManagedAvailabilityMemberOrderSchema,
  ManagedAvailabilityPreflightSchema,
  ManagedAvailabilitySettingsSchema,
};
