import { Cloud, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { CloudLinkStatusView, CloudRequestSummary, CloudSocketState } from "@/types";

const CACHE_KEY = "settings:cloud-link-status";
/** The audit log filtered to the cloud link's entries (connects, disconnects, every request it served). */
const CLOUD_AUDIT_LOG_PATH = "/administration/audit?resource=cloud-link";
const POLL_INTERVAL_MS = 10_000;
/** Code alphabet of the cloud account: A–Z without I and O, digits 2–9. */
const CODE_ALPHABET = /^[A-HJ-NP-Z2-9]{8}$/;

/** `CLD-7K3M-Q9TX`, `7K3M-Q9TX` or `7k3mq9tx` as `CLD-XXXX-XXXX`; null when it is not a code. */
function normalizeCloudCode(input: string): string | null {
  let compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length === 11 && compact.startsWith("CLD")) compact = compact.slice(3);
  if (!CODE_ALPHABET.test(compact)) return null;
  return `CLD-${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function socketBadge(state: CloudSocketState) {
  if (state === "online") return <Badge variant="success">Online</Badge>;
  if (state === "reconnecting") return <Badge variant="warning">Reconnecting</Badge>;
  return <Badge variant="secondary">Connecting</Badge>;
}

function PortalLink({ url }: { url: string }) {
  return (
    <Button asChild variant="link" size="inline">
      <a href={url} target="_blank" rel="noreferrer">
        {url.replace(/^https?:\/\//, "")}
      </a>
    </Button>
  );
}

function RecentRequests({
  requests,
  canViewAudit,
}: {
  requests: CloudRequestSummary[];
  canViewAudit: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4 px-4 pt-3 pb-1">
        <span className="text-sm text-muted-foreground">Last requests</span>
        {canViewAudit && (
          <Button asChild variant="link" size="inline">
            <Link to={CLOUD_AUDIT_LOG_PATH}>All in the audit log</Link>
          </Button>
        )}
      </div>
      {requests.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">
          Your cloud account has not read anything yet.
        </p>
      ) : (
        <ul className="pb-1">
          {requests.map((request, index) => (
            <li
              key={`${request.at}-${index}`}
              className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-center gap-4 px-4 py-2 text-sm md:grid-cols-[10rem_minmax(0,1fr)_auto]"
            >
              <RelativeTime value={request.at} className="text-muted-foreground" />
              <span className="min-w-0 truncate" title={request.error ?? undefined}>
                <span className="font-mono text-xs">{request.type}</span>
                {request.service && (
                  <span className="text-muted-foreground"> · {request.service}</span>
                )}
                {request.count > 1 && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {request.count}×
                    {request.lastAt && (
                      <>
                        , last <RelativeTime value={request.lastAt} />
                      </>
                    )}
                  </span>
                )}
                {!request.ok && request.error && (
                  <span className="text-muted-foreground"> · {request.error}</span>
                )}
              </span>
              {request.ok ? (
                <Badge variant="success">
                  {request.resultBytes !== null ? `OK · ${formatBytes(request.resultBytes)}` : "OK"}
                </Badge>
              ) : (
                <Badge variant="destructive">Error</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CloudSectionProps {
  canManage: boolean;
  canViewAudit: boolean;
}

export function CloudSection({ canManage, canViewAudit }: CloudSectionProps) {
  const [status, setStatus] = useState<CloudLinkStatusView | null>(
    () => api.getCached<CloudLinkStatusView>(CACHE_KEY) ?? null
  );
  const [loading, setLoading] = useState(
    () => api.getCached<CloudLinkStatusView>(CACHE_KEY) === undefined
  );
  const [code, setCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const applyStatus = useCallback((next: CloudLinkStatusView) => {
    const { warning: _warning, ...view } = next;
    api.setCache(CACHE_KEY, view);
    setStatus(view);
  }, []);

  const loadStatus = useCallback(
    async (quiet = false) => {
      try {
        applyStatus(await api.getCloudLinkStatus());
      } catch (err) {
        if (!quiet)
          toast.error(err instanceof Error ? err.message : "Failed to load the cloud status");
      } finally {
        setLoading(false);
      }
    },
    [applyStatus]
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The socket state changes on its own (reconnects, a disconnect from the account): follow it while shown.
  const linkState = status?.state;
  useEffect(() => {
    if (linkState !== "connected") return;
    const timer = setInterval(() => void loadStatus(true), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [linkState, loadStatus]);

  const normalizedCode = normalizeCloudCode(code);

  const handleConnect = async () => {
    if (!normalizedCode) return;
    setConnecting(true);
    try {
      const updated = await api.connectCloud(normalizedCode);
      applyStatus(updated);
      setCode("");
      toast.success(
        updated.accountEmail
          ? `Connected to ${updated.accountEmail}`
          : "Connected to your cloud account"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect to your cloud account");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    const ok = await confirm({
      title: "Disconnect from Cloud",
      description:
        "Disconnect this Gateway from your cloud account? The account will no longer see its state or logs until you connect it again with a new code.",
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!ok) return;
    setDisconnecting(true);
    try {
      const updated = await api.disconnectCloud();
      applyStatus(updated);
      if (updated.warning) toast.warning(updated.warning);
      else toast.success("Disconnected from your cloud account");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to disconnect from your cloud account"
      );
    } finally {
      setDisconnecting(false);
    }
  };

  useContentLoading(loading);
  if (loading || !status) return null;

  const connected = status.state === "connected";
  const disconnectedByAccount = status.state === "disconnected_by_account";

  const codeForm = canManage ? (
    <form
      className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        void handleConnect();
      }}
    >
      <Input
        id="cloud-connection-code"
        aria-label="Connection code"
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        onBlur={() => {
          if (normalizedCode) setCode(normalizedCode);
        }}
        placeholder="CLD-XXXX-XXXX"
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        className="font-mono sm:max-w-xs"
      />
      <Button type="submit" pending={connecting} disabled={!normalizedCode}>
        <Cloud className="h-4 w-4" />
        {disconnectedByAccount ? "Connect again" : "Connect"}
      </Button>
    </form>
  ) : (
    <p className="p-4 text-sm text-muted-foreground">
      Ask an administrator who manages the license to connect this Gateway.
    </p>
  );

  return (
    <PanelShell
      icon={<Cloud className="h-4 w-4 text-info-text" />}
      id="gateway-cloud"
      title={<span className="text-info-text">Cloud</span>}
      description={
        connected
          ? `Connected to ${status.accountEmail ?? "your cloud account"}`
          : disconnectedByAccount
            ? "Disconnected by the account"
            : "Connect this Gateway to your cloud account"
      }
      className="xl:col-span-2"
      style={{ borderColor: "var(--color-info)" }}
      actions={
        connected && canManage ? (
          <Button variant="outline" onClick={handleDisconnect} pending={disconnecting}>
            <Unplug className="h-4 w-4" />
            Disconnect
          </Button>
        ) : null
      }
    >
      {connected && (
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          <DetailRow label="Account" value={status.accountEmail ?? "—"} />
          <DetailRow label="Portal" value={<PortalLink url={status.portalUrl} />} />
          <DetailRow
            label="Connected since"
            value={<RelativeTime value={status.connectedSince} />}
          />
          <DetailRow
            label="Connection"
            value={status.socket ? socketBadge(status.socket.state) : socketBadge("connecting")}
          />
          {status.socket?.state === "reconnecting" && status.socket.lastError && (
            <DetailRow label="Last error" value={status.socket.lastError} />
          )}
          <RecentRequests requests={status.recentRequests} canViewAudit={canViewAudit} />
        </div>
      )}

      {disconnectedByAccount && (
        <>
          <div className="border-b border-border p-4">
            <p className="text-sm text-muted-foreground">
              {status.disconnectedReason ?? "Your cloud account disconnected this Gateway."} To
              connect it again, create a new code on this installation's page in your cloud account.
            </p>
          </div>
          <div className="divide-y divide-border border-b border-border">
            {status.accountEmail && <DetailRow label="Account" value={status.accountEmail} />}
            <DetailRow
              label="Disconnected"
              value={<RelativeTime value={status.disconnectedAt} />}
            />
          </div>
          {codeForm}
        </>
      )}

      {!connected && !disconnectedByAccount && (
        <>
          <div className="border-b border-border p-4">
            <p className="text-sm text-muted-foreground">
              A connected Gateway keeps one outbound connection to your cloud account, so the
              account can show this Gateway's state and container logs. Open this installation in
              your cloud account, press Connect, and enter the code it shows.
            </p>
          </div>
          {codeForm}
        </>
      )}
    </PanelShell>
  );
}
