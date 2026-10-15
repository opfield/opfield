import { z } from 'zod';
import { isValidCidr, normalizeIp } from '@/lib/ip-cidr.js';
import { hostingOrigin } from './hosting-http.js';
import { HOSTING_PROVIDERS } from './hosting-provider.types.js';
import { parseIpv4Range, parseVmidRange } from './proxmox-pool.js';

const identifier = z.string().trim().min(1).max(200);
const hostName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/);
const positiveInteger = z.number().int().positive().max(1_048_576);
const dnsServer = z
  .string()
  .trim()
  .refine((ip) => !!normalizeIp(ip), 'Invalid DNS server');
export const HostingProviderSchema = z.enum(HOSTING_PROVIDERS);

const ProxmoxProfileSchema = z
  .object({
    nodes: z.array(identifier).min(1).max(100),
    templateId: z.number().int().min(100).max(999_999_999).optional(),
    templateNode: identifier.optional(),
    storage: identifier,
    imageStorage: identifier.optional(),
    seedStorage: identifier.optional(),
    bridge: identifier,
    pool: identifier.optional(),
    cleanTemplate: z.boolean().default(false),
    network: z.enum(['dhcp', 'static']).default('dhcp'),
    gateway: z
      .string()
      .refine((ip) => !!normalizeIp(ip), 'Invalid gateway IP')
      .optional(),
    subnet: z.string().refine(isValidCidr, 'Invalid network CIDR').optional(),
    vmidRange: z
      .string()
      .trim()
      .min(1)
      .transform((value, ctx) => {
        try {
          return parseVmidRange(value).normalized;
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : 'Invalid VMID pool',
          });
          return z.NEVER;
        }
      })
      .optional(),
    ipRange: z.string().trim().min(1).optional(),
    vlan: z.number().int().min(1).max(4094).nullable().optional(),
    dnsServers: z.array(dnsServer).min(1).max(8).optional(),
    searchDomain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
      )
      .optional(),
    mtu: z.number().int().min(576).max(9000).optional(),
    firewall: z.boolean().optional(),
    defaultCpu: positiveInteger.optional(),
    defaultMemoryMb: positiveInteger.optional(),
    defaultDiskGb: positiveInteger.optional(),
    maxCpu: positiveInteger.optional(),
    maxMemoryMb: positiveInteger.optional(),
    maxDiskGb: positiveInteger.optional(),
  })
  .strict();

export const HostingSettingsSchema = z
  .object({
    kind: z.literal('hosting').default('hosting'),
    autoSyncEnabled: z.boolean().default(true),
    autoSyncIntervalSeconds: z.number().int().min(60).max(86400).default(300),
    resourceIds: z.array(identifier).max(1000).default([]),
    adoptionNodeIds: z.array(z.string().uuid()).max(1000).default([]),
    adoptionEnabled: z.boolean().default(true),
    tokenId: z
      .string()
      .trim()
      .max(200)
      .regex(/^[^\s=!]+@[^\s=!]+![^\s=!]+$/)
      .optional(),
    caCertificate: z.string().max(100_000).optional(),
    certificateFingerprint: z
      .string()
      .regex(/^(?:sha256:)?(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/)
      .optional(),
    clusterId: identifier.optional(),
    proxmoxHost: identifier.optional(),
    defaultLocation: identifier.optional(),
    defaultSize: identifier.optional(),
    defaultImage: identifier.optional(),
    proxmox: ProxmoxProfileSchema.optional(),
  })
  .strict();

const connectorFields = {
  provider: HostingProviderSchema,
  name: z.string().trim().min(1).max(255),
  baseUrl: z.string().url().max(1000),
  token: z.string().trim().min(1).max(16_384),
  enabled: z.boolean().default(true),
  settings: HostingSettingsSchema,
};

function validateConnection(
  value: {
    provider: z.infer<typeof HostingProviderSchema>;
    baseUrl: string;
    settings: z.infer<typeof HostingSettingsSchema>;
  },
  ctx: z.RefinementCtx,
  requireNewProfile: boolean
) {
  try {
    hostingOrigin(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseUrl'],
      message: 'Use the official provider HTTPS origin, or your Proxmox HTTPS origin',
    });
  }
  if (value.provider === 'proxmox' && !value.settings.tokenId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['settings'],
      message: 'Proxmox token ID is required',
    });
  }
  if (
    value.provider !== 'proxmox' &&
    (value.settings.caCertificate || value.settings.certificateFingerprint || value.settings.proxmox)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['settings'],
      message: 'Custom TLS and placement settings are only allowed for Proxmox',
    });
  }
  const pve = value.settings.proxmox;
  if (pve?.network === 'static' && (!pve.subnet || !pve.gateway)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['settings', 'proxmox'],
      message: 'Static addressing requires a subnet and gateway',
    });
  }
  if (pve?.network === 'static' && pve.subnet && pve.gateway) {
    if (!pve.ipRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settings', 'proxmox', 'ipRange'],
        message: 'Static addressing requires an IP pool',
      });
    } else {
      try {
        const ips = parseIpv4Range(pve.ipRange, pve.subnet, pve.gateway);
        if (pve.vmidRange && ips.ips.length < parseVmidRange(pve.vmidRange).ids.length)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['settings', 'proxmox', 'ipRange'],
            message: 'The IP pool must contain at least as many addresses as the VMID pool',
          });
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settings', 'proxmox', 'ipRange'],
          message: error instanceof Error ? error.message : 'Invalid IP pool',
        });
      }
    }
  }
  if (requireNewProfile && value.provider === 'proxmox') {
    if (!value.settings.proxmoxHost) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settings', 'proxmoxHost'],
        message: 'Select the physical Proxmox host',
      });
    }
    if (pve) {
      if (!pve.vmidRange) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settings', 'proxmox'],
          message: 'New Proxmox provisioning profiles require a VMID range',
        });
      }
      if (!pve.imageStorage || !pve.seedStorage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settings', 'proxmox'],
          message: 'Select import-capable image storage and ISO-capable bootstrap storage',
        });
      }
      if (value.settings.proxmoxHost && (pve.nodes.length !== 1 || pve.nodes[0] !== value.settings.proxmoxHost)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['settings', 'proxmox', 'nodes'],
          message: 'A Proxmox profile must target the selected physical host only',
        });
      }
    }
  }
}

export const CreateHostingConnectorSchema = z
  .object(connectorFields)
  .strict()
  .superRefine((value, ctx) => validateConnection(value, ctx, true));
export const UpdateHostingConnectorSchema = z
  .object({ ...connectorFields, token: connectorFields.token.optional() })
  .strict()
  .superRefine((value, ctx) => validateConnection(value, ctx, false));

export const DiscoverHostingConnectorSchema = z
  .object({
    connectorId: z.string().uuid().optional(),
    provider: z.literal('proxmox'),
    name: z.string().trim().min(1).max(255),
    baseUrl: z.string().url().max(1000),
    token: z.string().trim().min(1).max(16_384).optional(),
    enabled: z.literal(true),
    tlsMode: z.enum(['system', 'ca', 'pin']).optional(),
    settings: HostingSettingsSchema.partial().strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.connectorId && (!value.token || !value.settings.tokenId))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['settings', 'tokenId'],
        message: 'A Proxmox token and token ID are required for a new connection',
      });
    try {
      hostingOrigin(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Use a Proxmox HTTPS origin' });
    }
  });

const confirmedHostingPrice = z
  .object({
    amount: z
      .string()
      .trim()
      .max(128, 'Provider quote amount is too long')
      .regex(/^\d+(?:\.\d+)?$/, 'Provider quote amount must be a non-negative decimal'),
    currency: z.string().regex(/^[A-Z]{3}$/, 'Provider quote currency must be a three-letter currency code'),
  })
  .strict();

export const HostingProvisionSchema = z
  .object({
    connectorId: z.string().uuid(),
    folderId: z.string().uuid().nullable().optional(),
    idempotencyKey: z.string().uuid(),
    name: hostName,
    displayName: z.string().trim().min(1).max(255).optional(),
    role: z.enum(['nginx', 'docker', 'builder', 'databases', 'storage', 'monitoring', 'relay']),
    location: identifier,
    size: identifier,
    image: identifier,
    cpu: positiveInteger.optional(),
    memoryMb: positiveInteger.optional(),
    diskGb: positiveInteger.optional(),
    ipAddress: z
      .string()
      .refine((ip) => !!normalizeIp(ip), 'Invalid interface address')
      .optional(),
    relayAddress: z.string().trim().min(1).max(255).optional(),
    confirmedPrice: confirmedHostingPrice.optional(),
    /** Existing-resource installation is a separate explicit operation, never implicit adoption. */
    existingResourceId: z.string().uuid().optional(),
    sshConnectorId: z.string().uuid().optional(),
  })
  .strict();

export const HostingActionSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    action: z.enum(['start', 'shutdown', 'reboot', 'resize', 'delete', 'recover']),
    confirmedPrice: confirmedHostingPrice.optional(),
    expectedIncarnation: z.string().min(1).max(1000),
    size: identifier.optional(),
    cpu: positiveInteger.optional(),
    memoryMb: positiveInteger.optional(),
    diskGb: positiveInteger.optional(),
    confirmed: z.literal(true),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action === 'resize' && !input.size && !input.cpu && !input.memoryMb && !input.diskGb) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Select the new size or resources' });
    }
  });

export type CreateHostingConnectorInput = z.infer<typeof CreateHostingConnectorSchema>;
export type UpdateHostingConnectorInput = z.infer<typeof UpdateHostingConnectorSchema>;
export type DiscoverHostingConnectorInput = z.infer<typeof DiscoverHostingConnectorSchema>;
export type HostingProvisionInput = z.infer<typeof HostingProvisionSchema>;
export type HostingActionInput = z.infer<typeof HostingActionSchema>;

export const HostingAdoptSchema = z.object({ resourceId: z.string().uuid(), nodeId: z.string().uuid() }).strict();
