import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { nodeTypeLabel } from "@/lib/node-appearance";
import type { RouteIngressGroupOption } from "@/types";

export interface IngressTargetNodeOption {
  id: string;
  hostname: string;
  status: string;
  type: string;
  serviceCreationLocked: boolean;
}

/** Where a route is served: one node, an ingress group, or chosen by the server (registered domain). */
export interface IngressTarget {
  nodeId: string;
  ingressGroupId: string;
  auto: boolean;
}

const NONE_VALUE = "__none__";
/** Create without a node: the server uses the registered domain's ingress node or group. */
export const AUTO_INGRESS_TARGET = "__auto__";
const GROUP_PREFIX = "group:";

export function ingressTargetValue(target: IngressTarget): string {
  if (target.auto) return AUTO_INGRESS_TARGET;
  if (target.ingressGroupId) return `${GROUP_PREFIX}${target.ingressGroupId}`;
  return target.nodeId || NONE_VALUE;
}

export function parseIngressTarget(value: string): IngressTarget {
  if (value === AUTO_INGRESS_TARGET) return { nodeId: "", ingressGroupId: "", auto: true };
  if (value.startsWith(GROUP_PREFIX)) {
    return { nodeId: "", ingressGroupId: value.slice(GROUP_PREFIX.length), auto: false };
  }
  return { nodeId: value === NONE_VALUE ? "" : value, ingressGroupId: "", auto: false };
}

function statusVariant(status: string) {
  if (status === "online") return "success" as const;
  if (status === "error") return "destructive" as const;
  return "secondary" as const;
}

interface IngressTargetSelectProps {
  target: IngressTarget;
  onChange: (target: IngressTarget) => void;
  nodes: IngressTargetNodeOption[];
  groups: RouteIngressGroupOption[];
  loading?: boolean;
  allowAutomatic?: boolean;
  /** The node a route already uses may be kept even when it is locked for new services. */
  currentNodeId?: string | null;
  /** A route on a group changes its placement from the route page; the edit dialog shows the group only. */
  lockedGroupName?: string | null;
  /** The only target an app environment allows: shown, not changeable. */
  disabled?: boolean;
  /** Shown under the field (which targets an app environment allows). */
  hint?: string | null;
}

/**
 * The ingress node or ingress group of a route: nginx nodes, then the groups the caller may view whose members the
 * caller may use.
 */
export function IngressTargetSelect({
  target,
  onChange,
  nodes,
  groups,
  loading,
  allowAutomatic,
  currentNodeId,
  lockedGroupName,
  disabled,
  hint,
}: IngressTargetSelectProps) {
  const selectedNode = nodes.find((node) => node.id === target.nodeId) ?? null;
  const selectedGroup = groups.find((group) => group.id === target.ingressGroupId) ?? null;
  const locked = (node: IngressTargetNodeOption) =>
    node.serviceCreationLocked && node.id !== currentNodeId;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">Ingress node or group</label>
      <Select
        value={lockedGroupName ? "__locked__" : ingressTargetValue(target)}
        onValueChange={(value) => onChange(parseIngressTarget(value))}
        disabled={loading || !!lockedGroupName || disabled}
      >
        <SelectTrigger aria-label="Ingress node" aria-busy={loading}>
          {lockedGroupName ? (
            <span className="min-w-0 flex-1 truncate">{lockedGroupName} (ingress group)</span>
          ) : selectedGroup ? (
            <div className="flex min-w-0 items-center gap-3 pr-2">
              <span className="min-w-0 flex-1 truncate">{selectedGroup.name}</span>
              <Badge variant="secondary" size="inline" className="shrink-0">
                {selectedGroup.members.length} members
              </Badge>
            </div>
          ) : target.ingressGroupId ? (
            // A registered domain's group the caller may not view (or the list is still loading).
            <span className="min-w-0 flex-1 truncate">Ingress group</span>
          ) : selectedNode ? (
            <div className="flex min-w-0 items-center gap-3 pr-2">
              <span className="min-w-0 flex-1 truncate">{selectedNode.hostname}</span>
              <Badge variant="secondary" size="inline" className="shrink-0">
                {nodeTypeLabel(selectedNode.type)}
              </Badge>
              <Badge
                variant={statusVariant(selectedNode.status)}
                size="inline"
                className="shrink-0"
              >
                {selectedNode.status}
              </Badge>
            </div>
          ) : target.auto ? (
            <span className="min-w-0 flex-1 truncate">Automatic (from the registered domain)</span>
          ) : (
            <SelectValue placeholder="Select a node or group..." />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE} disabled>
            Select a node or group...
          </SelectItem>
          {allowAutomatic && (
            <SelectItem value={AUTO_INGRESS_TARGET}>
              Automatic (from the registered domain)
            </SelectItem>
          )}
          <SelectGroup>
            {groups.length > 0 && <SelectLabel>Nginx nodes</SelectLabel>}
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id} disabled={locked(node)}>
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{node.hostname}</span>
                  <Badge variant="secondary" size="inline">
                    {nodeTypeLabel(node.type)}
                  </Badge>
                  <Badge variant={statusVariant(node.status)} size="inline">
                    {node.status}
                  </Badge>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
          {groups.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Ingress groups (served by every member)</SelectLabel>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={`${GROUP_PREFIX}${group.id}`}>
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="min-w-0 truncate">{group.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {group.members
                          .map((member) => member.displayName || member.hostname)
                          .join(", ")}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          {lockedGroupName && <SelectItem value="__locked__">{lockedGroupName}</SelectItem>}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
