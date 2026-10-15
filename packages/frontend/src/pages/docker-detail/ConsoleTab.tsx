import { type ReactNode, useCallback } from "react";
import { ConsolePanel } from "@/components/terminal/ConsolePanel";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

export function ConsoleTab({
  nodeId,
  containerId,
  scopeResourceId,
  scopeNodeId = nodeId,
  headerActions,
  onContainerUnavailable,
}: {
  nodeId: string;
  containerId: string;
  scopeResourceId?: string;
  scopeNodeId?: string;
  headerActions?: ReactNode;
  /** The console found no container (recreated, not running yet): the page looks it up again. */
  onContainerUnavailable?: () => void;
}) {
  const { hasScope } = useAuthStore();
  const canUseConsole = hasScope(
    `docker:containers:console:${scopeNodeId}${scopeResourceId ? `/${scopeResourceId}` : ""}`
  );

  const wsFactory = useCallback(
    () => api.createExecWebSocket(nodeId, containerId, "auto"),
    [nodeId, containerId]
  );

  if (!canUseConsole) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        You don't have permission to access the console.
      </div>
    );
  }

  return (
    <ConsolePanel
      title="Container Console"
      description="Interactive shell session inside this container"
      wsFactory={wsFactory}
      channelKey={`docker-console:${containerId}`}
      popoutUrl={`/docker/console/${nodeId}/${containerId}?shell=auto`}
      connectLabel={containerId.slice(0, 12)}
      headerActions={headerActions}
      onContainerUnavailable={onContainerUnavailable}
    />
  );
}
