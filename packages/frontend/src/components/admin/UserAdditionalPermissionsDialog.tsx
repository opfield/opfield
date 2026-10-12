import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AccessDialogFooter } from "@/components/access/AccessDialogFooter";
import { AccessSection } from "@/components/access/AccessSection";
import { type InheritedAccess, useAccessEditor } from "@/components/access/use-access-editor";
import { ContentLoading } from "@/components/common/ContentLoading";
import {
  allResourcePages,
  canLoadScopeResource,
  loadScopeResourceList,
  reportScopeLoadError,
} from "@/components/common/scope-list-helpers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import { deriveAllowedResourceIdsByScope, hasSelectableScopeBase } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import type {
  DatabaseConnection,
  LoggingSchema,
  Node,
  PermissionGroup,
  ProxyHost,
  User,
} from "@/types";
import { GROUP_ASSIGNABLE_SCOPES, RESOURCE_SCOPABLE_SCOPES } from "@/types";

interface UserAdditionalPermissionsDialogProps {
  open: boolean;
  user: User | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (user: User) => void;
}

const NO_SCOPES: string[] = [];

function joinNames(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * A user's access: their own lines, which this dialog edits (stored as additional scopes), and
 * the lines of their groups, which only show here.
 */
export function UserAdditionalPermissionsDialog({
  open,
  user,
  onOpenChange,
  onSaved,
}: UserAdditionalPermissionsDialogProps) {
  const displayedUser = useRetainedDialogValue(user, open);
  const currentUser = useAuthStore((state) => state.user);
  const hasScopedAccess = useAuthStore((state) => state.hasScopedAccess);
  const { cas, fetchCAs } = useCAStore();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setSaving(false);
  }, [open]);
  const [scopesOpen, setScopesOpen] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[]>([]);
  const [databases, setDatabases] = useState<DatabaseConnection[]>([]);
  const [loggingSchemas, setLoggingSchemas] = useState<LoggingSchema[]>([]);
  // The groups, to show each one's lines under its own name; null when they cannot be listed.
  const [groups, setGroups] = useState<PermissionGroup[] | null>(null);
  // The resource pickers' options; the dialog opens once they are loaded.
  const [resourceListsReady, setResourceListsReady] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setResourceListsReady(false);
  }

  const actorScopes = currentUser?.scopes ?? NO_SCOPES;
  const groupScopes = displayedUser?.groupScopes ?? NO_SCOPES;
  const groupNames = useMemo(
    () => displayedUser?.groupNames ?? (displayedUser?.groupName ? [displayedUser.groupName] : []),
    [displayedUser?.groupName, displayedUser?.groupNames]
  );
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(actorScopes),
    [actorScopes]
  );
  const assignableScopes = useMemo(
    () =>
      GROUP_ASSIGNABLE_SCOPES.filter((scope) => hasSelectableScopeBase(actorScopes, scope.value)),
    [actorScopes]
  );
  const inherited = useMemo<InheritedAccess[]>(() => {
    const groupIds = displayedUser?.groupIds ?? (displayedUser ? [displayedUser.groupId] : []);
    const known = groupIds.map((id) => groups?.find((group) => group.id === id));
    if (groups && known.every(Boolean)) {
      return known.map((group) => ({
        from: group!.name,
        scopes: [...new Set([...group!.scopes, ...(group!.inheritedScopes ?? [])])],
      }));
    }
    return groupScopes.length > 0 ? [{ from: joinNames(groupNames), scopes: groupScopes }] : [];
  }, [displayedUser, groupNames, groupScopes, groups]);

  const access = useAccessEditor({
    open,
    scopes: displayedUser?.additionalScopes ?? NO_SCOPES,
    inherited,
  });

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.allSettled([
      canLoadScopeResource("pki:ca:view") ? fetchCAs() : undefined,
      loadScopeResourceList("nodes:details", () =>
        allResourcePages((page) => api.listNodes({ page, limit: 100 }))
      )
        .then(setNodes)
        .catch((error) => {
          setNodes([]);
          reportScopeLoadError("nodes", error);
        }),
      loadScopeResourceList("proxy:view", () =>
        allResourcePages((page) => api.listProxyHosts({ page, limit: 100 }))
      )
        .then(setProxyHosts)
        .catch((error) => {
          setProxyHosts([]);
          reportScopeLoadError("routes", error);
        }),
      loadScopeResourceList("databases:view", () =>
        allResourcePages((page) => api.listDatabases({ page, limit: 100 }))
      )
        .then(setDatabases)
        .catch((error) => {
          setDatabases([]);
          reportScopeLoadError("databases", error);
        }),
      loadScopeResourceList("logs:schemas:view", () => api.listLoggingSchemas())
        .then((items) => setLoggingSchemas(items ?? []))
        .catch((error) => {
          setLoggingSchemas([]);
          reportScopeLoadError("logging schemas", error);
        }),
      (hasScopedAccess("admin:groups") ? api.listGroups() : Promise.resolve(null))
        .then(setGroups)
        .catch(() => setGroups(null)),
    ]).then(() => {
      if (active) setResourceListsReady(true);
    });
    return () => {
      active = false;
    };
  }, [fetchCAs, hasScopedAccess, open]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const updated = await api.updateUserAdditionalPermissions(user.id, access.scopes);
      api.invalidateCache("req:");
      api.invalidateCache("admin:users");
      onSaved(updated);
      onOpenChange(false);
      toast.success("Permissions updated");
    } catch (error) {
      setSaving(false);
      toastApiError(error, "Failed to update permissions");
    }
  };

  const userName = displayedUser?.name || displayedUser?.email || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" fitViewport>
        <DialogHeader>
          <DialogTitle>{userName}</DialogTitle>
          {groupNames.length > 0 ? (
            <DialogDescription>Member of {joinNames(groupNames)}.</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="space-y-4">
          <ContentLoading loading={!resourceListsReady} />
          <AccessSection
            editor={access}
            subject={userName}
            description="Lines from a group change in that group."
            mode={{ kind: "grant", actorScopes }}
            scopesOpen={scopesOpen}
            onScopesOpenChange={setScopesOpen}
            picker={{
              scopes: assignableScopes,
              searchPlaceholder: "Search permissions...",
              cas,
              nodes,
              proxyHosts,
              databases,
              loggingSchemas,
              restrictableScopes: RESOURCE_SCOPABLE_SCOPES,
              allowedResourceIds: allowedResourceIdsByScope,
              inheritedScopes: groupScopes,
              inheritedFromName: joinNames(groupNames),
            }}
          />
        </div>
        <AccessDialogFooter
          scopeCount={access.scopes.length}
          onReviewScopes={() => setScopesOpen(true)}
        >
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} pending={saving}>
            Save Changes
          </Button>
        </AccessDialogFooter>
      </DialogContent>
    </Dialog>
  );
}
