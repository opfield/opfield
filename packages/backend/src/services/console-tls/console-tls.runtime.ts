import { join } from 'node:path';
import type { DependencyContainer } from 'tsyringe';
import type { Env } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { setConsoleBaseHost } from '@/lib/console-base-host.js';
import { createChildLogger } from '@/lib/logger.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import {
  CLOUD_ADDON_SETTING_KEYS,
  readCloudSetting,
  writeCloudSetting,
} from '@/modules/cloud-link/cloud-link-settings.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { ACMEService } from '@/modules/ssl/acme.service.js';
import { OpfieldIdentityRenewalService } from '@/services/opfield-identity-renewal.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import { ConsoleTlsService, readFallbackMaterial } from './console-tls.service.js';
import type { StoredPublicAlias } from './console-tls-alias.js';
import { isValidConsoleDomain, resolveDirectoryOverride } from './console-tls-policy.js';

const logger = createChildLogger('ConsoleTLS');

/** Alerts need a resource id; the console certificate is a single, fixed resource. */
export const CONSOLE_CERTIFICATE_RESOURCE_ID = '00000000-0000-4000-8000-00000000c0de';
/** The same for the certificate of the custom domain (cloud link public-alias). */
export const CONSOLE_ALIAS_CERTIFICATE_RESOURCE_ID = '00000000-0000-4000-8000-00000000c0df';

/**
 * The console TLS service when OPFIELD_CONSOLE_DOMAIN is set, null otherwise (an installation without it keeps only
 * its PORT listener). A configuration it cannot use is logged and leaves the console on PORT; the app still starts.
 */
export function createConsoleTlsService(env: Env, container: DependencyContainer): ConsoleTlsService | null {
  const domain = env.OPFIELD_CONSOLE_DOMAIN?.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return null;
  if (!isValidConsoleDomain(domain)) {
    logger.error('OPFIELD_CONSOLE_DOMAIN is not a DNS name; the console stays on its port only', { domain });
    return null;
  }
  const email = env.OPFIELD_ACME_EMAIL?.trim();
  if (!email) {
    logger.error('OPFIELD_ACME_EMAIL is required with OPFIELD_CONSOLE_DOMAIN; the console stays on its port only');
    return null;
  }
  let directory: ReturnType<typeof resolveDirectoryOverride>;
  try {
    directory = resolveDirectoryOverride(env.OPFIELD_ACME_DIRECTORY_URL);
  } catch (error) {
    logger.error('OPFIELD_ACME_DIRECTORY_URL is invalid; the console stays on its port only', {
      error: (error as Error).message,
    });
    return null;
  }
  const webIdentity = container.resolve(WebIdentityService);
  const generalSettings = container.resolve(GeneralSettingsService);
  const alerts = container.resolve(AlertService);
  const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
  // The console domain always serves: browsers on it are an allowed origin next to the public URL.
  setConsoleBaseHost(domain);
  return new ConsoleTlsService({
    domain,
    email,
    staging: directory.staging,
    stateDir: join(env.WEB_TLS_AUTO_DIR, 'console-acme'),
    httpsPort: env.OPFIELD_CONSOLE_HTTPS_PORT,
    httpPort: env.OPFIELD_CONSOLE_HTTP_PORT,
    bindHost: env.BIND_HOST,
    acme: new ACMEService({ directoryUrl: directory.directoryUrl }),
    fallback: () =>
      readFallbackMaterial(
        () => webIdentity.resolve(),
        () => webIdentity.refresh()
      ),
    publicUrl: {
      get: () => generalSettings.getPublicUrl(),
      set: async (url) => {
        await generalSettings.updateConfig({ publicUrl: url });
      },
    },
    alert: (level, message) =>
      alerts.createAlert({
        type: level === 'critical' ? 'expiry_critical' : 'expiry_warning',
        resourceType: 'console_certificate',
        resourceId: CONSOLE_CERTIFICATE_RESOURCE_ID,
        message,
      }),
    alias: {
      store: {
        get: () => readCloudSetting<StoredPublicAlias>(db, CLOUD_ADDON_SETTING_KEYS.publicAlias),
        set: (value) => writeCloudSetting(db, CLOUD_ADDON_SETTING_KEYS.publicAlias, value),
      },
      // The system path, as the managed set-up writes the public URL: the gRPC and web identities follow it.
      publicUrl: {
        get: () => generalSettings.getPublicUrl(),
        set: async (url) => {
          await generalSettings.updateConfig({ publicUrl: url });
          await container.resolve(OpfieldIdentityRenewalService).refreshGrpcIdentity();
          if ((await container.resolve(WebTransportSettingsService).getConfig()).tlsEnabled) {
            await container.resolve(WebIdentityService).refresh();
          }
        },
      },
      alert: (level, message) =>
        alerts.createAlert({
          type: level === 'critical' ? 'expiry_critical' : 'expiry_warning',
          resourceType: 'console_certificate',
          resourceId: CONSOLE_ALIAS_CERTIFICATE_RESOURCE_ID,
          message,
        }),
    },
  });
}
