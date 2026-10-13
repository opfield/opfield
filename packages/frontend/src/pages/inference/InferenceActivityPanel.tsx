import { Activity } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/lib/api-error-toast";
import { getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import type {
  InferenceActivity,
  InferenceActivityFilters,
  InferenceActivityPage,
  InferenceActivityQuery,
} from "@/types/inference";

type ActivityStatus = NonNullable<InferenceActivityQuery["status"]> | "all";

export function InferenceActivityPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const cachedRecent = api.getCached<InferenceActivityPage>(
    "req:/api/inference/usage/activity?page=1&limit=6",
    Number.POSITIVE_INFINITY
  );
  const [recent, setRecent] = useState<InferenceActivity[]>(cachedRecent?.data ?? []);
  const [recentLoading, setRecentLoading] = useState(!cachedRecent);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<InferenceActivity[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<ActivityStatus>("all");
  const [userId, setUserId] = useState("all");
  const [model, setModel] = useState("all");
  const [filterOptions, setFilterOptions] = useState<InferenceActivityFilters>({
    users: [],
    models: [],
  });
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [filtersLoading, setFiltersLoading] = useState(false);
  const requestId = useRef(0);
  const filterRequestId = useRef(0);
  const loadingMore = useRef(false);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const recentInitializedRef = useRef(Boolean(cachedRecent));
  useContentLoading(recentLoading);

  const loadRecent = useCallback(async () => {
    if (!recentInitializedRef.current) setRecentLoading(true);
    try {
      const page = await api.listInferenceActivity({ page: 1, limit: 6 });
      setRecent(page.data);
      recentInitializedRef.current = true;
    } catch (error) {
      toastApiError(error, "Failed to load inference activity");
    } finally {
      setRecentLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshToken;
    void loadRecent();
  }, [loadRecent, refreshToken]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadPage = useCallback(
    async (page: number, replace: boolean) => {
      if (!replace && loadingMore.current) return;
      const currentRequest = ++requestId.current;
      if (replace) {
        setNextPage(null);
      } else {
        loadingMore.current = true;
      }
      setLoading(true);
      try {
        const result = await api.listInferenceActivity({
          page,
          limit: 50,
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
          ...(status !== "all" ? { status } : {}),
          ...(userId !== "all" ? { userId } : {}),
          ...(model !== "all" ? { model } : {}),
        });
        if (currentRequest !== requestId.current) return;
        setRows((current) => (replace ? result.data : [...current, ...result.data]));
        setNextPage(result.nextPage);
      } catch (error) {
        if (currentRequest === requestId.current) {
          toastApiError(error, "Failed to load inference activity");
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [debouncedSearch, model, status, userId]
  );

  useEffect(() => {
    void refreshToken;
    if (!open) return;
    void loadPage(1, true);
  }, [loadPage, open, refreshToken]);

  useEffect(() => {
    void refreshToken;
    if (!open) return;
    const currentRequest = ++filterRequestId.current;
    void api
      .listInferenceActivityFilters()
      .then((options) => {
        if (currentRequest === filterRequestId.current) setFilterOptions(options);
      })
      .catch((error) => {
        if (currentRequest === filterRequestId.current) {
          toastApiError(error, "Failed to load activity filters");
        }
      })
      .finally(() => {
        if (currentRequest === filterRequestId.current) setFiltersLoading(false);
      });
  }, [open, refreshToken]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = tableScrollRef.current;
    if (!open || !sentinel || !root || !nextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore.current) {
          void loadPage(nextPage, false);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadPage, nextPage, open]);

  const openAll = () => {
    requestId.current += 1;
    filterRequestId.current += 1;
    loadingMore.current = false;
    setRows([]);
    setNextPage(null);
    setLoading(true);
    setSearch("");
    setDebouncedSearch("");
    setStatus("all");
    setUserId("all");
    setModel("all");
    setFilterOptions({ users: [], models: [] });
    setFiltersLoading(true);
    setOpen(true);
  };

  const close = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      requestId.current += 1;
      filterRequestId.current += 1;
      loadingMore.current = false;
    }
  };

  const userOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All users" },
      ...filterOptions.users.map((user) => ({
        value: user.id,
        label: user.name || user.email,
        keywords: user.email,
      })),
    ],
    [filterOptions.users]
  );
  const modelOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All models" },
      ...filterOptions.models.map((item) => ({ value: item, label: item })),
    ],
    [filterOptions.models]
  );
  const activityTableHeight = rows.length ? 49 + rows.length * 49 + 44 : undefined;

  const previewColumns = useMemo<SimpleTableColumn<InferenceActivity>[]>(
    () => [
      { id: "user", header: "User", render: (row) => <ActivityUser row={row} /> },
      { id: "model", header: "Model", render: (row) => <ActivityModel row={row} /> },
      { id: "status", header: "Status", render: (row) => <StatusBadge row={row} /> },
      {
        id: "cost",
        header: "Cost",
        align: "right",
        render: formatActivityCost,
      },
      {
        id: "time",
        header: "Time",
        align: "right",
        cellClassName: "text-muted-foreground",
        render: (row) => <RelativeTime value={row.startedAt} />,
      },
    ],
    []
  );

  return (
    <TooltipProvider>
      <PanelShell
        icon={<Activity className="h-4 w-4" />}
        title="Recent activity"
        description="Request metadata and normalized usage; prompts and outputs are never stored"
        actions={
          <Button
            variant="ghost"
            className="h-auto p-0 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={openAll}
          >
            View all
          </Button>
        }
      >
        <SimpleTable
          columns={previewColumns}
          rows={recent}
          getRowKey={(row) => row.id}
          loading={recentLoading}
          loadingMessage="Loading activity..."
          emptyMessage="No inference activity"
          tableClassName="min-w-[720px]"
        />
      </PanelShell>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-h-[85dvh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Inference Activity</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Metadata-only request history. Scroll the table to load older requests.
          </DialogDescription>
          <ActivityDialogBody initialLoading={(loading && rows.length === 0) || filtersLoading}>
            <SearchFilterBar
              search={search}
              onSearchChange={setSearch}
              hasActiveFilters={Boolean(
                search || status !== "all" || userId !== "all" || model !== "all"
              )}
              onReset={() => {
                setSearch("");
                setStatus("all");
                setUserId("all");
                setModel("all");
              }}
              placeholder="Search user, model, status, or error..."
              inlineFilters
              filters={
                <>
                  <Select
                    value={status}
                    onValueChange={(value) => setStatus(value as ActivityStatus)}
                  >
                    <SelectTrigger className="w-40" aria-label="Activity status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      <SelectItem value="reserved">Reserved</SelectItem>
                      <SelectItem value="running">Running</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                  <Combobox
                    value={userId}
                    options={userOptions}
                    onValueChange={setUserId}
                    placeholder="All users"
                    searchPlaceholder="Search users..."
                    ariaLabel="Activity user"
                    className="w-52"
                  />
                  <Combobox
                    value={model}
                    options={modelOptions}
                    onValueChange={setModel}
                    placeholder="All models"
                    searchPlaceholder="Search models..."
                    ariaLabel="Activity model"
                    className="w-52"
                  />
                </>
              }
            />
            <div
              className="max-h-[min(56dvh,36rem)]"
              style={activityTableHeight ? { height: activityTableHeight } : undefined}
            >
              <DataTable
                columns={activityColumns}
                data={rows}
                keyFn={(row) => row.id}
                horizontalScroll
                minWidth="52rem"
                className="h-full"
                fixedRowHeight={49}
                emptyMessage="No inference activity"
                scrollRef={tableScrollRef}
                footer={
                  nextPage ? (
                    <div
                      ref={sentinelRef}
                      className="py-3 text-center text-xs text-muted-foreground"
                    >
                      {loading ? "Loading more…" : "Scroll to load older requests"}
                    </div>
                  ) : null
                }
              />
            </div>
          </ActivityDialogBody>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/**
 * The dialog opens once the first page and the filter options are in; later
 * filter and page requests update the table in place.
 */
function ActivityDialogBody({
  initialLoading,
  children,
}: {
  initialLoading: boolean;
  children: ReactNode;
}) {
  useContentLoading(initialLoading);
  return <div className="space-y-3 overflow-hidden">{children}</div>;
}

const activityColumns: DataTableColumn<InferenceActivity>[] = [
  {
    key: "time",
    header: "Time",
    width: "11rem",
    render: (row) => <RelativeTime value={row.startedAt} />,
  },
  {
    key: "user",
    header: "User",
    width: "minmax(11.5rem,0.95fr)",
    truncate: true,
    render: (row) => <ActivityUser row={row} />,
  },
  {
    key: "model",
    header: "Model",
    width: "minmax(10rem,1fr)",
    truncate: true,
    render: (row) => <ActivityModel row={row} />,
  },
  { key: "status", header: "Status", width: "7.75rem", render: (row) => <StatusBadge row={row} /> },
  {
    key: "tokens",
    header: "Tokens",
    width: "6rem",
    align: "right",
    render: (row) => totalTokens(row).toLocaleString(),
  },
  {
    key: "cost",
    header: "Cost",
    width: "6.5rem",
    align: "right",
    render: formatActivityCost,
  },
];

function ActivityModel({ row }: { row: InferenceActivity }) {
  const connectionName = row.providerConnectionName ?? "Deleted provider account";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block max-w-full cursor-help truncate align-bottom">
          {row.publicModelId}
          {row.reasoningEffort ? ` ${row.reasoningEffort}` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-0.5">
          <p>{connectionName}</p>
          {row.providerAccountLabel && row.providerAccountLabel !== connectionName ? (
            <p className="text-muted-foreground">{row.providerAccountLabel}</p>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function ActivityUser({ row }: { row: InferenceActivity }) {
  const label = row.userName || row.userEmail || "Deleted user";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="h-7 w-7 shrink-0">
        <AvatarImage src={row.userAvatarUrl ?? undefined} />
        <AvatarFallback className="text-xs">{getInitials(label)}</AvatarFallback>
      </Avatar>
      <span className="truncate font-medium">{label}</span>
    </span>
  );
}

function StatusBadge({ row }: { row: InferenceActivity }) {
  return (
    <Badge
      variant={
        row.status === "completed"
          ? "success"
          : row.status === "failed"
            ? "destructive"
            : "secondary"
      }
      size="inline"
    >
      {row.status}
    </Badge>
  );
}

function totalTokens(row: InferenceActivity) {
  return (
    row.uncachedInputTokens +
    row.cachedInputTokens +
    row.cacheWriteTokens +
    row.outputTokens +
    row.reasoningTokens
  );
}

function formatActivityCost(row: InferenceActivity) {
  return row.budgetType === "api"
    ? `$${(row.apiMicrodollars / 1_000_000).toFixed(4)}`
    : `${row.credits.toFixed(2)} cr`;
}
