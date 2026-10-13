import { describe, expect, it } from 'vitest';
import { createdResourceScopes } from './created-resource-scopes.js';
import { scopeResourceReferences } from './resource-scope-references.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';

describe('scope resource references', () => {
  it('names the node for every permission a node creator receives', () => {
    const scopes = createdResourceScopes('nodes', NODE);
    expect(scopes).toHaveLength(11);
    for (const scope of scopes) expect(scopeResourceReferences(scope)).toEqual([{ kinds: ['node'], id: NODE }]);
  });

  it('names the resource of each family by its own table', () => {
    expect(scopeResourceReferences(`proxy:edit:${CHILD}`)).toEqual([{ kinds: ['proxyHost'], id: CHILD }]);
    expect(scopeResourceReferences(`proxy:templates:manage:${CHILD}`)).toEqual([
      { kinds: ['proxyTemplate'], id: CHILD },
    ]);
    expect(scopeResourceReferences(`acl:delete:${CHILD}`)).toEqual([{ kinds: ['accessList'], id: CHILD }]);
    expect(scopeResourceReferences(`logs:read:${CHILD}`)).toEqual([{ kinds: ['loggingEnvironment'], id: CHILD }]);
    expect(scopeResourceReferences(`admin:groups:${CHILD}`)).toEqual([{ kinds: ['group'], id: CHILD }]);
    // Legacy creation grants name the target node.
    expect(scopeResourceReferences(`proxy:create:${NODE}`)).toEqual([{ kinds: ['node'], id: NODE }]);
  });

  it('names folders, nodes and hosting accounts by their qualifier prefix', () => {
    expect(scopeResourceReferences(`proxy:view:folder/${FOLDER}`)).toEqual([{ kinds: ['folder'], id: FOLDER }]);
    expect(scopeResourceReferences(`pages:view:node/${NODE}`)).toEqual([{ kinds: ['node'], id: NODE }]);
    expect(scopeResourceReferences(`integrations:hosting:view:account/${CHILD}`)).toEqual([
      { kinds: ['integrationConnector'], id: CHILD },
    ]);
  });

  it('names a Docker child and its node, but only the node for image and volume names', () => {
    expect(scopeResourceReferences(`docker:containers:manage:${NODE}/${CHILD}`)).toEqual([
      { kinds: ['node'], id: NODE },
      { kinds: ['dockerAccessResource', 'dockerDeployment', 'dockerComposeProject'], id: CHILD },
    ]);
    expect(scopeResourceReferences(`docker:volumes:view:${NODE}/${CHILD}`)).toEqual([{ kinds: ['node'], id: NODE }]);
    expect(scopeResourceReferences(`docker:images:view:${NODE}/sha256:abc`)).toEqual([{ kinds: ['node'], id: NODE }]);
  });

  it('never judges unqualified, wildcard, unknown or non-ID qualifiers', () => {
    for (const scope of [
      'nodes:manage',
      'proxy:view',
      'nodes:manage:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      'proxy:view:not-an-id',
      `pages:create:${NODE}`,
      'hosting:resources:view:provider/hetzner',
      `docker:registries:internal:pull:${NODE}`,
      `settings:opfield:edit:${NODE}`,
      `unknown:scope:${NODE}`,
    ]) {
      expect(scopeResourceReferences(scope), scope).toEqual([]);
    }
  });
});
