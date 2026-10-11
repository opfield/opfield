import { z } from 'zod';

/** Query-string boolean (`true`/`1`); zod's coerce turns "false" into true. */
function queryFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return value === true || value === 'true' || value === '1';
}

/**
 * The app member filters of a foldered resource list (databases, storage, Pages and their managed lists): the
 * normal lists leave app members out, an app's tabs ask for one app's members. `appId` wins over
 * `excludeAppMembers`. Every row carries `app` either way.
 */
export const appListQueryFields = {
  /** Leave out resources that belong to an app (the normal lists). */
  excludeAppMembers: z.preprocess(queryFlag, z.boolean().optional()),
  /** Only the members of this app (any environment). */
  appId: z.string().uuid().optional(),
};
