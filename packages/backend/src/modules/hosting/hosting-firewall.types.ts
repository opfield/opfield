import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { HostingResourceSnapshot } from './hosting-provider.types.js';

const address = z
  .string()
  .trim()
  .max(64)
  .refine((value) => {
    const [ip, prefix, extra] = value.split('/');
    const version = isIP(ip!);
    return (
      !!version &&
      !ip!.includes('%') &&
      extra === undefined &&
      (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)))
    );
  }, 'Enter an IPv4/IPv6 address or CIDR');
const ports = z
  .string()
  .regex(/^(all|[1-9]\d{0,4}(-[1-9]\d{0,4})?)$/)
  .refine((value) => {
    if (value === 'all') return true;
    const [from, to = from] = value.split('-').map(Number);
    return from! <= to! && to! <= 65535;
  }, 'Ports must be between 1 and 65535');

export const HostingFirewallConfigSchema = z
  .object({
    enabled: z.boolean(),
    inboundPolicy: z.enum(['allow', 'deny']),
    outboundPolicy: z.enum(['allow', 'deny']),
    rules: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            direction: z.enum(['in', 'out']),
            action: z.enum(['allow', 'deny']),
            protocol: z.enum(['tcp', 'udp', 'icmp']),
            ports,
            addresses: z.array(address).min(1).max(16),
            description: z.string().trim().max(120),
          })
          .strict()
      )
      .max(40),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (new Set(config.rules.map((rule) => rule.id)).size !== config.rules.length)
      ctx.addIssue({ code: 'custom', path: ['rules'], message: 'Rule IDs must be unique' });
    for (const [index, rule] of config.rules.entries()) {
      if (
        [false, true].some(
          (ipv6) => rule.addresses.filter((address) => address.includes(':') === ipv6).join(',').length > 512
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'addresses'],
          message: 'Address list is too long; split it into separate rules',
        });
      if (rule.protocol === 'icmp' && rule.ports !== 'all')
        ctx.addIssue({ code: 'custom', path: ['rules', index, 'ports'], message: 'ICMP has no ports' });
    }
  });
export type HostingFirewallConfig = z.infer<typeof HostingFirewallConfigSchema>;
export type HostingFirewallRule = HostingFirewallConfig['rules'][number];
export const defaultHostingFirewall = (): HostingFirewallConfig => ({
  enabled: false,
  inboundPolicy: 'deny',
  outboundPolicy: 'allow',
  rules: [],
});

/** Opaque provider fingerprint is used for compare-before-write, never as authorization. */
export interface HostingFirewallObservation {
  fingerprint: string;
  enabled: boolean;
  matches: boolean;
  applying: boolean;
  remoteId: string | null;
  blockers: string[];
  /** Activation prerequisites do not necessarily prevent disabling or saving an off policy. */
  disableBlockers?: string[];
  observedAt: string;
}
export interface HostingFirewallAdapter {
  /** Cleanup only after VM absence is independently confirmed; checkpoint before destructive IO. */
  cleanup?(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    remoteId: string | null,
    dispatched: boolean,
    beforeDelete: (remoteId: string) => Promise<void>
  ): Promise<{ status: 'absent' | 'deleted' | 'preserved'; remoteId: string | null; reason?: string }>;
  read(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig
  ): Promise<HostingFirewallObservation>;
  /** Must refuse changed fingerprint or external/shared policy; never mutate another VM/host. */
  apply(
    resource: HostingResourceSnapshot,
    ownerKey: string,
    desired: HostingFirewallConfig,
    expected: HostingFirewallObservation
  ): Promise<void>;
  /**
   * Rewrites names/comments that older releases wrote on this VM's owned firewall objects to the
   * current form. Metadata only: never recreates a policy or changes its rules. Returns whether
   * anything was written, so the caller re-reads the observation.
   */
  migrateLegacyNames?(resource: HostingResourceSnapshot, ownerKey: string): Promise<boolean>;
}
export const HostingFirewallUpdateSchema = z
  .object({
    config: HostingFirewallConfigSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedFingerprint: z.string().min(1).max(128),
    acknowledgeConnectivityRisk: z.boolean(),
  })
  .strict();
export type HostingFirewallUpdate = z.infer<typeof HostingFirewallUpdateSchema>;
export interface HostingFirewallView {
  resourceId: string;
  revision: number;
  config: HostingFirewallConfig;
  status: 'loading' | 'pending' | 'applying' | 'ready' | 'failed';
  observation: HostingFirewallObservation | null;
  error: string | null;
  canEdit: boolean;
}
export function firewallFingerprint(value: unknown): string {
  // JSON object ordering is not provider state (nor stable across API workers).
  // Rule-array ordering remains significant for Proxmox's first-match semantics.
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, canonical(nested)])
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
