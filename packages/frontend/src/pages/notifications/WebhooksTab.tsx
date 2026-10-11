import { MoreVertical, Pencil, Send, Trash2 } from "lucide-react";
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
import type { NotificationWebhook } from "@/types";
import { WebhookDialog } from "./WebhookDialog";

// ── Webhooks Tab ────────────────────────────────────────────────────

export function WebhooksTab({
  canRead,
  canManage,
  openCreateToken,
}: {
  canRead: boolean;
  canManage: boolean;
  openCreateToken: number;
}) {
  const [webhooks, setWebhooks] = useState<NotificationWebhook[]>(() =>
    canRead ? (api.getCached<NotificationWebhook[]>("notifications:webhooks") ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(
    () => canRead && api.getCached<NotificationWebhook[]>("notifications:webhooks") === undefined
  );
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWh, setEditingWh] = useState<NotificationWebhook | null>(null);
  const lastHandledCreateToken = useRef(openCreateToken);

  const load = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!canRead) {
        setWebhooks([]);
        setIsLoading(false);
        return;
      }
      if (options?.showLoading !== false) setIsLoading(true);
      try {
        const data = (await api.listWebhooks({ limit: 100 })).data;
        api.setCache("notifications:webhooks", data);
        setWebhooks(data);
      } catch {
        toast.error("Failed to load webhooks");
      } finally {
        setIsLoading(false);
      }
    },
    [canRead]
  );

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("notification.webhook.changed", () => {
    load({ showLoading: false });
  });

  const toggle = async (wh: NotificationWebhook) => {
    const nextEnabled = !wh.enabled;
    setWebhooks((prev) =>
      prev.map((candidate) =>
        candidate.id === wh.id ? { ...candidate, enabled: nextEnabled } : candidate
      )
    );
    try {
      const updated = await api.updateWebhook(wh.id, { enabled: nextEnabled });
      setWebhooks((prev) => {
        const next = prev.map((candidate) => (candidate.id === updated.id ? updated : candidate));
        api.setCache("notifications:webhooks", next);
        return next;
      });
    } catch {
      setWebhooks((prev) =>
        prev.map((candidate) =>
          candidate.id === wh.id ? { ...candidate, enabled: wh.enabled } : candidate
        )
      );
      toast.error("Failed");
    }
  };

  const del = async (wh: NotificationWebhook) => {
    if (
      !(await confirm({
        title: "Delete Webhook",
        description: `Delete "${wh.name}"?`,
        confirmLabel: "Delete",
      }))
    )
      return;
    try {
      await api.deleteWebhook(wh.id);
      toast.success("Deleted");
      load();
    } catch {
      toast.error("Failed");
    }
  };

  const test = async (wh: NotificationWebhook) => {
    try {
      const r = await api.testWebhook(wh.id);
      r.success
        ? toast.success(`Test succeeded (HTTP ${r.statusCode})`)
        : toast.error(`Test failed: ${r.error ?? `HTTP ${r.statusCode}`}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    }
  };

  const openEdit = (wh: NotificationWebhook) => {
    setEditingWh(wh);
    setDialogOpen(true);
  };
  const openCreate = useCallback(() => {
    setEditingWh(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (openCreateToken > lastHandledCreateToken.current && canManage) {
      lastHandledCreateToken.current = openCreateToken;
      openCreate();
    }
  }, [canManage, openCreate, openCreateToken]);

  const visibleWebhooks = canRead ? webhooks : [];
  const columns: SimpleTableColumn<NotificationWebhook>[] = [
    {
      id: "name",
      header: "Name",
      render: (webhook) => <span className="text-sm font-medium">{webhook.name}</span>,
    },
    {
      id: "url",
      header: "URL",
      render: (webhook) => (
        <span
          title={webhook.url}
          className="block min-w-0 truncate font-mono text-sm text-muted-foreground"
        >
          {webhook.url}
        </span>
      ),
    },
    {
      id: "method",
      header: "Method",
      render: (webhook) => <Badge variant="secondary">{webhook.method}</Badge>,
    },
    {
      id: "preset",
      header: "Preset",
      render: (webhook) =>
        webhook.templatePreset ? (
          <Badge variant="secondary">{webhook.templatePreset}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">custom</span>
        ),
    },
    {
      id: "active",
      header: "Active",
      className: "w-16",
      cellClassName: "w-16",
      render: (webhook) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={webhook.enabled}
            onChange={() => {
              if (canManage) toggle(webhook);
            }}
            disabled={!canManage}
          />
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-12",
      cellClassName: "w-12",
      render: (webhook) =>
        canManage ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${webhook.name}`}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => test(webhook)}>
                  <Send className="h-4 w-4" /> Test
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openEdit(webhook)}>
                  <Pencil className="h-4 w-4" /> Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => del(webhook)} className="text-destructive">
                  <Trash2 className="h-4 w-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  useContentLoading(initialLoading && visibleWebhooks.length === 0);

  return (
    <div className="space-y-4">
      {initialLoading && visibleWebhooks.length === 0 ? null : visibleWebhooks.length > 0 ? (
        <div className="border border-border bg-card">
          <SimpleTable
            columns={columns}
            rows={visibleWebhooks}
            getRowKey={(webhook) => webhook.id}
            loading={isLoading}
            loadingMessage="Loading webhooks"
            onRowClick={canManage ? openEdit : undefined}
          />
        </div>
      ) : (
        <EmptyState
          message="No webhooks configured."
          actionLabel={canManage ? "Create a webhook" : undefined}
          onAction={canManage ? openCreate : undefined}
        />
      )}
      <WebhookDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        webhook={editingWh}
        onSaved={load}
      />
    </div>
  );
}
