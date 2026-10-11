import {
  ArchiveRestore,
  Ban,
  EllipsisVertical,
  FolderPlus,
  Plus,
  Settings,
  ShieldPlus,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AdminUserConfigDialog } from "@/components/admin/AdminUserConfigDialog";
import { UserAdditionalPermissionsDialog } from "@/components/admin/UserAdditionalPermissionsDialog";
import { groupSelectionLabel, UserGroupSelect } from "@/components/admin/UserGroupSelect";
import { confirm } from "@/components/common/ConfirmDialog";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { RelativeTime } from "@/components/common/RelativeTime";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { useContentLoading } from "@/components/common/reveal-gate";
import { type FolderOption, flattenFolderTree } from "@/components/common/scope-list-helpers";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { canCreateInFolder, scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { DeletedUser, PermissionGroup, User } from "@/types";

function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  return email[0].toUpperCase();
}

function isScopeSubset(requestedScopes: string[], availableScopes: string[]): boolean {
  return requestedScopes.every((scope) => scopeMatches(availableScopes, scope));
}

interface AdminUsersProps {
  embedded?: boolean;
  createRequest?: number;
  onCreateFolderRef?: (fn: () => void) => void;
  onOpenDeletedUsersRef?: (fn: () => void) => void;
}

export function AdminUsers(props: AdminUsersProps) {
  // Embedded in a tab panel, the panel is the gate; standalone, the page is.
  return props.embedded ? (
    <AdminUsersContent {...props} />
  ) : (
    <PageTransition>
      <AdminUsersContent {...props} />
    </PageTransition>
  );
}

function AdminUsersContent({
  embedded = false,
  createRequest = 0,
  onCreateFolderRef,
  onOpenDeletedUsersRef,
}: AdminUsersProps) {
  const navigate = useNavigate();
  const { user: currentUser, hasScope, hasScopedAccess } = useAuthStore();
  const cachedUsers = api.getCached<User[]>("admin:users");
  const cachedGroups = api.getCached<PermissionGroup[]>("admin:groups");
  const [users, setUsers] = useState<User[]>(cachedUsers ?? []);
  const [groups, setGroups] = useState<PermissionGroup[]>(cachedGroups ?? []);
  const [isLoading, setIsLoading] = useState(!cachedUsers);
  const [groupsLoading, setGroupsLoading] = useState(!cachedGroups);
  useContentLoading(isLoading || groupsLoading);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFolderId, setCreateFolderId] = useState<string | null>(null);
  // null until the create dialog's folder list arrives.
  const [destinationFolders, setDestinationFolders] = useState<FolderOption[] | null>(null);
  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    setCreateFolderId(null);
    void api
      .listAdminUserFolders()
      .then((tree) => {
        if (!cancelled) setDestinationFolders(flattenFolderTree(tree, "users"));
      })
      .catch(() => {
        if (!cancelled) setDestinationFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen]);
  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createGroupId, setCreateGroupId] = useState("");
  const [createAdditionalGroupIds, setCreateAdditionalGroupIds] = useState<string[]>([]);
  const groupUpdates = useRef(new Map<string, { confirmed: User; desired: string[] }>());
  const usersLoadVersion = useRef(0);
  const [createAuthMethod, setCreateAuthMethod] = useState<"oidc" | "password" | "email_otp">(
    "oidc"
  );
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [permissionsUser, setPermissionsUser] = useState<User | null>(null);
  const [configureUser, setConfigureUser] = useState<User | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [deletedUsers, setDeletedUsers] = useState<DeletedUser[]>([]);
  const [deletedUsersLoaded, setDeletedUsersLoaded] = useState(false);
  const [deletedUsersOpen, setDeletedUsersOpen] = useState(false);
  const [deletedUsersSearch, setDeletedUsersSearch] = useState("");
  const [restoreUser, setRestoreUser] = useState<DeletedUser | null>(null);
  const displayedRestoreUser = useRetainedDialogValue(restoreUser, restoreUser !== null);
  const [restoreGroupId, setRestoreGroupId] = useState("");
  const [restoreAdditionalGroupIds, setRestoreAdditionalGroupIds] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [impersonatingUserId, setImpersonatingUserId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const lastCreateRequest = useRef(createRequest);

  useEffect(() => {
    if (!hasScopedAccess("admin:users")) {
      navigate("/");
      return;
    }
  }, [hasScopedAccess, navigate]);

  const loadUsers = useCallback(async () => {
    const version = ++usersLoadVersion.current;
    try {
      const data = await api.listUsers();
      if (version !== usersLoadVersion.current) return;
      api.setCache("admin:users", data || []);
      setUsers((current) =>
        (data || []).map((entry) => {
          if (!groupUpdates.current.has(entry.id)) return entry;
          const pending = current.find((user) => user.id === entry.id);
          return pending
            ? {
                ...entry,
                groupId: pending.groupId,
                groupName: pending.groupName,
                groupIds: pending.groupIds,
                groupNames: pending.groupNames,
              }
            : entry;
        })
      );
    } catch {
      toast.error("Failed to load users");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadDeletedUsers = useCallback(async () => {
    try {
      const data = await api.listDeletedUsers();
      setDeletedUsers(data ?? []);
    } catch {
      toast.error("Failed to load deleted users");
    } finally {
      setDeletedUsersLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const canManageDeletedUsers = hasScope("admin:system");

  const openDeletedUsers = useCallback(() => {
    setDeletedUsersSearch("");
    setDeletedUsersOpen(true);
  }, []);

  useEffect(() => {
    if (embedded && canManageDeletedUsers) onOpenDeletedUsersRef?.(openDeletedUsers);
  }, [canManageDeletedUsers, embedded, onOpenDeletedUsersRef, openDeletedUsers]);

  useEffect(() => {
    if (canManageDeletedUsers) void loadDeletedUsers();
  }, [canManageDeletedUsers, loadDeletedUsers]);

  useEffect(() => {
    api
      .listGroups()
      .then((data) => {
        api.setCache("admin:groups", data);
        setGroups(data);
      })
      .catch(() => {})
      .finally(() => setGroupsLoading(false));
  }, []);

  useEffect(() => {
    if (createGroupId || groups.length === 0) return;
    const preferred =
      groups.find((group) => group.name === "viewer") ??
      groups.find((group) => !group.isBuiltin) ??
      groups[0];
    if (preferred) setCreateGroupId(preferred.id);
  }, [createGroupId, groups]);

  useRealtime("user.changed", () => {
    reloadUsers();
  });

  useRealtime("group.changed", () => {
    api
      .listGroups()
      .then((data) => {
        api.setCache("admin:groups", data);
        setGroups(data);
      })
      .catch(() => {});
    reloadUsers();
  });

  const reloadUsers = useCallback(() => {
    api.invalidateCache("req:");
    api.invalidateCache("admin:users");
    return loadUsers();
  }, [loadUsers]);

  const handleGroupChange = async (user: User, groupIds: string[]) => {
    if (!groupIds.length) return;
    ++usersLoadVersion.current;
    const names = groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id);
    setUsers((current) =>
      current.map((entry) =>
        entry.id === user.id
          ? { ...entry, groupId: groupIds[0], groupName: names[0], groupIds, groupNames: names }
          : entry
      )
    );
    const pending = groupUpdates.current.get(user.id);
    if (pending) {
      pending.desired = groupIds;
      return;
    }
    const update = { confirmed: user, desired: groupIds };
    groupUpdates.current.set(user.id, update);
    try {
      while (true) {
        const requested = update.desired;
        const updated = await api.updateUserGroup(user.id, requested);
        update.confirmed = updated;
        if (requested !== update.desired) continue;
        setUsers((current) =>
          current.map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry))
        );
        break;
      }
    } catch (err) {
      setUsers((current) =>
        current.map((entry) => (entry.id === user.id ? { ...entry, ...update.confirmed } : entry))
      );
      toast.error(err instanceof Error ? err.message : "Failed to update group");
    } finally {
      ++usersLoadVersion.current;
      groupUpdates.current.delete(user.id);
      api.invalidateCache("admin:users");
    }
  };

  const handleDelete = async (user: User) => {
    const ok = await confirm({
      title: "Delete User",
      description: `Delete "${user.name || user.email}"? Their access and tokens will be revoked. Only a system administrator can restore them.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteUser(user.id);
      toast.success("User deleted");
      await Promise.all([reloadUsers(), ...(canManageDeletedUsers ? [loadDeletedUsers()] : [])]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const handleImpersonate = async (user: User) => {
    setImpersonatingUserId(user.id);
    try {
      await api.impersonateUser(user.id);
      api.resetSessionState();
      window.location.assign("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to impersonate user");
      setImpersonatingUserId(null);
    }
  };

  const openRestore = (user: DeletedUser) => {
    setRestoreUser(user);
    setRestoreGroupId("");
    setRestoreAdditionalGroupIds([]);
  };

  const handleRestore = async () => {
    if (!restoreUser) return;
    if (!restoreUser.originalGroupExists && !restoreGroupId) {
      toast.error("Select a group to restore this user");
      return;
    }
    setRestoring(true);
    try {
      await api.restoreUser(
        restoreUser.id,
        restoreUser.originalGroupExists ? undefined : [restoreGroupId, ...restoreAdditionalGroupIds]
      );
      toast.success("User restored in blocked state. Unblock them separately to grant access.");
      setRestoreUser(null);
      await Promise.all([loadDeletedUsers(), reloadUsers()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore user");
    } finally {
      setRestoring(false);
    }
  };

  const openCreateDialog = useCallback(() => {
    setCreateEmail("");
    setCreateName("");
    setCreateAuthMethod("oidc");
    const preferred =
      groups.find((group) => group.name === "viewer") ??
      groups.find((group) => !group.isBuiltin) ??
      groups[0];
    setCreateGroupId(preferred?.id ?? "");
    setCreateAdditionalGroupIds([]);
    setDestinationFolders(null);
    setCreateOpen(true);
  }, [groups]);

  const closeCreateDialog = () => setCreateOpen(false);

  const handleCreateUser = async () => {
    if (!createEmail.trim() || !createName.trim() || !createGroupId) {
      toast.error("Name, email, and group are required");
      return;
    }

    setCreating(true);
    try {
      if (!canCreateInFolder(currentUser?.scopes ?? [], "admin:users", createFolderId))
        throw new Error("Select an authorized destination folder");
      await api.createUser({
        folderId: createFolderId,
        email: createEmail.trim(),
        name: createName.trim(),
        groupId: createGroupId,
        groupIds: [createGroupId, ...createAdditionalGroupIds],
        authMethod: createAuthMethod,
      });
      toast.success("User created");
      closeCreateDialog();
      reloadUsers();
    } catch (err) {
      if (!handleLicenseApiError(err, "Users")) {
        toast.error(err instanceof Error ? err.message : "Failed to create user");
      }
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!embedded || createRequest === 0 || createRequest === lastCreateRequest.current) return;
    lastCreateRequest.current = createRequest;
    openCreateDialog();
  }, [createRequest, embedded, openCreateDialog]);

  const canManageFolders = useCanManageSomeFolders("admin:users:folders:manage", "admin:system");
  const canImpersonateUsers = hasScope("admin:users:impersonate");
  const hasActiveFilters = search.trim() !== "";
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) =>
      [user.name, user.email, ...(user.groupNames ?? [user.groupName])].some((value) =>
        value?.toLowerCase().includes(query)
      )
    );
  }, [search, users]);
  const filteredDeletedUsers = useMemo(() => {
    const query = deletedUsersSearch.trim().toLowerCase();
    if (!query) return deletedUsers;
    return deletedUsers.filter((user) =>
      [user.name, user.email].some((value) => value?.toLowerCase().includes(query))
    );
  }, [deletedUsers, deletedUsersSearch]);
  const userColumns: ResourceListColumn<User>[] = [
    {
      id: "user",
      label: "User",
      width: "minmax(16rem, 1fr)",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        return (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="h-9 w-9 shrink-0">
              <AvatarImage src={user.avatarUrl ?? undefined} />
              <AvatarFallback className="text-xs">
                {getInitials(user.name, user.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                {isSelf && (
                  <Badge variant="secondary" size="inline" className="shrink-0">
                    You
                  </Badge>
                )}
                {isSystemUser && (
                  <Badge variant="outline" size="inline" className="shrink-0">
                    System
                  </Badge>
                )}
                {user.isBlocked && (
                  <Badge variant="destructive" size="inline" className="shrink-0">
                    <Ban className="mr-0.5 h-2.5 w-2.5" />
                    Blocked
                  </Badge>
                )}
                {(user.additionalScopes?.length ?? 0) > 0 && (
                  <Badge variant="outline" size="inline" className="shrink-0">
                    +{user.additionalScopes!.length} additional
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "group",
      label: "Groups",
      width: "20rem",
      align: "right",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        const isReadOnly = isSelf || isSystemUser;
        const groupIds = user.groupIds ?? [user.groupId];
        if (isReadOnly)
          return (
            <Badge variant="secondary" className="min-w-0 max-w-full">
              <span className="truncate" title={user.groupNames?.join(", ") ?? user.groupName}>
                {groupSelectionLabel(
                  groupIds,
                  groups,
                  user.groupNames?.join(", ") ?? user.groupName
                )}
              </span>
            </Badge>
          );
        return (
          <div
            className="min-w-0 w-full"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <UserGroupSelect
              value={groupIds}
              groups={groups}
              fallback={user.groupNames?.join(", ") ?? user.groupName}
              onChange={(ids) => handleGroupChange(user, ids)}
            />
          </div>
        );
      },
    },
    {
      id: "sign-in",
      label: "Sign-in",
      width: "12rem",
      align: "right",
      renderCell: (user) => (
        <Badge variant="secondary">
          {user.authMethod === "password"
            ? "Email and password"
            : user.authMethod === "email_otp"
              ? "Email code"
              : "OIDC"}
        </Badge>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      width: "8.5rem",
      align: "right",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        const isReadOnly = isSelf || isSystemUser;
        if (isReadOnly) return null;
        const canManagePermissions = isScopeSubset(user.scopes, currentUser?.scopes ?? []);
        return (
          <div
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="User actions">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setConfigureUser(user);
                    setConfigureOpen(true);
                  }}
                >
                  <Settings className="h-4 w-4" />
                  Configure user
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setPermissionsUser(user)}
                  disabled={!canManagePermissions}
                >
                  <ShieldPlus className="h-4 w-4" />
                  Assign permissions
                </DropdownMenuItem>
                {canImpersonateUsers && (
                  <DropdownMenuItem
                    onClick={() => void handleImpersonate(user)}
                    disabled={
                      user.isBlocked || !canManagePermissions || impersonatingUserId !== null
                    }
                  >
                    <UserRoundCheck className="h-4 w-4" />
                    Impersonate
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void handleDelete(user)}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  // Group users by their group name for summary
  const groupCounts = new Map<string, number>();
  let blockedCount = 0;
  for (const u of users) {
    if (u.isBlocked) {
      blockedCount++;
    } else {
      for (const name of new Set(u.groupNames ?? [u.groupName])) {
        groupCounts.set(name, (groupCounts.get(name) || 0) + 1);
      }
    }
  }
  const summaryParts = Array.from(groupCounts.entries()).map(
    ([name, count]) => `${count} ${name.toLowerCase()}${count !== 1 ? "s" : ""}`
  );
  if (blockedCount > 0) summaryParts.push(`${blockedCount} blocked`);

  return (
    <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
      {!embedded && (
        <PageHeader
          title="Users"
          description={
            <>
              {users.length} user{users.length !== 1 ? "s" : ""}
              {summaryParts.length > 0 && <> &middot; {summaryParts.join(", ")}</>}
            </>
          }
          leading={<LiteModeBackButton />}
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
                ...(canManageDeletedUsers
                  ? [
                      {
                        label: "Deleted Users",
                        icon: <ArchiveRestore className="h-4 w-4" />,
                        onClick: openDeletedUsers,
                      },
                    ]
                  : []),
                {
                  label: "Create User",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: openCreateDialog,
                },
              ]}
            >
              {canManageFolders && (
                <Button variant="outline" onClick={() => createFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canManageDeletedUsers && (
                <Button variant="outline" onClick={openDeletedUsers}>
                  <ArchiveRestore className="h-4 w-4" />
                  Deleted Users
                </Button>
              )}
              <Button onClick={openCreateDialog}>
                <Plus className="h-4 w-4" />
                Create User
              </Button>
            </ResponsiveHeaderActions>
          }
        />
      )}

      <FolderedResourceList<User>
        resourceType="admin-user"
        realtimeChannel="user.changed"
        resources={filteredUsers}
        columns={userColumns}
        search={{
          search,
          onSearchChange: setSearch,
          placeholder: "Search users...",
          hasActiveFilters,
          onReset: () => setSearch(""),
        }}
        loading={isLoading}
        loadingLabel="Loading users..."
        emptyState={
          <EmptyState
            message="No users."
            hasActiveFilters={hasActiveFilters}
            onReset={() => setSearch("")}
          />
        }
        minWidth={720}
        canManageFolders={canManageFolders}
        canReorganizeItem={() => canManageFolders}
        getResourceLabel={(user) => user.name || user.email}
        onRefresh={reloadUsers}
        onCreateFolderRef={(fn) => {
          setCreateFolderAction(() => fn);
          onCreateFolderRef?.(fn);
        }}
      />

      <Dialog open={createOpen} onOpenChange={(open) => (!creating ? setCreateOpen(open) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <ContentLoading loading={destinationFolders === null} />
            {((destinationFolders?.length ?? 0) > 0 || !hasScope("admin:users")) && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Folder</label>
                <Select
                  value={createFolderId ?? (hasScope("admin:users") ? "__none__" : "")}
                  onValueChange={(value) => setCreateFolderId(value === "__none__" ? null : value)}
                >
                  <SelectTrigger aria-label="User folder">
                    <SelectValue placeholder="Select a folder" />
                  </SelectTrigger>
                  <SelectContent>
                    {hasScope("admin:users") && <SelectItem value="__none__">No folder</SelectItem>}
                    {(destinationFolders ?? [])
                      .filter((folder) =>
                        canCreateInFolder(currentUser?.scopes ?? [], "admin:users", folder.id)
                      )
                      .map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="create-user-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="create-user-email"
                type="email"
                placeholder="user@example.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Sign-in method</label>
              <Select
                value={createAuthMethod}
                onValueChange={(value) =>
                  setCreateAuthMethod(value as "oidc" | "password" | "email_otp")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="password">Email and password</SelectItem>
                  <SelectItem value="email_otp">Email code</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="create-user-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="create-user-name"
                placeholder="Jane Doe"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Groups</label>
              <UserGroupSelect
                value={createGroupId ? [createGroupId, ...createAdditionalGroupIds] : []}
                groups={groups}
                disabled={creating}
                onChange={(ids) => {
                  setCreateGroupId(ids[0]);
                  setCreateAdditionalGroupIds(ids.slice(1));
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Password users receive a setup link by email. OIDC users are pre-created for their
              first identity-provider sign-in.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreateDialog} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateUser}
              pending={creating}
              disabled={!createEmail.trim() || !createName.trim() || !createGroupId}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserAdditionalPermissionsDialog
        open={permissionsUser !== null}
        user={permissionsUser}
        onOpenChange={(open) => {
          if (!open) setPermissionsUser(null);
        }}
        onSaved={(updatedUser) => {
          setUsers((current) =>
            current.map((user) => (user.id === updatedUser.id ? updatedUser : user))
          );
          void reloadUsers();
        }}
      />

      <AdminUserConfigDialog
        open={configureOpen}
        user={configureUser}
        canResetMfa={hasScope("admin:system")}
        onOpenChange={setConfigureOpen}
        onUserUpdated={(updatedUser) => {
          // Action responses can omit list-only fields (sign-in and invitation state); keep them.
          setUsers((current) =>
            current.map((user) => (user.id === updatedUser.id ? { ...user, ...updatedUser } : user))
          );
          setConfigureUser((current) =>
            current?.id === updatedUser.id ? { ...current, ...updatedUser } : updatedUser
          );
          void reloadUsers();
        }}
        onUserDeleted={() => {
          setConfigureOpen(false);
          void Promise.all([reloadUsers(), ...(canManageDeletedUsers ? [loadDeletedUsers()] : [])]);
        }}
      />

      <Dialog
        open={deletedUsersOpen}
        onOpenChange={(open) => {
          setDeletedUsersOpen(open);
          if (!open) setDeletedUsersSearch("");
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Deleted Users</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Restoring an account keeps it blocked. Its old sessions and tokens are not restored.
          </p>
          <div className="border border-border">
            <ContentLoading loading={!deletedUsersLoaded} />
            <Input
              value={deletedUsersSearch}
              onChange={(event) => setDeletedUsersSearch(event.target.value)}
              placeholder="Search deleted users..."
              className="h-9 rounded-none border-0 border-b border-border text-sm focus-visible:ring-0"
            />
            {filteredDeletedUsers.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {deletedUsersSearch ? "No deleted users found." : "No deleted users."}
              </p>
            ) : (
              <div className="max-h-[min(25rem,48dvh)] divide-y divide-border overflow-y-auto overscroll-contain">
                {filteredDeletedUsers.map((user) => (
                  <div key={user.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarImage src={user.avatarUrl ?? undefined} />
                        <AvatarFallback className="text-xs">
                          {getInitials(user.name, user.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.email} · deleted <RelativeTime value={user.deletedAt} />
                        </p>
                        {!user.originalGroupExists && (
                          <p className="mt-1 text-xs text-warning-foreground">
                            Original group was deleted
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openRestore(user)}
                      aria-label={`Restore ${user.name || user.email}`}
                      title="Restore user"
                    >
                      <ArchiveRestore className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={restoreUser !== null}
        onOpenChange={(open) => {
          if (!restoring && !open) setRestoreUser(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Restore {displayedRestoreUser?.name || displayedRestoreUser?.email}? The account will
              remain blocked until explicitly unblocked.
            </p>
            {displayedRestoreUser && !displayedRestoreUser.originalGroupExists && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">New group</label>
                <UserGroupSelect
                  value={restoreGroupId ? [restoreGroupId, ...restoreAdditionalGroupIds] : []}
                  groups={groups}
                  disabled={restoring}
                  onChange={(ids) => {
                    setRestoreGroupId(ids[0]);
                    setRestoreAdditionalGroupIds(ids.slice(1));
                  }}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreUser(null)} disabled={restoring}>
              Cancel
            </Button>
            <Button
              onClick={handleRestore}
              pending={restoring}
              disabled={!displayedRestoreUser?.originalGroupExists && !restoreGroupId}
            >
              Restore blocked user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
