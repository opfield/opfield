import { z } from 'zod';
import { queryFlagOrFalse } from '@/lib/query-flag.js';

/** Query-string boolean (`true`/`1`); zod's coerce turns "false" into true. */
/**
 * The app member filters of a foldered resource list (databases, storage, Pages and their managed lists): the
 * normal lists leave app members out, an app's tabs ask for one app's members. `appId` wins over
 * `excludeAppMembers`. Every row carries `app` either way.
 */
export const appListQueryFields = {
  /** Leave out resources that belong to an app (the normal lists). */
  excludeAppMembers: z.preprocess(queryFlagOrFalse, z.boolean().optional()),
  /** Only the members of this app (any environment). */
  appId: z.string().uuid().optional(),
};
