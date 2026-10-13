import { FolderPlus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CertificateIssueDialog } from "@/components/certificates/CertificateIssueDialog";
import { IssuingCABadge } from "@/components/certificates/IssuingCABadge";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { HubTabPanel, HubTabs } from "@/components/common/HubTabs";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { StatusBadge } from "@/components/common/StatusBadge";
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
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useLiveSearch } from "@/hooks/use-live-search";
import { useRealtime } from "@/hooks/use-realtime";
import { cn, daysUntil, formatDate, hoursUntil } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useCertificatesStore } from "@/stores/certificates";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { useUIStore } from "@/stores/ui";
import type { Certificate, CertificateStatus, CertificateType } from "@/types";

const statusOptions: { value: CertificateStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

const typeOptions: { value: CertificateType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "tls-server", label: "TLS Server" },
  { value: "tls-client", label: "TLS Client" },
  { value: "code-signing", label: "Code Signing" },
  { value: "email", label: "Email" },
];

export function Certificates() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const { cas, fetchCAs } = useCAStore();
  const {
    certificates,
    error,
    isLoading,
    isLoadingMore,
    filters,
    hasMore,
    total,
    fetchCertificates,
    fetchNextPage,
    setFilters,
    resetFilters,
  } = useCertificatesStore();
  const [searchInput, setSearchInput] = useState(filters.search);
  // The list follows the search as it is typed; Enter applies it at once.
  useLiveSearch(searchInput, filters.search, (search) => setFilters({ search }));
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const openIssueDialog = () => {
    if (!requireLicenseFeature("internal-pki", "Internal PKI certificates")) return;
    setIssueDialogOpen(true);
  };
  // The CA list names the issuing CA and feeds the CA filter and the issue dialog.
  const canListCAs = hasScopedAccess("pki:ca:view") || hasScopedAccess("pki:cert:issue");

  useEffect(() => {
    void showSystemCertificates;
    fetchCertificates();
    if (canListCAs) fetchCAs();
  }, [canListCAs, fetchCAs, fetchCertificates, showSystemCertificates]);

  // `?status=expired` opens the list on that status, e.g. from the Dashboard expired-certificates notice.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get("status");
  useEffect(() => {
    if (!requestedStatus) return;
    const status = statusOptions.find((option) => option.value === requestedStatus)?.value;
    if (status) setFilters({ status });
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("status");
    setSearchParams(nextParams, { replace: true });
  }, [requestedStatus, searchParams, setFilters, setSearchParams]);

  useRealtime("cert.changed", () => {
    fetchCertificates();
  });

  // Deleting a folder moves its certificates to ungrouped.
  useRealtime("cert.folder.changed", () => {
    fetchCertificates();
  });

  useRealtime("ca.changed", () => {
    if (canListCAs) fetchCAs();
  });

  // Folders group the whole list, so every page loads.
  useEffect(() => {
    if (hasMore && !isLoading && !isLoadingMore && !error) void fetchNextPage();
  }, [error, fetchNextPage, hasMore, isLoading, isLoadingMore]);

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.status !== "active" ||
    filters.type !== "all" ||
    filters.caId !== "all" ||
    filters.search !== "";
  const canManageFolders = useCanManageSomeFolders("pki:cert:folders:manage");
  const casById = useMemo(() => new Map((cas || []).map((ca) => [ca.id, ca])), [cas]);
  const certificateColumns: ResourceListColumn<Certificate>[] = [
    {
      id: "common-name",
      label: "Common Name",
      renderCell: (cert) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{cert.commonName}</p>
            {cert.isSystem && (
              <Badge variant="outline" size="inline">
                System
              </Badge>
            )}
          </div>
          {(cert.sans?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">+{cert.sans.length} SANs</p>
          )}
        </div>
      ),
    },
    {
      id: "type",
      label: "Type",
      width: "9rem",
      align: "right",
      renderCell: (cert) => <Badge variant="secondary">{cert.type}</Badge>,
    },
    {
      id: "issuing-ca",
      label: "Issuing CA",
      width: "15rem",
      align: "right",
      renderCell: (cert) => <IssuingCABadge certificate={cert} ca={casById.get(cert.caId)} />,
    },
    {
      id: "status",
      label: "Status",
      width: "8rem",
      align: "right",
      renderCell: (cert) => <StatusBadge status={cert.status} />,
    },
    {
      id: "expires",
      label: "Expires",
      width: "190px",
      align: "right",
      cellClassName: "whitespace-nowrap",
      renderCell: (cert) => {
        const expDays = daysUntil(cert.notAfter);
        return (
          <span
            className={cn(
              "text-sm",
              expDays <= 30 && expDays > 0
                ? "text-warning-foreground"
                : expDays <= 0
                  ? "text-destructive"
                  : "text-muted-foreground"
            )}
          >
            {formatDate(cert.notAfter)}
            {expDays > 0 && <span className="ml-1">({expDays}d)</span>}
            {expDays === 0 && hoursUntil(cert.notAfter) > 0 && (
              <span className="ml-1">({hoursUntil(cert.notAfter)}h)</span>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-3">
      <PageHeader
        className="shrink-0"
        leading={<LiteModeBackButton />}
        title="Certificates"
        badges={<LicensePlanBadge feature="internal-pki" />}
        description={`${total} certificates total`}
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
              ...(hasScopedAccess("pki:cert:issue")
                ? [
                    {
                      label: "Issue Certificate",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: openIssueDialog,
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
            {hasScopedAccess("pki:cert:issue") && (
              <Button onClick={openIssueDialog}>
                <Plus className="h-4 w-4" />
                Issue Certificate
              </Button>
            )}
          </ResponsiveHeaderActions>
        }
      />
      <HubTabs />
      <HubTabPanel className="space-y-3">
        <FolderedResourceList<Certificate>
          resourceType="pki-certificate"
          realtimeChannel="cert.folder.changed"
          resources={certificates || []}
          columns={certificateColumns}
          search={{
            placeholder: "Search by common name, serial number...",
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
                    value={filters.status}
                    onValueChange={(v) => setFilters({ status: v as CertificateStatus | "all" })}
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
                <div className="w-40">
                  <Select
                    value={filters.type}
                    onValueChange={(v) => setFilters({ type: v as CertificateType | "all" })}
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
                <div className="w-48">
                  <Select value={filters.caId} onValueChange={(v) => setFilters({ caId: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All CAs</SelectItem>
                      {(cas || []).map((ca) => (
                        <SelectItem key={ca.id} value={ca.id}>
                          {ca.commonName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ),
          }}
          loading={isLoading || isLoadingMore}
          loadingLabel="Loading certificates..."
          emptyState={
            <EmptyState
              message="No certificates."
              {...(hasScopedAccess("pki:cert:issue")
                ? { actionLabel: "Issue one", onAction: openIssueDialog }
                : {})}
              hasActiveFilters={hasActiveFilters}
              onReset={() => {
                resetFilters();
                setSearchInput("");
              }}
            />
          }
          minWidth={900}
          canManageFolders={canManageFolders}
          canReorganizeItem={(cert) =>
            canManageFolders && !cert.isSystem && hasScope(`pki:cert:issue:${cert.caId}`)
          }
          getResourceLabel={(cert) => cert.commonName}
          onItemClick={(cert) => navigate(`/certificates/${cert.id}`)}
          onRefresh={fetchCertificates}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />

        <CertificateIssueDialog
          open={issueDialogOpen}
          onOpenChange={setIssueDialogOpen}
          onSuccess={fetchCertificates}
        />
      </HubTabPanel>
    </div>
  );
}
