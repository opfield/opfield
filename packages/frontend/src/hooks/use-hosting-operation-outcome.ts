import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { hostingActionTitle } from "@/lib/hosting-status";
import type { HostingOperation } from "@/types/hosting";

type OutcomeOperation = Pick<HostingOperation, "id" | "action" | "phase" | "errorMessage">;

/**
 * A hosting action answers 202 once the operation is queued; whether it worked is only known when it ends.
 * `watch` the operation a request returned, and feed every refreshed operation to `observe`: a watched one that
 * ended raises an error toast with the operation's message, or a success toast, once.
 */
export function useHostingOperationOutcome() {
  const watched = useRef(new Set<string>());
  const settle = useCallback((operation: OutcomeOperation) => {
    if (!watched.current.has(operation.id)) return;
    const title = hostingActionTitle(operation.action);
    if (operation.phase === "failed") toast.error(operation.errorMessage || `${title} failed`);
    else if (operation.phase === "ready") toast.success(`${title} finished`);
    else return;
    watched.current.delete(operation.id);
  }, []);
  const watch = useCallback(
    (operation: OutcomeOperation) => {
      watched.current.add(operation.id);
      settle(operation);
    },
    [settle]
  );
  const observe = useCallback(
    (operations: OutcomeOperation[]) => {
      for (const operation of operations) settle(operation);
    },
    [settle]
  );
  return { watch, observe };
}
