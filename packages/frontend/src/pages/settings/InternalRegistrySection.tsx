import { HardDrive, Save, ShieldCheck } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow, SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { DomainAutocompleteInput } from "@/components/domains/DomainAutocompleteInput";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { DockerInternalRegistryState, Node, SSLCertificate } from "@/types";

interface InternalRegistrySectionProps {
  nodesList: Node[];
}

function registryStatusReason(state: DockerInternalRegistryState | null): string | null {
  if (!state || state.status === "ready") return null;
  if (state.lastError) return state.lastError;
  if (state.status === "maintenance") {
    return `Registry maintenance is running${state.maintenancePhase !== "idle" ? ` (${state.maintenancePhase.replaceAll("_", " ")})` : ""}.`;
  }
  if (state.status === "starting") return "The registry service is still starting.";
  if (state.status === "read_only") {
    return "The registry health check passed, but its storage backend did not report writable access.";
  }
  if (state.status === "degraded") return "The registry is available with reduced capacity.";
  return "Registry health checks are failing.";
}

function RegistryBadgeWithTooltip({
  label,
  tooltip,
  variant,
}: {
  label: string;
  tooltip: string | null;
  variant: ComponentProps<typeof Badge>["variant"];
}) {
  const badge = (
    <Badge variant={variant} size="inline">
      {label}
    </Badge>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip>
      {/* A focusable tooltip trigger around the badge, not an action button. */}
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-xs whitespace-normal py-2 leading-relaxed"
      >
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function certificateCoversHostname(certificate: SSLCertificate, hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || certificate.status !== "active") return false;
  if (certificate.notAfter && Date.parse(certificate.notAfter) <= Date.now()) return false;
  return certificate.domainNames.some((domain) => {
    const candidate = domain.trim().toLowerCase().replace(/\.$/, "");
    if (candidate === normalized) return true;
    if (!candidate.startsWith("*.")) return false;
    const suffix = candidate.slice(2);
    return (
      normalized.endsWith(`.${suffix}`) &&
      normalized.split(".").length === suffix.split(".").length + 1
    );
  });
}

export function InternalRegistrySection({ nodesList }: InternalRegistrySectionProps) {
  const [state, setState] = useState<DockerInternalRegistryState | null>(null);
  const [externalEnabled, setExternalEnabled] = useState(false);
  const [hostname, setHostname] = useState("");
  const [nginxNodeId, setNginxNodeId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [certificates, setCertificates] = useState<SSLCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  useContentLoading(loading);

  const applyState = useCallback((next: DockerInternalRegistryState, syncForm = true) => {
    setState(next);
    if (!syncForm) return;
    setExternalEnabled(next.externalAccessEnabled);
    setHostname(next.externalHostname ?? "");
    setNginxNodeId(next.externalNginxNodeId ?? "");
    setCertificateId(next.externalCertificateId ?? "");
  }, []);

  useEffect(() => {
    void Promise.all([
      api.getDockerInternalRegistryState(),
      api.listSSLCertificates({ limit: 100, status: "active" }),
    ])
      .then(([next, certificateResponse]) => {
        applyState(next);
        setCertificates(certificateResponse.data ?? []);
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load internal registry")
      )
      .finally(() => setLoading(false));
  }, [applyState]);

  const nginxNodes = useMemo(() => nodesList.filter((node) => node.type === "nginx"), [nodesList]);
  const matchingCertificates = useMemo(
    () => certificates.filter((certificate) => certificateCoversHostname(certificate, hostname)),
    [certificates, hostname]
  );
  const used = state?.storageUsedBytes ?? 0;
  const capacity = state?.storageCapacityBytes ?? null;
  const free = capacity === null ? null : Math.max(0, capacity - used);
  const statusReason = registryStatusReason(state);
  const readOnlyReason =
    state && !state.writable
      ? `Registry writes are disabled. ${statusReason ?? "The storage backend is not writable."}`
      : null;

  const save = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const next = await api.updateDockerInternalRegistrySettings({
        externalAccessEnabled: externalEnabled,
        externalHostname: externalEnabled ? hostname.trim() || undefined : undefined,
        externalNginxNodeId: externalEnabled ? nginxNodeId || undefined : undefined,
        externalCertificateId: externalEnabled ? certificateId || undefined : undefined,
      });
      applyState(next);
      toast.success("Internal registry settings updated");
    } catch (error) {
      if (!handleLicenseApiError(error, "External internal registry access")) {
        toast.error(error instanceof Error ? error.message : "Failed to update internal registry");
      }
    } finally {
      setSaving(false);
    }
  };

  const dirty = Boolean(
    state &&
      (externalEnabled !== state.externalAccessEnabled ||
        (externalEnabled &&
          (hostname.trim() !== (state.externalHostname ?? "") ||
            nginxNodeId !== (state.externalNginxNodeId ?? "") ||
            certificateId !== (state.externalCertificateId ?? ""))))
  );

  const setExternalAccess = (enabled: boolean) => {
    if (
      enabled &&
      !requireLicenseFeature("git-push-to-deploy", "External internal registry access")
    ) {
      return;
    }
    setExternalEnabled(enabled);
    if (!enabled && state) {
      setHostname(state.externalHostname ?? "");
      setNginxNodeId(state.externalNginxNodeId ?? "");
      setCertificateId(state.externalCertificateId ?? "");
    }
  };

  useRealtime(
    "docker.registry.changed",
    (payload) => {
      const event = payload as { id?: string; action?: string } | undefined;
      if (event?.id !== "gateway-internal-registry") return;
      void api
        .getDockerInternalRegistryState()
        .then((next) => applyState(next, event.action === "settings" && !dirty))
        .catch(() => undefined);
    },
    {
      onReconnect: () => {
        void api
          .getDockerInternalRegistryState()
          .then((next) => applyState(next, !dirty))
          .catch(() => undefined);
      },
    }
  );

  return (
    <PanelShell
      title={
        <TooltipProvider delayDuration={200}>
          <span className="flex items-center gap-2">
            Internal Registry
            <RegistryBadgeWithTooltip
              label={state?.status?.replaceAll("_", " ") ?? "Loading"}
              variant={state?.status === "ready" ? "success" : "warning"}
              tooltip={statusReason}
            />
            <RegistryBadgeWithTooltip
              label={state?.writable ? "Writable" : "Read only"}
              variant={state?.writable ? "default" : "secondary"}
              tooltip={readOnlyReason}
            />
          </span>
        </TooltipProvider>
      }
      icon={<HardDrive className="h-4 w-4" />}
      description={state?.lastError ?? "Managed registry for Git builds and runtime image pulls."}
      dirty={dirty}
      actions={
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void save()}
            disabled={
              !state || !dirty || (externalEnabled && (!hostname || !nginxNodeId || !certificateId))
            }
            pending={saving}
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        </div>
      }
    >
      <SettingsControlRow
        title="Storage backend"
        description="Artifacts are stored on the Opfield-managed registry volume."
      >
        <span className="text-sm">Local volume</span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Capacity"
        description="Registry data remains on the Opfield node volume."
      >
        <span className="text-right text-sm">
          {formatBytes(used)} used
          {capacity !== null ? ` · ${formatBytes(free ?? 0)} free of ${formatBytes(capacity)}` : ""}
        </span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Garbage collection"
        description="Retention and scheduled garbage collection are managed in Housekeeping."
        help="Garbage collection permanently removes image layers and build artifacts that are no longer referenced. Its schedule and retention policy are configured in Housekeeping."
      >
        <span className="text-right text-sm text-muted-foreground">
          {state?.lastGcAt ? (
            <>
              Last <RelativeTime value={state.lastGcAt} />
            </>
          ) : (
            "Not run yet"
          )}
          {state?.nextGcAt ? ` · Next ${formatDateTime(state.nextGcAt)}` : ""}
        </span>
      </SettingsControlRow>
      <SettingsControlRow
        title={
          <span className="flex items-center gap-2">
            <SettingsHelpTitle
              label="External access"
              help="Publishes the internal registry through an Nginx ingress so Docker clients outside Opfield's private transport can pull images over HTTPS."
            />
            <LicensePlanBadge feature="git-push-to-deploy" label="Business+" />
          </span>
        }
        description="Internal builds and pulls keep working when this is disabled."
      >
        <Switch
          checked={externalEnabled}
          onChange={setExternalAccess}
          ariaLabel="External registry access"
        />
      </SettingsControlRow>
      {externalEnabled && (
        <>
          <SettingsControlRow
            title="External domain"
            description="Optional hostname for Docker clients outside the Opfield private transport."
            help="Public DNS name Docker clients use as the registry address. It must resolve to the selected ingress node and match the TLS certificate."
          >
            <DomainAutocompleteInput
              value={hostname}
              onChange={setHostname}
              nginxNodeId={nginxNodeId || undefined}
              registeredOnly
              placeholder="registry.example.com"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Ingress node"
            description="The selected Nginx node owns the public registry route."
            help="This Nginx node terminates TLS and forwards registry traffic to Opfield. It must be reachable from the external Docker clients."
          >
            <Select value={nginxNodeId} onValueChange={setNginxNodeId}>
              <SelectTrigger className="sm:w-72">
                <SelectValue placeholder="Select Nginx node" />
              </SelectTrigger>
              <SelectContent>
                {nginxNodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          <SettingsControlRow
            title="TLS certificate"
            description="Certificate presented by the external registry endpoint."
            help="Docker verifies this certificate when connecting to the external registry domain. The certificate must be active and cover that exact hostname."
          >
            <Select value={certificateId} onValueChange={setCertificateId}>
              <SelectTrigger className="sm:w-72">
                <SelectValue placeholder="Select certificate" />
              </SelectTrigger>
              <SelectContent>
                {matchingCertificates.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No active certificate covers this domain
                  </SelectItem>
                ) : (
                  matchingCertificates.map((certificate) => (
                    <SelectItem key={certificate.id} value={certificate.id}>
                      {certificate.name} · {certificate.domainNames.join(", ")}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </>
      )}
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
          Repository-scoped pull/push tokens remain authoritative for external access.
        </span>
      </div>
    </PanelShell>
  );
}
