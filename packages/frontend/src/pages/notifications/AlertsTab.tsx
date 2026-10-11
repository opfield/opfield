import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
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
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { AlertRule } from "@/types";
import { AlertDialog } from "./AlertDialog";
import { alertSeverityVariant } from "./notification-status";

// ── Alerts Tab ──────────────────────────────────────────────────────

export function AlertsTab({
  canRead,
  canManage,
  openCreateToken,
}: {
  canRead: boolean;
  canManage: boolean;
  openCreateToken: number;
}) {
  const [rules, setRules] = useState<AlertRule[]>(() =>
    canRead ? (api.getCached<AlertRule[]>("notifications:alerts") ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(
    () => canRead && api.getCached<AlertRule[]>("notifications:alerts") === undefined
  );
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const lastHandledCreateToken = useRef(openCreateToken);

  const load = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!canRead) {
        setRules([]);
        setIsLoading(false);
        return;
      }
      if (options?.showLoading !== false) setIsLoading(true);
      try {
        const data = (await api.listAlertRules({ limit: 100 })).data;
        api.setCache("notifications:alerts", data);
        setRules(data);
      } catch {
        toast.error("Failed to load alerts");
      } finally {
        setIsLoading(false);
      }
    },
    [canRead]
  );

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("notification.alert-rule.changed", () => {
    load({ showLoading: false });
  });

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
    if (openCreateToken > lastHandledCreateToken.current && canManage) {
      lastHandledCreateToken.current = openCreateToken;
      openCreate();
    }
  }, [canManage, openCreate, openCreateToken]);

  const visibleRules = canRead ? rules : [];
  const columns: SimpleTableColumn<AlertRule>[] = [
    {
      id: "name",
      header: "Name",
      render: (rule) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{rule.name}</span>
          {rule.isBuiltin && <Badge size="inline">Built-in</Badge>}
        </div>
      ),
    },
    {
      id: "category",
      header: "Category",
      align: "right",
      render: (rule) => <Badge variant="secondary">{rule.category}</Badge>,
    },
    {
      id: "scope",
      header: "Scope",
      align: "right",
      render: (rule) => (
        <Badge variant="secondary">
          {rule.resourceIds.length === 0 ? "All" : rule.resourceIds.length}
        </Badge>
      ),
    },
    {
      id: "severity",
      header: "Severity",
      align: "right",
      render: (rule) => (
        <Badge variant={alertSeverityVariant(rule.severity)}>{rule.severity}</Badge>
      ),
    },
    {
      id: "active",
      header: "Active",
      align: "right",
      className: "w-20",
      cellClassName: "w-20",
      render: (rule) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={rule.enabled}
            onChange={() => {
              if (canManage) toggle(rule);
            }}
            disabled={!canManage}
          />
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      className: "w-24",
      cellClassName: "w-24",
      render: (rule) =>
        canManage ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rule.name}`}>
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

  useContentLoading(initialLoading && visibleRules.length === 0);

  return (
    <div className="space-y-4">
      {initialLoading && visibleRules.length === 0 ? null : visibleRules.length > 0 ? (
        <div className="border border-border bg-card">
          <SimpleTable
            columns={columns}
            rows={visibleRules}
            getRowKey={(rule) => rule.id}
            loading={isLoading}
            loadingMessage="Loading alerts"
            onRowClick={canManage ? openEdit : undefined}
          />
        </div>
      ) : (
        <EmptyState
          message="No alerts configured."
          actionLabel={canManage ? "Create an alert" : undefined}
          onAction={canManage ? openCreate : undefined}
        />
      )}
      <AlertDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editingRule}
        onSaved={load}
      />
    </div>
  );
}

// ── Alert Dialog (3-step wizard) ────────────────────────────────────
