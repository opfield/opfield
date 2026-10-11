import {
  ArrowRight,
  FolderPlus,
  Globe,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Shield,
  Trash2,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { AddDomainDialog } from "@/components/domains/AddDomainDialog";
import { DomainCertificateFolderDialog } from "@/components/domains/DomainCertificateFolderDialog";
import { DomainDetailDialog } from "@/components/domains/DomainDetailDialog";
import { getDomainPermissions } from "@/components/domains/domain-permissions";
import { CreateProxyHostDialog } from "@/components/proxy/CreateProxyHostDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { hasCreationDestination } from "@/lib/creation-folders";
import { canCreateInFolder } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { Domain, DomainDnsConflictDetails, DomainNginxNodeOptions } from "@/types";

const DOMAIN_FOLDER_LIST_CACHE_KEY = "domains:list:folder-view";
const DIALOG_PAYLOAD_CLEAR_DELAY_MS = 260;

type DomainCreationBlocker = "no_nodes" | "no_public_address";
export type DomainHealthStatus = "healthy" | "warning" | "error";

const DOMAIN_HEALTH_BADGE: Record<
  DomainHealthStatus,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  healthy: { label: "Healthy", variant: "success" },
  warning: { label: "Warning", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
};

export function getDomainHealthStatus(
  domain: Pick<Domain, "dnsStatus" | "cloudflareMigrationStatus">
): DomainHealthStatus {
  if (domain.dnsStatus === "invalid") return "error";
  if (domain.dnsStatus === "valid") return "healthy";
  return "warning";
}

function DomainHealthBadge({ domain }: { domain: Domain }) {
  const health = getDomainHealthStatus(domain);
  const config = DOMAIN_HEALTH_BADGE[health];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

const DOMAIN_CREATION_BLOCKER_COPY: Record<
  DomainCreationBlocker,
  { title: string; description: string; actionLabel: string; href: string }
> = {
  no_nodes: {
    title: "No Ingress Nodes",
    description:
      "A domain must be assigned to an Ingress node that accepts incoming traffic. Add and connect an Ingress node first; Opfield will use its detected public service address as the DNS target. You can review or change that address in the node's Settings before returning here.",
    actionLabel: "Open Nodes",
    href: "/nodes",
  },
  no_public_address: {
    title: "No Public Ingress Addresses",
    description:
      "Opfield found Ingress nodes, but none currently reports a public service address that can be used as the DNS target. Open a node's Settings and choose Automatic or one of the detected public addresses. Nodes that expose only private addresses cannot be assigned to a domain.",
    actionLabel: "Open Nodes",
    href: "/nodes",
  },
};

export function getDomainCreationBlocker(
  options: DomainNginxNodeOptions
): DomainCreationBlocker | null {
  if (options.totalNginxNodes === 0) return "no_nodes";
  if (options.eligibleNodes.length === 0) return "no_public_address";
  return null;
}

export function Domains() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDomainName = searchParams.get("domain");
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const userScopes = user?.scopes ?? [];
  const { canCreateDomain, canInspectCloudflare } = getDomainPermissions(
    hasScope,
    undefined,
    hasScopedAccess
  );
  // Issuing from a domain creates an SSL certificate: any ssl:cert:issue destination
  // (broad or folder) qualifies; the folder is picked when the root is not allowed.
  const canIssueDomainCertificates = hasCreationDestination(userScopes, "ssl:cert:issue");
  const canIssueCertificateAtRoot = canCreateInFolder(userScopes, "ssl:cert:issue", null);
  const hasRouteFolderCreationGrant = userScopes.some((scope) =>
    scope.startsWith("proxy:create:folder/")
  );
  const [issueCertDomain, setIssueCertDomain] = useState<Domain | null>(null);
  const hasCloudflareIntegration = useUIBootstrapStore(
    (state) => state.snapshot?.navigation.hasCloudflareIntegration ?? false
  );

  const cachedDomains = api.getCached<{ data: Domain[] }>(DOMAIN_FOLDER_LIST_CACHE_KEY);
  const [domains, setDomains] = useState<Domain[]>(cachedDomains?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cachedDomains);
  const [cloudflareReady, setCloudflareReady] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DomainHealthStatus | "all">("all");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDnsProvider, setAddDnsProvider] = useState<"cloudflare" | "external">("cloudflare");
  const [cloudflareChoiceOpen, setCloudflareChoiceOpen] = useState(false);
  const [creationBlocker, setCreationBlocker] = useState<DomainCreationBlocker | null>(null);
  const [creationBlockerOpen, setCreationBlockerOpen] = useState(false);
  const creationBlockerClearTimerRef = useRef<number | null>(null);
  const [checkingNginxNodes, setCheckingNginxNodes] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailInitialView, setDetailInitialView] = useState<"details" | "ingress-migration">(
    "details"
  );
  const [routeCreateDomain, setRouteCreateDomain] = useState<Pick<
    Domain,
    "domain" | "nginxNodeId" | "ingressGroupId"
  > | null>(null);
  const cloudflareConfigured = cloudflareReady ?? hasCloudflareIntegration;
  const creationBlockerCopy = creationBlocker
    ? DOMAIN_CREATION_BLOCKER_COPY[creationBlocker]
    : null;

  const openCreationBlocker = useCallback((blocker: DomainCreationBlocker) => {
    if (creationBlockerClearTimerRef.current !== null) {
      window.clearTimeout(creationBlockerClearTimerRef.current);
      creationBlockerClearTimerRef.current = null;
    }
    setCreationBlocker(blocker);
    setCreationBlockerOpen(true);
  }, []);

  const closeCreationBlocker = useCallback(() => {
    setCreationBlockerOpen(false);
    if (creationBlockerClearTimerRef.current !== null) {
      window.clearTimeout(creationBlockerClearTimerRef.current);
    }
    creationBlockerClearTimerRef.current = window.setTimeout(() => {
      setCreationBlocker(null);
      creationBlockerClearTimerRef.current = null;
    }, DIALOG_PAYLOAD_CLEAR_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (creationBlockerClearTimerRef.current !== null) {
        window.clearTimeout(creationBlockerClearTimerRef.current);
      }
    },
    []
  );

  const loadDomains = useCallback(async () => {
    try {
      const [result, connectors] = await Promise.all([
        api.listDomains({
          page: 1,
          limit: 1000,
        }),
        canInspectCloudflare
          ? api.listCloudflareConnectors({ enabled: true }).catch(() => [])
          : Promise.resolve(null),
      ]);
      setCloudflareReady(
        connectors === null
          ? null
          : connectors.some(
              (connector) =>
                connector.enabled &&
                connector.syncStatus !== "error" &&
                (connector.zones?.length ?? 0) > 0
            )
      );
      setDomains(result.data);
      api.setCache(DOMAIN_FOLDER_LIST_CACHE_KEY, result);
    } catch {
      toast.error("Failed to load domains");
    } finally {
      setIsLoading(false);
    }
  }, [canInspectCloudflare]);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  useRealtime("domain.changed", () => {
    loadDomains();
  });

  useRealtime("proxy.host.changed", (payload) => {
    if ((payload as { action?: string } | null)?.action === "health.sampled") return;
    loadDomains();
  });

  useRealtime("ssl.cert.changed", () => {
    loadDomains();
  });

  useRealtime("integration.connector.changed", () => {
    loadDomains();
  });

  const handleAddDomain = async () => {
    if (checkingNginxNodes) return;
    setCheckingNginxNodes(true);
    try {
      const options = await api.listDomainNginxNodes();
      const blocker = getDomainCreationBlocker(options);
      if (blocker) {
        openCreationBlocker(blocker);
        return;
      }
      if (!cloudflareConfigured) {
        setCloudflareChoiceOpen(true);
        return;
      }
      setAddDnsProvider("cloudflare");
      setAddDialogOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load Ingress nodes");
    } finally {
      setCheckingNginxNodes(false);
    }
  };

  const handleCheckDns = async (d: Domain) => {
    try {
      await api.checkDomainDns(d.id);
      toast.success(`DNS check complete for ${d.domain}`);
      loadDomains();
    } catch {
      toast.error("DNS check failed");
    }
  };

  const issueCertificate = async (d: Domain, folderId: string | null) => {
    try {
      await api.issueDomainCert(d.id, folderId);
      toast.success(`Certificate issued for ${d.domain}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue cert");
    }
  };

  const handleIssueCert = async (d: Domain) => {
    if (!canIssueCertificateAtRoot) {
      setIssueCertDomain(d);
      return;
    }
    await issueCertificate(d, null);
  };

  const handleDelete = async (d: Domain) => {
    let deleteDns: boolean | undefined;
    if (d.dnsProvider === "cloudflare" && d.dnsOwnership === "matched_existing") {
      const ok = await confirm({
        title: "Delete Domain Mapping",
        description: `Remove "${d.domain}" from Opfield? The matched existing Cloudflare DNS record will be kept.`,
        confirmLabel: "Remove Mapping",
        cancelLabel: "Cancel",
        variant: "default",
      });
      if (!ok) return;
      deleteDns = false;
    } else {
      const ok = await confirm({
        title: "Delete Domain",
        description:
          d.dnsProvider === "cloudflare"
            ? `Delete "${d.domain}" and its Opfield-managed Cloudflare DNS records?`
            : `Are you sure you want to delete "${d.domain}"? This won't affect routes or certificates using this domain.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
    }
    try {
      await api.deleteDomain(d.id, deleteDns === undefined ? undefined : { deleteDns });
      toast.success("Domain deleted");
      loadDomains();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "DOMAIN_DNS_DELETE_CHOICE_REQUIRED") {
        const details = err.details as DomainDnsConflictDetails | undefined;
        const ok = await confirm({
          title: "Delete Cloudflare DNS Too?",
          description: `This domain was adopted from existing Cloudflare records. Delete those DNS records as well?${details?.recordIds?.length ? ` Records: ${details.recordIds.join(", ")}` : ""}`,
          confirmLabel: "Delete DNS",
          cancelLabel: "Keep DNS",
          variant: "destructive",
        });
        try {
          await api.deleteDomain(d.id, { deleteDns: ok });
          toast.success("Domain deleted");
          loadDomains();
        } catch (retryErr) {
          toast.error(retryErr instanceof Error ? retryErr.message : "Failed to delete domain");
        }
        return;
      }
      const msg = err instanceof Error ? err.message : "Failed to delete domain";
      if (msg.includes("in use")) {
        toast.error("Cannot delete: domain is used by routes. Remove it from routes first.");
      } else if (msg.includes("System")) {
        toast.error("System domains cannot be deleted.");
      } else {
        toast.error(msg);
      }
    }
  };

  const openDetail = (id: string, initialView: "details" | "ingress-migration" = "details") => {
    setDetailId(id);
    setDetailInitialView(initialView);
    setDetailOpen(true);
  };

  useEffect(() => {
    if (!requestedDomainName || isLoading) return;
    const requested = requestedDomainName.trim().toLowerCase();
    const matchingDomain = domains.find((domain) => domain.domain.toLowerCase() === requested);
    if (matchingDomain) {
      setDetailId(matchingDomain.id);
      setDetailInitialView("details");
      setDetailOpen(true);
    } else {
      setSearch(requestedDomainName);
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("domain");
    setSearchParams(nextParams, { replace: true });
  }, [domains, isLoading, requestedDomainName, searchParams, setSearchParams]);

  const hasActiveFilters = search.trim() !== "" || statusFilter !== "all";
  const filteredDomains = useMemo(() => {
    const query = search.trim().toLowerCase();
    return domains.filter((domain) => {
      if (statusFilter !== "all" && getDomainHealthStatus(domain) !== statusFilter) return false;
      if (!query) return true;
      return [domain.domain, domain.description].some((value) =>
        value?.toLowerCase().includes(query)
      );
    });
  }, [domains, search, statusFilter]);
  const canManageFolders = useCanManageSomeFolders("domains:folders:manage");
  const domainColumns: ResourceListColumn<Domain>[] = [
    {
      id: "domain",
      label: "Domain",
      renderCell: (d) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{d.domain}</span>
            {d.isSystem && (
              <Badge variant="outline" size="inline">
                System
              </Badge>
            )}
          </div>
          {d.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{d.description}</p>
          )}
        </div>
      ),
    },
    {
      id: "health",
      label: "Health",
      align: "right",
      width: "7rem",
      renderCell: (d) => <DomainHealthBadge domain={d} />,
    },
    {
      id: "ssl",
      label: "SSL",
      align: "right",
      width: "4.5rem",
      renderCell: (d) =>
        d.sslCertCount ? (
          <Badge variant="secondary">{d.sslCertCount}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
    {
      id: "proxyHosts",
      label: "Routes",
      align: "right",
      width: "5.5rem",
      renderCell: (d) =>
        d.proxyHostCount ? (
          <Badge variant="secondary">{d.proxyHostCount}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
    {
      id: "added",
      label: "Added",
      align: "right",
      width: "7.5rem",
      renderCell: (d) => (
        <RelativeTime value={d.createdAt} className="text-sm text-muted-foreground" />
      ),
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (d) => {
        const permissions = getDomainPermissions(hasScope, d.id);
        const canCheckDns = permissions.canEditDomain;
        // Issuing changes nothing on the domain: viewing it (every listed row) is enough.
        const canIssueCert = canIssueDomainCertificates;
        const canCreateRoute =
          hasRouteFolderCreationGrant ||
          canCreateInFolder(userScopes, "proxy:create", null, d.nginxNodeId ?? undefined);
        const canDeleteRow = !d.isSystem && permissions.canDeleteDomain;
        if (!canCheckDns && !canIssueCert && !canCreateRoute && !canDeleteRow) return null;
        return (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Domain actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canCheckDns && (
                  <DropdownMenuItem onClick={() => handleCheckDns(d)}>
                    <RefreshCw className="h-4 w-4" />
                    Check DNS
                  </DropdownMenuItem>
                )}
                {/* A domain on an ingress group moves from its detail view (Ingress panel). */}
                {canCheckDns && !d.ingressGroupId && (
                  <DropdownMenuItem onClick={() => openDetail(d.id, "ingress-migration")}>
                    <Truck className="h-4 w-4" />
                    {d.ingressMigrationId ? "Complete migration" : "Move ingress"}
                  </DropdownMenuItem>
                )}
                {canCreateRoute && d.nginxNodeId && (
                  <DropdownMenuItem onClick={() => setRouteCreateDomain(d)}>
                    <RouteIcon className="h-4 w-4" />
                    Create route
                  </DropdownMenuItem>
                )}
                {canIssueCert && !d.dnsProxied && d.dnsStatus === "valid" && !d.sslCertCount && (
                  <DropdownMenuItem onClick={() => handleIssueCert(d)}>
                    <Shield className="h-4 w-4" />
                    Issue Cert
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => openDetail(d.id)}>
                  <Pencil className="h-4 w-4" />
                  Details
                </DropdownMenuItem>
                {canDeleteRow && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleDelete(d)} className="text-destructive">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
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
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Domains"
          description="Manage public hostnames and ingress placement"
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
                ...(canCreateDomain
                  ? [
                      {
                        label: "Add Domain",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => void handleAddDomain(),
                        disabled: checkingNginxNodes,
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
              {canCreateDomain && (
                <Button onClick={() => void handleAddDomain()} pending={checkingNginxNodes}>
                  <Plus className="h-4 w-4" />
                  Add Domain
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <FolderedResourceList<Domain>
          resourceType="domain"
          realtimeChannel="domain.changed"
          resources={filteredDomains}
          columns={domainColumns}
          search={{
            placeholder: "Search domains...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters,
            onReset: () => {
              setSearch("");
              setStatusFilter("all");
            },
            filters: (
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as DomainHealthStatus | "all")}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Health" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="healthy">Healthy</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            ),
          }}
          loading={isLoading}
          loadingLabel="Loading domains..."
          emptyState={
            <EmptyState
              message="No domains."
              actionLabel={canCreateDomain ? "Add one" : undefined}
              onAction={canCreateDomain ? () => void handleAddDomain() : undefined}
              hasActiveFilters={hasActiveFilters}
              onReset={() => {
                setSearch("");
                setStatusFilter("all");
              }}
            />
          }
          minWidth={800}
          canManageFolders={canManageFolders}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(domain) => domain.domain}
          onItemClick={(domain) => openDetail(domain.id)}
          onRefresh={loadDomains}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />

        <AddDomainDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onCreated={loadDomains}
          dnsProvider={addDnsProvider}
        />
        <Dialog open={cloudflareChoiceOpen} onOpenChange={setCloudflareChoiceOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Configure Cloudflare DNS</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Cloudflare can create and maintain the DNS records for this domain automatically. You
              can also continue with external DNS after pointing the domain at the selected Ingress
              node yourself.
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setCloudflareChoiceOpen(false);
                  setAddDnsProvider("external");
                  setAddDialogOpen(true);
                }}
              >
                Continue without Cloudflare
              </Button>
              {canInspectCloudflare && (
                <Button asChild>
                  <Link to="/settings/integrations" onClick={() => setCloudflareChoiceOpen(false)}>
                    Configure Cloudflare <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={creationBlockerOpen}
          onOpenChange={(open) => {
            if (open) setCreationBlockerOpen(true);
            else closeCreationBlocker();
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{creationBlockerCopy?.title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{creationBlockerCopy?.description}</p>
            <DialogFooter>
              <Button variant="outline" onClick={closeCreationBlocker}>
                Close
              </Button>
              {creationBlockerCopy && (
                <Button asChild>
                  <Link to={creationBlockerCopy.href} onClick={closeCreationBlocker}>
                    {creationBlockerCopy.actionLabel} <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <DomainDetailDialog
          domainId={detailId}
          listDomain={domains.find((domain) => domain.id === detailId) ?? null}
          open={detailOpen}
          initialView={detailInitialView}
          onOpenChange={(nextOpen) => {
            setDetailOpen(nextOpen);
            if (!nextOpen) setDetailInitialView("details");
          }}
          onUpdated={loadDomains}
        />
        <DomainCertificateFolderDialog
          open={issueCertDomain !== null}
          onOpenChange={(open) => {
            if (!open) setIssueCertDomain(null);
          }}
          domainName={issueCertDomain?.domain ?? null}
          onIssue={async (folderId) => {
            if (issueCertDomain) await issueCertificate(issueCertDomain, folderId);
          }}
        />
        <CreateProxyHostDialog
          open={routeCreateDomain !== null}
          onOpenChange={(open) => {
            if (!open) setRouteCreateDomain(null);
          }}
          initialDomainName={routeCreateDomain?.domain}
          initialNodeId={
            routeCreateDomain?.ingressGroupId
              ? undefined
              : (routeCreateDomain?.nginxNodeId ?? undefined)
          }
          initialIngressGroupId={routeCreateDomain?.ingressGroupId ?? undefined}
          onSuccess={() => {
            setRouteCreateDomain(null);
            void loadDomains();
          }}
        />
      </div>
    </PageTransition>
  );
}
