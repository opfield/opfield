import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { disposableDatabase, migrateDatabase } from '@/db/migration-database.test-helpers.js';
import type { OperationLeaseStore } from '@/db/operation-lease.js';
import * as schema from '@/db/schema/index.js';
import { syncPermissionGroupsAtStartup } from '@/lib/startup-scope-sync.js';
import { assertAdminSignInRemains } from '@/modules/auth/admin-sign-in-guard.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { AuthSettingsService } from '@/modules/auth/auth.settings.service.js';
import { OidcSettingsService } from '@/modules/auth/oidc-settings.service.js';
import { FinalizeSetupService } from '@/modules/onboarding/finalize-setup.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { SetupTokenPolicyService } from '@/modules/setup/setup-token-policy.js';
import { CryptoService } from '@/services/crypto.service.js';
import type { CloudLinkService } from './cloud-link.service.js';
import { CloudLinkEnrollFile, type EnrollFileLicense } from './cloud-link-enroll-file.js';
import { CloudManagedSso, type CloudManagedSsoDeps } from './cloud-link-managed-sso.js';

// The account portal as the identity provider: discovery and the code exchange answer what the portal would.
const idToken = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));
vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({ serverMetadata: () => ({}) })),
  randomPKCECodeVerifier: () => 'verifier',
  calculatePKCECodeChallenge: async () => 'challenge',
  randomState: () => 'state-1',
  buildAuthorizationUrl: (_config: unknown, parameters: Record<string, string>) =>
    new URL(`https://account.opfield.dev/oauth/authorize?${new URLSearchParams(parameters)}`),
  authorizationCodeGrant: vi.fn(async () => ({
    access_token: 'access',
    // The portal issues no refresh token.
    refresh_token: undefined,
    claims: () => idToken.claims,
  })),
}));

const url = process.env.GATEWAY_MIGRATION_TEST_DATABASE_URL;
const ISSUER = 'https://account.opfield.dev';
const SECRET = 'portal-client-secret-4b1f9e';
const OWNER = { sub: '0b6f3c8e-6a1e-4d43-9b8e-2b8d3c1f0a77', email: 'ada@example.com', name: 'Ada Owner' };
// The installer serves HTTPS on 3000: the port is part of the public URL and of the redirect URI.
const PUBLIC_URL = 'https://acme.opfield.cloud:3000';

/**
 * Opt-in (GATEWAY_MIGRATION_TEST_DATABASE_URL): a managed installation whose enrolment file carries the Opfield
 * account client and owner comes up set up: owner as system administrator, the provider, setup complete and the
 * secret out of the file, all or nothing; retries are idempotent; sign-in through the provider lands on the owner;
 * replacing the provider is refused while the owner is the only administrator.
 */
describe.skipIf(!url)('managed installation signed in with the Opfield account (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof disposableDatabase>>;
  let pool: pg.Pool;
  let db: DrizzleClient;
  let crypto: CryptoService;
  let dir: string;
  let path: string;
  const audit = vi.fn(async (_details: Record<string, unknown>) => undefined);
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  const services = () => ({
    oidcSettings: new OidcSettingsService(db, crypto),
    authSettings: new AuthSettingsService(db),
    generalSettings: new GeneralSettingsService(db),
    setupPolicy: new SetupTokenPolicyService(db, true),
    finalizeSetup: new FinalizeSetupService(db),
  });
  const managedSso = (overrides: Partial<CloudManagedSsoDeps> = {}) =>
    new CloudManagedSso({ db, ...services(), invalidateOidc: () => undefined, audit, ...overrides });

  const leases = {
    claim: vi.fn(async () => ({ acquired: true as const, token: 't', claimedAt: 0 })),
    release: vi.fn(async () => undefined),
  } as unknown as OperationLeaseStore;
  const cloud = (enroll: () => Promise<void> = async () => undefined) => {
    let enrolled = false;
    return {
      isEnrolled: vi.fn(async () => enrolled),
      connect: vi.fn(async () => {
        await enroll();
        enrolled = true;
      }),
      recordEnrollFileEvent: vi.fn(async () => undefined),
      recordLicenseActivation: vi.fn(async () => undefined),
      recordManagedSso: audit,
    } as unknown as CloudLinkService;
  };
  const noLicense = {} as EnrollFileLicense;
  const enrollFile = (sso: CloudManagedSso, service = cloud()) => {
    const runner = new CloudLinkEnrollFile(service, leases, noLicense, path);
    runner.setManagedSso(sso);
    return runner;
  };
  const writeEnrollFile = (extra: Record<string, unknown> = {}) =>
    writeFile(
      path,
      JSON.stringify({
        code: 'CLD-7K3M-Q9TX',
        publicUrl: PUBLIC_URL,
        sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
        owner: OWNER,
        ...extra,
      })
    );
  const exists = (file: string) =>
    readFile(file).then(
      () => true,
      () => false
    );
  const users = () => db.select().from(schema.users).where(eq(schema.users.email, OWNER.email));

  beforeAll(async () => {
    database = await disposableDatabase(url!, 'managed_sso');
    pool = database.pool;
    await migrateDatabase(pool);
    db = drizzle(pool, { schema });
    await syncPermissionGroupsAtStartup(db, 'standard');
    crypto = new CryptoService(randomBytes(32).toString('hex'));
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  beforeEach(async () => {
    audit.mockClear();
    dir = await mkdtemp(join(tmpdir(), 'managed-sso-'));
    path = join(dir, 'cloud-enroll.json');
    // A fresh managed installation: setup open, nobody signed up yet.
    await q(`delete from users where oidc_subject is null or oidc_subject not like 'system:%'`);
    await q(
      `delete from settings where key like 'setup:%' or key like 'auth:%' or key = 'onboarding:finalize_setup' or key = 'general:settings'`
    );
    await new SetupTokenPolicyService(db, true).ensureSetupStarted();
    return () => rm(dir, { recursive: true, force: true });
  });

  it('comes up set up: owner admin, Opfield account provider, setup complete, secret out of the file', async () => {
    await writeEnrollFile();
    const { setupPolicy, oidcSettings, generalSettings } = services();
    expect(await setupPolicy.isSetupComplete()).toBe(false);

    await expect(enrollFile(managedSso()).runOnce()).resolves.toBe(false);

    expect(await setupPolicy.isSetupComplete()).toBe(true);
    const [owner] = await users();
    expect(owner).toMatchObject({ oidcSubject: OWNER.sub, oidcIssuer: ISSUER, authMethod: 'oidc', name: OWNER.name });
    const [group] = await db
      .select({ name: schema.permissionGroups.name })
      .from(schema.permissionGroups)
      .where(eq(schema.permissionGroups.id, owner!.groupId));
    expect(group?.name).toBe('system-admin');
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      configured: true,
      issuer: `${ISSUER}/`,
      clientId: 'gw-acme',
      clientSecretLast4: SECRET.slice(-4),
      redirectUri: `${PUBLIC_URL}/auth/callback`,
      displayName: 'Opfield account',
      opfieldAccount: true,
    });
    expect((await services().authSettings.getConfig()).methods.oidc).toBe(true);
    expect((await generalSettings.getConfig()).publicUrl).toBe(PUBLIC_URL);
    expect((await generalSettings.getConfig()).gatewayGrpcPublicTarget).toBe('acme.opfield.cloud');
    expect(await new FinalizeSetupService(db).isOwner(owner!.id)).toBe(true);
    // Stored encrypted, never in the audit, and the file is gone once every step settled.
    expect((await oidcSettings.getRuntimeConfig())?.redirectUri).toBe('https://acme.opfield.cloud:3000/auth/callback');
    const stored = await q(`select value::text from settings where key = 'auth:oidc'`);
    expect(stored.rows[0].value).not.toContain(SECRET);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(SECRET);
    expect(audit.mock.calls.map(([details]) => details.step)).toEqual([
      'public_url',
      'provider',
      'owner',
      'setup_complete',
      'secret_removed',
    ]);
    expect(await exists(path)).toBe(false);
  });

  it('is idempotent across restarts and retries', async () => {
    await writeEnrollFile();
    // Enrolment keeps failing: the file stays (without its secret) and the next start reads it again.
    const offline = cloud(async () => {
      const { CloudLinkRequestError } = await import('./cloud-link.service.js');
      throw new CloudLinkRequestError(502, 'CLOUD_PORTAL_UNAVAILABLE', 'unreachable', true);
    });
    await expect(enrollFile(managedSso(), offline).runOnce()).resolves.toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8')).sso.clientSecret).toBeUndefined();
    await expect(enrollFile(managedSso(), offline).runOnce()).resolves.toBe(true);
    // A crash before the secret left the file: the same file again changes nothing.
    await writeEnrollFile();
    await expect(managedSso().apply(JSON.parse(await readFile(path, 'utf8')))).resolves.toBe('done');
    expect(await users()).toHaveLength(1);
    expect(audit.mock.calls.filter(([details]) => details.step === 'owner')).toHaveLength(1);
    expect(audit.mock.calls.some(([details]) => details.step === 'client_replaced')).toBe(false);
  });

  it('rolls back everything when a step fails, so the setup link flow stays', async () => {
    const { setupPolicy, oidcSettings, generalSettings } = services();
    const failing = managedSso({
      finalizeSetup: {
        initializeOwner: async () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(
      failing.apply({
        publicUrl: PUBLIC_URL,
        sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
        owner: OWNER,
      })
    ).resolves.toBe('retry');
    expect(await setupPolicy.isSetupComplete()).toBe(false);
    expect(await users()).toHaveLength(0);
    expect((await oidcSettings.getPublicConfig()).configured).toBe(false);
    expect((await generalSettings.getConfig()).publicUrl).toBeNull();
    expect(await q(`select 1 from settings where key = 'setup:first_admin_claim'`)).toMatchObject({ rowCount: 0 });
    expect(audit).toHaveBeenCalledWith({ step: 'failed', error: 'disk full' });

    // Without sso or owner, or while the wizard holds the first-admin claim, nothing is written either.
    await expect(managedSso().apply({ publicUrl: PUBLIC_URL, owner: OWNER })).resolves.toBe('rejected');
    await q(`insert into settings (key, value, updated_at) values ('setup:first_admin_claim', '"wizard"', now())`);
    await expect(
      managedSso().apply({
        publicUrl: PUBLIC_URL,
        sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
        owner: OWNER,
      })
    ).resolves.toBe('retry');
    expect(await users()).toHaveLength(0);
    expect(await setupPolicy.isSetupComplete()).toBe(false);
    await q(`delete from settings where key = 'setup:first_admin_claim'`);

    // The next pass succeeds.
    await expect(
      managedSso().apply({
        publicUrl: PUBLIC_URL,
        sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
        owner: OWNER,
      })
    ).resolves.toBe('done');
    expect(await setupPolicy.isSetupComplete()).toBe(true);
  });

  it('signs the owner in through the Opfield account provider, and nobody else as the owner', async () => {
    await managedSso().apply({
      publicUrl: PUBLIC_URL,
      sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
      owner: OWNER,
    });
    const cache = new Map<string, unknown>();
    const { oidcSettings, authSettings, generalSettings } = services();
    const auth = new AuthService(
      db,
      {
        createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
        getSession: vi.fn(async () => ({ authMethod: 'oidc' })),
        destroySession: vi.fn(async () => undefined),
      } as never,
      {
        get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: unknown) => void cache.set(key, value),
        delete: async (key: string) => void cache.delete(key),
      } as never,
      authSettings,
      { log: vi.fn(async () => undefined) } as never,
      oidcSettings,
      generalSettings
    );

    const authorize = new URL(await auth.getAuthorizationUrl('/'));
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

    idToken.claims = { iss: ISSUER, sub: OWNER.sub, email: OWNER.email, email_verified: true, name: OWNER.name };
    const result = await auth.handleCallback(`${PUBLIC_URL}/auth/callback?code=c&state=state-1`, 'state-1');
    const [owner] = await users();
    expect(result.user.id).toBe(owner!.id);
    expect(result.user.scopes).toContain('admin:system');
    // The portal has no end-session endpoint: sign-out ends the Opfield session only.
    await expect(auth.logout('session-1')).resolves.toBeNull();

    // The same subject from another issuer is somebody else.
    await auth.getAuthorizationUrl('/');
    idToken.claims = { iss: 'https://idp.other.example', sub: OWNER.sub, email: OWNER.email, email_verified: true };
    await expect(
      auth.handleCallback(`${PUBLIC_URL}/auth/callback?code=c&state=state-1`, 'state-1')
    ).rejects.toMatchObject({ code: 'OIDC_ISSUER_MISMATCH' });
  });

  it('never lets the last administrator lose sign-in, and replaces the provider client on a restore', async () => {
    await managedSso().apply({
      publicUrl: PUBLIC_URL,
      sso: { issuer: ISSUER, clientId: 'gw-acme', clientSecret: SECRET },
      owner: OWNER,
    });
    const { oidcSettings, authSettings } = services();
    const current = { methods: (await authSettings.getConfig()).methods, issuer: await oidcSettings.getIssuer() };

    // The customer's own SSO in place of the Opfield account would lock the owner, the only administrator, out.
    await expect(
      assertAdminSignInRemains(db, { issuer: 'https://id.customer.example' }, current)
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_SIGN_IN' });
    await expect(
      managedSso().apply({ sso: { issuer: 'https://id.customer.example', clientId: 'x', clientSecret: 'y' } })
    ).resolves.toBe('rejected');
    expect((await oidcSettings.getPublicConfig()).clientId).toBe('gw-acme');
    // Renaming or a new secret keeps the issuer, so it is fine.
    await expect(assertAdminSignInRemains(db, { issuer: `${ISSUER}/` }, current)).resolves.toBeUndefined();

    // A restore delivers a new client in the file: it replaces the client and keeps the admin's name for it.
    await oidcSettings.saveConfig({
      issuer: ISSUER,
      clientId: 'gw-acme',
      redirectUri: `${PUBLIC_URL}/auth/callback`,
      displayName: 'Acme login',
    });
    await expect(
      managedSso().apply({ sso: { issuer: ISSUER, clientId: 'gw-acme-2', clientSecret: 'new-secret-0001' } })
    ).resolves.toBe('done');
    expect(await oidcSettings.getPublicConfig()).toMatchObject({
      clientId: 'gw-acme-2',
      clientSecretLast4: '0001',
      displayName: 'Acme login',
      opfieldAccount: true,
    });
    expect(await users()).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ step: 'client_replaced', clientId: 'gw-acme-2' }));

    // The portal's secret rotation: only for the Opfield account provider.
    await oidcSettings.rotateOpfieldAccountSecret('rotated-secret-0002');
    expect((await oidcSettings.getPublicConfig()).clientSecretLast4).toBe('0002');

    // Once another administrator signs in with a password, the provider can be replaced.
    await authSettings.updateConfig({ methods: { password: true } });
    const [adminGroup] = await db
      .select({ id: schema.permissionGroups.id })
      .from(schema.permissionGroups)
      .where(eq(schema.permissionGroups.name, 'system-admin'));
    await db
      .insert(schema.users)
      .values({ email: 'ops@example.com', name: 'Ops', authMethod: 'password', groupId: adminGroup!.id });
    await expect(
      assertAdminSignInRemains(
        db,
        { issuer: 'https://id.customer.example' },
        {
          methods: (await authSettings.getConfig()).methods,
          issuer: await oidcSettings.getIssuer(),
        }
      )
    ).resolves.toBeUndefined();
    await oidcSettings.saveConfig({
      issuer: 'https://id.customer.example',
      clientId: 'customer',
      clientSecret: 'customer-secret',
      redirectUri: `${PUBLIC_URL}/auth/callback`,
      displayName: 'Customer SSO',
    });
    expect(await oidcSettings.getPublicConfig()).toMatchObject({ opfieldAccount: false, displayName: 'Customer SSO' });
    await expect(oidcSettings.rotateOpfieldAccountSecret('nope')).rejects.toMatchObject({
      code: 'OPFIELD_ACCOUNT_PROVIDER_MISSING',
    });
  });
});
