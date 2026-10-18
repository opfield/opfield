import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useCanManageSomeFolders } from "@/hooks/use-folder-access";
import { useRealtime } from "@/hooks/use-realtime";
import { hasCreationDestination } from "@/lib/creation-folders";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AlertCategoryDef, AlertRule } from "@/types";
import { AlertDialog } from "./AlertDialog";
import { alertSeverityVariant } from "./notification-status";

/** Read-only folder that holds the built-in rules above the operator's folders. */
const BUILTIN_FOLDER_ID = "notification-alert-rules-builtin";

const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

/** A category id read as words ("managed_storage" → "Managed storage") until the catalog names it. */
export function alertCategoryLabel(
  category: string,
  categories: readonly AlertCategoryDef[]
): string {
  const label = categories.find((item) => item.id === category)?.label;
  if (label) return label;
  const words = category.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Alerts Tab ──────────────────────────────────────────────────────

export function AlertsTab({
  canRead,
  openCreateToken,
  onCreateFolderRef,
}: {
  canRead: boolean;
  openCreateToken: number;
  /** Receives the list's "Add Folder" action for the page header. */
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  const hasScope = useAuthStore((state) => state.hasScope);
  const scopes = useAuthStore((state) => state.user?.scopes);
  // Creating needs notifications:alerts:manage broadly or on a destination folder.
  const canCreate = hasCreationDestination(scopes ?? [], "notifications:alerts:manage");
  const [rules, setRules] = useState<AlertRule[]>(() =>
    canRead ? (api.getCached<AlertRule[]>("notifications:alerts") ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(
    () => canRead && api.getCached<AlertRule[]>("notifications:alerts") === undefined
  );
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const lastHandledCreateToken = useRef(openCreateToken);
  const [categories, setCategories] = useState<AlertCategoryDef[]>([]);
  const canManageFolders = useCanManageSomeFolders("notifications:alerts:folders:manage");

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api
      .getAlertCategories()
      .then((loaded) => {
        if (!cancelled) setCategories(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  const load = useCallback(async () => {
    if (!canRead) {
      setRules([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listAllAlertRules();
      api.setCache("notifications:alerts", data);
      setRules(data);
    } catch {
      toast.error("Failed to load alerts");
    } finally {
      setIsLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("notification.alert-rule.changed", () => {
    load();
  });

  // Deleting a folder moves its rules to ungrouped.
  useRealtime("notification.alert-rule.folder.changed", () => {
    load();
  });

  // Mirrors the rule routes: manage on the rule (broadly, on it, or on its folder) edits, toggles and deletes it.
  const canManageRule = (rule: AlertRule) => hasScope(`notifications:alerts:manage:${rule.id}`);

  const toggle = async (rule: AlertRule) => {
    const nextEnabled = !rule.enabled;
    setRules((prev) =>
      prev.map((candidate) =>
        candidate.id === rule.id ? { ...candidate, enabled: nextEnabled } : candidate
      )
    );
    try {
      const updated = await api.updateAlertRule(rule.id, { enabled: nextEnabled });
      setRules((prev) => {
        const next = prev.map((candidate) => (candidate.id === updated.id ? updated : candidate));
        api.setCache("notifications:alerts", next);
        return next;
      });
    } catch {
      setRules((prev) =>
        prev.map((candidate) =>
          candidate.id === rule.id ? { ...candidate, enabled: rule.enabled } : candidate
        )
      );
      toast.error("Failed to toggle");
    }
  };

  const del = async (rule: AlertRule) => {
    if (
      !(await confirm({
        title: "Delete Alert",
        description: `Delete "${rule.name}"?`,
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.deleteAlertRule(rule.id);
      toast.success("Deleted");
      load();
    } catch {
      toast.error("Failed");
    }
  };

  const openEdit = (rule: AlertRule) => {
    setEditingRule(rule);
    setDialogOpen(true);
  };
  const openCreate = useCallback(() => {
    setEditingRule(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (openCreateToken > lastHandledCreateToken.current) {
      lastHandledCreateToken.current = openCreateToken;
      openCreate();
    }
  }, [openCreate, openCreateToken]);

  const query = search.trim().toLowerCase();
  const visibleRules = (canRead ? rules : []).filter(
    (rule) =>
      !query ||
      [rule.name, alertCategoryLabel(rule.category, categories)].some((value) =>
        value.toLowerCase().includes(query)
      )
  );
  // Built-in rules keep the server's order in their read-only group.
  const builtinRules = visibleRules
    .filter((rule) => rule.isBuiltin)
    .map((rule, index) => ({ ...rule, sortOrder: index }));
  const customRules = visibleRules.filter((rule) => !rule.isBuiltin);

  const columns: ResourceListColumn<AlertRule>[] = [
    {
      id: "name",
      label: "Name",
      renderCell: (rule) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{rule.name}</span>
          {rule.isBuiltin && <Badge size="inline">Built-in</Badge>}
        </div>
      ),
    },
    {
      id: "category",
      label: "Category",
      align: "right",
      width: "10rem",
      renderCell: (rule) => (
        <Badge variant="secondary">{alertCategoryLabel(rule.category, categories)}</Badge>
      ),
    },
    {
      id: "scope",
      label: "Scope",
      align: "right",
      width: "5rem",
      renderCell: (rule) => (
        <Badge variant="secondary">
          {rule.resourceIds.length === 0 ? "All" : rule.resourceIds.length}
        </Badge>
      ),
    },
    {
      id: "severity",
      label: "Severity",
      align: "right",
      width: "6rem",
      renderCell: (rule) => (
        <Badge variant={alertSeverityVariant(rule.severity)}>{rule.severity}</Badge>
      ),
    },
    {
      id: "active",
      label: "Active",
      align: "right",
      width: "5rem",
      renderCell: (rule) => (
        <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
          <Switch
            checked={rule.enabled}
            onChange={() => {
              if (canManageRule(rule)) toggle(rule);
            }}
            disabled={!canManageRule(rule)}
          />
        </div>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (rule) =>
        canManageRule(rule) ? (
          <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${rule.name}`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openEdit(rule)}>
                  <Pencil className="h-4 w-4" /> Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => del(rule)} className="text-destructive">
                  <Trash2 className="h-4 w-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  if (!canRead) return null;

  return (
    <>
      <FolderedResourceList<AlertRule>
        resourceType="notification-alert-rule"
        realtimeChannel="notification.alert-rule.folder.changed"
        resources={customRules}
        systemFolders={[{ id: BUILTIN_FOLDER_ID, name: "Built-in", items: builtinRules }]}
        columns={columns}
        search={{
          placeholder: "Search alerts...",
          search,
          onSearchChange: setSearch,
          hasActiveFilters: search !== "",
          onReset: () => setSearch(""),
        }}
        loading={isLoading}
        loadingLabel="Loading alerts..."
        emptyState={
          <EmptyState
            message="No alerts configured."
            actionLabel={canCreate ? "Create an alert" : undefined}
            onAction={canCreate ? openCreate : undefined}
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
          />
        }
        canManageFolders={canManageFolders}
        canViewItem={() => true}
        canReorganizeItem={(rule) => canManageFolders && !rule.isBuiltin && canManageRule(rule)}
        getResourceLabel={(rule) => rule.name}
        onItemClick={(rule) => {
          if (canManageRule(rule)) openEdit(rule);
        }}
        onRefresh={load}
        onCreateFolderRef={onCreateFolderRef}
      />
      <AlertDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editingRule}
        onSaved={load}
      />
    </>
  );
}

// ── Alert Dialog (3-step wizard) ────────────────────────────────────
