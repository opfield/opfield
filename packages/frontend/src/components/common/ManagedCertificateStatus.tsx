import { useCallback, useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { Notice, NoticeAction } from "@/components/common/Notice";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { ManagedCertificateStatus as ManagedCertificateStatusView } from "@/types";

/** One line of what the automatic renewal is doing, or null when nothing needs saying. */
export function describeCertificateRenewal(
  status: ManagedCertificateStatusView
): { tone: "info" | "warning"; text: string } | null {
  const { renewal } = status;
  const next = renewal.nextAttemptAt
    ? ` Next attempt ${formatDateTime(renewal.nextAttemptAt)}.`
    : "";
  switch (renewal.state) {
    case "failed":
      return {
        tone: "warning",
        text: `Automatic renewal failed${renewal.attempts > 1 ? ` (${renewal.attempts} attempts)` : ""}: ${renewal.lastError ?? "unknown error"}.${next}`,
      };
    case "ca_limited":
      return {
        tone: "warning",
        text:
          renewal.lastError ??
          "The issuing CA expires before a renewed certificate would; renew or replace the CA.",
      };
    case "waiting_for_daemon":
      return {
        tone: "warning",
        text: "Renewal is waiting for the node daemon to be updated, so the certificate can be reloaded without a restart. A restart is used only once 7 days or less remain.",
      };
    case "awaiting_reload":
    case "delivering":
      return {
        tone: "info",
        text: `A renewed certificate was delivered; the service loads it on its own schedule and Opfield confirms it.${next}`,
      };
    default:
      if (renewal.due && renewal.skipReason)
        return {
          tone: "info",
          text: `Renewal is due and runs once the service is available again (${renewal.skipReason.replaceAll("_", " ")}).`,
        };
      if (renewal.due) return { tone: "info", text: "Renewal is due and runs within the hour." };
      return null;
  }
}

/** Days before expiry from which a certificate needs attention (matches the backend summary). */
const ATTENTION_BEFORE_EXPIRY_DAYS = 7;

export type CertificateAttention =
  | "renewal_failed"
  | "ca_limited"
  | "waiting_for_daemon"
  | "awaiting_reload"
  | "expiring";

/** Why the certificate needs someone to look at it, or null while it renews on its own. */
export function certificateAttention(
  status: ManagedCertificateStatusView | null
): CertificateAttention | null {
  if (!status?.certificate) return null;
  switch (status.renewal.state) {
    case "failed":
      return "renewal_failed";
    case "ca_limited":
      return "ca_limited";
    case "waiting_for_daemon":
      return "waiting_for_daemon";
    case "awaiting_reload":
      return "awaiting_reload";
    default:
      return status.certificate.daysRemaining <= ATTENTION_BEFORE_EXPIRY_DAYS ? "expiring" : null;
  }
}

function daysLabel(days: number) {
  if (days <= 0) return "today";
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Notice title for a certificate that needs attention. */
export function certificateAttentionTitle(attention: CertificateAttention, daysRemaining: number) {
  switch (attention) {
    case "renewal_failed":
      return "TLS certificate renewal failed";
    case "ca_limited":
      return "TLS certificate renewal is limited by its CA";
    case "waiting_for_daemon":
      return "TLS certificate renewal is waiting for the node daemon";
    case "awaiting_reload":
      return "Renewed TLS certificate is not loaded yet";
    case "expiring":
      return `TLS certificate expires ${daysLabel(daysRemaining)}`;
  }
}

/**
 * Loads the TLS certificate status of a managed storage cluster or managed
 * database. `loading` is true until the first answer while enabled; a
 * resource without TLS (or an older Gateway) answers with no status.
 */
export function useManagedCertificateStatus(
  load: () => Promise<ManagedCertificateStatusView>,
  { enabled, refreshKey }: { enabled: boolean; refreshKey?: unknown }
) {
  const [status, setStatus] = useState<ManagedCertificateStatusView | null>(null);
  const [settled, setSettled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await load());
    } catch {
      // TLS off, no permission, or an older Gateway: nothing to show.
      setStatus(null);
    } finally {
      setSettled(true);
    }
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads the status when the owning resource changes.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh, refreshKey]);

  return {
    status: enabled ? status : null,
    // Only the first load holds the page; later refreshes update in place.
    loading: enabled && !settled,
    refresh,
  };
}

/**
 * Warning notice for a managed certificate that needs attention: renewal
 * failed, 7 days or less left, a delivered certificate not loaded yet, a
 * renewal waiting for the node daemon or limited by its CA. Renders nothing
 * while the certificate renews on its own.
 */
export function ManagedCertificateNotice({
  status,
  onRenew,
  onRenewed,
  renewLabel = "Renew now",
}: {
  status: ManagedCertificateStatusView | null;
  /** Shown as an action when set (the caller checks permissions and confirms). */
  onRenew?: () => Promise<boolean>;
  /** Called after a renewal request, to reload the status. */
  onRenewed?: () => Promise<void> | void;
  renewLabel?: string;
}) {
  const [renewing, setRenewing] = useState(false);
  const attention = certificateAttention(status);
  if (!status?.certificate || !attention) return null;
  const { certificate } = status;
  const note = describeCertificateRenewal(status);

  const renew = async () => {
    if (!onRenew) return;
    setRenewing(true);
    try {
      if (await onRenew()) await onRenewed?.();
    } finally {
      setRenewing(false);
    }
  };

  return (
    <Notice
      tone="warning"
      role="status"
      title={certificateAttentionTitle(attention, certificate.daysRemaining)}
      actions={
        onRenew ? (
          <NoticeAction tone="warning" onClick={() => void renew()} pending={renewing}>
            {renewLabel}
          </NoticeAction>
        ) : undefined
      }
    >
      <p>
        {note ? `${note.text} ` : ""}
        The current certificate expires {formatDate(certificate.notAfter)}.
      </p>
    </Notice>
  );
}

/**
 * The certificate's expiry as a quiet row of the resource's details, for
 * example "Expires Mar 12, 2027 · renewed automatically".
 */
export function ManagedCertificateDetailRow({
  status,
}: {
  status: ManagedCertificateStatusView | null;
}) {
  if (!status?.certificate) return null;
  const attention = certificateAttention(status);
  return (
    <DetailRow
      label="TLS Certificate"
      value={
        <span className="text-muted-foreground">
          Expires {formatDate(status.certificate.notAfter)} ·{" "}
          {attention ? "needs attention" : "renewed automatically"}
        </span>
      }
    />
  );
}
