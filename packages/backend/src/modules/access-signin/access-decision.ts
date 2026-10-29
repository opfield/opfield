import { evaluate } from '@/modules/access-lists/access-policy-evaluator.js';
import type { AccessListRow } from './access-signin-directory.js';
import type { AccessTokenIdentity } from './access-token.js';

/** The contract's Decision, the same in the nginx daemon and the backend. */
export type AccessDecision = 'allow' | 'deny' | 'basic' | 'redirect';

export type AccessDecide = (
  list: AccessListRow,
  request: { clientIp: string },
  identity: AccessTokenIdentity | null
) => AccessDecision;

/** The sign-in side asks the shared evaluator with the identity of the visitor's central session. */
export const decideAccess: AccessDecide = (list, request, identity) => evaluate(list, request, identity);
