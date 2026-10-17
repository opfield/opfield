import { eq, inArray } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes, settings } from '@/db/schema/index.js';
import { LEGACY_HOST_MOVE_CAPABILITY } from '@/lib/legacy-compat.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import { type GeneralSettingsService, normalizeHostPortTarget } from '@/modules/settings/general-settings.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';

const logger = createChildLogger('OpfieldMove');
const SETTINGS_KEY = 'configuration-transfer:next-address';
export const OPFIELD_NEXT_ADDRESS_CAPABILITY = LEGACY_HOST_MOVE_CAPABILITY;
const RESEND_INTERVAL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;

export interface OpfieldMoveAnnouncement {
  address: string;
  announcedAt: string;
  userId: string | null;
}

export interface OpfieldMoveNodeState {
  nodeId: string;
  name: string;
  type: string;
  /**
   * ready: no address announced, the daemon can take one; told: the daemon keeps the announced address; pending: not
   * told yet; offline: not connected now; unsupported: its daemon is too old; failed: it refused or did not answer.
   */
  state: 'ready' | 'told' | 'pending' | 'offline' | 'unsupported' | 'failed';
  error?: string;
}

export interface OpfieldMoveStatus {
  announcement: OpfieldMoveAnnouncement | null;
  currentAddress: string | null;
  nodes: OpfieldMoveNodeState[];
}

/**
 * Tells enrolled daemons the address Opfield moves to. A daemon keeps it next to its current
 * address and switches its control connection to it only after the current address stayed
 * unreachable for 10 minutes and the new one presents a certificate of the same System CA, that
 * is, once the old installation is shut down and the restored one answers. Connected daemons are
 * told at once; daemons that connect later are told within a minute while the announcement stands.
 */
export class OpfieldMoveService {
  private readonly told = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private sending: Promise<void> | null = null;

  constructor(
    private readonly db: DrizzleClient,
    private readonly registry: Pick<NodeRegistryService, 'getAllNodes' | 'hasCapability' | 'sendCommand'>,
    private readonly generalSettings: Pick<GeneralSettingsService, 'getOpfieldEndpointSettings'>
  ) {}

  async initialize(): Promise<void> {
    const announcement = await this.getAnnouncement();
    if (!announcement) return;
    const current = await this.currentAddress();
    if (current && normalize(current) === normalize(announcement.address)) {
      // This installation is the one the daemons were told about (it was restored here): they
      // switched or switch to it, and keeping the address would only repeat it.
      await this.db.delete(settings).where(eq(settings.key, SETTINGS_KEY));
      logger.info('Cleared the announced Opfield address: this installation serves it');
      return;
    }
    this.startResending();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getAnnouncement(): Promise<OpfieldMoveAnnouncement | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const value = row?.value as Partial<OpfieldMoveAnnouncement> | undefined;
    if (!value || typeof value.address !== 'string' || !value.address) return null;
    return {
      address: value.address,
      announcedAt: typeof value.announcedAt === 'string' ? value.announcedAt : new Date(0).toISOString(),
      userId: typeof value.userId === 'string' ? value.userId : null,
    };
  }

  private async currentAddress(): Promise<string | null> {
    return (await this.generalSettings.getOpfieldEndpointSettings()).grpcPublicTarget ?? null;
  }

  async status(): Promise<OpfieldMoveStatus> {
    const [announcement, currentAddress] = await Promise.all([this.getAnnouncement(), this.currentAddress()]);
    const enrolled = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname, displayName: nodes.displayName, type: nodes.type })
      .from(nodes);
    const connected = new Set(this.registry.getAllNodes().map((node) => node.nodeId));
    return {
      announcement,
      currentAddress,
      nodes: enrolled.map((node) => {
        const base = { nodeId: node.id, name: node.displayName || node.hostname, type: node.type };
        if (!connected.has(node.id)) return { ...base, state: 'offline' as const };
        if (!this.registry.hasCapability(node.id, OPFIELD_NEXT_ADDRESS_CAPABILITY)) {
          return { ...base, state: 'unsupported' as const };
        }
        const failure = this.failures.get(node.id);
        if (failure) return { ...base, state: 'failed' as const, error: failure };
        if (announcement && this.told.get(node.id) === announcement.address) return { ...base, state: 'told' as const };
        return { ...base, state: announcement ? ('pending' as const) : ('ready' as const) };
      }),
    };
  }

  /** Announces `address` (host:port) to every daemon; null withdraws the announcement. */
  async announce(address: string | null, userId: string | null): Promise<OpfieldMoveStatus> {
    if (address === null) {
      await this.db.delete(settings).where(eq(settings.key, SETTINGS_KEY));
      this.stop();
      this.told.clear();
      this.failures.clear();
      await this.sendToAll('');
      return this.status();
    }
    let normalized: string | null;
    try {
      normalized = normalizeHostPortTarget(address);
    } catch (error) {
      throw new AppError(400, 'INVALID_ADDRESS', error instanceof Error ? error.message : 'Invalid address');
    }
    if (!normalized) throw new AppError(400, 'INVALID_ADDRESS', 'Enter the new gRPC address of Opfield');
    normalized = withDefaultPort(normalized);
    const current = await this.currentAddress();
    if (current && normalize(current) === normalize(normalized)) {
      throw new AppError(400, 'SAME_ADDRESS', 'This is the current address of Opfield; nodes need no new address');
    }
    const announcement: OpfieldMoveAnnouncement = {
      address: normalized,
      announcedAt: new Date().toISOString(),
      userId,
    };
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: announcement, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: announcement, updatedAt: new Date() } });
    this.told.clear();
    this.failures.clear();
    await this.sendToAll(normalized);
    this.startResending();
    return this.status();
  }

  private startResending(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.resend().catch((error) => logger.warn('Could not repeat the announced Opfield address', { error }));
    }, RESEND_INTERVAL_MS);
    this.timer.unref();
  }

  private async resend(): Promise<void> {
    const announcement = await this.getAnnouncement();
    if (!announcement) {
      this.stop();
      return;
    }
    await this.sendToAll(announcement.address, true);
  }

  private async sendToAll(address: string, onlyMissing = false): Promise<void> {
    if (this.sending) await this.sending;
    const run = async () => {
      const targets = this.registry
        .getAllNodes()
        .map((node) => node.nodeId)
        .filter((nodeId) => this.registry.hasCapability(nodeId, OPFIELD_NEXT_ADDRESS_CAPABILITY))
        .filter((nodeId) => !onlyMissing || this.told.get(nodeId) !== address);
      await Promise.all(
        targets.map(async (nodeId) => {
          try {
            const result = await this.registry.sendCommand(
              nodeId,
              { setOpfieldNextAddress: { address } },
              COMMAND_TIMEOUT_MS
            );
            if (!result.success) throw new Error(result.error || 'The daemon refused the address');
            this.failures.delete(nodeId);
            if (address) this.told.set(nodeId, address);
            else this.told.delete(nodeId);
          } catch (error) {
            this.failures.set(nodeId, error instanceof Error ? error.message : String(error));
          }
        })
      );
    };
    this.sending = run();
    try {
      await this.sending;
    } finally {
      this.sending = null;
    }
  }

  /** Nodes by id, for audit details. */
  async nodeNames(ids: string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const rows = await this.db
      .select({ id: nodes.id, hostname: nodes.hostname })
      .from(nodes)
      .where(inArray(nodes.id, ids));
    return Object.fromEntries(rows.map((row) => [row.id, row.hostname]));
  }
}

/** host:port with the default gRPC port; a bare IPv6 address gets brackets. */
export function withDefaultPort(target: string): string {
  if (target.startsWith('[')) return /]:\d+$/.test(target) ? target : `${target}:9443`;
  if ((target.match(/:/g) ?? []).length > 1) return `[${target}]:9443`;
  return /:\d+$/.test(target) ? target : `${target}:9443`;
}

function normalize(address: string): string {
  return withDefaultPort(address.trim().toLowerCase());
}
