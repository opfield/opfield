import { isIP } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { settings } from '@/db/schema/index.js';
import type { InferenceCatalogEventsService } from '@/modules/inference/inference-catalog-events.service.js';
import { type LicensePolicyService, requireConfiguredLicensePolicy } from '@/modules/license/license-policy.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';

const SETTINGS_KEY = 'general:settings';
const BODY_LIMIT_OVERHEAD_RATIO = 1.5;
const BODY_LIMIT_OVERHEAD_BYTES = 4096;

export const FILE_UPLOAD_MIN_BYTES = 1 * 1024 * 1024;
export const FILE_UPLOAD_DEFAULT_BYTES = 100 * 1024 * 1024;
export const FILE_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const FILE_OPEN_MIN_BYTES = 1 * 1024 * 1024;
export const FILE_OPEN_DEFAULT_BYTES = 10 * 1024 * 1024;
export const FILE_OPEN_MAX_BYTES = 100 * 1024 * 1024;
export const RELAY_GRANT_TTL_DEFAULT_HOURS = 4;
export const RELAY_GRANT_TTL_MIN_HOURS = 1;
// Raised from 48 so a grant can still cover the longest policy lease (see
// RELAY_POLICY_LEASE_MAX_HOURS): effectiveGrantTtlHours below needs headroom up
// to ceil(leaseHours * 4 / 3). A relay that has not advertised
// policy_long_lease_v1 still only ever receives a grant capped at
// LEGACY_RELAY_GRANT_TTL_MAX_HOURS, regardless of this setting.
export const RELAY_GRANT_TTL_MAX_HOURS = 224;
/** The grant lifetime cap a relay that predates long-lease support still enforces. */
export const LEGACY_RELAY_GRANT_TTL_MAX_HOURS = 48;
export const RELAY_POLICY_LEASE_DEFAULT_HOURS = 72;
export const RELAY_POLICY_LEASE_MIN_HOURS = 1;
export const RELAY_POLICY_LEASE_MAX_HOURS = 168;
/** The policy lease a relay that predates long-lease support still enforces. */
export const LEGACY_RELAY_POLICY_LEASE_SECONDS = 15 * 60;
/**
 * Mirrors policy.LeaseExpiryClockSkew in packages/relay/internal/policy/store.go: how long past
 * its issued lease a relay whose clock runs ahead still admits. A relay that is genuinely
 * isolated cannot still be admitting past lease + this skew, so that bound is safe to treat as
 * "the relay has stopped admitting on the pre-rotation policy" when nothing else confirms it.
 */
export const RELAY_LEASE_EXPIRY_CLOCK_SKEW_MS = 2 * 60 * 1000;
/**
 * Advertised by relay builds that accept a policy lease and grant lifetime longer than the legacy
 * 15-minute lease / 48-hour grant caps (see policy.LongLeaseCapability in the relay). Gateway must
 * not issue the longer lease or grant to an instance that has not reported this, or it refuses the
 * envelope outright.
 */
export const LONG_POLICY_LEASE_CAPABILITY = 'policy_long_lease_v1';
export const RELAY_DATA_LANES_DEFAULT = 4;
export const RELAY_DATA_LANES_MIN = 1;
export const RELAY_DATA_LANES_MAX = 16;
export const RELAY_ASSIGNMENT_SPREAD_DEFAULT_COUNT = 2;
export const RELAY_ASSIGNMENT_SPREAD_MIN_COUNT = 1;
export const RELAY_ASSIGNMENT_SPREAD_MAX_COUNT = 64;
export const RELAY_READ_CHUNK_BYTES_DEFAULT = 32 * 1024;
export const RELAY_READ_CHUNK_BYTES_MIN = 4 * 1024;
export const RELAY_READ_CHUNK_BYTES_MAX = 256 * 1024;
export const RELAY_ADAPTIVE_ADMISSION_DEFAULT = true;
export const RELAY_PROXY_TARGET_PRESSURE_DEFAULT_PERCENT = 70;
export const RELAY_PROXY_TARGET_PRESSURE_MIN_PERCENT = 50;
export const RELAY_PROXY_TARGET_PRESSURE_MAX_PERCENT = 85;
export const RELAY_DATABASE_RESERVE_DEFAULT_PERCENT = 20;
export const RELAY_DATABASE_RESERVE_MIN_PERCENT = 5;
export const RELAY_DATABASE_RESERVE_MAX_PERCENT = 35;
export const RELAY_HARD_PRESSURE_DEFAULT_PERCENT = 95;
export const RELAY_HARD_PRESSURE_MIN_PERCENT = 90;
export const RELAY_HARD_PRESSURE_MAX_PERCENT = 99;
export const SHUTDOWN_USER_DRAIN_MAX_SECONDS = 40;
export const SHUTDOWN_LOG_DRAIN_MAX_SECONDS = 10;
export const SHUTDOWN_FINALIZATION_MIN_SECONDS = 5;
export const SHUTDOWN_FINALIZATION_MAX_SECONDS = 15;
export const SHUTDOWN_TOTAL_MAX_SECONDS = 50;

export interface GeneralSettings {
  publicUrl: string | null;
  updateChannel: UpdateChannel;
  hideExternalBranding: boolean;
  autoAssignCreatedResourcePermissions: boolean;
  /** Email the account invitation to every user created through the admin, API or MCP create-user path. */
  sendInvitationOnUserCreate: boolean;
  fileUploadMaxBytes: number;
  fileOpenMaxBytes: number;
  grpcPublicTarget: string | null;
  grpcLocalIp: string | null;
  relayAutoRecovery: boolean;
  relay: GeneralRelaySettings;
  shutdown: GeneralShutdownSettings;
  relayGrantTtlHours: number;
  /** Lifetime of the signed policy envelope Gateway pushes to a relay; see relayGrantTtlHours. */
  relayPolicyLeaseHours: number;
  features: GeneralFeatureSettings;
}

/**
 * The grant lifetime a relay pool member actually gets once its lease is known: long enough that
 * a grant refreshed a quarter of its life before an outage still covers the whole policy lease,
 * so a relay never runs out of grants while it is still admitting on its last known policy.
 */
export function effectiveRelayGrantTtlHours(relayGrantTtlHours: number, relayPolicyLeaseHours: number): number {
  return Math.max(relayGrantTtlHours, Math.ceil((relayPolicyLeaseHours * 4) / 3));
}

export type UpdateChannel = 'stable' | 'preview';

export interface GeneralRelaySettings {
  dataLanes: number;
  readChunkBytes: number;
  assignmentSpread: RelayAssignmentSpread;
  adaptiveAdmissionEnabled: boolean;
  proxyTargetPressurePercent: number;
  databaseReservePercent: number;
  hardPressurePercent: number;
}

export type RelayAssignmentSpread = { mode: 'fixed'; count: number } | { mode: 'all'; count?: never };

export interface GeneralShutdownSettings {
  userRequestDrainSeconds: number;
  structuredLogDrainSeconds: number;
  finalizationTimeoutSeconds: number;
}

export interface GeneralFeatureSettings {
  pkiEnabled: boolean;
  domainsEnabled: boolean;
  siemEnabled: boolean;
  inferenceEnabled: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  publicUrl: null,
  updateChannel: 'stable',
  hideExternalBranding: false,
  autoAssignCreatedResourcePermissions: true,
  sendInvitationOnUserCreate: false,
  fileUploadMaxBytes: FILE_UPLOAD_DEFAULT_BYTES,
  fileOpenMaxBytes: FILE_OPEN_DEFAULT_BYTES,
  grpcPublicTarget: null,
  grpcLocalIp: null,
  relayAutoRecovery: true,
  relay: {
    dataLanes: RELAY_DATA_LANES_DEFAULT,
    readChunkBytes: RELAY_READ_CHUNK_BYTES_DEFAULT,
    assignmentSpread: { mode: 'fixed', count: RELAY_ASSIGNMENT_SPREAD_DEFAULT_COUNT },
    adaptiveAdmissionEnabled: RELAY_ADAPTIVE_ADMISSION_DEFAULT,
    proxyTargetPressurePercent: RELAY_PROXY_TARGET_PRESSURE_DEFAULT_PERCENT,
    databaseReservePercent: RELAY_DATABASE_RESERVE_DEFAULT_PERCENT,
    hardPressurePercent: RELAY_HARD_PRESSURE_DEFAULT_PERCENT,
  },
  relayGrantTtlHours: RELAY_GRANT_TTL_DEFAULT_HOURS,
  relayPolicyLeaseHours: RELAY_POLICY_LEASE_DEFAULT_HOURS,
  shutdown: {
    userRequestDrainSeconds: 30,
    structuredLogDrainSeconds: 5,
    finalizationTimeoutSeconds: 10,
  },
  features: {
    pkiEnabled: true,
    domainsEnabled: true,
    siemEnabled: true,
    inferenceEnabled: false,
  },
};

export type GeneralSettingsUpdate = Omit<Partial<GeneralSettings>, 'features' | 'shutdown' | 'relay'> & {
  features?: Partial<GeneralFeatureSettings>;
  shutdown?: GeneralShutdownSettings;
  relay?: Partial<GeneralRelaySettings>;
};

export function normalizePublicUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Opfield public URL must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Opfield public URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Opfield public URL must be an origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function fileUploadBodyLimitBytes(fileUploadMaxBytes: number): number {
  return Math.ceil(fileUploadMaxBytes * BODY_LIMIT_OVERHEAD_RATIO) + BODY_LIMIT_OVERHEAD_BYTES;
}

export function normalizeHostPortTarget(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (/[/?#@\s]/.test(trimmed) || trimmed.includes('://')) {
    throw new Error(`Opfield gRPC public target must be a hostname or IP address: ${trimmed}`);
  }

  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) {
    const [, ip, rawPort] = bracketedIpv6;
    if (!isValidOpfieldIp(ip)) throw new Error(`Opfield gRPC public target IPv6 address is invalid: ${ip}`);
    const port = normalizePort(rawPort);
    return port ? `[${ip}]:${port}` : ip;
  }

  if (isValidOpfieldIp(trimmed)) return trimmed;

  const hostWithPort = trimmed.match(/^([^:]+):(\d+)$/);
  const host = hostWithPort?.[1] ?? trimmed;
  const port = normalizePort(hostWithPort?.[2]);
  if (!isValidOpfieldHostname(host)) {
    throw new Error(`Opfield gRPC public target must be a hostname or IP address: ${trimmed}`);
  }
  return port ? `${host}:${port}` : host;
}

export function isValidOpfieldIp(value: string): boolean {
  return isIP(value) !== 0;
}

export function isValidOpfieldHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith('.')) return false;
  const labels = value.split('.');
  return labels.every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function normalizePort(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error(`Opfield gRPC local IP port must be numeric: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Opfield gRPC local IP port must be between 1 and 65535: ${value}`);
  }
  return String(port);
}

export function normalizeIpPortTarget(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;

  const bracketedIpv6 = trimmed.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketedIpv6) {
    const [, ip, rawPort] = bracketedIpv6;
    if (!isValidOpfieldIp(ip)) throw new Error(`Opfield gRPC local IP must be an IPv4 or IPv6 address: ${ip}`);
    const port = normalizePort(rawPort);
    return port ? `[${ip}]:${port}` : ip;
  }

  if (isValidOpfieldIp(trimmed)) return trimmed;

  const ipv4WithPort = trimmed.match(/^([^:]+):(\d+)$/);
  if (ipv4WithPort) {
    const [, ip, rawPort] = ipv4WithPort;
    if (!isValidOpfieldIp(ip)) throw new Error(`Opfield gRPC local IP must be an IPv4 or IPv6 address: ${ip}`);
    return `${ip}:${normalizePort(rawPort)}`;
  }

  throw new Error(`Opfield gRPC local IP must be an IPv4 or IPv6 address: ${trimmed}`);
}

export function isValidOpfieldIpPortTarget(value: string): boolean {
  try {
    normalizeIpPortTarget(value);
    return true;
  } catch {
    return false;
  }
}

export function isValidOpfieldHostPortTarget(value: string): boolean {
  try {
    normalizeHostPortTarget(value);
    return true;
  } catch {
    return false;
  }
}

export class GeneralSettingsService {
  private licensePolicy?: LicensePolicyService;
  private cached: GeneralSettings | null = null;
  private cachedAt = 0;
  private writeGeneration = 0;
  private inferenceDisabledHandler?: () => Promise<void>;

  constructor(
    private readonly db: DrizzleClient,
    private readonly inferenceCatalogEvents?: InferenceCatalogEventsService,
    private readonly eventBus?: EventBusService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setInferenceDisabledHandler(handler: () => Promise<void>): void {
    this.inferenceDisabledHandler = handler;
  }

  async getConfig(): Promise<GeneralSettings> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < 5000) return this.cached;

    // A read that started before a write must not cache the value it replaced.
    const generation = this.writeGeneration;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const config = this.normalize(row?.value);
    if (generation === this.writeGeneration) {
      this.cached = config;
      this.cachedAt = now;
    }
    return config;
  }

  async updateConfig(updates: GeneralSettingsUpdate): Promise<GeneralSettings> {
    if (updates.features?.pkiEnabled === true) {
      // LICENSE ENFORCEMENT: Enabling user-managed PKI requires Enterprise under the project license/TOS.
      await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('internal-pki');
    }
    if (updates.features?.siemEnabled === true) {
      // LICENSE ENFORCEMENT: Enabling SIEM export requires Enterprise under the project license/TOS.
      await requireConfiguredLicensePolicy(this.licensePolicy).requireFeature('siem-export');
    }
    const { current, next } = await this.writeConfig((current) =>
      this.normalize({
        ...current,
        ...updates,
        features: {
          ...current.features,
          ...updates.features,
        },
        shutdown: updates.shutdown ?? current.shutdown,
        relay: {
          ...current.relay,
          ...updates.relay,
        },
      })
    );
    await this.afterConfigChanged(current, next);
    return next;
  }

  /**
   * Restores only the given top-level fields from `previous`, e.g. to undo a
   * save whose side effect failed, without overwriting fields someone else
   * changed meanwhile. With `ifUnchangedFrom`, a field is restored only while
   * it still holds the value from that snapshot (the value the save wrote).
   */
  async restoreFields(
    previous: GeneralSettings,
    fields: readonly (keyof GeneralSettings)[],
    options: { ifUnchangedFrom?: GeneralSettings } = {}
  ): Promise<GeneralSettings> {
    const { current, next } = await this.writeConfig((current) => {
      const patch: Record<string, unknown> = {};
      for (const field of fields) {
        const expected = options.ifUnchangedFrom;
        if (expected && JSON.stringify(current[field]) !== JSON.stringify(expected[field])) continue;
        patch[field] = previous[field];
      }
      return this.normalize({ ...current, ...patch });
    });
    await this.afterConfigChanged(current, next);
    return next;
  }

  /**
   * Read-merge-write under a transaction-scoped lock, reading the stored row
   * rather than the cache, so concurrent writers (admin saves, the license
   * reconciler) never lose each other's fields.
   */
  private async writeConfig(
    merge: (current: GeneralSettings) => GeneralSettings
  ): Promise<{ current: GeneralSettings; next: GeneralSettings }> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SETTINGS_KEY}))`);
      const [row] = await tx.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
      const current = this.normalize(row?.value);
      const next = merge(current);
      await tx
        .insert(settings)
        .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: next, updatedAt: new Date() },
        });
      return { current, next };
    });
    this.writeGeneration += 1;
    this.cached = result.next;
    this.cachedAt = Date.now();
    return result;
  }

  private async afterConfigChanged(current: GeneralSettings, next: GeneralSettings): Promise<void> {
    // No configuration is carried by this event. It only lets cached,
    // permission-filtered read models refresh immediately.
    this.eventBus?.publish('system.config.changed', {
      // The policy lease is part of every relay snapshot: a change is published to all relays at once, not at
      // their next lease refresh.
      relayChanged:
        JSON.stringify(current.relay) !== JSON.stringify(next.relay) ||
        current.relayPolicyLeaseHours !== next.relayPolicyLeaseHours,
      externalBrandingChanged: current.hideExternalBranding !== next.hideExternalBranding,
    });
    if (current.features.inferenceEnabled !== next.features.inferenceEnabled) {
      this.inferenceCatalogEvents?.publishCatalogChanged();
    }
    if (current.features.inferenceEnabled && !next.features.inferenceEnabled) {
      await this.inferenceDisabledHandler?.();
    }
  }

  async getFileUploadMaxBodyBytes(): Promise<number> {
    const config = await this.getConfig();
    return fileUploadBodyLimitBytes(config.fileUploadMaxBytes);
  }

  async getPublicUrl(): Promise<string | null> {
    return (await this.getConfig()).publicUrl;
  }

  getCachedPublicUrl(): string | null {
    return this.cached?.publicUrl ?? null;
  }

  async requirePublicUrl(): Promise<string> {
    const publicUrl = await this.getPublicUrl();
    if (!publicUrl) throw new Error('Opfield public URL has not been configured');
    return publicUrl;
  }

  async importLegacyPublicUrl(value: string | null | undefined): Promise<GeneralSettings> {
    const current = await this.getConfig();
    if (current.publicUrl) return current;
    const publicUrl = normalizePublicUrl(value);
    return publicUrl ? this.updateConfig({ publicUrl }) : current;
  }

  async getFileOpenMaxBytes(): Promise<number> {
    const config = await this.getConfig();
    return config.fileOpenMaxBytes;
  }

  async getOpfieldEndpointSettings(): Promise<Pick<GeneralSettings, 'grpcPublicTarget' | 'grpcLocalIp'>> {
    const config = await this.getConfig();
    return {
      grpcPublicTarget: config.grpcPublicTarget,
      grpcLocalIp: config.grpcLocalIp,
    };
  }

  async isFeatureEnabled(feature: keyof GeneralFeatureSettings): Promise<boolean> {
    const config = await this.getConfig();
    return config.features[feature];
  }

  getCachedShutdownSettings(): GeneralShutdownSettings {
    return { ...(this.cached?.shutdown ?? DEFAULT_GENERAL_SETTINGS.shutdown) };
  }

  private normalize(value: unknown): GeneralSettings {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const rawFileUploadMaxBytes = Number(record.fileUploadMaxBytes);
    const fileUploadMaxBytes = Number.isInteger(rawFileUploadMaxBytes)
      ? rawFileUploadMaxBytes
      : DEFAULT_GENERAL_SETTINGS.fileUploadMaxBytes;
    const rawFileOpenMaxBytes = Number(record.fileOpenMaxBytes);
    const fileOpenMaxBytes = Number.isInteger(rawFileOpenMaxBytes)
      ? rawFileOpenMaxBytes
      : DEFAULT_GENERAL_SETTINGS.fileOpenMaxBytes;
    const rawRelayGrantTtlHours = Number(record.relayGrantTtlHours);
    const relayGrantTtlHours = Number.isInteger(rawRelayGrantTtlHours)
      ? rawRelayGrantTtlHours
      : DEFAULT_GENERAL_SETTINGS.relayGrantTtlHours;
    const rawRelayPolicyLeaseHours = Number(record.relayPolicyLeaseHours);
    const relayPolicyLeaseHours = Number.isInteger(rawRelayPolicyLeaseHours)
      ? rawRelayPolicyLeaseHours
      : DEFAULT_GENERAL_SETTINGS.relayPolicyLeaseHours;
    const relayRecord =
      typeof record.relay === 'object' && record.relay !== null ? (record.relay as Record<string, unknown>) : {};
    const relayDataLanes = numberOrDefault(relayRecord.dataLanes, DEFAULT_GENERAL_SETTINGS.relay.dataLanes);
    const relayReadChunkBytes = numberOrDefault(
      relayRecord.readChunkBytes,
      DEFAULT_GENERAL_SETTINGS.relay.readChunkBytes
    );
    const relayAssignmentSpread = normalizeRelayAssignmentSpread(relayRecord.assignmentSpread);
    const relayAdaptiveAdmissionEnabled =
      typeof relayRecord.adaptiveAdmissionEnabled === 'boolean'
        ? relayRecord.adaptiveAdmissionEnabled
        : DEFAULT_GENERAL_SETTINGS.relay.adaptiveAdmissionEnabled;
    const relayProxyTargetPressurePercent = numberOrDefault(
      relayRecord.proxyTargetPressurePercent,
      DEFAULT_GENERAL_SETTINGS.relay.proxyTargetPressurePercent
    );
    const relayDatabaseReservePercent = numberOrDefault(
      relayRecord.databaseReservePercent,
      DEFAULT_GENERAL_SETTINGS.relay.databaseReservePercent
    );
    const relayHardPressurePercent = numberOrDefault(
      relayRecord.hardPressurePercent,
      DEFAULT_GENERAL_SETTINGS.relay.hardPressurePercent
    );

    if (fileUploadMaxBytes < FILE_UPLOAD_MIN_BYTES || fileUploadMaxBytes > FILE_UPLOAD_MAX_BYTES) {
      throw new Error(`File upload limit must be between ${FILE_UPLOAD_MIN_BYTES} and ${FILE_UPLOAD_MAX_BYTES} bytes`);
    }

    if (fileOpenMaxBytes < FILE_OPEN_MIN_BYTES || fileOpenMaxBytes > FILE_OPEN_MAX_BYTES) {
      throw new Error(`File open limit must be between ${FILE_OPEN_MIN_BYTES} and ${FILE_OPEN_MAX_BYTES} bytes`);
    }
    if (relayGrantTtlHours < RELAY_GRANT_TTL_MIN_HOURS || relayGrantTtlHours > RELAY_GRANT_TTL_MAX_HOURS) {
      throw new Error(
        `Relay grant TTL must be between ${RELAY_GRANT_TTL_MIN_HOURS} and ${RELAY_GRANT_TTL_MAX_HOURS} hours`
      );
    }
    if (relayPolicyLeaseHours < RELAY_POLICY_LEASE_MIN_HOURS || relayPolicyLeaseHours > RELAY_POLICY_LEASE_MAX_HOURS) {
      throw new Error(
        `Relay policy lease must be between ${RELAY_POLICY_LEASE_MIN_HOURS} and ${RELAY_POLICY_LEASE_MAX_HOURS} hours`
      );
    }
    if (relayDataLanes < RELAY_DATA_LANES_MIN || relayDataLanes > RELAY_DATA_LANES_MAX) {
      throw new Error(`Relay data lanes must be between ${RELAY_DATA_LANES_MIN} and ${RELAY_DATA_LANES_MAX}`);
    }
    if (relayReadChunkBytes < RELAY_READ_CHUNK_BYTES_MIN || relayReadChunkBytes > RELAY_READ_CHUNK_BYTES_MAX) {
      throw new Error(
        `Relay read chunk must be between ${RELAY_READ_CHUNK_BYTES_MIN} and ${RELAY_READ_CHUNK_BYTES_MAX} bytes`
      );
    }
    if (
      relayProxyTargetPressurePercent < RELAY_PROXY_TARGET_PRESSURE_MIN_PERCENT ||
      relayProxyTargetPressurePercent > RELAY_PROXY_TARGET_PRESSURE_MAX_PERCENT
    ) {
      throw new Error(
        `Relay proxy pressure target must be between ${RELAY_PROXY_TARGET_PRESSURE_MIN_PERCENT} and ${RELAY_PROXY_TARGET_PRESSURE_MAX_PERCENT} percent`
      );
    }
    if (
      relayDatabaseReservePercent < RELAY_DATABASE_RESERVE_MIN_PERCENT ||
      relayDatabaseReservePercent > RELAY_DATABASE_RESERVE_MAX_PERCENT
    ) {
      throw new Error(
        `Relay database reserve must be between ${RELAY_DATABASE_RESERVE_MIN_PERCENT} and ${RELAY_DATABASE_RESERVE_MAX_PERCENT} percent`
      );
    }
    if (
      relayHardPressurePercent < RELAY_HARD_PRESSURE_MIN_PERCENT ||
      relayHardPressurePercent > RELAY_HARD_PRESSURE_MAX_PERCENT
    ) {
      throw new Error(
        `Relay hard pressure cutoff must be between ${RELAY_HARD_PRESSURE_MIN_PERCENT} and ${RELAY_HARD_PRESSURE_MAX_PERCENT} percent`
      );
    }
    if (relayProxyTargetPressurePercent + relayDatabaseReservePercent >= relayHardPressurePercent) {
      throw new Error('Relay proxy pressure target plus database reserve must remain below the hard cutoff');
    }

    const features =
      typeof record.features === 'object' && record.features !== null
        ? (record.features as Record<string, unknown>)
        : {};
    const shutdown = normalizeShutdownSettings(record.shutdown);

    return {
      publicUrl: normalizePublicUrl(record.publicUrl as string | null | undefined),
      updateChannel: record.updateChannel === 'preview' ? 'preview' : 'stable',
      hideExternalBranding:
        typeof record.hideExternalBranding === 'boolean'
          ? record.hideExternalBranding
          : DEFAULT_GENERAL_SETTINGS.hideExternalBranding,
      autoAssignCreatedResourcePermissions: record.autoAssignCreatedResourcePermissions !== false,
      sendInvitationOnUserCreate: record.sendInvitationOnUserCreate === true,
      fileUploadMaxBytes,
      fileOpenMaxBytes,
      grpcPublicTarget: normalizeHostPortTarget(record.grpcPublicTarget as string | null | undefined),
      grpcLocalIp: normalizeIpPortTarget(record.grpcLocalIp as string | null | undefined),
      relayAutoRecovery:
        typeof record.relayAutoRecovery === 'boolean'
          ? record.relayAutoRecovery
          : DEFAULT_GENERAL_SETTINGS.relayAutoRecovery,
      relay: {
        dataLanes: relayDataLanes,
        readChunkBytes: relayReadChunkBytes,
        assignmentSpread: relayAssignmentSpread,
        adaptiveAdmissionEnabled: relayAdaptiveAdmissionEnabled,
        proxyTargetPressurePercent: relayProxyTargetPressurePercent,
        databaseReservePercent: relayDatabaseReservePercent,
        hardPressurePercent: relayHardPressurePercent,
      },
      shutdown,
      relayGrantTtlHours,
      relayPolicyLeaseHours,
      features: {
        pkiEnabled:
          typeof features.pkiEnabled === 'boolean' ? features.pkiEnabled : DEFAULT_GENERAL_SETTINGS.features.pkiEnabled,
        domainsEnabled:
          typeof features.domainsEnabled === 'boolean'
            ? features.domainsEnabled
            : DEFAULT_GENERAL_SETTINGS.features.domainsEnabled,
        siemEnabled:
          typeof features.siemEnabled === 'boolean'
            ? features.siemEnabled
            : DEFAULT_GENERAL_SETTINGS.features.siemEnabled,
        inferenceEnabled:
          typeof features.inferenceEnabled === 'boolean'
            ? features.inferenceEnabled
            : DEFAULT_GENERAL_SETTINGS.features.inferenceEnabled,
      },
    };
  }
}

export function normalizeRelayAssignmentSpread(value: unknown): RelayAssignmentSpread {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (record.mode === 'all') return { mode: 'all' };
  const count = numberOrDefault(record.count, RELAY_ASSIGNMENT_SPREAD_DEFAULT_COUNT);
  if (record.mode !== undefined && record.mode !== 'fixed') {
    throw new Error('Relay assignment spread mode must be fixed or all');
  }
  if (count < RELAY_ASSIGNMENT_SPREAD_MIN_COUNT || count > RELAY_ASSIGNMENT_SPREAD_MAX_COUNT) {
    throw new Error(
      `Relay assignment spread must be between ${RELAY_ASSIGNMENT_SPREAD_MIN_COUNT} and ${RELAY_ASSIGNMENT_SPREAD_MAX_COUNT}`
    );
  }
  return { mode: 'fixed', count };
}

export function normalizeShutdownSettings(value: unknown): GeneralShutdownSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const normalized = {
    userRequestDrainSeconds: numberOrDefault(
      record.userRequestDrainSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.userRequestDrainSeconds
    ),
    structuredLogDrainSeconds: numberOrDefault(
      record.structuredLogDrainSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.structuredLogDrainSeconds
    ),
    finalizationTimeoutSeconds: numberOrDefault(
      record.finalizationTimeoutSeconds,
      DEFAULT_GENERAL_SETTINGS.shutdown.finalizationTimeoutSeconds
    ),
  };

  if (normalized.userRequestDrainSeconds < 0 || normalized.userRequestDrainSeconds > SHUTDOWN_USER_DRAIN_MAX_SECONDS) {
    throw new Error(`User request drain must be between 0 and ${SHUTDOWN_USER_DRAIN_MAX_SECONDS} seconds`);
  }
  if (
    normalized.structuredLogDrainSeconds < 0 ||
    normalized.structuredLogDrainSeconds > SHUTDOWN_LOG_DRAIN_MAX_SECONDS
  ) {
    throw new Error(`Structured log drain must be between 0 and ${SHUTDOWN_LOG_DRAIN_MAX_SECONDS} seconds`);
  }
  if (
    normalized.finalizationTimeoutSeconds < SHUTDOWN_FINALIZATION_MIN_SECONDS ||
    normalized.finalizationTimeoutSeconds > SHUTDOWN_FINALIZATION_MAX_SECONDS
  ) {
    throw new Error(
      `Shutdown finalization must be between ${SHUTDOWN_FINALIZATION_MIN_SECONDS} and ${SHUTDOWN_FINALIZATION_MAX_SECONDS} seconds`
    );
  }
  const total =
    normalized.userRequestDrainSeconds + normalized.structuredLogDrainSeconds + normalized.finalizationTimeoutSeconds;
  if (total > SHUTDOWN_TOTAL_MAX_SECONDS) {
    throw new Error(`Total graceful shutdown deadline must not exceed ${SHUTDOWN_TOTAL_MAX_SECONDS} seconds`);
  }
  return normalized;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}
