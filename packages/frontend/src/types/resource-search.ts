import type { AppMembershipRef } from "./apps";

export type ResourceSearchType =
  | "node"
  | "proxy_host"
  | "proxy_template"
  | "ssl_certificate"
  | "domain"
  | "access_list"
  | "ca"
  | "pki_certificate"
  | "pki_template"
  | "docker_container"
  | "docker_deployment"
  | "docker_compose_project"
  | "docker_build"
  | "docker_image"
  | "docker_volume"
  | "docker_network"
  | "docker_registry"
  | "database"
  | "page_project"
  | "logging_environment"
  | "logging_schema"
  | "status_page_service"
  | "status_page_incident"
  | "notification_rule"
  | "notification_webhook";

export interface ResourceSearchResult {
  type: ResourceSearchType;
  id: string;
  name: string;
  nodeId?: string;
  nodeSlug?: string;
  /** Set when the result is a member of an app environment ("in <app> · <env>"). */
  app?: AppMembershipRef | null;
  summary: Record<string, unknown>;
}

export interface ResourceSearchResponse {
  query: string;
  results: ResourceSearchResult[];
  total: number;
  truncated: boolean;
  errors?: Array<{ type: string; error: string }>;
}
