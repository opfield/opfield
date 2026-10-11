import { History, MoreVertical, Pencil, Send, ShieldCheck, Trash2 } from "lucide-react";
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
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { SiemAuthType, SiemDestination } from "@/types";
import { siemDeliveryVariant } from "./notification-status";
import { SiemDestinationDialog } from "./SiemDestinationDialog";

export const SIEM_DESTINATION_CACHE_KEY = "audit:siem:destinations";

const AUTH_LABEL: Record<SiemAuthType, string> = {
  bearer: "Bearer",
  hmac_sha256: "HMAC-SHA256",
  custom_header: "Custom header",
};

export function SiemDestinationsTab({
  canRead,
  canManage,
  openCreateToken,
  onViewDeliveryLog,
}: {
  canRead: boolean;
  canManage: boolean;
  openCreateToken: number;
  onViewDeliveryLog: (destination: SiemDestination) => void;
}) {
  const [destinations, setDestinations] = useState<SiemDestination[]>(() =>
    canRead ? (api.getCached<SiemDestination[]>(SIEM_DESTINATION_CACHE_KEY) ?? []) : []
  );
  const [isLoading, setIsLoading] = useState(
    () => canRead && api.getCached<SiemDestination[]>(SIEM_DESTINATION_CACHE_KEY) === undefined
  );
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDestination, setEditingDestination] = useState<SiemDestination | null>(null);
  const lastHandledCreateToken = useRef(openCreateToken);

  const load = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!canRead) {
        setDestinations([]);
        setIsLoading(false);
        return;
      }
      if (options?.showLoading !== false) setIsLoading(true);
      try {
        const data = (await api.listSiemDestinations({ limit: 100 })).data;
        api.setCache(SIEM_DESTINATION_CACHE_KEY, data);
        setDestinations(data);
      } catch {
        toast.error("Failed to load SIEM destinations");
      } finally {
        setIsLoading(false);
      }
    },
    [canRead]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("siem.destination.changed", () => {
    void load({ showLoading: false });
  });
  useRealtime("siem.delivery.changed", () => {
    void load({ showLoading: false });
  });

  const openCreate = useCallback(() => {
    if (!requireLicenseFeature("siem-export", "SIEM destinations")) return;
    setEditingDestination(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (openCreateToken > lastHandledCreateToken.current && canManage) {
      lastHandledCreateToken.current = openCreateToken;
      openCreate();
    }
  }, [canManage, openCreate, openCreateToken]);

  const openEdit = (destination: SiemDestination) => {
    if (!requireLicenseFeature("siem-export", "SIEM destinations")) return;
    setEditingDestination(destination);
    setDialogOpen(true);
  };

  const toggle = async (destination: SiemDestination) => {
    if (!requireLicenseFeature("siem-export", "SIEM delivery")) return;
    const enabled = !destination.enabled;
    setDestinations((current) =>
      current.map((candidate) =>
        candidate.id === destination.id ? { ...candidate, enabled } : candidate
      )
    );
    try {
      const updated = await api.updateSiemDestination(destination.id, { enabled });
      setDestinations((current) => {
        const next = current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate
        );
        api.setCache(SIEM_DESTINATION_CACHE_KEY, next);
        return next;
      });
      toast.success(enabled ? "SIEM delivery enabled" : "SIEM delivery paused");
    } catch (error) {
      setDestinations((current) =>
        current.map((candidate) =>
          candidate.id === destination.id
            ? { ...candidate, enabled: destination.enabled }
            : candidate
        )
      );
      if (!handleLicenseApiError(error, "SIEM delivery")) {
        toast.error(error instanceof Error ? error.message : "Failed to update SIEM destination");
      }
    }
  };

  const test = async (destination: SiemDestination) => {
    if (!requireLicenseFeature("siem-export", "SIEM destination test")) return;
    try {
      const result = await api.testSiemDestination(destination.id);
      if (result.success) {
        toast.success(
          result.statusCode
            ? `Test succeeded — HTTP ${result.statusCode} in ${result.responseTimeMs}ms`
            : `Test event delivered in ${result.responseTimeMs}ms`
        );
      } else {
        toast.error(
          result.error ??
            `Test failed${result.statusCode ? ` (HTTP ${result.statusCode})` : ""} in ${result.responseTimeMs}ms`
        );
      }
    } catch (error) {
      if (!handleLicenseApiError(error, "SIEM destination test")) {
        toast.error(error instanceof Error ? error.message : "SIEM test failed");
      }
    }
  };

  const remove = async (destination: SiemDestination) => {
    if (!requireLicenseFeature("siem-export", "SIEM destinations")) return;
    const description = destination.pendingDeliveries
      ? `Delete "${destination.name}" and discard ${destination.pendingDeliveries} pending delivery ${destination.pendingDeliveries === 1 ? "record" : "records"}? Historical terminal records remain until audit retention cleanup.`
      : `Delete "${destination.name}"? Historical terminal records remain until audit retention cleanup.`;
    if (!(await confirm({ title: "Delete SIEM Destination", description, confirmLabel: "Delete" })))
      return;
    try {
      const result = await api.deleteSiemDestination(destination.id);
      toast.success(
        result.discardedDeliveries
          ? `Deleted and discarded ${result.discardedDeliveries} pending delivery records`
          : "SIEM destination deleted"
      );
      await load({ showLoading: false });
    } catch (error) {
      if (!handleLicenseApiError(error, "SIEM destinations")) {
        toast.error(error instanceof Error ? error.message : "Failed to delete SIEM destination");
      }
    }
  };

  const columns: SimpleTableColumn<SiemDestination>[] = [
    {
      id: "name",
      header: "Name",
      render: (destination) => (
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{destination.name}</span>
        </div>
      ),
    },
    {
      id: "endpoint",
      header: "HTTPS Endpoint",
      render: (destination) => (
        <span
          title={destination.url}
          className="block min-w-0 truncate font-mono text-sm text-muted-foreground"
        >
          {destination.url}
        </span>
      ),
    },
    {
      id: "authentication",
      header: "Auth",
      render: (destination) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{AUTH_LABEL[destination.authType]}</Badge>
          {!destination.secretConfigured && <Badge variant="destructive">Secret missing</Badge>}
        </div>
      ),
    },
    {
      id: "delivery",
      header: "Last Delivery",
      render: (destination) =>
        destination.lastDeliveryStatus ? (
          <Badge variant={siemDeliveryVariant(destination.lastDeliveryStatus)}>
            {destination.lastDeliveryStatus}
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">No deliveries yet</span>
        ),
    },
    {
      id: "pending",
      header: "Pending",
      className: "w-24",
      cellClassName: "w-24",
      render: (destination) => (
        <span className="text-sm text-muted-foreground">{destination.pendingDeliveries}</span>
      ),
    },
    {
      id: "enabled",
      header: "Active",
      className: "w-16",
      cellClassName: "w-16",
      render: (destination) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={destination.enabled}
            onChange={() => {
              if (canManage) void toggle(destination);
            }}
            disabled={!canManage}
            ariaLabel={`Toggle ${destination.name}`}
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
      render: (destination) =>
        canRead ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${destination.name}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onViewDeliveryLog(destination)}>
                  <History className="h-4 w-4" /> View delivery log
                </DropdownMenuItem>
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void test(destination)}>
                      <Send className="h-4 w-4" /> Send test event
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openEdit(destination)}>
                      <Pencil className="h-4 w-4" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => void remove(destination)}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4" /> Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  useContentLoading(initialLoading && destinations.length === 0);

  return (
    <div className="space-y-4">
      {initialLoading && destinations.length === 0 ? null : destinations.length > 0 ? (
        <div className="border border-border bg-card">
          <SimpleTable
            columns={columns}
            rows={destinations}
            getRowKey={(destination) => destination.id}
            loading={isLoading}
            loadingMessage="Loading SIEM destinations"
            onRowClick={canManage ? openEdit : undefined}
          />
        </div>
      ) : (
        <EmptyState message="No SIEM destinations configured. Add an HTTPS collector to export Gateway audit events." />
      )}
      <SiemDestinationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        destination={editingDestination}
        onSaved={() => void load({ showLoading: false })}
      />
    </div>
  );
}
