import { Gauge, Link2, RefreshCw, Trash2, WalletCards } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
  InferenceQuotaWindow,
} from "@/types/inference";
import { connectionIdentity, HealthBadge } from "./inference-provider-ui";

interface Props {
  open: boolean;
  connection: InferenceProviderConnection | null;
  provider: InferenceProviderCatalogItem | null;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}

const QUOTA_WINDOWS = [
  { dimension: "5h", label: "5 hours" },
  { dimension: "7d", label: "Weekly" },
  { dimension: "30d", label: "Monthly" },
] as const;

export function InferenceProviderDialog({
  open,
  connection,
  provider,
  canManage,
  onOpenChange,
  onChanged,
}: Props) {
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState("");
  const [routingStrategy, setRoutingStrategy] = useState<"even" | "balanced" | "sequential">(
    "balanced"
  );
  const [minimumRemainingPercent, setMinimumRemainingPercent] = useState("1");
  const [apiMonthlyLimitUsd, setApiMonthlyLimitUsd] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [retainedConnection, setRetainedConnection] = useState(connection);
  const [retainedProvider, setRetainedProvider] = useState(provider);
  const initializedDraftRef = useRef<string | null>(null);
  const displayedConnection = connection ?? retainedConnection;
  const displayedProvider = provider ?? retainedProvider;

  useEffect(() => {
    if (!connection) return;
    setRetainedConnection(connection);
    setRetainedProvider(provider);
  }, [connection, provider]);

  useEffect(() => {
    if (!open) {
      initializedDraftRef.current = null;
      return;
    }
    if (!connection || initializedDraftRef.current === connection.id) return;
    initializedDraftRef.current = connection.id;
    setName(connection.name);
    setEnabled(connection.enabled);
    setRoutingStrategy(connection.routingStrategy);
    setMinimumRemainingPercent(String(connection.minimumRemainingPercent));
    setApiMonthlyLimitUsd(formatUsdInput(connection.apiMonthlyLimitMicrodollars));
  }, [connection, open]);

  // close-reset-ok: the connection is retained once shown, so this is null only before the first opening
  if (!displayedConnection) return null;

  const subscription = displayedProvider?.subscription === true;
  const parsedMinimumRemainingPercent = parseMinimumRemainingPercent(minimumRemainingPercent);
  const minimumRemainingPercentValid = !subscription || parsedMinimumRemainingPercent !== undefined;
  const apiMonthlyLimitMicrodollars = parseUsdLimit(apiMonthlyLimitUsd);
  const apiMonthlyLimitValid = subscription || apiMonthlyLimitMicrodollars !== undefined;
  // Model-scoped windows (for example Anthropic's weekly Fable bucket) are separate limits,
  // not a worse reading of the account-wide window, so they get their own rows.
  const accountQuota = displayedConnection.quota.filter((window) => !window.modelBucket);
  const reportedQuotaWindows = QUOTA_WINDOWS.flatMap(({ dimension, label }) => {
    const quota = quotaForDimension(accountQuota, dimension);
    const scoped = displayedConnection.quota
      .filter((window) => window.dimension === dimension && window.modelBucket)
      .map((window) => ({
        dimension: `${dimension}:${window.modelBucket}`,
        label: `${label} · ${modelBucketLabel(window.modelBucket as string)}`,
        quota: window,
      }));
    return [...(quota ? [{ dimension, label, quota }] : []), ...scoped];
  });
  const providerBalance = displayedConnection.quota.find(
    (quota) => quota.remainingValue != null || quota.limitValue != null
  );
  const dirty =
    name.trim() !== displayedConnection.name ||
    enabled !== displayedConnection.enabled ||
    routingStrategy !== displayedConnection.routingStrategy ||
    (subscription &&
      minimumRemainingPercentValid &&
      parsedMinimumRemainingPercent !== displayedConnection.minimumRemainingPercent) ||
    (!subscription &&
      apiMonthlyLimitValid &&
      apiMonthlyLimitMicrodollars !== displayedConnection.apiMonthlyLimitMicrodollars);

  const save = async () => {
    setSaving(true);
    try {
      const connectionChanges = {
        ...(name.trim() !== displayedConnection.name ? { name: name.trim() } : {}),
        ...(enabled !== displayedConnection.enabled ? { enabled } : {}),
        ...(subscription &&
        parsedMinimumRemainingPercent !== undefined &&
        parsedMinimumRemainingPercent !== displayedConnection.minimumRemainingPercent
          ? { minimumRemainingPercent: parsedMinimumRemainingPercent }
          : {}),
        ...(!subscription &&
        apiMonthlyLimitMicrodollars !== displayedConnection.apiMonthlyLimitMicrodollars
          ? { apiMonthlyLimitMicrodollars }
          : {}),
      };
      if (Object.keys(connectionChanges).length) {
        await api.updateInferenceProvider(displayedConnection.id, connectionChanges);
      }
      if (routingStrategy !== displayedConnection.routingStrategy) {
        await api.updateInferenceRouting(displayedConnection.providerId, routingStrategy);
      }
      await onChanged();
      onOpenChange(false);
      toast.success("Provider settings updated");
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to update provider");
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const synced = await api.syncInferenceProvider(displayedConnection.id);
      await onChanged();
      // The sync endpoint records a failed sync on the connection and still answers 200.
      if (synced.syncStatus === "error") {
        toast.error(
          synced.syncLastError
            ? `Provider sync failed: ${synced.syncLastError}`
            : "Provider sync failed"
        );
      } else {
        toast.success("Provider synchronized");
      }
    } catch (error) {
      toastApiError(error, "Provider sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    const accepted = await confirm({
      title: "Disconnect Provider",
      description: `Disconnect “${displayedConnection.name}” and destroy its stored credential?`,
      confirmLabel: "Disconnect",
    });
    if (!accepted) return;
    setDisconnecting(true);
    try {
      await api.disconnectInferenceProvider(displayedConnection.id);
      onOpenChange(false);
      await onChanged();
      toast.success("Provider disconnected");
    } catch (error) {
      toastApiError(error, "Failed to disconnect provider");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{displayedConnection.name}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {displayedProvider?.label ?? displayedConnection.providerId} ·{" "}
          {connectionIdentity(displayedConnection)}
        </DialogDescription>

        {subscription && reportedQuotaWindows.length > 0 && (
          <PanelShell
            title="Subscription limits"
            description="Latest synchronized quota windows for this account"
            icon={<Gauge className="h-4 w-4" />}
          >
            {reportedQuotaWindows.map(({ dimension, label, quota }) => (
              <SettingsControlRow key={dimension} title={label}>
                <QuotaWindowValue quota={quota} />
              </SettingsControlRow>
            ))}
          </PanelShell>
        )}

        {providerBalance && (
          <PanelShell
            title="Provider balance"
            description="Latest synchronized credit balance reported by the provider"
            icon={<WalletCards className="h-4 w-4" />}
          >
            <SettingsControlRow title="Available credits">
              <ProviderBalanceValue quota={providerBalance} />
            </SettingsControlRow>
          </PanelShell>
        )}

        <PanelShell
          title="Connection"
          description="Health, routing availability, and synchronization"
          icon={<Link2 className="h-4 w-4" />}
        >
          <SettingsControlRow title="Connection name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Connection name"
              disabled={!canManage}
            />
          </SettingsControlRow>
          <SettingsControlRow title="Status">
            <HealthBadge status={enabled ? displayedConnection.status : "disabled"} />
          </SettingsControlRow>
          <SettingsControlRow title="Enabled" description="Allow Opfield to route requests here">
            <Switch
              checked={enabled}
              onChange={setEnabled}
              ariaLabel={`Enable ${displayedConnection.name}`}
              disabled={!canManage}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Routing strategy"
            description={`Applies to all ${displayedProvider?.label ?? displayedConnection.providerId} connections`}
            help="Sequential prefers higher-priority connections and falls through when needed. Balanced distributes requests more evenly across available connections."
          >
            <Select
              value={routingStrategy}
              onValueChange={(value) =>
                setRoutingStrategy(value as "even" | "balanced" | "sequential")
              }
              disabled={!canManage}
            >
              <SelectTrigger aria-label="Routing strategy">
                <SelectValue>
                  {routingStrategy === "even"
                    ? "Even"
                    : routingStrategy === "balanced"
                      ? "Balanced"
                      : "Sequential"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">
                <SelectItem value="balanced" textValue="Balanced" className="items-start py-2">
                  <span className="flex w-full min-w-0 flex-col gap-0.5 pr-4">
                    <span>Balanced</span>
                    <span className="whitespace-normal text-xs font-normal leading-relaxed text-muted-foreground">
                      Sends more new threads to connections with more remaining quota.
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="even" textValue="Even" className="items-start py-2">
                  <span className="flex w-full min-w-0 flex-col gap-0.5 pr-4">
                    <span>Even</span>
                    <span className="whitespace-normal text-xs font-normal leading-relaxed text-muted-foreground">
                      Distributes new threads equally across available connections.
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="sequential" textValue="Sequential" className="items-start py-2">
                  <span className="flex w-full min-w-0 flex-col gap-0.5 pr-4">
                    <span>Sequential</span>
                    <span className="whitespace-normal text-xs font-normal leading-relaxed text-muted-foreground">
                      Uses the highest connection until unavailable, then moves down the list.
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsControlRow>
          {subscription && (
            <SettingsControlRow
              title="Minimum remaining"
              description="Stop routing when any quota window reaches this reserve"
              help="Keeps a percentage of the provider's reported quota unused. Opfield stops selecting this connection when any synchronized quota window falls to the reserve."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={minimumRemainingPercent}
                  onChange={(event) => setMinimumRemainingPercent(event.target.value)}
                  aria-label="Minimum remaining percentage"
                  className="w-24"
                  disabled={!canManage}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </SettingsControlRow>
          )}
          {!subscription && (
            <SettingsControlRow
              title="Monthly API limit"
              description={`Used this UTC month: ${formatUsd(displayedConnection.apiMonthlySpentMicrodollars)}. Leave empty for unlimited.`}
              help="Opfield stops routing paid API traffic to this connection after its tracked spend reaches the limit for the current UTC calendar month."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  max={Number.MAX_SAFE_INTEGER / 1_000_000}
                  step="0.01"
                  value={apiMonthlyLimitUsd}
                  onChange={(event) => setApiMonthlyLimitUsd(event.target.value)}
                  placeholder="Unlimited"
                  aria-label="Monthly API limit in USD"
                  className="w-32"
                  disabled={!canManage}
                />
                <span className="text-sm text-muted-foreground">USD</span>
              </div>
            </SettingsControlRow>
          )}
          <SettingsControlRow title="Last synchronized">
            <RelativeTime
              value={displayedConnection.lastSyncedAt}
              fallback="Never"
              className="text-sm"
            />
          </SettingsControlRow>
        </PanelShell>

        {canManage && (
          <DialogFooter>
            <Button
              variant="destructive"
              onClick={() => void disconnect()}
              disabled={saving || syncing}
              pending={disconnecting}
            >
              <Trash2 />
              Disconnect
            </Button>
            <Button
              variant="outline"
              onClick={() => void sync()}
              disabled={saving || disconnecting}
              pending={syncing}
            >
              <RefreshCw />
              Sync now
            </Button>
            <Button
              onClick={() => void save()}
              disabled={
                !dirty ||
                !name.trim() ||
                !minimumRemainingPercentValid ||
                !apiMonthlyLimitValid ||
                syncing ||
                disconnecting
              }
              pending={saving}
            >
              Save settings
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function parseMinimumRemainingPercent(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return undefined;
  return percent;
}

function parseUsdLimit(value: string): number | null | undefined {
  if (!value.trim()) return null;
  const dollars = Number(value);
  const microdollars = Math.round(dollars * 1_000_000);
  if (!Number.isFinite(dollars) || dollars < 0 || !Number.isSafeInteger(microdollars))
    return undefined;
  return microdollars;
}

function formatUsdInput(microdollars: number | null): string {
  if (microdollars === null) return "";
  return (microdollars / 1_000_000)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

function formatUsd(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

function modelBucketLabel(bucket: string): string {
  return bucket.charAt(0).toUpperCase() + bucket.slice(1);
}

function quotaForDimension(quota: InferenceQuotaWindow[], dimension: string) {
  const matches = quota.filter((window) => window.dimension === dimension);
  if (!matches.length) return null;
  return matches.reduce((worst, current) => {
    if (current.remainingFraction == null) return worst;
    if (worst.remainingFraction == null || current.remainingFraction < worst.remainingFraction)
      return current;
    return worst;
  });
}

function QuotaWindowValue({ quota }: { quota: InferenceQuotaWindow }) {
  return (
    <div className="text-right">
      <p className="text-sm">
        {quota.remainingFraction == null
          ? "Unknown"
          : `${Math.round(quota.remainingFraction * 100)}% remaining`}
        {quota.stale || quota.status === "stale" ? " · stale" : ""}
      </p>
      {quota.resetAt && (
        <p className="text-xs text-muted-foreground">Resets {formatDateTime(quota.resetAt)}</p>
      )}
    </div>
  );
}

function ProviderBalanceValue({ quota }: { quota: InferenceQuotaWindow }) {
  const remaining = quota.remainingValue == null ? null : Number(quota.remainingValue);
  const limit = quota.limitValue == null ? null : Number(quota.limitValue);
  const formattedRemaining =
    remaining !== null && Number.isFinite(remaining) ? `$${remaining.toFixed(2)}` : null;
  const formattedLimit = limit !== null && Number.isFinite(limit) ? `$${limit.toFixed(2)}` : null;
  return (
    <div className="text-right">
      <p className="text-sm">
        {formattedRemaining && formattedLimit
          ? `${formattedRemaining} of ${formattedLimit} remaining`
          : formattedRemaining
            ? `${formattedRemaining} remaining`
            : formattedLimit
              ? `${formattedLimit} total`
              : "Unknown"}
        {quota.stale || quota.status === "stale" ? " · stale" : ""}
      </p>
      {quota.remainingFraction != null && (
        <p className="text-xs text-muted-foreground">
          {Math.round(quota.remainingFraction * 100)}% remaining
        </p>
      )}
    </div>
  );
}
