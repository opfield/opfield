import { Link } from "react-router-dom";
import { Notice } from "@/components/common/Notice";
import { databaseRoute, storageRoute } from "@/lib/resource-routes";
import type { DashboardAvailabilityAttention } from "@/types";

function reasonLabel(item: DashboardAvailabilityAttention) {
  switch (item.reason) {
    case "primary_unreachable":
      return "primary not reachable";
    case "no_failover":
      return "no automatic failover";
    case "witness_lost":
      return "witness lost";
    case "degraded":
      return "degraded";
    case "failover":
      return "failed over";
  }
}

/**
 * Dashboard notice for databases and storage on several servers that need a look: a pair whose primary is gone or a
 * set that cannot fail over (destructive), a lost witness, a degraded set or a failover in the last day (warning).
 * Each row links to its resource.
 */
export function ManagedAvailabilityNotice({
  items,
}: {
  items: readonly DashboardAvailabilityAttention[];
}) {
  if (items.length === 0) return null;
  const critical = items.some(
    (item) => item.reason === "no_failover" || item.reason === "primary_unreachable"
  );
  return (
    <Notice
      tone={critical ? "destructive" : "warning"}
      role={critical ? "alert" : "status"}
      title={
        items.length === 1
          ? "A database or storage on several servers needs a look"
          : `${items.length} databases or storages on several servers need a look`
      }
    >
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="min-w-0">
            <Link
              to={item.kind === "storage" ? storageRoute(item.slug) : databaseRoute(item.slug)}
              className="font-medium text-link hover:underline"
            >
              {item.name}
            </Link>
            <span>
              {" "}
              · {reasonLabel(item)}
              {item.message ? `: ${item.message}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
