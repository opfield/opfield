import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import { UPDATES_BASE_URL } from '@/config/vendor-urls.js';
import { LEGACY_ADDRESS_FLAG, LEGACY_CERT_FLAG, LEGACY_INSTALLER_CHECKSUMS_ASSET } from '@/lib/legacy-compat.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import {
  enrollmentInstallation,
  installerRelease,
  NODE_INSTALLERS,
  nodeInstallCommands,
  OPFIELD_FLAG_INSTALLERS,
  secureRuntimeLocalCommand,
} from './node-installer.js';

vi.mock('@/config/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/env.js')>()),
  getEnv: () => ({ APP_VERSION: '2.11.0', GRPC_PORT: 9443 }),
}));

const RELEASE = `${UPDATES_BASE_URL}/releases/download/v2.11.0`;
const CERT = `sha256:${'a'.repeat(64)}`;

function storageCommands(release: string | null) {
  return nodeInstallCommands({
    nodeType: 'storage',
    release,
    token: 'gw_node_v2_token',
    opfieldCertSha256: CERT,
    targets: {
      public: { label: 'Public node', address: 'gw.example.com:9443' },
      local: { label: 'Local node', address: '[fd00::1]:9443' },
    },
    daemonVersion: 'v2.11.0',
  });
}

describe('Secure Runtime local command', () => {
  it('fetches and checks the release installer for a daemon that runs as its own user', () => {
    expect(secureRuntimeLocalCommand('sudo bash setup-docker-node.sh --user gwdock --secure-runtime', 'v2.11.0')).toBe(
      [
        'cd "$(mktemp -d)"',
        `curl -fsSL -o setup-docker-node.sh ${RELEASE}/setup-docker-node.sh`,
        `curl -fsSL -o opfield-node-installers.sha256 ${RELEASE}/opfield-node-installers.sha256`,
        "grep ' setup-docker-node.sh$' opfield-node-installers.sha256 | sha256sum -c -",
        'sudo bash setup-docker-node.sh --user gwdock --secure-runtime',
      ].join(' && ')
    );
  });

  it("pins the node's own daemon version, so the command never offers another release (F-B6)", () => {
    const local = 'sudo bash setup-docker-node.sh --user gwdock --secure-runtime';
    expect(secureRuntimeLocalCommand(local, 'v2.11.1-rc.20', 'v2.11.1-rc.20')).toMatch(
      /&& sudo bash setup-docker-node\.sh --user gwdock --secure-runtime --version v2\.11\.1-rc\.20$/
    );
    expect(secureRuntimeLocalCommand(local, 'v2.11.0', '2.11.0')).toMatch(/--secure-runtime --version v2\.11\.0$/);
    expect(secureRuntimeLocalCommand(local, 'v2.11.0', 'dev')).toMatch(/--secure-runtime$/);
    // A 2.11.1 daemon names its version itself.
    expect(secureRuntimeLocalCommand(`${local} --version v2.11.1-rc.24`, 'v2.11.1-rc.24', 'v2.11.1-rc.20')).toMatch(
      /--secure-runtime --version v2\.11\.1-rc\.24$/
    );
  });

  it('keeps every other command as the daemon reported it', () => {
    for (const command of [
      'sudo docker-daemon runtime install runsc',
      'sudo bash setup-docker-node.sh --user gw;rm --secure-runtime',
      'sudo bash setup-docker-node.sh --user gwdock --secure-runtime; reboot',
    ]) {
      expect(secureRuntimeLocalCommand(command, 'v2.11.0')).toBe(command);
    }
  });
});

describe('node setup commands', () => {
  it('run only the installer of the Opfield release that matches the release checksums', () => {
    const [publicCommand, localCommand] = storageCommands('v2.11.0');

    expect(publicCommand?.curl.split(' && \\\n')).toEqual([
      'cd "$(mktemp -d)"',
      `curl -fsSL -o setup-storage-node.sh ${RELEASE}/setup-storage-node.sh`,
      `curl -fsSL -o opfield-node-installers.sha256 ${RELEASE}/opfield-node-installers.sha256`,
      "grep ' setup-storage-node.sh$' opfield-node-installers.sha256 | sha256sum -c -",
      [
        'OPFIELD_NODE_TOKEN=gw_node_v2_token sudo --preserve-env=OPFIELD_NODE_TOKEN bash setup-storage-node.sh \\',
        '  --opfield gw.example.com:9443 \\',
        `  --opfield-cert-sha256 ${CERT} \\`,
        '  --version v2.11.0',
      ].join('\n'),
    ]);
    expect(publicCommand?.wget).toContain(`wget -qO setup-storage-node.sh ${RELEASE}/setup-storage-node.sh`);
    expect(publicCommand?.wget).toContain(
      `wget -qO opfield-node-installers.sha256 ${RELEASE}/opfield-node-installers.sha256`
    );
    expect(publicCommand?.wget).toContain(
      '| sha256sum -c - && \\\nOPFIELD_NODE_TOKEN=gw_node_v2_token sudo --preserve-env=OPFIELD_NODE_TOKEN bash setup-storage-node.sh'
    );
    // An IPv6 target is quoted so no shell expands the brackets.
    expect(localCommand?.curl).toContain("--opfield '[fd00::1]:9443' \\");
    for (const command of [publicCommand, localCommand].flatMap((entry) => [entry?.curl, entry?.wget])) {
      expect(command).not.toMatch(/raw\.githubusercontent|releases\/latest|\/main\//);
    }
  });

  it('pass the enrollment token in the environment, never on the command line of the installer (R3-04)', () => {
    for (const release of ['v2.11.0', null]) {
      for (const command of storageCommands(release).flatMap((entry) => [entry.curl, entry.wget])) {
        expect(command).not.toContain('--token');
        // Assigned for the sudo command alone: nothing stays exported in the shell that ran the command (L-05).
        expect(command).not.toContain('export ');
        expect(command).toMatch(
          /(^|[|&] |\n)OPFIELD_NODE_TOKEN=gw_node_v2_token sudo --preserve-env=OPFIELD_NODE_TOKEN bash /
        );
      }
    }
    // A token that needs quoting is quoted for the shell.
    const [quoted] = nodeInstallCommands({
      nodeType: 'nginx',
      release: 'v2.11.0',
      token: "tok'en",
      opfieldCertSha256: CERT,
      targets: { public: { label: 'Public node', address: 'gw.example.com:9443' } },
    });
    expect(quoted?.curl).toContain("OPFIELD_NODE_TOKEN='tok'\\''en' sudo --preserve-env=OPFIELD_NODE_TOKEN bash ");
  });

  it('keep running the installers from main on an unreleased build', () => {
    for (const version of ['dev', 'main-0123abc', 'v2.11.0-dirty', '']) expect(installerRelease(version)).toBeNull();
    expect(installerRelease('v2.11.0-rc.34')).toBe('v2.11.0-rc.34');
    expect(installerRelease('2.11.0')).toBe('v2.11.0');

    const [command] = storageCommands(null);
    expect(command?.curl).toMatch(
      /^curl -sSL https:\/\/raw\.githubusercontent\.com\/opfield\/opfield\/main\/scripts\/setup-storage-node\.sh \| OPFIELD_NODE_TOKEN=gw_node_v2_token sudo --preserve-env=OPFIELD_NODE_TOKEN bash -s -- \\\n {2}--opfield /
    );
    expect(command?.wget).toMatch(
      /^wget -qO- https:\/\/raw\.githubusercontent\.com\/.*\/main\/scripts\/setup-storage-node\.sh \|/
    );
  });

  it('give a relay its address, a non-default port and the pool release, and skip targets without an address', () => {
    const commands = nodeInstallCommands({
      nodeType: 'relay',
      release: 'v2.12.1',
      token: 'opf_node_v2_token',
      opfieldCertSha256: CERT,
      targets: { public: { label: 'Public node', address: null }, local: { label: 'Local node', address: null } },
      fallbackOpfield: 'opfield.example.com:9443',
      advertiseAddress: 'relay.example.com',
      servicePort: 9444,
      daemonVersion: 'v2.12.1-rc.3',
    });

    expect(commands.map((command) => command.target)).toEqual(['public']);
    expect(commands[0]?.curl).toContain('/download/v2.12.1/setup-relay-node.sh');
    expect(commands[0]?.curl).toContain('/download/v2.12.1/opfield-node-installers.sha256');
    expect(commands[0]?.curl).toMatch(
      /--opfield opfield\.example\.com:9443 \\\n.*\n {2}--advertise-address relay\.example\.com \\\n {2}--service-port 9444 \\\n {2}--version v2\.12\.1-rc\.3$/
    );
    expect(commands[0]?.curl).not.toContain('--token');
    expect(commands[0]?.curl).toContain(`--opfield-cert-sha256 ${CERT}`);
    expect(commands[0]?.curl).not.toContain(LEGACY_ADDRESS_FLAG);
  });

  it('give a relay pool before 2.12.1 the installer of its own release with the flags it takes', () => {
    const [command] = nodeInstallCommands({
      nodeType: 'relay',
      release: 'v2.12.1',
      token: 'opf_node_v2_token',
      opfieldCertSha256: CERT,
      targets: { public: { label: 'Public node', address: 'opfield.example.com:9443' } },
      advertiseAddress: 'relay.example.com',
      daemonVersion: '2.12.0',
    });

    expect(command?.curl).toContain('/download/v2.12.0/setup-relay-node.sh');
    expect(command?.curl).toContain(
      `/download/v2.12.0/${LEGACY_INSTALLER_CHECKSUMS_ASSET} && \\\ngrep ' setup-relay-node.sh$' ${LEGACY_INSTALLER_CHECKSUMS_ASSET}`
    );
    expect(command?.curl).toContain(`${LEGACY_ADDRESS_FLAG} opfield.example.com:9443`);
    expect(command?.curl).toContain(`${LEGACY_CERT_FLAG} ${CERT}`);
    expect(command?.curl).toMatch(/--version 2\.12\.0$/);
    // That installer reads the token only from --token.
    expect(command?.curl).toContain('--token opf_node_v2_token');
    expect(command?.curl).not.toContain('OPFIELD_NODE_TOKEN');
  });

  it('give no node without an enrollment address a command', () => {
    expect(
      nodeInstallCommands({
        nodeType: 'builder',
        release: 'v2.11.0',
        token: 't',
        opfieldCertSha256: CERT,
        targets: { public: { label: 'Public node', address: null } },
      })
    ).toEqual([]);
  });
});

describe('relay enrollment command', () => {
  function relayInstallation(metadata: Record<string, unknown>) {
    return enrollmentInstallation({
      node: { type: 'relay', serviceAddresses: ['relay.example.com'], metadata },
      enrollmentToken: 'gw_node_v2_token',
      opfieldCertSha256: CERT,
      opfieldEnrollmentTargets: { public: { label: 'Public node', address: 'gw.example.com:9443' } },
    });
  }

  it('carries the port the relay node was created with', async () => {
    const installation = await relayInstallation({ createdById: 'user-1', relayServicePort: 853 });
    expect(installation.installCommands[0]?.curl).toMatch(
      /--advertise-address relay\.example\.com \\\n {2}--service-port 853$/
    );
  });

  it('leaves the installer default port implicit', async () => {
    const installation = await relayInstallation({ createdById: 'user-1' });
    expect(installation.installCommands[0]?.curl).toMatch(/--advertise-address relay\.example\.com$/);
    expect(installation.installCommands[0]?.curl).not.toContain('--service-port');
  });
});

describe('DaemonUpdateService.installVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  function service(appVersion: string) {
    const env = {
      APP_VERSION: appVersion,
      RELEASES_API_URL: 'https://updates.example.test/opfield/releases',
      ARTIFACT_BASE_URL: 'https://updates.example.test/opfield',
    } as Env;
    const settings = { getConfig: async () => ({ updateChannel: 'preview' }) } as unknown as GeneralSettingsService;
    return new DaemonUpdateService({} as never, env, settings);
  }

  function resolverAnswers(tag: string | null) {
    const fetchMock = vi.fn(async () =>
      tag ? new Response(JSON.stringify({ target: { tag_name: tag } })) : new Response(null, { status: 204 })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("pins the newest stable daemon release of a stable Opfield's minor line, even on the preview channel", async () => {
    const fetchMock = resolverAnswers('v2.11.3-docker');

    await expect(service('v2.11.2').installVersion('docker')).resolves.toBe('v2.11.3');
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      component: 'docker-daemon',
      current: 'v2.11.0-rc.0',
      channel: 'stable',
    });
  });

  it('takes candidates of the line for a release candidate of Opfield', async () => {
    const fetchMock = resolverAnswers('v2.11.3-rc.1-docker');
    await expect(service('v2.11.3-rc.2').installVersion('docker')).resolves.toBe('v2.11.3-rc.1');
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('channel')).toBe('preview');
  });

  it('never pins a release whose binary the update host no longer serves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (init?.method === 'HEAD') return new Response(null, { status: url.pathname.includes('-rc.') ? 404 : 200 });
        if (url.pathname.endsWith('.update.json')) return new Response('{}');
        const tag = url.searchParams.get('channel') === 'preview' ? 'v2.11.4-rc.1-docker' : 'v2.11.3-docker';
        return new Response(JSON.stringify({ target: { tag_name: tag } }));
      })
    );
    // The candidate's manifest is still served but its binary is gone: the stable release of the line instead.
    await expect(service('v2.11.4-rc.2').installVersion('docker')).resolves.toBe('v2.11.3');
  });

  it("does not pin a later line's daemon, a missing release or an unreleased Opfield", async () => {
    resolverAnswers('v2.12.0-nginx');
    await expect(service('v2.11.0').installVersion('nginx')).resolves.toBeNull();

    resolverAnswers(null);
    await expect(service('v2.11.0').installVersion('monitoring')).resolves.toBeNull();

    const fetchMock = resolverAnswers('v2.11.0-docker');
    await expect(service('dev').installVersion('docker')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(service('v2.11.0').installVersion('docker')).resolves.toBeNull();
  });
});

describe('DaemonUpdateService.relayInstallVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  function service(appVersion = 'v2.12.1', updateChannel = 'stable') {
    const env = {
      APP_VERSION: appVersion,
      RELEASES_API_URL: 'https://updates.example.test/opfield/releases',
      ARTIFACT_BASE_URL: 'https://updates.example.test/opfield',
    } as Env;
    const settings = { getConfig: async () => ({ updateChannel }) } as unknown as GeneralSettingsService;
    return new DaemonUpdateService({} as never, env, settings);
  }

  /** The release feed: the relay manifests it serves, and the newest relay release of each minor line. */
  function feed(published: string[], lines: Record<string, string>) {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/relay-supervisor/')) {
        const tag = url.pathname.split('/').at(-2) ?? '';
        return new Response(published.includes(tag) ? '{}' : 'not found', {
          status: published.includes(tag) ? 200 : 404,
        });
      }
      const line = /^v(\d+\.\d+)\.0-rc\.0$/.exec(url.searchParams.get('current') ?? '')?.[1] ?? '';
      const tag = lines[`${line}:${url.searchParams.get('channel')}`];
      return tag ? new Response(JSON.stringify({ target: { tag_name: tag } })) : new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("keeps the pool's release when the feed publishes it", async () => {
    const fetchMock = feed(['v2.12.0-relay'], { '2.12:stable': 'v2.12.1-relay' });
    await expect(service().relayInstallVersion('2.12.0')).resolves.toBe('v2.12.0');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://updates.example.test/opfield/relay-supervisor/v2.12.0-relay/relay-supervisor-linux-amd64.update.json'
    );
  });

  it("gives a pool on an unpublished release the published release of the pool's line", async () => {
    feed(['v2.12.0-relay'], { '2.12:preview': 'v2.12.0-relay', '2.12:stable': 'v2.12.0-relay' });
    // A pool on a stand-only candidate: its line on the preview channel.
    await expect(service().relayInstallVersion('v2.12.0-rc.18')).resolves.toBe('v2.12.0');
  });

  it("falls back to the relay release of Opfield's line, and to the installer's own choice", async () => {
    feed(['v2.12.1-relay'], { '2.12:stable': 'v2.12.1-relay' });
    await expect(service('v2.12.1').relayInstallVersion('v2.10.9-rc.1')).resolves.toBe('v2.12.1');
    await expect(service('v2.12.1').relayInstallVersion(null)).resolves.toBe('v2.12.1');
    feed([], {});
    await expect(service('v2.12.1').relayInstallVersion('v2.10.9-rc.1')).resolves.toBeNull();
    await expect(service('dev').relayInstallVersion(null)).resolves.toBeNull();
  });

  it('replaces a pool release whose manifest is still served but whose binary is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('.update.json')) return new Response('{}');
        if (init?.method === 'HEAD') return new Response(null, { status: url.pathname.includes('-rc.') ? 404 : 200 });
        return new Response(JSON.stringify({ target: { tag_name: 'v2.12.6-relay' } }));
      })
    );
    await expect(service('v2.12.8-rc.2').relayInstallVersion('v2.12.6-rc.2')).resolves.toBe('v2.12.6');
  });

  it("keeps the pool's release when the feed cannot be reached", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(service().relayInstallVersion('v2.12.0-rc.18')).resolves.toBe('v2.12.0-rc.18');
  });
});

describe('installer enrollment flags', () => {
  it('passes --opfield exactly to the installers of this release that parse it', () => {
    const scripts = fileURLToPath(new URL('../../../../../scripts/', import.meta.url));
    // A wrapper that hands its arguments to an installer of the same release parses what that installer parses.
    const parses = (installer: string): boolean => {
      const source = readFileSync(join(scripts, installer), 'utf8');
      const delegate = /^bash "\$stage\/(setup-[a-z-]+\.sh)" "\$@"$/m.exec(source)?.[1];
      return /^\s*--opfield\)/m.test(source) || (delegate !== undefined && parses(delegate));
    };
    const parsing = [...new Set(Object.values(NODE_INSTALLERS))].filter(parses);
    expect([...OPFIELD_FLAG_INSTALLERS].sort()).toEqual(parsing.sort());
  });
});
