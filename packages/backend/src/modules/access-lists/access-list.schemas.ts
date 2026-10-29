import { isIP } from 'node:net';
import { z } from 'zod';
import type { AccessRuleSelector } from '@/db/schema/access-lists.js';
import { AppError } from '@/middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * An IPv4/IPv6 address or a CIDR range with a prefix inside the family's bounds (`all` only with `allowAll`, the
 * literal of the legacy ipRules).
 *
 * Examples:
 *   192.168.1.0/24   10.0.0.1   ::1   2001:db8::/32   fe80::1
 */
export function isValidAccessListIpValue(value: string, { allowAll = false }: { allowAll?: boolean } = {}): boolean {
  if (value === 'all') return allowAll;
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const family = isIP(address);
  if (family === 0 || address.includes('%')) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const IpValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => isValidAccessListIpValue(value), 'Must be a valid IP address or CIDR range');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSignInMethod(value: string): boolean {
  return (
    ['opfield', 'password', 'basic', 'shared'].includes(value) ||
    (value.startsWith('idp:') && UUID_PATTERN.test(value.slice(4)))
  );
}

/** opfield, password, basic, shared, or idp:<identity provider id>. */
export const SignInMethodSchema = z
  .string()
  .trim()
  .refine(isSignInMethod, 'Must be opfield, password, basic, shared or idp:<identity provider id>');

// htpasswd lines are `username:hash`, and basic authentication sends `username:password`; a colon or control
// character in the username would corrupt both (RFC 7617 forbids ':' in user-ids).
const UsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^:\p{Cc}]+$/u, 'Username cannot contain ":" or control characters');

const RULE_SELECTORS = [
  'everyone',
  'ip',
  'email',
  'email_domain',
  'opfield_user',
  'opfield_group',
  'sso_group',
  'method',
  'service_token',
] as const satisfies readonly AccessRuleSelector[];

/** What each selector accepts as a value; `everyone` takes none. */
const RULE_VALUE_CHECKS: Record<AccessRuleSelector, { test: (value: string) => boolean; message: string }> = {
  everyone: { test: () => false, message: 'everyone takes no values' },
  ip: { test: (value) => isValidAccessListIpValue(value), message: 'must be an IP address or CIDR range' },
  email: { test: (value) => /^[^\s@]+@[^\s@]+$/.test(value), message: 'must be an email address' },
  email_domain: {
    test: (value) => /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value),
    message: 'must be a domain such as example.com, without @',
  },
  opfield_user: { test: (value) => UUID_PATTERN.test(value), message: 'must be an Opfield user id' },
  opfield_group: { test: (value) => UUID_PATTERN.test(value), message: 'must be an Opfield permission group id' },
  sso_group: { test: (value) => value.length <= 255, message: 'must be a group name up to 255 characters' },
  method: {
    test: (value) => value === 'service_token' || isSignInMethod(value),
    message: 'must be a sign-in method (opfield, password, basic, shared, idp:<id>) or service_token',
  },
  service_token: { test: (value) => UUID_PATTERN.test(value), message: 'must be a service token id' },
};

export const AccessRuleSchema = z
  .object({
    selector: z.enum(RULE_SELECTORS),
    values: z.array(z.string().trim().min(1).max(320)).max(500).default([]),
  })
  .superRefine((rule, ctx) => {
    if (rule.selector === 'everyone') {
      if (rule.values.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'everyone takes no values', path: ['values'] });
      }
      return;
    }
    if (rule.values.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${rule.selector} needs at least one value`,
        path: ['values'],
      });
      return;
    }
    const check = RULE_VALUE_CHECKS[rule.selector];
    rule.values.forEach((value, index) => {
      if (!check.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${value}" ${check.message}`, path: ['values', index] });
      }
    });
  })
  .transform((rule) => ({
    selector: rule.selector,
    // Email and domain matching ignores case; one spelling is stored.
    values: [
      ...new Set(
        rule.selector === 'email' || rule.selector === 'email_domain'
          ? rule.values.map((value) => value.toLowerCase())
          : rule.values
      ),
    ],
  }));

const RulesSchema = z.array(AccessRuleSchema).max(100);

const SkipIpRangesSchema = z
  .array(IpValueSchema)
  .max(500)
  .transform((values) => [...new Set(values)]);

/** Null: the default session length of the sign-in settings. */
const SessionTtlSchema = z
  .number()
  .int()
  .min(300)
  .max(365 * 24 * 3600)
  .nullable();

/** A user of the list's sign-in form and basic authentication; without a password an existing user keeps theirs. */
const UserInputSchema = z.object({ username: UsernameSchema, password: z.string().max(255).optional() });

function uniqueUsernames(users: { username: string }[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  users.forEach((user, index) => {
    if (seen.has(user.username)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `User "${user.username}" is listed twice`,
        path: [index, 'username'],
      });
    }
    seen.add(user.username);
  });
}

const UsersSchema = z.array(UserInputSchema).max(500).superRefine(uniqueUsernames);

// ---------------------------------------------------------------------------
// Legacy fields (before sign-in based lists), converted with the mapping of migration 0277
// ---------------------------------------------------------------------------

export const LegacyIpRuleSchema = z.object({
  type: z.enum(['allow', 'deny']),
  value: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => isValidAccessListIpValue(value, { allowAll: true }),
      'Must be a valid IP address, CIDR range, or "all"'
    ),
});

export const LEGACY_ACCESS_LIST_FIELDS = ['ipRules', 'basicAuthEnabled', 'basicAuthUsers'] as const;

const MODEL_FIELDS = [
  'signInMethods',
  'users',
  'sharedPassword',
  'skipIpRanges',
  'includeRules',
  'requireRules',
  'excludeRules',
  'sessionTtlSeconds',
] as const;

const legacyShape = {
  ipRules: z.array(LegacyIpRuleSchema).optional(),
  basicAuthEnabled: z.boolean().optional(),
  basicAuthUsers: UsersSchema.optional(),
};

const modelShape = {
  signInMethods: z
    .array(SignInMethodSchema)
    .max(20)
    .transform((methods) => [...new Set(methods)])
    .optional(),
  users: UsersSchema.optional(),
  /** Sets the shared password; null clears it; omitted keeps it. */
  sharedPassword: z.string().min(1).max(255).nullable().optional(),
  skipIpRanges: SkipIpRangesSchema.optional(),
  includeRules: RulesSchema.optional(),
  requireRules: RulesSchema.optional(),
  excludeRules: RulesSchema.optional(),
  sessionTtlSeconds: SessionTtlSchema.optional(),
};

/** A body speaks either the legacy fields or the sign-in fields: a mix has no single meaning. */
function oneModel(data: Record<string, unknown>, ctx: z.RefinementCtx) {
  const legacy = LEGACY_ACCESS_LIST_FIELDS.filter((field) => data[field] !== undefined);
  const model = MODEL_FIELDS.filter((field) => data[field] !== undefined);
  if (legacy.length > 0 && model.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${legacy.join(', ')} (legacy fields) cannot be combined with ${model.join(', ')}; send the sign-in fields only`,
      path: [legacy[0]!],
    });
  }
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export const CreateAccessListSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    /** Destination folder (null or omitted: ungrouped); needs acl:create there. */
    folderId: z.string().uuid().nullable().optional(),
    ...modelShape,
    ...legacyShape,
  })
  .superRefine(oneModel);

export const UpdateAccessListSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional().nullable(),
    ...modelShape,
    ...legacyShape,
  })
  .superRefine(oneModel);

// ---------------------------------------------------------------------------
// List query — pagination + search
// ---------------------------------------------------------------------------

export const AccessListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(255).optional(),
  /** Only the access lists in this folder (not its subfolders). */
  folderId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateAccessListInput = z.infer<typeof CreateAccessListSchema>;
export type UpdateAccessListInput = z.infer<typeof UpdateAccessListSchema>;
export type AccessListQuery = z.infer<typeof AccessListQuerySchema>;
export type AccessListUserInput = z.infer<typeof UserInputSchema>;
export type LegacyIpRule = z.infer<typeof LegacyIpRuleSchema>;

const ACCESS_LIST_FIELDS = ['name', 'description', ...MODEL_FIELDS, ...LEGACY_ACCESS_LIST_FIELDS] as const;

/**
 * A field the API would drop silently is refused and named instead. `folderId` is a create field (the destination
 * folder); an existing list changes folder through POST /api/access-lists/folders/move-access-lists.
 */
export function assertAccessListFields(body: unknown, { create = false }: { create?: boolean } = {}): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const fields: readonly string[] = create ? [...ACCESS_LIST_FIELDS, 'folderId'] : ACCESS_LIST_FIELDS;
  const unknown = Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length === 0) return;
  throw new AppError(
    400,
    'VALIDATION_ERROR',
    `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of ${create ? 'a new' : 'an'} access list (fields: ${fields.join(', ')}).${unknown.includes('folderId') ? ' Move an access list to another folder with POST /api/access-lists/folders/move-access-lists.' : ''}`,
    { unknownFields: unknown, fields: [...fields] }
  );
}
