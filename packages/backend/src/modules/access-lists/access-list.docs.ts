import { appRoute, createdJson, IdParamSchema, jsonBody, okJson, UnknownDataResponseSchema } from '@/lib/openapi.js';
import {
  AccessListQuerySchema,
  CreateAccessListSchema,
  MoveAccessListIpRuleSchema,
  UpdateAccessListSchema,
} from './access-list.schemas.js';

const ACCESS_LIST_FIELDS_DESCRIPTION =
  'Who gets in: an address in excludeRules (selector ip) is denied first; an address in skipIpRanges gets in without signing in; everyone else signs in with one of signInMethods (opfield, password, basic, shared, idp:<identity provider id>) or sends a service token, and must match one includeRules entry and every requireRules entry and no excludeRules entry. users serve the password and basic methods ({ username, password }; an existing user sent without a password keeps theirs); sharedPassword sets the shared password (null clears it). The legacy fields ipRules, basicAuthEnabled and basicAuthUsers are still accepted on their own and converted; responses carry only the sign-in fields (usernames and sharedPasswordSet, never hashes).';

export const listAccessListsRoute = appRoute({
  method: 'get',
  path: '/',
  tags: ['Access Lists'],
  summary: 'List access lists',
  request: { query: AccessListQuerySchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const getAccessListRoute = appRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Access Lists'],
  summary: 'Get access list details',
  request: { params: IdParamSchema },
  responses: okJson(UnknownDataResponseSchema),
});

export const createAccessListRoute = appRoute({
  method: 'post',
  path: '/',
  tags: ['Access Lists'],
  summary: 'Create an access list',
  description: ACCESS_LIST_FIELDS_DESCRIPTION,
  request: jsonBody(CreateAccessListSchema),
  responses: createdJson(UnknownDataResponseSchema),
});

export const updateAccessListRoute = appRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Access Lists'],
  summary: 'Update an access list',
  description: `${ACCESS_LIST_FIELDS_DESCRIPTION} Omitted fields keep their value; users replaces the whole user list.`,
  request: { params: IdParamSchema, ...jsonBody(UpdateAccessListSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const moveAccessListIpRuleRoute = appRoute({
  method: 'post',
  path: '/{id}/ip-rules/move',
  tags: ['Access Lists'],
  summary: 'Move an IP rule to another position (legacy)',
  description:
    'For clients written before sign-in based access lists. Moves the rule at fromIndex to toIndex (0-based) in the ipRules the list has in the legacy fields (deny rules first, then allow rules; the first match wins) and saves the list as an update with those fields would. A list that uses sign-in methods or identity rules answers 409 ACCESS_LIST_NOT_LEGACY.',
  request: { params: IdParamSchema, ...jsonBody(MoveAccessListIpRuleSchema) },
  responses: okJson(UnknownDataResponseSchema),
});

export const deleteAccessListRoute = appRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Access Lists'],
  summary: 'Delete an access list',
  request: { params: IdParamSchema },
  responses: { 204: { description: 'No content' } },
});
