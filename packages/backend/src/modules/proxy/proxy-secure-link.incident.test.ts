import { describe, expect, it, vi } from 'vitest';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST = { id: '11111111-1111-4111-8111-111111111111', type: 'proxy', nodeId: 'nginx-node' } as any;
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const INCIDENT_ID = '33333333-3333-4333-8333-333333333333';

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    proxyHostId: HOST.id,
    name: 'api',
    purpose: 'user_managed',
    upstreamKind: 'docker_container',
    dockerNodeId: 'docker-node',
    sourceNodeId: 'nginx-node',
    status: 'active',
    generation: 1,
    dormant: false,
    incidentSuspendedBy: null,
    ...overrides,
  };
}

function service(row: Record<string, unknown>) {
  const set = vi.fn();
  const db = {
    query: {
      proxyAdditionalSecureLinks: { findFirst: vi.fn(async () => row) },
      proxyHosts: { findFirst: vi.fn(async () => ({ nodeId: 'nginx-node', ingressGroupId: null })) },
    },
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        set(values);
        return { where: () => ({ returning: async () => [{ ...row, ...values }] }) };
      },
    })),
  };
  const secureLinks = new ProxySecureLinkService(
    db as never,
    {} as never,
    { revokeOwner: vi.fn() } as never,
    'connector@sha256:test',
    {} as never
  );
  const sources = vi.spyOn(secureLinks as any, 'syncSourceNodes').mockResolvedValue(undefined);
  const target = vi.spyOn(secureLinks as any, 'syncTargetNode').mockResolvedValue(undefined);
  vi.spyOn(secureLinks as any, 'bindingSources').mockResolvedValue(['nginx-node']);
  return { secureLinks, set, sources, target };
}

describe('Secure Links held closed by an app kill switch', () => {
  it('suspends a link, resyncs its sources and target, and reports the previous holder', async () => {
    const { secureLinks, set, sources, target } = service(link());
    await expect(secureLinks.setIncidentSuspended(LINK_ID, INCIDENT_ID)).resolves.toEqual({ previous: null });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ incidentSuspendedBy: INCIDENT_ID }));
    expect(sources).toHaveBeenCalledWith(['nginx-node']);
    expect(target).toHaveBeenCalledWith('docker-node');
  });

  it('opens it again on release without touching Availability dormancy', async () => {
    const { secureLinks, set } = service(link({ incidentSuspendedBy: INCIDENT_ID }));
    await expect(secureLinks.setIncidentSuspended(LINK_ID, null)).resolves.toEqual({ previous: INCIDENT_ID });
    expect(set).toHaveBeenCalledWith(expect.not.objectContaining({ dormant: expect.anything() }));
  });

  it('refuses retry and retarget while held, and answers a gone link with undefined', async () => {
    const { secureLinks } = service(link({ incidentSuspendedBy: INCIDENT_ID }));
    await expect(secureLinks.retryAdditional(HOST, LINK_ID)).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    await expect(
      secureLinks.retargetAdditional(HOST, LINK_ID, {
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-node',
        dockerContainerName: 'api',
        dockerContainerPort: 8080,
      } as never)
    ).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    const gone = service(null as never);
    await expect(gone.secureLinks.setIncidentSuspended(LINK_ID, INCIDENT_ID)).resolves.toBeUndefined();
  });

  it('refuses deleting a link while held, so the release finds it to open again', async () => {
    const { secureLinks, set } = service(link({ incidentSuspendedBy: INCIDENT_ID }));
    await expect(secureLinks.deleteAdditional(HOST, LINK_ID)).rejects.toMatchObject({ code: 'APP_ISOLATED' });
    expect(set).not.toHaveBeenCalled();
  });
});
