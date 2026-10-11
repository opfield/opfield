import { Award, Globe, Lock, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { StatCard } from "@/components/ui/stat-card";
import type { DashboardStats, Node } from "@/types";

function StatLink({
  href,
  title,
  value,
  icon,
  subtitle,
}: {
  href: string;
  title: string;
  value: number;
  icon: React.ElementType;
  subtitle: string;
}) {
  return (
    <Link to={href} className="block">
      <StatCard
        appearance="dashboard"
        label={title}
        value={String(value)}
        icon={icon}
        subtitle={subtitle}
        className="h-full transition-colors hover:bg-accent"
      />
    </Link>
  );
}

interface QuickStatsCardProps {
  displayStats: DashboardStats;
  nodesList: Node[];
  /**
   * Any grant of the scope base (broad, resource, folder or node). The server scopes the counts to
   * what the caller can see, so a folder-scoped user gets the stats of their folder.
   */
  hasScopedAccess: (scopeBase: string) => boolean;
  pkiEnabled?: boolean;
}

export function QuickStatsCard({
  displayStats,
  nodesList,
  hasScopedAccess: hasScope,
  pkiEnabled = true,
}: QuickStatsCardProps) {
  if (
    !hasScope("proxy:view") &&
    !hasScope("ssl:cert:view") &&
    !(pkiEnabled && hasScope("pki:cert:view")) &&
    !hasScope("nodes:details")
  ) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
      {hasScope("proxy:view") && (
        <StatLink
          title="Routes"
          value={displayStats.proxyHosts.total}
          icon={Globe}
          subtitle={`${displayStats.proxyHosts.online} online, ${displayStats.proxyHosts.offline} offline`}
          href="/routes"
        />
      )}
      {hasScope("ssl:cert:view") && (
        <StatLink
          title="SSL Certificates"
          value={displayStats.sslCertificates.total}
          icon={Lock}
          subtitle={
            displayStats.sslCertificates.expiringSoon > 0
              ? `${displayStats.sslCertificates.expiringSoon} expiring soon`
              : "All certificates valid"
          }
          href="/certificates"
        />
      )}
      {pkiEnabled && hasScope("pki:cert:view") && (
        <StatLink
          title="PKI Certificates"
          value={displayStats.pkiCertificates.active}
          icon={Award}
          subtitle={`${displayStats.pkiCertificates.total} total`}
          href="/certificates/pki"
        />
      )}
      {hasScope("nodes:details") && (
        <StatLink
          title="Nodes"
          value={nodesList.filter((n) => n.status === "online").length}
          icon={Server}
          subtitle={`${nodesList.length} registered`}
          href="/nodes"
        />
      )}
    </div>
  );
}
