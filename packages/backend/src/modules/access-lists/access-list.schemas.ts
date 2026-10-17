import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError } from '@/middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * nginx `allow`/`deny` accept an IPv4/IPv6 address, a CIDR range with a prefix
 * inside the family's bounds, or the literal `all`.
 *
 * Examples:
 *   192.168.1.0/24   10.0.0.1   ::1   2001:db8::/32   fe80::1   all
 */
export function isValidAccessListIpRuleValue(value: string): boolean {
  if (value === 'all') return true;
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const IPRuleSchema = z.object({
  type: z.enum(['allow', 'deny']),
  value: z
    .string()
    .trim()
    .min(1)
    .refine(isValidAccessListIpRuleValue, 'Must be a valid IP address, CIDR range, or "all"'),
});

// htpasswd lines are `username:hash`; a colon or control character in the
// username would corrupt the file (RFC 7617 forbids ':' in user-ids).
const BasicAuthUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^:\p{Cc}]+$/u, 'Username cannot contain ":" or control characters');

const BasicAuthUserInputSchema = z.object({
  username: BasicAuthUsernameSchema,
  password: z.string().min(1).max(255),
});

const UpdateBasicAuthUserInputSchema = z.object({
  username: BasicAuthUsernameSchema,
  password: z.string().max(255).optional(),
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const CreateAccessListSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    ipRules: z.array(IPRuleSchema).default([]),
    basicAuthEnabled: z.boolean().default(false),
    basicAuthUsers: z.array(BasicAuthUserInputSchema).default([]),
  })
  .superRefine((data, ctx) => {
    if (data.basicAuthEnabled && data.basicAuthUsers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Add at least one user to enable basic authentication',
        path: ['basicAuthUsers'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Update — partial version (all fields optional)
// ---------------------------------------------------------------------------

export const UpdateAccessListSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  ipRules: z.array(IPRuleSchema).optional(),
  basicAuthEnabled: z.boolean().optional(),
  basicAuthUsers: z.array(UpdateBasicAuthUserInputSchema).optional(),
});

// ---------------------------------------------------------------------------
// Move one IP rule — nginx checks the rules in order and the first match wins
// ---------------------------------------------------------------------------

export const MoveAccessListIpRuleSchema = z.object({
  fromIndex: z.number().int().min(0).describe('0-based position of the rule to move'),
  toIndex: z
    .number()
    .int()
    .min(0)
    .describe('0-based position the rule takes; the rules between shift by one (0 = checked first)'),
});

// ---------------------------------------------------------------------------
// List query — pagination + search
// ---------------------------------------------------------------------------

export const AccessListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(255).optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateAccessListInput = z.infer<typeof CreateAccessListSchema>;
export type UpdateAccessListInput = z.infer<typeof UpdateAccessListSchema>;
export type AccessListQuery = z.infer<typeof AccessListQuerySchema>;
export type MoveAccessListIpRuleInput = z.infer<typeof MoveAccessListIpRuleSchema>;

const ACCESS_LIST_FIELDS = ['name', 'description', 'ipRules', 'basicAuthEnabled', 'basicAuthUsers'] as const;

/** A field the API would drop silently (folderId: access lists have no folders) is refused and named instead. */
export function assertAccessListFields(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const unknown = Object.keys(body).filter((key) => !(ACCESS_LIST_FIELDS as readonly string[]).includes(key));
  if (unknown.length === 0) return;
  throw new AppError(
    400,
    'VALIDATION_ERROR',
    `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of an access list (fields: ${ACCESS_LIST_FIELDS.join(', ')}).${unknown.includes('folderId') ? ' Access lists have no folders.' : ''}`,
    { unknownFields: unknown, fields: [...ACCESS_LIST_FIELDS] }
  );
}
