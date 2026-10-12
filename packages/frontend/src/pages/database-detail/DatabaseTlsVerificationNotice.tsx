import { useState } from "react";
import { toast } from "sonner";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";

/** An external TLS connection saved before verification existed, or explicitly opted out. */
export function hasUnverifiedTls(database: DatabaseConnection) {
  return !database.managed && database.tlsEnabled && database.tlsVerifyCertificate === false;
}

export function DatabaseTlsVerificationNotice({
  database,
  canEdit,
  onVerified,
  onOpenSettings,
}: {
  database: DatabaseConnection;
  canEdit: boolean;
  onVerified: (database: DatabaseConnection) => void;
  onOpenSettings: () => void;
}) {
  const [verifying, setVerifying] = useState(false);

  if (!hasUnverifiedTls(database)) return null;

  // The backend tests the connection with verification before saving it, so a
  // certificate that cannot be verified leaves the connection unchanged.
  const enableVerification = async () => {
    setVerifying(true);
    try {
      const updated = await api.updateDatabase(database.id, {
        config: { tlsVerifyCertificate: true },
      });
      toast.success("Certificate verified. Verification is now enabled.");
      onVerified(updated);
    } catch (error) {
      toastApiError(error, "The server certificate could not be verified");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Notice
      tone="warning"
      title="TLS certificate is not verified"
      actions={
        canEdit ? (
          <>
            <NoticeAction tone="warning" onClick={onOpenSettings} disabled={verifying}>
              Add CA certificate
            </NoticeAction>
            <NoticeAction
              tone="warning"
              onClick={() => void enableVerification()}
              pending={verifying}
            >
              Test and enable verification
            </NoticeAction>
          </>
        ) : undefined
      }
    >
      <p>
        The connection is encrypted, but Opfield does not check the server identity, so the database
        could be impersonated on the network path.
      </p>
    </Notice>
  );
}
