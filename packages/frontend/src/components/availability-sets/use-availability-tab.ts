import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { usePlanIncludes } from "@/stores/license-paywall";
import type { AvailabilityOwner } from "@/types/availability-sets";

/**
 * Whether a managed resource shows its Availability tab: always with multi-node availability in
 * the plan, otherwise only while an availability set already exists (so it stays manageable).
 */
export function useAvailabilityTabVisible(owner: AvailabilityOwner | null): boolean {
  const inPlan = usePlanIncludes("multi-node-availability");
  const [hasSet, setHasSet] = useState(false);
  const kind = owner?.kind;
  const id = owner?.id;

  useEffect(() => {
    if (inPlan || !kind || !id) return;
    let cancelled = false;
    void api
      .getAvailability({ kind, id } as AvailabilityOwner)
      .then((view) => {
        if (!cancelled) setHasSet(!!view);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, inPlan, kind]);

  return inPlan || hasSet;
}
