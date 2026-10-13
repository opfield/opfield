import { describe, expect, it } from 'vitest';
import { appOnlyScopeBases, resolveAppOnlyScopeBases } from './app-place-scopes.js';

const ENV = '11111111-1111-4111-8111-111111111111';
const ROOT = '22222222-2222-4222-8222-222222222222';
const USER_FOLDER = '33333333-3333-4333-8333-333333333333';
const HIDDEN = new Set([ENV, ROOT]);
const hidden = (_table: string, folderId: string) => HIDDEN.has(folderId);

/** The scopes an "In an app environment" access line assigns (developer role). */
const APP_LINE = [
  `apps:view:env/${ENV}`,
  `apps:promote:env/${ENV}`,
  `docker:containers:view:folder/${ENV}`,
  `docker:containers:manage:folder/${ENV}`,
  `docker:compose:view:folder/${ENV}`,
  `proxy:view:folder/${ENV}`,
  `proxy:edit:folder/${ENV}`,
  `databases:view:folder/${ENV}`,
  `storage:view:folder/${ROOT}`,
  `pages:view:folder/${ENV}`,
];

describe('appOnlyScopeBases', () => {
  it('lists every resource base an app access line alone grants, never the app scopes', () => {
    expect(appOnlyScopeBases(APP_LINE, hidden)).toEqual([
      'databases:view',
      'docker:compose:view',
      'docker:containers:manage',
      'docker:containers:view',
      'pages:view',
      'proxy:edit',
      'proxy:view',
      'storage:view',
    ]);
  });

  it('keeps a base granted outside app places too: user folder, resource, node or broad', () => {
    const bases = (extra: string) => appOnlyScopeBases([...APP_LINE, extra], hidden);
    expect(bases(`storage:view:folder/${USER_FOLDER}`)).not.toContain('storage:view');
    expect(bases('storage:view:9f0c7a2e-0000-4000-8000-000000000001')).not.toContain('storage:view');
    expect(bases('proxy:view:node/9f0c7a2e-0000-4000-8000-000000000002')).not.toContain('proxy:view');
    expect(bases('docker:containers:view')).not.toContain('docker:containers:view');
    // Only the base granted elsewhere is kept; the rest stay app-only.
    expect(bases('docker:containers:view')).toContain('docker:containers:manage');
    expect(bases(`storage:view:folder/${USER_FOLDER}`)).toContain('databases:view');
  });

  it('treats each base on its own (an app-only action base next to a global view base)', () => {
    expect(appOnlyScopeBases([`storage:edit:folder/${ENV}`, `storage:view:folder/${USER_FOLDER}`], hidden)).toEqual([
      'storage:edit',
    ]);
  });

  it('ignores bases of families apps do not hold, even when the folder id is hidden elsewhere', () => {
    expect(appOnlyScopeBases([`ssl:cert:view:folder/${ENV}`, `proxy:templates:view:folder/${ENV}`], hidden)).toEqual(
      []
    );
  });

  it('is empty for scopes without app places', () => {
    expect(appOnlyScopeBases(['storage:view', `proxy:view:folder/${USER_FOLDER}`], hidden)).toEqual([]);
    expect(appOnlyScopeBases([], hidden)).toEqual([]);
  });
});

describe('resolveAppOnlyScopeBases', () => {
  it('does not query the database without folder grants of app families', async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('database read');
        },
      }
    );
    await expect(
      resolveAppOnlyScopeBases(db as never, ['storage:view', `ssl:cert:view:folder/${ENV}`, 'proxy:view:not-a-folder'])
    ).resolves.toEqual([]);
  });
});
