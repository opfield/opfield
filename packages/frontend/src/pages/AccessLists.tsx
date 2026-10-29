import { FolderPlus, MoreVertical, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { HubTabPanel, HubTabs } from "@/components/common/HubTabs";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { toastApiError } from "@/lib/api-error-toast";
import { hasCreationDestination } from "@/lib/creation-folders";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessIdentityProvider, AccessList } from "@/types";
import { AccessListDialog } from "./access-lists/AccessListDialog";
import { signInMethodTitle } from "./access-lists/access-options";
import { SignInSettingsDialog } from "./access-lists/SignInSettingsDialog";

const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

/** "Opfield account, Google" plus the addresses that skip sign-in; "Nobody" for a closed list. */
function signInSummary(al: AccessList, providers: AccessIdentityProvider[] | null): string {
  const methods = (al.signInMethods ?? []).map((key) => signInMethodTitle(key, providers));
  const skip = al.skipIpRanges?.length ?? 0;
  const parts = [
    ...methods,
    ...(skip > 0 ? [`${skip} ${skip === 1 ? "address skips" : "addresses skip"} sign-in`] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : "Nobody";
}

/** Include, Require and Exclude rules together. */
const ruleCount = (al: AccessList) =>
  (al.includeRules?.length ?? 0) + (al.requireRules?.length ?? 0) + (al.excludeRules?.length ?? 0);

export function AccessLists() {
  const { hasScope, user } = useAuthStore();
  // Creating needs acl:create broadly or on a destination folder.
  const canCreateAccessList = hasCreationDestination(user?.scopes ?? [], "acl:create");
  const canEditAccessList = (id: string) => hasScope(`acl:edit:${id}`);
  const canDeleteAccessList = (id: string) => hasScope(`acl:delete:${id}`);
  const canManageFolders = useCanManageSomeFolders("acl:folders:manage");
  // Sign-in settings: the domain and providers need admin:system, service tokens acl:edit.
  const canOpenSignInSettings = hasScope("admin:system") || hasScope("acl:edit");
  const [signInSettingsOpen, setSignInSettingsOpen] = useState(false);
  const [providers, setProviders] = useState<AccessIdentityProvider[] | null>(null);
  const cachedAccessLists = api.getCached<{ data: AccessList[] }>("access-lists:list");
  const [accessLists, setAccessLists] = useState<AccessList[]>(cachedAccessLists?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cachedAccessLists);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AccessList | null>(null);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const receiveCreateFolder = useCallback((fn: () => void) => setCreateFolderAction(() => fn), []);

  const loadAccessLists = useCallback(async () => {
    try {
      setAccessLists(await api.listAllAccessLists());
    } catch {
      toast.error("Failed to load access lists");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Provider names for the Sign-in column; without them a provider shows as "Identity provider".
  const loadProviders = useCallback(() => {
    api
      .listAccessIdentityProviders()
      .then(setProviders)
      .catch(() => setProviders(null));
  }, []);

  useEffect(() => {
    loadAccessLists();
    loadProviders();
  }, [loadAccessLists, loadProviders]);

  useRealtime("access-list.changed", () => {
    loadAccessLists();
  });

  // Deleting a folder moves its access lists to ungrouped.
  useRealtime("access-list.folder.changed", () => {
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
      toastApiError(err, "Failed to delete access list");
    }
  };

  const query = search.trim().toLowerCase();
  const visibleAccessLists = query
    ? accessLists.filter((al) =>
        [al.name, al.description].some((value) => value?.toLowerCase().includes(query))
      )
    : accessLists;

  const accessListColumns: ResourceListColumn<AccessList>[] = [
    {
      id: "name",
      label: "Name",
      renderCell: (al) => <p className="truncate text-sm font-medium">{al.name}</p>,
    },
    {
      id: "description",
      label: "Description",
      renderCell: (al) => (
        <p className="truncate text-sm text-muted-foreground" title={al.description || undefined}>
          {al.description || "—"}
        </p>
      ),
    },
    {
      id: "sign-in",
      label: "Sign-in",
      renderCell: (al) => {
        const summary = signInSummary(al, providers);
        return (
          <p className="truncate text-sm text-muted-foreground" title={summary}>
            {summary}
          </p>
        );
      },
    },
    {
      id: "rules",
      label: "Rules",
      align: "right",
      width: "7rem",
      renderCell: (al) => {
        const count = ruleCount(al);
        return (
          <Badge variant={count > 0 ? "secondary" : "outline"} className="gap-1">
            <span>{count}</span>
            <span>{count === 1 ? "rule" : "rules"}</span>
          </Badge>
        );
      },
    },
    {
      id: "usage",
      label: "Usage",
      align: "right",
      width: "7rem",
      renderCell: (al) => (
        <Badge variant="secondary" className="gap-1">
          <span>{al.usageCount ?? 0}</span>
          <span>{al.usageCount === 1 ? "route" : "routes"}</span>
        </Badge>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (al) =>
        canEditAccessList(al.id) || canDeleteAccessList(al.id) ? (
          <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Access list actions">
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
                  <>
                    {canEditAccessList(al.id) && <DropdownMenuSeparator />}
                    <DropdownMenuItem onClick={() => handleDelete(al)} className="text-destructive">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <PageHeader
        leading={<LiteModeBackButton />}
        title="Access Lists"
        description="Decide who can open routes and Pages"
        actions={
          canCreateAccessList ||
          canOpenSignInSettings ||
          (canManageFolders && createFolderAction) ? (
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
                ...(canOpenSignInSettings
                  ? [
                      {
                        label: "Sign-in settings",
                        icon: <Settings2 className="h-4 w-4" />,
                        onClick: () => setSignInSettingsOpen(true),
                      },
                    ]
                  : []),
                ...(canCreateAccessList
                  ? [
                      {
                        label: "Add Access List",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: openCreate,
                      },
                    ]
                  : []),
              ]}
            >
              {canManageFolders && createFolderAction && (
                <Button variant="outline" onClick={() => createFolderAction()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canOpenSignInSettings && (
                <Button variant="outline" onClick={() => setSignInSettingsOpen(true)}>
                  <Settings2 className="h-4 w-4" />
                  Sign-in settings
                </Button>
              )}
              {canCreateAccessList && (
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" />
                  Add Access List
                </Button>
              )}
            </ResponsiveHeaderActions>
          ) : null
        }
      />
      <HubTabs />
      <HubTabPanel className="space-y-4">
        <FolderedResourceList<AccessList>
          resourceType="access-list"
          realtimeChannel="access-list.folder.changed"
          resources={visibleAccessLists}
          columns={accessListColumns}
          search={{
            placeholder: "Search access lists...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters: search !== "",
            onReset: () => setSearch(""),
          }}
          loading={isLoading}
          loadingLabel="Loading access lists..."
          emptyState={
            <EmptyState
              message="No access lists."
              {...(canCreateAccessList ? { actionLabel: "Create one", onAction: openCreate } : {})}
              hasActiveFilters={search !== ""}
              onReset={() => setSearch("")}
            />
          }
          canManageFolders={canManageFolders}
          canViewItem={() => true}
          canReorganizeItem={(al) => canManageFolders && canEditAccessList(al.id)}
          getResourceLabel={(al) => al.name}
          onItemClick={(accessList) => {
            if (canEditAccessList(accessList.id)) openEdit(accessList);
          }}
          onRefresh={loadAccessLists}
          onCreateFolderRef={receiveCreateFolder}
        />

        <AccessListDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          accessList={editing}
          onSaved={loadAccessLists}
        />
        <SignInSettingsDialog
          open={signInSettingsOpen}
          onOpenChange={setSignInSettingsOpen}
          onProvidersChanged={loadProviders}
        />
      </HubTabPanel>
    </div>
  );
}
