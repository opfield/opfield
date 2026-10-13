import {
  CONTAINER_LINK_NETWORK_PATTERN,
  isContainerLinkNetworkName,
  isManagedDatabaseLinkNetworkName,
  isManagedStorageNetworkName,
  isSecureLinkManagementNetwork,
  MANAGED_STORAGE_NETWORK_PATTERN,
} from './docker-object-names.js';

/**
 * Networks Opfield owns on a Docker node. Users can neither list, connect,
 * disconnect nor remove them, and a user container cannot be created on one:
 * the Secure Links management network, managed database link networks
 * (`opfield-db-*`), managed storage networks (`opfield-storage-<16 hex>` of a storage link, the cluster id of a
 * managed storage cluster) and container link networks (`opfield-link-<16 hex>`); objects created before 2.12.1 keep
 * their earlier names (docker-object-names.ts). The link services attach their workloads through the daemon directly.
 */
export function isOpfieldManagedDockerNetwork(name: string) {
  return (
    isSecureLinkManagementNetwork(name) ||
    isManagedDatabaseLinkNetworkName(name) ||
    MANAGED_STORAGE_NETWORK_PATTERN.test(name) ||
    CONTAINER_LINK_NETWORK_PATTERN.test(name)
  );
}

/** Names users may not give a network they create: every Opfield-managed name, now or later. */
export function isReservedOpfieldNetworkName(name: string) {
  return (
    isSecureLinkManagementNetwork(name) ||
    isManagedDatabaseLinkNetworkName(name) ||
    isManagedStorageNetworkName(name) ||
    isContainerLinkNetworkName(name)
  );
}
