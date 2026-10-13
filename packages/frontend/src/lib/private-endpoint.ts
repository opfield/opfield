import type { DatabaseConnection } from "@/types";

/** How clients reach a managed database or storage with no published address: "Private · through relay · edge-1". */
export function privateThroughRelayLabel(nodeName?: string | null) {
  return ["Private", "through relay", nodeName].filter(Boolean).join(" · ");
}

/**
 * Where clients reach a database: a managed one with no published port only through the relay, with one by its
 * published TCP port on its node; another by its host and port.
 */
export function databaseEndpointLabel(
  database: Pick<DatabaseConnection, "host" | "port" | "managed">,
  nodeName?: string | null
) {
  const managed = database.managed;
  if (!managed) return `${database.host}:${database.port}`;
  if (managed.publishedPort == null) return privateThroughRelayLabel(nodeName);
  return [`TCP ${managed.publishedPort}`, nodeName].filter(Boolean).join(" · ");
}
