import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { nodeStatusTone } from "@/components/common/resource-status";
import { Badge } from "@/components/ui/badge";
import { nodeTypeLabel } from "@/lib/node-appearance";
import { nodeRoute } from "@/lib/resource-routes";
import type { Node } from "@/types";
import { nodeDisplayStatus } from "@/types";

interface NodesCardProps {
  nodesList: Node[];
}

function dashboardNodePriority(node: Node): number {
  const status = nodeDisplayStatus(node);
  if (status === "offline" || status === "error") return 0;
  if (status === "degraded") return 1;
  if (status === "pending") return 2;
  if (status === "online") return 3;
  return 2;
}

export function sortDashboardNodes(nodes: Node[]): Node[] {
  return [...nodes].sort((left, right) => {
    const priorityDifference = dashboardNodePriority(left) - dashboardNodePriority(right);
    if (priorityDifference !== 0) return priorityDifference;

    const leftName = (left.displayName || left.hostname).toLowerCase();
    const rightName = (right.displayName || right.hostname).toLowerCase();
    return leftName.localeCompare(rightName) || left.id.localeCompare(right.id);
  });
}

export function NodesCard({ nodesList }: NodesCardProps) {
  // The server sends only what the viewer may see, and this panel explains the Dashboard dot: no
  // second scope check on the cached scopes. Omit the panel when there is nothing to show.
  if (nodesList.length === 0) return null;

  return (
    <PanelShell
      title="Nodes"
      actions={
        <Link to="/nodes" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      }
    >
      <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
        {sortDashboardNodes(nodesList)
          .slice(0, 8)
          .map((node) => (
            <Link
              key={node.id}
              to={nodeRoute(node.slug)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors"
            >
              <span className="text-sm font-medium truncate flex-1">
                {node.displayName || node.hostname}
              </span>
              <Badge variant="secondary" size="inline">
                {nodeTypeLabel(node.type)}
              </Badge>
              {node.daemonVersion && (
                <Badge variant="outline" size="inline">
                  {node.daemonVersion}
                </Badge>
              )}
              <Badge variant={nodeStatusTone(nodeDisplayStatus(node))} size="inline">
                {nodeDisplayStatus(node)}
              </Badge>
            </Link>
          ))}
      </div>
    </PanelShell>
  );
}
