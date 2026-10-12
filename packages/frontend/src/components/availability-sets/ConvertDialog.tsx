import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { AvailabilityOwner, AvailabilityPreflightInput, Node } from "@/types";
import {
  AvailabilityCreateSection,
  type AvailabilityDraft,
  type AvailabilityEngine,
  type AvailabilityPreflightState,
  availabilityInputOf,
  EMPTY_AVAILABILITY_DRAFT,
} from "./AvailabilityCreateSection";
import { AVAILABILITY_CAPABILITY, AVAILABILITY_FEATURE, ownerNoun } from "./availability-labels";

/** "Make available…": runs a single-server database or storage on several servers. */
export function ConvertDialog({
  open,
  onOpenChange,
  owner,
  engine,
  originNodeId,
  nodes,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  owner: AvailabilityOwner;
  engine: AvailabilityEngine;
  originNodeId: string;
  nodes: Node[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<AvailabilityDraft>(EMPTY_AVAILABILITY_DRAFT);
  const [preflight, setPreflight] = useState<AvailabilityPreflightState>({
    result: null,
    pending: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_AVAILABILITY_DRAFT);
    setPreflight({ result: null, pending: false });
  }, [open]);

  const runPreflight = useCallback(
    (input: AvailabilityPreflightInput) => api.preflightAvailability(owner, input),
    [owner]
  );

  const manual = preflight.result?.mode === "manual";
  const ready = !!preflight.result && !preflight.pending && preflight.result.blockers.length === 0;

  const submit = async () => {
    if (!requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)) return;
    setSaving(true);
    try {
      await api.enableAvailability(owner, availabilityInputOf(originNodeId, draft, engine));
      toast.success("Setting up the servers");
      onDone();
      onOpenChange(false);
    } catch (error) {
      if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
        toastApiError(error, "Failed to turn on availability");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Make Available</DialogTitle>
          <DialogDescription>
            Keep a copy of this {ownerNoun(owner)} on another server and fail over to it.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AvailabilityCreateSection
            engine={engine}
            originNodeId={originNodeId}
            nodes={nodes}
            value={draft}
            onChange={setDraft}
            runPreflight={runPreflight}
            onPreflight={setPreflight}
            restartNoun={ownerNoun(owner)}
            disabled={saving}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button pending={saving} disabled={!ready} onClick={() => void submit()}>
            {manual ? "Create replicated pair (manual failover)" : "Turn on availability"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
