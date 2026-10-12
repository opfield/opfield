import { eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  aiConversationFolders,
  aiConversations,
  alerts,
  appEnvironments,
  apps,
  hostingOperations,
  hostingResources,
  inferenceLimitPolicies,
  inferenceModels,
  inferenceProviderConnections,
  ingressGroups,
  integrationConnectors,
  managedDatabaseInstances,
  managedStorageClusters,
  nodes,
  oauthClients,
  proxyAdditionalRoutes,
  proxyHosts,
  relayInstances,
  siemDeliveries,
  siemDestinations,
  users,
} from '@/db/schema/index.js';
import { inferAIToolResourceType } from '@/modules/ai/ai-resource-references.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resource types of AI and MCP tool rows, mapped to the audit resource types names are resolved for. */
const TOOL_RESOURCE_TYPES: Record<string, string> = {
  proxy_host: 'proxy_host',
  ssl_certificate: 'ssl_certificate',
  access_list: 'access_list',
  domain: 'domain',
  ca: 'ca',
  pki_certificate: 'certificate',
  database: 'database',
  node: 'node',
  notification_webhook: 'notification_webhook',
  notification_rule: 'notification_alert_rule',
  proxy_template: 'nginx_template',
  docker_deployment: 'docker-deployment',
  docker_registry: 'docker-registry',
};

/**
 * The resource type an audit row's name is looked up under. AI (`ai.<tool>`) and MCP (`mcp.<tool>`) tool rows are
 * written under the tool's category; their resource id is the target's, so it is looked up as the target's type.
 */
export function auditLookupType(entry: {
  action: string;
  resourceType: string;
  details: Record<string, unknown> | null;
}): string {
  const details = entry.details ?? {};
  const isToolRow =
    (entry.action.startsWith('mcp.') || entry.action.startsWith('ai.')) &&
    (typeof details.toolName === 'string' || (details.arguments !== null && typeof details.arguments === 'object'));
  if (!isToolRow) return entry.resourceType;
  const toolName = typeof details.toolName === 'string' ? details.toolName : entry.action.split('.').slice(1).join('.');
  const args = (details.arguments && typeof details.arguments === 'object' ? details.arguments : {}) as Record<
    string,
    unknown
  >;
  const target = inferAIToolResourceType(toolName, args);
  return (target && TOOL_RESOURCE_TYPES[target]) ?? entry.resourceType;
}

type Add = (type: string, id: string | null | undefined, name: string | null | undefined) => void;

/**
 * Names for the resource types added in 2.12 and the ones resolveResourceNames did not know: apps and environments,
 * relay instances, managed databases and storage, integrations, ingress groups, inference, OAuth clients, hosting,
 * AI conversations, alerts, SIEM deliveries and additional routes. Only UUIDs are looked up.
 */
export async function resolveMoreResourceNames(
  db: DrizzleClient,
  idsOf: (type: string) => string[],
  add: Add
): Promise<void> {
  const uuids = (...types: string[]) => [...new Set(types.flatMap(idsOf))].filter((id) => UUID.test(id));
  const lookups: Array<Promise<void>> = [];
  const lookup = (types: string[], run: (ids: string[]) => Promise<Array<{ id: string; name: string | null }>>) => {
    const ids = uuids(...types);
    if (!ids.length) return;
    lookups.push(
      run(ids).then((rows) => {
        for (const row of rows) for (const type of types) add(type, row.id, row.name);
      })
    );
  };

  lookup(['app'], (ids) => db.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, ids)));
  lookup(['app_environment'], (ids) =>
    db
      .select({ id: appEnvironments.id, name: sql<string>`${apps.name} || ' / ' || ${appEnvironments.name}` })
      .from(appEnvironments)
      .innerJoin(apps, eq(apps.id, appEnvironments.appId))
      .where(inArray(appEnvironments.id, ids))
  );
  lookup(['relay_instance', 'relay-instance'], (ids) =>
    db
      .select({ id: relayInstances.id, name: relayInstances.displayName })
      .from(relayInstances)
      .where(inArray(relayInstances.id, ids))
  );
  lookup(['managed_database'], (ids) =>
    db
      .select({ id: managedDatabaseInstances.id, name: managedDatabaseInstances.name })
      .from(managedDatabaseInstances)
      .where(inArray(managedDatabaseInstances.id, ids))
  );
  lookup(['managed_storage'], (ids) =>
    db
      .select({ id: managedStorageClusters.id, name: managedStorageClusters.name })
      .from(managedStorageClusters)
      .where(inArray(managedStorageClusters.id, ids))
  );
  lookup(['integration-connector'], (ids) =>
    db
      .select({ id: integrationConnectors.id, name: integrationConnectors.name })
      .from(integrationConnectors)
      .where(inArray(integrationConnectors.id, ids))
  );
  lookup(['ingress_group'], (ids) =>
    db
      .select({ id: ingressGroups.id, name: ingressGroups.name })
      .from(ingressGroups)
      .where(inArray(ingressGroups.id, ids))
  );
  lookup(['inference_provider_connection'], (ids) =>
    db
      .select({ id: inferenceProviderConnections.id, name: inferenceProviderConnections.name })
      .from(inferenceProviderConnections)
      .where(inArray(inferenceProviderConnections.id, ids))
  );
  lookup(['inference_model'], (ids) =>
    db
      .select({ id: inferenceModels.id, name: inferenceModels.displayName })
      .from(inferenceModels)
      .where(inArray(inferenceModels.id, ids))
  );
  lookup(['inference_limit_policy'], (ids) =>
    db
      .select({
        id: inferenceLimitPolicies.id,
        name: sql<string>`coalesce(${users.email}, initcap(${inferenceLimitPolicies.policyType}) || ' limit')`,
      })
      .from(inferenceLimitPolicies)
      .leftJoin(users, eq(users.id, inferenceLimitPolicies.userId))
      .where(inArray(inferenceLimitPolicies.id, ids))
  );
  lookup(['hosting-resource'], (ids) =>
    db
      .select({
        id: hostingResources.id,
        name: sql<string>`coalesce(${hostingResources.snapshot}->>'name', ${hostingResources.remoteId})`,
      })
      .from(hostingResources)
      .where(inArray(hostingResources.id, ids))
  );
  lookup(['hosting-operation'], (ids) =>
    db
      .select({
        id: hostingOperations.id,
        name: sql<string>`${hostingOperations.action} || coalesce(' · ' || coalesce(${hostingResources.snapshot}->>'name', ${hostingOperations.request}->>'name'), '')`,
      })
      .from(hostingOperations)
      .leftJoin(hostingResources, eq(hostingResources.id, hostingOperations.resourceId))
      .where(inArray(hostingOperations.id, ids))
  );
  lookup(['docker-node'], (ids) =>
    db
      .select({ id: nodes.id, name: sql<string>`coalesce(nullif(${nodes.displayName}, ''), ${nodes.hostname})` })
      .from(nodes)
      .where(inArray(nodes.id, ids))
  );
  lookup(['ai-conversation'], (ids) =>
    db
      .select({ id: aiConversations.id, name: aiConversations.title })
      .from(aiConversations)
      .where(inArray(aiConversations.id, ids))
  );
  lookup(['ai-conversation-folder'], (ids) =>
    db
      .select({ id: aiConversationFolders.id, name: aiConversationFolders.name })
      .from(aiConversationFolders)
      .where(inArray(aiConversationFolders.id, ids))
  );
  lookup(['alert'], (ids) =>
    db
      .select({ id: alerts.id, name: sql<string>`left(${alerts.message}, 120)` })
      .from(alerts)
      .where(inArray(alerts.id, ids))
  );
  lookup(['siem-delivery'], (ids) =>
    db
      .select({ id: siemDeliveries.id, name: siemDestinations.name })
      .from(siemDeliveries)
      .innerJoin(siemDestinations, eq(siemDestinations.id, siemDeliveries.destinationId))
      .where(inArray(siemDeliveries.id, ids))
  );
  lookup(['proxy_additional_route'], (ids) =>
    db
      .select({
        id: proxyAdditionalRoutes.id,
        name: sql<string>`coalesce((${proxyHosts.domainNames})->>0, '') || ${proxyAdditionalRoutes.path}`,
      })
      .from(proxyAdditionalRoutes)
      .leftJoin(proxyHosts, eq(proxyHosts.id, proxyAdditionalRoutes.proxyHostId))
      .where(inArray(proxyAdditionalRoutes.id, ids))
  );

  // OAuth clients are keyed by their client id, not a UUID.
  const clientIds = idsOf('oauth-client');
  if (clientIds.length) {
    lookups.push(
      db
        .select({ id: oauthClients.clientId, name: oauthClients.clientName })
        .from(oauthClients)
        .where(inArray(oauthClients.clientId, clientIds))
        .then((rows) => {
          for (const row of rows) add('oauth-client', row.id, row.name);
        })
    );
  }

  await Promise.all(lookups);
}
