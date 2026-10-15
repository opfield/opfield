import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';

/** Settings keys of what the cloud account sets on a managed installation over the link (its add-ons). */
export const CLOUD_ADDON_SETTING_KEYS = {
  publicAlias: 'cloud:public-alias',
  mail: 'cloud:mail',
  inference: 'cloud:inference',
} as const;

export async function readCloudSetting<T>(db: DrizzleClient, key: string): Promise<T | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function writeCloudSetting(db: DrizzleClient, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteCloudSetting(db: DrizzleClient, key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}
