import { asArray, unwrapData } from './api-client.js';
import { e2eName } from './config.js';
import {
  asRow,
  findDockerComposeNode,
  findDockerNode,
  firstId,
  getDockerContainerId,
  getSystemConfig,
  isLocalDockerRuntimeUnavailable,
  listRows,
  type Row,
  resolveDockerRuntimeImage,
  skipWithoutMutations,
  skipWithoutRuntimeMutations,
  sleep,
  waitForContainerVisible,
  waitForDockerTask,
} from './scenario-helpers.js';
import {
  expectApiAccessible,
  expectApiAccessibleOrFeatureDisabled,
  expectOk,
  expectSessionOnly,
  expectStatus,
  type TestCase,
  test,
} from './test-harness.js';

export const scenarios: TestCase[] = [
  test('health endpoint reports dependency status', async (ctx) => {
    const response = await ctx.client.get('/health', { auth: false });
    if (ctx.config.allowUnhealthy) {
      expectStatus(response, [200, 503], 'GET /health');
    } else {
      expectStatus(response, 200, 'GET /health');
    }
  }),

  test('OpenAPI is reachable and legacy nginx management routes are absent', async (ctx) => {
    const response = await ctx.client.get<{ paths?: Record<string, unknown> }>('/openapi.json');
    expectOk(response, 'GET /openapi.json');
    const paths = Object.keys(response.body.paths ?? {});
    const legacy = paths.filter((path) => path.startsWith('/api/monitoring/nginx'));
    if (legacy.length > 0) throw new Error(`Legacy nginx management paths still documented: ${legacy.join(', ')}`);
  }),

  test('API token is rejected from browser-session-only surfaces', async (ctx) => {
    expectSessionOnly(await ctx.client.get('/auth/me'), 'GET /auth/me');
    expectSessionOnly(await ctx.client.get('/api/tokens'), 'GET /api/tokens');
    expectSessionOnly(await ctx.client.get('/api/ai/status'), 'GET /api/ai/status');
    expectSessionOnly(await ctx.client.get('/api/admin/users'), 'GET /api/admin/users');
  }),

  test('all no-parameter OpenAPI GET routes are API-accessible or explicitly session-only', async (ctx) => {
    const openapi = await ctx.client.get<{ paths?: Record<string, Record<string, unknown>> }>('/openapi.json');
    expectOk(openapi, 'GET /openapi.json');
    const skipPrefixes = [
      '/auth/',
      '/api/admin',
      '/api/ai',
      '/api/tokens',
      '/api/oauth/authorize',
      '/api/oauth/authorizations',
      '/api/oauth/consent',
      '/api/mcp',
      '/api/setup',
      '/api/public/status-page',
      '/api/webhooks/docker',
      '/docs',
    ];
    const skipFragments = ['/stream', '/release-notes'];
    const paths = Object.entries(openapi.body.paths ?? {})
      .filter(([path, methods]) => methods.get && !path.includes('{'))
      .map(([path]) => path)
      .filter((path) => path !== '/openapi.json' && path !== '/health')
      .filter((path) => !skipPrefixes.some((prefix) => path.startsWith(prefix)))
      .filter((path) => !skipFragments.some((fragment) => path.includes(fragment)))
      .sort();

    for (const path of paths) {
      const response = await ctx.client.get(path);
      if (response.status === 403 && response.text.includes('browser session')) {
        expectSessionOnly(response, `GET ${path}`);
      } else if (
        (response.status === 403 || response.status === 503) &&
        response.text.includes('"code":"FEATURE_DISABLED"')
      ) {
      } else if (path.startsWith('/api/logging/')) {
        expectApiAccessibleOrFeatureDisabled(response, `GET ${path}`, 'LOGGING_DISABLED');
      } else {
        expectApiAccessible(response, `GET ${path}`);
      }
    }
  }),

  test('core resource list APIs are reachable', async (ctx) => {
    const paths = [
      '/api/nodes',
      '/api/proxy-hosts',
      '/api/proxy-host-folders',
      '/api/nginx-templates',
      '/api/ssl-certificates',
      '/api/domains',
      '/api/access-lists',
      '/api/cas',
      '/api/certificates',
      '/api/templates',
      '/api/databases',
      '/api/docker/registries',
      '/api/docker/tasks',
      '/api/monitoring/dashboard',
      '/api/monitoring/health-status',
      '/api/system/version',
      '/api/system/config',
      '/api/system/daemon-updates',
      '/api/system/license/status',
      '/api/housekeeping/config',
      '/api/housekeeping/stats',
      '/api/housekeeping/history',
      '/api/notifications/alert-rules',
      '/api/notifications/alert-rules/categories',
      '/api/notifications/alerts',
      '/api/notifications/alerts?status=all',
      '/api/notifications/webhooks',
      '/api/notifications/deliveries',
      '/api/notifications/deliveries/stats',
      '/api/logging/environments',
      '/api/logging/schemas',
      '/api/status-page/settings',
      '/api/status-page/services',
      '/api/status-page/incidents',
    ];

    for (const path of paths) {
      const response = await ctx.client.get(path, { query: path.includes('?') ? undefined : { limit: 5 } });
      if (path.startsWith('/api/logging/')) {
        expectApiAccessibleOrFeatureDisabled(response, `GET ${path}`, 'LOGGING_DISABLED');
      } else if (
        (response.status === 403 || response.status === 503) &&
        response.text.includes('"code":"FEATURE_DISABLED"')
      ) {
      } else {
        expectApiAccessible(response, `GET ${path}`);
      }
    }
  }),

  test('resource detail APIs work for existing visible rows', async (ctx) => {
    const resources = [
      {
        list: '/api/nodes',
        detail: (id: string) => `/api/nodes/${id}`,
        extras: [(id: string) => `/api/nodes/${id}/health-history`],
      },
      { list: '/api/proxy-hosts', detail: (id: string) => `/api/proxy-hosts/${id}` },
      { list: '/api/nginx-templates', detail: (id: string) => `/api/nginx-templates/${id}` },
      { list: '/api/ssl-certificates', detail: (id: string) => `/api/ssl-certificates/${id}` },
      { list: '/api/domains', detail: (id: string) => `/api/domains/${id}` },
      { list: '/api/access-lists', detail: (id: string) => `/api/access-lists/${id}` },
      { list: '/api/cas', detail: (id: string) => `/api/cas/${id}` },
      { list: '/api/certificates', detail: (id: string) => `/api/certificates/${id}` },
      { list: '/api/templates', detail: (id: string) => `/api/templates/${id}` },
      {
        list: '/api/databases',
        detail: (id: string) => `/api/databases/${id}`,
        extras: [(id: string) => `/api/databases/${id}/health-history`],
      },
      { list: '/api/docker/registries', detail: (id: string) => `/api/docker/registries/${id}` },
      { list: '/api/notifications/alert-rules', detail: (id: string) => `/api/notifications/alert-rules/${id}` },
      { list: '/api/notifications/webhooks', detail: (id: string) => `/api/notifications/webhooks/${id}` },
    ];

    for (const resource of resources) {
      const rows = await listRows(ctx, resource.list, { limit: 5 });
      const id = firstId(rows);
      if (!id) continue;
      expectApiAccessible(await ctx.client.get(resource.detail(id)), `GET ${resource.detail(id)}`);
      for (const extra of resource.extras ?? []) {
        expectApiAccessible(await ctx.client.get(extra(id)), `GET ${extra(id)}`);
      }
    }
  }),

  test('Docker node read APIs work for existing docker nodes', async (ctx) => {
    const nodes = await listRows(ctx, '/api/nodes', { type: 'docker', limit: 5 });
    const node = nodes.find((row) => row.status === 'online' && row.isConnected !== false) ?? nodes[0];
    if (!node?.id) return;

    const paths = [
      `/api/docker/nodes/${node.id}/containers`,
      `/api/docker/nodes/${node.id}/images`,
      `/api/docker/nodes/${node.id}/volumes`,
      `/api/docker/nodes/${node.id}/networks`,
      `/api/docker/nodes/${node.id}/deployments`,
      `/api/docker/nodes/${node.id}/folders`,
    ];
    for (const path of paths) {
      const response = await ctx.client.get(path);
      expectApiAccessible(response, `GET ${path}`);
    }

    const containers = asArray<Row>((await ctx.client.get(`/api/docker/nodes/${node.id}/containers`)).body);
    for (const container of containers) {
      const containerId = container.id ?? container.Id;
      if (!containerId) continue;
      const detailPath = `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`;
      const detail = await ctx.client.get(detailPath);
      if (detail.status < 200 || detail.status > 299) continue;
      const responses = [detail];
      for (const path of [
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/logs`,
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stats`,
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/env`,
      ]) {
        responses.push(await ctx.client.get(path));
      }
      if (responses.some((response) => response.status === 502 && response.text.includes('No such container'))) {
        continue;
      }
      expectApiAccessible(responses[0], `GET ${detailPath}`);
      expectApiAccessible(
        responses[1],
        `GET /api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/logs`
      );
      expectApiAccessible(
        responses[2],
        `GET /api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stats`
      );
      expectApiAccessible(
        responses[3],
        `GET /api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/env`
      );
      break;
    }
  }),

  test('connected PostgreSQL databases allow safe read-only query checks', async (ctx) => {
    const databases = await listRows(ctx, '/api/databases', { type: 'postgres', limit: 20 });
    const database =
      databases.find((row) => row.healthStatus === 'online') ??
      databases.find((row) => row.healthStatus === 'degraded') ??
      null;
    if (!database?.id) return;

    expectApiAccessible(await ctx.client.get(`/api/databases/${database.id}/postgres/schemas`), 'GET Postgres schemas');
    expectOk(
      await ctx.client.post(`/api/databases/${database.id}/postgres/query`, {
        sql: 'select 1 as e2e_check',
        maxRows: 5,
      }),
      'POST Postgres read-only query'
    );
  }),

  test(
    'metadata mutations create, update, and clean up core records',
    async (ctx) => {
      const pendingNode = await ctx.client.post('/api/nodes', {
        type: 'docker',
        hostname: `${e2eName('pending-node')}.local`,
        displayName: 'API e2e pending node',
      });
      expectOk(pendingNode, 'POST /api/nodes');
      const pendingNodeId = (asRow(pendingNode.body).node as Row | undefined)?.id;
      if (pendingNodeId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/nodes/${pendingNodeId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/nodes/${pendingNodeId}`), 'GET pending node');
        expectOk(
          await ctx.client.patch(`/api/nodes/${pendingNodeId}`, { displayName: 'API e2e pending node updated' }),
          'PATCH pending node'
        );
        expectOk(
          await ctx.client.patch(`/api/nodes/${pendingNodeId}/service-creation-lock`, {
            serviceCreationLocked: true,
          }),
          'PATCH pending node service creation lock'
        );
        expectOk(
          await ctx.client.patch(`/api/nodes/${pendingNodeId}/service-creation-lock`, {
            serviceCreationLocked: false,
          }),
          'PATCH pending node service creation unlock'
        );
      }

      const accessListName = e2eName('acl');
      const accessList = await ctx.client.post('/api/access-lists', {
        name: accessListName,
        ipRules: [],
        basicAuthEnabled: false,
        basicAuthUsers: [],
      });
      expectOk(accessList, 'POST /api/access-lists');
      const accessListId = unwrapData<Row>(accessList.body).id;
      if (accessListId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/access-lists/${accessListId}`);
        });
        expectOk(
          await ctx.client.put(`/api/access-lists/${accessListId}`, { name: `${accessListName}-updated` }),
          'PUT access list'
        );
        expectApiAccessible(await ctx.client.get(`/api/access-lists/${accessListId}`), 'GET created access list');
      }

      const registryName = e2eName('registry');
      const registry = await ctx.client.post('/api/docker/registries', {
        name: registryName,
        url: `https://${registryName}.example.test`,
        authType: 'none',
      });
      expectOk(registry, 'POST /api/docker/registries');
      const registryId = unwrapData<Row>(registry.body).id;
      if (registryId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/docker/registries/${registryId}`);
        });
        expectOk(
          await ctx.client.put(`/api/docker/registries/${registryId}`, { name: `${registryName}-updated` }),
          'PUT registry'
        );
        expectApiAccessible(await ctx.client.get(`/api/docker/registries/${registryId}`), 'GET created registry');
      }

      const nginxNodes = await ctx.client.get('/api/domains/nginx-nodes');
      expectApiAccessible(nginxNodes, 'GET /api/domains/nginx-nodes');
      const eligibleNodes = unwrapData<{ eligibleNodes?: Array<Row & { effectiveAddress?: string }> }>(
        nginxNodes.body
      ).eligibleNodes;
      const ingressNode = eligibleNodes?.find((node) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(node.effectiveAddress ?? ''));
      if (ingressNode?.id && ingressNode.effectiveAddress) {
        const dnsLabel = ingressNode.effectiveAddress.replaceAll('.', '-');
        const domainName = `${e2eName('domain')}.${dnsLabel}.sslip.io`;
        const domain = await ctx.client.post('/api/domains', {
          domain: domainName,
          description: 'created by API e2e',
          dnsProvider: 'external',
          nginxNodeId: ingressNode.id,
        });
        expectOk(domain, 'POST /api/domains');
        const domainId = unwrapData<Row>(domain.body).id;
        if (domainId) {
          ctx.cleanup.push(async () => {
            await ctx.client.delete(`/api/domains/${domainId}`);
          });
          expectOk(
            await ctx.client.put(`/api/domains/${domainId}`, { description: 'updated by API e2e' }),
            'PUT domain'
          );
          expectApiAccessible(await ctx.client.get(`/api/domains/${domainId}`), 'GET created domain');
          expectApiAccessible(await ctx.client.post(`/api/domains/${domainId}/check-dns`), 'POST domain DNS check');
        }
      }
    },
    skipWithoutMutations
  ),

  test(
    'proxy metadata mutations cover folders and nginx templates',
    async (ctx) => {
      const folder = await ctx.client.post('/api/proxy-host-folders', { name: e2eName('proxy-folder') });
      expectOk(folder, 'POST /api/proxy-host-folders');
      const folderId = asRow(folder.body).id;
      if (folderId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/proxy-host-folders/${folderId}`);
        });
        expectOk(
          await ctx.client.put(`/api/proxy-host-folders/${folderId}`, { name: e2eName('proxy-folder-updated') }),
          'PUT proxy folder'
        );
        expectOk(
          await ctx.client.put(`/api/proxy-host-folders/${folderId}/move`, { parentId: null }),
          'PUT proxy folder move'
        );
        expectOk(
          await ctx.client.put('/api/proxy-host-folders/reorder', { items: [{ id: folderId, sortOrder: 0 }] }),
          'PUT proxy folder reorder'
        );
      }

      const templateContent = [
        'server {',
        '  listen 80;',
        '  server_name example.test;',
        '  location / {',
        '    proxy_pass http://127.0.0.1:8080;',
        '  }',
        '}',
      ].join('\n');
      const template = await ctx.client.post('/api/nginx-templates', {
        name: e2eName('nginx-template'),
        type: 'proxy',
        content: templateContent,
        variables: [],
      });
      if (template.status === 403 && template.text.includes('"code":"BROWSER_SESSION_REQUIRED"')) {
        expectSessionOnly(template, 'POST /api/nginx-templates with template content');
        return;
      }
      expectOk(template, 'POST /api/nginx-templates');
      const templateId = asRow(template.body).id;
      if (templateId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/nginx-templates/${templateId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/nginx-templates/${templateId}`), 'GET created nginx template');
        expectOk(
          await ctx.client.put(`/api/nginx-templates/${templateId}`, { description: 'updated by API e2e' }),
          'PUT nginx template'
        );
        expectOk(
          await ctx.client.post('/api/nginx-templates/preview', { content: templateContent }),
          'POST nginx template preview'
        );
        const clone = await ctx.client.post(`/api/nginx-templates/${templateId}/clone`);
        expectOk(clone, 'POST nginx template clone');
        const cloneId = asRow(clone.body).id;
        if (cloneId) {
          ctx.cleanup.push(async () => {
            await ctx.client.delete(`/api/nginx-templates/${cloneId}`);
          });
          expectApiAccessible(await ctx.client.get(`/api/nginx-templates/${cloneId}`), 'GET cloned nginx template');
        }
      }
    },
    skipWithoutMutations
  ),

  test(
    'proxy host runtime mutation covers create, detail, update, toggle, and delete when nginx node exists',
    async (ctx) => {
      const nginxNodes = await listRows(ctx, '/api/nodes', { type: 'nginx', limit: 10 });
      const node = nginxNodes.find((row) => row.status === 'online' && row.isConnected !== false);
      if (!node?.id) return;

      const host = await ctx.client.post('/api/proxy-hosts', {
        type: '404',
        nodeId: node.id,
        domainNames: [`${e2eName('proxy')}.example.test`],
        customHeaders: [],
        customRewrites: [],
        cacheEnabled: false,
        rateLimitEnabled: false,
        sslEnabled: false,
        sslForced: false,
        http2Support: true,
        websocketSupport: false,
        healthCheckEnabled: false,
      });
      expectOk(host, 'POST /api/proxy-hosts');
      const hostId = asRow(host.body).id;
      if (hostId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/proxy-hosts/${hostId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/proxy-hosts/${hostId}`), 'GET created proxy host');
        expectApiAccessible(
          await ctx.client.get(`/api/proxy-hosts/${hostId}/health-history`),
          'GET proxy host health history'
        );
        expectOk(
          await ctx.client.put(`/api/proxy-hosts/${hostId}`, {
            customHeaders: [{ name: 'X-E2E', value: 'true' }],
          }),
          'PUT proxy host'
        );
        expectOk(await ctx.client.post(`/api/proxy-hosts/${hostId}/toggle`, { enabled: false }), 'POST proxy toggle');
      }
    },
    skipWithoutRuntimeMutations
  ),

  test(
    'PKI metadata mutations cover CA and certificate templates',
    async (ctx) => {
      const ca = await ctx.client.post('/api/cas', {
        commonName: e2eName('root-ca'),
        keyAlgorithm: 'ecdsa-p256',
        validityYears: 1,
        maxValidityDays: 30,
      });
      if (ca.status === 403 && ca.text.includes('"code":"FEATURE_DISABLED"')) return;
      expectOk(ca, 'POST /api/cas');
      const caId = asRow(ca.body).id;
      if (caId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/cas/${caId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/cas/${caId}`), 'GET created CA');
        expectOk(await ctx.client.put(`/api/cas/${caId}`, { maxValidityDays: 31 }), 'PUT CA');

        const issuedCert = await ctx.client.post('/api/certificates', {
          caId,
          type: 'tls-server',
          commonName: `${e2eName('cert')}.example.test`,
          sans: [`${e2eName('cert-san')}.example.test`],
          keyAlgorithm: 'ecdsa-p256',
          validityDays: 7,
        });
        expectOk(issuedCert, 'POST /api/certificates/issue');
        const issuedCertRow = asRow(issuedCert.body);
        const certId = (issuedCertRow.certificate as Row | undefined)?.id ?? issuedCertRow.id;
        if (certId) {
          ctx.cleanup.push(async () => {
            await ctx.db.query('delete from certificates where id = $1', [certId]);
          });
          expectApiAccessible(await ctx.client.get(`/api/certificates/${certId}`), 'GET issued certificate');
          expectApiAccessible(
            await ctx.client.get(`/api/certificates/${certId}/chain`),
            'GET issued certificate chain'
          );

          const sslCert = await ctx.client.post('/api/ssl-certificates/internal', {
            internalCertId: certId,
            name: e2eName('internal-ssl'),
          });
          expectOk(sslCert, 'POST /api/ssl-certificates/internal');
          const sslCertId = asRow(sslCert.body).id;
          if (sslCertId) {
            ctx.cleanup.push(async () => {
              await ctx.client.delete(`/api/ssl-certificates/${sslCertId}`);
            });
            expectApiAccessible(await ctx.client.get(`/api/ssl-certificates/${sslCertId}`), 'GET linked SSL cert');
          }

          expectOk(
            await ctx.client.post(`/api/certificates/${certId}/revoke`, { reason: 'cessationOfOperation' }),
            'POST revoke issued certificate'
          );
        }
      }

      const template = await ctx.client.post('/api/templates', {
        name: e2eName('pki-template'),
        description: 'created by API e2e',
        certType: 'tls-server',
        keyAlgorithm: 'ecdsa-p256',
        validityDays: 30,
        keyUsage: ['digitalSignature', 'keyEncipherment'],
        extKeyUsage: ['serverAuth'],
        requireSans: true,
        sanTypes: ['dns'],
        subjectDnFields: {},
        crlDistributionPoints: [],
        authorityInfoAccess: {},
        certificatePolicies: [],
        customExtensions: [],
      });
      expectOk(template, 'POST /api/templates');
      const templateId = asRow(template.body).id;
      if (templateId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/templates/${templateId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/templates/${templateId}`), 'GET created PKI template');
        expectOk(
          await ctx.client.patch(`/api/templates/${templateId}`, { description: 'updated by API e2e' }),
          'PATCH PKI template'
        );
      }
    },
    skipWithoutMutations
  ),

  test(
    'status page mutations cover services and incident lifecycle',
    async (ctx) => {
      const nodeId = firstId(await listRows(ctx, '/api/nodes', { limit: 1 }));
      let serviceId: string | null = null;

      if (nodeId) {
        const service = await ctx.client.post('/api/status-page/services', {
          sourceType: 'node',
          sourceId: nodeId,
          publicName: e2eName('status-service'),
          publicDescription: 'created by API e2e',
          publicGroup: 'API e2e',
          enabled: false,
        });
        expectOk(service, 'POST /api/status-page/services');
        serviceId = asRow(service.body).id ?? null;
        if (serviceId) {
          ctx.cleanup.push(async () => {
            await ctx.client.delete(`/api/status-page/services/${serviceId}`);
          });
          expectOk(
            await ctx.client.put(`/api/status-page/services/${serviceId}`, { publicDescription: 'updated by API e2e' }),
            'PUT status page service'
          );
        }
      }

      const incident = await ctx.client.post('/api/status-page/incidents', {
        title: e2eName('incident'),
        message: 'created by API e2e',
        severity: 'info',
        affectedServiceIds: serviceId ? [serviceId] : [],
      });
      expectOk(incident, 'POST /api/status-page/incidents');
      const incidentId = asRow(incident.body).id;
      if (incidentId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/status-page/incidents/${incidentId}`);
        });
        expectOk(
          await ctx.client.post(`/api/status-page/incidents/${incidentId}/updates`, {
            message: 'investigating from API e2e',
            status: 'investigating',
          }),
          'POST status page incident update'
        );
        expectOk(
          await ctx.client.put(`/api/status-page/incidents/${incidentId}`, { severity: 'warning' }),
          'PUT status page incident'
        );
        expectOk(await ctx.client.post(`/api/status-page/incidents/${incidentId}/resolve`), 'POST resolve incident');
      }
    },
    skipWithoutMutations
  ),

  test(
    'notification mutations cover webhook and alert rule lifecycle',
    async (ctx) => {
      const webhook = await ctx.client.post('/api/notifications/webhooks', {
        name: e2eName('webhook'),
        url: 'https://example.test/opfield-e2e',
        method: 'POST',
        enabled: false,
        signingHeader: 'X-Signature-256',
        bodyTemplate: '{"message":"{{event.title}}"}',
        headers: {},
      });
      expectOk(webhook, 'POST /api/notifications/webhooks');
      const webhookId = asRow(webhook.body).id;
      if (webhookId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/notifications/webhooks/${webhookId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/notifications/webhooks/${webhookId}`), 'GET created webhook');
        expectOk(
          await ctx.client.put(`/api/notifications/webhooks/${webhookId}`, { enabled: false }),
          'PUT notification webhook'
        );
      }

      expectOk(
        await ctx.client.post('/api/notifications/webhooks/preview', { bodyTemplate: '{"title":"{{event.title}}"}' }),
        'POST notification webhook preview'
      );

      const rule = await ctx.client.post('/api/notifications/alert-rules', {
        name: e2eName('alert-rule'),
        enabled: false,
        type: 'event',
        category: 'node',
        severity: 'info',
        eventPattern: 'node.*',
        resourceIds: [],
        webhookIds: webhookId ? [webhookId] : [],
        cooldownSeconds: 0,
      });
      expectOk(rule, 'POST /api/notifications/alert-rules');
      const ruleId = asRow(rule.body).id;
      if (ruleId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/notifications/alert-rules/${ruleId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/notifications/alert-rules/${ruleId}`), 'GET created alert rule');
        expectOk(
          await ctx.client.put(`/api/notifications/alert-rules/${ruleId}`, { severity: 'warning' }),
          'PUT alert rule'
        );
      }
    },
    skipWithoutMutations
  ),

  test(
    'logging mutations cover schema, environment, token, and ingest when available',
    async (ctx) => {
      const systemConfig = await getSystemConfig(ctx);
      if (!systemConfig.features?.loggingEnabled) return;

      const schemaSlug = e2eName('schema');
      const schema = await ctx.client.post('/api/logging/schemas', {
        name: schemaSlug,
        slug: schemaSlug,
        schemaMode: 'reject',
        fieldSchema: [],
      });
      expectOk(schema, 'POST /api/logging/schemas');
      const schemaId = asRow(schema.body).id;
      if (schemaId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/logging/schemas/${schemaId}`);
        });
        expectApiAccessible(await ctx.client.get(`/api/logging/schemas/${schemaId}`), 'GET created logging schema');
        expectOk(
          await ctx.client.put(`/api/logging/schemas/${schemaId}`, { description: 'updated by e2e' }),
          'PUT logging schema'
        );
      }

      const environmentSlug = e2eName('logs-env');
      const environment = await ctx.client.post('/api/logging/environments', {
        name: environmentSlug,
        slug: environmentSlug,
        description: 'created by API e2e',
        enabled: true,
        schemaId,
        schemaMode: 'reject',
        retentionDays: 1,
        fieldSchema: [],
      });
      expectOk(environment, 'POST /api/logging/environments');
      const environmentId = asRow(environment.body).id;
      if (environmentId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/logging/environments/${environmentId}`);
        });
        expectApiAccessible(
          await ctx.client.get(`/api/logging/environments/${environmentId}`),
          'GET created logging environment'
        );
        expectOk(
          await ctx.client.put(`/api/logging/environments/${environmentId}`, { description: 'updated by e2e' }),
          'PUT logging environment'
        );

        const token = await ctx.client.post(`/api/logging/environments/${environmentId}/tokens`, {
          name: e2eName('logs-token'),
        });
        expectOk(token, 'POST logging token');
        const tokenRow = asRow(token.body);
        const tokenId = tokenRow.id;
        const rawToken = tokenRow.token;
        if (tokenId) {
          ctx.cleanup.push(async () => {
            await ctx.client.delete(`/api/logging/environments/${environmentId}/tokens/${tokenId}`);
          });
          expectApiAccessible(
            await ctx.client.get(`/api/logging/environments/${environmentId}/tokens`),
            'GET logging tokens'
          );
        }

        if (typeof rawToken === 'string') {
          expectOk(
            await ctx.client.post(
              '/api/logging/ingest',
              {
                severity: 'info',
                message: 'API e2e ingest smoke',
                service: 'opfield-e2e',
                labels: { suite: 'api' },
              },
              { auth: false, headers: { Authorization: `Bearer ${rawToken}` } }
            ),
            'POST logging ingest'
          );
          expectApiAccessible(
            await ctx.client.post(`/api/logging/environments/${environmentId}/search`, {
              query: { type: 'text', value: 'API e2e ingest smoke' },
              limit: 5,
            }),
            'POST logging search'
          );
        }
      }
    },
    skipWithoutMutations
  ),

  test(
    'Docker node safe mutations cover folders, volumes, and networks',
    async (ctx) => {
      const node = await findDockerNode(ctx);

      const folder = await ctx.client.post('/api/docker/folders', { name: e2eName('docker-folder') });
      expectOk(folder, 'POST /api/docker/folders');
      const folderId = asRow(folder.body).id;
      if (folderId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/docker/folders/${folderId}`);
        });
        expectOk(
          await ctx.client.put(`/api/docker/folders/${folderId}`, { name: e2eName('docker-folder-updated') }),
          'PUT docker folder'
        );
        expectOk(
          await ctx.client.put('/api/docker/folders/reorder', { items: [{ id: folderId, sortOrder: 0 }] }),
          'PUT docker folder reorder'
        );
      }

      if (!node?.id) return;

      const volumeName = e2eName('volume').replaceAll('-', '_');
      const volume = await ctx.client.post(`/api/docker/nodes/${node.id}/volumes`, {
        name: volumeName,
      });
      expectOk(volume, 'POST docker volume');
      ctx.cleanup.push(async () => {
        await ctx.client.delete(`/api/docker/nodes/${node.id}/volumes/${encodeURIComponent(volumeName)}`, {
          query: { force: true },
        });
      });
      const volumeList = await ctx.client.get(`/api/docker/nodes/${node.id}/volumes`, {
        query: { search: volumeName },
      });
      expectApiAccessible(volumeList, 'GET created docker volume via search');

      const networkName = e2eName('network').replaceAll('-', '_');
      const network = await ctx.client.post(`/api/docker/nodes/${node.id}/networks`, {
        name: networkName,
        driver: 'bridge',
      });
      expectOk(network, 'POST docker network');
      const networkId = asRow(network.body).id ?? asRow(network.body).Id ?? networkName;
      ctx.cleanup.push(async () => {
        await ctx.client.delete(`/api/docker/nodes/${node.id}/networks/${encodeURIComponent(networkId)}`);
      });
      const networkList = await ctx.client.get(`/api/docker/nodes/${node.id}/networks`, {
        query: { search: networkName },
      });
      expectApiAccessible(networkList, 'GET created docker network via search');
    },
    skipWithoutMutations
  ),

  test(
    'Docker container runtime mutations cover disposable container lifecycle',
    async (ctx) => {
      const node = await findDockerNode(ctx);
      if (!node?.id) return;

      const image = await resolveDockerRuntimeImage(ctx, node.id);
      if (!image) return;

      const name = e2eName('container');
      let containerId: string | undefined;
      const created = await ctx.client.post(`/api/docker/nodes/${node.id}/containers`, {
        image,
        name,
        labels: { 'opfield.e2e': 'true' },
        restartPolicy: 'no',
      });
      expectOk(created, 'POST docker container');
      containerId = getDockerContainerId(created.body);
      if (!containerId) {
        const visible = await waitForContainerVisible(ctx, node.id, name);
        containerId = (visible?.id ?? visible?.Id) as string | undefined;
      }
      if (!containerId) throw new Error('Created Docker container did not return or expose an id');
      ctx.cleanup.push(async () => {
        await ctx.client
          .post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId!)}/stop`, { timeout: 2 })
          .catch(() => undefined);
        await ctx.client.delete(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId!)}`, {
          query: { force: true },
        });
      });

      expectApiAccessible(
        await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`),
        'GET created docker container'
      );

      const duplicateName = e2eName('container-copy');
      const duplicate = await ctx.client.post(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/duplicate`,
        { name: duplicateName }
      );
      expectOk(duplicate, 'POST duplicate docker container');
      const duplicateId = getDockerContainerId(duplicate.body);
      if (duplicateId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(duplicateId)}`, {
            query: { force: true },
          });
        });
      }

      const renamedName = e2eName('container-renamed');
      expectOk(
        await ctx.client.post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/rename`, {
          name: renamedName,
        }),
        'POST rename docker container'
      );

      const secret = await ctx.client.post(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/secrets`,
        { key: 'CODEX_E2E_SECRET', value: 'initial-secret' }
      );
      expectOk(secret, 'POST docker container secret');
      const secretId = asRow(secret.body).id;
      if (secretId) {
        ctx.cleanup.push(async () => {
          await ctx.client.delete(
            `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId!)}/secrets/${secretId}`
          );
        });
        expectApiAccessible(
          await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/secrets`),
          'GET docker container secrets'
        );
        expectOk(
          await ctx.client.put(
            `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/secrets/${secretId}`,
            { value: 'updated-secret' }
          ),
          'PUT docker container secret'
        );
      }

      const envUpdate = await ctx.client.put(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/env`,
        {
          env: { CODEX_E2E_ENV: 'updated' },
          removeEnv: ['CODEX_E2E_REMOVED'],
        }
      );
      expectOk(envUpdate, 'PUT docker container env');
      const envTaskId = asRow(envUpdate.body).taskId;
      if (typeof envTaskId === 'string') await waitForDockerTask(ctx, envTaskId);
      const afterEnv = await waitForContainerVisible(ctx, node.id, renamedName);
      containerId = ((afterEnv?.id ?? afterEnv?.Id) as string | undefined) ?? containerId;
      expectApiAccessible(
        await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/env`),
        'GET docker container env'
      );

      expectOk(
        await ctx.client.post(
          `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/live-update`,
          {
            restartPolicy: 'no',
            memoryLimit: 67_108_864,
          }
        ),
        'POST docker live update'
      );

      const volumeName = e2eName('container-volume').replaceAll('-', '_');
      expectOk(
        await ctx.client.post(`/api/docker/nodes/${node.id}/volumes`, {
          name: volumeName,
        }),
        'POST docker container test volume'
      );
      ctx.cleanup.push(async () => {
        if (containerId) {
          await ctx.client
            .post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stop`, { timeout: 2 })
            .catch(() => undefined);
          await ctx.client
            .delete(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`, {
              query: { force: true },
            })
            .catch(() => undefined);
        }
        await ctx.client.delete(`/api/docker/nodes/${node.id}/volumes/${encodeURIComponent(volumeName)}`, {
          query: { force: true },
        });
      });

      const recreate = await ctx.client.post(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/recreate`,
        {
          ports: [{ hostPort: 0, containerPort: 8080, protocol: 'tcp' }],
          mounts: [{ name: volumeName, containerPath: '/tmp/codex-e2e-data', readOnly: false }],
          env: { CODEX_E2E_RECREATE: 'true' },
          labels: { 'opfield.e2e.recreated': 'true' },
          restartPolicy: 'no',
        }
      );
      expectOk(recreate, 'POST docker recreate with runtime settings');
      const recreateTaskId = asRow(recreate.body).taskId;
      if (typeof recreateTaskId === 'string') await waitForDockerTask(ctx, recreateTaskId);
      const afterRecreate = await waitForContainerVisible(ctx, node.id, renamedName);
      const replacementId = (afterRecreate?.id ?? afterRecreate?.Id) as string | undefined;
      if (!replacementId || replacementId === containerId) {
        throw new Error('Docker recreate task completed without exposing the replacement container id');
      }
      containerId = replacementId;

      const startResponse = await ctx.client.post(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/start`
      );
      if (startResponse.status < 200 || startResponse.status > 299) {
        if (isLocalDockerRuntimeUnavailable(startResponse.text)) {
          console.log(
            '- INFO Docker runtime start/stop branch skipped: local Docker runtime cannot start nested containers'
          );
          return;
        }
        expectOk(startResponse, 'POST start docker container');
      }
      await sleep(1000);
      const inspectAfterStart = await ctx.client.get<Row>(
        `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`
      );
      expectApiAccessible(inspectAfterStart, 'GET started docker container');
      const running = Boolean(asRow(inspectAfterStart.body).State?.Running);

      expectApiAccessible(
        await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/logs`, {
          query: { tail: 20 },
        }),
        'GET docker container logs'
      );
      expectApiAccessible(
        await ctx.client.get(
          `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stats/history`
        ),
        'GET docker container stats history'
      );

      if (running) {
        expectApiAccessible(
          await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stats`),
          'GET docker container stats'
        );
        expectApiAccessible(
          await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/top`),
          'GET docker container top'
        );
        expectApiAccessible(
          await ctx.client.get(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/files`, {
            query: { path: '/tmp' },
          }),
          'GET docker container files'
        );
        expectOk(
          await ctx.client.post(
            `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/files/create`,
            'api e2e initial',
            { query: { path: '/tmp/codex-e2e.txt' }, headers: { 'Content-Type': 'application/octet-stream' } }
          ),
          'POST docker container file'
        );
        expectOk(
          await ctx.client.put(
            `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/files/write`,
            'api e2e',
            { query: { path: '/tmp/codex-e2e.txt' }, headers: { 'Content-Type': 'application/octet-stream' } }
          ),
          'PUT docker container file'
        );
        expectApiAccessible(
          await ctx.client.get(
            `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/files/read`,
            {
              query: { path: '/tmp/codex-e2e.txt' },
            }
          ),
          'GET docker container file'
        );

        expectOk(
          await ctx.client.post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/restart`, {
            timeout: 2,
          }),
          'POST restart docker container'
        );
        await waitForContainerVisible(ctx, node.id, renamedName);
        expectOk(
          await ctx.client.post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/stop`, {
            timeout: 2,
          }),
          'POST stop docker container'
        );
        await waitForContainerVisible(ctx, node.id, renamedName);
        expectOk(
          await ctx.client.post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/start`),
          'POST restart stopped docker container'
        );
        await waitForContainerVisible(ctx, node.id, renamedName);
        expectOk(
          await ctx.client.post(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}/kill`, {
            signal: 'SIGTERM',
          }),
          'POST kill docker container'
        );
        await waitForContainerVisible(ctx, node.id, renamedName);
        expectOk(
          await ctx.client.delete(`/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`, {
            query: { force: true },
          }),
          'DELETE disposable docker container'
        );
        expectOk(
          await ctx.client.delete(`/api/docker/nodes/${node.id}/volumes/${encodeURIComponent(volumeName)}`, {
            query: { force: true },
          }),
          'DELETE docker container test volume'
        );
      }
    },
    skipWithoutRuntimeMutations
  ),

  test(
    'Docker Compose runtime mutations cover validation, revisions, ownership, and lifecycle',
    async (ctx) => {
      const node = await findDockerComposeNode(ctx);
      if (!node?.id) return;

      const image = await resolveDockerRuntimeImage(ctx, node.id);
      if (!image) return;

      const projectName = e2eName('compose');
      const buildValidation = await ctx.client.post(`/api/docker/nodes/${node.id}/compose-projects/validate`, {
        projectName: `${projectName}-build`,
        yaml: 'services:\n  app:\n    build: .\n',
        variables: {},
        secretKeys: [],
      });
      expectOk(buildValidation, 'POST Compose build validation');
      const buildValidationRow = asRow(buildValidation.body);
      if (buildValidationRow.valid !== false || !JSON.stringify(buildValidationRow).includes('BUILD_FORBIDDEN')) {
        throw new Error(
          `Compose build validation did not return BUILD_FORBIDDEN: ${buildValidation.text.slice(0, 500)}`
        );
      }

      const composeYaml = [
        'services:',
        '  app:',
        `    image: ${JSON.stringify(image)}`,
        '    restart: unless-stopped',
        '    cpus: 0.25',
        '    mem_limit: 64m',
        '    environment:',
        `      CODEX_E2E_ENV: \${CODEX_E2E_ENV}`,
        `      CODEX_E2E_SECRET: \${CODEX_E2E_SECRET}`,
        '    volumes:',
        '      - e2e-data:/tmp/codex-e2e-data',
        'volumes:',
        '  e2e-data:',
        '',
      ].join('\n');
      const create = await ctx.client.post(`/api/docker/nodes/${node.id}/compose-projects`, {
        projectName,
        yaml: composeYaml,
        variables: { CODEX_E2E_ENV: 'initial' },
        secretKeys: ['CODEX_E2E_SECRET'],
      });
      expectOk(create, 'POST Compose project');
      const created = asRow(create.body);
      const projectId = created.project?.id as string | undefined;
      const initialRevisionId = created.revision?.id as string | undefined;
      if (!projectId || !initialRevisionId)
        throw new Error('Created Compose project did not return project and revision ids');

      const projectPath = `/api/docker/nodes/${node.id}/compose-projects/${projectId}`;
      let composeVolumeNames = [`${projectName}_e2e-data`];
      const waitForOperation = async (operationId: string) => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const operations = await listRows(ctx, `${projectPath}/operations`);
          const operation = operations.find((row) => row.id === operationId);
          if (operation?.status === 'succeeded') return operation;
          if (operation?.status === 'failed' || operation?.status === 'cancelled') {
            throw new Error(`Compose operation ${operationId} ${operation.status}: ${operation.error ?? ''}`);
          }
          await sleep(1000);
        }
        throw new Error(`Timed out waiting for Compose operation ${operationId}`);
      };
      const runAction = async (
        action: string,
        revisionId?: string,
        idempotencyKey = e2eName(`compose-${action}`),
        volumeNames: string[] = []
      ) => {
        const response = await ctx.client.post(`${projectPath}/actions/${action}`, {
          revisionId,
          idempotencyKey,
          removeOrphans: false,
          volumeNames,
        });
        expectOk(response, `POST Compose ${action}`);
        const operation = asRow(response.body);
        if (!operation.id) throw new Error(`Compose ${action} did not return an operation id`);
        await waitForOperation(operation.id);
        return { operation, idempotencyKey };
      };
      const presentComposeVolumes = async (volumeNames: string[]) => {
        const present: string[] = [];
        for (const volumeName of volumeNames) {
          const response = await ctx.client.get(
            `/api/docker/nodes/${node.id}/volumes/${encodeURIComponent(volumeName)}`
          );
          if (response.status === 404) continue;
          if (response.status >= 200 && response.status < 300) {
            present.push(volumeName);
            continue;
          }
          throw new Error(
            `GET Compose volume ${volumeName} returned ${response.status}: ${response.text.slice(0, 500)}`
          );
        }
        return present;
      };
      const waitForComposeVolumesAbsent = async (volumeNames: string[]) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const present = await presentComposeVolumes(volumeNames);
          if (present.length === 0) return;
          await sleep(1000);
        }
        throw new Error(`Compose volumes still exist after deletion: ${volumeNames.join(', ')}`);
      };

      ctx.cleanup.push(async () => {
        const down = await ctx.client.post(`${projectPath}/actions/down`, {
          idempotencyKey: e2eName('compose-cleanup-down'),
          removeOrphans: true,
          volumeNames: [],
        });
        const downOperation = asRow(down.body);
        if (down.status >= 200 && down.status < 300 && downOperation.id) {
          await waitForOperation(downOperation.id).catch(() => undefined);
        }
        if (composeVolumeNames.length > 0) {
          const remainingVolumeNames = await presentComposeVolumes(composeVolumeNames);
          if (remainingVolumeNames.length > 0) {
            await runAction('delete_volumes', undefined, e2eName('compose-cleanup-volumes'), remainingVolumeNames);
            await waitForComposeVolumesAbsent(remainingVolumeNames);
          }
        }
        await ctx.client.delete(projectPath);
      });

      const secret = await ctx.client.post(`${projectPath}/secrets`, {
        key: 'CODEX_E2E_SECRET',
        value: 'compose-secret-value',
      });
      expectOk(secret, 'POST Compose secret');
      const secretId = asRow(secret.body).id as string | undefined;
      if (!secretId) throw new Error('Created Compose secret did not return an id');
      const secrets = await listRows(ctx, `${projectPath}/secrets`);
      if (!secrets.some((row) => row.id === secretId && row.key === 'CODEX_E2E_SECRET')) {
        throw new Error('Created Compose secret was not listed');
      }

      const applyKey = e2eName('compose-apply');
      const applied = await runAction('apply', initialRevisionId, applyKey);
      const repeatedApply = await ctx.client.post(`${projectPath}/actions/apply`, {
        revisionId: initialRevisionId,
        idempotencyKey: applyKey,
        removeOrphans: false,
        volumeNames: [],
      });
      expectOk(repeatedApply, 'POST idempotent Compose apply');
      if (asRow(repeatedApply.body).id !== applied.operation.id) {
        throw new Error('Repeated Compose apply did not return the reserved operation');
      }

      let project: Row | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const detail = await ctx.client.get(projectPath);
        expectApiAccessible(detail, 'GET applied Compose project');
        project = asRow(detail.body);
        if (Array.isArray(project.volumeNames) && project.volumeNames.length > 0) {
          composeVolumeNames = project.volumeNames;
        }
        if (project.runningServiceCount === 1 && project.services?.[0]?.containerIds?.[0]) break;
        await sleep(1000);
      }
      const containerId = project?.services?.[0]?.containerIds?.[0] as string | undefined;
      if (!containerId || project?.status !== 'running') {
        throw new Error(`Applied Compose project did not become running: ${JSON.stringify(project)}`);
      }

      const containers = await listRows(ctx, `/api/docker/nodes/${node.id}/containers`, { search: projectName });
      if (containers.some((row) => row.id === containerId || row.Id === containerId)) {
        throw new Error('Compose-owned container leaked into the global container list');
      }
      const volumes = await listRows(ctx, `/api/docker/nodes/${node.id}/volumes`, { search: projectName });
      if (volumes.length > 0) throw new Error('Compose-owned volume leaked into the global volume list');
      const networks = await listRows(ctx, `/api/docker/nodes/${node.id}/networks`, { search: projectName });
      if (networks.length > 0) throw new Error('Compose-owned network leaked into the global network list');

      const childPath = `/api/docker/nodes/${node.id}/containers/${encodeURIComponent(containerId)}`;
      expectApiAccessible(await ctx.client.get(childPath), 'GET Compose-owned child container');
      const childStop = await ctx.client.post(`${childPath}/stop`, { timeout: 2 });
      expectStatus(childStop, 409, 'POST stop Compose-owned child container');
      if (!childStop.text.includes('COMPOSE_RESOURCE_MANAGED')) {
        throw new Error(`Compose-owned child mutation returned an unexpected error: ${childStop.text.slice(0, 500)}`);
      }

      const updatedYaml = composeYaml.replace(
        `CODEX_E2E_ENV: \${CODEX_E2E_ENV}`,
        `CODEX_E2E_ENV: \${CODEX_E2E_ENV}\n      CODEX_E2E_REVISION: two`
      );
      const revision = await ctx.client.post(`${projectPath}/revisions`, {
        yaml: updatedYaml,
        variables: { CODEX_E2E_ENV: 'updated' },
        secretKeys: ['CODEX_E2E_SECRET'],
      });
      expectOk(revision, 'POST Compose revision');
      const updatedRevisionId = asRow(revision.body).id as string | undefined;
      if (!updatedRevisionId) throw new Error('Created Compose revision did not return an id');
      await runAction('apply', updatedRevisionId);
      expectOk(
        await ctx.client.delete(`${projectPath}/revisions/${initialRevisionId}`),
        'DELETE inactive Compose revision'
      );

      await runAction('restart');
      await runAction('stop');
      await runAction('start');
      await runAction('down');
      await runAction('delete_volumes', undefined, e2eName('compose-delete-volumes'), composeVolumeNames);
      await waitForComposeVolumesAbsent(composeVolumeNames);
      expectOk(await ctx.client.delete(projectPath), 'DELETE stopped Compose project');
    },
    skipWithoutRuntimeMutations
  ),
];
