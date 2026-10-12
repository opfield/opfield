import { describe, expect, it } from 'vitest';
import { appEnvironments, apps, oauthClients, relayInstances } from '@/db/schema/index.js';
import { __testOnly } from '@/middleware/audit-context.js';
import { auditLookupType, resolveMoreResourceNames } from './audit-resource-names.js';

const APP = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';
const RELAY = '33333333-3333-4333-8333-333333333333';

/** Answers each lookup with the rows of the table it reads, whatever the filter. */
function fakeDb(rows: Map<unknown, Array<{ id: string; name: string }>>) {
  const queried: unknown[] = [];
  return {
    queried,
    db: {
      select: () => {
        let table: unknown;
        const chain = {
          from: (from: unknown) => {
            table = from;
            queried.push(from);
            return chain;
          },
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(rows.get(table) ?? []),
        };
        return chain;
      },
    } as never,
  };
}

describe('audit resource names', () => {
  it('names apps, environments, relay instances and OAuth clients, and looks up only what the page holds', async () => {
    const { db, queried } = fakeDb(
      new Map<unknown, Array<{ id: string; name: string }>>([
        [apps, [{ id: APP, name: 'Shop' }]],
        [appEnvironments, [{ id: ENV, name: 'Shop / live' }]],
        [relayInstances, [{ id: RELAY, name: 'relay-eu' }]],
        [oauthClients, [{ id: 'mcp-client-1', name: 'Claude' }]],
      ])
    );
    const ids: Record<string, string[]> = {
      app: [APP],
      app_environment: [ENV, 'not-a-uuid'],
      'relay-instance': [RELAY],
      'oauth-client': ['mcp-client-1'],
    };
    const names = new Map<string, string>();
    await resolveMoreResourceNames(
      db,
      (type) => ids[type] ?? [],
      (type, id, name) => {
        if (id && name) names.set(`${type}:${id}`, name);
      }
    );
    expect(Object.fromEntries(names)).toMatchObject({
      [`app:${APP}`]: 'Shop',
      [`app_environment:${ENV}`]: 'Shop / live',
      [`relay-instance:${RELAY}`]: 'relay-eu',
      [`relay_instance:${RELAY}`]: 'relay-eu',
      'oauth-client:mcp-client-1': 'Claude',
    });
    expect(queried).toHaveLength(4);
  });

  it('looks AI and MCP tool rows up under the type of the resource they acted on', () => {
    expect(
      auditLookupType({
        action: 'mcp.update_route',
        resourceType: 'routes',
        details: { toolName: 'update_route', arguments: { id: 'r1' } },
      })
    ).toBe('proxy_host');
    expect(
      auditLookupType({ action: 'ai.manage_node', resourceType: 'nodes', details: { arguments: { nodeId: 'n1' } } })
    ).toBe('node');
    expect(
      auditLookupType({ action: 'ai.conversation_folder.delete', resourceType: 'ai-conversation-folder', details: {} })
    ).toBe('ai-conversation-folder');
    expect(auditLookupType({ action: 'node.update', resourceType: 'node', details: null })).toBe('node');
  });

  it('names the 2.12 routes that used to read Route Post / Http Route', () => {
    const resolve = __testOnly.resolveFallbackAuditTarget;
    expect(resolve('POST', '/api/system/configuration-export')).toMatchObject({
      action: 'system.configuration_export.prepare',
      resourceType: 'system',
    });
    expect(resolve('POST', `/api/apps/${APP}/promotions/preview`)).toEqual({
      action: 'app.promotion.preview',
      resourceType: 'app',
      resourceId: APP,
    });
    expect(resolve('PUT', `/api/apps/${APP}/environments/${ENV}/variables`)).toEqual({
      action: 'app.environment.variables.update',
      resourceType: 'app_environment',
      resourceId: ENV,
    });
    expect(resolve('DELETE', `/api/apps/${APP}/environments/${ENV}/nodes/n1`)).toMatchObject({
      action: 'app.environment.remove_node',
      resourceId: ENV,
    });
  });
});
