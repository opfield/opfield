import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import * as schema from '@/db/schema/index.js';
import { syncPermissionGroupsAtStartup } from '@/lib/startup-scope-sync.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { CloudLinkService } from './cloud-link.service.js';
import { createCloudLinkActions } from './cloud-link-actions.js';
import { CloudSsoClient } from './cloud-link-sso-client.js';

const url = process.env.OPFIELD_MIGRATION_TEST_DATABASE_URL;
const ISSUER = 'https://account.opfield.dev';
const REDIRECT = 'https://gw.example.com/auth/callback';
const SECRET = 'self-hosted-client-secret-5e1a';
const CLIENT = { issuer: ISSUER, clientId: 'gw-self', clientSecret: SECRET, redirectUri: REDIRECT };

/**
 * Opt-in (OPFIELD_MIGRATION_TEST_DATABASE_URL): a self-hosted installation connected to Opfield Cloud asks for an
 * Opfield account sign-in client through its hello, takes only the client it asked for, rotates its secret without
 * being managed, and drops the provider when the cloud link ends unless no administrator could sign in then.
 */
describe.skipIf(!url)('Opfield account sign-in client over the cloud link (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let crypto: CryptoService;
  const audit = vi.fn(async (_entry: Record<string, unknown>) => undefined);
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const steps = () =>
    audit.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === 'cloud.managed_sso')
      .map((entry) => (entry.details as Record<string, unknown>).step);

  let cloud: CloudLinkService;
  let oidcSettings: OidcSettingsService;
  let authSettings: AuthSettingsService;
  let ssoClient: CloudSsoClient;
  // What the portal answers to a code (Switch account): a new agent of the account named here.
  let enrollAnswer: Record<string, string>;

  const enrol = async (managed = false) => {
    await q(
      `insert into settings (key, value, updated_at) values ('cloud:enrollment', $1, now())
             on conflict (key) do update set value = excluded.value`,
      [
        JSON.stringify({
          agentId: 'agent-1',
          secret: crypto.encryptString('agent-secret-0123456789'),
          portalUrl: 'https://account.opfield.dev',
          accountEmail: 'ada@example.com',
          enrolledAt: '2026-10-13T10:00:00.000Z',
          ...(managed ? { managed: true } : {}),
        }),
      ]
    );
  };
  const viewerGroupId = async () => {
    const [group] = await db
      .select({ id: schema.permissionGroups.id })
      .from(schema.permissionGroups)
      .where(eq(schema.permissionGroups.name, 'viewer'));
    return group!.id;
  };
  const adminGroupId = async () => {
    const [group] = await db
      .select({ id: schema.permissionGroups.id })
      .from(schema.permissionGroups)
      .where(eq(schema.permissionGroups.name, 'system-admin'));
    return group!.id;
  };

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'sso_client');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    await syncPermissionGroupsAtStartup(db, 'standard');
    crypto = new CryptoService(randomBytes(32).toString('hex'));
  }, 120_000);

  afterAll(async () => {
    container.reset();
    await database?.drop();
  });

  beforeEach(async () => {
    audit.mockClear();
    await q(`delete from users where oidc_subject is null or oidc_subject not like 'system:%'`);
    await q(`delete from settings where key like 'auth:%' or key like 'cloud:%'`);
    enrollAnswer = {
      agentId: 'agent-0002',
      secret: 'agent-secret-abcdefghijklmnop',
      accountEmail: 'other@example.com',
    };
    cloud = new CloudLinkService(
      db,
      crypto,
      { CLOUD_PORTAL_URL: 'https://account.opfield.dev', APP_VERSION: 'v2.12.1' },
      { getInstallationId: async () => 'installation-1', getInstallationName: () => 'gw' },
      null,
      (async (input: string | URL | Request) =>
        String(input).endsWith('/api/cloud/enroll')
          ? new Response(JSON.stringify({ data: enrollAnswer }), { status: 200 })
          : new Response('{}', { status: 200 })) as typeof fetch
    );
    cloud.setAuditService({ log: audit } as never);
    oidcSettings = new OidcSettingsService(db, crypto);
    authSettings = new AuthSettingsService(db);
    ssoClient = new CloudSsoClient({
      db,
      oidcSettings,
      authSettings,
      cloud,
      invalidateOidc: () => undefined,
    });
    cloud.setSignInDetacher((reason) => ssoClient.detach(reason));
    // A self-hosted installation: one administrator signing in with a password.
    await authSettings.updateConfig({ methods: { password: true, oidc: false } });
    await db
      .insert(schema.users)
      .values({ email: 'ops@example.com', name: 'Ops', authMethod: 'password', groupId: await adminGroupId() });
    await enrol();
  });

  it('asks through the hello and takes only the client it asked for', async () => {
    expect(await cloud.helloInfo()).not.toHaveProperty('ssoClientRequest');
    // Nobody asked: refused, nothing stored.
    await expect(ssoClient.accept(CLIENT)).rejects.toMatchObject({ code: 'SSO_CLIENT_NOT_REQUESTED' });

    const request = await cloud.requestSsoClient(REDIRECT, { userId: null });
    expect(await cloud.requestSsoClient(REDIRECT, { userId: null })).toEqual(request);
    expect(steps()).toEqual(['client_requested']);
    expect(await cloud.helloInfo()).toMatchObject({ ssoClientRequest: { redirectUri: REDIRECT } });

    await expect(
      ssoClient.accept({ ...CLIENT, redirectUri: 'https://elsewhere.example.com/auth/callback' })
    ).rejects.toMatchObject({ code: 'SSO_CLIENT_NOT_REQUESTED' });
    await expect(ssoClient.accept({ ...CLIENT, issuer: 'not a url' })).rejects.toMatchObject({
      code: 'INVALID_SSO_CLIENT',
    });
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);

    await expect(ssoClient.accept(CLIENT)).resolves.toEqual({ saved: true, applied: true });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      configured: true,
      issuer: `${ISSUER}/`,
      clientId: 'gw-self',
      redirectUri: REDIRECT,
      displayName: 'Opfield account',
      opfieldAccount: true,
    });
    expect((await authSettings.getConfig()).methods.oidc).toBe(true);
    expect(await cloud.helloInfo()).not.toHaveProperty('ssoClientRequest');
    expect(await oidcSettings.hasKeptOpfieldAccountClient()).toBe(true);
    const stored = await q(
      `select value::text from settings where key in ('auth:oidc', 'cloud:opfield_account_client')`
    );
    expect(stored.rows.map((row) => row.value).join()).not.toContain(SECRET);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET);
    expect(steps()).toEqual(['client_requested', 'client_received']);

    // The request is gone: the same client again is not taken.
    await expect(ssoClient.accept(CLIENT)).rejects.toMatchObject({ code: 'SSO_CLIENT_NOT_REQUESTED' });

    // A cancelled request is gone from the hello.
    await cloud.requestSsoClient('https://gw2.example.com/auth/callback', { userId: null });
    expect(await cloud.cancelSsoClientRequest({ userId: null })).toBe(true);
    expect(await cloud.helloInfo()).not.toHaveProperty('ssoClientRequest');
  });

  it('rotates the secret of the client on a self-hosted installation, and only for that client', async () => {
    container.registerInstance(CloudLinkService, cloud);
    container.registerInstance(OidcSettingsService, oidcSettings);
    container.registerInstance(AuthService, { invalidateOidcConfiguration: vi.fn() } as unknown as AuthService);
    const actions = createCloudLinkActions();

    // No client from the cloud yet.
    await expect(actions.ssoSecret('rotated-0001')).rejects.toMatchObject({
      code: 'OPFIELD_ACCOUNT_PROVIDER_MISSING',
    });

    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    await expect(actions.ssoSecret('rotated-secret-0002')).resolves.toEqual({ saved: true });
    expect((await oidcSettings.getPublicConfig()).clientSecretLast4).toBe('0002');
    expect((await oidcSettings.getOpfieldAccountClient())?.clientSecret).toBe('rotated-secret-0002');

    // The admin switched to their own provider: refused, nothing changes.
    await oidcSettings.saveConfig({
      issuer: 'https://id.customer.example',
      clientId: 'customer',
      clientSecret: 'customer-secret-0003',
      redirectUri: REDIRECT,
    });
    await expect(actions.ssoSecret('refused-0004')).rejects.toMatchObject({
      code: 'OPFIELD_ACCOUNT_PROVIDER_MISSING',
    });
    expect((await oidcSettings.getPublicConfig()).clientSecretLast4).toBe('0003');
    expect((await oidcSettings.getOpfieldAccountClient())?.clientSecret).toBe('rotated-secret-0002');
    container.reset();
  });

  it('drops the Opfield account sign-in when the installation disconnects', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);

    await cloud.disconnect({ userId: null });
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);
    expect((await authSettings.getConfig()).methods).toMatchObject({ oidc: false, password: true });
    expect(await oidcSettings.getOpfieldAccountClient()).toBeNull();
    expect(steps()).toContain('provider_removed');
    expect(await q(`select 1 from settings where key = 'cloud:sso_client_request'`)).toMatchObject({ rowCount: 0 });
  });

  it('drops the sign-in on disconnect even while members and deleted accounts are bound to it', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    // A team member signing in with the Opfield account, and a deleted one: neither keeps the dead provider.
    const groupId = await viewerGroupId();
    await db.insert(schema.users).values([
      {
        email: 'bob@example.com',
        name: 'Bob',
        authMethod: 'oidc',
        oidcSubject: 'account-bob',
        oidcIssuer: ISSUER,
        groupId,
      },
      {
        groupId,
        email: 'eve@example.com',
        name: 'Eve',
        authMethod: 'oidc',
        oidcSubject: 'account-eve',
        oidcIssuer: ISSUER,
        isBlocked: true,
        deletedAt: new Date(),
      },
    ]);

    await cloud.disconnect({ userId: null });
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);
    expect((await authSettings.getConfig()).methods).toMatchObject({ oidc: false, password: true });
    expect(steps()).toContain('provider_removed');
  });

  it('lets an administrator turn OIDC off while only deleted accounts are bound to it', async () => {
    await authSettings.updateConfig({ methods: { oidc: true } });
    await db.insert(schema.users).values({
      groupId: await viewerGroupId(),
      email: 'eve@example.com',
      name: 'Eve',
      authMethod: 'oidc',
      oidcSubject: 'account-eve',
      oidcIssuer: ISSUER,
      isBlocked: true,
      deletedAt: new Date(),
    });
    await expect(authSettings.updateConfig({ methods: { oidc: false } })).resolves.toBeDefined();
    expect((await authSettings.getConfig()).methods.oidc).toBe(false);
  });

  it('keeps the provider when the account disconnects and nobody else could sign in, and says so', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    // The only administrator now signs in with the Opfield account.
    await q(`update users set is_blocked = true where email = 'ops@example.com'`);
    await db.insert(schema.users).values({
      email: 'ada@example.com',
      name: 'Ada',
      authMethod: 'oidc',
      oidcSubject: 'account-ada',
      oidcIssuer: ISSUER,
      groupId: await adminGroupId(),
    });

    await cloud.markDisconnectedByAccount('agent-1');
    // It keeps signing in, but is no longer the cloud's.
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      configured: true,
      clientId: 'gw-self',
      opfieldAccount: false,
      detachedOpfieldAccount: 'cloud_disconnected',
    });
    expect((await authSettings.getConfig()).methods.oidc).toBe(true);
    const kept = audit.mock.calls
      .map(([entry]) => entry.details as Record<string, unknown>)
      .find((details) => details.step === 'provider_kept');
    expect(kept).toMatchObject({ reason: 'cloud_disconnected', errorCode: 'LAST_ADMIN_SIGN_IN' });
    expect(String(kept?.warning)).toContain('no administrator could sign in');
    // The kept cloud client is forgotten either way.
    expect(await oidcSettings.hasKeptOpfieldAccountClient()).toBe(false);
    expect(await oidcSettings.getOpfieldAccountClient()).toBeNull();
  });

  it('drops the sign-in of the previous account on Switch account, and asks the new one afresh', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    await cloud.requestSsoClient('https://gw2.example.com/auth/callback', { userId: null });

    await cloud.connect('CLD-7K3M-Q9TX', { userId: null });
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);
    expect((await authSettings.getConfig()).methods).toMatchObject({ oidc: false, password: true });
    expect(await oidcSettings.getOpfieldAccountClient()).toBeNull();
    const removed = audit.mock.calls
      .map(([entry]) => entry.details as Record<string, unknown>)
      .find((details) => details.step === 'provider_removed');
    expect(removed).toMatchObject({ reason: 'account_switched', clientId: 'gw-self' });
    // The pending request was for the previous account: gone, and the hello of the new agent carries none.
    expect(await cloud.helloInfo()).not.toHaveProperty('ssoClientRequest');
    expect(await q(`select 1 from settings where key = 'cloud:sso_client_request'`)).toMatchObject({ rowCount: 0 });
    // Use Opfield account asks the new account.
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await expect(ssoClient.accept({ ...CLIENT, clientId: 'gw-other' })).resolves.toEqual({
      saved: true,
      applied: true,
    });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({ clientId: 'gw-other', opfieldAccount: true });
  });

  it('keeps the provider on Switch account when nobody else could sign in, no longer as the cloud client', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    await q(`update users set is_blocked = true where email = 'ops@example.com'`);
    await db.insert(schema.users).values({
      email: 'ada@example.com',
      name: 'Ada',
      authMethod: 'oidc',
      oidcSubject: 'account-ada',
      oidcIssuer: ISSUER,
      groupId: await adminGroupId(),
    });

    await cloud.connect('CLD-7K3M-Q9TX', { userId: null });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      configured: true,
      clientId: 'gw-self',
      opfieldAccount: false,
      detachedOpfieldAccount: 'account_switched',
    });
    expect((await authSettings.getConfig()).methods.oidc).toBe(true);
    const kept = audit.mock.calls
      .map(([entry]) => entry.details as Record<string, unknown>)
      .find((details) => details.step === 'provider_kept');
    expect(kept).toMatchObject({ reason: 'account_switched', errorCode: 'LAST_ADMIN_SIGN_IN' });
    // The new account cannot rotate the previous account's client.
    await expect(oidcSettings.rotateOpfieldAccountSecret('rotated-0009')).rejects.toMatchObject({
      code: 'OPFIELD_ACCOUNT_PROVIDER_MISSING',
    });
    // Asking the new account replaces it once its client arrives, and the warning goes with it.
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept({ ...CLIENT, clientId: 'gw-other' });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      clientId: 'gw-other',
      opfieldAccount: true,
      detachedOpfieldAccount: null,
    });
  });

  it('keeps the sign-in when the same account connects again, and a managed installation cannot switch', async () => {
    await cloud.requestSsoClient(REDIRECT, { userId: null });
    await ssoClient.accept(CLIENT);
    enrollAnswer = { ...enrollAnswer, accountEmail: 'ADA@example.com' };
    await cloud.connect('CLD-7K3M-Q9TX', { userId: null });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({ clientId: 'gw-self', opfieldAccount: true });
    expect(await oidcSettings.hasKeptOpfieldAccountClient()).toBe(true);

    await enrol(true);
    await expect(cloud.connect('CLD-7K3M-Q9TX', { userId: null })).rejects.toMatchObject({ code: 'CLOUD_MANAGED' });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({ clientId: 'gw-self', opfieldAccount: true });
    expect(steps()).not.toContain('provider_removed');
  });

  it('keeps an unrequested client of a managed installation while the admin uses no Opfield account provider', async () => {
    await enrol(true);
    await expect(ssoClient.accept(CLIENT)).resolves.toEqual({ saved: true, applied: false });
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);
    expect(await oidcSettings.getOpfieldAccountClient()).toMatchObject({ clientId: 'gw-self' });
    expect(steps()).toEqual(['client_kept']);
  });
});
