import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';
import { dockerTargetUnavailableError } from './proxy.service.mutations.js';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST_ID = '33333333-3333-4333-8333-333333333333';

function dockerRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: HOST_ID,
    type: 'proxy',
    domainNames: ['shop.example.com'],
    slug: 'shop-example-com',
    enabled: true,
    isSystem: false,
    nodeId: 'nginx-node',
    ingressGroupId: null,
    upstreamKind: 'docker_container',
    dockerNodeId: 'node-a',
    dockerContainerName: 'app',
    dockerComposeProjectId: null,
    dockerComposeServiceName: null,
    dockerDeploymentId: null,
    dockerContainerPort: 8080,
    dockerHostPort: null,
    dockerProtocol: 'tcp',
    forwardHost: '127.0.0.1',
    forwardPort: 1,
    forwardScheme: 'http',
    // Served by Availability members: its own link was retired.
    secureLinkGeneration: 0,
    secureLinkStatus: 'legacy',
    secureLinkLastError: null,
    secureLinkTargetNetwork: null,
    secureLinkTargetContainer: null,
    secureLinkTargetHost: null,
    secureLinkListenerPort: null,
    secureLinkConnectorPort: null,
    secureLinkMigratedAt: new Date('2026-10-01T00:00:00Z'),
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
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as any;
}

/** A Route update over fakes: the stored row, the row the write returns, Availability and the Secure Link service. */
function harness(existing: any, updated: any, options: { managed: boolean; members?: any[] }) {
  const sets: Record<string, unknown>[] = [];
  const db = {
    query: {
      proxyHosts: { findFirst: vi.fn().mockResolvedValueOnce(existing).mockResolvedValue(updated) },
      proxyAdditionalSecureLinks: { findMany: vi.fn().mockResolvedValue(options.members ?? []) },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        sets.push(values);
        return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...updated, ...values }]) })) };
      }),
    })),
    transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) =>
      write({ execute: vi.fn(), update: db.update })
    ),
  } as any;
  const secureLinks = {
    prepare: vi.fn(async (host: unknown) => host),
    commitCutover: vi.fn(async () => updated),
    activate: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    reconcileExisting: vi.fn().mockResolvedValue(undefined),
    reconcileTargetNode: vi.fn().mockResolvedValue(undefined),
    getActiveAdditional: vi.fn().mockResolvedValue([]),
    getActiveAvailabilityMembers: vi.fn().mockResolvedValue(options.members ?? []),
    deleteAvailabilityMember: vi.fn().mockResolvedValue(undefined),
    assertAdditionalReferences: vi.fn().mockResolvedValue(undefined),
  } as any;
  const applyConfig = vi.fn().mockResolvedValue({ success: true });
  const service = new ProxyService(
    db,
    { renderForHost: vi.fn().mockResolvedValue('rendered config') } as any,
    { log: vi.fn().mockResolvedValue(undefined) } as any,
    { validateAdvancedConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }) } as any,
    { resolveNodeId: vi.fn().mockResolvedValue('nginx-node'), applyConfig } as any,
    {} as any,
    undefined,
    secureLinks
  );
  vi.spyOn(service as any, 'queueSecureLinkRuntimeSample').mockReturnValue(undefined);
  const reconciler = vi.fn().mockResolvedValue(options.managed);
  service.setAvailabilityIngressReconciler(reconciler);
  return { service, secureLinks, reconciler, applyConfig, sets };
}

const liveMember = { id: 'member-a', referenceId: 'placement-a', dormant: false };

describe('Routes of Availability workloads (C-1)', () => {
  it('edits a Route its live members serve without a link of its own to the stopped original', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ websocketSupport: false });
    const { service, secureLinks, reconciler, applyConfig } = harness(existing, updated, {
      managed: true,
      members: [liveMember],
    });

    await service.updateProxyHost(HOST_ID, { websocketSupport: false } as any, 'user-id');

    expect(reconciler).toHaveBeenCalledWith(HOST_ID);
    expect(secureLinks.prepare).not.toHaveBeenCalled();
    expect(secureLinks.commitCutover).not.toHaveBeenCalled();
    expect(secureLinks.activate).not.toHaveBeenCalled();
    expect(applyConfig).toHaveBeenCalled();
  });

  it('keeps the own link path while only dormant standbys hold members', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ websocketSupport: false });
    const { service, secureLinks } = harness(existing, updated, {
      managed: true,
      members: [{ ...liveMember, dormant: true }],
    });

    await service.updateProxyHost(HOST_ID, { websocketSupport: false } as any, 'user-id');

    expect(secureLinks.prepare).toHaveBeenCalled();
    expect(secureLinks.activate).toHaveBeenCalledWith(HOST_ID);
  });

  it('lets a Route pointed away from the workload release its members once its own link is active', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ dockerNodeId: 'node-c', dockerContainerName: 'other' });
    const { service, secureLinks, reconciler } = harness(existing, updated, { managed: false });

    await service.updateProxyHost(HOST_ID, { websocketSupport: false } as any, 'user-id');

    expect(secureLinks.prepare).toHaveBeenCalled();
    expect(secureLinks.activate).toHaveBeenCalledWith(HOST_ID);
    // Before the own link (projection first) and after it is active (release of the members).
    expect(reconciler).toHaveBeenCalledTimes(2);
    expect(secureLinks.activate.mock.invocationCallOrder[0]).toBeLessThan(reconciler.mock.invocationCallOrder[1]!);
  });

  it('answers 409 when the target container is not running', async () => {
    const existing = dockerRoute();
    const updated = dockerRoute({ websocketSupport: false });
    const { service, secureLinks } = harness(existing, updated, { managed: false });
    secureLinks.prepare.mockRejectedValue(new Error('resolve secure-link abc: target container is unavailable'));

    await expect(service.updateProxyHost(HOST_ID, { websocketSupport: false } as any, 'user-id')).rejects.toMatchObject(
      { statusCode: 409, code: 'DOCKER_TARGET_UNAVAILABLE' }
    );
  });

  it('commits the cutover marker of a Route that Availability serves from the start', async () => {
    const existing = dockerRoute({ secureLinkMigratedAt: null });
    const { service, sets } = harness(existing, existing, { managed: true, members: [liveMember] });

    const projected = await (service as any).projectAvailabilityIngress(HOST_ID);

    expect(projected.secureLinkMigratedAt).toBeInstanceOf(Date);
    expect(sets).toContainEqual(expect.objectContaining({ secureLinkMigratedAt: expect.any(Date) }));
  });

  it('removes the members of a Route that switched to a manual upstream', async () => {
    const route = dockerRoute({ upstreamKind: 'manual' });
    const { service, secureLinks } = harness(route, route, {
      managed: false,
      members: [{ ...liveMember, availabilityOwnerKey: `proxy-host:${HOST_ID}` }],
    });

    await (service as any).releaseAvailabilityMembers(route);

    expect(secureLinks.deleteAvailabilityMember).toHaveBeenCalledWith(route, 'placement-a', `proxy-host:${HOST_ID}`);
  });
});

describe('dockerTargetUnavailableError', () => {
  it('maps the daemon error of a stopped target and nothing else', () => {
    expect(
      dockerTargetUnavailableError(new Error('resolve secure-link x: target container is unavailable'))
    ).toMatchObject({ statusCode: 409, code: 'DOCKER_TARGET_UNAVAILABLE' });
    expect(dockerTargetUnavailableError(new Error('relay policy rejected'))).toBeNull();
  });
});

describe('Availability member of a Route whose port changed', () => {
  function memberService(existing: any) {
    const sets: Record<string, unknown>[] = [];
    const db = {
      query: { proxyAdditionalSecureLinks: { findFirst: vi.fn().mockResolvedValue(existing) } },
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          sets.push(values);
          return { where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ ...existing, ...values }]) })) };
        }),
      })),
    } as any;
    const service = new ProxySecureLinkService(db, {} as any, {} as any, 'connector@sha256:test');
    vi.spyOn(service as any, 'hostSources').mockResolvedValue(['nginx-node']);
    vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
    const reprovision = vi
      .spyOn(service as any, 'createAdditionalFromExisting')
      .mockResolvedValue({ ...existing, status: 'active', lastError: null });
    return { service, sets, reprovision };
  }

  const member = {
    id: 'member-a',
    status: 'active',
    lastError: null,
    dormant: false,
    dockerNodeId: 'node-b',
    targetNetwork: '',
    targetContainer: 'gwav-container-1',
    dockerContainerPort: 8080,
    dockerHostPort: 8080,
    dockerComposeServiceName: null,
  };
  const input = (port: number) => ({
    placementId: 'placement-a',
    ingressOwnerKey: `proxy-host:${HOST_ID}`,
    dockerNodeId: 'node-b',
    upstreamKind: 'docker_container' as const,
    forwardScheme: 'http' as const,
    dockerContainerName: 'gwav-container-1',
    dockerContainerPort: port,
    dockerHostPort: port,
    targetNetwork: '',
    targetContainer: 'gwav-container-1',
  });

  it('re-provisions the member on the new port', async () => {
    const { service, sets, reprovision } = memberService(member);

    await service.ensureAvailabilityMember(dockerRoute(), input(9090));

    expect(sets).toContainEqual(expect.objectContaining({ dockerContainerPort: 9090, dockerHostPort: 9090 }));
    expect(reprovision).toHaveBeenCalledWith(expect.objectContaining({ id: HOST_ID }), 'member-a');
  });

  it('keeps a member whose target did not change', async () => {
    const { service, sets, reprovision } = memberService(member);

    await service.ensureAvailabilityMember(dockerRoute(), input(8080));

    expect(sets).toEqual([]);
    expect(reprovision).not.toHaveBeenCalled();
  });
});
