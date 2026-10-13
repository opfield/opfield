import { createHash } from 'node:crypto';
import type {
  AIResourceAppearanceColor,
  AIResourceReference,
  AIResourceReferenceRelation,
  AIResourceReferenceType,
} from './ai.types.js';

const MAX_REFERENCES_PER_RESULT = 64;
/** Prefix of reference ids; no token prefix, so secret masking leaves the markers alone. */
const REFERENCE_ID_PREFIX = 'res_';
// legacy-name: gwr_ reference ids in conversations stored before 2.12.1 — remove once those conversations aged out
const RESOURCE_MARKER_RE = /\[\[resource:((?:res|gwr)_[a-f0-9]{24})\|((?:[^[\]\r\n]|\[[^[\]\r\n]*\]){1,240})\]\]/g;

type RecordValue = Record<string, unknown>;

export interface AIResourceReferenceExtractionOptions {
  nodeSlug?: string;
  nodeLabel?: string;
  nodeAppearanceColor?: AIResourceAppearanceColor;
  relation?: AIResourceReferenceRelation;
}

export function mergeAIResourceReference(
  previous: AIResourceReference | undefined,
  incoming: AIResourceReference
): AIResourceReference {
  if (!previous) return incoming;
  const label = isFallbackResourceLabel(incoming) ? previous.label : incoming.label;
  const merged = {
    ...previous,
    ...incoming,
    label,
    nodeId: incoming.nodeId || previous.nodeId,
    nodeSlug: incoming.nodeSlug || previous.nodeSlug,
    slug: incoming.slug || previous.slug,
    appearanceColor: incoming.appearanceColor ?? previous.appearanceColor,
  };
  return {
    ...merged,
    // A later, less detailed tool result may know the resource id but not its
    // slug. Recompute the route after merging so a previously resolved detail
    // route never degrades back to the collection page.
    uiHref: resourceUiHref(merged),
  };
}

export function extractAIResourceReferences(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  options: AIResourceReferenceExtractionOptions = {}
): AIResourceReference[] {
  if (toolName === 'find_resource') return extractFindResourceReferences(result);
  if (isBroadListTool(toolName, args)) return [];

  const type = inferAIToolResourceType(toolName, args);
  if (!type) return nodeReferenceFromArgs(args, options);

  const relation = options.relation ?? inferRelation(toolName, args);
  const value = primaryResultRecord(result);
  const reference = buildReference(type, args, value, relation, options);
  const references = reference ? [reference] : [];

  if (type.startsWith('docker_')) {
    references.push(...nodeReferenceFromArgs(args, options));
  }
  return dedupeReferences(references).slice(0, MAX_REFERENCES_PER_RESULT);
}

export function appendAIResourceReferencesToModelResult(result: unknown, references: AIResourceReference[]): unknown {
  if (references.length === 0) return result;
  const modelReferences = references.map((reference) => ({
    marker: formatAIResourceMarker(reference),
    type: reference.type,
    label: sanitizeMarkerLabel(reference.label),
    relation: reference.relation,
  }));
  const instruction =
    'When mentioning one of these Opfield resources in a progress comment or final answer, copy its marker exactly. Do not write or guess an href.';

  if (isRecord(result)) {
    return { ...result, opfieldResourceReferences: modelReferences, opfieldResourceReferenceInstruction: instruction };
  }
  return { data: result, opfieldResourceReferences: modelReferences, opfieldResourceReferenceInstruction: instruction };
}

export function formatAIResourceMarker(reference: Pick<AIResourceReference, 'refId' | 'label'>): string {
  return `[[resource:${reference.refId}|${sanitizeMarkerLabel(reference.label)}]]`;
}

export function referencedAIResourceIds(content: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(RESOURCE_MARKER_RE)) {
    const refId = match[1];
    if (seen.has(refId)) continue;
    seen.add(refId);
    ids.push(refId);
  }
  return ids;
}

export function stripAIResourceMarkers(content: string): string {
  return content.replace(RESOURCE_MARKER_RE, (_marker, _refId: string, label: string) => label.trim());
}

function extractFindResourceReferences(result: unknown): AIResourceReference[] {
  const record = isRecord(result) ? result : {};
  const items = Array.isArray(record.results) ? record.results : [];
  const references: AIResourceReference[] = [];
  for (const item of items) {
    if (!isRecord(item) || !isResourceType(item.type)) continue;
    const summary = isRecord(item.summary) ? item.summary : {};
    const resourceId =
      item.type === 'docker_container'
        ? firstString(item.name, summary.name, item.id, summary.id)
        : firstString(item.id, summary.id, item.name);
    const label =
      item.type === 'proxy_host'
        ? firstString(firstArrayString(summary.domainNames), firstCommaSeparatedValue(item.name), resourceId)
        : firstString(item.name, summary.name, summary.title, summary.hostname, resourceId);
    if (!resourceId || !label) continue;
    references.push(
      createReference({
        type: item.type,
        resourceId,
        label,
        relation: 'read',
        nodeId: firstString(item.nodeId, summary.nodeId),
        nodeSlug: firstString(item.nodeSlug, summary.nodeSlug),
        slug: firstString(summary.slug, item.slug),
        appearanceColor: resourceAppearanceColor(item.appearanceColor, summary.appearanceColor),
      })
    );
    const nodeId = firstString(item.nodeId, summary.nodeId);
    const nodeSlug = firstString(item.nodeSlug, summary.nodeSlug);
    if (item.type.startsWith('docker_') && nodeId && nodeSlug) {
      references.push(
        createReference({
          type: 'node',
          resourceId: nodeId,
          label: nodeSlug,
          relation: 'read',
          slug: nodeSlug,
        })
      );
    }
    if (references.length >= MAX_REFERENCES_PER_RESULT) break;
  }
  return dedupeReferences(references).slice(0, MAX_REFERENCES_PER_RESULT);
}

function buildReference(
  type: AIResourceReferenceType,
  args: Record<string, unknown>,
  value: RecordValue,
  relation: AIResourceReferenceRelation,
  options: AIResourceReferenceExtractionOptions
): AIResourceReference | null {
  const data = isRecord(value.data) ? value.data : value;
  const nodeId = firstString(data.nodeId, value.nodeId, args.nodeId);
  const nodeSlug = firstString(data.nodeSlug, value.nodeSlug, options.nodeSlug);
  const slug =
    firstString(data.slug, value.slug, args.slug, type === 'node' ? options.nodeSlug : undefined) || undefined;
  const resourceId = resourceIdForType(type, args, data, value);
  const label = labelForType(type, args, data, value, resourceId, options);
  if (!resourceId || !label) return null;
  return createReference({
    type,
    resourceId,
    label,
    relation,
    nodeId,
    nodeSlug,
    slug,
    appearanceColor:
      resourceAppearanceColor(data.appearanceColor, value.appearanceColor) ??
      (type === 'node' ? options.nodeAppearanceColor : undefined),
  });
}

function nodeReferenceFromArgs(
  args: Record<string, unknown>,
  options: AIResourceReferenceExtractionOptions
): AIResourceReference[] {
  const nodeId = firstString(args.nodeId);
  const nodeSlug = firstString(options.nodeSlug);
  const label = firstString(options.nodeLabel, nodeSlug);
  if (!nodeId || !label) return [];
  return [
    createReference({
      type: 'node',
      resourceId: nodeId,
      label,
      relation: 'read',
      slug: nodeSlug,
      appearanceColor: options.nodeAppearanceColor,
    }),
  ];
}

function createReference(
  input: Omit<AIResourceReference, 'refId' | 'uiHref' | 'workspaceEmbeddable'>
): AIResourceReference {
  const identity = [input.type, input.nodeId ?? '', input.resourceId].join('\u0000');
  const refId = `${REFERENCE_ID_PREFIX}${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
  return {
    refId,
    ...input,
    uiHref: resourceUiHref(input),
    workspaceEmbeddable: true,
  };
}

function resourceUiHref(resource: Omit<AIResourceReference, 'refId' | 'uiHref' | 'workspaceEmbeddable'>): string {
  const segment = (value: string) => encodeURIComponent(value);
  if (resource.relation === 'deleted') {
    const parents: Record<AIResourceReferenceType, string> = {
      node: '/nodes',
      proxy_host: '/routes',
      proxy_template: '/routes/templates',
      ssl_certificate: '/certificates',
      domain: '/routes/domains',
      access_list: '/routes/access-lists',
      ca: '/certificates/authorities',
      pki_certificate: '/certificates/pki',
      pki_template: '/certificates/templates',
      docker_container: '/docker/containers',
      docker_deployment: '/docker/deployments',
      docker_image: '/docker/images',
      docker_volume: '/docker/volumes',
      docker_network: '/docker/networks',
      docker_registry: '/settings/advanced',
      database: '/databases',
      page_project: '/pages',
      logging_environment: '/logging/environments',
      logging_schema: '/logging/schemas',
      status_page_service: '/status-page/services',
      status_page_incident: '/status-page/incidents',
      notification_rule: '/notifications/alerts',
      notification_webhook: '/notifications/webhooks',
    };
    return parents[resource.type];
  }
  switch (resource.type) {
    case 'node':
      return `/nodes/${segment(resource.slug ?? resource.resourceId)}`;
    case 'proxy_host':
      return `/proxy-hosts/${segment(resource.slug || resource.resourceId)}`;
    case 'proxy_template':
      return `/nginx-templates/${segment(resource.resourceId)}`;
    case 'ca':
      return `/cas/${segment(resource.resourceId)}`;
    case 'pki_certificate':
      return `/certificates/${segment(resource.resourceId)}`;
    case 'docker_container':
      return resource.nodeSlug
        ? `/docker/containers/${segment(resource.nodeSlug)}/${segment(resource.label)}`
        : '/docker/containers';
    case 'docker_deployment':
      return resource.nodeSlug
        ? `/docker/deployments/${segment(resource.nodeSlug)}/${segment(resource.label)}`
        : '/docker/deployments';
    case 'docker_volume':
      return resource.nodeSlug
        ? `/docker/volumes/${segment(resource.nodeSlug)}/${segment(resource.label)}`
        : '/docker/volumes';
    case 'database':
      return `/databases/${segment(resource.slug ?? resource.resourceId)}`;
    case 'page_project':
      return `/pages/${segment(resource.slug ?? resource.resourceId)}`;
    case 'logging_environment':
      return `/logging/environments/${segment(resource.slug ?? resource.resourceId)}`;
    case 'logging_schema':
      return `/logging/schemas/${segment(resource.slug ?? resource.resourceId)}`;
    default:
      return resourceUiHref({ ...resource, relation: 'deleted' });
  }
}

/** The kind of Opfield resource an AI or MCP tool call works on; null for tools outside Opfield navigation. */
export function inferAIToolResourceType(
  toolName: string,
  args: Record<string, unknown>
): AIResourceReferenceType | null {
  // GitLab resources are external to Opfield navigation. In particular, project
  // webhooks must never be presented as Opfield notification webhooks.
  if (toolName.startsWith('gitlab_')) return null;
  if (toolName.includes('docker_container') || toolName === 'execute_docker_container_console_command') {
    return 'docker_container';
  }
  if (toolName.includes('docker_deployment')) return 'docker_deployment';
  if (toolName.includes('docker_image')) return 'docker_image';
  if (toolName.includes('docker_volume')) return 'docker_volume';
  if (toolName.includes('docker_network')) return 'docker_network';
  if (toolName.includes('docker_registry')) return 'docker_registry';
  if (['list_routes', 'get_route', 'create_route', 'update_route', 'delete_route'].includes(toolName)) {
    return 'proxy_host';
  }
  if (toolName.includes('proxy_template')) return 'proxy_template';
  if (toolName.includes('ssl_certificate') || toolName === 'request_acme_cert') return 'ssl_certificate';
  if (toolName.includes('access_list')) return 'access_list';
  if (toolName.includes('domain')) return 'domain';
  if (toolName === 'manage_ca' || toolName.includes('_ca')) return 'ca';
  if (
    toolName.includes('pki_template') ||
    toolName === 'manage_template' ||
    toolName === 'create_template' ||
    toolName === 'delete_template'
  ) {
    return 'pki_template';
  }
  if (toolName.includes('certificate')) return 'pki_certificate';
  if (toolName.includes('database')) return 'database';
  if (toolName === 'manage_pages' && String(args.operation ?? '').startsWith('project_')) return 'page_project';
  if (toolName === 'manage_logging') {
    return String(args.resource ?? '').startsWith('schema') ? 'logging_schema' : 'logging_environment';
  }
  if (toolName === 'manage_status_page') {
    return String(args.resource ?? '').startsWith('incident') ? 'status_page_incident' : 'status_page_service';
  }
  if (toolName.includes('alert_rule')) return 'notification_rule';
  if (toolName.includes('webhook')) return 'notification_webhook';
  if (toolName.includes('node')) return 'node';
  return null;
}

function inferRelation(toolName: string, args: Record<string, unknown>): AIResourceReferenceRelation {
  const operation = String(args.operation ?? '').toLowerCase();
  if (/delete|remove|revoke|disconnect|clear/.test(`${toolName} ${operation}`)) return 'deleted';
  if (/create|issue|upload|clone|add/.test(`${toolName} ${operation}`)) return 'created';
  if (/test|verify|check|renew|pull|start|stop|restart|execute|run/.test(`${toolName} ${operation}`)) {
    return 'verified';
  }
  if (/update|set|move|reorder|regenerate|write|connect/.test(`${toolName} ${operation}`)) return 'updated';
  return 'read';
}

function isBroadListTool(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'find_resource') return false;
  if (toolName.startsWith('list_')) return true;
  return String(args.operation ?? '').toLowerCase() === 'list';
}

function resourceIdForType(
  type: AIResourceReferenceType,
  args: Record<string, unknown>,
  data: RecordValue,
  value: RecordValue
): string {
  const candidatesByType: Partial<Record<AIResourceReferenceType, unknown[]>> = {
    node: [data.id, value.id, args.nodeId, args.id],
    proxy_host: [data.id, value.id, args.routeId, args.proxyHostId, args.id],
    proxy_template: [data.id, value.id, args.templateId, args.id],
    ssl_certificate: [data.id, value.id, args.certificateId, args.id],
    domain: [data.id, value.id, args.domainId, args.id, args.domain],
    access_list: [data.id, value.id, args.accessListId, args.id],
    ca: [data.id, value.id, args.caId, args.parentCaId, args.id],
    pki_certificate: [data.id, value.id, args.certificateId, args.id],
    pki_template: [data.id, value.id, args.templateId, args.id],
    docker_container: [
      dockerContainerName(data.Name),
      data.name,
      dockerContainerName(value.Name),
      value.name,
      args.name,
      args.containerName,
      args.containerId,
      data.id,
      data.Id,
      value.id,
    ],
    docker_deployment: [data.id, value.id, args.deploymentId, args.name, args.deploymentName],
    docker_image: [data.id, value.id, args.imageId, args.imageRef, args.name],
    docker_volume: [data.name, value.name, args.volumeName, args.name],
    docker_network: [data.id, value.id, args.networkId, args.name],
    docker_registry: [data.id, value.id, args.registryId, args.name],
    database: [args.databaseId, data.id, value.id, args.id],
    page_project: [data.id, value.id, args.projectId, args.id],
    logging_environment: [data.id, value.id, args.environmentId, args.id, args.name],
    logging_schema: [data.id, value.id, args.schemaId, args.id, args.name],
    status_page_service: [data.id, value.id, args.serviceId, args.id, args.name],
    status_page_incident: [data.id, value.id, args.incidentId, args.id, args.title],
    notification_rule: [data.id, value.id, args.ruleId, args.id, args.name],
    notification_webhook: [data.id, value.id, args.webhookId, args.id, args.name],
  };
  return firstString(...(candidatesByType[type] ?? [data.id, value.id, args.id]));
}

function labelForType(
  type: AIResourceReferenceType,
  args: Record<string, unknown>,
  data: RecordValue,
  value: RecordValue,
  resourceId: string,
  options: AIResourceReferenceExtractionOptions
): string {
  if (type === 'node') {
    return firstString(
      data.displayName,
      data.hostname,
      data.slug,
      value.displayName,
      value.hostname,
      args.name,
      options.nodeLabel,
      options.nodeSlug,
      resourceId
    );
  }
  if (type === 'proxy_host') {
    const domains = Array.isArray(data.domainNames) ? data.domainNames.filter((item) => typeof item === 'string') : [];
    return firstString(domains[0], data.name, data.slug, args.domain, resourceId);
  }
  if (type === 'domain') return firstString(data.domain, value.domain, args.domain, data.name, resourceId);
  if (type === 'pki_certificate' || type === 'ssl_certificate' || type === 'ca') {
    return firstString(
      data.commonName,
      data.name,
      value.commonName,
      value.name,
      args.commonName,
      args.name,
      resourceId
    );
  }
  if (type === 'docker_image') {
    const repoTags = Array.isArray(data.repoTags) ? data.repoTags : [];
    return firstString(repoTags[0], data.name, args.imageRef, args.name, resourceId);
  }
  if (type === 'docker_container') {
    return firstString(
      dockerContainerName(data.Name),
      data.name,
      dockerContainerName(value.Name),
      value.name,
      args.name,
      args.containerName,
      resourceId
    );
  }
  return firstString(
    data.name,
    data.title,
    data.slug,
    value.name,
    value.title,
    args.name,
    args.containerName,
    args.deploymentName,
    args.volumeName,
    resourceId
  );
}

function primaryResultRecord(result: unknown): RecordValue {
  if (!isRecord(result)) return {};
  return result;
}

function dedupeReferences(references: AIResourceReference[]): AIResourceReference[] {
  const result: AIResourceReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.refId)) continue;
    seen.add(reference.refId);
    result.push(reference);
  }
  return result;
}

function isResourceType(value: unknown): value is AIResourceReferenceType {
  return typeof value === 'string' && RESOURCE_TYPES.has(value as AIResourceReferenceType);
}

const RESOURCE_TYPES = new Set<AIResourceReferenceType>([
  'node',
  'proxy_host',
  'proxy_template',
  'ssl_certificate',
  'domain',
  'access_list',
  'ca',
  'pki_certificate',
  'pki_template',
  'docker_container',
  'docker_deployment',
  'docker_image',
  'docker_volume',
  'docker_network',
  'docker_registry',
  'database',
  'page_project',
  'logging_environment',
  'logging_schema',
  'status_page_service',
  'status_page_incident',
  'notification_rule',
  'notification_webhook',
]);

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function firstArrayString(value: unknown): string {
  return Array.isArray(value) ? firstString(...value) : '';
}

function firstCommaSeparatedValue(value: unknown): string {
  return typeof value === 'string' ? firstString(value.split(',')[0]) : '';
}

function sanitizeMarkerLabel(value: string): string {
  return (
    value
      .replace(/[[\]|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240) || 'Resource'
  );
}

function dockerContainerName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^\/+/, '') : '';
}

function isFallbackResourceLabel(reference: AIResourceReference): boolean {
  const label = reference.label.trim();
  if (!label || label === reference.resourceId) return true;
  return reference.type === 'docker_container' && /^[a-f0-9]{12,64}$/i.test(label);
}

const RESOURCE_APPEARANCE_COLORS = new Set<AIResourceAppearanceColor>([
  'blue',
  'red',
  'green',
  'yellow',
  'purple',
  'pink',
  'orange',
]);

function resourceAppearanceColor(...values: unknown[]): AIResourceAppearanceColor | undefined {
  for (const value of values) {
    if (typeof value === 'string' && RESOURCE_APPEARANCE_COLORS.has(value as AIResourceAppearanceColor)) {
      return value as AIResourceAppearanceColor;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
