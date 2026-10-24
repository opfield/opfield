import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { entitlementsIncludeFeature } from '@/modules/license/license-features.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';

/**
 * GET /system/config, also get_opfield_runtime config: upload limits and the effective feature switches (a plan
 * without a feature reports it off) for any signed-in caller; node and relay addresses need settings:opfield:view.
 */
export async function readSystemConfigView(scopes: string[]) {
  const service = container.resolve(GeneralSettingsService);
  const loggingFeature = container.resolve(LoggingFeatureService);
  const [config, license] = await Promise.all([
    service.getConfig(),
    container.resolve(LicensePolicyService).getSummary(),
  ]);
  const canViewOpfieldSettings = hasScope(scopes, 'settings:opfield:view');
  return {
    fileUploadMaxBytes: config.fileUploadMaxBytes,
    fileOpenMaxBytes: config.fileOpenMaxBytes,
    grpcPublicTarget: canViewOpfieldSettings ? config.grpcPublicTarget : null,
    grpcLocalIp: canViewOpfieldSettings ? config.grpcLocalIp : null,
    relayAutoRecovery: canViewOpfieldSettings ? config.relayAutoRecovery : false,
    ...(canViewOpfieldSettings ? { relay: config.relay } : {}),
    features: {
      ...config.features,
      // The switches default to on; a plan without the feature reports them off.
      pkiEnabled:
        config.features.pkiEnabled && entitlementsIncludeFeature(license.entitlements.features, 'internal-pki'),
      siemEnabled:
        config.features.siemEnabled && entitlementsIncludeFeature(license.entitlements.features, 'siem-export'),
      loggingEnabled: loggingFeature.isEnabled(),
    },
  };
}
