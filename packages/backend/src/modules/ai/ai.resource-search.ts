import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { extractBaseScope } from '@/lib/scopes.js';
import { canReachApps } from '@/modules/apps/app-access.js';
import type { AppMemberType } from '@/modules/apps/app-families.js';
import { AppMembershipService, memberKey } from '@/modules/apps/app-membership.js';
import { AppsService } from '@/modules/apps/apps.service.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import { dockerScopedNodeIds, hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import type { DockerSnapshotKind, DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { User } from '@/types.js';
import {
  compactDockerContainerForAgent,
  compactDockerImageForAgent,
  compactDockerNetworkForAgent,
  compactDockerVolumeForAgent,
  dockerContainerMatchesSearch,
  dockerImageMatchesSearch,
  dockerNetworkMatchesSearch,
  dockerVolumeMatchesSearch,
  textMatchesSearch,
} from './ai.service-helpers.js';

type ExecuteToolInternal = (user: User, toolName: string, args: Record<string, unknown>) => Promise<unknown>;

type ResourceSearchDeps = {
  executeToolInternal: ExecuteToolInternal;
  nodesService: NodesService;
  dockerService: DockerManagementService;
  dockerSnapshotService?: DockerSnapshotService;
};

type ResourceSearchItem = Record<string, unknown>;
type ResourceSearchError = { type: string; error: string };
type ResourceSearchBatch = {
  results: ResourceSearchItem[];
  errors: ResourceSearchError[];
};

const RESOURCE_SEARCH_CONCURRENCY = 6;

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const output = new Array<T>(tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      output[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return output;
}

export async function findResource(deps: ResourceSearchDeps, user: User, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  const requestedTypes = Array.isArray(args.types)
    ? new Set(args.types.map((type) => String(type).trim()).filter(Boolean))
    : new Set<string>();
  if (!query && requestedTypes.size === 0) throw new Error('query or types is required');

  const typeWanted = (...types: string[]) =>
    requestedTypes.size === 0 || types.some((type) => requestedTypes.has(type));
  const limitValue = typeof args.limit === 'number' ? args.limit : Number(args.limit);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 50) : 25;
  const searchTasks: Array<() => Promise<ResourceSearchBatch>> = [];

  const itemsOf = (value: unknown): Record<string, any>[] => {
    if (Array.isArray(value)) return value as Record<string, any>[];
    if (value && typeof value === 'object' && Array.isArray((value as any).data)) return (value as any).data;
    return [];
  };
  const add = (
    results: ResourceSearchItem[],
    type: string,
    item: Record<string, any>,
    options: {
      id?: unknown;
      name?: unknown;
      nodeId?: unknown;
      nodeSlug?: unknown;
      skipMatch?: boolean;
    } = {}
  ) => {
    if (results.length >= limit) return;
    if (
      !options.skipMatch &&
      !textMatchesSearch(
        [
          options.id,
          options.name,
          item.id,
          item.name,
          item.title,
          item.hostname,
          item.domain,
          item.domainNames,
          item.commonName,
          item.serialNumber,
          item.repoTags,
          item.image,
          item.status,
        ],
        query
      )
    ) {
      return;
    }
    const id = String(options.id ?? item.id ?? item.name ?? item.domain ?? '');
    results.push({
      type,
      id,
      name: options.name ?? item.name ?? item.title ?? item.hostname ?? item.domain ?? item.commonName ?? item.id ?? id,
      nodeId: options.nodeId ?? item.nodeId,
      nodeSlug: options.nodeSlug ?? item.nodeSlug,
      summary: item,
    });
  };
  const collect = async (
    type: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    map: (item: Record<string, any>) => {
      id?: unknown;
      name?: unknown;
      nodeId?: unknown;
      nodeSlug?: unknown;
    } = () => ({})
  ): Promise<ResourceSearchBatch> => {
    const batch: ResourceSearchBatch = { results: [], errors: [] };
    try {
      const serviceFiltered = toolArgs.search === query;
      for (const item of itemsOf(await deps.executeToolInternal(user, toolName, toolArgs))) {
        add(batch.results, type, item, { ...map(item), skipMatch: serviceFiltered });
        if (batch.results.length >= limit) break;
      }
    } catch (err) {
      batch.errors.push({ type, error: err instanceof Error ? err.message : 'search failed' });
    }
    return batch;
  };
  const flattenCas = (cas: Record<string, any>[]): Record<string, any>[] =>
    cas.flatMap((ca) => [ca, ...(Array.isArray(ca.children) ? flattenCas(ca.children) : [])]);

  if (typeWanted('app') && canReachApps(user.scopes) && container.isRegistered(AppsService)) {
    searchTasks.push(async () => {
      const batch: ResourceSearchBatch = { results: [], errors: [] };
      try {
        for (const app of await container.resolve(AppsService).list(user.scopes)) {
          add(batch.results, 'app', { id: app.id, name: app.name, slug: app.slug, path: `/apps/${app.slug}` });
          if (batch.results.length >= limit) break;
        }
      } catch (err) {
        batch.errors.push({ type: 'app', error: err instanceof Error ? err.message : 'search failed' });
      }
      return batch;
    });
  }
  if (typeWanted('node') && hasScopeBase(user.scopes, 'nodes:details')) {
    searchTasks.push(() =>
      collect('node', 'list_nodes', { search: query, limit }, (node) => ({
        id: node.id,
        name: node.displayName || node.hostname,
      }))
    );
  }
  if (typeWanted('proxy_host') && hasScopeBase(user.scopes, 'proxy:view')) {
    searchTasks.push(() =>
      collect('proxy_host', 'list_routes', { search: query, limit }, (host) => ({
        id: host.id,
        name: Array.isArray(host.domainNames) ? host.domainNames.join(', ') : host.id,
        nodeId: host.nodeId,
      }))
    );
  }
  if (typeWanted('proxy_template') && hasScopeBase(user.scopes, 'proxy:templates:view')) {
    searchTasks.push(() => collect('proxy_template', 'manage_proxy_template', { operation: 'list' }));
  }
  if (typeWanted('ssl_certificate') && hasScopeBase(user.scopes, 'ssl:cert:view')) {
    searchTasks.push(() =>
      collect('ssl_certificate', 'list_ssl_certificates', { search: query, limit }, (cert) => ({
        id: cert.id,
        name: cert.name || cert.commonName || (Array.isArray(cert.domains) ? cert.domains.join(', ') : cert.id),
      }))
    );
  }
  if (typeWanted('domain') && hasScopeBase(user.scopes, 'domains:view')) {
    searchTasks.push(() =>
      collect('domain', 'list_domains', { search: query, limit }, (domain) => ({
        id: domain.id,
        name: domain.domain,
      }))
    );
  }
  if (typeWanted('access_list') && hasScopeBase(user.scopes, 'acl:view')) {
    searchTasks.push(() => collect('access_list', 'list_access_lists', { search: query, limit }));
  }
  if (typeWanted('ca') && hasScopeBase(user.scopes, 'pki:ca:view')) {
    searchTasks.push(async () => {
      const batch: ResourceSearchBatch = { results: [], errors: [] };
      try {
        for (const ca of flattenCas(itemsOf(await deps.executeToolInternal(user, 'list_cas', {})))) {
          add(batch.results, 'ca', ca, { id: ca.id, name: ca.commonName });
          if (batch.results.length >= limit) break;
        }
      } catch (err) {
        batch.errors.push({ type: 'ca', error: err instanceof Error ? err.message : 'search failed' });
      }
      return batch;
    });
  }
  if (typeWanted('pki_certificate') && hasScopeBase(user.scopes, 'pki:cert:view')) {
    searchTasks.push(() =>
      collect('pki_certificate', 'list_certificates', { search: query, limit }, (cert) => ({
        id: cert.id,
        name: cert.commonName || cert.serialNumber,
      }))
    );
  }
  if (typeWanted('pki_template') && hasScopeBase(user.scopes, 'pki:templates:view')) {
    searchTasks.push(() =>
      collect('pki_template', 'list_templates', {}, (template) => ({
        id: template.id,
        name: template.name,
      }))
    );
  }
  if (typeWanted('database') && hasScopeBase(user.scopes, 'databases:view')) {
    searchTasks.push(() =>
      collect('database', 'list_databases', { search: query, limit }, (database) => ({
        id: database.id,
        name: database.name,
      }))
    );
  }
  if (typeWanted('page_project') && hasScopeBase(user.scopes, 'pages:view')) {
    searchTasks.push(() =>
      collect('page_project', 'manage_pages', { operation: 'project_list', search: query, limit }, (project) => ({
        id: project.id,
        name: project.name,
        nodeId: project.nodeId,
      }))
    );
  }
  if (typeWanted('docker_compose_project') && hasScopeBase(user.scopes, 'docker:compose:view')) {
    searchTasks.push(() =>
      collect(
        'docker_compose_project',
        'manage_docker_compose',
        { operation: 'list', nodeId: args.nodeId },
        (project) => ({
          id: project.id,
          name: project.name || project.projectName,
          nodeId: project.nodeId,
        })
      )
    );
  }
  if (
    typeWanted('docker_build') &&
    (hasScopeBase(user.scopes, 'docker:containers:view') ||
      hasScopeBase(user.scopes, 'docker:compose:view') ||
      hasScopeBase(user.scopes, 'pages:view'))
  ) {
    searchTasks.push(() =>
      collect('docker_build', 'list_docker_builds', { nodeId: args.nodeId, search: query, limit }, (build) => ({
        id: build.id,
        name: build.repositoryPath || build.repository || build.branch || build.id,
        nodeId: build.target?.nodeId,
      }))
    );
  }
  if (typeWanted('logging_environment') && hasScopeBase(user.scopes, 'logs:environments:view')) {
    searchTasks.push(() =>
      collect('logging_environment', 'manage_logging', {
        resource: 'environment',
        operation: 'list',
        search: query,
        allowedIds: hasScope(user.scopes, 'logs:environments:view')
          ? undefined
          : getResourceScopedIds(user.scopes, 'logs:environments:view'),
      })
    );
  }
  if (typeWanted('logging_schema') && hasScopeBase(user.scopes, 'logs:schemas:view')) {
    searchTasks.push(() =>
      collect('logging_schema', 'manage_logging', {
        resource: 'schema',
        operation: 'list',
        search: query,
        allowedIds: hasScope(user.scopes, 'logs:schemas:view')
          ? undefined
          : getResourceScopedIds(user.scopes, 'logs:schemas:view'),
      })
    );
  }
  if (typeWanted('status_page_service') && hasScope(user.scopes, 'status-page:view')) {
    searchTasks.push(() =>
      collect('status_page_service', 'manage_status_page', { resource: 'services', operation: 'list' })
    );
  }
  if (typeWanted('status_page_incident') && hasScope(user.scopes, 'status-page:view')) {
    searchTasks.push(() =>
      collect('status_page_incident', 'manage_status_page', {
        resource: 'incidents',
        operation: 'list',
        page: 1,
        limit,
      })
    );
  }
  if (typeWanted('notification_rule') && hasScope(user.scopes, 'notifications:alerts:view')) {
    searchTasks.push(() => collect('notification_rule', 'list_alert_rules', {}));
  }
  if (typeWanted('notification_webhook') && hasScope(user.scopes, 'notifications:webhooks:view')) {
    searchTasks.push(() => collect('notification_webhook', 'list_webhooks', {}));
  }

  const dockerTypes = ['docker_container', 'docker_deployment', 'docker_image', 'docker_volume', 'docker_network'];
  if (dockerTypes.some((type) => typeWanted(type))) {
    searchTasks.push(async () => {
      const snapshots = deps.dockerSnapshotService;
      if (!snapshots) {
        return {
          results: [],
          errors: [{ type: 'docker', error: 'Docker snapshot service is unavailable' }],
        };
      }
      const dockerNodes = await findDockerSearchNodes(
        deps.nodesService,
        user,
        typeof args.nodeId === 'string' ? args.nodeId : undefined
      );
      const dockerTasks: Array<() => Promise<ResourceSearchBatch>> = [];
      const collectSnapshot = async (
        type: string,
        nodeId: string,
        nodeSlug: string,
        kind: DockerSnapshotKind,
        prepare: (items: Record<string, any>[]) => Record<string, any>[] | Promise<Record<string, any>[]>,
        identify: (item: Record<string, any>) => { id?: unknown; name?: unknown } = (item) => ({
          id: item.id ?? item.name,
          name: item.name,
        })
      ): Promise<ResourceSearchBatch> => {
        const batch: ResourceSearchBatch = { results: [], errors: [] };
        try {
          const snapshot = await snapshots.getList<Record<string, any>[]>(nodeId, kind);
          for (const item of await prepare(itemsOf(snapshot.data))) {
            const identity = identify(item);
            add(batch.results, type, item, {
              id: identity.id,
              name: identity.name,
              nodeId,
              nodeSlug,
              skipMatch: true,
            });
            if (batch.results.length >= limit) break;
          }
        } catch (err) {
          batch.errors.push({ type, error: err instanceof Error ? err.message : 'snapshot search failed' });
        }
        return batch;
      };
      for (const node of dockerNodes) {
        const nodeId = node.id;
        if (typeWanted('docker_container') && hasScopeBase(user.scopes, 'docker:containers:view')) {
          dockerTasks.push(() =>
            collectSnapshot(
              'docker_container',
              nodeId,
              node.slug,
              'containers',
              async (snapshotContainers) => {
                const containers = itemsOf(
                  await deps.dockerService.decoratePublicContainerSnapshot(nodeId, snapshotContainers)
                );
                const canViewNode = hasDockerResourceScope(user.scopes, 'docker:containers:view', nodeId, '');
                return containers
                  .filter(
                    (container) =>
                      canViewNode ||
                      (!!container.scopeResourceId &&
                        hasDockerResourceScope(
                          user.scopes,
                          'docker:containers:view',
                          nodeId,
                          container.scopeResourceId
                        ))
                  )
                  .filter((container) => dockerContainerMatchesSearch(container, query))
                  .map((container) => compactDockerContainerForAgent(container));
              },
              (container) => ({ id: container.name, name: container.name })
            )
          );
        }
        if (typeWanted('docker_deployment') && hasScopeBase(user.scopes, 'docker:containers:view')) {
          dockerTasks.push(() =>
            collect('docker_deployment', 'list_docker_deployments', { nodeId, search: query }, (deployment) => ({
              id: deployment.id,
              name: deployment.name,
              nodeId,
              nodeSlug: node.slug,
            }))
          );
        }
        // Folder and per-resource grants reach single images, volumes and networks on a node: filter each item like
        // list_docker_images/volumes/networks instead of requiring the whole node.
        if (typeWanted('docker_image') && hasDockerViewOnNode(user.scopes, 'docker:images:view', nodeId)) {
          const canViewNode = hasDockerResourceScope(user.scopes, 'docker:images:view', nodeId, '');
          dockerTasks.push(() =>
            collectSnapshot(
              'docker_image',
              nodeId,
              node.slug,
              'images',
              async (snapshotImages) =>
                (canViewNode
                  ? snapshotImages
                  : itemsOf(await deps.dockerService.decoratePublicImageSnapshot(nodeId, snapshotImages)).filter(
                      (image) =>
                        hasDockerResourceScope(
                          user.scopes,
                          'docker:images:view',
                          nodeId,
                          String(image.scopeResourceId ?? image.id ?? image.Id ?? '')
                        )
                    )
                )
                  .filter((image) => dockerImageMatchesSearch(image, query))
                  .map((image) => compactDockerImageForAgent(image)),
              (image) => ({
                id: image.id,
                name: Array.isArray(image.repoTags) ? image.repoTags[0] : image.id,
              })
            )
          );
        }
        if (typeWanted('docker_volume') && hasDockerViewOnNode(user.scopes, 'docker:volumes:view', nodeId)) {
          dockerTasks.push(() =>
            collectSnapshot('docker_volume', nodeId, node.slug, 'volumes', (volumes) =>
              volumes
                .filter((volume) =>
                  hasDockerResourceScope(
                    user.scopes,
                    'docker:volumes:view',
                    nodeId,
                    String(volume.name ?? volume.Name ?? '')
                  )
                )
                .filter((volume) => dockerVolumeMatchesSearch(volume, query))
                .map((volume) => compactDockerVolumeForAgent(volume))
            )
          );
        }
        if (typeWanted('docker_network') && hasDockerViewOnNode(user.scopes, 'docker:networks:view', nodeId)) {
          const canViewNode = hasDockerResourceScope(user.scopes, 'docker:networks:view', nodeId, '');
          dockerTasks.push(() =>
            collectSnapshot('docker_network', nodeId, node.slug, 'networks', async (snapshotNetworks) =>
              (canViewNode
                ? snapshotNetworks
                : itemsOf(await deps.dockerService.decoratePublicNetworkSnapshot(nodeId, snapshotNetworks)).filter(
                    (network) =>
                      !!network.scopeResourceId &&
                      hasDockerResourceScope(
                        user.scopes,
                        'docker:networks:view',
                        nodeId,
                        String(network.scopeResourceId)
                      )
                  )
              )
                .filter((network) => dockerNetworkMatchesSearch(network, query))
                .map((network) => compactDockerNetworkForAgent(network))
            )
          );
        }
      }
      const dockerBatches = await runWithConcurrency(dockerTasks, RESOURCE_SEARCH_CONCURRENCY);
      return dockerBatches.reduce<ResourceSearchBatch>(
        (combined, batch) => {
          combined.results.push(...batch.results);
          combined.errors.push(...batch.errors);
          return combined;
        },
        { results: [], errors: [] }
      );
    });
  }
  if (typeWanted('docker_registry') && hasScopeBase(user.scopes, 'docker:registries:view')) {
    searchTasks.push(() => collect('docker_registry', 'manage_docker_registry', { operation: 'list' }));
  }

  const results: ResourceSearchItem[] = [];
  const errors: ResourceSearchError[] = [];
  for (const batch of await runWithConcurrency(searchTasks, RESOURCE_SEARCH_CONCURRENCY)) {
    errors.push(...batch.errors);
    if (results.length < limit) results.push(...batch.results.slice(0, limit - results.length));
  }

  await annotateAppMembers(results);

  return {
    query,
    results,
    total: results.length,
    truncated: results.length >= limit,
    errors: errors.length > 0 ? errors : undefined,
  };
}

const SEARCH_MEMBER_TYPES: Readonly<Record<string, AppMemberType>> = {
  proxy_host: 'route',
  database: 'database',
  storage: 'storage',
  page_project: 'pages',
  docker_compose_project: 'compose',
  docker_deployment: 'deployment',
  docker_container: 'container',
};

/** Results of member types carry `app` (null outside apps), so search can say "in <app> · <env>". */
async function annotateAppMembers(results: ResourceSearchItem[]): Promise<void> {
  if (!container.isRegistered(AppMembershipService)) return;
  const members = results.flatMap((result) => {
    const type = SEARCH_MEMBER_TYPES[String(result.type)];
    return type ? [{ type, id: String(result.id), nodeId: (result.nodeId as string | undefined) ?? null }] : [];
  });
  if (members.length === 0) return;
  try {
    const refs = await container.resolve(AppMembershipService).refsForMembers(members);
    for (const result of results) {
      const type = SEARCH_MEMBER_TYPES[String(result.type)];
      if (!type) continue;
      result.app =
        refs.get(memberKey({ type, id: String(result.id), nodeId: (result.nodeId as string | undefined) ?? null })) ??
        null;
    }
  } catch {
    // The label is a convenience; search results stay usable without it.
  }
}

/** The node, or any resource on it, is granted for this Docker view scope (directly or by an implying scope). */
function hasDockerViewOnNode(scopes: string[], baseScope: string, nodeId: string): boolean {
  return (
    hasScopeForResource(scopes, baseScope, nodeId) ||
    scopes.some((scope) => {
      const base = extractBaseScope(scope);
      return (
        scope.startsWith(`${base}:${nodeId}/`) && hasScope([scope], `${baseScope}:${scope.slice(base.length + 1)}`)
      );
    })
  );
}

async function findDockerSearchNodes(nodesService: NodesService, user: User, nodeId?: string) {
  const dockerViewScopes = [
    'docker:containers:view',
    'docker:images:view',
    'docker:volumes:view',
    'docker:networks:view',
  ];
  if (nodeId) {
    if (
      !dockerViewScopes.some(
        (scope) =>
          hasScopeForResource(user.scopes, scope, nodeId) || dockerScopedNodeIds(user.scopes, [scope]).includes(nodeId)
      )
    ) {
      return [];
    }
    const node = await nodesService.get(nodeId);
    return node.type === 'docker' ? [{ id: node.id, slug: node.slug }] : [];
  }
  const broadAccess = dockerViewScopes.some((scope) => hasScope(user.scopes, scope));
  const scopedIds = broadAccess ? undefined : dockerScopedNodeIds(user.scopes, dockerViewScopes);
  if (scopedIds?.length === 0) return [];
  const dockerNodes: Array<{ id: string; slug: string }> = [];
  let page = 1;
  let totalPages = 1;
  do {
    const nodes = await nodesService.list(
      { type: 'docker', page, limit: 100 },
      scopedIds ? { allowedIds: scopedIds } : undefined
    );
    dockerNodes.push(...nodes.data.map((node) => ({ id: node.id, slug: node.slug })));
    totalPages = nodes.totalPages;
    page += 1;
  } while (page <= totalPages);
  return dockerNodes;
}
