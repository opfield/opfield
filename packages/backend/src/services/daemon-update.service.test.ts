import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import { nodes } from '@/db/schema/nodes.js';
import { relayInstances } from '@/db/schema/relay.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { DaemonUpdateService, daemonUpdateBaseline } from './daemon-update.service.js';

describe('daemonUpdateBaseline', () => {
  it('stages a daemon type from its oldest node', () => {
    expect(daemonUpdateBaseline(['v2.12.0', null, 'dev', 'unknown', 'v2.11.3'], null)).toBe('v2.11.3');
    expect(daemonUpdateBaseline([null, 'dev'], null)).toBeUndefined();
  });

  it('stages relays from the release their pool runs, not from an old relay', () => {
    expect(daemonUpdateBaseline(['v2.11.1', 'v2.12.1-rc.3'], 'v2.12.1-rc.3')).toBe('v2.12.1-rc.3');
  });
});

describe('DaemonUpdateService.checkForUpdates', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Drizzle as checkForUpdates uses it: node rows, the local relay, and the settings it writes. */
  function fakeDb(nodeRows: Array<{ type: string; daemonVersion: string | null }>, localRelay: string | null) {
    const written = new Map<string, string>();
    const rowsOf = (table: unknown) =>
      table === nodes
        ? nodeRows.map((row, index) => ({ id: `n${index}`, hostname: `n${index}`, capabilities: {}, ...row }))
        : table === relayInstances
          ? localRelay
            ? [{ buildVersion: localRelay }]
            : []
          : [];
    const query = (table: unknown) => {
      const rows = rowsOf(table);
      const chain = {
        where: () => chain,
        limit: async () => rows,
        // biome-ignore lint/suspicious/noThenProperty: a Drizzle query is awaited directly.
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    };
    const db = {
      select: () => ({ from: query }),
      insert: () => ({
        values: (value: { key: string; value: string }) => ({
          onConflictDoUpdate: async () => {
            written.set(value.key, value.value);
          },
        }),
      }),
      delete: () => ({ where: async () => {} }),
    };
    return { db, written };
  }

  function resolver(targets: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        const tag = targets[`${url.searchParams.get('component')}@${url.searchParams.get('current')}`];
        return tag ? new Response(JSON.stringify({ target: { tag_name: tag } })) : new Response(null, { status: 204 });
      })
    );
  }

  function service(db: unknown) {
    const env = { APP_VERSION: 'v2.12.1', RELEASES_API_URL: 'https://updates.example.test/gateway/releases' } as Env;
    const settings = { getConfig: async () => ({ updateChannel: 'preview' }) } as unknown as GeneralSettingsService;
    return new DaemonUpdateService(db as never, env, settings);
  }

  it("takes the relays' latest release from the pool's release, not from an old offline relay", async () => {
    const { db, written } = fakeDb(
      [
        { type: 'relay', daemonVersion: 'v2.11.1' },
        { type: 'relay', daemonVersion: 'v2.12.1-rc.3' },
        { type: 'docker', daemonVersion: 'v2.12.1-rc.3' },
      ],
      'v2.12.1-rc.3'
    );
    resolver({
      'relay-supervisor@v2.11.1': 'v2.11.4-relay',
      'docker-daemon@v2.12.1-rc.3': 'v2.12.1-rc.4-docker',
    });

    await service(db).checkForUpdates();

    // The pool runs the newest release on the feed: that is the relays' latest.
    expect(written.get('daemon-update:relay:latest_version')).toBe('v2.12.1-rc.3');
    expect(written.get('daemon-update:docker:latest_version')).toBe('v2.12.1-rc.4');
  });

  it("takes the pool's next release when the feed has one", async () => {
    const { db, written } = fakeDb([{ type: 'relay', daemonVersion: 'v2.11.1' }], 'v2.12.1-rc.3');
    resolver({ 'relay-supervisor@v2.12.1-rc.3': 'v2.12.1-relay' });

    await service(db).checkForUpdates();

    expect(written.get('daemon-update:relay:latest_version')).toBe('v2.12.1');
    expect(written.get('daemon-update:relay:latest_tag')).toBe('v2.12.1-relay');
  });
});
