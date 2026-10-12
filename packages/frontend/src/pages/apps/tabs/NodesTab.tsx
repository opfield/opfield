// Nodes: every environment's allowed nodes (canvas frame app-nodes). Allow a node here or on the
// environment's page; remove nodes on the environment's page.
import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nodeRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import type { AppAllowedNodes, AppDetail, AppEnvironmentDetail } from "@/types";
import { type AllowedNodeRow, allowedNodeColumns } from "../allowed-nodes";
import { useAppLoad } from "../app-resources";
import { CountTitle, GroupedList, groupTotal, orderedEnvironments } from "../app-shared";
import { AllowNodeDialog } from "../dialogs/AllowNodeDialog";
import { useNodeIndex } from "../use-node-index";

const readOnlyColumns = allowedNodeColumns();

export function NodesTab({ app, version }: { app: AppDetail; version: number }) {
  const navigate = useNavigate();
  const { nodes, byId: nodesById } = useNodeIndex(version);
  const [localVersion, setLocalVersion] = useState(0);
  const [allowEnv, setAllowEnv] = useState<AppEnvironmentDetail | null>(null);
  const usage = useAppLoad(`nodes:${app.id}`, version + localVersion, async () => {
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

  // Allow Node per environment the user manages; with several, pick the environment first.
  const manageable = orderedEnvironments(app.environments).filter(
    (env) => app.permissions.envManage[env.id]
  );
  const allowAction =
    manageable.length === 1 ? (
      <Button onClick={() => setAllowEnv(manageable[0])}>
        <Plus className="h-3.5 w-3.5" />
        Allow node
      </Button>
    ) : manageable.length > 1 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus className="h-3.5 w-3.5" />
            Allow node
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {manageable.map((env) => (
            <DropdownMenuItem key={env.id} onClick={() => setAllowEnv(env)}>
              {env.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : undefined;

  return (
    <div className="pb-6">
      <PanelShell
        title={<CountTitle title="Allowed nodes" count={groupTotal(groups)} />}
        icon={<Server className="h-4 w-4" />}
        description="Nodes each environment may use"
        actions={allowAction}
      >
        {groupTotal(groups) === 0 ? (
          <EmptyState
            message="No nodes allowed yet. Resources of an environment are created only on its allowed nodes."
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
      {allowEnv && (
        <AllowNodeDialog
          app={app}
          env={allowEnv}
          nodes={nodes}
          open
          onOpenChange={(open) => {
            if (!open) setAllowEnv(null);
          }}
          onAllowed={() => setLocalVersion((current) => current + 1)}
        />
      )}
    </div>
  );
}
