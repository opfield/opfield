import { describe, expect, it } from "vitest";
import { mutationCachePrefixes } from "./mutation-cache";

describe("mutationCachePrefixes", () => {
  it("drops the Apps caches when an app member is deleted", () => {
    for (const url of [
      "/api/docker/nodes/n1/containers/c1",
      "/api/docker/nodes/n1/deployments/d1",
      "/api/docker/nodes/n1/compose-projects/p1",
      "/api/databases/db1",
      "/api/object-storage/s1?backupHistory=keep",
      "/api/pages/p1",
      "/api/proxy-hosts/r1",
      "/api/nodes/n1",
    ]) {
      expect(mutationCachePrefixes(url, "DELETE"), url).toContain("apps:");
    }
  });

  it("keeps the Apps caches for other member mutations and other resources", () => {
    expect(mutationCachePrefixes("/api/docker/nodes/n1/containers/c1/start")).not.toContain(
      "apps:"
    );
    expect(mutationCachePrefixes("/api/domains/d1", "DELETE")).not.toContain("apps:");
  });
});
