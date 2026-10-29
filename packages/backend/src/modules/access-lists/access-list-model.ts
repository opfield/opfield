import bcrypt from 'bcryptjs';
import type { AccessListUser, AccessRule, AccessSignInMethod, accessLists } from '@/db/schema/access-lists.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AccessListUserInput, CreateAccessListInput, UpdateAccessListInput } from './access-list.schemas.js';
import { LEGACY_ACCESS_LIST_FIELDS } from './access-list.schemas.js';
import { type AccessListRules, legacyAccessFieldsOf, legacyAccessRules } from './access-list-legacy.js';

const BCRYPT_ROUNDS = 10;

type AccessListRow = typeof accessLists.$inferSelect;

/** Who gets in: the columns an edit of a list writes (besides name and description). */
export interface AccessListModel extends AccessListRules {
  users: AccessListUser[];
  sharedPasswordHash: string | null;
  sessionTtlSeconds: number | null;
}

const EMPTY_MODEL: AccessListModel = {
  signInMethods: [],
  users: [],
  sharedPasswordHash: null,
  skipIpRanges: [],
  includeRules: [],
  requireRules: [],
  excludeRules: [],
  sessionTtlSeconds: null,
};

export function accessListModelOf(row: AccessListRow): AccessListModel {
  return {
    signInMethods: row.signInMethods ?? [],
    users: row.users ?? [],
    sharedPasswordHash: row.sharedPasswordHash ?? null,
    skipIpRanges: row.skipIpRanges ?? [],
    includeRules: row.includeRules ?? [],
    requireRules: row.requireRules ?? [],
    excludeRules: row.excludeRules ?? [],
    sessionTtlSeconds: row.sessionTtlSeconds ?? null,
  };
}

/**
 * The users after an edit: a user with a password gets it hashed, a user without one keeps their current password
 * (an unknown user without one is refused), a user left out is removed.
 */
async function nextUsers(input: AccessListUserInput[], current: AccessListUser[], legacy: boolean) {
  return Promise.all(
    input.map(async (user): Promise<AccessListUser> => {
      if (user.password) {
        return { username: user.username, passwordHash: await bcrypt.hash(user.password, BCRYPT_ROUNDS) };
      }
      const existing = current.find((candidate) => candidate.username === user.username);
      if (existing) return existing;
      throw new AppError(
        400,
        legacy ? 'BASIC_AUTH_PASSWORD_REQUIRED' : 'ACCESS_LIST_PASSWORD_REQUIRED',
        `Password required for ${legacy ? 'basic auth ' : ''}user "${user.username}"`
      );
    })
  );
}

function legacyRules(input: CreateAccessListInput | UpdateAccessListInput, current: AccessListModel | null) {
  const fields = current ? legacyAccessFieldsOf(current) : { ipRules: [], basicAuthEnabled: false };
  if (!fields && (input.ipRules === undefined || input.basicAuthEnabled === undefined)) {
    throw new AppError(
      409,
      'ACCESS_LIST_NOT_LEGACY',
      'This access list uses sign-in rules that ipRules and basicAuthEnabled cannot express: send both to replace them, or edit it with the sign-in fields (signInMethods, users, skipIpRanges, includeRules, requireRules, excludeRules)'
    );
  }
  return legacyAccessRules({
    ipRules: input.ipRules ?? fields!.ipRules,
    basicAuthEnabled: input.basicAuthEnabled ?? fields!.basicAuthEnabled,
  });
}

/**
 * The complete state of a list after a create (current null) or an update, validated before anything is written.
 * The legacy fields (ipRules, basicAuthEnabled, basicAuthUsers) are converted like migration 0277 converted stored
 * lists; one of them alone keeps the others as the list has them.
 */
export async function nextAccessListModel(
  input: CreateAccessListInput | UpdateAccessListInput,
  current: AccessListModel | null
): Promise<AccessListModel> {
  const base = current ?? EMPTY_MODEL;
  const legacy = LEGACY_ACCESS_LIST_FIELDS.some((field) => input[field] !== undefined);
  const rules: AccessListRules = legacy
    ? legacyRules(input, current)
    : {
        signInMethods: (input.signInMethods as AccessSignInMethod[] | undefined) ?? base.signInMethods,
        skipIpRanges: input.skipIpRanges ?? base.skipIpRanges,
        includeRules: (input.includeRules as AccessRule[] | undefined) ?? base.includeRules,
        requireRules: (input.requireRules as AccessRule[] | undefined) ?? base.requireRules,
        excludeRules: (input.excludeRules as AccessRule[] | undefined) ?? base.excludeRules,
      };
  const usersInput = legacy ? input.basicAuthUsers : input.users;
  const users = usersInput === undefined ? base.users : await nextUsers(usersInput, base.users, legacy);
  const sharedPasswordHash =
    input.sharedPassword === undefined
      ? base.sharedPasswordHash
      : input.sharedPassword === null
        ? null
        : await bcrypt.hash(input.sharedPassword, BCRYPT_ROUNDS);
  const model: AccessListModel = {
    ...rules,
    users,
    sharedPasswordHash,
    sessionTtlSeconds: input.sessionTtlSeconds === undefined ? base.sessionTtlSeconds : input.sessionTtlSeconds,
  };
  assertConsistent(model, legacy);
  return model;
}

function assertConsistent(model: AccessListModel, legacy: boolean): void {
  const methods = model.signInMethods;
  if (legacy && methods.includes('basic') && model.users.length === 0) {
    throw new AppError(400, 'BASIC_AUTH_USERS_REQUIRED', 'Add at least one user to enable basic authentication');
  }
  if ((methods.includes('password') || methods.includes('basic')) && model.users.length === 0) {
    throw new AppError(
      400,
      'ACCESS_LIST_USERS_REQUIRED',
      'Add at least one user: the username and password and the basic authentication sign-in check the list users'
    );
  }
  if (methods.includes('shared') && !model.sharedPasswordHash) {
    throw new AppError(400, 'SHARED_PASSWORD_REQUIRED', 'Set a shared password to offer the shared password sign-in');
  }
  if (methods.length > 0 && model.includeRules.length === 0) {
    throw new AppError(
      400,
      'ACCESS_LIST_INCLUDE_REQUIRED',
      'Add an Include rule (for example everyone): without one nobody who signs in gets in'
    );
  }
}

/**
 * The API shape of a list: usernames only and whether a shared password is set (hashes never leave the server).
 */
export function presentAccessList(row: AccessListRow) {
  const { users, sharedPasswordHash, ...rest } = row;
  return {
    ...rest,
    users: (users ?? []).map((user) => ({ username: user.username })),
    sharedPasswordSet: !!sharedPasswordHash,
  };
}

export type PresentedAccessList = ReturnType<typeof presentAccessList>;
