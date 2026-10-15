import { Badge } from "@/components/ui/badge";
import type { InferenceProviderConnection } from "@/types/inference";

export function HealthBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "healthy"
          ? "success"
          : status === "quota_hot" || status === "stale" || status === "cooldown"
            ? "warning"
            : status === "unavailable" || status === "reauth_required"
              ? "destructive"
              : "secondary"
      }
      size="inline"
    >
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

/** The Opfield Cloud add-on's busiest window, as its usage shows it ("40% used"). */
export function formatCloudUsage(connection: InferenceProviderConnection) {
  const windows = connection.cloudUsage?.windows ?? [];
  if (!windows.length) return "Not reported";
  return `${Math.round(Math.max(...windows.map((window) => window.usedPercent)))}% used`;
}

/** Window names of the Opfield Cloud usage ("5h", "30d") as Settings shows them. */
export function cloudUsageWindowLabel(window: string) {
  return window === "5h" ? "5 hours" : window === "30d" ? "30 days" : window;
}

export function formatWorstQuota(connections: InferenceProviderConnection[]) {
  const cloud = connections.find((connection) => connection.cloudManaged);
  if (cloud) return formatCloudUsage(cloud);
  const apiBudget = connections.find(
    (connection) => connection.apiMonthlyLimitMicrodollars !== null
  );
  if (
    apiBudget?.apiMonthlyLimitMicrodollars !== null &&
    apiBudget?.apiMonthlyLimitMicrodollars !== undefined
  ) {
    return `${formatUsd(apiBudget.apiMonthlySpentMicrodollars)} / ${formatUsd(apiBudget.apiMonthlyLimitMicrodollars)}`;
  }
  const providerBalances = connections
    .flatMap((connection) => connection.quota)
    .filter((quota) => quota.remainingValue != null || quota.limitValue != null);
  const providerBalance = providerBalances.reduce<(typeof providerBalances)[number] | undefined>(
    (worst, quota) => {
      if (!worst) return quota;
      if (quota.remainingFraction == null) return worst;
      if (worst.remainingFraction == null || quota.remainingFraction < worst.remainingFraction)
        return quota;
      return worst;
    },
    undefined
  );
  if (providerBalance) {
    const remaining = finiteUsd(providerBalance.remainingValue);
    const limit = finiteUsd(providerBalance.limitValue);
    if (remaining !== null && limit !== null)
      return `$${remaining.toFixed(2)} / $${limit.toFixed(2)}`;
    if (remaining !== null) return `$${remaining.toFixed(2)} remaining`;
    if (limit !== null) return `$${limit.toFixed(2)} total`;
  }
  const fractions = connections.flatMap((connection) =>
    connection.quota.flatMap((quota) =>
      quota.remainingFraction == null ? [] : [quota.remainingFraction]
    )
  );
  if (!fractions.length) return "Not reported";
  return `${Math.round(Math.min(...fractions) * 100)}% remaining`;
}

function formatUsd(microdollars: number) {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

function finiteUsd(value: string | null | undefined) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function connectionIdentity(connection: InferenceProviderConnection) {
  if (connection.accountLabel) return connection.accountLabel;
  if (connection.credential?.last4) return `•••• ${connection.credential.last4}`;
  return connection.authType.replaceAll("_", " ");
}
