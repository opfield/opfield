import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/common/Combobox";
import { ContentLoading } from "@/components/common/ContentLoading";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import type { HostingAdoptionCandidates } from "@/types/hosting";

export function HostingAdoptDialog({
  open,
  connectorId,
  onClose,
  onAdopted,
}: {
  open: boolean;
  connectorId: string;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const [candidates, setCandidates] = useState<HostingAdoptionCandidates | null>(null);
  const [resourceId, setResourceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  // Cleared when the dialog closes: every opening waits for fresh candidates.
  const [candidatesSettled, setCandidatesSettled] = useState(false);
  const submitting = useRef(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    if (!open) return;
    const current = ++generation.current;
    setCandidates(null);
    setResourceId("");
    setNodeId("");
    setError(null);
    setLoading(true);
    void api
      .getHostingAdoptionCandidates(connectorId)
      .then((data) => {
        if (generation.current === current) setCandidates(data);
      })
      .catch((cause) => {
        if (generation.current === current)
          setError(
            cause instanceof Error ? cause.message : "Could not load available resources and nodes."
          );
      })
      .finally(() => {
        if (generation.current !== current) return;
        setLoading(false);
        setCandidatesSettled(true);
      });
  }, [open, connectorId]);
  useEffect(() => {
    load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!open) setCandidatesSettled(false);
  }, [open]);
  const adopt = async () => {
    if (submitting.current || !resourceId || !nodeId) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const current = generation.current;
    try {
      await api.adoptHostingNode(connectorId, { resourceId, nodeId });
      if (current !== generation.current) return;
      toast.success("Node adopted");
      onClose();
      onAdopted();
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Could not verify this node association."
        );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const empty = !!candidates && (!candidates.resources.length || !candidates.nodes.length);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting.current) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adopt Nodes</DialogTitle>
          <DialogDescription>
            Associate an existing VM or container with an Opfield node. Opfield verifies that both
            are the same host before linking them.
          </DialogDescription>
        </DialogHeader>
        <PanelShell title="Node association">
          <ContentLoading loading={open && !candidatesSettled} />
          <SettingsControlRow
            title="VM or container"
            description="Discovered resources without an Opfield association."
          >
            <Combobox
              ariaLabel="VM or container"
              value={resourceId}
              onValueChange={setResourceId}
              disabled={loading || busy || !candidates?.resources.length}
              placeholder="Select a resource"
              options={(candidates?.resources ?? []).map((r) => ({
                value: r.id,
                label: `${r.name} · ${r.kind === "ct" ? "CT" : "VM"} ${r.remoteId}`,
              }))}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Opfield node"
            description="Nodes without a hosting association."
          >
            <Combobox
              ariaLabel="Opfield node"
              value={nodeId}
              onValueChange={setNodeId}
              disabled={loading || busy || !candidates?.nodes.length}
              placeholder="Select a node"
              options={(candidates?.nodes ?? []).map((n) => ({
                value: n.id,
                label: `${n.displayName || n.hostname} · ${n.status}`,
              }))}
            />
          </SettingsControlRow>
        </PanelShell>
        {empty && (
          <p className="text-sm text-muted-foreground">
            {!candidates.resources.length
              ? "No unbound resources are available. Synchronize the provider to refresh discovery."
              : "No unbound Opfield nodes are available."}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {error && !candidates ? (
            <Button onClick={load} pending={loading}>
              Try again
            </Button>
          ) : (
            <Button
              onClick={() => void adopt()}
              pending={busy}
              disabled={loading || empty || !resourceId || !nodeId}
            >
              Verify and adopt
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
