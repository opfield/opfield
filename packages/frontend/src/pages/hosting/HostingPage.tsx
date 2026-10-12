import { useCallback, useState } from "react";
import { NodeEnrollmentDialog } from "@/components/nodes/NodeEnrollmentDialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import type { HostingOperation, HostingResource } from "@/types/hosting";
import { HostingIntegrationDetail } from "./HostingIntegrationDetail";

/** Route-level state only; the account page and installer use existing product shells. */
export function HostingPage() {
  const [request, setRequest] = useState<{
    connectorId: string;
    resource?: HostingResource;
  } | null>(null);
  const shownRequest = useRetainedDialogValue(request, request !== null);
  const [acceptedOperations, setAcceptedOperations] = useState<HostingOperation[]>([]);
  const onAccepted = useCallback((operation: HostingOperation) => {
    setAcceptedOperations((current) => [
      ...current.filter((item) => item.id !== operation.id),
      operation,
    ]);
  }, []);
  return (
    <>
      <HostingIntegrationDetail
        acceptedOperations={acceptedOperations}
        onCreate={(connectorId) => setRequest({ connectorId })}
        onInstall={(connectorId, resource) => setRequest({ connectorId, resource })}
      />
      <NodeEnrollmentDialog
        onHostingCreated={onAccepted}
        open={!!request}
        initialMode="hosting"
        hosting={{
          connectorId: shownRequest?.connectorId,
          existingResource: shownRequest?.resource,
        }}
        onOpenChange={(open) => {
          if (open) return;
          setRequest(null);
        }}
      />
    </>
  );
}
