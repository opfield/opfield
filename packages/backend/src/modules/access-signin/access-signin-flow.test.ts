import 'reflect-metadata';
import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccessDecide } from './access-decision.js';
import { MemorySessionStore, MemorySigningKeyStore, testCrypto } from './access-signin.test-support.js';
import type { AccessListRow, AccessSignInDirectory } from './access-signin-directory.js';
import { AccessSignInFlowService, type AccessSignInTarget } from './access-signin-flow.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';

const LIST_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_NODE_ID = '44444444-4444-4444-8444-444444444444';
const target = (host: string, nodeId = NODE_ID): AccessSignInTarget => ({
  listId: LIST_ID,
  host,
  nodeId,
  clientIp: '203.0.113.9',
  userAgent: 'test',
});

let list: AccessListRow;

beforeAll(async () => {
  list = {
    id: LIST_ID,
    name: 'Support',
    description: null,
    signInMethods: ['password', 'opfield', 'basic'],
    users: [{ username: 'lena.novak', passwordHash: await bcrypt.hash('correct horse', 4) }],
    sharedPasswordHash: null,
    skipIpRanges: [],
    includeRules: [{ selector: 'everyone', values: [] }],
    requireRules: [],
    excludeRules: [],
    sessionTtlSeconds: 3600,
    createdById: '22222222-2222-4222-8222-222222222222',
    createdAt: new Date(),
    updatedAt: new Date(),
    folderId: null,
    sortOrder: 0,
  };
});

function setup(decide: AccessDecide = (_list, _request, identity) => (identity ? 'allow' : 'redirect')) {
  const directory: AccessSignInDirectory = {
    getList: async (id) => (id === LIST_ID ? list : null),
    // Only app.example.com on NODE_ID is a route protected by the list.
    hostOfList: async (listId, host, nodeId) =>
      listId === LIST_ID && host === 'app.example.com' && nodeId === NODE_ID ? { secure: true } : null,
    getOpfieldUser: async () => null,
    providerNames: async () => new Map(),
  };
  const sessions = new MemorySessionStore();
  const keys = new AccessSigningKeyService(new MemorySigningKeyStore(), testCrypto);
  const settings = { getConfig: async () => ({ defaultSessionTtlSeconds: 86_400 }) };
  const flow = new AccessSignInFlowService({ directory, sessions, keys, settings, decide });
  return { flow, keys, sessions };
}

describe('access sign-in on the route', () => {
  it('issues a host token valid only for the route host the asking node serves', async () => {
    const { flow, keys, sessions } = setup();
    const signed = await flow.signInWithPassword(target('APP.example.com'), ' lena.novak ', 'correct horse');
    const payload = await keys.verify(signed.token, 'app.example.com');
    expect(payload).toMatchObject({ aud: 'app.example.com', idn: { m: 'password', sub: 'lena.novak', lst: LIST_ID } });
    expect(payload!.non).toBeUndefined();
    expect(payload!.exp - payload!.iat).toBe(3600);
    expect(await keys.verify(signed.token, 'evil.example.com')).toBeNull();
    // The session is recorded with the visitor the daemon saw.
    const [session] = [...sessions.rows.values()];
    expect(session).toMatchObject({ method: 'password', accessListId: LIST_ID, clientIp: '203.0.113.9' });
  });

  it('refuses hosts, lists and nodes that do not serve the route, without creating a session', async () => {
    const { flow, sessions } = setup();
    for (const bad of [
      target('evil.example.com'),
      target('app.example.com', OTHER_NODE_ID),
      { ...target('app.example.com'), listId: '55555555-5555-4555-8555-555555555555' },
      target('app.example.com:8443'),
    ]) {
      await expect(flow.signInWithPassword(bad, 'lena.novak', 'correct horse')).rejects.toMatchObject({
        statusCode: 403,
        code: 'ACCESS_DENIED',
      });
      await expect(flow.methods(bad)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    }
    expect(sessions.rows.size).toBe(0);
  });

  it('rejects a wrong password and offers only sign-in page methods', async () => {
    const { flow } = setup();
    await expect(flow.signInWithPassword(target('app.example.com'), 'lena.novak', 'wrong')).rejects.toMatchObject({
      statusCode: 401,
      code: 'ACCESS_SIGN_IN_FAILED',
    });
    await expect(flow.signInWithSharedPassword(target('app.example.com'), 'x')).rejects.toMatchObject({
      code: 'ACCESS_METHOD_NOT_OFFERED',
    });
    expect(await flow.methods(target('app.example.com'))).toEqual([
      { key: 'password', label: 'Username', kind: 'password' },
      { key: 'opfield', label: 'Opfield', kind: 'opfield' },
    ]);
  });

  it('signs in nobody the list turns away', async () => {
    const { flow, sessions } = setup(() => 'deny');
    await expect(
      flow.signInWithPassword(target('app.example.com'), 'lena.novak', 'correct horse')
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCESS_DENIED' });
    expect(sessions.rows.size).toBe(0);
  });
});
