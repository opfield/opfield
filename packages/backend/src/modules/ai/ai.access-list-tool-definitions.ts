import type { AIToolDefinition } from './ai.types.js';

const RULE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        enum: [
          'everyone',
          'ip',
          'email',
          'email_domain',
          'opfield_user',
          'opfield_group',
          'sso_group',
          'method',
          'service_token',
        ],
      },
      values: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Matches when any value matches. everyone: none. ip: IP or CIDR. email: addresses. email_domain: example.com (no @). opfield_user: user ids (list_users). opfield_group: permission group ids (list_groups). sso_group: group names from the identity provider. method: opfield, password, basic, shared, idp:<id>, service_token. service_token: service token ids.',
      },
    },
    required: ['selector'],
  },
};

const MODEL_PROPERTIES = {
  signInMethods: {
    type: 'array',
    items: { type: 'string' },
    description:
      'How visitors sign in: opfield (an Opfield account), password (sign-in form for users), basic (HTTP basic authentication for users; scripts send Authorization), shared (one password, set with sharedPassword), idp:<identity provider id> (Google or OIDC; topic access-sign-in). Empty: nobody signs in (only skipIpRanges and service tokens get in).',
  },
  users: {
    type: 'array',
    items: {
      type: 'object',
      properties: { username: { type: 'string' }, password: { type: 'string' } },
      required: ['username'],
    },
    description:
      'Users of the password and basic methods; replaces the whole list. An existing user sent without password keeps their password; a new user needs one.',
  },
  sharedPassword: {
    type: ['string', 'null'],
    description: 'Sets the password of the shared method; null clears it; omit to keep it.',
  },
  skipIpRanges: {
    type: 'array',
    items: { type: 'string' },
    description: 'IPs or CIDR ranges that get in without signing in (0.0.0.0/0 and ::/0: everyone).',
  },
  includeRules: {
    ...RULE_SCHEMA,
    description: 'A signed-in visitor or service token must match one of these (needed when signInMethods is set).',
  },
  requireRules: { ...RULE_SCHEMA, description: 'A signed-in visitor or service token must match every one of these.' },
  excludeRules: {
    ...RULE_SCHEMA,
    description: 'Turned away when any matches; an ip Exclude rule applies before skipIpRanges.',
  },
  sessionTtlSeconds: {
    type: ['number', 'null'],
    description: 'How long a sign-in lasts, 300 to 31536000 seconds; null: the default of the sign-in settings.',
  },
};

const MODEL_FIELDS_NOTE =
  'An address in an ip Exclude rule is denied; an address in skipIpRanges gets in; everyone else signs in with one of signInMethods (or sends a service token named by an Include rule) and needs one Include rule, every Require rule and no Exclude rule to match.';

export const ACCESS_LIST_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_access_lists',
    description:
      'List access lists (sign-in methods, Include/Require/Exclude rules, skip ranges; usernames only, sharedPasswordSet instead of the password). Each carries folderId (null: ungrouped) and sortOrder, in the order of the access list page (folders in tree order, then ungrouped); list_resource_folders with access_lists names the folders, manage_resource_folder moves lists between them.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        folderId: { type: 'string', description: 'Only the access lists in this folder (not its subfolders)' },
        page: { type: 'number' },
        limit: { type: 'number' },
      },
    },
    destructive: false,
    category: 'Access Lists',
    requiredScope: 'acl:view',
    invalidateStores: [],
  },
  {
    name: 'create_access_list',
    description: `Create an access list for routes and Pages projects. ${MODEL_FIELDS_NOTE} Read topic access-lists first.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Access list name' },
        description: { type: 'string', description: 'Optional description' },
        ...MODEL_PROPERTIES,
        folderId: {
          type: ['string', 'null'],
          description:
            'Destination access list folder UUID (list_resource_folders access_lists); omitted or null: ungrouped. acl:create on that folder is enough to create there.',
        },
      },
      required: ['name'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:create',
    invalidateStores: ['accessLists'],
  },
  {
    name: 'delete_access_list',
    description: 'Delete an access list. Refused while a route or a Pages project uses it: detach it from them first.',
    parameters: {
      type: 'object',
      properties: {
        accessListId: { type: 'string', description: 'Access list UUID to delete' },
      },
      required: ['accessListId'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:delete',
    invalidateStores: ['accessLists'],
  },
  {
    name: 'manage_access_list',
    description: `Get or update an access list. Operations: get; update (name, description and the sign-in fields; omitted fields keep their value, an array replaces the whole array). ${MODEL_FIELDS_NOTE} Routes and Pages previews that use the list follow the change.`,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'update'] },
        accessListId: { type: 'string' },
        name: { type: 'string' },
        description: { type: ['string', 'null'] },
        ...MODEL_PROPERTIES,
      },
      required: ['operation', 'accessListId'],
    },
    destructive: true,
    category: 'Access Lists',
    requiredScope: 'acl:view',
    invalidateStores: ['accessLists'],
  },
];
