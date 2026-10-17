/**
 * Opfield's own Docker network names (mirrors the backend's docker-object-names.ts). Networks created before 2.12.1
 * keep their earlier names.
 */
// legacy-name: legacy-prefixed networks of links created before 2.12.1 — remove once every node reports none
const NETWORK_FAMILY = "(?:opfield|gateway)";

/** A storage link network (`opfield-storage-<16 hex>`) or a managed storage cluster network. */
const OPFIELD_STORAGE_NETWORK = new RegExp(
  `^${NETWORK_FAMILY}-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`
);

/** A container link network (`opfield-link-<16 hex>`). */
const OPFIELD_LINK_NETWORK = new RegExp(`^${NETWORK_FAMILY}-link-[0-9a-f]{16}$`);

/** The Secure Links management network and managed database link networks. */
const OPFIELD_SECURE_LINK_NETWORK = new RegExp(`^${NETWORK_FAMILY}-secure-links$`);
const OPFIELD_DATABASE_NETWORK = new RegExp(`^${NETWORK_FAMILY}-db-`);

/** Mirrors the backend: Secure Links, managed database, managed storage and container link networks. */
export function isOpfieldManagedDockerNetwork(name: string) {
  return (
    OPFIELD_SECURE_LINK_NETWORK.test(name) ||
    OPFIELD_DATABASE_NETWORK.test(name) ||
    OPFIELD_STORAGE_NETWORK.test(name) ||
    OPFIELD_LINK_NETWORK.test(name)
  );
}

export function filterUserDockerNetworks<T extends { name?: string; Name?: string }>(
  networks: T[]
) {
  return networks.filter(
    (network) => !isOpfieldManagedDockerNetwork(String(network.name ?? network.Name ?? ""))
  );
}

/** Runtime containers Opfield runs for managed databases, storage, links, connectors and backups. */
const OPFIELD_RUNTIME_CONTAINER = new RegExp(
  `^${NETWORK_FAMILY}-(db|storage|link|managed|clickhouse|backup|secure-link|database-connector|storage-connector)(-|$)`
);

/** Whether a container name is one of Opfield's own runtime containers, never shown by its name. */
export function isOpfieldRuntimeContainerName(name: string) {
  return OPFIELD_RUNTIME_CONTAINER.test(name.replace(/^\//, ""));
}

/** What lists show for one of Opfield's own runtime containers. */
export const OPFIELD_RUNTIME_CONTAINER_LABEL = "Opfield service";
