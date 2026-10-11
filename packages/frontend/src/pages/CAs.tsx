import { CornerDownRight, FolderPlus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CACreateDialog } from "@/components/ca/CACreateDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
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
import { useRealtime } from "@/hooks/use-realtime";
import { arrangeCATree, type CAListItem } from "@/lib/ca-tree";
import { cn, daysUntil, formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { requireLicenseFeature } from "@/stores/license-paywall";
import { useUIStore } from "@/stores/ui";

type StatusFilter = "active" | "all";

/** Indent per nesting level: the connector of a child sits under its parent's name. */
const CA_NEST_STEP_PX = 18;

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active only" },
  { value: "all", label: "All statuses" },
];

export function CAs() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const { cas, fetchCAs, isLoading } = useCAStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createIntermediateParentId, setCreateIntermediateParentId] = useState<
    string | undefined
  >();
  const modal = useUIStore((s) => s.modal);
  const closeModal = useUIStore((s) => s.closeModal);

  const openCreate = useCallback((parentId?: string) => {
    if (!requireLicenseFeature("internal-pki", "Internal PKI")) return;
    setCreateIntermediateParentId(parentId);
    setCreateDialogOpen(true);
  }, []);

  useEffect(() => {
    if (modal?.type === "createCA") {
      openCreate();
      closeModal();
    }
  }, [modal, closeModal, openCreate]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;

  useEffect(() => {
    void showSystemCertificates;
    fetchCAs();
  }, [fetchCAs, showSystemCertificates]);

  useRealtime("ca.changed", () => {
    fetchCAs();
  });

  useRealtime("cert.changed", () => {
    fetchCAs();
  });

  // Deleting a folder moves its CAs to ungrouped.
  useRealtime("ca.folder.changed", () => {
    fetchCAs();
  });

  const allCAs = cas || [];
  const caRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return arrangeCATree(
      allCAs.filter(
        (ca) =>
          (statusFilter === "all" || ca.status === "active") &&
          (!query || ca.commonName.toLowerCase().includes(query))
      )
    );
  }, [allCAs, search, statusFilter]);
  const activeCAs = allCAs.filter((ca) => ca.status === "active");
  const activeUserManagedCAs = activeCAs.filter(
    (ca) => !ca.isSystem && hasScope(`pki:ca:create:intermediate:${ca.id}`)
  );
  const totalCerts = allCAs.reduce((sum, ca) => sum + (ca.certCount || 0), 0);
  const canCreateRoot = hasScope("pki:ca:create:root");
  const canCreateIntermediate = hasScopedAccess("pki:ca:create:intermediate");
  const canManageFolders = useCanManageSomeFolders("pki:ca:folders:manage");

  const caColumns: ResourceListColumn<CAListItem>[] = [
    {
      id: "common-name",
      label: "Common Name",
      renderCell: (ca) => (
        <div
          className="flex min-w-0 items-center gap-1.5"
          style={
            ca.depth > 1 ? { paddingLeft: `${(ca.depth - 1) * CA_NEST_STEP_PX}px` } : undefined
          }
        >
          {ca.depth > 0 && (
            <CornerDownRight
              className="h-3 w-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="truncate text-sm font-medium">{ca.commonName}</span>
          {ca.isSystem && (
            <Badge variant="outline" size="inline">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "algorithm",
      label: "Algorithm",
      width: "9rem",
      align: "right",
      renderCell: (ca) => <Badge variant="secondary">{ca.keyAlgorithm}</Badge>,
    },
    {
      id: "certificates",
      label: "Certs",
      width: "5.5rem",
      align: "right",
      renderCell: (ca) => <Badge variant="secondary">{ca.certCount}</Badge>,
    },
    {
      id: "status",
      label: "Status",
      width: "8rem",
      align: "right",
      renderCell: (ca) => <StatusBadge status={ca.status} />,
    },
    {
      id: "expires",
      label: "Expires",
      width: "9rem",
      align: "right",
      cellClassName: "whitespace-nowrap",
      renderCell: (ca) => {
        const expDays = daysUntil(ca.notAfter);
        return (
          <span
            className={cn(
              "text-sm",
              expDays <= 90 && expDays > 0
                ? "text-warning-foreground"
                : expDays <= 0
                  ? "text-destructive"
                  : "text-muted-foreground"
            )}
          >
            {formatDate(ca.notAfter)}
          </span>
        );
      },
    },
  ];

  const hasActiveFilters = statusFilter !== "active" || search !== "";

  const resetFilters = () => {
    setSearch("");
    setStatusFilter("active");
  };

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-3">
        <PageHeader
          className="shrink-0"
          leading={<LiteModeBackButton />}
          title="Certificate Authorities"
          badges={<LicensePlanBadge feature="internal-pki" />}
          description={
            <>
              {activeCAs.length} active &middot; {totalCerts} certificate
              {totalCerts !== 1 ? "s" : ""} issued
            </>
          }
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
                ...(canCreateIntermediate
                  ? [
                      {
                        label: "Create Intermediate",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => openCreate("pick"),
                        disabled: activeUserManagedCAs.length === 0,
                      },
                    ]
                  : []),
                ...(canCreateRoot
                  ? [
                      {
                        label: "Create Root CA",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => openCreate(),
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
              {canCreateIntermediate && (
                <Button
                  variant="outline"
                  onClick={() => openCreate("pick")}
                  disabled={activeUserManagedCAs.length === 0}
                >
                  <Plus className="h-4 w-4" />
                  Create Intermediate
                </Button>
              )}
              {canCreateRoot && (
                <Button onClick={() => openCreate()}>
                  <Plus className="h-4 w-4" />
                  Create Root CA
                </Button>
              )}
            </ResponsiveHeaderActions>
          }
        />

        <FolderedResourceList<CAListItem>
          resourceType="pki-ca"
          realtimeChannel="ca.folder.changed"
          resources={caRows}
          columns={caColumns}
          search={{
            placeholder: "Search by common name...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters,
            onReset: resetFilters,
            filters: (
              <div className="w-40">
                <Select
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as StatusFilter)}
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
            ),
          }}
          loading={isLoading}
          loadingLabel="Loading certificate authorities..."
          emptyState={
            <EmptyState
              message="No certificate authorities."
              {...(canCreateRoot
                ? {
                    actionLabel: "Create one",
                    onAction: () => openCreate(),
                  }
                : {})}
              hasActiveFilters={hasActiveFilters}
              onReset={resetFilters}
            />
          }
          minWidth={760}
          canManageFolders={canManageFolders}
          // A folder holds whole hierarchies: root CAs move, their intermediates follow.
          canReorganizeItem={(ca) =>
            canManageFolders && !ca.isSystem && !ca.parentId && hasScope(`pki:ca:edit:${ca.id}`)
          }
          getResourceLabel={(ca) => ca.commonName}
          onItemClick={(ca) => navigate(`/cas/${ca.id}`)}
          onRefresh={fetchCAs}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />

        <CACreateDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          parentId={createIntermediateParentId}
        />
      </div>
    </PageTransition>
  );
}
