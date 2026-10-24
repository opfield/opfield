import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import type { Node } from "@/types";

export const MANAGED_STORAGE_CAPABILITY = "managed_storage_v1";
export const DATABASE_BACKUPS_CAPABILITY = "database_backups_v1";
const MAX_NODE_LIST_PAGE_SIZE = 100;
const COMPACT_CAPABILITY_FLAGS: Record<string, string> = {
  managed_databases_v1: "managedDatabasesV1",
  managed_storage_v1: "managedStorageV1",
  database_backups_v1: "databaseBackupsV1",
};

function isLegacyStorageTypeValidationError(error: unknown): boolean {
  if (
    !(error instanceof ApiRequestError) ||
    error.status !== 400 ||
    error.code !== "VALIDATION_ERROR"
  ) {
    return false;
  }
  return (
    Array.isArray(error.details) &&
    error.details.some(
      (detail) =>
        detail &&
        typeof detail === "object" &&
        (detail as { path?: unknown }).path === "type" &&
        typeof (detail as { message?: unknown }).message === "string" &&
        /storage/i.test((detail as { message: string }).message)
    )
  );
}

async function listManagedDatabaseNodePages(
  type: "databases" | "storage",
  requestedLimit: number
): Promise<Node[]> {
  if (requestedLimit <= MAX_NODE_LIST_PAGE_SIZE) {
    return (await api.listNodes({ type, limit: requestedLimit })).data;
  }

  const pageCount = Math.ceil(requestedLimit / MAX_NODE_LIST_PAGE_SIZE);
  const nodes: Node[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const result = await api.listNodes({ type, page, limit: MAX_NODE_LIST_PAGE_SIZE });
    nodes.push(...result.data);
    const totalPages = result.totalPages ?? pageCount;
    if (page >= totalPages || result.data.length < MAX_NODE_LIST_PAGE_SIZE) break;
  }
  return nodes.slice(0, requestedLimit);
}

/** Nodes allowed to host managed database and storage runtimes. */
export async function listManagedDatabaseCandidateNodes(limit = 100): Promise<Node[]> {
  const [databaseResult, storageResult] = await Promise.all([
    listManagedDatabaseNodePages("databases", limit),
    listManagedDatabaseNodePages("storage", limit).catch((error) => {
      if (isLegacyStorageTypeValidationError(error)) return null;
      throw error;
    }),
  ]);
  const byID = new Map(databaseResult.map((node) => [node.id, node]));
  for (const node of storageResult ?? []) byID.set(node.id, node);
  return [...byID.values()];
}

export function isManagedDatabaseCandidateNode(
  node: Pick<Node, "type"> | null | undefined
): boolean {
  return node?.type === "databases" || node?.type === "storage";
}

export function nodeSupportsCapability(
  node: Pick<Node, "capabilities"> | null | undefined,
  capability: string
): boolean {
  const capabilities = node?.capabilities;
  if (!capabilities) return false;
  const compactFlag = COMPACT_CAPABILITY_FLAGS[capability];
  if (compactFlag && capabilities[compactFlag] === true) return true;
  const advertised = capabilities.capabilities;
  return Array.isArray(advertised) && advertised.includes(capability);
}

export function isManagedStorageCandidateNode(
  node: Pick<Node, "type" | "capabilities"> | null | undefined
): boolean {
  return (
    isManagedDatabaseCandidateNode(node) && nodeSupportsCapability(node, MANAGED_STORAGE_CAPABILITY)
  );
}

export function isDatabaseBackupCandidateNode(
  node: Pick<Node, "type" | "capabilities"> | null | undefined
): boolean {
  return (
    isManagedDatabaseCandidateNode(node) &&
    nodeSupportsCapability(node, DATABASE_BACKUPS_CAPABILITY)
  );
}

/** The node's database daemon starts Valkey with the modules its CPU runs and reports its x86-64 level. */
export const VALKEY_CPU_MODULES_CAPABILITY = "managed_redis_valkey_cpu_modules_v1";

/**
 * Whether a Valkey key-value store on the node runs without Search: Search needs AVX2 (x86-64-v3), and on an older
 * CPU (a VM with an x86-64-v2 CPU type) the daemon starts Valkey with JSON and Bloom only. False when the node's
 * daemon does not say (an older daemon).
 */
export function valkeySearchUnavailableOnNode(
  node: Pick<Node, "capabilities"> | null | undefined
): boolean {
  if (!nodeSupportsCapability(node, VALKEY_CPU_MODULES_CAPABILITY)) return false;
  const advertised = node?.capabilities?.capabilities;
  if (!Array.isArray(advertised)) return false;
  const level = advertised
    .map((capability) => /^cpu_x86_64_v(\d)$/.exec(String(capability)))
    .find((match) => match !== null);
  return !!level && Number(level[1]) < 3;
}

export const VALKEY_SEARCH_UNAVAILABLE_TEXT =
  "This node's CPU has no AVX2 (x86-64-v3), so Valkey runs here with JSON and Bloom but without Search (FT.* commands).";
