import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { Node } from "@/types";

const CACHE_KEY = "apps:nodes";

/** Every node the user may see, by id (node badges, the Nodes tab, Allow Node). Empty without node access. */
export function useNodeIndex(version = 0) {
  const canViewNodes = useAuthStore((state) => state.hasScopedAccess("nodes:details"));
  const [nodes, setNodes] = useState<Node[]>(() => api.getCached<Node[]>(CACHE_KEY) ?? []);
  const [loaded, setLoaded] = useState(() => api.getCached(CACHE_KEY) !== undefined);

  useEffect(() => {
    void version;
    if (!canViewNodes) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const all: Node[] = [];
        for (let page = 1; page <= 20; page += 1) {
          const response = await api.listNodes({ page, limit: 100 });
          all.push(...response.data);
          if (page >= response.totalPages) break;
        }
        if (cancelled) return;
        api.setCache(CACHE_KEY, all);
        setNodes(all);
      } catch {
        // Badges fall back to the node id.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canViewNodes, version]);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { nodes, byId, loaded, canViewNodes };
}

export const nodeDisplayName = (
  node: Pick<Node, "displayName" | "hostname"> | undefined,
  id: string
) => node?.displayName || node?.hostname || id.slice(0, 8);
