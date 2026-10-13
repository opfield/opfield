/** A storage link network (`gateway-storage-<16 hex>`) or a managed storage cluster network. */
const OPFIELD_STORAGE_NETWORK =
  /^gateway-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** A container link network (`gateway-link-<16 hex>`). */
const OPFIELD_LINK_NETWORK = /^gateway-link-[0-9a-f]{16}$/;

/** Mirrors the backend: Secure Links, managed database, managed storage and container link networks. */
export function isOpfieldManagedDockerNetwork(name: string) {
  return (
    name === "gateway-secure-links" ||
    name.startsWith("gateway-db-") ||
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
