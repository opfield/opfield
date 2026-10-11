import { Globe } from "lucide-react";
import { Link } from "react-router-dom";
import { proxyHealthTone } from "@/components/common/resource-status";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { proxyHostRoute } from "@/lib/resource-routes";
import { HEALTH_LABEL } from "@/pages/proxy-detail/helpers";
import type { ProxyHost } from "@/types";

interface PinnedProxyCardProps {
  proxy: ProxyHost;
}

export function PinnedProxyCard({ proxy }: PinnedProxyCardProps) {
  const eff = proxy.effectiveHealthStatus ?? proxy.healthStatus;
  const statusLabel = HEALTH_LABEL[eff] ?? eff;

  return (
    <Link
      to={proxyHostRoute(proxy.slug)}
      className="flex items-center justify-between border border-border bg-card px-4 py-3 hover:bg-accent transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{proxy.domainNames[0]}</p>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {proxy.domainNames.length > 1 ? (
              <span className="truncate">+{proxy.domainNames.length - 1} more</span>
            ) : null}
            {proxy.type === "proxy" ? <ProxyUpstreamTarget host={proxy} size="inline" /> : null}
            {proxy.type === "redirect" && proxy.redirectUrl
              ? `${proxy.domainNames.length > 1 ? " · " : ""}→ ${proxy.redirectUrl}`
              : null}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="secondary" size="inline">
          {proxy.type}
        </Badge>
        <Badge variant={proxyHealthTone(eff)} size="inline">
          {statusLabel}
        </Badge>
      </div>
    </Link>
  );
}
