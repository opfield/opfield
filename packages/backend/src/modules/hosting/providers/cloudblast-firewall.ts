import { createHash } from 'node:crypto';
import {
  firewallFingerprint,
  type HostingFirewallAdapter,
  type HostingFirewallConfig,
  type HostingFirewallObservation,
} from '../hosting-firewall.types.js';
import { HostingProviderError } from '../hosting-http.js';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';
import {
  type CloudBlastApi,
  id,
  mutationResponse,
  number,
  optionalString,
  record,
  string,
  unsafe,
  values,
} from './cloudblast-api.js';

/** Comparable rule shape. Order matters: CloudBlast applies rules in ascending priority, first match wins. */
type Rule = {
  direction: 'in' | 'out';
  action: 'ACCEPT' | 'DROP';
  protocol: string;
  address: string | null;
  port: string | null;
};
type RemoteRule = Rule & { id: string; priority: number; supported: boolean };
type Group = { id: string; name: string; servers: string[]; rules: RemoteRule[] };

const PROTOCOLS = ['tcp', 'udp', 'icmp', 'ipv6-icmp'] as const;

function ownedName(ownerKey: string, remoteId: string): string {
  // Security group names are limited to 30 characters.
  return `gw-fw-${createHash('sha256').update(`${ownerKey}:${remoteId}`).digest('hex').slice(0, 20)}`;
}
function canonical(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}
function parseRule(value: unknown): RemoteRule {
  const rule = record(value);
  const direction = rule.type === 'inbound' ? 'in' : rule.type === 'outbound' ? 'out' : unsafe();
  const action = string(rule.action).toUpperCase();
  const protocol = string(rule.protocol).toLowerCase();
  const source = canonical(optionalString(rule.source));
  const destination = canonical(optionalString(rule.destination));
  const address = direction === 'in' ? source : destination;
  const crossAddress = direction === 'in' ? destination : source;
  // Selectors Gateway does not model could broaden or narrow an owned rule unnoticed.
  const supported =
    (action === 'ACCEPT' || action === 'DROP') &&
    crossAddress === null &&
    optionalString(rule.source_port) === null &&
    (PROTOCOLS as readonly string[]).includes(protocol);
  return {
    id: id(rule.id),
    priority: number(rule.priority) ?? 0,
    direction,
    action: action === 'ACCEPT' ? 'ACCEPT' : 'DROP',
    protocol,
    address,
    port: canonical(optionalString(rule.destination_port))?.replace('-', ':') ?? null,
    supported,
  };
}
function parseGroup(value: unknown): Group {
  const group = record(value);
  const rules = values(group.rules).map(parseRule);
  rules.sort((left, right) => left.priority - right.priority || Number(left.id) - Number(right.id));
  return {
    id: id(group.id),
    name: string(group.name),
    servers: values(group.servers)
      .map((server) => string(record(server).uuid).toLowerCase())
      .sort(),
    rules,
  };
}
function comparable(rule: Rule): Rule {
  return {
    direction: rule.direction,
    action: rule.action,
    protocol: rule.protocol,
    address: rule.address,
    port: rule.port,
  };
}
function sameRules(left: Rule[], right: Rule[]): boolean {
  return JSON.stringify(left.map(comparable)) === JSON.stringify(right.map(comparable));
}
/** Explicit catch-alls keep the Gateway policy independent of the provider's default firewall policy. */
function compile(config: HostingFirewallConfig): Rule[] {
  const configured = config.rules.flatMap((rule) =>
    [...rule.addresses].sort().map(
      (address): Rule => ({
        direction: rule.direction,
        action: rule.action === 'allow' ? 'ACCEPT' : 'DROP',
        protocol: rule.protocol === 'icmp' && address.includes(':') ? 'ipv6-icmp' : rule.protocol,
        address: address.toLowerCase(),
        port: rule.protocol === 'icmp' || rule.ports === 'all' ? null : rule.ports.replace('-', ':'),
      })
    )
  );
  const defaults = (['in', 'out'] as const).flatMap((direction) =>
    PROTOCOLS.map(
      (protocol): Rule => ({
        direction,
        action: (direction === 'in' ? config.inboundPolicy : config.outboundPolicy) === 'allow' ? 'ACCEPT' : 'DROP',
        protocol,
        address: null,
        port: null,
      })
    )
  );
  return [
    ...configured.filter((rule) => rule.action === 'DROP'),
    ...configured.filter((rule) => rule.action === 'ACCEPT'),
    ...defaults,
  ];
}
function rulePayload(rule: Rule, priority: number) {
  return {
    type: rule.direction === 'in' ? 'inbound' : 'outbound',
    action: rule.action,
    protocol: rule.protocol,
    ...(rule.direction === 'in' ? { source: rule.address } : { destination: rule.address }),
    destination_port: rule.port,
    comment: 'Managed by Gateway',
    priority,
  };
}

export class CloudBlastFirewallAdapter implements HostingFirewallAdapter {
  constructor(
    private readonly api: CloudBlastApi,
    private readonly getResource: (remoteId: string) => Promise<HostingResourceSnapshot | null>
  ) {}

  private path(groupId: string, suffix = ''): string {
    return `/security-groups/${encodeURIComponent(groupId)}${suffix}`;
  }
  private async group(groupId: string): Promise<Group | null> {
    try {
      const group = parseGroup(await this.api.data(this.path(groupId)));
      return group.id === groupId ? group : unsafe();
    } catch (error) {
      if (error instanceof HostingProviderError && !error.outcomeUnknown && error.providerStatus === 404) return null;
      throw error;
    }
  }
  /** The list omits rules and attachments, so every non-empty or owned group is read in full. */
  private async groups(expectedName: string): Promise<Group[]> {
    const summaries = await this.api.array('/security-groups', record);
    const result: Group[] = [];
    for (const summary of summaries) {
      if (summary.name !== expectedName && number(summary.vm_count) === 0) continue;
      const group = await this.group(id(summary.id));
      if (group) result.push(group);
    }
    return result;
  }

  private async inspect(resource: HostingResourceSnapshot, ownerKey: string, desired: HostingFirewallConfig) {
    const remoteId = resource.remoteId.toLowerCase();
    const fresh = await this.getResource(resource.remoteId);
    const expectedName = ownedName(ownerKey, resource.remoteId);
    const blockers: string[] = [];
    if (!fresh) blockers.push('The selected CloudBlast server no longer exists.');
    else if (resource.incarnation && fresh.incarnation && resource.incarnation !== fresh.incarnation)
      blockers.push('The selected CloudBlast server was recreated; refresh the resource before changing its firewall.');
    const all = await this.groups(expectedName);
    const owned = all.filter((group) => group.name === expectedName);
    const group = owned[0] ?? null;
    const disableBlockers = [...blockers];
    const ownershipBlockers: string[] = [];
    if (owned.length > 1) ownershipBlockers.push('Several CloudBlast security groups have Opfield’s ownership name.');
    if (group?.servers.some((server) => server !== remoteId))
      ownershipBlockers.push(
        'Opfield’s CloudBlast security group is attached to another server and will not be changed.'
      );
    const external = all.filter((item) => item.name !== expectedName && item.servers.includes(remoteId));
    if (external.length)
      blockers.push(
        `The server is attached to other CloudBlast security groups: ${external.map((item) => item.name).join(', ')}.`
      );
    if (group?.rules.some((rule) => !rule.supported))
      blockers.push(
        'Opfield’s CloudBlast security group contains rules Opfield cannot represent; review them in CloudBlast before applying rules.'
      );
    blockers.push(...ownershipBlockers);
    disableBlockers.push(...ownershipBlockers);
    const attached = !!group?.servers.includes(remoteId);
    const rules = compile(desired);
    const matches = desired.enabled
      ? !!group && attached && sameRules(group.rules, rules) && !blockers.length
      : !attached && !group?.servers.length;
    const fingerprint = firewallFingerprint({
      resource: fresh ? { remoteId: fresh.remoteId, incarnation: fresh.incarnation } : null,
      expectedName,
      owned: group && { id: group.id, servers: group.servers, rules: group.rules },
      attached: external.map((item) => ({ id: item.id, name: item.name, servers: item.servers })),
      blockers,
      disableBlockers,
    });
    return { group, expectedName, blockers, disableBlockers, attached, matches, fingerprint, rules };
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
        enabled: current.attached,
        matches: current.matches,
        // Rule changes are synchronized within the request; there is no pending state to observe.
        applying: false,
        remoteId: current.group?.id ?? null,
        blockers: current.blockers,
        disableBlockers: current.disableBlockers,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!(error instanceof HostingProviderError) || (error.providerStatus !== 401 && error.providerStatus !== 403))
        throw error;
      const blockers = ['CloudBlast token cannot read security groups.'];
      return {
        fingerprint: firewallFingerprint({ provider: 'cloudblast', resource: resource.remoteId, blockers }),
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

  async apply(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig,
    expected: HostingFirewallObservation
  ): Promise<void> {
    const current = await this.inspect(resource, ownerKey, desired);
    if (current.fingerprint !== expected.fingerprint)
      throw new HostingProviderError(409, false, 'CloudBlast security group changed; refresh before saving again.');
    const blockers = desired.enabled ? current.blockers : current.disableBlockers;
    if (blockers.length) throw new HostingProviderError(409, false, blockers.join(' '));
    const server = { server_uuid: resource.remoteId };
    if (!desired.enabled) {
      // Detaching keeps the owned rules for a later re-enable.
      if (current.group && current.attached)
        await this.api.request(this.path(current.group.id, '/servers/detach'), { method: 'DELETE', body: server });
      return;
    }
    let group = current.group;
    if (!group) {
      const payload = await this.api.request('/security-groups', {
        method: 'POST',
        body: { name: current.expectedName, description: 'Managed by Gateway' },
      });
      const groupId = mutationResponse(() => id(record(record(payload).data).id));
      group = { id: groupId, name: current.expectedName, servers: [], rules: [] };
    }
    if (!sameRules(group.rules, current.rules)) {
      // Make before break: new rules are added first; older rules keep precedence on equal priority until removed.
      for (const [priority, rule] of current.rules.entries())
        await this.api.request(this.path(group.id, '/rules'), { method: 'POST', body: rulePayload(rule, priority) });
      for (const rule of group.rules)
        await this.api.request(this.path(group.id, `/rules/${encodeURIComponent(rule.id)}`), { method: 'DELETE' });
    }
    if (!current.attached)
      await this.api.request(this.path(group.id, '/servers/attach'), { method: 'POST', body: server });
  }

  /** Cleanup only after VM absence is independently confirmed; never delete a group still in use. */
  async cleanup(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    remoteId: string | null,
    dispatched: boolean,
    beforeDelete: (remoteId: string) => Promise<void>
  ): Promise<{ status: 'absent' | 'deleted' | 'preserved'; remoteId: string | null; reason?: string }> {
    const expectedName = ownedName(ownerKey, resource.remoteId);
    const assertVmAbsent = async () => {
      if ((await this.getResource(resource.remoteId)) !== null)
        throw new HostingProviderError(409, false, 'The VM still exists; its security group will not be deleted.');
    };
    await assertVmAbsent();
    if (!remoteId) {
      if (dispatched) return unsafe();
      const owned = (await this.groups(expectedName)).filter((group) => group.name === expectedName);
      if (owned.length > 1)
        throw new HostingProviderError(
          409,
          false,
          'Several security groups have the ownership name; cleanup needs review.'
        );
      remoteId = owned[0]?.id ?? null;
    }
    if (!remoteId) return { status: 'absent', remoteId: null };
    const targetId = remoteId;
    const check = (group: Group | null) => {
      if (!group) return { status: 'absent' as const, remoteId: targetId };
      if (group.name !== expectedName || group.servers.length)
        return {
          status: 'preserved' as const,
          remoteId: targetId,
          reason: 'Security group ownership changed or it is still attached; it was not deleted.',
        };
      return null;
    };
    const resolved = check(await this.group(targetId));
    if (resolved) return resolved;
    if (dispatched)
      throw new HostingProviderError(
        409,
        true,
        'VM deleted; security group deletion is unconfirmed and will not be repeated.'
      );
    await beforeDelete(targetId);
    await assertVmAbsent();
    const changed = check(await this.group(targetId));
    if (changed) return changed;
    await this.api.request(this.path(targetId), { method: 'DELETE' });
    return { status: 'deleted', remoteId: targetId };
  }
}
