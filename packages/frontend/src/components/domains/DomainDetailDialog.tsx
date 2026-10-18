import { ArrowRight, ExternalLink, LoaderCircle, Lock, Truck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable } from "@/components/common/SimpleTable";
import { SwitchCard } from "@/components/common/SwitchCard";
import { DomainIngressPlacementSection } from "@/components/ingress-groups/DomainIngressPlacementSection";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { proxyHostRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import type {
  Domain,
  DomainIngressMigrationImpact,
  DomainNginxNodeOptions,
  DomainWithUsage,
  ResolveCloudflareMigrationRequest,
} from "@/types";
import { DnsStatusBadge } from "./DnsStatusBadge";
import {
  CLOUDFLARE_MIGRATION_LABELS,
  cloudflareTargetDescription,
  dnsRows,
  type IngressMigrationImpactRow,
  type UsageRow,
} from "./domain-detail-helpers";
import { getDomainPermissions } from "./domain-permissions";

/** A check this recent (the list's Check DNS, a reopen) is shown instead of probing again. */
const DNS_RECHECK_AFTER_MS = 60_000;

function checkedRecently(lastDnsCheckAt: string | null) {
  return lastDnsCheckAt !== null && Date.now() - Date.parse(lastDnsCheckAt) < DNS_RECHECK_AFTER_MS;
}

interface DomainDetailDialogProps {
  domainId: string | null;
  /** The list row, so the header is complete while the details still load. */
  listDomain?: Pick<Domain, "domain" | "lastDnsCheckAt"> | null;
  open: boolean;
  initialView?: "details" | "ingress-migration";
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

export function DomainDetailDialog({
  domainId,
  listDomain = null,
  open,
  initialView = "details",
  onOpenChange,
  onUpdated,
}: DomainDetailDialogProps) {
  const { hasScope } = useAuthStore();
  const { canEditDomain: canEdit } = getDomainPermissions(hasScope, domainId);
  const canEditDns = canEdit;
  const [domain, setDomain] = useState<DomainWithUsage | null>(null);
  const [description, setDescription] = useState("");
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [dnsCheckFailed, setDnsCheckFailed] = useState(false);
  const autoCheckedDomainIdRef = useRef<string | null>(null);
  const [isUpdatingProxied, setIsUpdatingProxied] = useState(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<DomainNginxNodeOptions | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [ingressMigrationOpen, setIngressMigrationOpen] = useState(false);
  const [ingressMigrationNodes, setIngressMigrationNodes] = useState<DomainNginxNodeOptions | null>(
    null
  );
  const [ingressMigrationTargetNodeId, setIngressMigrationTargetNodeId] = useState("");
  const [ingressMigrationImpact, setIngressMigrationImpact] =
    useState<DomainIngressMigrationImpact | null>(null);
  const [isLoadingIngressMigration, setIsLoadingIngressMigration] = useState(false);
  const [isMigratingIngress, setIsMigratingIngress] = useState(false);
  const loadedDomainIdRef = useRef<string | null>(null);
  const domainLoadVersionRef = useRef(0);
  const onOpenChangeRef = useRef(onOpenChange);
  const initialIngressMigrationStartedRef = useRef(false);
  onOpenChangeRef.current = onOpenChange;

  const loadDomain = useCallback(async () => {
    if (!domainId || !open) return;
    const initialLoad = loadedDomainIdRef.current !== domainId;
    const loadVersion = ++domainLoadVersionRef.current;
    try {
      const d = await api.getDomain(domainId);
      if (loadVersion !== domainLoadVersionRef.current) return;
      loadedDomainIdRef.current = domainId;
      setDomain(d);
      setDescription(d.description || "");
    } catch {
      if (loadVersion !== domainLoadVersionRef.current) return;
      toast.error("Failed to load domain");
      if (initialLoad) onOpenChangeRef.current(false);
    }
  }, [domainId, open]);

  useEffect(() => {
    void loadDomain();
    return () => {
      domainLoadVersionRef.current += 1;
    };
  }, [loadDomain]);

  useRealtime(open ? "domain.changed" : null, (payload) => {
    const event = payload as { id?: string; action?: string } | undefined;
    if (!domainId || (event?.id && event.id !== domainId)) return;
    if (event?.action === "deleted") {
      onOpenChange(false);
      onUpdated();
      return;
    }
    void loadDomain();
    onUpdated();
  });

  useRealtime(open ? "proxy.host.changed" : null, (payload) => {
    if ((payload as { action?: string } | null)?.action === "health.sampled") return;
    void loadDomain();
    onUpdated();
  });

  useRealtime(open ? "ssl.cert.changed" : null, () => {
    void loadDomain();
    onUpdated();
  });

  const saveIfChanged = async () => {
    if (!domain) return;
    const newDesc = description.trim() || null;
    if (newDesc === (domain.description || null)) return;
    try {
      await api.updateDomain(domain.id, { description: newDesc });
      onUpdated();
    } catch (err) {
      toastApiError(err, "Failed to save domain description");
    }
  };

  const handleClose = (v: boolean) => {
    if (!v) saveIfChanged();
    onOpenChange(v);
  };

  // Read-only probe: opening the details never rewrites a drifted Cloudflare record.
  const checkDns = useCallback(
    async (id: string) => {
      setIsCheckingDns(true);
      setDnsCheckFailed(false);
      try {
        const updated = await api.checkDomainDns(id, { repair: false });
        domainLoadVersionRef.current += 1;
        setDomain((current) =>
          current?.id === updated.id ? { ...current, ...updated, usage: current.usage } : current
        );
        onUpdated();
      } catch {
        setDnsCheckFailed(true);
      } finally {
        setIsCheckingDns(false);
      }
    },
    [onUpdated]
  );

  const handleProxiedChange = async (proxied: boolean) => {
    if (!domain || !canEditDns || proxied === domain.dnsProxied) return;
    setIsUpdatingProxied(true);
    try {
      const updated = await api.updateDomain(domain.id, { proxied });
      domainLoadVersionRef.current += 1;
      setDomain((current) =>
        current?.id === updated.id ? { ...current, ...updated, usage: current.usage } : current
      );
      toast.success(proxied ? "Cloudflare proxy enabled" : "Cloudflare proxy disabled");
      onUpdated();
    } catch (err) {
      toastApiError(err, "Failed to update Cloudflare proxy");
    } finally {
      setIsUpdatingProxied(false);
    }
  };

  const openConflictResolution = async () => {
    if (!domain) return;
    try {
      const options = await api.listDomainNginxNodes();
      setNodeOptions(options);
      const selected = options.eligibleNodes.some((node) => node.id === domain.nginxNodeId)
        ? domain.nginxNodeId
        : options.eligibleNodes[0]?.id;
      setSelectedNodeId(selected || "");
      setResolutionOpen(true);
    } catch (err) {
      toastApiError(err, "Failed to load Ingress nodes");
    }
  };

  const resolveMigration = async (input: ResolveCloudflareMigrationRequest) => {
    if (!domain) return;
    setIsResolving(true);
    try {
      const updated = await api.resolveDomainCloudflareMigration(domain.id, input);
      setDomain(updated);
      setDescription(updated.description || "");
      onUpdated();
      if (updated.dnsProvider === "cloudflare" || input.action === "keep_external") {
        setResolutionOpen(false);
      }
      toast.success(
        updated.dnsProvider === "cloudflare"
          ? "Domain migrated to Cloudflare"
          : input.action === "keep_external"
            ? "External DNS retained"
            : "Cloudflare migration checked"
      );
    } catch (err) {
      toastApiError(err, "Failed to resolve DNS conflict");
    } finally {
      setIsResolving(false);
    }
  };

  const handleUpdateDns = async () => {
    const selectedNode = nodeOptions?.eligibleNodes.find((node) => node.id === selectedNodeId);
    if (!domain || !selectedNode) return;
    const approved = await confirm({
      title: "Update Cloudflare DNS?",
      description: `Change ${domain.domain} from ${
        [...(domain.dnsRecords?.a ?? []), ...(domain.dnsRecords?.aaaa ?? [])].join(", ") ||
        "no address record"
      } to ${selectedNode.effectiveAddress} and migrate it to Opfield management?`,
      confirmLabel: "Update DNS and migrate",
      variant: "default",
    });
    if (approved) {
      await resolveMigration({ action: "update_dns", nginxNodeId: selectedNode.id });
    }
  };

  const handleKeepExternal = async () => {
    if (!domain) return;
    const approved = await confirm({
      title: "Keep External DNS?",
      description: `Stop trying to migrate ${domain.domain} to Cloudflare. Opfield will continue checking its external DNS health.`,
      confirmLabel: "Keep external DNS",
      variant: "default",
    });
    if (approved) await resolveMigration({ action: "keep_external" });
  };

  const openIngressMigration = useCallback(async () => {
    if (!domain) return;
    setIsLoadingIngressMigration(true);
    try {
      const options = await api.listDomainNginxNodes();
      const pendingTargetId = domain.ingressMigrationId ? domain.nginxNodeId : null;
      const target = pendingTargetId
        ? options.eligibleNodes.find((node) => node.id === pendingTargetId)
        : options.eligibleNodes.find((node) => node.id !== domain.nginxNodeId);
      if (!target) {
        toast.error("No other eligible Ingress node is available");
        if (initialView === "ingress-migration") onOpenChange(false);
        return;
      }
      setIngressMigrationNodes(options);
      setIngressMigrationTargetNodeId(target.id);
      setIngressMigrationOpen(true);
      setIngressMigrationImpact(await api.previewDomainIngressMigration(domain.id, target.id));
    } catch (err) {
      toastApiError(err, "Failed to prepare ingress migration");
      if (initialView === "ingress-migration") onOpenChange(false);
    } finally {
      setIsLoadingIngressMigration(false);
    }
  }, [domain, initialView, onOpenChange]);

  useEffect(() => {
    if (!open) {
      initialIngressMigrationStartedRef.current = false;
      return;
    }
    if (
      initialView !== "ingress-migration" ||
      !domain ||
      initialIngressMigrationStartedRef.current
    ) {
      return;
    }
    initialIngressMigrationStartedRef.current = true;
    void openIngressMigration();
  }, [domain, initialView, open, openIngressMigration]);

  const changeIngressMigrationTarget = async (targetNodeId: string) => {
    if (!domain) return;
    setIngressMigrationTargetNodeId(targetNodeId);
    setIsLoadingIngressMigration(true);
    try {
      setIngressMigrationImpact(await api.previewDomainIngressMigration(domain.id, targetNodeId));
    } catch (err) {
      toastApiError(err, "Failed to preview ingress migration");
    } finally {
      setIsLoadingIngressMigration(false);
    }
  };

  const handleMigrateIngress = async () => {
    if (!domain || !ingressMigrationTargetNodeId) return;
    setIsMigratingIngress(true);
    try {
      const result = await api.migrateDomainIngress(domain.id, ingressMigrationTargetNodeId);
      setIngressMigrationImpact(result);
      await loadDomain();
      onUpdated();
      if (result.status === "completed") {
        setIngressMigrationOpen(false);
        if (initialView === "ingress-migration") onOpenChange(false);
        toast.success("Ingress migration completed");
      } else if (result.status === "waiting_dns") {
        toast.info("Update external DNS, then complete the migration");
      } else {
        toast.warning("Source cleanup is pending");
      }
    } catch (err) {
      toastApiError(err, "Ingress migration failed");
      // Something changed since the preview: show what blocks the move now.
      if (err instanceof ApiRequestError && err.code === "DOMAIN_INGRESS_MIGRATION_BLOCKED") {
        await api
          .previewDomainIngressMigration(domain.id, ingressMigrationTargetNodeId)
          .then(setIngressMigrationImpact)
          .catch(() => undefined);
      }
    } finally {
      setIsMigratingIngress(false);
    }
  };

  const selectedNode = nodeOptions?.eligibleNodes.find((node) => node.id === selectedNodeId);
  const ingressMigrationTarget = ingressMigrationNodes?.eligibleNodes.find(
    (node) => node.id === ingressMigrationTargetNodeId
  );
  const ingressMigrationDnsBlocked = Boolean(
    (ingressMigrationImpact?.status === "ready" || ingressMigrationImpact?.status === "blocked") &&
      ingressMigrationImpact.requiresExternalDnsBeforeMove &&
      ingressMigrationImpact.domains.some(
        (item) => item.dnsProvider === "external" && item.dnsStatus !== "valid"
      )
  );
  // External DNS has its own panel below; every other issue is listed before Start.
  const ingressMigrationIssues = (ingressMigrationImpact?.issues ?? []).filter(
    (issue) => issue.code !== "DOMAIN_INGRESS_EXTERNAL_DNS_NOT_READY"
  );
  const ingressMigrationBlocked = ingressMigrationImpact?.status === "blocked";
  const currentAddress = domain
    ? [...(domain.dnsRecords?.a ?? []), ...(domain.dnsRecords?.aaaa ?? [])].join(", ") ||
      "No address record"
    : "";
  const detailsReady = Boolean(domain && domainId && loadedDomainIdRef.current === domainId);
  const headerDomain = detailsReady ? domain : listDomain;
  const showsDetails = open && initialView === "details";

  // The details check DNS once per opening (editors only; the check needs
  // domains:edit), so the records shown are current without a Check button.
  useEffect(() => {
    if (!showsDetails) {
      autoCheckedDomainIdRef.current = null;
      return;
    }
    if (!detailsReady || !domain || !canEditDns) return;
    if (autoCheckedDomainIdRef.current === domain.id) return;
    autoCheckedDomainIdRef.current = domain.id;
    if (checkedRecently(domain.lastDnsCheckAt)) return;
    void checkDns(domain.id);
  }, [canEditDns, checkDns, detailsReady, domain, showsDetails]);

  return (
    <>
      <Dialog
        open={open && initialView === "details" && !resolutionOpen && !ingressMigrationOpen}
        onOpenChange={handleClose}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{headerDomain?.domain ?? "Domain"}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {headerDomain?.lastDnsCheckAt ? (
              <>
                Last checked <RelativeTime value={headerDomain.lastDnsCheckAt} />
              </>
            ) : (
              "DNS not checked yet"
            )}
          </DialogDescription>

          <ContentLoading loading={!detailsReady} />
          {detailsReady && domain ? (
            <div className="space-y-4">
              {/* Description */}
              {canEdit && (
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              )}
              {!canEdit && domain.description && (
                <p className="text-sm text-muted-foreground">{domain.description}</p>
              )}

              {domain.dnsProvider === "cloudflare" && (
                <SwitchCard
                  label="Proxied"
                  description="Serve the domain through the Cloudflare proxy."
                  checked={!!domain.dnsProxied}
                  onCheckedChange={handleProxiedChange}
                  disabled={!canEditDns || isUpdatingProxied}
                />
              )}

              <PanelShell title="DNS Management">
                <SettingsControlRow title="Provider">
                  <span className="text-right text-sm">
                    {domain.dnsProvider === "cloudflare" ? "Cloudflare" : "External DNS"}
                  </span>
                </SettingsControlRow>
                {domain.dnsProvider === "legacy" && domain.cloudflareMigrationStatus && (
                  <SettingsControlRow
                    title="Cloudflare migration"
                    description={
                      domain.cloudflareMigrationCheckedAt ? (
                        <>
                          Last checked <RelativeTime value={domain.cloudflareMigrationCheckedAt} />
                        </>
                      ) : undefined
                    }
                  >
                    {domain.cloudflareMigrationStatus === "dns_conflict" && canEdit ? (
                      <Button
                        variant="link"
                        className="h-auto p-0"
                        onClick={openConflictResolution}
                      >
                        Resolve conflict
                        <ArrowRight />
                      </Button>
                    ) : (
                      <span className="text-right text-sm">
                        {CLOUDFLARE_MIGRATION_LABELS[domain.cloudflareMigrationStatus]}
                      </span>
                    )}
                  </SettingsControlRow>
                )}
              </PanelShell>

              <PanelShell
                title={
                  <div className="flex items-center gap-2">
                    <span>DNS</span>
                    <DnsStatusBadge status={domain.dnsStatus} />
                  </div>
                }
                actions={
                  isCheckingDns ? (
                    <span
                      role="status"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      Checking…
                    </span>
                  ) : dnsCheckFailed ? (
                    <span className="text-xs text-muted-foreground">
                      Check failed; showing the last result
                    </span>
                  ) : null
                }
              >
                {domain.dnsRecords && dnsRows(domain.dnsRecords).length > 0 ? (
                  dnsRows(domain.dnsRecords).map((row) => (
                    <SettingsControlRow
                      key={row.type}
                      title={row.type}
                      className="sm:grid-cols-[minmax(5rem,8rem)_minmax(0,1fr)]"
                      controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                    >
                      <span className="min-w-0 max-w-full break-all text-right text-sm">
                        {row.values.join(", ")}
                      </span>
                    </SettingsControlRow>
                  ))
                ) : (
                  <EmptyState
                    message={
                      domain.dnsRecords
                        ? "No DNS records found"
                        : isCheckingDns
                          ? "Checking DNS records…"
                          : "DNS has not been checked yet"
                    }
                    embedded
                  />
                )}
              </PanelShell>

              {domain.dnsProvider === "cloudflare" && domain.dnsProxied && (
                <PanelShell title="Cloudflare Target">
                  <SettingsControlRow title="Ingress node">
                    <span className="min-w-0 truncate text-right text-sm">
                      {domain.nginxNode
                        ? domain.nginxNode.displayName || domain.nginxNode.hostname
                        : "Not assigned"}
                    </span>
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="IP address"
                    description={cloudflareTargetDescription(domain)}
                    controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                  >
                    <span className="min-w-0 max-w-full break-all text-right text-sm">
                      {domain.dnsTargetIps.length > 0
                        ? domain.dnsTargetIps.join(", ")
                        : "Not assigned"}
                    </span>
                  </SettingsControlRow>
                </PanelShell>
              )}

              <DomainIngressPlacementSection
                domain={domain}
                canEdit={canEdit}
                onChanged={() => {
                  void loadDomain();
                  onUpdated();
                }}
              />

              <PanelShell title="Usage" bodyClassName="min-w-0">
                <SimpleTable<UsageRow>
                  rows={[
                    ...domain.usage.proxyHosts.map(
                      (value): UsageRow => ({ key: `proxy-${value.id}`, type: "Route", value })
                    ),
                    ...domain.usage.sslCertificates.map(
                      (value): UsageRow => ({
                        key: `certificate-${value.id}`,
                        type: "SSL Certificate",
                        value,
                      })
                    ),
                  ]}
                  columns={[
                    {
                      id: "type",
                      header: "Type",
                      cellClassName: "whitespace-nowrap text-muted-foreground",
                      render: (row) => row.type,
                    },
                    {
                      id: "target",
                      header: "Target",
                      render: (row) =>
                        row.type === "Route" ? (
                          <Link
                            to={proxyHostRoute(row.value.slug)}
                            onClick={() => handleClose(false)}
                            className="flex min-w-0 items-center gap-2 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{row.value.domainNames[0]}</span>
                            {!row.value.enabled && (
                              <Badge variant="secondary" size="inline">
                                Off
                              </Badge>
                            )}
                          </Link>
                        ) : (
                          <div className="flex min-w-0 items-center gap-2">
                            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{row.value.domainNames[0]}</span>
                            <Badge
                              variant={row.value.status === "active" ? "success" : "secondary"}
                              size="inline"
                            >
                              {row.value.status}
                            </Badge>
                          </div>
                        ),
                    },
                  ]}
                  getRowKey={(row) => row.key}
                  emptyMessage="Not used by any routes or certificates"
                />
              </PanelShell>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={resolutionOpen} onOpenChange={setResolutionOpen}>
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Resolve Cloudflare DNS Conflict</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <PanelShell title="DNS conflict">
              <div className="divide-y divide-border">
                <DetailRow label="Current DNS" value={currentAddress} />
                <DetailRow
                  label="Required target"
                  value={selectedNode?.effectiveAddress || "Select a node"}
                />
              </div>
            </PanelShell>

            <PanelShell title="Routing">
              <SettingsControlRow title="Ingress node" description="Public ingress for this domain">
                <Select
                  value={selectedNodeId}
                  onValueChange={setSelectedNodeId}
                  disabled={isResolving}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue>
                      {selectedNode?.displayName || selectedNode?.hostname || "Select a node"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {nodeOptions?.eligibleNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname} · {node.effectiveAddress}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </PanelShell>

            <PanelShell title="Other actions">
              <SettingsControlRow
                title="Retry"
                description="Recheck Cloudflare after correcting DNS manually"
              >
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={isResolving}
                  onClick={() => resolveMigration({ action: "retry" })}
                >
                  Retry <ArrowRight />
                </Button>
              </SettingsControlRow>
              <SettingsControlRow
                title="Keep external DNS"
                description="Stop automatic Cloudflare migration for this domain"
              >
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={isResolving}
                  onClick={handleKeepExternal}
                >
                  Keep external DNS <ArrowRight />
                </Button>
              </SettingsControlRow>
            </PanelShell>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResolutionOpen(false)}
              disabled={isResolving}
            >
              Cancel
            </Button>
            <Button onClick={handleUpdateDns} disabled={!selectedNode} pending={isResolving}>
              Update DNS and migrate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ingressMigrationOpen}
        onOpenChange={(nextOpen) => {
          if (isMigratingIngress) return;
          setIngressMigrationOpen(nextOpen);
          if (!nextOpen && initialView === "ingress-migration") onOpenChange(false);
        }}
      >
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Move Ingress</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <ContentLoading loading={isLoadingIngressMigration} />
            <PanelShell title="Routing">
              <SettingsControlRow title="Source node">
                <span className="text-right text-sm">
                  {ingressMigrationImpact?.sourceNode.displayName ||
                    ingressMigrationImpact?.sourceNode.hostname ||
                    domain?.nginxNode?.displayName ||
                    domain?.nginxNode?.hostname ||
                    "Not assigned"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Target node" description="New public ingress">
                <Select
                  value={ingressMigrationTargetNodeId}
                  onValueChange={changeIngressMigrationTarget}
                  disabled={isMigratingIngress || Boolean(domain?.ingressMigrationId)}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue>
                      {ingressMigrationTarget?.displayName ||
                        ingressMigrationTarget?.hostname ||
                        "Select a node"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ingressMigrationNodes?.eligibleNodes
                      .filter(
                        (node) =>
                          node.id !== domain?.nginxNodeId || Boolean(domain?.ingressMigrationId)
                      )
                      .map((node) => (
                        <SelectItem key={node.id} value={node.id}>
                          {node.displayName || node.hostname} · {node.effectiveAddress}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </PanelShell>

            {ingressMigrationImpact ? (
              <PanelShell title="Impact" bodyClassName="min-w-0">
                <SimpleTable<IngressMigrationImpactRow>
                  rows={[
                    ...ingressMigrationImpact.domains.map(
                      (item): IngressMigrationImpactRow => ({
                        key: `domain-${item.id}`,
                        type: "Domain",
                        target: item.domain,
                      })
                    ),
                    ...ingressMigrationImpact.proxyHosts.map(
                      (item): IngressMigrationImpactRow => ({
                        key: `proxy-${item.id}`,
                        type: "Route",
                        target: item.domainNames[0] || item.slug,
                      })
                    ),
                  ]}
                  columns={[
                    {
                      id: "type",
                      header: "Type",
                      cellClassName: "whitespace-nowrap text-muted-foreground",
                      render: (row) => row.type,
                    },
                    { id: "target", header: "Target", render: (row) => row.target },
                  ]}
                  getRowKey={(row) => row.key}
                  emptyMessage="No linked routes"
                />
              </PanelShell>
            ) : null}

            {ingressMigrationIssues.length > 0 ? (
              <div className="space-y-2">
                {ingressMigrationIssues.map((issue) => (
                  <Notice
                    key={`${issue.severity}-${issue.code}-${issue.resourceId}-${issue.message}`}
                    tone={issue.severity === "blocker" ? "destructive" : "warning"}
                    title={issue.message}
                  >
                    {issue.fix}
                  </Notice>
                ))}
              </div>
            ) : null}

            {ingressMigrationImpact?.domains.some((item) => item.dnsProvider === "external") ? (
              <PanelShell title="External DNS">
                {ingressMigrationImpact.domains
                  .filter((item) => item.dnsProvider === "external")
                  .map((item) => (
                    <SettingsControlRow
                      key={item.id}
                      title={item.domain}
                      description={
                        item.dnsStatus === "valid"
                          ? "Ready"
                          : ingressMigrationImpact.requiresExternalDnsBeforeMove
                            ? "Point DNS to the target before starting"
                            : "Point DNS to the target before completing"
                      }
                      controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                    >
                      <span className="break-all text-right text-sm">
                        {ingressMigrationImpact.targetIps.join(", ")}
                      </span>
                    </SettingsControlRow>
                  ))}
              </PanelShell>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIngressMigrationOpen(false);
                if (initialView === "ingress-migration") onOpenChange(false);
              }}
              disabled={isMigratingIngress}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMigrateIngress}
              disabled={
                !ingressMigrationImpact || ingressMigrationDnsBlocked || ingressMigrationBlocked
              }
              pending={isMigratingIngress || isLoadingIngressMigration}
            >
              <Truck className="h-4 w-4" />
              {ingressMigrationImpact?.status === "waiting_dns"
                ? "Check DNS and complete"
                : ingressMigrationImpact?.status === "cleanup_pending"
                  ? "Retry cleanup"
                  : "Move ingress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
