import { ArrowRight, Cloud, FolderPlus, MoreVertical, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { DNSChallengeVerification } from "@/components/ssl/DNSChallengeVerification";
import {
  SSLCertificateCreateDialog,
  type SSLCertificateCreateDialogDevPreview,
} from "@/components/ssl/SSLCertificateCreateDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { hasCreationDestination } from "@/lib/creation-folders";
import { cn, daysUntil, formatDate, hoursUntil } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSSLStore } from "@/stores/ssl";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type {
  CertificateDistributionState,
  DNSChallenge,
  SSLCertificate,
  SSLCertStatus,
  SSLCertType,
} from "@/types";

const typeOptions: { value: SSLCertType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "acme", label: "ACME" },
  { value: "upload", label: "Upload" },
  { value: "internal", label: "Internal" },
];

const statusOptions: { value: SSLCertStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "pending", label: "Pending" },
  { value: "error", label: "Error" },
];

function SSLTypeBadge({ type }: { type: SSLCertType }) {
  switch (type) {
    case "acme":
      return <Badge variant="success">ACME</Badge>;
    case "upload":
      return <Badge variant="secondary">UPLOAD</Badge>;
    case "internal":
      return <Badge variant="default">INTERNAL</Badge>;
    default:
      return <Badge variant="secondary">{type}</Badge>;
  }
}

function SSLStatusBadge({ status }: { status: SSLCertStatus }) {
  switch (status) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "pending":
      return <Badge variant="warning">Pending</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function TLSDeploymentBadge({ distribution }: { distribution?: CertificateDistributionState }) {
  if (!distribution || distribution.status === "not_deployed") {
    return <Badge variant="secondary">Not deployed</Badge>;
  }
  if (distribution.status === "pending") {
    return <Badge variant="warning">Deploying</Badge>;
  }
  if (distribution.status === "ready") {
    return <Badge variant="success">Ready ({distribution.readyReplicaCount})</Badge>;
  }
  if (distribution.status === "daemon_update_required") {
    return <Badge variant="warning">Daemon update needed</Badge>;
  }
  return <Badge variant="destructive">TLS failed</Badge>;
}

export function SSLCertificates() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCertificateId = searchParams.get("certificate");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [domainRequiredOpen, setDomainRequiredOpen] = useState(false);
  const [cloudflareRequiredOpen, setCloudflareRequiredOpen] = useState(false);
  const [hasDomains, setHasDomains] = useState(false);
  const [createInitialTab, setCreateInitialTab] = useState<"acme" | "upload">("acme");
  const [isCheckingDomains, setIsCheckingDomains] = useState(false);
  const [createDialogDevPreview, setCreateDialogDevPreview] =
    useState<SSLCertificateCreateDialogDevPreview | null>(null);
  const [cloudflareReady, setCloudflareReady] = useState<boolean | null>(null);
  const isCheckingDomainsRef = useRef(false);
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  // Creating needs ssl:cert:issue on some destination (broad or a folder); the dialog
  // offers only those folders. Per-certificate grants only cover renewal actions.
  const canCreateCertificate = hasCreationDestination(user?.scopes ?? [], "ssl:cert:issue");
  // Let's Encrypt picks registered domains, which needs domains:view; without it only
  // upload and internal CA linking are offered and no domain lookup is made.
  const canViewDomains = hasScopedAccess("domains:view");
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);
  const hasCloudflareIntegration = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.hasCloudflareIntegration ?? false
  );
  const canInspectCloudflare =
    hasScope("integrations:cloudflare:view") || hasScope("integrations:cloudflare:manage");
  const cloudflareConfigured = cloudflareReady ?? hasCloudflareIntegration;
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const modal = useUIStore((s) => s.modal);
  const closeModal = useUIStore((s) => s.closeModal);

  const openCreateCertificate = useCallback(async () => {
    if (isCheckingDomainsRef.current) return;
    isCheckingDomainsRef.current = true;
    setIsCheckingDomains(true);
    try {
      const [result, connectors] = await Promise.all([
        canViewDomains ? api.listDomains({ page: 1, limit: 1 }) : Promise.resolve(null),
        canInspectCloudflare
          ? api.listCloudflareConnectors({ enabled: true }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (connectors !== null) {
        setCloudflareReady(
          connectors.some(
            (connector) =>
              connector.enabled &&
              connector.syncStatus !== "error" &&
              (connector.zones?.length ?? 0) > 0
          )
        );
      }
      if (!result) {
        setHasDomains(false);
        setCreateInitialTab("upload");
        setCreateDialogOpen(true);
        return;
      }
      const domainsAvailable = result.pagination.total > 0;
      setHasDomains(domainsAvailable);
      if (!domainsAvailable) {
        setDomainRequiredOpen(true);
        return;
      }
      setCreateInitialTab("acme");
      setCreateDialogOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check registered domains");
    } finally {
      isCheckingDomainsRef.current = false;
      setIsCheckingDomains(false);
    }
  }, [canInspectCloudflare, canViewDomains]);

  const continueWithManualCertificate = () => {
    setDomainRequiredOpen(false);
    setHasDomains(false);
    setCreateInitialTab("upload");
    setCreateDialogOpen(true);
  };

  // Open dialog from command palette
  useEffect(() => {
    if (modal?.type === "createSSLCert") {
      void openCreateCertificate();
      closeModal();
    }
  }, [modal, closeModal, openCreateCertificate]);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = ((window as Window & { gatewayDev?: Record<string, unknown> }).gatewayDev ??=
      {});
    const openDns01Modal = () => {
      setHasDomains(true);
      setCreateInitialTab("acme");
      setCreateDialogDevPreview({
        mode: "dns-01",
        domains: ["example.com", "*.example.com"],
        dnsChallenges: [
          {
            domain: "example.com",
            recordName: "_acme-challenge.example.com",
            recordValue: "dev-preview-token-example-com-8f4d9b2a",
          },
          {
            domain: "*.example.com",
            recordName: "_acme-challenge.example.com",
            recordValue: "dev-preview-token-wildcard-example-com-c31a7e0f",
          },
        ],
      });
      setCreateDialogOpen(true);
    };
    const openHttp01Modal = () => {
      setHasDomains(true);
      setCreateInitialTab("acme");
      setCreateDialogDevPreview({
        mode: "http-01",
        domains: ["example.com"],
      });
      setCreateDialogOpen(true);
    };
    gatewayDev.openSslDns01Modal = openDns01Modal;
    gatewayDev.openSslHttp01Modal = openHttp01Modal;
    (
      window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      }
    ).gatewayDevOpenSslDns01Modal = openDns01Modal;
    (
      window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      }
    ).gatewayDevOpenSslHttp01Modal = openHttp01Modal;

    return () => {
      if (gatewayDev.openSslDns01Modal === openDns01Modal) delete gatewayDev.openSslDns01Modal;
      if (gatewayDev.openSslHttp01Modal === openHttp01Modal) delete gatewayDev.openSslHttp01Modal;
      const win = window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      };
      if (win.gatewayDevOpenSslDns01Modal === openDns01Modal) {
        delete win.gatewayDevOpenSslDns01Modal;
      }
      if (win.gatewayDevOpenSslHttp01Modal === openHttp01Modal) {
        delete win.gatewayDevOpenSslHttp01Modal;
      }
    };
  }, []);
  const {
    certificates,
    error,
    isLoading,
    isLoadingMore,
    filters,
    hasMore,
    fetchCertificates,
    fetchNextPage,
    setFilters,
    resetFilters,
    renewCert,
    setAutoRenew,
    completeDNSVerify,
    deleteCert,
  } = useSSLStore();
  const [searchInput, setSearchInput] = useState(filters.search);
  type PendingRenewal = {
    certId: string;
    certName: string;
    operation: "issue" | "renewal";
    challenges: DNSChallenge[];
  };
  const {
    open: pendingRenewalOpen,
    value: pendingRenewal,
    setValue: setPendingRenewal,
    onOpenChange: onPendingRenewalOpenChange,
  } = useDeferredDialogState<PendingRenewal>();
  const [previewCert, setPreviewCert] = useState<SSLCertificate | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isVerifyingRenewal, setIsVerifyingRenewal] = useState(false);
  const [resyncingCertId, setResyncingCertId] = useState<string | null>(null);
  type RenewingCertificate = {
    id: string;
    name: string;
    challengeType: SSLCertificate["acmeChallengeType"];
  };
  const {
    open: renewingCertOpen,
    value: renewingCert,
    setValue: setRenewingCert,
  } = useDeferredDialogState<RenewingCertificate>();
  const previewCleanupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void showSystemCertificates;
    fetchCertificates();
  }, [fetchCertificates, showSystemCertificates]);

  useRealtime("ssl.cert.changed", () => {
    fetchCertificates();
  });
  useRealtime("ssl.cert.folder.changed", () => {
    fetchCertificates();
  });

  useEffect(() => {
    if (hasMore && !isLoading && !isLoadingMore && !error) void fetchNextPage();
  }, [error, fetchNextPage, hasMore, isLoading, isLoadingMore]);

  useEffect(
    () => () => {
      if (previewCleanupTimerRef.current !== null) {
        window.clearTimeout(previewCleanupTimerRef.current);
      }
    },
    []
  );

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.type !== "all" || filters.status !== "active" || filters.search !== "";
  const canManageFolders = useCanManageSomeFolders("ssl:cert:folders:manage");

  const handleRenew = async (cert: SSLCertificate) => {
    setRenewingCert({
      id: cert.id,
      name: cert.name,
      challengeType: cert.acmeChallengeType,
    });
    try {
      const result = await renewCert(cert.id);
      if ("certificate" in result && result.status === "pending_dns_verification") {
        setRenewingCert(null);
        setPendingRenewal({
          certId: result.certificate.id,
          certName: result.certificate.name,
          operation: "renewal",
          challenges: result.challenges ?? [],
        });
        toast.success("DNS renewal challenge created. Add the TXT records, then verify.");
        return;
      }
      toast.success("Certificate renewed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to renew certificate");
    } finally {
      setRenewingCert(null);
    }
  };

  const handleRetryDeployments = async (cert: SSLCertificate) => {
    setResyncingCertId(cert.id);
    try {
      await api.resyncSSLCertificateDistribution(cert.id);
      toast.success(`TLS deployment retry requested for ${cert.name}`);
      await fetchCertificates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry TLS deployments");
    } finally {
      setResyncingCertId(null);
    }
  };

  const handleSetCloudflareAutoRenew = async (cert: SSLCertificate, enabled: boolean) => {
    try {
      await setAutoRenew(
        cert.id,
        enabled ? { enabled: true, provider: "cloudflare" } : { enabled: false }
      );
      toast.success(enabled ? "Cloudflare auto-renew enabled" : "Auto-renew disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update auto-renew");
    }
  };

  const handleEnableInternalAutoRenew = async (cert: SSLCertificate) => {
    try {
      await setAutoRenew(cert.id, { enabled: true });
      toast.success("Automatic reissue enabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update auto-renew");
    }
  };

  const handleContinueDNSRenewal = (cert: {
    id: string;
    name: string;
    acmePendingOperation: "issue" | "renewal" | null;
    acmePendingChallenges: DNSChallenge[] | null;
  }) => {
    if (!cert.acmePendingChallenges?.length) {
      toast.error("No pending DNS challenges found for this certificate");
      return;
    }
    setPendingRenewal({
      certId: cert.id,
      certName: cert.name,
      operation: cert.acmePendingOperation ?? "issue",
      challenges: cert.acmePendingChallenges,
    });
  };

  const handleVerifyRenewal = async () => {
    if (!pendingRenewal) return;
    setIsVerifyingRenewal(true);
    try {
      await completeDNSVerify(pendingRenewal.certId);
      toast.success(
        pendingRenewal.operation === "renewal"
          ? "DNS verification complete. Certificate renewed."
          : "DNS verification complete. Certificate issued."
      );
      setPendingRenewal(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "DNS verification failed");
    } finally {
      setIsVerifyingRenewal(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Delete SSL Certificate",
      description: `Are you sure you want to delete "${name}"? This action cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await deleteCert(id);
      toast.success("Certificate deleted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete certificate";
      if (msg.includes("in use") || msg.includes("CERT_IN_USE")) {
        toast.error("Cannot delete: certificate is used by routes. Remove it from routes first.");
      } else if (msg.includes("System") || msg.includes("SYSTEM_CERT")) {
        toast.error("System certificates cannot be deleted.");
      } else {
        toast.error(msg);
      }
    }
  };

  const openCertificatePreview = useCallback((cert: SSLCertificate) => {
    if (previewCleanupTimerRef.current !== null) {
      window.clearTimeout(previewCleanupTimerRef.current);
      previewCleanupTimerRef.current = null;
    }
    setPreviewCert(cert);
    setPreviewOpen(true);
  }, []);

  useEffect(() => {
    if (!requestedCertificateId) return;
    let cancelled = false;
    void api
      .getSSLCertificate(requestedCertificateId)
      .then((certificate) => {
        if (!cancelled) openCertificatePreview(certificate);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Failed to load certificate");
        }
      });
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("certificate");
    setSearchParams(nextParams, { replace: true });
    return () => {
      cancelled = true;
    };
  }, [openCertificatePreview, requestedCertificateId, searchParams, setSearchParams]);

  const handlePreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (open) return;
    previewCleanupTimerRef.current = window.setTimeout(() => {
      setPreviewCert(null);
      previewCleanupTimerRef.current = null;
    }, 250);
  };

  const certificateColumns: ResourceListColumn<SSLCertificate>[] = [
    {
      id: "name",
      label: "Name",
      width: "minmax(200px, 1.25fr)",
      renderCell: (cert) => (
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{cert.name}</p>
          {cert.isSystem && (
            <Badge variant="outline" size="inline">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "domains",
      label: "Domains",
      width: "minmax(200px, 1.25fr)",
      renderCell: (cert) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground">
            {cert.domainNames.slice(0, 2).join(", ") || "-"}
          </p>
          {cert.domainNames.length > 2 && (
            <p className="text-xs text-muted-foreground">+{cert.domainNames.length - 2} more</p>
          )}
        </div>
      ),
    },
    {
      id: "type",
      label: "Type",
      width: "110px",
      renderCell: (cert) => <SSLTypeBadge type={cert.type} />,
    },
    {
      id: "status",
      label: "Status",
      width: "120px",
      renderCell: (cert) => <SSLStatusBadge status={cert.status} />,
    },
    {
      id: "tls",
      label: "Deployments",
      width: "minmax(130px, 0.7fr)",
      renderCell: (cert) => <TLSDeploymentBadge distribution={cert.distribution} />,
    },
    {
      id: "expires",
      label: "Expires",
      width: "190px",
      cellClassName: "whitespace-nowrap",
      renderCell: (cert) => {
        const expDays = cert.notAfter ? daysUntil(cert.notAfter) : null;
        return cert.notAfter ? (
          <span
            className={cn(
              "text-sm",
              expDays !== null && expDays <= 7
                ? "font-medium text-destructive"
                : expDays !== null && expDays <= 30
                  ? "text-warning-foreground"
                  : "text-muted-foreground"
            )}
          >
            {formatDate(cert.notAfter)}
            {expDays !== null && expDays > 0 && <span className="ml-1 text-xs">({expDays}d)</span>}
            {expDays !== null && expDays === 0 && hoursUntil(cert.notAfter) > 0 && (
              <span className="ml-1 text-xs">({hoursUntil(cert.notAfter)}h)</span>
            )}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        );
      },
    },
    {
      id: "autoRenew",
      label: "Auto-Renew",
      width: "150px",
      renderCell: (cert) => {
        if (cert.type === "internal") {
          return cert.autoRenew ? (
            <Badge variant="success">Reissue</Badge>
          ) : (
            <Badge variant="secondary">No</Badge>
          );
        }
        if (cert.type !== "acme") return <Badge variant="secondary">No</Badge>;
        if (cert.autoRenew && cert.autoRenewProvider === "cloudflare") {
          return <Badge variant="success">Cloudflare</Badge>;
        }
        if (cert.autoRenew && cert.acmeChallengeType !== "dns-01") {
          return <Badge variant="success">Yes</Badge>;
        }
        if (cert.autoRenew && cert.acmeChallengeType === "dns-01") {
          return <Badge variant="warning">Needs Setup</Badge>;
        }
        return (
          <Badge variant={cert.autoRenewDisabledReason ? "warning" : "secondary"}>
            {cert.autoRenewDisabledReason ? "Disabled" : "No"}
          </Badge>
        );
      },
    },
    {
      id: "actions",
      label: "",
      align: "right",
      width: "64px",
      renderCell: (cert) => {
        const hasPendingDNSVerification =
          (cert.acmePendingOperation === "issue" || cert.acmePendingOperation === "renewal") &&
          (cert.acmePendingChallenges?.length ?? 0) > 0;
        // Row actions use the per-certificate grant, like /ssl-certificates/:id/* on the backend:
        // renewal steps need ssl:cert:renew (implied by ssl:cert:issue), re-delivery needs
        // ssl:cert:issue.
        const canIssueForCert = hasScope(`ssl:cert:issue:${cert.id}`);
        const canRenewForCert = hasScope(`ssl:cert:renew:${cert.id}`);
        const canContinueDNSVerification = canRenewForCert && hasPendingDNSVerification;
        const canRenewCert =
          canRenewForCert &&
          (cert.type === "acme" || (cert.type === "internal" && cert.autoRenew)) &&
          Boolean(cert.notAfter) &&
          (cert.status === "active" || cert.status === "error") &&
          !hasPendingDNSVerification;
        const canEnableCloudflareAutoRenew =
          canRenewForCert &&
          cert.type === "acme" &&
          cert.acmeChallengeType === "dns-01" &&
          cert.status === "active" &&
          !(cert.autoRenew && cert.autoRenewProvider === "cloudflare") &&
          !hasPendingDNSVerification;
        const canDisableCloudflareAutoRenew =
          canRenewForCert &&
          ((cert.type === "acme" &&
            cert.acmeChallengeType === "dns-01" &&
            cert.autoRenew &&
            cert.autoRenewProvider === "cloudflare") ||
            (cert.type === "internal" && cert.autoRenew));
        const canEnableInternalAutoRenew =
          canRenewForCert && cert.type === "internal" && !cert.autoRenew;
        const canDeleteCert =
          !cert.isSystem && (hasScope("ssl:cert:delete") || hasScope(`ssl:cert:delete:${cert.id}`));
        const canRetryDeployments =
          // System certificates stay operator-only (admin:update), like the backend.
          (cert.isSystem
            ? hasScope("admin:update")
            : canIssueForCert || hasScope("admin:update")) &&
          cert.distribution !== undefined &&
          cert.distribution.status !== "ready" &&
          cert.distribution.status !== "not_deployed";
        const hasActions =
          canContinueDNSVerification ||
          canRenewCert ||
          canEnableCloudflareAutoRenew ||
          canDisableCloudflareAutoRenew ||
          canEnableInternalAutoRenew ||
          canRetryDeployments ||
          canDeleteCert;
        if (!hasActions) return null;
        return (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Certificate actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canContinueDNSVerification && (
                  <DropdownMenuItem onClick={() => handleContinueDNSRenewal(cert)}>
                    <RefreshCw className="h-4 w-4" />
                    Continue Verification
                  </DropdownMenuItem>
                )}
                {canRenewCert && (
                  <DropdownMenuItem onClick={() => handleRenew(cert)}>
                    <RefreshCw className="h-4 w-4" />
                    Renew
                  </DropdownMenuItem>
                )}
                {canEnableCloudflareAutoRenew && (
                  <DropdownMenuItem onClick={() => handleSetCloudflareAutoRenew(cert, true)}>
                    <Cloud className="h-4 w-4" />
                    Enable Cloudflare Auto-Renew
                  </DropdownMenuItem>
                )}
                {canDisableCloudflareAutoRenew && (
                  <DropdownMenuItem onClick={() => handleSetCloudflareAutoRenew(cert, false)}>
                    <Cloud className="h-4 w-4" />
                    Disable Auto-Renew
                  </DropdownMenuItem>
                )}
                {canEnableInternalAutoRenew && (
                  <DropdownMenuItem onClick={() => handleEnableInternalAutoRenew(cert)}>
                    <RefreshCw className="h-4 w-4" />
                    Enable Automatic Reissue
                  </DropdownMenuItem>
                )}
                {canRetryDeployments && (
                  <DropdownMenuItem
                    onClick={() => handleRetryDeployments(cert)}
                    disabled={resyncingCertId === cert.id}
                    aria-label={`Retry TLS deployments for ${cert.name}`}
                  >
                    <RefreshCw
                      className={cn("h-4 w-4", resyncingCertId === cert.id && "animate-spin")}
                    />
                    Retry Deployments
                  </DropdownMenuItem>
                )}
                {canDeleteCert && (
                  <DropdownMenuItem
                    onClick={() => handleDelete(cert.id, cert.name)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-3">
        <PageHeader
          className="shrink-0"
          leading={<LiteModeBackButton />}
          title="SSL Certificates"
          description="Manage TLS certificates for ingress domains"
          actions={
            <ResponsiveHeaderActions
              actions={[
                ...(canManageFolders && createFolderAction
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: createFolderAction,
                      },
                    ]
                  : []),
                ...(canCreateCertificate
                  ? [
                      {
                        label: "Add Certificate",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => void openCreateCertificate(),
                        disabled: isCheckingDomains,
                      },
                    ]
                  : []),
              ]}
            >
              {canManageFolders && (
                <Button variant="outline" onClick={() => createFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canCreateCertificate && (
                <Button onClick={() => void openCreateCertificate()} pending={isCheckingDomains}>
                  <Plus className="h-4 w-4" />
                  Add Certificate
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <FolderedResourceList<SSLCertificate>
          resourceType="ssl-certificate"
          realtimeChannel="ssl.cert.folder.changed"
          resources={certificates || []}
          columns={certificateColumns}
          search={{
            placeholder: "Search by name or domain...",
            search: searchInput,
            onSearchChange: setSearchInput,
            onSearchSubmit: handleSearch,
            hasActiveFilters,
            onReset: () => {
              resetFilters();
              setSearchInput("");
            },
            filters: (
              <>
                <div className="w-40">
                  <Select
                    value={filters.type}
                    onValueChange={(v) => setFilters({ type: v as SSLCertType | "all" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {typeOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-40">
                  <Select
                    value={filters.status}
                    onValueChange={(v) => setFilters({ status: v as SSLCertStatus | "all" })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ),
          }}
          loading={isLoading || isLoadingMore}
          loadingLabel="Loading SSL certificates..."
          emptyState={
            <EmptyState
              message="No SSL certificates."
              {...(canCreateCertificate
                ? { actionLabel: "Add one", onAction: () => void openCreateCertificate() }
                : {})}
              hasActiveFilters={hasActiveFilters}
              onReset={() => {
                resetFilters();
                setSearchInput("");
              }}
            />
          }
          minWidth={1128}
          canManageFolders={canManageFolders}
          canReorganizeItem={(certificate) => canManageFolders && !certificate.isSystem}
          getResourceLabel={(certificate) => certificate.name}
          onItemClick={openCertificatePreview}
          onRefresh={fetchCertificates}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      <SSLCertificateCreateDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setCreateDialogDevPreview(null);
        }}
        onCreated={fetchCertificates}
        hasDomains={hasDomains}
        pkiEnabled={pkiEnabled}
        cloudflareConfigured={cloudflareConfigured}
        onCloudflareRequired={() => {
          setCreateDialogOpen(false);
          setCloudflareRequiredOpen(true);
        }}
        initialTab={createInitialTab}
        devPreview={createDialogDevPreview}
      />
      <Dialog open={cloudflareRequiredOpen} onOpenChange={setCloudflareRequiredOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Configure Cloudflare</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Automatic DNS validation requires a configured Cloudflare integration. Add and enable a
            Cloudflare connector in Settings, then return here to request the certificate.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloudflareRequiredOpen(false)}>
              Close
            </Button>
            <Button asChild>
              <Link to="/settings/integrations" onClick={() => setCloudflareRequiredOpen(false)}>
                Configure Cloudflare <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={domainRequiredOpen} onOpenChange={setDomainRequiredOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Add a Domain First</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Public certificates require a registered domain. Add the domain first, then return here
            to request its certificate.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={continueWithManualCertificate}>
              Continue manually
            </Button>
            <Button asChild>
              <Link to="/domains" onClick={() => setDomainRequiredOpen(false)}>
                Open Domains <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={previewOpen} onOpenChange={handlePreviewOpenChange}>
        <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>SSL Certificate Details</DialogTitle>
          </DialogHeader>
          {previewCert && (
            <div className="space-y-4">
              <PanelShell title="Certificate" bodyClassName="divide-y divide-border">
                <DetailRow
                  label="Name"
                  value={<span className="break-all">{previewCert.name}</span>}
                />
                <DetailRow
                  label="Domains"
                  value={
                    <span className="break-all">{previewCert.domainNames.join(", ") || "-"}</span>
                  }
                />
                <DetailRow label="Type" value={<SSLTypeBadge type={previewCert.type} />} />
                <DetailRow label="Status" value={<SSLStatusBadge status={previewCert.status} />} />
                <DetailRow
                  label="Valid From"
                  value={previewCert.notBefore ? formatDate(previewCert.notBefore) : "-"}
                />
                <DetailRow
                  label="Valid Until"
                  value={previewCert.notAfter ? formatDate(previewCert.notAfter) : "-"}
                />
                {previewCert.isSystem && <DetailRow label="System" value="Yes" />}
                <DetailRow label="Created" value={<RelativeTime value={previewCert.createdAt} />} />
                <DetailRow label="Updated" value={<RelativeTime value={previewCert.updatedAt} />} />
              </PanelShell>

              <PanelShell title="Deployments" bodyClassName="divide-y divide-border">
                {(previewCert.distribution?.replicas?.length ?? 0) === 0 ? (
                  <EmptyState
                    message="Not deployed. The certificate will be installed when an enabled route uses it."
                    embedded
                  />
                ) : (
                  previewCert.distribution?.replicas?.map((replica) => (
                    <DetailRow
                      key={replica.nodeId}
                      label={replica.nodeName}
                      value={
                        <span className="flex min-w-0 flex-col items-end gap-1">
                          <Badge
                            variant={
                              replica.status === "ready"
                                ? "success"
                                : replica.status === "failed"
                                  ? "destructive"
                                  : "warning"
                            }
                          >
                            {replica.status.replaceAll("_", " ")}
                          </Badge>
                          {replica.error && (
                            <span className="max-w-full break-words text-xs text-destructive">
                              {replica.error}
                            </span>
                          )}
                          {replica.lastVerifiedAt && (
                            <span className="text-xs text-muted-foreground">
                              Checked <RelativeTime value={replica.lastVerifiedAt} />
                            </span>
                          )}
                        </span>
                      }
                    />
                  ))
                )}
              </PanelShell>

              <PanelShell title="ACME & Renewal" bodyClassName="divide-y divide-border">
                <DetailRow label="Provider" value={previewCert.acmeProvider ?? "-"} />
                <DetailRow label="Challenge" value={previewCert.acmeChallengeType ?? "-"} />
                <DetailRow
                  label="Auto-Renew"
                  value={
                    previewCert.autoRenewProvider === "cloudflare" && previewCert.autoRenew
                      ? `Cloudflare (${previewCert.autoRenewDnsBindings?.[0]?.connectorName ?? "connector"})`
                      : previewCert.autoRenew
                        ? "Yes"
                        : "No"
                  }
                />
                <DetailRow
                  label="Last Renewed"
                  value={<RelativeTime value={previewCert.lastRenewedAt} />}
                />
                {previewCert.autoRenewDisabledReason && (
                  <DetailRow
                    label="Auto-Renew Disabled"
                    value={previewCert.autoRenewDisabledReason}
                  />
                )}
                {(previewCert.renewalError || previewCert.distribution?.error) && (
                  <DetailRow
                    label="Issue"
                    value={
                      <span className="break-words text-destructive">
                        {previewCert.renewalError ?? previewCert.distribution?.error}
                      </span>
                    }
                  />
                )}
              </PanelShell>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={renewingCertOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Renewing Certificate</DialogTitle>
            <DialogDescription>{renewingCert?.name}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-4 border border-border bg-muted/20 px-4 py-4">
            <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {renewingCert?.challengeType === "dns-01"
                  ? "Preparing DNS-01 renewal"
                  : "Renewal in progress"}
              </p>
              <p className="text-sm text-muted-foreground">
                {renewingCert?.challengeType === "dns-01"
                  ? "Gateway is creating or checking DNS TXT records and will continue automatically when Cloudflare is configured."
                  : "Gateway is requesting and deploying the renewed certificate."}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={pendingRenewalOpen} onOpenChange={onPendingRenewalOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {pendingRenewal?.operation === "renewal" ? "Verify DNS Renewal" : "Verify DNS Issue"}
            </DialogTitle>
            <DialogDescription>{pendingRenewal?.certName}</DialogDescription>
          </DialogHeader>
          {pendingRenewal && (
            <DNSChallengeVerification
              challenges={pendingRenewal.challenges}
              onVerify={handleVerifyRenewal}
              isVerifying={isVerifyingRenewal}
              title={
                pendingRenewal.operation === "renewal"
                  ? "DNS Renewal Records"
                  : "DNS Challenge Records"
              }
              description={
                pendingRenewal.operation === "renewal"
                  ? "Add or confirm these DNS TXT records, then verify to replace the existing certificate in place."
                  : "Add or confirm these DNS TXT records, then verify to issue the certificate."
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
