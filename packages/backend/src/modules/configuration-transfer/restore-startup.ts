import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService, GeneralSettingsUpdate } from '@/modules/settings/general-settings.service.js';
import { RESTORED_MARKER_FILE, type RestoredMarker } from './configuration-restore.js';
import { RESTORE_STAGING_DIR } from './transfer-layout.js';

const logger = createChildLogger('ConfigurationRestore');

/**
 * The first start after a restore: applies the address entered for the new host (before the gRPC
 * and web listener certificates are checked, so they are reissued for it), records the restore in
 * the audit log and removes what the restore left in gateway_data.
 */
export async function completeConfigurationRestore(
  generalSettings: Pick<GeneralSettingsService, 'updateConfig'>,
  audit: Pick<AuditService, 'log'>,
  dataDir = '/var/lib/gateway'
): Promise<RestoredMarker | null> {
  const stagingDir = join(dataDir, RESTORE_STAGING_DIR);
  let marker: RestoredMarker;
  try {
    marker = JSON.parse(await readFile(join(stagingDir, RESTORED_MARKER_FILE), 'utf8')) as RestoredMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.error('The configuration restore record is unreadable; it is removed', { error });
    await rm(join(stagingDir, RESTORED_MARKER_FILE), { force: true });
    return null;
  }
  const updates: GeneralSettingsUpdate = {};
  if (marker.address?.publicUrl) updates.publicUrl = marker.address.publicUrl;
  if (marker.address?.grpcPublicTarget) updates.gatewayGrpcPublicTarget = marker.address.grpcPublicTarget;
  if (marker.address && 'grpcLocalIp' in marker.address)
    updates.gatewayGrpcLocalIp = marker.address.grpcLocalIp ?? null;
  if (Object.keys(updates).length > 0) {
    await generalSettings.updateConfig(updates);
    logger.info('Applied the address entered for the restored installation', { ...updates });
  }
  await audit
    .log({
      userId: null,
      action: 'system.configuration_restored',
      resourceType: 'system',
      details: {
        exportCreatedAt: marker.exportCreatedAt,
        restoredAt: marker.restoredAt,
        gatewayVersion: marker.gatewayVersion,
        sourcePublicUrl: marker.sourcePublicUrl,
        sourceGrpcPublicTarget: marker.sourceGrpcPublicTarget,
        includes: marker.includes,
        address: updates,
      },
    })
    .catch((error) => logger.warn('Could not audit the configuration restore', { error }));
  await rm(stagingDir, { recursive: true, force: true });
  return marker;
}
