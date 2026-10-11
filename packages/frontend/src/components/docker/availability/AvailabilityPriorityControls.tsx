import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Node } from "@/types";
import { movePriorityNode, priorityRoleLabel } from "./availability-priority";

function nodeLabel(nodeId: string, nodes: Node[]) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.displayName || node?.hostname || node?.slug || nodeId.slice(0, 12);
}

/**
 * Priority mode settings of the Availability panel: the switch, the ordered node list (Primary, then Backup 1..n)
 * with keyboard-accessible up/down buttons, and the failback delay.
 */
export function AvailabilityPriorityControls({
  nodes,
  compatibleNodeIds,
  priorityMode,
  onPriorityModeChange,
  order,
  onOrderChange,
  failbackDelay,
  onFailbackDelayChange,
  disabled,
  part = "all",
  rowClassName,
  detailsClassName,
}: {
  nodes: Node[];
  compatibleNodeIds: Set<string>;
  priorityMode: boolean;
  onPriorityModeChange: (value: boolean) => void;
  order: string[];
  onOrderChange: (order: string[]) => void;
  failbackDelay: string;
  onFailbackDelayChange: (value: string) => void;
  disabled: boolean;
  /** Render only the Priority mode row, only its details (order and delay), or both. */
  part?: "all" | "row" | "details";
  rowClassName?: string;
  detailsClassName?: string;
}) {
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());

  function move(index: number, delta: -1 | 1) {
    const nodeId = order[index];
    const next = movePriorityNode(order, index, delta);
    if (!nodeId || next === order) return;
    onOrderChange(next);
    // Keep focus on the moved node; at either end it moves to its other button.
    const target = index + delta;
    const direction =
      (target === 0 && delta === -1) || (target === next.length - 1 && delta === 1)
        ? -delta
        : delta;
    requestAnimationFrame(() => moveButtons.current.get(`${nodeId}:${direction}`)?.focus());
  }

  return (
    <>
      {part !== "details" && (
        <SettingsControlRow
          className={rowClassName}
          title="Priority mode"
          description="Prefer nodes in a fixed order and move back to the primary when it returns."
          help="Traffic is served from the first available nodes in the order below; the first node is the primary. When a higher-priority node comes back and stays healthy for the delay below, the workload starts there, traffic switches to it, and the backup placement is drained and removed."
        >
          <Switch
            checked={priorityMode}
            onChange={onPriorityModeChange}
            disabled={disabled}
            ariaLabel="Priority mode"
          />
        </SettingsControlRow>
      )}
      {part !== "row" && priorityMode && (
        <>
          {order.length === 0 ? (
            <div className={cn("border-b border-border", detailsClassName)}>
              <EmptyState embedded message="Select eligible nodes to set their priority." />
            </div>
          ) : (
            <ol
              className={cn("divide-y divide-border border-b border-border", detailsClassName)}
              aria-label="Node priority"
            >
              {order.map((nodeId, index) => {
                const name = nodeLabel(nodeId, nodes);
                const status = nodes.find((node) => node.id === nodeId)?.status;
                return (
                  <li key={nodeId} className="flex min-w-0 items-center gap-2 px-4 py-2 text-sm">
                    <Badge size="inline" variant={index === 0 ? "info" : "secondary"}>
                      {priorityRoleLabel(index)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {!compatibleNodeIds.has(nodeId) && status ? (
                      <Badge size="inline" variant="secondary">
                        {status.replaceAll("_", " ")}
                      </Badge>
                    ) : null}
                    <Button
                      ref={(button) => {
                        if (button) moveButtons.current.set(`${nodeId}:-1`, button);
                        else moveButtons.current.delete(`${nodeId}:-1`);
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${name} up`}
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      ref={(button) => {
                        if (button) moveButtons.current.set(`${nodeId}:1`, button);
                        else moveButtons.current.delete(`${nodeId}:1`);
                      }}
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${name} down`}
                      disabled={disabled || index === order.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
          <SettingsControlRow
            className={detailsClassName}
            title="Return to the primary after"
            description="How long a returning higher-priority node must stay healthy first."
            help="A node that goes offline or reports an error again restarts this delay, so a flapping node never takes traffic back. Zero moves back as soon as the node is healthy."
          >
            <Input
              aria-label="Return to the primary after, in seconds"
              type="number"
              min={0}
              max={3600}
              value={failbackDelay}
              onChange={(event) => onFailbackDelayChange(event.target.value)}
              disabled={disabled}
            />
          </SettingsControlRow>
        </>
      )}
    </>
  );
}
