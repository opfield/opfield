import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { getConsoleBaseOrigin } from '@/lib/console-base-host.js';
import {
  type PublicAliasView,
  publicAliasView,
  type StoredPublicAlias,
} from '@/services/console-tls/console-tls-alias.js';
import { isCloudManaged } from './cloud-link-managed-locks.js';
import { CLOUD_ADDON_SETTING_KEYS, readCloudSetting } from './cloud-link-settings.js';

/** The custom domain as Settings shows it (read-only): what the account set, and the console domain that stays. */
export interface CloudPublicAliasSettingsView extends PublicAliasView {
  /** `https://<console domain>`; keeps working next to the custom domain. */
  baseUrl: string | null;
}

/** Managed installations only; null elsewhere or when it cannot be read. */
export async function readCloudPublicAlias(): Promise<CloudPublicAliasSettingsView | null> {
  try {
    if (!(await isCloudManaged())) return null;
    const db = container.resolve<DrizzleClient>(TOKENS.DrizzleClient);
    const stored = await readCloudSetting<StoredPublicAlias>(db, CLOUD_ADDON_SETTING_KEYS.publicAlias);
    return { ...publicAliasView(stored), baseUrl: getConsoleBaseOrigin() };
  } catch {
    return null;
  }
}
