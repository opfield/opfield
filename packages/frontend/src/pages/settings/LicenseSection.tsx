import { ClipboardCopy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { formatDate, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { LicensePlan, LicenseStatus, LicenseStatusView } from "@/types";
import { resolveLicensePlan } from "./license-plan";

interface LicenseSectionProps {
  canManage: boolean;
}

function planLabel(plan: LicensePlan): string {
  if (plan === "community") return "Community";
  if (plan === "personal") return "Personal";
  if (plan === "business") return "Business";
  return "Enterprise";
}

function planIconSrc(plan: LicensePlan): string {
  return `/license/wiolett-gw-${plan}.png?v=2`;
}

function statusLabel(status: LicenseStatus): string {
  switch (status) {
    case "community":
      return "Community";
    case "valid":
      return "Licensed";
    case "expired_grace":
      return "Expired — grace period";
    case "valid_with_warning":
      return "Licensed with warning";
    case "unreachable_grace_expired":
      return "Grace expired";
    case "invalid":
      return "Invalid";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
    case "replaced":
      return "Replaced";
    case "deactivated":
      return "Deactivated";
  }
}

function statusVariant(status: LicenseStatus): "secondary" | "success" | "warning" | "destructive" {
  if (status === "valid") return "success";
  if (status === "community") return "secondary";
  if (status === "valid_with_warning") return "warning";
  return "destructive";
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Copied to clipboard"),
    () => toast.error("Failed to copy")
  );
}

function InstallationIdValue({ value }: { value: string }) {
  // Inline value that copies itself on click, not a standalone action button.
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 font-mono hover:text-primary cursor-pointer"
      onClick={() => copyToClipboard(value)}
    >
      {value.slice(0, 12)}...
      <ClipboardCopy className="h-3 w-3" />
    </button>
  );
}

function LicenseKeyValue({ last4 }: { last4: string | null }) {
  return <span className="font-mono text-xs">WLT-GW-...-{last4 ?? "????"}</span>;
}

function LicenseSummary({ status }: { status: LicenseStatusView }) {
  const plan = resolveLicensePlan(status);
  const communityRegistrationPending =
    status.status === "community" && status.registrationStatus !== "registered";

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border p-4">
      <div className="flex min-w-0 items-center gap-4">
        <img src={planIconSrc(plan)} alt={planLabel(plan)} className="h-10 w-10" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{planLabel(plan)}</p>
          <p className="truncate text-xs text-muted-foreground mt-0.5">
            {status.hasKey
              ? `Licensed to ${status.licenseName ?? status.installationName}`
              : communityRegistrationPending
                ? "Community registration pending"
                : "Community edition"}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge className="uppercase" variant={statusVariant(status.status)}>
          {statusLabel(status.status)}
        </Badge>
        {communityRegistrationPending && (
          <Badge className="uppercase" variant="warning">
            Pending registration
          </Badge>
        )}
      </div>
    </div>
  );
}

export function LicenseSection({ canManage }: LicenseSectionProps) {
  const moduleState = useUIBootstrapStore((state) => state.snapshot?.commercialModule);
  const [activatingModule, setActivatingModule] = useState(false);
  const [status, setStatus] = useState<LicenseStatusView | null>(
    () => api.getCached<LicenseStatusView>("settings:license-status") ?? null
  );
  const [loading, setLoading] = useState(
    () => api.getCached<LicenseStatusView>("settings:license-status") === undefined
  );
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  useScrollToNavigationTarget("gateway-license", !loading);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.getLicenseStatus();
      api.setCache("settings:license-status", data);
      setStatus(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load license status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const updated = await api.checkLicense();
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      toast.success("License checked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check license");
    } finally {
      setChecking(false);
    }
  };

  const handleActivate = async () => {
    if (!licenseKey.trim()) return;
    setSaving(true);
    try {
      const updated = await api.activateLicense(licenseKey.trim());
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      setLicenseKey("");
      setDialogOpen(false);
      if (updated.status === "valid") {
        toast.success(
          updated.moduleRestarting
            ? "License activated. Gateway is preparing paid features and will restart when ready."
            : "License activated"
        );
      } else {
        toast.error(updated.errorMessage ?? "License was not accepted");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to activate license");
      void loadStatus();
    } finally {
      setSaving(false);
    }
  };

  const handleModuleActivation = async () => {
    setActivatingModule(true);
    try {
      const result = await api.activateLicenseModule();
      toast.success(
        result.restarting
          ? "Gateway is preparing paid features and will restart when ready."
          : "Paid features are ready"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to enable paid features");
    } finally {
      setActivatingModule(false);
    }
  };

  const handleDeactivate = async () => {
    const ok = await confirm({
      title: "Deactivate License",
      description:
        "Deactivate this license and release it from this Gateway installation? The Gateway will return to Community edition.",
      confirmLabel: "Deactivate",
      variant: "destructive",
    });
    if (!ok) return;
    setDeactivating(true);
    try {
      const updated = await api.clearLicenseKey();
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      toast.success("License deactivated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to deactivate license");
    } finally {
      setDeactivating(false);
    }
  };

  useContentLoading(loading);
  if (loading || !status) return null;

  return (
    <>
      <PanelShell
        icon={<KeyRound className="h-4 w-4" />}
        id="gateway-license"
        title="License"
        description="Current Gateway license and activation state"
        actions={
          canManage ? (
            <Button onClick={() => setDialogOpen(true)}>
              <KeyRound className="h-4 w-4" />
              Update license
            </Button>
          ) : null
        }
      >
        <LicenseSummary status={status} />

        {status.licensed &&
        status.plan !== "community" &&
        moduleState &&
        moduleState !== "ready" ? (
          <div className="border-t border-border p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Your license is active, but paid features are not ready. Enabling them prepares the
              required files before restarting Gateway.
            </p>
            {canManage ? (
              <Button onClick={handleModuleActivation} pending={activatingModule}>
                Enable paid features
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Contact your administrator to enable paid features.
              </p>
            )}
          </div>
        ) : null}

        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          <DetailRow
            label="Installation ID"
            value={<InstallationIdValue value={status.installationId} />}
          />
          <DetailRow
            label="Expires"
            value={
              <Badge variant="secondary" className="uppercase">
                {status.expiresAt ? formatDate(status.expiresAt) : "Perpetual"}
              </Badge>
            }
          />
          <DetailRow label="Last checked" value={<RelativeTime value={status.lastCheckedAt} />} />
        </div>
      </PanelShell>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update License</DialogTitle>
          </DialogHeader>
          {status.hasKey && (
            <div className="space-y-3">
              <div className="border border-border bg-card">
                <LicenseSummary status={status} />
                <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
                  <DetailRow label="Key" value={<LicenseKeyValue last4={status.keyLast4} />} />
                  <DetailRow
                    label="Installation ID"
                    value={<InstallationIdValue value={status.installationId} />}
                  />
                  <DetailRow
                    label="Expires"
                    value={
                      <Badge variant="secondary" className="uppercase">
                        {status.expiresAt ? formatDate(status.expiresAt) : "Perpetual"}
                      </Badge>
                    }
                  />
                  <DetailRow
                    label="Last checked"
                    value={<RelativeTime value={status.lastCheckedAt} />}
                  />
                  <DetailRow
                    label="Last valid"
                    value={<RelativeTime value={status.lastValidAt} />}
                  />
                  {status.graceUntil && (
                    <DetailRow label="Grace until" value={formatDateTime(status.graceUntil)} />
                  )}
                  {status.activeInstallationName && (
                    <DetailRow label="Server name" value={status.activeInstallationName} />
                  )}
                  {status.activeInstallationId && (
                    <DetailRow
                      label="Server ID"
                      value={<InstallationIdValue value={status.activeInstallationId} />}
                    />
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={handleCheck} pending={checking}>
                  <RefreshCw className="h-4 w-4" />
                  Check
                </Button>
                <Button variant="destructive" onClick={handleDeactivate} pending={deactivating}>
                  <Trash2 className="h-4 w-4" />
                  Deactivate
                </Button>
              </div>
            </div>
          )}
          {!status.hasKey && (
            <div className="space-y-1.5">
              {moduleState && moduleState !== "ready" ? (
                <p className="text-sm text-muted-foreground">
                  Activation will prepare paid features, then restart Gateway. It stays available
                  while files are downloaded and verified.
                </p>
              ) : null}
              <label className="text-sm font-medium" htmlFor="license-key">
                License key
              </label>
              <Input
                id="license-key"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="WLT-GW-XXXX-XXXX-XXXX-XXXX"
                autoComplete="off"
              />
            </div>
          )}
          {!status.hasKey && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleActivate} pending={saving} disabled={!licenseKey.trim()}>
                Activate
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
