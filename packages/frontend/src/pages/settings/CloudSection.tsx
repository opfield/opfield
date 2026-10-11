import { Cloud, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm, confirmAction } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";
import type { CloudLinkStatusView } from "@/types";

const CACHE_KEY = "settings:cloud-link-status";
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

const REMOTE_MANAGEMENT_HINT = "Lets your cloud account add nodes and start updates.";

function RemoteManagementRow({
  remoteManagement,
  canManage,
  saving,
  onChange,
}: {
  remoteManagement: { managed: boolean; enabled: boolean };
  canManage: boolean;
  saving: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsControlRow
      title={<span id="cloud-remote-management-label">Allow remote management</span>}
      description={<span id="cloud-remote-management-hint">{REMOTE_MANAGEMENT_HINT}</span>}
    >
      {remoteManagement.managed ? (
        <Badge variant="info">Managed by the cloud</Badge>
      ) : (
        <Switch
          checked={remoteManagement.enabled}
          onChange={onChange}
          disabled={!canManage || saving}
          ariaLabelledBy="cloud-remote-management-label"
          ariaDescribedBy="cloud-remote-management-hint"
        />
      )}
    </SettingsControlRow>
  );
}

interface CloudSectionProps {
  canManage: boolean;
}

export function CloudSection({ canManage }: CloudSectionProps) {
  const [status, setStatus] = useState<CloudLinkStatusView | null>(
    () => api.getCached<CloudLinkStatusView>(CACHE_KEY) ?? null
  );
  const [loading, setLoading] = useState(
    () => api.getCached<CloudLinkStatusView>(CACHE_KEY) === undefined
  );
  const [code, setCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingRemoteManagement, setSavingRemoteManagement] = useState(false);

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

  // The link changes on its own (a disconnect from the account): follow it while shown.
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

  const saveRemoteManagement = async (enabled: boolean) => {
    setSavingRemoteManagement(true);
    try {
      applyStatus(await api.setCloudRemoteManagement(enabled));
      toast.success(enabled ? "Remote management allowed" : "Remote management turned off");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change remote management");
      return false;
    } finally {
      setSavingRemoteManagement(false);
    }
  };

  // Turning it on hands actions to the cloud account, so it is confirmed; turning it off is not.
  const handleRemoteManagement = (enabled: boolean) => {
    if (!enabled) {
      void saveRemoteManagement(false);
      return;
    }
    void confirmAction(
      {
        title: "Allow remote management",
        description:
          "Your cloud account will be able to enrol nodes, start Opfield updates and issue a first-admin setup code. You can turn this off at any time.",
        confirmLabel: "Allow",
        variant: "default",
      },
      () => saveRemoteManagement(true)
    );
  };

  const handleDisconnect = async () => {
    const ok = await confirm({
      title: "Disconnect from Cloud",
      description:
        "Disconnect this Opfield installation from your cloud account? The account will no longer see its state or logs until you connect it again with a new code.",
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
      className="flex items-center gap-2"
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
        className="w-36 font-mono"
      />
      <Button type="submit" pending={connecting} disabled={!normalizedCode}>
        <Cloud className="h-4 w-4" />
        {disconnectedByAccount ? "Connect again" : "Connect"}
      </Button>
    </form>
  ) : null;

  const askAdministrator = canManage ? null : (
    <> Ask an administrator who manages the license to connect this Opfield installation.</>
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
            : "Connect this Opfield installation to your cloud account"
      }
      className="xl:col-span-2"
      style={{ borderColor: "var(--color-info)" }}
      actions={
        connected ? (
          canManage ? (
            <Button variant="outline" onClick={handleDisconnect} pending={disconnecting}>
              <Unplug className="h-4 w-4" />
              Disconnect
            </Button>
          ) : null
        ) : (
          codeForm
        )
      }
    >
      {connected && (
        <div className="divide-y divide-border">
          <DetailRow label="Account" value={status.accountEmail ?? "—"} />
          <DetailRow
            label="Connected since"
            value={<RelativeTime value={status.connectedSince} />}
          />
          {status.remoteManagement && (
            <RemoteManagementRow
              remoteManagement={status.remoteManagement}
              canManage={canManage}
              saving={savingRemoteManagement}
              onChange={handleRemoteManagement}
            />
          )}
        </div>
      )}

      {disconnectedByAccount && (
        <div className="divide-y divide-border">
          <p className="p-4 text-sm text-muted-foreground">
            {status.disconnectedReason ??
              "Your cloud account disconnected this Opfield installation."}{" "}
            To connect it again, create a new code on this installation's page in your cloud
            account.
            {askAdministrator}
          </p>
          {status.accountEmail && <DetailRow label="Account" value={status.accountEmail} />}
          <DetailRow label="Disconnected" value={<RelativeTime value={status.disconnectedAt} />} />
        </div>
      )}

      {!connected && !disconnectedByAccount && (
        <p className="p-4 text-sm text-muted-foreground">
          A connected Opfield keeps one outbound connection to your cloud account, so the account
          can show this installation's state and container logs. Open this installation in your
          cloud account, press Connect, and enter the code it shows.
          {askAdministrator}
        </p>
      )}
    </PanelShell>
  );
}
