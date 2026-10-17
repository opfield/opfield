import { createHash, randomBytes } from 'node:crypto';
import {
  firewallFingerprint,
  type HostingFirewallAdapter,
  type HostingFirewallConfig,
  type HostingFirewallObservation,
} from '../hosting-firewall.types.js';
import { HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';
import { disableProxmoxFirewall, restoreProxmoxFirewallBinding } from './proxmox-firewall-disable.js';

type Request = <T>(path: string, options?: HostingRequestOptions) => Promise<T>;
type PveConfig = Record<string, string | number | boolean | undefined>;
type PveRule = Record<string, string | number | undefined>;
type PveOptions = Record<string, string | number | boolean | undefined>;
type PveGroup = { group?: string; comment?: string; digest?: string };

export interface ProxmoxFirewallDependencies {
  request: Request;
  getResource(remoteId: string): Promise<HostingResourceSnapshot | null>;
}

type ManagedRule = {
  key: string;
  action: 'ACCEPT' | 'DROP';
  type: 'in' | 'out';
  proto: 'tcp' | 'udp' | 'icmp' | 'ipv6-icmp';
  source?: string;
  dest?: string;
  dport?: string;
  comment: string;
  legacyComment: string;
};
type Inspection = {
  fresh: HostingResourceSnapshot | null;
  base: string | null;
  token: string;
  wantedGroup: string;
  marker: string;
  legacyMarker: string;
  bindingComment: string;
  legacyBindingComment: string;
  blockers: string[];
  disableBlockers: string[];
  options: PveOptions | null;
  vmRules: PveRule[];
  ownBindings: PveRule[];
  wanted: PveGroup | null;
  groupRules: PveRule[];
  expectedRules: ManagedRule[];
  matches: boolean;
  fingerprint: string;
};

const EMPTY_RULES_DIGEST = createHash('sha1').digest('hex');

function groupName(ownerKey: string, remoteId: string, desired: HostingFirewallConfig): string {
  return `gwfw${createHash('sha256').update(JSON.stringify({ ownerKey, remoteId, desired })).digest('hex').slice(0, 10)}`;
}
function ownerToken(ownerKey: string, remoteId: string): string {
  return createHash('sha256').update(`${ownerKey}:${remoteId}`).digest('hex').slice(0, 12);
}
function comment(token: string, key?: string): string {
  return key ? `Opfield firewall ${token} ${key}` : `Opfield firewall ${token}`;
}
// legacy-name: the pre-2.12.1 Proxmox firewall group/rule comment — remove once every hosting resource was reconciled by 2.12.1+
function legacyComment(token: string, key?: string): string {
  return key ? `Gateway firewall ${token} ${key}` : `Gateway firewall ${token}`;
}
function enabled(rule: PveRule): boolean {
  return rule.enable === undefined || Number(rule.enable) !== 0;
}
function digest(items: PveRule[]): string {
  const value = items[0]?.digest;
  return typeof value === 'string' && value.length ? value : EMPTY_RULES_DIGEST;
}
function pvePort(ports: string): string | undefined {
  return ports === 'all' ? undefined : ports.replace('-', ':');
}
function compile(config: HostingFirewallConfig, token: string): ManagedRule[] {
  const fromConfig = config.rules.flatMap((rule) =>
    [false, true].flatMap((ipv6) => {
      const addresses = rule.addresses.filter((address) => address.includes(':') === ipv6).sort();
      if (!addresses.length) return [];
      return [
        {
          key: `rule-${rule.id}`,
          action: rule.action === 'allow' ? ('ACCEPT' as const) : ('DROP' as const),
          type: rule.direction,
          proto: rule.protocol === 'icmp' && ipv6 ? ('ipv6-icmp' as const) : rule.protocol,
          ...(rule.direction === 'in' ? { source: addresses.join(',') } : { dest: addresses.join(',') }),
          ...(rule.protocol === 'icmp' ? {} : { dport: pvePort(rule.ports) }),
          comment: comment(token, `rule-${rule.id}-${ipv6 ? '6' : '4'}`),
          legacyComment: legacyComment(token, `rule-${rule.id}-${ipv6 ? '6' : '4'}`),
        },
      ];
    })
  );
  const defaults: ManagedRule[] = [];
  for (const [direction, policy] of [
    ['in', config.inboundPolicy],
    ['out', config.outboundPolicy],
  ] as const) {
    if (policy !== 'allow') continue;
    for (const protocol of ['tcp', 'udp', 'icmp', 'ipv6-icmp'] as const)
      defaults.push({
        key: `default-${direction}-${protocol}`,
        action: 'ACCEPT',
        type: direction,
        proto: protocol,
        comment: comment(token, `default-${direction}-${protocol}`),
        legacyComment: legacyComment(token, `default-${direction}-${protocol}`),
      });
  }
  return [
    ...fromConfig.filter((rule) => rule.action === 'DROP'),
    ...fromConfig.filter((rule) => rule.action === 'ACCEPT'),
    ...defaults,
  ];
}
function sameRule(rule: PveRule, expected: ManagedRule): boolean {
  return (
    !rule.errors &&
    !rule.macro &&
    !rule.iface &&
    !rule.sport &&
    !rule['icmp-type'] &&
    enabled(rule) &&
    rule.type === expected.type &&
    rule.action === expected.action &&
    rule.proto === expected.proto &&
    (rule.source ?? undefined) === expected.source &&
    (rule.dest ?? undefined) === expected.dest &&
    (rule.dport ?? undefined) === expected.dport &&
    (rule.comment === expected.comment || rule.comment === expected.legacyComment)
  );
}
function hasPrivilege(permissions: Record<string, Record<string, number>>, path: string, privilege: string): boolean {
  // Permission values are propagation flags; zero is still a granted privilege.
  return Object.hasOwn(permissions[path] ?? {}, privilege);
}
function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
function completeBinding(rule: PveRule): boolean {
  return (
    !rule.errors &&
    !rule.iface &&
    !rule.macro &&
    !rule.proto &&
    !rule.source &&
    !rule.dest &&
    !rule.sport &&
    !rule.dport
  );
}
function explicitPolicyOptions(options: PveOptions): boolean {
  // PVE otherwise inserts DHCP/NDP accepts before user rules and an outbound RA drop.
  return Number(options.dhcp) === 0 && Number(options.ndp) === 0 && truthy(options.radv);
}
function ruleData(rule: ManagedRule): Record<string, string | number> {
  return {
    action: rule.action,
    type: rule.type,
    proto: rule.proto,
    ...(rule.source ? { source: rule.source } : {}),
    ...(rule.dest ? { dest: rule.dest } : {}),
    ...(rule.dport ? { dport: rule.dport } : {}),
    comment: rule.comment,
    enable: 1,
  };
}

export class ProxmoxFirewallAdapter implements HostingFirewallAdapter {
  /** VM firewall paths, by remote ID, whose owned objects a read on this instance found with legacy comments. */
  private readonly legacyNames = new Map<string, string>();
  constructor(private readonly dependencies: ProxmoxFirewallDependencies) {}

  private async clusterOptions(): Promise<PveOptions> {
    try {
      return await this.dependencies.request<PveOptions>('/cluster/firewall/options');
    } catch (error) {
      if (error instanceof HostingProviderError && (error.providerStatus === 401 || error.providerStatus === 403))
        throw new HostingProviderError(
          error.providerStatus,
          false,
          'Proxmox token lacks Sys.Audit on / to read whether the cluster firewall is enabled; Opfield will not enable it.'
        );
      throw error;
    }
  }

  private async rules(path: string): Promise<PveRule[]> {
    const rules = await this.dependencies.request<PveRule[]>(path);
    if (!Array.isArray(rules)) throw new HostingProviderError(502, false, 'Proxmox returned invalid firewall rules');
    return rules;
  }

  private async inspect(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig
  ): Promise<Inspection> {
    const fresh = await this.dependencies.getResource(resource.remoteId);
    const token = ownerToken(ownerKey, resource.remoteId);
    const groupPrefix = groupName(ownerKey, resource.remoteId, desired);
    let wantedGroup = `${groupPrefix}${randomBytes(2).toString('hex')}`;
    const marker = comment(token);
    const legacyMarker = legacyComment(token);
    const bindingComment = comment(token, 'binding');
    const legacyBindingComment = legacyComment(token, 'binding');
    const blockers: string[] = [];
    if (!fresh) {
      blockers.push('The selected Proxmox VM no longer exists.');
      return {
        fresh,
        base: null,
        token,
        wantedGroup,
        marker,
        legacyMarker,
        bindingComment,
        legacyBindingComment,
        blockers,
        disableBlockers: blockers,
        options: null,
        vmRules: [],
        ownBindings: [],
        wanted: null,
        groupRules: [],
        expectedRules: compile(desired, token),
        matches: false,
        fingerprint: firewallFingerprint({ resource: null }),
      };
    }
    if (resource.incarnation && fresh.incarnation && resource.incarnation !== fresh.incarnation)
      blockers.push('The selected Proxmox VM was recreated; refresh the resource before changing its firewall.');
    const base = `/nodes/${encodeURIComponent(fresh.location)}/${fresh.kind === 'ct' ? 'lxc' : 'qemu'}/${encodeURIComponent(resource.remoteId)}`;
    const clusterOptions = await this.clusterOptions();
    const [config, options, vmRules, groups, vmPermissions, rootPermissions] = await Promise.all([
      this.dependencies.request<PveConfig>(`${base}/config`),
      this.dependencies.request<PveOptions>(`${base}/firewall/options`),
      this.rules(`${base}/firewall/rules`),
      this.dependencies.request<PveGroup[]>('/cluster/firewall/groups'),
      this.dependencies.request<Record<string, Record<string, number>>>('/access/permissions', {
        query: { path: `/vms/${resource.remoteId}` },
      }),
      this.dependencies.request<Record<string, Record<string, number>>>('/access/permissions', {
        query: { path: '/' },
      }),
    ]);
    const managedGroups = groups.filter((group) => group.comment === marker || group.comment === legacyMarker);
    const expectedRules = compile(desired, token);
    const ownedGroups = [];
    for (const group of managedGroups) {
      if (!group.group) continue;
      ownedGroups.push({
        ...group,
        rules: await this.rules(`/cluster/firewall/groups/${encodeURIComponent(group.group)}`),
      });
    }
    const wanted =
      ownedGroups.find(
        (group) =>
          group.group!.startsWith(groupPrefix) &&
          group.rules.length === expectedRules.length &&
          group.rules.every((rule, index) => sameRule(rule, expectedRules[index]!))
      ) ?? null;
    if (wanted?.group) wantedGroup = wanted.group;
    const groupRules = wanted?.rules ?? [];
    const activeVmRules = vmRules.filter(enabled);
    const isBinding = (rule: PveRule) =>
      rule.type === 'group' && (rule.comment === bindingComment || rule.comment === legacyBindingComment);
    const ownBindings = vmRules.filter(isBinding);
    const legacyRule = (rule: PveRule) => String(rule.comment ?? '').startsWith(`${legacyMarker} `);
    if (
      ownedGroups.some((group) => group.comment === legacyMarker || group.rules.some(legacyRule)) ||
      ownBindings.some((rule) => rule.comment === legacyBindingComment)
    )
      this.legacyNames.set(resource.remoteId, base);
    else this.legacyNames.delete(resource.remoteId);
    const foreignVmRules = activeVmRules.filter((rule) => !isBinding(rule));
    const disableBlockers = [...blockers];
    if (foreignVmRules.length) blockers.push('The VM has active firewall rules or groups not owned by Opfield.');
    if (truthy(options.enable) && !ownBindings.length)
      blockers.push('An existing VM firewall is enabled without an Opfield-owned policy; it will not be overwritten.');
    if (ownBindings.some((binding) => !completeBinding(binding)))
      blockers.push('Opfield’s VM firewall binding is scoped or invalid; review it in Proxmox before applying rules.');
    const activeGroupRules = groupRules.filter(enabled);
    const foreignGroupRules = activeGroupRules.filter(
      (rule) => !String(rule.comment ?? '').startsWith(marker) && !String(rule.comment ?? '').startsWith(legacyMarker)
    );
    if (foreignGroupRules.length)
      blockers.push('Opfield’s target security group contains active rules not owned by Opfield.');
    const targetRulesMatch =
      activeGroupRules.length === expectedRules.length &&
      expectedRules.every((expected, index) => sameRule(activeGroupRules[index]!, expected));
    const nics = Object.entries(config).filter(([key]) => /^net\d+$/.test(key));
    const networkReady = nics.length > 0 && nics.every(([, value]) => String(value).split(',').includes('firewall=1'));
    if (!truthy(clusterOptions.enable))
      blockers.push('Proxmox cluster firewall is disabled; Opfield will not enable it.');
    if (!networkReady) blockers.push('Every Proxmox VM NIC must have firewall=1 before Opfield can apply filtering.');
    const vmPath = `/vms/${resource.remoteId}`;
    if (!hasPrivilege(vmPermissions, vmPath, 'VM.Config.Network')) {
      blockers.push(`Proxmox token lacks VM.Config.Network on ${vmPath}.`);
      if (ownBindings.length && (ownBindings.some(enabled) || (truthy(options.enable) && !foreignVmRules.length)))
        disableBlockers.push(`Proxmox token lacks VM.Config.Network on ${vmPath}.`);
    }
    if (!hasPrivilege(rootPermissions, '/', 'Sys.Modify'))
      blockers.push('Proxmox token lacks Sys.Modify required to stage the owned security group.');
    const optionsOwned =
      !truthy(options.enable) ||
      (options.policy_in === undefined || options.policy_in === 'DROP'
        ? options.policy_out === undefined || options.policy_out === 'DROP'
        : false);
    if (desired.enabled && !optionsOwned) blockers.push('The VM has firewall policy options not owned by Opfield.');
    const bindingMatches =
      ownBindings.length === 1 &&
      enabled(ownBindings[0]!) &&
      ownBindings[0]!.action === wantedGroup &&
      completeBinding(ownBindings[0]!);
    const matches = desired.enabled
      ? !!wanted &&
        targetRulesMatch &&
        bindingMatches &&
        truthy(options.enable) &&
        options.policy_in === 'DROP' &&
        options.policy_out === 'DROP' &&
        explicitPolicyOptions(options) &&
        !blockers.length
      : !ownBindings.some(enabled) && (!truthy(options.enable) || foreignVmRules.length > 0 || !ownBindings.length);
    const fingerprint = firewallFingerprint({
      resource: {
        remoteId: fresh.remoteId,
        incarnation: fresh.incarnation,
        location: fresh.location,
        kind: fresh.kind,
      },
      clusterEnabled: truthy(clusterOptions.enable),
      nics: nics.map(([key, value]) => [key, String(value)]),
      options,
      managedGroups: ownedGroups.sort((a, b) => a.group!.localeCompare(b.group!)),
      vmRules,
    });
    return {
      fresh,
      base,
      token,
      wantedGroup,
      marker,
      legacyMarker,
      bindingComment,
      legacyBindingComment,
      blockers,
      disableBlockers,
      options,
      vmRules,
      ownBindings,
      wanted,
      groupRules,
      expectedRules,
      matches,
      fingerprint,
    };
  }

  async read(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig
  ): Promise<HostingFirewallObservation> {
    try {
      const current = await this.inspect(resource, ownerKey, desired);
      const isEnabled = current.ownBindings.some(enabled) && truthy(current.options?.enable);
      return {
        fingerprint: current.fingerprint,
        enabled: isEnabled,
        matches: current.matches,
        applying: false,
        remoteId: current.wanted?.group ?? null,
        blockers: current.blockers,
        disableBlockers: current.disableBlockers,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!(error instanceof HostingProviderError) || (error.providerStatus !== 401 && error.providerStatus !== 403))
        throw error;
      const blockers = [
        error.message || 'Proxmox token cannot inspect VM firewall state or lacks VM.Audit/Sys.Audit permissions.',
      ];
      return {
        fingerprint: firewallFingerprint({ provider: 'proxmox', resource: resource.remoteId, blockers }),
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
   * Rewrites legacy comments on this VM's owned groups, their rules and its binding. Comments only:
   * groups are updated in place (`rename` to the same name), rule actions and order are untouched.
   */
  async migrateLegacyNames(resource: HostingResourceSnapshot, ownerKey: string): Promise<boolean> {
    // Only after a read of this VM found legacy comments; the caller fences the VM identity.
    const base = this.legacyNames.get(resource.remoteId);
    if (!base) return false;
    this.legacyNames.delete(resource.remoteId);
    const token = ownerToken(ownerKey, resource.remoteId);
    const marker = comment(token);
    const legacyMarker = legacyComment(token);
    const rewrite = (value: unknown) =>
      typeof value === 'string' && (value === legacyMarker || value.startsWith(`${legacyMarker} `))
        ? `${marker}${value.slice(legacyMarker.length)}`
        : null;
    let changed = false;
    const groups = await this.dependencies.request<PveGroup[]>('/cluster/firewall/groups');
    for (const group of groups) {
      if (!group.group || (group.comment !== marker && group.comment !== legacyMarker)) continue;
      if (group.comment === legacyMarker) {
        // Every cluster firewall write changes the shared digest: read it fresh for each update.
        const current = (await this.dependencies.request<PveGroup[]>('/cluster/firewall/groups')).find(
          (item) => item.group === group.group
        );
        if (current?.comment === legacyMarker) {
          // `rename` equal to `group` updates only the comment of the existing group.
          await this.dependencies.request('/cluster/firewall/groups', {
            method: 'POST',
            body: {
              group: group.group,
              rename: group.group,
              comment: marker,
              ...(typeof current.digest === 'string' ? { digest: current.digest } : {}),
            },
          });
          changed = true;
        }
      }
      const path = `/cluster/firewall/groups/${encodeURIComponent(group.group)}`;
      changed = (await this.rewriteRuleComments(path, rewrite)) || changed;
    }
    const binding = legacyComment(token, 'binding');
    changed =
      (await this.rewriteRuleComments(`${base}/firewall/rules`, (value) =>
        value === binding ? comment(token, 'binding') : null
      )) || changed;
    return changed;
  }

  /** One rule per request with a fresh digest; bounded by the legacy rules seen first. */
  private async rewriteRuleComments(path: string, rewrite: (value: unknown) => string | null): Promise<boolean> {
    const pending = (rules: PveRule[]) => rules.filter((rule) => typeof rule.pos === 'number' && rewrite(rule.comment));
    let rules = await this.rules(path);
    const limit = pending(rules).length;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const rule = pending(rules)[0];
      if (!rule) break;
      await this.dependencies.request(`${path}/${rule.pos}`, {
        method: 'PUT',
        body: { comment: rewrite(rule.comment)!, digest: digest(rules) },
      });
      rules = await this.rules(path);
    }
    return limit > 0;
  }

  private async stageGroup(current: Inspection) {
    if (!current.base) return;
    // Existing groups are immutable: another VM may reference them. An interrupted
    // staging attempt is abandoned; an explicit retry creates a fresh group.
    if (current.wanted) return;
    await this.dependencies.request('/cluster/firewall/groups', {
      method: 'POST',
      body: { group: current.wantedGroup, comment: current.marker },
    });
    const rulesPath = `/cluster/firewall/groups/${encodeURIComponent(current.wantedGroup)}`;
    for (const rule of [...current.expectedRules].reverse()) {
      const fresh = await this.rules(rulesPath);
      await this.dependencies.request(rulesPath, {
        method: 'POST',
        body: { ...ruleData(rule), pos: 0, digest: digest(fresh) },
      });
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
      throw new HostingProviderError(409, false, 'Proxmox firewall changed; refresh before saving again.');
    const blockers = desired.enabled ? current.blockers : current.disableBlockers;
    if (blockers.length) throw new HostingProviderError(409, false, blockers.join(' '));
    if (!current.base || !current.options)
      throw new HostingProviderError(
        409,
        false,
        'The selected Proxmox VM is no longer available for firewall changes.'
      );
    if (!desired.enabled) {
      if (current.matches) return;
      return disableProxmoxFirewall(
        { ...current, base: current.base, options: current.options },
        this.dependencies.request,
        this.rules.bind(this)
      );
    }
    if (current.ownBindings.length > 1)
      throw new HostingProviderError(409, false, 'Multiple Opfield firewall bindings require review.');
    await this.stageGroup(current);
    await this.assertStagedRules(current);
    const vmRules = await this.rules(`${current.base}/firewall/rules`);
    if (firewallFingerprint(vmRules) !== firewallFingerprint(current.vmRules))
      throw new HostingProviderError(409, false, 'VM firewall rules changed while staging the new policy.');
    const binding = current.ownBindings[0];
    await this.dependencies.request(`${current.base}/firewall/rules${binding ? `/${binding.pos}` : ''}`, {
      method: binding ? 'PUT' : 'POST',
      body: {
        action: current.wantedGroup,
        type: 'group',
        comment: current.bindingComment,
        enable: 1,
        ...(binding ? {} : { pos: 0 }),
        digest: digest(vmRules),
      },
    });
    let options: PveOptions;
    try {
      await this.assertStagedRules(current);
      const bound = (await this.rules(`${current.base}/firewall/rules`)).filter(enabled);
      if (
        bound.length !== 1 ||
        bound[0]!.type !== 'group' ||
        bound[0]!.action !== current.wantedGroup ||
        bound[0]!.comment !== current.bindingComment ||
        !completeBinding(bound[0]!)
      )
        throw new HostingProviderError(
          409,
          true,
          'VM firewall rules changed during policy binding; filtering was not enabled.'
        );
      options = await this.dependencies.request<PveOptions>(`${current.base}/firewall/options`);
      if (firewallFingerprint(options) !== firewallFingerprint(current.options))
        throw new HostingProviderError(
          409,
          true,
          'VM firewall options changed during policy application; review the current state.'
        );
    } catch (error) {
      if (binding && truthy(current.options.enable))
        await restoreProxmoxFirewallBinding(
          current.base,
          binding,
          current.wantedGroup,
          this.dependencies.request,
          this.rules.bind(this),
          current.bindingComment
        );
      throw error;
    }
    await this.dependencies.request(`${current.base}/firewall/options`, {
      method: 'PUT',
      body: {
        enable: 1,
        policy_in: 'DROP',
        policy_out: 'DROP',
        dhcp: 0,
        ndp: 0,
        radv: 1,
        ...(typeof options.digest === 'string' ? { digest: options.digest } : {}),
      },
    });
  }

  private async assertStagedRules(current: Inspection) {
    const rules = await this.rules(`/cluster/firewall/groups/${encodeURIComponent(current.wantedGroup)}`);
    if (
      rules.length !== current.expectedRules.length ||
      rules.some((rule, index) => !sameRule(rule, current.expectedRules[index]!))
    )
      throw new HostingProviderError(409, true, 'Staged firewall group changed; filtering was not enabled.');
  }
}
