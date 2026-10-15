import { z } from 'zod';
import { isValidNodeServiceAddress } from './node-service-address.js';

export const NODE_APPEARANCE_COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange'] as const;

const NodeServiceAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidNodeServiceAddress, 'Must be a valid IP address or hostname');

const NodeServiceAddressesSchema = z
  .array(NodeServiceAddressSchema)
  .max(10)
  .superRefine((addresses, context) => {
    const seen = new Set<string>();
    for (const [index, address] of addresses.entries()) {
      if (seen.has(address)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Service addresses must be unique',
          path: [index],
        });
      }
      seen.add(address);
    }
  });

export const CreateNodeSchema = z
  .object({
    type: z
      .enum(['nginx', 'bastion', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay'])
      .default('nginx'),
    hostname: z.string().min(1).max(255),
    displayName: z.string().max(255).optional(),
    folderId: z.string().uuid().nullable().optional(),
    serviceAddresses: NodeServiceAddressesSchema.optional(),
    servicePort: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((input, context) => {
    // The type stays in the enum for stored nodes and list filters; the Bastion daemon has no installer yet.
    if (input.type === 'bastion') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Bastion nodes are not available yet (the Bastion daemon is expected in Opfield 2.14); choose another node type',
        path: ['type'],
      });
    }
    if (input.type === 'relay' && !input.serviceAddresses?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Relay nodes require at least one advertised service address',
        path: ['serviceAddresses'],
      });
    }
    if (input.type !== 'relay' && (input.serviceAddresses !== undefined || input.servicePort !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Service address and port are accepted during creation only for relay nodes',
        path: ['serviceAddresses'],
      });
    }
  });

export const UpdateNodeSchema = z
  .object({
    displayName: z.string().max(255).nullable().optional(),
    appearanceColor: z.enum(NODE_APPEARANCE_COLORS).nullable().optional(),
    serviceAddresses: NodeServiceAddressesSchema.optional(),
    serviceAddress: NodeServiceAddressSchema.nullable().optional(),
    secondaryServiceAddress: NodeServiceAddressSchema.nullable().optional(),
    confirmDomainDnsUpdate: z.boolean().optional(),
    builderSettings: z
      .object({
        parallelism: z.number().int().min(1).max(16),
        timeoutMinutes: z.number().int().min(1).max(360),
      })
      .optional(),
  })
  .superRefine((input, context) => {
    if (
      input.serviceAddresses !== undefined &&
      (input.serviceAddress !== undefined || input.secondaryServiceAddress !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use serviceAddresses without legacy service address fields',
        path: ['serviceAddresses'],
      });
    }
  });

export const UpdateNodeServiceCreationLockSchema = z.object({
  serviceCreationLocked: z.boolean(),
});

export const NodeListQuerySchema = z.object({
  hosting: z.union([z.string().uuid(), z.literal('unmanaged')]).optional(),
  search: z.string().optional(),
  type: z.enum(['nginx', 'bastion', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay']).optional(),
  status: z.enum(['pending', 'online', 'offline', 'error']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;
export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;
export type UpdateNodeServiceCreationLockInput = z.infer<typeof UpdateNodeServiceCreationLockSchema>;
export type NodeListQuery = z.infer<typeof NodeListQuerySchema>;
