import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import { daemonTypeForNode, isDaemonUpdateAvailable, nodeTypeLabel } from "@/lib/node-appearance";
import { api } from "@/services/api";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { isNodeUpdateQueued, isNodeUpdating, type Node } from "@/types";

interface Candidate {
  node: Node;
  targetVersion: string;
  /** Why the node cannot be updated now; null when it can. */
  blockedReason: string | null;
}

async function loadAllNodes(): Promise<Node[]> {
  const nodes: Node[] = [];
  for (let page = 1; ; page++) {
    const result = await api.listNodes({ page, limit: 100 });
    nodes.push(...result.data);
    if (page >= result.totalPages) return nodes;
  }
}

/** Nodes whose daemon is older than the latest release of its type. */
export function nodeUpdateCandidates(
  nodes: Node[],
  latestByType: Map<string, string | null>
): Candidate[] {
  return nodes.flatMap((node) => {
    // Relay nodes update with the Relay Pool, which drains and orders them.
    if (node.type === "relay") return [];
    const targetVersion = latestByType.get(daemonTypeForNode(node.type));
    if (!isDaemonUpdateAvailable(node.daemonVersion, targetVersion)) return [];
    const blockedReason = isNodeUpdating(node)
      ? isNodeUpdateQueued(node)
        ? "Queued"
        : "Updating"
      : node.status !== "online" || !node.isConnected
        ? "Offline"
        : null;
    return [{ node, targetVersion, blockedReason }];
  });
}

/** The candidate list; the dialog opens once it is known. */
function CandidateList({
  candidates,
  selected,
  selectable,
  disabled,
  onToggle,
  onSelectAll,
}: {
  candidates: Candidate[] | null;
  selected: Set<string>;
  selectable: Candidate[];
  disabled: boolean;
  onToggle: (nodeId: string, checked: boolean) => void;
  onSelectAll: (all: boolean) => void;
}) {
  useContentLoading(candidates === null);
  if (candidates === null) return null;
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">Every node runs the latest daemon.</p>;
  }
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.node.id));
  return (
    <div className="space-y-2">
      {selectable.length > 1 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            disabled={disabled}
            onClick={() => onSelectAll(!allSelected)}
          >
            {allSelected ? "Clear selection" : "Select all"}
          </Button>
        </div>
      )}
      {candidates.map(({ node, targetVersion, blockedReason }) => (
        <CheckboxCard
          key={node.id}
          checked={selected.has(node.id)}
          onCheckedChange={(checked) => onToggle(node.id, checked)}
          disabled={!!blockedReason || disabled}
          label={node.displayName || node.hostname}
          description={`${nodeTypeLabel(node.type)} · ${node.daemonVersion ?? "unknown"} → ${targetVersion}${
            blockedReason ? ` · ${blockedReason}` : ""
          }`}
        />
      ))}
    </div>
  );
}

export function BulkNodeUpdateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fetchDaemonUpdates = useDaemonUpdatesStore((state) => state.fetchDaemonUpdates);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates(null);
    Promise.all([fetchDaemonUpdates({ force: true }), loadAllNodes()])
      .then(([statuses, nodes]) => {
        if (cancelled) return;
        const latestByType = new Map(
          statuses.map((status) => [status.daemonType as string, status.latestVersion])
        );
        const next = nodeUpdateCandidates(nodes, latestByType);
        setCandidates(next);
        setSelected(
          new Set(
            next
              .filter((candidate) => !candidate.blockedReason)
              .map((candidate) => candidate.node.id)
          )
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setCandidates([]);
        toastApiError(error, "Failed to load node updates");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchDaemonUpdates, open]);

  const selectable = useMemo(
    () => (candidates ?? []).filter((candidate) => !candidate.blockedReason),
    [candidates]
  );
  const toggle = (nodeId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });

  const update = async () => {
    const chosen = selectable.filter((candidate) => selected.has(candidate.node.id));
    if (chosen.length === 0) return;
    setUpdating(true);
    // Sent together on purpose: Gateway orders nodes that share an availability lease, the
    // others restart at the same time.
    const results = await Promise.allSettled(
      chosen.map((candidate) => api.triggerDaemonUpdate(candidate.node.id))
    );
    setUpdating(false);
    const failed = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${chosen[index]!.node.displayName || chosen[index]!.node.hostname}: ${
              result.reason instanceof Error ? result.reason.message : "update failed"
            }`,
          ]
        : []
    );
    const started = chosen.length - failed.length;
    // Each node waits for its own running tasks first (at most 30 minutes), as a single update does.
    const waiting = results.filter(
      (result) => result.status === "fulfilled" && (result.value.waitingForTasks ?? 0) > 0
    ).length;
    if (started > 0) {
      toast.success(
        waiting > 0
          ? `Updating ${started} node${started === 1 ? "" : "s"}; ${waiting} of them wait${waiting === 1 ? "s" : ""} for running tasks first, at most 30 minutes`
          : `Updating ${started} node${started === 1 ? "" : "s"}; each one restarts its daemon shortly`
      );
    }
    if (failed.length > 0) {
      toast.error(
        failed.length === 1
          ? `The update did not start on ${failed[0]}`
          : `The update did not start on ${failed.length} nodes, first ${failed[0]}`
      );
    }
    if (failed.length === 0) {
      onOpenChange(false);
      return;
    }
    // Keep the dialog for a retry of the nodes that did not start; the others now update.
    const startedIds = new Set(
      chosen.filter((_, index) => results[index]!.status === "fulfilled").map((c) => c.node.id)
    );
    setCandidates((current) =>
      (current ?? []).map((candidate) =>
        startedIds.has(candidate.node.id) ? { ...candidate, blockedReason: "Updating" } : candidate
      )
    );
    setSelected((current) => new Set([...current].filter((id) => !startedIds.has(id))));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !updating && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update Nodes</DialogTitle>
          <DialogDescription>
            The selected nodes update together; nodes that share an availability lease restart one
            after another, ingress nodes restart after the others, and a node with running tasks
            waits for them first.
          </DialogDescription>
        </DialogHeader>
        <CandidateList
          candidates={candidates}
          selected={selected}
          selectable={selectable}
          disabled={updating}
          onToggle={toggle}
          onSelectAll={(all) =>
            setSelected(all ? new Set(selectable.map((c) => c.node.id)) : new Set())
          }
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updating}>
            Cancel
          </Button>
          <Button onClick={() => void update()} disabled={selected.size === 0} pending={updating}>
            {selected.size > 0
              ? `Update ${selected.size} node${selected.size === 1 ? "" : "s"}`
              : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
