/**
 * The network a storage link's connector shares with its one workload on a
 * Docker node (`gateway-storage-<16 hex>`, see managed-storage-bindings), or a
 * managed storage cluster network (`gateway-storage-<cluster uuid>`). Mirrors
 * the daemon's storageBindingNetworkNamePattern.
 */
const OPFIELD_STORAGE_NETWORK =
  /^gateway-storage-(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** A container link network (`gateway-link-<16 hex>`): the consumer and the shared connector, nothing else. */
const OPFIELD_LINK_NETWORK = /^gateway-link-[0-9a-f]{16}$/;

/**
 * Networks Gateway owns on a Docker node. Users can neither list, connect,
 * disconnect nor remove them, and a user container cannot be created on one:
 * the Secure Links management network, managed database link networks
 * (`gateway-db-*`), managed storage networks and container link networks. The link services attach
 * their workloads through the daemon directly.
 */
export function isOpfieldManagedDockerNetwork(name: string) {
  return (
    name === 'gateway-secure-links' ||
    name.startsWith('gateway-db-') ||
    OPFIELD_STORAGE_NETWORK.test(name) ||
    OPFIELD_LINK_NETWORK.test(name)
  );
}

/** Names users may not give a network they create: every Gateway-managed name, now or later. */
export function isReservedOpfieldNetworkName(name: string) {
  return (
    name === 'gateway-secure-links' ||
    name.startsWith('gateway-db-') ||
    name.startsWith('gateway-storage-') ||
    name.startsWith('gateway-link-')
  );
}
