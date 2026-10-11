import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/config/env.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import {
  enrollmentInstallation,
  installerRelease,
  nodeInstallCommands,
  secureRuntimeLocalCommand,
} from './node-installer.js';

vi.mock('@/config/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/env.js')>()),
  getEnv: () => ({ APP_VERSION: '2.11.0', GRPC_PORT: 9443 }),
}));

const RELEASE = 'https://get.opfield.dev/gateway/releases/download/v2.11.0';
const CERT = `sha256:${'a'.repeat(64)}`;

function storageCommands(release: string | null) {
  return nodeInstallCommands({
    nodeType: 'storage',
    release,
    token: 'gw_node_v2_token',
    gatewayCertSha256: CERT,
    targets: {
      public: { label: 'Public node', gateway: 'gw.example.com:9443' },
      local: { label: 'Local node', gateway: '[fd00::1]:9443' },
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
        `curl -fsSL -o gateway-daemon-installers.sha256 ${RELEASE}/gateway-daemon-installers.sha256`,
        "grep ' setup-docker-node.sh$' gateway-daemon-installers.sha256 | sha256sum -c -",
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
  it('run only the installer of the Gateway release that matches the release checksums', () => {
    const [publicCommand, localCommand] = storageCommands('v2.11.0');

    expect(publicCommand?.curl.split(' && \\\n')).toEqual([
      'cd "$(mktemp -d)"',
      `curl -fsSL -o setup-storage-node.sh ${RELEASE}/setup-storage-node.sh`,
      `curl -fsSL -o gateway-daemon-installers.sha256 ${RELEASE}/gateway-daemon-installers.sha256`,
      "grep ' setup-storage-node.sh$' gateway-daemon-installers.sha256 | sha256sum -c -",
      [
        'sudo bash setup-storage-node.sh \\',
        '  --gateway gw.example.com:9443 \\',
        '  --token gw_node_v2_token \\',
        `  --gateway-cert-sha256 ${CERT} \\`,
        '  --version v2.11.0',
      ].join('\n'),
    ]);
    expect(publicCommand?.wget).toContain(`wget -qO setup-storage-node.sh ${RELEASE}/setup-storage-node.sh`);
    expect(publicCommand?.wget).toContain(
      `wget -qO gateway-daemon-installers.sha256 ${RELEASE}/gateway-daemon-installers.sha256`
    );
    expect(publicCommand?.wget).toContain('| sha256sum -c - && \\\nsudo bash setup-storage-node.sh');
    // An IPv6 target is quoted so no shell expands the brackets.
    expect(localCommand?.curl).toContain("--gateway '[fd00::1]:9443' \\");
    for (const command of [publicCommand, localCommand].flatMap((entry) => [entry?.curl, entry?.wget])) {
      expect(command).not.toMatch(/raw\.githubusercontent|releases\/latest|\/main\//);
    }
  });

  it('keep running the installers from main on an unreleased build', () => {
    for (const version of ['dev', 'main-0123abc', 'v2.11.0-dirty', '']) expect(installerRelease(version)).toBeNull();
    expect(installerRelease('v2.11.0-rc.34')).toBe('v2.11.0-rc.34');
    expect(installerRelease('2.11.0')).toBe('v2.11.0');

    const [command] = storageCommands(null);
    expect(command?.curl).toMatch(
      /^curl -sSL https:\/\/raw\.githubusercontent\.com\/opfield\/opfield\/main\/scripts\/setup-storage-node\.sh \| sudo bash -s -- \\\n {2}--gateway /
    );
    expect(command?.wget).toMatch(
      /^wget -qO- https:\/\/raw\.githubusercontent\.com\/.*\/main\/scripts\/setup-storage-node\.sh \|/
    );
  });

  it('give a relay its address, a non-default port and the pool release, and skip targets without an address', () => {
    const commands = nodeInstallCommands({
      nodeType: 'relay',
      release: 'v2.11.0',
      token: 'gw_node_v2_token',
      gatewayCertSha256: CERT,
      targets: { public: { label: 'Public node', gateway: null }, local: { label: 'Local node', gateway: null } },
      fallbackGateway: 'gateway.example.com:9443',
      advertiseAddress: 'relay.example.com',
      servicePort: 9444,
      daemonVersion: 'v2.11.0-rc.20',
    });

    expect(commands.map((command) => command.target)).toEqual(['public']);
    expect(commands[0]?.curl).toContain(`${RELEASE}/setup-relay-node.sh`);
    expect(commands[0]?.curl).toMatch(
      /--gateway gateway\.example\.com:9443 \\\n.*\n.*\n {2}--advertise-address relay\.example\.com \\\n {2}--service-port 9444 \\\n {2}--version v2\.11\.0-rc\.20$/
    );
    expect(
      nodeInstallCommands({
        nodeType: 'builder',
        release: 'v2.11.0',
        token: 't',
        gatewayCertSha256: CERT,
        targets: { public: { label: 'Public node', gateway: null } },
      })
    ).toEqual([]);
  });
});

describe('relay enrollment command', () => {
  function relayInstallation(metadata: Record<string, unknown>) {
    return enrollmentInstallation({
      node: { type: 'relay', serviceAddresses: ['relay.example.com'], metadata },
      enrollmentToken: 'gw_node_v2_token',
      gatewayCertSha256: CERT,
      gatewayEnrollmentTargets: { public: { label: 'Public node', gateway: 'gw.example.com:9443' } },
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
    const env = { APP_VERSION: appVersion, RELEASES_API_URL: 'https://updates.example.test/gateway/releases' } as Env;
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

  it("pins the newest daemon release of the Gateway's minor line on its update channel", async () => {
    const fetchMock = resolverAnswers('v2.11.3-docker');

    await expect(service('v2.11.2').installVersion('docker')).resolves.toBe('v2.11.3');
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      component: 'docker-daemon',
      current: 'v2.11.0-rc.0',
      channel: 'preview',
    });
  });

  it("does not pin a later line's daemon, a missing release or an unreleased Gateway", async () => {
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
