import { Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { RouteIngressPlacementPanel } from "@/components/ingress-groups/RouteIngressPlacementPanel";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { nodeRoute } from "@/lib/resource-routes";
import { formatDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { NodeDetail, ProxyHost } from "@/types";

const HEALTH_BODY_MATCH_LABEL: Record<ProxyHost["healthCheckBodyMatchMode"], string> = {
  includes: "Includes",
  exact: "Exact Match",
  starts_with: "Starts With",
  ends_with: "Ends With",
};

export function DetailsTab({ host }: { host: ProxyHost }) {
  const navigate = useNavigate();
  const nodeId = host.nodeId ?? null;
  const shellNode = useUIBootstrapStore((state) =>
    state.snapshot?.navigation.nodes.data.find((node) => node.id === nodeId)
  );
  const cachedNode = useMemo(
    () =>
      nodeId
        ? api.getCached<{ data: NodeDetail }>(`req:/api/nodes/${nodeId}`, Number.POSITIVE_INFINITY)
            ?.data
        : undefined,
    [nodeId]
  );
  const initialNode = shellNode ?? cachedNode;
  const [nodeInfo, setNodeInfo] = useState<{
    id: string;
    slug: string;
    name: string;
    status: string;
    type: string;
  } | null>(() =>
    initialNode
      ? {
          id: initialNode.id,
          slug: initialNode.slug,
          name: initialNode.displayName || initialNode.hostname,
          status: initialNode.status,
          type: initialNode.type,
        }
      : null
  );
  const [nodeLoadComplete, setNodeLoadComplete] = useState(!nodeId || Boolean(initialNode));
  useContentLoading(!nodeLoadComplete);

  useEffect(() => {
    if (!nodeId) {
      setNodeInfo(null);
      setNodeLoadComplete(true);
      return;
    }
    if (shellNode) {
      setNodeInfo({
        id: shellNode.id,
        slug: shellNode.slug,
        name: shellNode.displayName || shellNode.hostname,
        status: shellNode.status,
        type: shellNode.type,
      });
      setNodeLoadComplete(true);
    } else if (!cachedNode) {
      setNodeInfo(null);
      setNodeLoadComplete(false);
    }
    api
      .getNode(nodeId)
      .then((n) =>
        setNodeInfo({
          id: n.id,
          slug: n.slug,
          name: n.displayName || n.hostname,
          status: n.status,
          type: n.type,
        })
      )
      .catch(() => {})
      .finally(() => setNodeLoadComplete(true));
  }, [cachedNode, nodeId, shellNode]);

  return (
    <div className="space-y-4">
      {/* Node Card */}
      {nodeInfo && (
        <PanelShell
          className="cursor-pointer transition-colors hover:bg-accent"
          bodyClassName="flex items-center justify-between p-4"
          onClick={() => navigate(nodeRoute(nodeInfo.slug))}
        >
          <div className="flex items-center gap-3">
            <Server className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{nodeInfo.name}</p>
              <p className="text-xs text-muted-foreground">
                {host.ingressGroupId ? "First active member of the ingress group" : "Ingress node"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="uppercase">
              {nodeInfo.type}
            </Badge>
            <Badge
              variant={
                nodeInfo.status === "online"
                  ? "success"
                  : nodeInfo.status === "offline" || nodeInfo.status === "error"
                    ? "destructive"
                    : "warning"
              }
              className="uppercase"
            >
              {nodeInfo.status}
            </Badge>
          </div>
        </PanelShell>
      )}

      <RouteIngressPlacementPanel host={host} onChanged={() => undefined} />

      {/* Host Info + Health Check in one row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Host Info Card */}
        <PanelShell
          title="Route Information"
          className={!host.healthCheckEnabled ? "md:col-span-2" : ""}
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Domains"
            value={
              <div className="flex flex-wrap justify-end gap-1">
                {host.domainNames.map((d) => (
                  <Link key={d} to={`/routes/domains?domain=${encodeURIComponent(d)}`} title={d}>
                    <Badge variant="info">{d}</Badge>
                  </Link>
                ))}
              </div>
            }
          />
          {host.type === "proxy" && (
            <DetailRow
              label="Forward Target"
              value={<ProxyUpstreamTarget host={host} linkToResource />}
            />
          )}
          {host.type === "redirect" && host.redirectUrl && (
            <DetailRow
              label="Redirect URL"
              value={`${host.redirectUrl} (${host.redirectStatusCode})`}
            />
          )}
          <DetailRow label="Created" value={<RelativeTime value={host.createdAt} />} />
          <DetailRow label="Updated" value={<RelativeTime value={host.updatedAt} />} />
        </PanelShell>

        {/* Health Check Status Card */}
        {host.healthCheckEnabled && (
          <PanelShell
            title="Health Check"
            bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
          >
            <DetailRow label="URL Path" value={host.healthCheckUrl || "/"} />
            <DetailRow label="Interval" value={`${host.healthCheckInterval || 30}s`} />
            <DetailRow
              label="Expected Status"
              value={
                host.healthCheckExpectedStatus ? String(host.healthCheckExpectedStatus) : "Any 2xx"
              }
            />
            {host.healthCheckExpectedBody && (
              <DetailRow
                label="Expected Body"
                value={`${HEALTH_BODY_MATCH_LABEL[host.healthCheckBodyMatchMode || "includes"]}: ${host.healthCheckExpectedBody}`}
              />
            )}
            {host.lastHealthCheckAt && (
              <DetailRow
                label="Last Check"
                value={<RelativeTime value={host.lastHealthCheckAt} />}
              />
            )}
          </PanelShell>
        )}
      </div>

      {/* SSL Certificate Info (when SSL enabled) */}
      {host.sslEnabled && host.sslCertificate && (
        <PanelShell
          title="SSL Certificate"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Name"
            value={
              <Link to={`/certificates?certificate=${host.sslCertificate.id}`}>
                <Badge variant="info">{host.sslCertificate.name}</Badge>
              </Link>
            }
          />
          <DetailRow
            label="Type"
            value={<Badge variant="secondary">{host.sslCertificate.type}</Badge>}
          />
          <DetailRow
            label="Status"
            value={
              <Badge variant={host.sslCertificate.status === "active" ? "success" : "destructive"}>
                {host.sslCertificate.status}
              </Badge>
            }
          />
          {host.sslCertificate.notAfter && (
            <DetailRow label="Expires" value={formatDate(host.sslCertificate.notAfter)} />
          )}
        </PanelShell>
      )}

      {/* A PKI certificate attached directly (API/MCP internalCertificateId) serves while no SSL certificate is set */}
      {host.sslEnabled && !host.sslCertificate && host.internalCertificate && (
        <PanelShell
          title="SSL Certificate"
          bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
        >
          <DetailRow
            label="Name"
            value={
              <Link to={`/certificates/${host.internalCertificate.id}`}>
                <Badge variant="info">{host.internalCertificate.commonName}</Badge>
              </Link>
            }
          />
          <DetailRow label="Type" value={<Badge variant="secondary">PKI</Badge>} />
          <DetailRow
            label="Status"
            value={
              <Badge
                variant={host.internalCertificate.status === "active" ? "success" : "destructive"}
              >
                {host.internalCertificate.status}
              </Badge>
            }
          />
          <DetailRow label="Expires" value={formatDate(host.internalCertificate.notAfter)} />
        </PanelShell>
      )}
    </div>
  );
}
