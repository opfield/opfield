import { describe, expect, it } from 'vitest';
import type { AppMember } from './app-members.service.js';
import { assertPromotionImageScopes } from './app-promotion-image-scopes.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const RESOURCE = 'access-1';

const targetMembers: AppMember[] = [
  {
    type: 'container',
    id: 'shop-prod',
    name: 'shop-prod',
    environmentId: 'prod',
    nodeIds: [NODE],
    nodeId: NODE,
    scopeResourceId: RESOURCE,
  },
  {
    type: 'deployment',
    id: DEPLOYMENT,
    name: 'api-prod',
    environmentId: 'prod',
    nodeIds: [NODE],
    nodeId: NODE,
    scopeResourceId: DEPLOYMENT,
  },
];

const container = {
  type: 'container',
  targetId: 'shop-prod',
  targetName: 'shop-prod',
  targetNodeId: NODE,
  promotable: true,
};
const deployment = {
  type: 'deployment',
  targetId: DEPLOYMENT,
  targetName: 'api-prod',
  targetNodeId: NODE,
  promotable: true,
};

describe('promotion image scopes', () => {
  it('refuses a container image change when only apps:promote and view are held', () => {
    const scopes = ['apps:promote', 'docker:containers:view', `docker:containers:edit:${NODE}/${RESOURCE}`];
    expect(() => assertPromotionImageScopes(scopes, [container], targetMembers)).toThrowError(
      /docker:containers:environment, docker:containers:secrets/
    );
  });

  it('allows it with edit, environment and secrets on that container, or on its node', () => {
    const on = (id: string) => ['edit', 'environment', 'secrets'].map((name) => `docker:containers:${name}:${id}`);
    expect(() => assertPromotionImageScopes(on(`${NODE}/${RESOURCE}`), [container], targetMembers)).not.toThrow();
    expect(() => assertPromotionImageScopes(on(NODE), [container], targetMembers)).not.toThrow();
  });

  it('does not accept the same scopes held on another container', () => {
    const scopes = ['edit', 'environment', 'secrets'].map((name) => `docker:containers:${name}:${NODE}/other`);
    expect(() => assertPromotionImageScopes(scopes, [container], targetMembers)).toThrowError(/Requires all of/);
  });

  it('checks a deployment target on the deployment id', () => {
    const own = ['edit', 'environment', 'secrets'].map((name) => `docker:containers:${name}:${NODE}/${DEPLOYMENT}`);
    expect(() => assertPromotionImageScopes(own, [deployment], targetMembers)).not.toThrow();
    expect(() => assertPromotionImageScopes(['docker:containers:edit'], [deployment], targetMembers)).toThrowError(
      /docker:containers:environment/
    );
  });

  it('ignores items that are skipped or are not containers and deployments', () => {
    expect(() =>
      assertPromotionImageScopes(
        [],
        [
          { ...container, promotable: false },
          { type: 'compose', targetId: 'p', targetName: 'p', targetNodeId: NODE, promotable: true },
          { type: 'pages', targetId: 'g', targetName: 'g', targetNodeId: null, promotable: true },
        ],
        targetMembers
      )
    ).not.toThrow();
  });

  it('refuses a container that is no longer a member unless the node is granted broadly', () => {
    expect(() => assertPromotionImageScopes([], [{ ...container, targetId: 'gone' }], [])).toThrowError(
      /Requires all of/
    );
    const broad = ['edit', 'environment', 'secrets'].map((name) => `docker:containers:${name}`);
    expect(() => assertPromotionImageScopes(broad, [{ ...container, targetId: 'gone' }], [])).not.toThrow();
  });
});
