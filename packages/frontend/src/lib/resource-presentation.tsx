import {
  Activity,
  Award,
  Bell,
  Box,
  Boxes,
  Database,
  FileText,
  Globe,
  Globe2,
  Hammer,
  HardDrive,
  Image,
  KeyRound,
  Layers,
  Lock,
  Network,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import type { ElementType } from "react";
import { appMembershipLabel } from "@/lib/app-members";
import type { AIResourceReference, AIResourceReferenceType } from "@/types/ai";
import type { ResourceSearchResult, ResourceSearchType } from "@/types/resource-search";
import {
  databaseRoute,
  dockerComposeProjectRoute,
  dockerContainerRoute,
  dockerDeploymentRoute,
  dockerVolumeRoute,
  loggingEnvironmentRoute,
  loggingSchemaRoute,
  nodeRoute,
  proxyHostRoute,
} from "./resource-routes";

export const RESOURCE_LABELS: Record<ResourceSearchType, string> = {
  node: "Node",
  proxy_host: "Proxy host",
  proxy_template: "Nginx template",
  ssl_certificate: "SSL certificate",
  domain: "Domain",
  access_list: "Access list",
  ca: "Certificate authority",
  pki_certificate: "Certificate",
  pki_template: "Certificate template",
  docker_container: "Container",
  docker_deployment: "Deployment",
  docker_compose_project: "Compose project",
  docker_build: "Docker build",
  docker_image: "Docker image",
  docker_volume: "Docker volume",
  docker_network: "Docker network",
  docker_registry: "Docker registry",
  database: "Database",
  page_project: "Page Project",
  logging_environment: "Logging environment",
  logging_schema: "Logging schema",
  status_page_service: "Status page service",
  status_page_incident: "Status page incident",
  notification_rule: "Alert rule",
  notification_webhook: "Notification webhook",
};

export const RESOURCE_ICONS: Record<ResourceSearchType, ElementType> = {
  node: Server,
  proxy_host: Globe,
  proxy_template: Award,
  ssl_certificate: Lock,
  domain: Globe2,
  access_list: ShieldAlert,
  ca: ShieldCheck,
  pki_certificate: FileText,
  pki_template: Award,
  docker_container: Box,
  docker_deployment: Layers,
  docker_compose_project: Boxes,
  docker_build: Hammer,
  docker_image: Image,
  docker_volume: HardDrive,
  docker_network: Network,
  docker_registry: KeyRound,
  database: Database,
  page_project: Globe,
  logging_environment: ScrollText,
  logging_schema: FileText,
  status_page_service: Activity,
  status_page_incident: Activity,
  notification_rule: Bell,
  notification_webhook: Webhook,
};

export function resourceTypeIcon(type: string): ElementType {
  return RESOURCE_ICONS[type as ResourceSearchType] ?? Box;
}

export function resourceTypeLabel(type: string): string {
  const fallback = type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return RESOURCE_LABELS[type as ResourceSearchType] ?? (fallback || "Resource");
}

function summaryString(result: ResourceSearchResult, key: string): string | undefined {
  const value = result.summary[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The muted text after a search result: its type, and for an app member "in <app> · <env>". */
export function resourceSearchSecondaryText(result: ResourceSearchResult): string {
  const type = resourceTypeLabel(result.type);
  return result.app ? `${type} in ${appMembershipLabel(result.app)}` : type;
}

export function resourceSearchHref(result: ResourceSearchResult): string {
  return resourceHref({
    type: result.type,
    resourceId: result.id,
    label: result.name,
    nodeId: result.nodeId,
    nodeSlug: result.nodeSlug,
    slug: summaryString(result, "slug"),
  });
}

export function aiResourceHref(reference: AIResourceReference): string {
  if (reference.relation === "deleted") return resourceParentHref(reference.type);
  return resourceHref({
    type: reference.type,
    resourceId: reference.resourceId,
    label: reference.label,
    nodeId: reference.nodeId,
    nodeSlug: reference.nodeSlug,
    slug: reference.slug,
  });
}

function resourceHref(resource: {
  type: ResourceSearchType;
  resourceId: string;
  label: string;
  nodeId?: string;
  nodeSlug?: string;
  slug?: string;
}): string {
  switch (resource.type) {
    case "node":
      return nodeRoute(resource.slug ?? resource.resourceId);
    case "proxy_host":
      return proxyHostRoute(resource.slug || resource.resourceId);
    case "proxy_template":
      return `/nginx-templates/${encodeURIComponent(resource.resourceId)}`;
    case "ssl_certificate":
      return "/ssl-certificates";
    case "domain":
      return "/domains";
    case "access_list":
      return "/access-lists";
    case "ca":
      return `/cas/${encodeURIComponent(resource.resourceId)}`;
    case "pki_certificate":
      return `/certificates/${encodeURIComponent(resource.resourceId)}`;
    case "pki_template":
      return "/templates/pki";
    case "docker_container":
      return resource.nodeSlug
        ? dockerContainerRoute(resource.nodeSlug, resource.label)
        : "/docker/containers";
    case "docker_deployment":
      return resource.nodeSlug
        ? dockerDeploymentRoute(resource.nodeSlug, resource.label)
        : "/docker/deployments";
    case "docker_compose_project":
      return dockerComposeProjectRoute(resource.resourceId);
    case "docker_build":
      return `/docker/builds?build=${encodeURIComponent(resource.resourceId)}`;
    case "docker_image":
      return "/docker/images";
    case "docker_volume":
      return resource.nodeSlug
        ? dockerVolumeRoute(resource.nodeSlug, resource.label)
        : "/docker/volumes";
    case "docker_network":
      return "/docker/networks";
    case "docker_registry":
      return "/settings/advanced";
    case "database":
      return databaseRoute(resource.slug ?? resource.resourceId);
    case "page_project":
      return `/pages/${encodeURIComponent(resource.slug ?? resource.resourceId)}`;
    case "logging_environment":
      return loggingEnvironmentRoute(resource.slug ?? resource.resourceId);
    case "logging_schema":
      return loggingSchemaRoute(resource.slug ?? resource.resourceId);
    case "status_page_service":
      return "/status-page/services";
    case "status_page_incident":
      return "/status-page/incidents";
    case "notification_rule":
      return "/notifications/alerts";
    case "notification_webhook":
      return "/notifications/webhooks";
    default:
      return "/";
  }
}

function resourceParentHref(type: AIResourceReferenceType): string {
  switch (type) {
    case "node":
      return "/nodes";
    case "proxy_host":
      return "/proxy-hosts";
    case "proxy_template":
      return "/templates/nginx";
    case "ssl_certificate":
      return "/ssl-certificates";
    case "domain":
      return "/domains";
    case "access_list":
      return "/access-lists";
    case "ca":
      return "/cas";
    case "pki_certificate":
      return "/certificates";
    case "pki_template":
      return "/templates/pki";
    case "docker_container":
      return "/docker/containers";
    case "docker_deployment":
      return "/docker/deployments";
    case "docker_compose_project":
      return "/docker/compose";
    case "docker_build":
      return "/docker/builds";
    case "docker_image":
      return "/docker/images";
    case "docker_volume":
      return "/docker/volumes";
    case "docker_network":
      return "/docker/networks";
    case "docker_registry":
      return "/settings/advanced";
    case "database":
      return "/databases";
    case "page_project":
      return "/pages";
    case "logging_environment":
      return "/logging/environments";
    case "logging_schema":
      return "/logging/schemas";
    case "status_page_service":
      return "/status-page/services";
    case "status_page_incident":
      return "/status-page/incidents";
    case "notification_rule":
      return "/notifications/alerts";
    case "notification_webhook":
      return "/notifications/webhooks";
    default:
      return "/";
  }
}
