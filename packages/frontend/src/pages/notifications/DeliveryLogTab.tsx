import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ContentLoading } from "@/components/common/ContentLoading";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { RelativeTime } from "@/components/common/RelativeTime";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDialogPresence,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import type { WebhookDelivery } from "@/types";
import {
  alertSeverityVariant,
  DeliveryStatusIcon,
  httpStatusVariant,
  webhookDeliveryVariant,
} from "./notification-status";

export const DELIVERY_PAGE_SIZE = 100;

const DELIVERY_COLUMNS: ResourceListColumn<WebhookDelivery>[] = [
  { id: "status", label: "", width: "56px" },
  { id: "webhook", label: "Webhook", width: "220px" },
  { id: "event", label: "Event" },
  { id: "severity", label: "Severity", width: "120px", align: "right" },
  { id: "http", label: "HTTP", width: "96px", align: "right" },
  { id: "time", label: "Time", width: "96px", align: "right" },
  { id: "when", label: "When", width: "180px", align: "right" },
];

export function DeliveryLogTab({
  refreshToken,
  onConfigureWebhook,
}: {
  refreshToken: number;
  onConfigureWebhook?: () => void;
}) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>(
    () => api.getCached<WebhookDelivery[]>("notifications:deliveries:all") ?? []
  );
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<WebhookDelivery[]>("notifications:deliveries:all") === undefined
  );
  const initialLoading = useInitialLoading(isLoading);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const {
    open: detailOpen,
    value: detail,
    setValue: setDetail,
    onOpenChange: onDetailOpenChange,
  } = useDeferredDialogState<WebhookDelivery>();
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const pageRef = useRef(0);
  const requestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const detailPresent = useDialogPresence(detailOpen);
  useEffect(() => {
    if (detailPresent) return;
    setDetailLoadFailed(false);
    setDetailLoading(false);
  }, [detailPresent]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (resetTo: WebhookDelivery[] | null) => {
      const nextPage = resetTo ? 1 : pageRef.current + 1;
      const requestId = ++requestIdRef.current;
      const cacheKey = `notifications:deliveries:${statusFilter}`;
      if (resetTo) {
        const cached = api.getCached<WebhookDelivery[]>(cacheKey);
        if (cached) {
          pageRef.current = 1;
          setDeliveries(cached);
          setIsLoading(false);
          setHasMore(api.getCached<boolean>(`${cacheKey}:has-more`) ?? true);
        } else {
          pageRef.current = 0;
          setDeliveries([]);
          setIsLoading(true);
          setHasMore(true);
        }
      } else {
        setLoadingMore(true);
      }
      try {
        const result = await api.listDeliveries({
          page: nextPage,
          limit: DELIVERY_PAGE_SIZE,
          status: statusFilter !== "all" ? statusFilter : undefined,
        });
        if (requestId !== requestIdRef.current) return;
        const fetched = result.data || [];
        const totalPages = result.totalPages ?? 1;
        pageRef.current = nextPage;
        setDeliveries((prev) => {
          const next = resetTo ? fetched : [...prev, ...fetched];
          if (resetTo) {
            api.setCache(cacheKey, next);
            api.setCache(`${cacheKey}:has-more`, nextPage < totalPages);
          }
          return next;
        });
        setHasMore(nextPage < totalPages);
      } catch {
        toast.error("Failed to load deliveries");
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [statusFilter]
  );

  const openDeliveryDetail = async (delivery: WebhookDelivery) => {
    const requestId = ++detailRequestIdRef.current;
    setDetailLoadFailed(false);
    setDetailLoading(true);
    setDetail(delivery);
    try {
      const full = await api.getDelivery(delivery.id);
      if (requestId !== detailRequestIdRef.current) return;
      setDetail(full);
    } catch {
      if (requestId !== detailRequestIdRef.current) return;
      setDetailLoadFailed(true);
      toast.error("Failed to load delivery details");
    } finally {
      if (requestId === detailRequestIdRef.current) setDetailLoading(false);
    }
  };

  useEffect(() => {
    pageRef.current = 0;
    fetchPage([]);
  }, [fetchPage]);

  useEffect(() => {
    if (refreshToken > 0) {
      pageRef.current = 0;
      void fetchPage([]);
    }
  }, [fetchPage, refreshToken]);

  useRealtime("alert.fired", () => {
    pageRef.current = 0;
    void fetchPage([]);
  });

  useRealtime("alert.resolved", () => {
    pageRef.current = 0;
    void fetchPage([]);
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !isLoading) {
          void fetchPage(null);
        }
      },
      { root, rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchPage, hasMore, loadingMore, isLoading]);

  const filteredDeliveries = useMemo(() => {
    if (!search) return deliveries;
    const q = search.toLowerCase();
    return deliveries.filter((delivery) =>
      [
        delivery.webhookName,
        delivery.webhookId,
        delivery.eventType,
        delivery.severity,
        delivery.responseStatus != null ? String(delivery.responseStatus) : "",
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [deliveries, search]);

  const deliveryFooterText = loadingMore
    ? "Loading more..."
    : !hasMore && deliveries.length > 0
      ? "End of logs"
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchFilterBar
        placeholder="Search by webhook, event, severity, or HTTP status..."
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={() => setSearch(searchInput)}
        hasActiveFilters={statusFilter !== "all" || search !== ""}
        onReset={() => {
          setSearchInput("");
          setSearch("");
          setStatusFilter("all");
        }}
        filters={
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="retrying">Retrying</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="superseded">Not sent</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {isLoading && deliveries.length === 0 ? (
        // The first load holds the tab; a filter without cached results loads in place.
        initialLoading ? (
          <ContentLoading loading />
        ) : (
          <LoadingSpinner label="Loading deliveries" />
        )
      ) : deliveries.length === 0 ? (
        <EmptyState
          message="No deliveries yet. Delivery attempts will appear here when alerts fire."
          actionLabel={onConfigureWebhook ? "Configure a webhook" : undefined}
          onAction={onConfigureWebhook}
        />
      ) : (
        <ResourceListFrame minWidth={800} innerClassName="flex flex-col">
          <ResourceListHeaderTable columns={DELIVERY_COLUMNS} />
          <div ref={scrollRef} className="max-h-[calc(100dvh-18rem)] overflow-auto">
            <ResourceListTable
              columns={DELIVERY_COLUMNS}
              bodyClassName="[&>tr:last-child]:border-b-0"
            >
              {filteredDeliveries.length === 0 ? (
                <ResourceListRow className="opacity-100">
                  <ResourceListCell colSpan={7} contentClassName="block p-0">
                    <EmptyState message="No deliveries match the current search." embedded />
                  </ResourceListCell>
                </ResourceListRow>
              ) : (
                filteredDeliveries.map((d) => (
                  <ResourceListRow
                    key={d.id}
                    interactive
                    onClick={() => void openDeliveryDetail(d)}
                  >
                    <ResourceListCell>
                      <DeliveryStatusIcon
                        state={
                          d.status === "success"
                            ? "delivered"
                            : d.status === "failed"
                              ? "failed"
                              : d.status === "pending"
                                ? "pending"
                                : d.status === "superseded"
                                  ? "skipped"
                                  : "in-progress"
                        }
                      />
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm font-medium">
                        {d.webhookName ?? d.webhookId.slice(0, 8)}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="min-w-0">
                      <span className="truncate font-mono text-sm text-muted-foreground">
                        {d.eventType}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell align="right">
                      <Badge variant={alertSeverityVariant(d.severity)}>{d.severity}</Badge>
                    </ResourceListCell>
                    <ResourceListCell align="right">
                      {d.responseStatus ? (
                        <Badge variant={httpStatusVariant(d.responseStatus)}>
                          {d.responseStatus}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </ResourceListCell>
                    <ResourceListCell align="right">
                      <span className="text-sm text-muted-foreground">
                        {d.responseTimeMs != null ? `${d.responseTimeMs}ms` : "—"}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell align="right">
                      <RelativeTime value={d.createdAt} className="text-xs text-muted-foreground" />
                    </ResourceListCell>
                  </ResourceListRow>
                ))
              )}
              <ResourceListRow className="border-b-0 opacity-100">
                <ResourceListCell colSpan={7} contentClassName="min-h-0 p-0">
                  <div
                    ref={sentinelRef}
                    className={`flex w-full items-center justify-center px-3 text-xs text-muted-foreground ${
                      deliveryFooterText ? "h-8" : "h-px overflow-hidden"
                    }`}
                    aria-live="polite"
                  >
                    {deliveryFooterText}
                  </div>
                </ResourceListCell>
              </ResourceListRow>
            </ResourceListTable>
          </div>
        </ResourceListFrame>
      )}
      {detail && (
        <Dialog
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) detailRequestIdRef.current++;
            onDetailOpenChange(open);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Delivery Details</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              {/* The dialog opens once the full request and response bodies arrive. */}
              <ContentLoading loading={detailLoading} />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <Badge variant={webhookDeliveryVariant(detail.status)} size="inline">
                    {detail.status === "superseded" ? "not sent" : detail.status}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Event:</span> {detail.eventType}
                </div>
                <div>
                  <span className="text-muted-foreground">HTTP:</span>{" "}
                  {detail.responseStatus ? (
                    <Badge variant={httpStatusVariant(detail.responseStatus)} size="inline">
                      {detail.responseStatus}
                    </Badge>
                  ) : (
                    "N/A"
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">Time:</span>{" "}
                  {detail.responseTimeMs != null ? `${detail.responseTimeMs}ms` : "N/A"}
                </div>
                <div>
                  <span className="text-muted-foreground">Attempts:</span> {detail.attempt}
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>{" "}
                  {formatDateTime(detail.createdAt)}
                </div>
              </div>
              {detail.error && (
                <div>
                  <p className="text-sm font-medium mb-1">
                    {detail.status === "superseded" ? "Reason" : "Error"}
                  </p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap">
                    {detail.error}
                  </pre>
                </div>
              )}
              {(detail.requestBody ?? detail.requestBodyPreview) && (
                <div>
                  <p className="text-sm font-medium mb-1">Request Body</p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap max-h-[200px] overflow-auto font-mono">
                    {detail.requestBody ?? detail.requestBodyPreview}
                  </pre>
                  {!detail.requestBody && detail.requestBodyTruncated && detailLoadFailed && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Preview truncated. Full details could not be loaded.
                    </p>
                  )}
                </div>
              )}
              {(detail.responseBody ?? detail.responseBodyPreview) && (
                <div>
                  <p className="text-sm font-medium mb-1">Response Body</p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap max-h-[200px] overflow-auto font-mono">
                    {detail.responseBody ?? detail.responseBodyPreview}
                  </pre>
                  {!detail.responseBody && detail.responseBodyTruncated && detailLoadFailed && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Preview truncated. Full details could not be loaded.
                    </p>
                  )}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
