import { createHash } from 'node:crypto';
import {
  firewallFingerprint,
  type HostingFirewallAdapter,
  type HostingFirewallConfig,
  type HostingFirewallObservation,
} from '../hosting-firewall.types.js';
import { HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';

type Json = Record<string, unknown>;
type Request = <T>(path: string, options?: HostingRequestOptions) => Promise<T>;

export interface DigitalOceanFirewallDependencies {
  request: Request;
  getResource(remoteId: string): Promise<HostingResourceSnapshot | null>;
  scopes?(): Promise<Set<string>>;
}

type FirewallRule = {
  action: 'allow' | 'deny';
  protocol: 'tcp' | 'udp' | 'icmp';
  ports: string;
  addresses: string[];
  unsupportedSelectors: Json;
};
type Firewall = {
  id: string;
  name: string;
  dropletIds: string[];
  tags: string[];
  inbound: FirewallRule[];
  outbound: FirewallRule[];
  applying: boolean;
};

const PAGE_SIZE = 200;
const MAX_PAGES = 100;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unsafe(): never {
  throw new HostingProviderError(502, false, 'DigitalOcean returned an unsafe firewall response');
}
function record(value: unknown): Json {
  return isRecord(value) ? value : unsafe();
}
function string(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : unsafe();
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return string(value);
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return unsafe();
  return [...value].sort();
}
function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : unsafe();
}
function ownedName(ownerKey: string, remoteId: string): string {
  return `opfield-fw-${createHash('sha256').update(`${ownerKey}:${remoteId}`).digest('hex').slice(0, 20)}`;
}
// legacy-name: DigitalOcean firewall name "gateway-fw-<hash>" — remove once every hosting resource was reconciled by 2.12.1+
function legacyOwnedName(ownerKey: string, remoteId: string): string {
  return `gateway-fw-${createHash('sha256').update(`${ownerKey}:${remoteId}`).digest('hex').slice(0, 20)}`;
}
function ownedNames(ownerKey: string, remoteId: string): string[] {
  return [ownedName(ownerKey, remoteId), legacyOwnedName(ownerKey, remoteId)];
}
function normalizeRule(value: unknown, direction: 'in' | 'out'): FirewallRule {
  const rule = record(value);
  const action = rule.action ?? 'allow';
  const protocol = rule.protocol;
  if ((action !== 'allow' && action !== 'deny') || (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'icmp'))
    return unsafe();
  const endpoint = record(direction === 'in' ? rule.sources : rule.destinations);
  const addresses = strings(endpoint.addresses ?? []);
  // Do not silently discard selectors added outside Gateway: they can broaden an Allow rule.
  const unsupportedSelectors = Object.fromEntries(
    Object.entries(endpoint)
      .filter(([key, value]) => key !== 'addresses' && value != null && !(Array.isArray(value) && !value.length))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
  );
  const rawPorts = protocol === 'icmp' ? 'all' : string(rule.ports);
  const ports = ['0', '1-65535', 'all'].includes(rawPorts) ? 'all' : rawPorts;
  return { action, protocol, ports, addresses, unsupportedSelectors };
}
function parseFirewall(value: unknown, expectedNames?: string[]): Firewall {
  const firewall = record(value);
  const pending = firewall.pending_changes === undefined ? [] : values(firewall.pending_changes);
  return {
    id: id(firewall.id),
    name: string(firewall.name),
    dropletIds: values(firewall.droplet_ids ?? [])
      .map(id)
      .sort(),
    tags: strings(firewall.tags ?? []),
    inbound:
      expectedNames && !expectedNames.includes(firewall.name as string)
        ? []
        : values(firewall.inbound_rules ?? []).map((rule) => normalizeRule(rule, 'in')),
    outbound:
      expectedNames && !expectedNames.includes(firewall.name as string)
        ? []
        : values(firewall.outbound_rules ?? []).map((rule) => normalizeRule(rule, 'out')),
    applying:
      (firewall.status !== undefined && firewall.status !== 'succeeded') ||
      pending.some((change) => {
        const item = record(change);
        const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
        return !['completed', 'succeeded', 'done'].includes(status);
      }),
  };
}
function stableRules(rules: FirewallRule[]) {
  return [...rules]
    .map((rule) => ({ ...rule, addresses: [...rule.addresses].sort() }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function rulesEqual(left: FirewallRule[], right: FirewallRule[]): boolean {
  return JSON.stringify(stableRules(left)) === JSON.stringify(stableRules(right));
}
function rulePayload(rule: FirewallRule, direction: 'in' | 'out') {
  const endpoint = direction === 'in' ? 'sources' : 'destinations';
  return {
    action: rule.action,
    protocol: rule.protocol,
    ports: rule.ports === 'all' ? '0' : rule.ports,
    [endpoint]: { addresses: rule.addresses },
  };
}
function compileDirection(config: HostingFirewallConfig, direction: 'in' | 'out'): FirewallRule[] {
  const policy = direction === 'in' ? config.inboundPolicy : config.outboundPolicy;
  const configured = config.rules
    .filter((rule) => rule.direction === direction)
    .map((rule) => ({
      action: rule.action,
      protocol: rule.protocol,
      ports: rule.ports,
      addresses: [...rule.addresses].sort(),
      unsupportedSelectors: {},
    }));
  const defaults =
    policy === 'allow'
      ? (['tcp', 'udp', 'icmp'] as const).map((protocol) => ({
          action: 'allow' as const,
          protocol,
          ports: 'all',
          addresses: ['0.0.0.0/0', '::/0'],
          unsupportedSelectors: {},
        }))
      : [];
  return [
    ...configured.filter((rule) => rule.action === 'deny'),
    ...configured.filter((rule) => rule.action === 'allow'),
    ...defaults,
  ];
}

export class DigitalOceanFirewallAdapter implements HostingFirewallAdapter {
  /** Owned firewalls, by droplet ID, that a read on this instance found under the legacy name. */
  private readonly legacyNames = new Map<string, Firewall>();
  constructor(private readonly dependencies: DigitalOceanFirewallDependencies) {}

  async cleanup(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    remoteId: string | null,
    dispatched: boolean,
    beforeDelete: (remoteId: string) => Promise<void>
  ): Promise<{ status: 'absent' | 'deleted' | 'preserved'; remoteId: string | null; reason?: string }> {
    const names = ownedNames(ownerKey, resource.remoteId);
    const assertVmAbsent = async () => {
      if ((await this.dependencies.getResource(resource.remoteId)) !== null)
        throw new HostingProviderError(409, false, 'The VM still exists; its firewall will not be deleted.');
    };
    await assertVmAbsent();
    if (!remoteId) {
      if (dispatched) return unsafe();
      const owned = (await this.listFirewalls(names)).filter((firewall) => names.includes(firewall.name));
      if (owned.length > 1)
        throw new HostingProviderError(409, false, 'Several firewalls have the ownership name; cleanup needs review.');
      remoteId = owned[0]?.id ?? null;
    }
    if (!remoteId) return { status: 'absent', remoteId: null };
    const targetId = remoteId;
    const inspect = async (): Promise<Firewall | null> => {
      try {
        const root = record(await this.dependencies.request<unknown>(`/v2/firewalls/${encodeURIComponent(targetId)}`));
        const firewall = record(root.firewall);
        // Missing attachment fields are not evidence that a destructive target is unused.
        values(firewall.droplet_ids);
        strings(firewall.tags);
        values(firewall.pending_changes);
        string(firewall.status);
        const parsed = parseFirewall(firewall, names);
        if (parsed.id !== targetId) return unsafe();
        return parsed;
      } catch (error) {
        if (error instanceof HostingProviderError && !error.outcomeUnknown && error.providerStatus === 404) return null;
        throw error;
      }
    };
    const check = (firewall: Firewall | null) => {
      if (!firewall) return { status: 'absent' as const, remoteId: targetId };
      if (
        !names.includes(firewall.name) ||
        firewall.tags.length ||
        firewall.dropletIds.some((id) => id !== resource.remoteId)
      )
        return {
          status: 'preserved' as const,
          remoteId: targetId,
          reason: 'Firewall ownership changed or the policy is still attached; it was not deleted.',
        };
      if (firewall.applying || firewall.dropletIds.length)
        throw new HostingProviderError(409, false, 'VM deleted; waiting for firewall changes before cleanup.');
      return null;
    };
    const resolved = check(await inspect());
    if (resolved) return resolved;
    if (dispatched)
      throw new HostingProviderError(
        409,
        true,
        'VM deleted; firewall deletion is unconfirmed and will not be repeated.'
      );
    await beforeDelete(targetId);
    // Recheck after persisting the dispatch fence, without releasing the operation lease.
    await assertVmAbsent();
    const changed = check(await inspect());
    if (changed) return changed;
    await this.dependencies.request(`/v2/firewalls/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
    return { status: 'deleted', remoteId: targetId };
  }

  private async listFirewalls(expectedNames: string[]): Promise<Firewall[]> {
    const result: Firewall[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const root = record(
        await this.dependencies.request<unknown>('/v2/firewalls', { query: { page, per_page: PAGE_SIZE } })
      );
      const firewalls = values(root.firewalls).map((value) => parseFirewall(value, expectedNames));
      result.push(...firewalls);
      const next = record(root.links ?? {}).pages;
      if (next === undefined || next === null) return result;
      if (!isRecord(next) || next.next === null || next.next === undefined) return result;
      if (typeof next.next !== 'string') return unsafe();
    }
    throw new HostingProviderError(502, false, 'DigitalOcean firewall pagination was incomplete');
  }

  private async attachedFirewalls(remoteId: string, expectedNames: string[]): Promise<Firewall[]> {
    const root = record(
      await this.dependencies.request<unknown>(`/v2/droplets/${encodeURIComponent(remoteId)}/firewalls`)
    );
    return values(root.firewalls).map((value) => parseFirewall(value, expectedNames));
  }

  private async inspect(resource: HostingResourceSnapshot, ownerKey: string, desired: HostingFirewallConfig) {
    const fresh = await this.dependencies.getResource(resource.remoteId);
    const expectedName = ownedName(ownerKey, resource.remoteId);
    const names = ownedNames(ownerKey, resource.remoteId);
    const blockers: string[] = [];
    if (!fresh) blockers.push('The selected DigitalOcean droplet no longer exists.');
    else if (resource.incarnation && fresh.incarnation && resource.incarnation !== fresh.incarnation)
      blockers.push(
        'The selected DigitalOcean droplet was recreated; refresh the resource before changing its firewall.'
      );

    const [all, attached] = await Promise.all([
      this.listFirewalls(names),
      this.attachedFirewalls(resource.remoteId, names),
    ]);
    const owned = all.filter((firewall) => names.includes(firewall.name));
    const firewall = owned[0] ?? null;
    if (owned.length === 1 && firewall && firewall.name !== expectedName)
      this.legacyNames.set(resource.remoteId, firewall);
    else this.legacyNames.delete(resource.remoteId);
    const disableBlockers = [...blockers];
    if (this.dependencies.scopes) {
      const scopes = await this.dependencies.scopes();
      const required = ['firewall:read', 'firewall:update', ...(!firewall ? ['firewall:create'] : [])];
      const missing = required.filter(
        (scope) => !scopes.has(scope) && !scopes.has('api:write') && !scopes.has('write')
      );
      if (missing.length) blockers.push(`DigitalOcean token needs ${missing.join(', ')}.`);
      const disableMissing = [
        'firewall:read',
        ...(firewall?.dropletIds.includes(resource.remoteId) ? ['firewall:update'] : []),
      ].filter((scope) => !scopes.has(scope) && !scopes.has('api:write') && !scopes.has('write'));
      if (disableMissing.length) disableBlockers.push(`DigitalOcean token needs ${disableMissing.join(', ')}.`);
    }
    const attachedIds = new Set(attached.map((item) => item.id));
    const external = attached.filter((item) => !names.includes(item.name));
    const ownershipBlockers = [];
    if (owned.length > 1)
      ownershipBlockers.push('Several DigitalOcean firewalls have Opfield’s deterministic ownership name.');
    if (external.length)
      blockers.push(
        `The droplet is affected by other DigitalOcean firewall policies: ${external.map((item) => item.name).join(', ')}.`
      );
    if (firewall && (firewall.tags.length || firewall.dropletIds.some((idValue) => idValue !== resource.remoteId)))
      ownershipBlockers.push(
        'Opfield’s DigitalOcean firewall is shared by tags or another droplet and will not be changed.'
      );
    blockers.push(...ownershipBlockers);
    disableBlockers.push(...ownershipBlockers);
    if (
      firewall &&
      [...firewall.inbound, ...firewall.outbound].some((rule) => Object.keys(rule.unsupportedSelectors).length)
    )
      blockers.push(
        'Opfield’s DigitalOcean firewall contains unsupported source or destination selectors; review them in DigitalOcean before applying rules.'
      );

    const attachedOwned = !!firewall && attachedIds.has(firewall.id) && firewall.dropletIds.includes(resource.remoteId);
    const inbound = compileDirection(desired, 'in');
    const outbound = compileDirection(desired, 'out');
    const applying = !!firewall?.applying;
    const matches = desired.enabled
      ? !!firewall &&
        attachedOwned &&
        !applying &&
        rulesEqual(firewall.inbound, inbound) &&
        rulesEqual(firewall.outbound, outbound) &&
        !blockers.length
      : !attachedOwned && (!firewall || (!firewall.tags.length && !firewall.dropletIds.length));
    const fingerprint = firewallFingerprint({
      resource: fresh ? { remoteId: fresh.remoteId, incarnation: fresh.incarnation } : null,
      expectedName,
      owned: firewall && {
        id: firewall.id,
        dropletIds: firewall.dropletIds,
        tags: firewall.tags,
        inbound: stableRules(firewall.inbound),
        outbound: stableRules(firewall.outbound),
        applying,
      },
      attached: [...attached]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({
          id: item.id,
          name: item.name,
          dropletIds: item.dropletIds,
          tags: item.tags,
        })),
      blockers,
      disableBlockers,
    });
    return {
      firewall,
      expectedName,
      blockers,
      disableBlockers,
      attachedOwned,
      applying,
      matches,
      fingerprint,
      inbound,
      outbound,
    };
  }

  async read(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig
  ): Promise<HostingFirewallObservation> {
    try {
      const current = await this.inspect(resource, ownerKey, desired);
      return {
        fingerprint: current.fingerprint,
        enabled: current.attachedOwned,
        matches: current.matches,
        applying: current.applying,
        remoteId: current.firewall?.id ?? null,
        blockers: current.blockers,
        disableBlockers: current.disableBlockers,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!(error instanceof HostingProviderError) || (error.providerStatus !== 401 && error.providerStatus !== 403))
        throw error;
      const blockers = ['DigitalOcean token cannot read firewall state or lacks firewall permissions.'];
      return {
        fingerprint: firewallFingerprint({ provider: 'digitalocean', resource: resource.remoteId, blockers }),
        enabled: false,
        matches: false,
        applying: false,
        remoteId: null,
        blockers,
        disableBlockers: blockers,
        observedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Renames an owned firewall that still has the legacy name. Same ID, attachment and rules: the PUT
   * resends exactly the rules just read. Shared, pending or not fully representable policies keep the
   * legacy name, which stays recognized.
   */
  async migrateLegacyNames(resource: HostingResourceSnapshot, ownerKey: string): Promise<boolean> {
    const firewall = this.legacyNames.get(resource.remoteId);
    if (!firewall) return false;
    this.legacyNames.delete(resource.remoteId);
    if (
      firewall.applying ||
      firewall.tags.length ||
      firewall.dropletIds.some((idValue) => idValue !== resource.remoteId) ||
      [...firewall.inbound, ...firewall.outbound].some((rule) => Object.keys(rule.unsupportedSelectors).length)
    )
      return false;
    await this.dependencies.request(`/v2/firewalls/${encodeURIComponent(firewall.id)}`, {
      method: 'PUT',
      body: {
        name: ownedName(ownerKey, resource.remoteId),
        droplet_ids: firewall.dropletIds.map(Number),
        tags: [],
        inbound_rules: firewall.inbound.map((rule) => rulePayload(rule, 'in')),
        outbound_rules: firewall.outbound.map((rule) => rulePayload(rule, 'out')),
      },
    });
    return true;
  }

  async apply(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig,
    expected: HostingFirewallObservation
  ): Promise<void> {
    const current = await this.inspect(resource, ownerKey, desired);
    if (current.fingerprint !== expected.fingerprint)
      throw new HostingProviderError(409, false, 'DigitalOcean firewall changed; refresh before saving again.');
    if (current.applying)
      throw new HostingProviderError(409, false, 'Wait for DigitalOcean firewall changes to finish.');
    const blockers = desired.enabled ? current.blockers : current.disableBlockers;
    if (blockers.length) throw new HostingProviderError(409, false, blockers.join(' '));
    if (!desired.enabled) {
      if (!current.firewall || !current.attachedOwned) return;
      await this.dependencies.request(`/v2/firewalls/${encodeURIComponent(current.firewall.id)}/droplets`, {
        method: 'DELETE',
        body: { droplet_ids: [Number(resource.remoteId)] },
      });
      return;
    }
    if (!current.firewall) {
      await this.dependencies.request('/v2/firewalls', {
        method: 'POST',
        body: {
          name: current.expectedName,
          droplet_ids: [Number(resource.remoteId)],
          tags: [],
          inbound_rules: current.inbound.map((rule) => rulePayload(rule, 'in')),
          outbound_rules: current.outbound.map((rule) => rulePayload(rule, 'out')),
        },
      });
      return;
    }
    if (
      !rulesEqual(current.firewall.inbound, current.inbound) ||
      !rulesEqual(current.firewall.outbound, current.outbound)
    ) {
      await this.dependencies.request(`/v2/firewalls/${encodeURIComponent(current.firewall.id)}`, {
        method: 'PUT',
        body: {
          name: current.expectedName,
          droplet_ids: current.attachedOwned ? [Number(resource.remoteId)] : [],
          tags: [],
          inbound_rules: current.inbound.map((rule) => rulePayload(rule, 'in')),
          outbound_rules: current.outbound.map((rule) => rulePayload(rule, 'out')),
        },
      });
    }
    if (!current.attachedOwned) {
      await this.dependencies.request(`/v2/firewalls/${encodeURIComponent(current.firewall.id)}/droplets`, {
        method: 'POST',
        body: { droplet_ids: [Number(resource.remoteId)] },
      });
    }
  }
}
