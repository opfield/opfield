import { MoreVertical, Pencil, Send, Trash2 } from "lucide-react";
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
import { toastApiError } from "@/lib/api-error-toast";
import { hasCreationDestination } from "@/lib/creation-folders";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { NotificationWebhook } from "@/types";
import { WebhookDialog } from "./WebhookDialog";

const stopRowEvent = (event: SyntheticEvent) => event.stopPropagation();

// ── Webhooks Tab ────────────────────────────────────────────────────

export function WebhooksTab({
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
  // Creating needs notifications:webhooks:manage broadly or on a destination folder.
  const canCreate = hasCreationDestination(scopes ?? [], "notifications:webhooks:manage");
  const canManageFolders = useCanManageSomeFolders("notifications:webhooks:folders:manage");
  const [webhooks, setWebhooks] = useState<NotificationWebhook[]>(() =>
    canRead ? (api.getCached<NotificationWebhook[]>("notifications:webhooks") ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(
    () => canRead && api.getCached<NotificationWebhook[]>("notifications:webhooks") === undefined
  );
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWh, setEditingWh] = useState<NotificationWebhook | null>(null);
  const lastHandledCreateToken = useRef(openCreateToken);

  const load = useCallback(async () => {
    if (!canRead) {
      setWebhooks([]);
      setIsLoading(false);
      return;
    }
    try {
      const data = await api.listAllWebhooks();
      api.setCache("notifications:webhooks", data);
      setWebhooks(data);
    } catch {
      toast.error("Failed to load webhooks");
    } finally {
      setIsLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("notification.webhook.changed", () => {
    load();
  });

  // Deleting a folder moves its webhooks to ungrouped.
  useRealtime("notification.webhook.folder.changed", () => {
    load();
  });

  // Mirrors the webhook routes: manage on the webhook (broadly, on it, or on its folder) edits, tests and deletes it.
  const canManageWebhook = (webhook: NotificationWebhook) =>
    hasScope(`notifications:webhooks:manage:${webhook.id}`);

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
      toastApiError(err, "Test failed");
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
    if (openCreateToken > lastHandledCreateToken.current) {
      lastHandledCreateToken.current = openCreateToken;
      openCreate();
    }
  }, [openCreate, openCreateToken]);

  const query = search.trim().toLowerCase();
  const visibleWebhooks = (canRead ? webhooks : []).filter(
    (webhook) =>
      !query ||
      [webhook.name, webhook.url, webhook.templatePreset ?? ""].some((value) =>
        value.toLowerCase().includes(query)
      )
  );

  const columns: ResourceListColumn<NotificationWebhook>[] = [
    {
      id: "name",
      label: "Name",
      renderCell: (webhook) => <span className="truncate text-sm font-medium">{webhook.name}</span>,
    },
    {
      id: "url",
      label: "URL",
      renderCell: (webhook) => (
        <span title={webhook.url} className="block min-w-0 truncate text-sm text-muted-foreground">
          {webhook.url}
        </span>
      ),
    },
    {
      id: "method",
      label: "Method",
      align: "right",
      width: "6rem",
      renderCell: (webhook) => <Badge variant="secondary">{webhook.method}</Badge>,
    },
    {
      id: "preset",
      label: "Preset",
      align: "right",
      width: "7rem",
      renderCell: (webhook) =>
        webhook.templatePreset ? (
          <Badge variant="secondary">{webhook.templatePreset}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">custom</span>
        ),
    },
    {
      id: "active",
      label: "Active",
      align: "right",
      width: "5rem",
      renderCell: (webhook) => (
        <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
          <Switch
            checked={webhook.enabled}
            onChange={() => {
              if (canManageWebhook(webhook)) toggle(webhook);
            }}
            disabled={!canManageWebhook(webhook)}
          />
        </div>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (webhook) =>
        canManageWebhook(webhook) ? (
          <div className="flex justify-end" onClick={stopRowEvent} onPointerDown={stopRowEvent}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Actions for ${webhook.name}`}>
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

  if (!canRead) return null;

  return (
    <>
      <FolderedResourceList<NotificationWebhook>
        resourceType="notification-webhook"
        realtimeChannel="notification.webhook.folder.changed"
        resources={visibleWebhooks}
        columns={columns}
        search={{
          placeholder: "Search webhooks...",
          search,
          onSearchChange: setSearch,
          hasActiveFilters: search !== "",
          onReset: () => setSearch(""),
        }}
        loading={isLoading}
        loadingLabel="Loading webhooks..."
        emptyState={
          <EmptyState
            message="No webhooks configured."
            actionLabel={canCreate ? "Create a webhook" : undefined}
            onAction={canCreate ? openCreate : undefined}
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
          />
        }
        canManageFolders={canManageFolders}
        canViewItem={() => true}
        canReorganizeItem={(webhook) => canManageFolders && canManageWebhook(webhook)}
        getResourceLabel={(webhook) => webhook.name}
        onItemClick={(webhook) => {
          if (canManageWebhook(webhook)) openEdit(webhook);
        }}
        onRefresh={load}
        onCreateFolderRef={onCreateFolderRef}
      />
      <WebhookDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        webhook={editingWh}
        onSaved={load}
      />
    </>
  );
}
