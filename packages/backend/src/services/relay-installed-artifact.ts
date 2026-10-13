import { eq } from 'drizzle-orm';
import type { Env } from '@/config/env.js';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/settings.js';
import { compareSemver, parseSemver } from '@/lib/semver.js';

const INSTALLED_RELAY_ARTIFACT_KEY = 'update:relay:installed_artifact';
const DIGEST_IMAGE_REF = /@sha256:[a-f0-9]{64}$/;

export interface InstalledRelayArtifact {
  imageRef: string;
  buildVersion: string;
  protocolMajor: number;
  secureLinkConnectorImage: string;
}

export function parseInstalledRelayArtifact(value: unknown): InstalledRelayArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InstalledRelayArtifact>;
  if (
    typeof candidate.imageRef !== 'string' ||
    !DIGEST_IMAGE_REF.test(candidate.imageRef) ||
    typeof candidate.buildVersion !== 'string' ||
    !parseSemver(candidate.buildVersion) ||
    typeof candidate.protocolMajor !== 'number' ||
    !Number.isInteger(candidate.protocolMajor) ||
    candidate.protocolMajor < 1 ||
    typeof candidate.secureLinkConnectorImage !== 'string' ||
    !DIGEST_IMAGE_REF.test(candidate.secureLinkConnectorImage)
  ) {
    return null;
  }
  return candidate as InstalledRelayArtifact;
}

export function applyNewerInstalledRelayArtifact(env: Env, installed: InstalledRelayArtifact | null): boolean {
  if (!installed) return false;
  const configuredVersion = env.OPFIELD_RELAY_BUILD_VERSION;
  if (
    configuredVersion &&
    configuredVersion !== 'dev' &&
    parseSemver(configuredVersion) &&
    compareSemver(installed.buildVersion, configuredVersion) <= 0
  ) {
    return false;
  }
  Object.assign(env, {
    OPFIELD_RELAY_IMAGE_REF: installed.imageRef,
    OPFIELD_RELAY_BUILD_VERSION: installed.buildVersion,
    OPFIELD_RELAY_PROTOCOL_MAJOR: installed.protocolMajor,
    SECURE_LINK_CONNECTOR_IMAGE: installed.secureLinkConnectorImage,
  });
  return true;
}

export async function loadInstalledRelayArtifact(db: DrizzleClient): Promise<InstalledRelayArtifact | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INSTALLED_RELAY_ARTIFACT_KEY))
    .limit(1);
  return parseInstalledRelayArtifact(row?.value);
}

export async function saveInstalledRelayArtifact(db: DrizzleClient, artifact: InstalledRelayArtifact): Promise<void> {
  const parsed = parseInstalledRelayArtifact(artifact);
  if (!parsed) throw new Error('Installed Relay artifact is invalid');
  await db
    .insert(settings)
    .values({ key: INSTALLED_RELAY_ARTIFACT_KEY, value: parsed, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: parsed, updatedAt: new Date() },
    });
}
