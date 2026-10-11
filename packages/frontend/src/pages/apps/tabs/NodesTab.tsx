// Nodes: every environment's allowed nodes, read-only (canvas frame app-nodes).
// Allow and remove nodes on each environment's page.
import { Server } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { nodeRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import type { AppAllowedNodes, AppDetail } from "@/types";
import { type AllowedNodeRow, allowedNodeColumns } from "../allowed-nodes";
import { useAppLoad } from "../app-resources";
import { CountTitle, GroupedList, groupTotal, orderedEnvironments } from "../app-shared";
import { useNodeIndex } from "../use-node-index";

const readOnlyColumns = allowedNodeColumns();

export function NodesTab({ app, version }: { app: AppDetail; version: number }) {
  const navigate = useNavigate();
  const { byId: nodesById } = useNodeIndex(version);
  const usage = useAppLoad(`nodes:${app.id}`, version, async () => {
    const entries = await Promise.all(
      app.environments.map(async (env) => {
        const result: AppAllowedNodes | null = await api
          .listAppAllowedNodes(app.id, env.id)
          .catch(() => null);
        return [env.id, result] as const;
      })
    );
    return new Map(entries);
  });
  if (usage.loading) return <ContentLoading loading />;

  const groups = orderedEnvironments(app.environments).map((env) => {
    const allowed = usage.data?.get(env.id);
    const nodeIds = allowed ? allowed.nodes.map((node) => node.nodeId) : env.allowedNodeIds;
    return {
      env,
      rows: nodeIds.map(
        (nodeId): AllowedNodeRow => ({
          nodeId,
          node: nodesById.get(nodeId),
          usedBy: allowed?.nodes.find((node) => node.nodeId === nodeId)?.usedBy,
        })
      ),
    };
  });

  return (
    <div className="pb-6">
      <PanelShell
        title={<CountTitle title="Allowed nodes" count={groupTotal(groups)} />}
        icon={<Server className="h-4 w-4" />}
        description="Nodes each environment may use"
      >
        {groupTotal(groups) === 0 ? (
          <EmptyState
            message="No nodes allowed yet. Open an environment to allow its nodes."
            embedded
          />
        ) : (
          <GroupedList
            appSlug={app.slug}
            columns={readOnlyColumns}
            groups={groups}
            rowKey={(row) => row.nodeId}
            onRowClick={(row) => {
              if (row.node) navigate(nodeRoute(row.node.slug));
            }}
          />
        )}
      </PanelShell>
    </div>
  );
}
