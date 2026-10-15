const segment = (value: string) => encodeURIComponent(value);
const withTab = (path: string, tab?: string) => (tab ? `${path}/${segment(tab)}` : path);

export const nodeRoute = (slug: string, tab?: string) => withTab(`/nodes/${segment(slug)}`, tab);
export const dockerNodeListRoute = (nodeId: string, tab: string) =>
  `/docker/${segment(tab)}?${new URLSearchParams({ nodeId, filters: "1" })}`;
export const databaseRoute = (slug: string, tab?: string) =>
  withTab(`/databases/${segment(slug)}`, tab);
export const proxyHostRoute = (slug: string, tab?: string) =>
  withTab(`/proxy-hosts/${segment(slug)}`, tab);
export const ingressGroupsRoute = () => "/routes/ingress-groups";
export const ingressGroupRoute = (id: string) => `/ingress-groups/${segment(id)}`;
export const pageProjectRoute = (slug: string, tab?: string) =>
  withTab(`/pages/${segment(slug)}`, tab);
/** The Domains tab with the domain's details open. */
export const domainRoute = (name: string) =>
  `/routes/domains?${new URLSearchParams({ domain: name })}`;
/** The certificates list with the certificate's details open. */
export const sslCertificateRoute = (id: string) =>
  `/certificates?${new URLSearchParams({ certificate: id })}`;
export const loggingEnvironmentRoute = (slug: string, tab?: string) =>
  withTab(`/logging/environments/${segment(slug)}`, tab);
export const loggingSchemaRoute = (slug: string, tab?: string) =>
  withTab(`/logging/schemas/${segment(slug)}`, tab);
export const dockerContainerRoute = (nodeSlug: string, name: string, tab?: string) =>
  withTab(`/docker/containers/${segment(nodeSlug)}/${segment(name)}`, tab);
export const dockerDeploymentRoute = (nodeSlug: string, name: string, tab?: string) =>
  withTab(`/docker/deployments/${segment(nodeSlug)}/${segment(name)}`, tab);
export const dockerVolumeRoute = (nodeSlug: string, name: string, tab?: string) =>
  withTab(`/docker/volumes/${segment(nodeSlug)}/${segment(name)}`, tab);
/** Pages that go away with a node: the node and the containers, deployments and volumes on it. */
export const nodeScopedPaths = (nodeSlug: string) => [
  nodeRoute(nodeSlug),
  `/docker/containers/${segment(nodeSlug)}`,
  `/docker/deployments/${segment(nodeSlug)}`,
  `/docker/volumes/${segment(nodeSlug)}`,
];
export const dockerComposeRootRoute = () => "/docker/compose";
export const dockerComposeProjectRoute = (projectId: string, tab?: string) =>
  withTab(`${dockerComposeRootRoute()}/${segment(projectId)}`, tab);
export const dockerComposeNewRoute = () => `${dockerComposeRootRoute()}/new`;

export function storageRoute(resource: string | { slug?: string; id: string }, tab?: string) {
  const slug = typeof resource === "string" ? resource : resource.slug || resource.id;
  return `/storage/${encodeURIComponent(slug)}${tab ? `/${encodeURIComponent(tab)}` : ""}`;
}
