import { MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessList } from "@/types";
import { AccessListDialog } from "./access-lists/AccessListDialog";

export function AccessLists() {
  const { hasScope } = useAuthStore();
  const canCreateAccessList = hasScope("acl:create");
  const canEditAccessList = (id: string) => hasScope("acl:edit") || hasScope(`acl:edit:${id}`);
  const canDeleteAccessList = (id: string) =>
    hasScope("acl:delete") || hasScope(`acl:delete:${id}`);
  const cachedAccessLists = api.getCached<{ data: AccessList[] }>("access-lists:list");
  const [accessLists, setAccessLists] = useState<AccessList[]>(cachedAccessLists?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cachedAccessLists);
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AccessList | null>(null);

  const loadAccessLists = useCallback(async () => {
    try {
      const res = await api.listAccessLists();
      setAccessLists(res.data || []);
    } catch {
      toast.error("Failed to load access lists");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccessLists();
  }, [loadAccessLists]);

  useRealtime("access-list.changed", () => {
    loadAccessLists();
  });

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (al: AccessList) => {
    setEditing(al);
    setDialogOpen(true);
  };

  const handleDelete = async (al: AccessList) => {
    const ok = await confirm({
      title: "Delete Access List",
      description: `Are you sure you want to delete "${al.name}"? This action cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteAccessList(al.id);
      toast.success("Access list deleted");
      loadAccessLists();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete access list");
    }
  };

  const accessListColumns: SimpleTableColumn<AccessList>[] = [
    {
      id: "name",
      header: "Name",
      render: (al) => <p className="text-sm font-medium">{al.name}</p>,
    },
    {
      id: "description",
      header: "Description",
      render: (al) => (
        <p className="line-clamp-1 text-sm text-muted-foreground">{al.description || "—"}</p>
      ),
    },
    {
      id: "ip-rules",
      header: "IP Rules",
      render: (al) => (
        <Badge variant="secondary" className="gap-1">
          <span>{(al.ipRules || []).length}</span>
          <span>rules</span>
        </Badge>
      ),
    },
    {
      id: "auth-users",
      header: "Auth Users",
      render: (al) => (
        <Badge variant={al.basicAuthEnabled ? "secondary" : "outline"} className="gap-1">
          {al.basicAuthEnabled ? (
            <>
              <span>{(al.basicAuthUsers || []).length}</span>
              <span>users</span>
            </>
          ) : (
            <span>Disabled</span>
          )}
        </Badge>
      ),
    },
    {
      id: "usage",
      header: "Usage",
      render: (al) => (
        <span className="text-sm text-muted-foreground">{al.usageCount ?? 0} hosts</span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-12",
      cellClassName: "w-12",
      render: (al) =>
        canEditAccessList(al.id) || canDeleteAccessList(al.id) ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Access list actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditAccessList(al.id) && (
                  <DropdownMenuItem onClick={() => openEdit(al)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDeleteAccessList(al.id) && (
                  <DropdownMenuItem onClick={() => handleDelete(al)} className="text-destructive">
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <PageHeader
          leading={<LiteModeBackButton />}
          title="Access Lists"
          description="Manage IP rules and basic authentication"
          actions={
            canCreateAccessList ? (
              <ResponsiveHeaderActions
                actions={[
                  {
                    label: "Add Access List",
                    icon: <Plus className="h-4 w-4" />,
                    onClick: openCreate,
                  },
                ]}
              >
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" />
                  Add Access List
                </Button>
              </ResponsiveHeaderActions>
            ) : null
          }
        />

        {/* Table */}
        <ContentLoading loading={initialLoading && accessLists.length === 0} />
        {initialLoading && accessLists.length === 0 ? null : accessLists.length > 0 ? (
          <div className="border border-border bg-card">
            <SimpleTable
              columns={accessListColumns}
              rows={accessLists}
              getRowKey={(al) => al.id}
              loading={isLoading}
              loadingMessage="Loading access lists"
              onRowClick={(accessList) => {
                if (canEditAccessList(accessList.id)) openEdit(accessList);
              }}
            />
          </div>
        ) : (
          <EmptyState
            message="No access lists."
            {...(canCreateAccessList ? { actionLabel: "Create one", onAction: openCreate } : {})}
          />
        )}

        <AccessListDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          accessList={editing}
          onSaved={loadAccessLists}
        />
      </div>
    </PageTransition>
  );
}
