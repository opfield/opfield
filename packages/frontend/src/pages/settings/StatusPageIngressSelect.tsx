import { useEffect, useState } from "react";
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
import { api } from "@/services/api";
import { usePlanIncludes } from "@/stores/license-paywall";
import type { IngressGroup, Node } from "@/types";

const GROUP_PREFIX = "group:";

interface StatusPageIngressSelectProps {
  nodeId: string | null;
  ingressGroupId: string | null;
  enabled: boolean;
  disabled: boolean;
  onlineNginxNodes: Node[];
  onChange: (target: { nodeId: string | null; ingressGroupId: string | null }) => void;
}

/**
 * The node or ingress group that serves the public status page. While the page is enabled it can move between one
 * node and a group that has that node as a member (the node keeps serving), but not to another single node.
 */
export function StatusPageIngressSelect({
  nodeId,
  ingressGroupId,
  enabled,
  disabled,
  onlineNginxNodes,
  onChange,
}: StatusPageIngressSelectProps) {
  const [loadedGroups, setGroups] = useState<IngressGroup[]>([]);
  // Serving from an ingress group needs multi-node availability; a page already on a group keeps it.
  const groupsInPlan = usePlanIncludes("multi-node-availability");
  const listsGroups = groupsInPlan || !!ingressGroupId;
  const groups = groupsInPlan
    ? loadedGroups
    : loadedGroups.filter((group) => group.id === ingressGroupId);

  useEffect(() => {
    if (!listsGroups) return;
    let cancelled = false;
    void api
      .listIngressGroups()
      .then((result) => {
        if (!cancelled) setGroups(result);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [listsGroups]);

  const currentGroup = groups.find((group) => group.id === ingressGroupId) ?? null;
  const nodeAllowed = (node: Node) => {
    if (node.serviceCreationLocked && node.id !== nodeId) return false;
    if (!enabled) return true;
    // Enabled: stay on the current node, or leave the current group for one of its members.
    if (currentGroup) return currentGroup.members.some((member) => member.nodeId === node.id);
    return node.id === nodeId;
  };
  const groupAllowed = (group: IngressGroup) =>
    !enabled || (!!nodeId && group.members.some((member) => member.nodeId === nodeId));

  return (
    <Select
      value={ingressGroupId ? `${GROUP_PREFIX}${ingressGroupId}` : (nodeId ?? "")}
      disabled={disabled}
      onValueChange={(value) =>
        onChange(
          value.startsWith(GROUP_PREFIX)
            ? { nodeId, ingressGroupId: value.slice(GROUP_PREFIX.length) }
            : { nodeId: value, ingressGroupId: null }
        )
      }
    >
      <SelectTrigger>
        <SelectValue placeholder="Select an online Ingress node or group" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {groups.length > 0 && <SelectLabel>Nginx nodes</SelectLabel>}
          {onlineNginxNodes.map((node) => (
            <SelectItem key={node.id} value={node.id} disabled={!nodeAllowed(node)}>
              {node.displayName || node.hostname}
            </SelectItem>
          ))}
        </SelectGroup>
        {groups.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Ingress groups (served by every member)</SelectLabel>
              {groups.map((group) => (
                <SelectItem
                  key={group.id}
                  value={`${GROUP_PREFIX}${group.id}`}
                  disabled={!groupAllowed(group)}
                >
                  {group.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}
