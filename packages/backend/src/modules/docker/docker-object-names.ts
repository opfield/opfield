import {
  LEGACY_CONTAINER_LINK_NETWORK_PREFIX,
  LEGACY_DATABASE_LINK_NETWORK_PREFIX,
  LEGACY_SECURE_LINK_NETWORK,
  LEGACY_STORAGE_LINK_NETWORK_PREFIX,
} from '@/lib/legacy-compat.js';

/**
 * Names of the Docker networks Opfield owns on a node: the Secure Link management network and the networks of managed
 * database, storage and container links (the commercial core's docker/opfield-names.ts names them).
 *
 * Objects created from 2.12.1 on carry Opfield names. Docker cannot rename a network in place, so a network created
 * before keeps its earlier name for its whole life (the name is stored on its link's row); every reader here accepts
 * both families.
 */

// legacy-name: legacy-prefixed link networks of links created before 2.12.1 or for a node without
// docker_opfield_names_v1 — remove once every node reports none
const DATABASE_LINK_NETWORK_PREFIXES = ['opfield-db-', LEGACY_DATABASE_LINK_NETWORK_PREFIX];
// legacy-name: legacy-prefixed storage networks (see DATABASE_LINK_NETWORK_PREFIXES) — remove once every node reports none
const STORAGE_NETWORK_PREFIXES = ['opfield-storage-', LEGACY_STORAGE_LINK_NETWORK_PREFIX];
// legacy-name: legacy-prefixed link networks (see DATABASE_LINK_NETWORK_PREFIXES) — remove once every node reports none
const CONTAINER_LINK_NETWORK_PREFIXES = ['opfield-link-', LEGACY_CONTAINER_LINK_NETWORK_PREFIX];

/** A managed database link network (`opfield-db-<16 hex>`, `opfield-db-av-<16 hex>`), by prefix. */
export function isManagedDatabaseLinkNetworkName(name: string): boolean {
  return DATABASE_LINK_NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A managed storage link or cluster network, by prefix. */
export function isManagedStorageNetworkName(name: string): boolean {
  return STORAGE_NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** A container link network, by prefix. */
export function isContainerLinkNetworkName(name: string): boolean {
  return CONTAINER_LINK_NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A storage link network (`opfield-storage-<16 hex>`) or a managed storage cluster network
 * (`opfield-storage-<cluster uuid>`). Mirrors the daemon's storageBindingNetworkNamePattern.
 */
// legacy-name: legacy-prefixed storage networks (see STORAGE_NETWORK_PREFIXES) — remove once every node reports none
export const MANAGED_STORAGE_NETWORK_PATTERN = new RegExp(
  `^(?:opfield-storage-|${LEGACY_STORAGE_LINK_NETWORK_PREFIX})(?:[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`
);
/** A container link network (`opfield-link-<16 hex>`): the consumer and the shared connector, nothing else. */
// legacy-name: legacy-prefixed link networks (see CONTAINER_LINK_NETWORK_PREFIXES) — remove once every node reports none
export const CONTAINER_LINK_NETWORK_PATTERN = new RegExp(
  `^(?:opfield-link-|${LEGACY_CONTAINER_LINK_NETWORK_PREFIX})[0-9a-f]{16}$`
);

/** The node's Secure Link management network, of either family. */
export const SECURE_LINK_MANAGEMENT_NETWORKS: readonly string[] = [
  'opfield-secure-links',
  // legacy-name: the Secure Link network of nodes that ran it before 2.12.1 — remove once every node reports none
  LEGACY_SECURE_LINK_NETWORK,
];

export function isSecureLinkManagementNetwork(name: string): boolean {
  return SECURE_LINK_MANAGEMENT_NETWORKS.includes(name);
}
