import { describe, expect, it, vi } from 'vitest';
import { NGINX_OPFIELD_NAMES_CAPABILITY } from './nginx-node-names.js';
import { ProxyService } from './proxy.service.js';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const SOCKET_PATH = `/run/opfield-secure-links/${HOST_ID}.sock`;
const UPSTREAM_NAME = `opfield_secure_link_${HOST_ID.replace(/-/g, '_')}`;
// What the Route dialog stores when raw mode is switched on: the config Gateway rendered.
const SEEDED_RAW_CONFIG = `upstream ${UPSTREAM_NAME} {
    server unix:${SOCKET_PATH};
    keepalive 64;
}

server {
    listen 80;
    server_name example.com;
    location / { proxy_pass http://${UPSTREAM_NAME}; }
}
`;

function dockerRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: HOST_ID,
    type: 'proxy',
    domainNames: ['example.com'],
    slug: 'example-com',
    enabled: true,
    isSystem: false,
    nodeId: 'nginx-node',
    ingressGroupId: null,
    upstreamKind: 'docker_container',
    dockerNodeId: 'docker-node',
    dockerContainerName: 'application',
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerContainerPort: 8080,
    dockerHostPort: 8080,
    dockerProtocol: 'tcp',
    forwardHost: '127.0.0.1',
    forwardPort: 41001,
    forwardScheme: 'http',
    secureLinkGeneration: 1,
    secureLinkStatus: 'active',
    secureLinkLastError: null,
    secureLinkTargetNetwork: 'application-net',
    secureLinkTargetContainer: 'application',
    secureLinkTargetHost: null,
    secureLinkListenerPort: 41001,
    secureLinkConnectorPort: 42001,
    secureLinkMigratedAt: new Date('2026-09-01T00:00:00Z'),
    sslEnabled: false,
    sslForced: false,
    http2Support: true,
    websocketSupport: true,
    sslCertificateId: null,
    internalCertificateId: null,
    redirectUrl: null,
    redirectStatusCode: 301,
    customHeaders: [],
    cacheEnabled: false,
    cacheOptions: null,
    rateLimitEnabled: false,
    rateLimitOptions: null,
    customRewrites: [],
    advancedConfig: null,
    rawConfig: null,
    rawConfigEnabled: false,
    accessListId: null,
    nginxTemplateId: null,
    templateVariables: {},
    maintenanceEnabled: false,
    healthCheckEnabled: false,
    relaySpreadMode: 'inherit',
    relaySpreadCount: null,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  } as any;
}

/** A Route update over fakes: the stored row, the row the write returns, and the Secure Link service. */
function updateHarness(existing: any, updated: any) {
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn().mockResolvedValue(existing) },
      // The node runs with the Opfield names, so configs reach it as written.
      nodes: {
        findFirst: vi.fn().mockResolvedValue({ capabilities: { capabilities: [NGINX_OPFIELD_NAMES_CAPABILITY] } }),
      },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([updated]) })) })),
    })),
  } as any;
  const secureLinks = {
    prepare: vi.fn(async (host: unknown) => host),
    commitCutover: vi.fn(),
    activate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    getActiveAdditional: vi.fn().mockResolvedValue([]),
    getActiveAvailabilityMembers: vi.fn().mockResolvedValue([]),
    assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
  } as any;
  const renderForHost = vi.fn().mockResolvedValue('rendered config');
  const applyConfig = vi.fn().mockResolvedValue({ success: true });
  const service = new ProxyService(
    db,
    { renderForHost } as any,
    { log: vi.fn().mockResolvedValue(undefined) } as any,
    { validateAdvancedConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }) } as any,
    { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
    {} as any,
    undefined,
    secureLinks
  );
  vi.spyOn(service as any, 'queueSecureLinkRuntimeSample').mockReturnValue(undefined);
  return { service, secureLinks, renderForHost, applyConfig };
}

describe('Raw Config Mode on a Docker Route', () => {
  it('keeps the Secure Link the seeded raw config proxies to (Route dialog)', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ type: 'raw', rawConfigEnabled: true, rawConfig: SEEDED_RAW_CONFIG });
    const { service, secureLinks, applyConfig } = updateHarness(existing, updated);

    await service.updateProxyHost(
      HOST_ID,
      { type: 'raw', rawConfigEnabled: true, rawConfig: SEEDED_RAW_CONFIG, healthCheckEnabled: false } as any,
      'user-id'
    );

    // The node does not report maintenance flags: the apply carries no maintenance state.
    expect(applyConfig).toHaveBeenCalledWith(
      'nginx-node',
      HOST_ID,
      SEEDED_RAW_CONFIG,
      false,
      'user_owned',
      false,
      undefined
    );
    expect(secureLinks.cleanup).not.toHaveBeenCalled();
    // The link stays maintained (a raw config is never a reason to re-provision) and its listener reconciled.
    expect(secureLinks.prepare).toHaveBeenCalledWith(updated, false, false);
    expect(secureLinks.activate).toHaveBeenCalledWith(HOST_ID);
  });

  it('renders the Secure Link socket when raw mode is switched on without a raw config (MCP toggle)', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ rawConfigEnabled: true });
    const { service, secureLinks, renderForHost } = updateHarness(existing, updated);

    await service.updateProxyHost(HOST_ID, { rawConfigEnabled: true } as any, 'user-id');

    expect(secureLinks.cleanup).not.toHaveBeenCalled();
    expect(renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({ secureLinkUpstream: true, secureLinkSocketPath: SOCKET_PATH }),
      null,
      false
    );
  });

  it('returns to the managed config on the same link when raw mode is switched off', async () => {
    const existing = dockerRoute({ type: 'raw', rawConfigEnabled: true, rawConfig: SEEDED_RAW_CONFIG });
    const updated = dockerRoute({ rawConfig: SEEDED_RAW_CONFIG });
    const { service, secureLinks, renderForHost } = updateHarness(existing, updated);

    await service.updateProxyHost(HOST_ID, { type: 'proxy', rawConfigEnabled: false } as any, 'user-id');

    expect(secureLinks.prepare).toHaveBeenCalledWith(updated, true, false);
    expect(renderForHost).toHaveBeenCalledWith(
      expect.objectContaining({ secureLinkUpstream: true, secureLinkSocketPath: SOCKET_PATH }),
      null,
      false
    );
    expect(secureLinks.activate).toHaveBeenCalledWith(HOST_ID);
    expect(secureLinks.cleanup).not.toHaveBeenCalled();
  });
});

describe('Secure Link source of a raw-mode Route', () => {
  function linkService(host: any) {
    const sendProxySecureLinks = vi.fn().mockResolvedValue({
      success: true,
      detail: JSON.stringify({ bindings: [{ linkId: host.id, generation: host.secureLinkGeneration, port: 41002 }] }),
    });
    const db = {
      query: {
        proxyHosts: { findFirst: vi.fn().mockResolvedValue(host), findMany: vi.fn().mockResolvedValue([host]) },
        proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue([]) },
      },
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    } as any;
    const service = new ProxySecureLinkService(
      db,
      { sendProxySecureLinks, isNodeConnected: vi.fn().mockReturnValue(true) } as any,
      {} as any,
      'connector@sha256:test'
    );
    vi.spyOn(service as any, 'hostSources').mockResolvedValue(['nginx-node']);
    return { service, sendProxySecureLinks };
  }

  it('keeps the socket and the loopback listener after activation', async () => {
    const raw = dockerRoute({ type: 'raw', rawConfigEnabled: true, rawConfig: SEEDED_RAW_CONFIG });
    const { service, sendProxySecureLinks } = linkService(raw);

    await service.activate(HOST_ID);

    expect(sendProxySecureLinks).toHaveBeenCalledWith('nginx-node', [
      expect.objectContaining({ linkId: HOST_ID, generation: 1, sourceConfigManaged: false, socketOnly: false }),
    ]);
  });

  it('drops the loopback listener of a managed Route after activation', async () => {
    const managed = dockerRoute();
    const { service, sendProxySecureLinks } = linkService(managed);

    await service.activate(HOST_ID);

    expect(sendProxySecureLinks).toHaveBeenCalledWith('nginx-node', [
      expect.objectContaining({ linkId: HOST_ID, sourceConfigManaged: true, socketOnly: true }),
    ]);
  });
});

describe('Docker reconciliation of raw-mode Routes', () => {
  function reconcileHarness(host: any) {
    const db = {
      query: {
        proxyHosts: {
          findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([host]),
          findFirst: vi.fn().mockResolvedValue(host),
        },
      },
    } as any;
    const dockerUpstreams = {
      resolve: vi.fn().mockResolvedValue({
        upstreamKind: host.upstreamKind,
        dockerNodeId: host.dockerNodeId,
        dockerContainerName: host.dockerContainerName,
        dockerComposeProjectId: host.dockerComposeProjectId,
        dockerComposeServiceName: host.dockerComposeServiceName,
        dockerDeploymentId: host.dockerDeploymentId,
        dockerContainerPort: host.dockerContainerPort,
        dockerProtocol: host.dockerProtocol,
      }),
    } as any;
    const provisioned = {
      ...host,
      secureLinkGeneration: 1,
      secureLinkStatus: 'cutover_ready',
      secureLinkListenerPort: 41002,
    };
    const secureLinks = {
      cleanup: vi.fn().mockResolvedValue(undefined),
      reconcileExisting: vi.fn().mockResolvedValue(provisioned),
      commitCutover: vi.fn().mockResolvedValue({ ...provisioned, secureLinkMigratedAt: new Date() }),
      activate: vi.fn().mockResolvedValue(undefined),
      getActiveAvailabilityMembers: vi.fn().mockResolvedValue([]),
    } as any;
    const service = new ProxyService(
      db,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dockerUpstreams,
      secureLinks
    );
    const withdrawHost = vi.spyOn(service as any, 'withdrawHost').mockResolvedValue(undefined);
    const deliverHost = vi.spyOn(service as any, 'deliverHost').mockResolvedValue({ configs: new Map() });
    vi.spyOn(service as any, 'queueSecureLinkRuntimeSample').mockReturnValue(undefined);
    vi.spyOn(service as any, 'scheduleDockerReconciliationRetry').mockReturnValue(undefined);
    return { service, dockerUpstreams, secureLinks, withdrawHost, deliverHost };
  }

  it('keeps the active Secure Link of a raw-mode Route and lets it follow its target', async () => {
    const raw = dockerRoute({ type: 'raw', rawConfigEnabled: true, rawConfig: SEEDED_RAW_CONFIG });
    const { service, dockerUpstreams, secureLinks } = reconcileHarness(raw);

    await (service as any).reconcileDockerUpstreams(false);

    expect(secureLinks.cleanup).not.toHaveBeenCalled();
    expect(dockerUpstreams.resolve).toHaveBeenCalledWith(raw, { allowPortRebind: true });
  });

  it('brings back a Secure Link an earlier release tore down under a raw config that proxies to it', async () => {
    const broken = dockerRoute({
      type: 'raw',
      rawConfigEnabled: true,
      rawConfig: SEEDED_RAW_CONFIG,
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
      secureLinkListenerPort: null,
      secureLinkMigratedAt: null,
    });
    const { service, secureLinks, deliverHost } = reconcileHarness(broken);

    await (service as any).reconcileDockerUpstreams(false);

    expect(secureLinks.reconcileExisting).toHaveBeenCalledWith(broken);
    expect(secureLinks.commitCutover).toHaveBeenCalledWith(HOST_ID);
    expect(deliverHost).toHaveBeenCalledOnce();
    expect(secureLinks.activate).toHaveBeenCalledWith(HOST_ID);
  });

  it('leaves a raw-mode Route with its own upstream without a Secure Link', async () => {
    const ownUpstream = dockerRoute({
      type: 'raw',
      rawConfigEnabled: true,
      rawConfig: 'server { listen 80; location / { proxy_pass http://10.0.0.5:8080; } }',
      secureLinkGeneration: 0,
      secureLinkStatus: 'legacy',
      secureLinkMigratedAt: null,
    });
    const { service, dockerUpstreams, secureLinks } = reconcileHarness(ownUpstream);

    await (service as any).reconcileDockerUpstreams(false);

    expect(dockerUpstreams.resolve).not.toHaveBeenCalled();
    expect(secureLinks.reconcileExisting).not.toHaveBeenCalled();
  });
});
