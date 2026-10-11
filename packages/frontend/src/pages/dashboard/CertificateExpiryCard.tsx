import { Link } from "react-router-dom";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Badge } from "@/components/ui/badge";
import { cn, formatDate, formatTimeLeft } from "@/lib/utils";

export interface ExpiringItem {
  id: string;
  name: string;
  type: "ca" | "pki" | "ssl";
  expiresAt: string;
  daysLeft: number;
}

interface CertificateExpiryCardProps {
  /**
   * Already scoped by the server to certificates the caller can see. Every item is also counted by the
   * server's expiry notices, so the card shows them all.
   */
  expiringItems: ExpiringItem[];
}

export function CertificateExpiryCard({ expiringItems: visible }: CertificateExpiryCardProps) {
  if (visible.length === 0) return null;

  return (
    <div className="border border-warning/60 bg-card">
      <SectionHeader
        title="Expiring Soon"
        actions={<Badge variant="warning-solid">{visible.length}</Badge>}
        className="text-warning-text"
      />
      <div className="divide-y">
        {[...visible]
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .map((item) => (
            <Link
              key={`${item.type}-${item.id}`}
              to={
                item.type === "ca"
                  ? `/cas/${item.id}`
                  : item.type === "pki"
                    ? `/certificates/${item.id}`
                    : "/ssl-certificates"
              }
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <span className="text-sm font-medium truncate flex-1">{item.name}</span>
              <Badge variant="secondary" size="inline">
                {item.type === "ca" ? "CA" : item.type === "pki" ? "PKI" : "SSL"}
              </Badge>
              <span className="text-xs text-muted-foreground">{formatDate(item.expiresAt)}</span>
              <span
                className={cn(
                  "text-xs font-medium",
                  "text-warning-foreground",
                  item.daysLeft <= 7 && "font-semibold"
                )}
              >
                {formatTimeLeft(item.expiresAt)}
              </span>
            </Link>
          ))}
      </div>
    </div>
  );
}
