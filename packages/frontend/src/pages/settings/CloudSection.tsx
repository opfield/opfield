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
import { isLicenseDenial, toastApiError } from "@/lib/api-error-toast";
import { cn } from "@/lib/utils";
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
  /** Why the last Connect with this code failed, shown at the field. */
  const [codeError, setCodeError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [savingRemoteManagement, setSavingRemoteManagement] = useState(false);
  /** Connected and pasting a code from another account. */
  const [switching, setSwitching] = useState(false);

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
        if (!quiet) toastApiError(err, "Failed to load the cloud status");
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
    // A code from another account ends the current connection at once, so switching is confirmed.
    if (status?.state === "connected") {
      const ok = await confirm({
        title: "Connect to another account",
        description: `The connection to ${
          status.accountEmail ?? "your cloud account"
        } ends at once and this installation connects to the account the code is from.`,
        confirmLabel: "Connect",
        variant: "default",
      });
      if (!ok) return;
    }
    setConnecting(true);
    try {
      const updated = await api.connectCloud(normalizedCode);
      applyStatus(updated);
      setCode("");
      setSwitching(false);
      toast.success(
        updated.accountEmail
          ? `Connected to ${updated.accountEmail}`
          : "Connected to your cloud account"
      );
    } catch (err) {
      if (isLicenseDenial(err)) toastApiError(err, "Failed to connect to your cloud account");
      else
        setCodeError(
          err instanceof Error && err.message
            ? err.message
            : "Failed to connect to your cloud account"
        );
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
      toastApiError(err, "Failed to change remote management");
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
      toastApiError(err, "Failed to disconnect from your cloud account");
    } finally {
      setDisconnecting(false);
    }
  };

  useContentLoading(loading);
  if (loading || !status) return null;

  const connected = status.state === "connected";
  // A managed installation stays on its account: no Switch account or Disconnect.
  const managed = connected && status.remoteManagement?.managed === true;
  const disconnectedByAccount = status.state === "disconnected_by_account";

  // A typed value that is not a code says why Connect stays off; a refused code says why at the field.
  const codeMessage = !canManage
    ? null
    : codeError
      ? { text: codeError, error: true }
      : code.trim() && !normalizedCode
        ? { text: "A code looks like CLD-XXXX-XXXX: 8 letters and digits.", error: false }
        : null;
  const codeMessageLine =
    codeMessage && (!connected || switching) ? (
      <p
        id="cloud-connection-code-message"
        className={cn(
          "px-4 pt-4 text-sm",
          codeMessage.error ? "text-destructive" : "text-muted-foreground"
        )}
        role={codeMessage.error ? "alert" : undefined}
        aria-live="polite"
      >
        {codeMessage.text}
      </p>
    ) : null;

  // Without a body the header stands alone (no empty strip under its border).
  const showBody = Boolean(codeMessageLine) || connected || disconnectedByAccount || !canManage;

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
        onChange={(event) => {
          setCode(event.target.value.toUpperCase());
          setCodeError(null);
        }}
        onBlur={() => {
          if (normalizedCode) setCode(normalizedCode);
        }}
        placeholder="CLD-XXXX-XXXX"
        autoComplete="off"
        spellCheck={false}
        maxLength={16}
        className="w-36 font-mono"
        aria-invalid={codeError ? true : undefined}
        aria-describedby={codeMessage ? "cloud-connection-code-message" : undefined}
      />
      <Button type="submit" pending={connecting} disabled={!normalizedCode}>
        <Cloud className="h-4 w-4" />
        {disconnectedByAccount ? "Connect again" : "Connect"}
      </Button>
      {switching && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSwitching(false);
            setCode("");
            setCodeError(null);
          }}
        >
          Cancel
        </Button>
      )}
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
        managed
          ? `Managed by Opfield Cloud · connected to ${status.accountEmail ?? "your cloud account"}`
          : connected && switching
            ? "Paste the code from the other Opfield account and press Connect"
            : connected
              ? `Connected to ${status.accountEmail ?? "your cloud account"}`
              : disconnectedByAccount
                ? "Disconnected by the account"
                : "Paste the code from your Opfield account and press Connect"
      }
      className="xl:col-span-2"
      style={{ borderColor: "var(--color-info)" }}
      actions={
        managed ? null : connected ? (
          switching ? (
            codeForm
          ) : canManage ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setSwitching(true)}>
                <Cloud className="h-4 w-4" />
                Switch account
              </Button>
              <Button variant="outline" onClick={handleDisconnect} pending={disconnecting}>
                <Unplug className="h-4 w-4" />
                Disconnect
              </Button>
            </div>
          ) : null
        ) : (
          codeForm
        )
      }
    >
      {showBody ? (
        <>
          {codeMessageLine}
          {connected && !managed && switching && (
            <p className="px-4 pt-4 text-sm text-warning-text" role="status">
              Copy the code from the installation's page in the other Opfield account. Connecting
              with it ends the connection to {status.accountEmail ?? "your cloud account"} at once.
            </p>
          )}

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
                To connect it again, paste a new code from your Opfield account above.
                {askAdministrator}
              </p>
              {status.accountEmail && <DetailRow label="Account" value={status.accountEmail} />}
              <DetailRow
                label="Disconnected"
                value={<RelativeTime value={status.disconnectedAt} />}
              />
            </div>
          )}

          {/* The header already says to paste the code; only a reader without manage access gets a line. */}
          {!connected && !disconnectedByAccount && !canManage && (
            <p className="p-4 text-sm text-muted-foreground">
              Ask an administrator who manages the license to connect this Opfield installation.
            </p>
          )}
        </>
      ) : null}
    </PanelShell>
  );
}
