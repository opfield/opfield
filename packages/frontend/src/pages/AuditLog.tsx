import { Download, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageHeader } from "@/components/common/PageHeader";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SCOPE_PICKER_VIEWPORT } from "@/components/common/ScopePicker";
import { ValueTile } from "@/components/common/ValueTile";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api-error-toast";
import { formatDateTime } from "@/lib/utils";
import { AUDIT_ACTION_OPTIONS, getAuditActionLabel } from "@/pages/audit-log/audit-action-labels";
import {
  type AuditExportFormat,
  type AuditFilterUserOption,
  buildAuditExportFilename,
  downloadTextFile,
  formatAuditExport,
  formatAuditToken,
  getAuditDescription,
  getAuditEntryUserKey,
  getAuditEntryUserLabel,
  getAuditResourceDisplay,
  mergeAuditFilterUsers,
  mergeAuditFilterValues,
} from "@/pages/audit-log/audit-format";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type { AuditLogEntry } from "@/types";

const PAGE_SIZE = 100;
const EXPORT_FORMATS: readonly AuditExportFormat[] = ["csv", "tsv", "txt", "html"];
const DIALOG_CLOSE_RESET_MS = 260;
const AUDIT_VIEW_STORAGE_KEY = "gateway:audit-log:view";
const SYSTEM_USER_FILTER = "system";

interface AuditViewConfig {
  excludedActions: string[];
  excludedResourceTypes: string[];
}

const DEFAULT_AUDIT_VIEW_CONFIG: AuditViewConfig = {
  excludedActions: [],
  excludedResourceTypes: [],
};
/** The download starts at this window; the server refuses exports above its entry cap. */
const AUDIT_EXPORT_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Resource keys no audit entry is written with ("certificate_authority" is an alert
 * resource; CA audit entries use "ca"). Dropped from saved views so the lists show no near-duplicates.
 */
const NON_AUDIT_RESOURCE_TYPES = new Set(["certificate_authority"]);
const DEFAULT_AUDIT_CACHE_KEY = "admin:audit:all:all:all::";
const AUDIT_RESOURCE_OPTIONS = [
  "access_list",
  "api-token",
  "ca",
  "certificate",
  "cloud-link",
  "database",
  "docker-container",
  "docker-deployment",
  "docker-image",
  "docker-health-check",
  "docker-network",
  "docker-registry",
  "docker-secret",
  "docker-volume",
  "docker-webhook",
  "docker_folder",
  "domain",
  "http-route",
  "nginx_template",
  "node",
  "notification_alert_rule",
  "notification_webhook",
  "permission_group",
  "proxy_host",
  "proxy_host_folder",
  "session",
  "settings",
  "ssl_certificate",
  "user",
] as const;

function readAuditViewConfig(): AuditViewConfig {
  if (typeof window === "undefined") return DEFAULT_AUDIT_VIEW_CONFIG;
  try {
    const raw = window.localStorage.getItem(AUDIT_VIEW_STORAGE_KEY);
    if (!raw) return DEFAULT_AUDIT_VIEW_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AuditViewConfig>;
    return {
      excludedActions: Array.isArray(parsed.excludedActions) ? parsed.excludedActions : [],
      excludedResourceTypes: Array.isArray(parsed.excludedResourceTypes)
        ? parsed.excludedResourceTypes.filter((type) => !NON_AUDIT_RESOURCE_TYPES.has(type))
        : [],
    };
  } catch {
    return DEFAULT_AUDIT_VIEW_CONFIG;
  }
}

function writeAuditViewConfig(config: AuditViewConfig) {
  window.localStorage.setItem(AUDIT_VIEW_STORAGE_KEY, JSON.stringify(config));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : uniqueSorted([...values, value]);
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A Date as a `datetime-local` input value (local time, minute precision). */
function dateToLocalDateTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getAuditUserLabel(entry: AuditLogEntry): string {
  return entry.userName || entry.userEmail || "System";
}

function getAuditUserInitials(entry: AuditLogEntry): string {
  const label = getAuditUserLabel(entry);
  if (label === "System") return "SY";
  return label
    .split(/[\s@._-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const columns: DataTableColumn<AuditLogEntry>[] = [
  {
    key: "user",
    header: "User",
    width: "minmax(180px, 1fr)",
    truncate: true,
    render: (entry) => {
      const label = getAuditUserLabel(entry);
      const isSystem = label === "System";
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar className="h-7 w-7">
            {!isSystem && <AvatarImage src={entry.userAvatarUrl ?? undefined} />}
            <AvatarFallback className="text-xs">
              {isSystem ? <Settings className="h-3.5 w-3.5" /> : getAuditUserInitials(entry)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{label}</span>
        </span>
      );
    },
  },
  {
    key: "action",
    header: "Action",
    width: "minmax(180px, 1fr)",
    render: (entry) => (
      <span title={entry.action} className="text-muted-foreground">
        {getAuditActionLabel(entry.action)}
      </span>
    ),
  },
  {
    key: "description",
    header: "Description",
    width: "minmax(220px, 1.4fr)",
    truncate: true,
    render: (entry) => {
      const description = getAuditDescription(entry);
      return (
        <span className="text-muted-foreground" title={description ?? undefined}>
          {description ?? "—"}
        </span>
      );
    },
  },
  {
    key: "resource",
    header: "Resource",
    width: "minmax(260px, 1.6fr)",
    truncate: true,
    render: (entry) => {
      const resource = getAuditResourceDisplay(entry);
      return (
        <span className="text-muted-foreground" title={resource.title}>
          {resource.label}
        </span>
      );
    },
  },
  {
    key: "ip",
    header: "IP Address",
    width: "minmax(160px, 0.75fr)",
    truncate: true,
    render: (entry) => (
      <span
        className="font-mono text-xs text-muted-foreground"
        title={entry.ipAddress ?? undefined}
      >
        {entry.ipAddress || "—"}
      </span>
    ),
  },
  {
    key: "time",
    header: "Time",
    width: "minmax(130px, 0.65fr)",
    align: "right",
    render: (entry) => <RelativeTime value={entry.createdAt} className="text-muted-foreground" />,
  },
];

export function AuditLog({
  embedded = false,
  headerActionsTarget,
}: {
  embedded?: boolean;
  headerActionsTarget?: HTMLElement | null;
}) {
  const initialViewConfig = useMemo(() => readAuditViewConfig(), []);
  // A link can open the log filtered: ?action=…&resource=….
  const [searchParams] = useSearchParams();
  const [initialFilters] = useState(() => ({
    action: searchParams.get("action")?.trim() || "all",
    resource: searchParams.get("resource")?.trim() || "all",
  }));
  const initialAuditCacheKey =
    initialFilters.action !== "all" ||
    initialFilters.resource !== "all" ||
    initialViewConfig.excludedActions.length > 0 ||
    initialViewConfig.excludedResourceTypes.length > 0
      ? `admin:audit:${initialFilters.action}:${initialFilters.resource}:all:${initialViewConfig.excludedActions.join(",")}:${initialViewConfig.excludedResourceTypes.join(",")}`
      : DEFAULT_AUDIT_CACHE_KEY;
  const [entries, setEntries] = useState<AuditLogEntry[]>(
    () => api.getCached<AuditLogEntry[]>(initialAuditCacheKey) ?? []
  );
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [entryDetailsOpen, setEntryDetailsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<AuditLogEntry[]>(initialAuditCacheKey) === undefined
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(
    () => api.getCached<number>(`${initialAuditCacheKey}:total`) ?? 0
  );
  const [actionFilter, setActionFilter] = useState(initialFilters.action);
  const [resourceFilter, setResourceFilter] = useState(initialFilters.resource);
  const [userFilter, setUserFilter] = useState("all");
  const [knownActions, setKnownActions] = useState<string[]>(() =>
    mergeAuditFilterValues(
      [...AUDIT_ACTION_OPTIONS],
      [
        ...initialViewConfig.excludedActions,
        ...(initialFilters.action === "all" ? [] : [initialFilters.action]),
        ...entries.map((entry) => entry.action),
      ]
    )
  );
  const [knownResources, setKnownResources] = useState<string[]>(() =>
    mergeAuditFilterValues(
      [...AUDIT_RESOURCE_OPTIONS],
      [
        ...initialViewConfig.excludedResourceTypes,
        ...(initialFilters.resource === "all" ? [] : [initialFilters.resource]),
        ...entries.map((entry) => entry.resourceType),
      ]
    )
  );
  const [knownUsers, setKnownUsers] = useState<AuditFilterUserOption[]>([]);
  const [viewConfig, setViewConfig] = useState<AuditViewConfig>(initialViewConfig);
  const [draftViewConfig, setDraftViewConfig] = useState<AuditViewConfig>(viewConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Export is a Business feature: without it the download actions are hidden.
  const exportIncluded = usePlanIncludes("audit-export");
  const [exportFormat, setExportFormat] = useState<AuditExportFormat>("csv");
  const [exportActions, setExportActions] = useState<string[]>([]);
  const [exportResourceTypes, setExportResourceTypes] = useState<string[]>([]);
  const [exportUserIds, setExportUserIds] = useState<string[]>([]);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const pageRef = useRef(0);
  const requestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const configSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingViewConfigRef = useRef<AuditViewConfig | null>(null);
  const selectedEntryResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const actionOptions = useMemo(
    () =>
      mergeAuditFilterValues(knownActions, [
        ...viewConfig.excludedActions,
        ...(actionFilter === "all" ? [] : [actionFilter]),
      ]),
    [actionFilter, knownActions, viewConfig.excludedActions]
  );
  const resourceOptions = useMemo(
    () =>
      mergeAuditFilterValues(knownResources, [
        ...viewConfig.excludedResourceTypes,
        ...(resourceFilter === "all" ? [] : [resourceFilter]),
      ]),
    [knownResources, resourceFilter, viewConfig.excludedResourceTypes]
  );
  const actionComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All actions" },
      ...actionOptions.map((action) => ({
        value: action,
        label: getAuditActionLabel(action),
        keywords: action,
      })),
    ],
    [actionOptions]
  );
  const resourceComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All resources" },
      ...resourceOptions.map((resourceType) => ({
        value: resourceType,
        label: formatAuditToken(resourceType),
        keywords: resourceType,
      })),
    ],
    [resourceOptions]
  );
  const userComboboxOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "all", label: "All users" },
      ...knownUsers.map((user) => ({ value: user.id, label: user.label })),
    ],
    [knownUsers]
  );
  const hiddenFilterCount =
    viewConfig.excludedActions.length + viewConfig.excludedResourceTypes.length;
  const auditCacheKey = useMemo(
    () =>
      `admin:audit:${actionFilter}:${resourceFilter}:${userFilter}:${viewConfig.excludedActions.join(",")}:${viewConfig.excludedResourceTypes.join(",")}`,
    [actionFilter, resourceFilter, userFilter, viewConfig]
  );

  const rememberUsers = useCallback((items: AuditLogEntry[]) => {
    setKnownUsers((prev) =>
      mergeAuditFilterUsers(
        prev,
        items.map((entry) => ({
          id: getAuditEntryUserKey(entry),
          label: getAuditEntryUserLabel(entry),
        }))
      )
    );
    setKnownActions((prev) =>
      mergeAuditFilterValues(
        prev,
        items.map((entry) => entry.action)
      )
    );
    setKnownResources((prev) =>
      mergeAuditFilterValues(
        prev,
        items.map((entry) => entry.resourceType)
      )
    );
  }, []);

  const fetchPage = useCallback(
    async (resetTo: AuditLogEntry[] | null) => {
      const nextPage = resetTo ? 1 : pageRef.current + 1;
      const requestId = ++requestIdRef.current;
      if (resetTo) {
        const cached = api.getCached<AuditLogEntry[]>(auditCacheKey);
        if (cached) {
          const cachedTotal = api.getCached<number>(`${auditCacheKey}:total`) ?? cached.length;
          pageRef.current = 1;
          setEntries(cached);
          setTotal(cachedTotal);
          setHasMore(cached.length < cachedTotal);
          setIsLoading(false);
        } else {
          pageRef.current = 0;
          setEntries([]);
          setTotal(0);
          setIsLoading(true);
          setHasMore(true);
        }
      } else {
        setLoadingMore(true);
      }
      try {
        const result = await api.getAuditLog({
          page: nextPage,
          limit: PAGE_SIZE,
          action: actionFilter !== "all" ? actionFilter : undefined,
          resourceType: resourceFilter !== "all" ? resourceFilter : undefined,
          userId: userFilter !== "all" ? userFilter : undefined,
          excludedActions: viewConfig.excludedActions,
          excludedResourceTypes: viewConfig.excludedResourceTypes,
        });
        if (requestId !== requestIdRef.current) return; // stale (filters changed mid-flight)
        const fetched: AuditLogEntry[] = result.data || [];
        rememberUsers(fetched);
        const totalPages = result.pagination?.totalPages ?? 1;
        const nextTotal = result.pagination?.total ?? 0;
        setTotal(nextTotal);
        pageRef.current = nextPage;
        setEntries((prev) => {
          const next = resetTo ? fetched : [...prev, ...fetched];
          if (resetTo) {
            api.setCache(auditCacheKey, next);
            api.setCache(`${auditCacheKey}:total`, nextTotal);
          }
          return next;
        });
        setHasMore(nextPage < totalPages);
      } catch {
        /* ignore */
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [actionFilter, auditCacheKey, resourceFilter, userFilter, viewConfig, rememberUsers]
  );

  const openConfigureDialog = () => {
    if (configSaveTimerRef.current) {
      clearTimeout(configSaveTimerRef.current);
      configSaveTimerRef.current = null;
    }
    const pendingConfig = pendingViewConfigRef.current;
    if (pendingConfig) {
      pendingViewConfigRef.current = null;
      setViewConfig(pendingConfig);
      setDraftViewConfig(pendingConfig);
    } else {
      setDraftViewConfig(viewConfig);
    }
    setConfigOpen(true);
  };

  const closeConfigureDialog = () => {
    setConfigOpen(false);
  };

  const handleConfigureOpenChange = (open: boolean) => {
    if (open) {
      setConfigOpen(true);
      return;
    }
    closeConfigureDialog();
  };

  const saveViewConfig = () => {
    const next = {
      excludedActions: uniqueSorted(draftViewConfig.excludedActions),
      excludedResourceTypes: uniqueSorted(draftViewConfig.excludedResourceTypes),
    };
    writeAuditViewConfig(next);
    closeConfigureDialog();
    if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
    pendingViewConfigRef.current = next;
    configSaveTimerRef.current = setTimeout(() => {
      if (pendingViewConfigRef.current) {
        setViewConfig(pendingViewConfigRef.current);
        pendingViewConfigRef.current = null;
      }
      configSaveTimerRef.current = null;
    }, DIALOG_CLOSE_RESET_MS);
  };

  const resetViewConfig = () => {
    setDraftViewConfig(DEFAULT_AUDIT_VIEW_CONFIG);
  };

  const openExportDialog = (format: AuditExportFormat) => {
    if (!requireLicenseFeature("audit-export", "Audit log export")) return;
    setExportFormat(format);
    setExportActions(actionFilter !== "all" ? [actionFilter] : []);
    setExportResourceTypes(resourceFilter !== "all" ? [resourceFilter] : []);
    setExportUserIds(userFilter !== "all" ? [userFilter] : []);
    setExportFrom(dateToLocalDateTimeInput(new Date(Date.now() - AUDIT_EXPORT_DEFAULT_WINDOW_MS)));
    setExportTo("");
    setExportOpen(true);
  };

  const closeExportDialog = () => {
    setExportOpen(false);
  };

  const handleExportOpenChange = (open: boolean) => {
    if (open) {
      setExportOpen(true);
      return;
    }
    closeExportDialog();
  };

  const openEntryDetails = (entry: AuditLogEntry) => {
    if (selectedEntryResetTimerRef.current) {
      clearTimeout(selectedEntryResetTimerRef.current);
      selectedEntryResetTimerRef.current = null;
    }
    setSelectedEntry(entry);
    setEntryDetailsOpen(true);
  };

  const closeEntryDetails = () => {
    setEntryDetailsOpen(false);
    if (selectedEntryResetTimerRef.current) clearTimeout(selectedEntryResetTimerRef.current);
    selectedEntryResetTimerRef.current = setTimeout(() => {
      setSelectedEntry(null);
      selectedEntryResetTimerRef.current = null;
    }, DIALOG_CLOSE_RESET_MS);
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const exportedEntries = await api.exportAuditLog({
        actions: exportActions,
        resourceTypes: exportResourceTypes,
        userIds: exportUserIds,
        from: localDateTimeToIso(exportFrom),
        to: localDateTimeToIso(exportTo),
        excludedActions: viewConfig.excludedActions,
        excludedResourceTypes: viewConfig.excludedResourceTypes,
      });
      const { content, type } = formatAuditExport(exportedEntries, exportFormat);
      downloadTextFile(content, buildAuditExportFilename(exportFormat), type);
      closeExportDialog();
      toast.success(`Exported ${exportedEntries.length} audit log entries`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "AUDIT_EXPORT_TOO_LARGE") {
        toast.error(
          "Too many entries for one file (50,000 at most). Choose a later From date or an earlier To date and download again."
        );
      } else if (!handleLicenseApiError(error, "Audit log export")) {
        toastApiError(error, "Failed to export audit log");
      }
    } finally {
      setExporting(false);
    }
  };

  // Initial load + reset on filter change
  useEffect(() => {
    pageRef.current = 0;
    fetchPage([]);
  }, [fetchPage]);

  useEffect(() => {
    return () => {
      if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
      if (selectedEntryResetTimerRef.current) clearTimeout(selectedEntryResetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    api
      .getAuditUsers()
      .then((users) => {
        setKnownUsers((current) =>
          mergeAuditFilterUsers(
            current,
            users.map((user) => ({
              id: user.userId ?? SYSTEM_USER_FILTER,
              label: user.userName || user.userEmail || (user.userId ? user.userId : "System"),
            }))
          )
        );
      })
      .catch(() => {});
  }, []);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !isLoading) {
          fetchPage(null);
        }
      },
      { root, rootMargin: "400px" }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [fetchPage, hasMore, loadingMore, isLoading]);

  const auditActions = (
    <ResponsiveHeaderActions
      actions={[
        {
          label: "Configure",
          icon: <Settings className="h-4 w-4" />,
          onClick: openConfigureDialog,
        },
        ...(exportIncluded ? EXPORT_FORMATS : []).map((format, index) => ({
          label: `Download ${format.toUpperCase()}`,
          icon: <Download className="h-4 w-4" />,
          onClick: () => openExportDialog(format),
          separatorBefore: index === 0,
        })),
      ]}
    >
      <Button variant="outline" onClick={openConfigureDialog}>
        <Settings className="h-4 w-4" />
        Configure
      </Button>
      {(exportIncluded ? EXPORT_FORMATS : []).map((format) => (
        <Button key={format} variant="outline" onClick={() => openExportDialog(format)}>
          <Download className="h-4 w-4" />
          {format.toUpperCase()}
        </Button>
      ))}
    </ResponsiveHeaderActions>
  );

  const headerActionsPortal =
    embedded && headerActionsTarget ? createPortal(auditActions, headerActionsTarget) : null;

  const content = (
    <>
      {headerActionsPortal}
      <div
        className={
          embedded
            ? "h-full space-y-4 flex flex-col min-h-0"
            : "h-full p-6 space-y-4 flex flex-col min-h-0"
        }
      >
        {!embedded && (
          <PageHeader
            leading={<LiteModeBackButton />}
            title="Audit Log"
            description={`${total} entries${
              hiddenFilterCount ? ` · ${hiddenFilterCount} hidden by local view` : ""
            }`}
            actions={auditActions}
          />
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="w-48">
            <Combobox
              value={actionFilter}
              options={actionComboboxOptions}
              onValueChange={setActionFilter}
              showAllOptionsOnFocus
              placeholder="All actions"
              searchPlaceholder="Search actions..."
              emptyMessage="No matching actions."
              ariaLabel="Filter audit actions"
            />
          </div>
          <div className="w-48">
            <Combobox
              value={resourceFilter}
              options={resourceComboboxOptions}
              onValueChange={setResourceFilter}
              showAllOptionsOnFocus
              placeholder="All resources"
              searchPlaceholder="Search resources..."
              emptyMessage="No matching resources."
              ariaLabel="Filter audit resources"
            />
          </div>
          <div className="w-56">
            <Combobox
              value={userFilter}
              options={userComboboxOptions}
              onValueChange={setUserFilter}
              showAllOptionsOnFocus
              placeholder="All users"
              searchPlaceholder="Search users..."
              emptyMessage="No matching users."
              ariaLabel="Filter audit users"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <DataTable
            columns={columns}
            data={entries}
            keyFn={(e) => e.id}
            loading={isLoading && entries.length === 0}
            onRowClick={openEntryDetails}
            scrollRef={scrollRef}
            horizontalScroll
            minWidth="1220px"
            emptyMessage="No audit log entries found"
            // The first load holds the page; a filter without cached entries loads in place.
            emptyContent={
              isLoading ? <LoadingSpinner label="Loading audit log entries" /> : undefined
            }
            footer={
              hasMore ? <div ref={sentinelRef} className="h-px" aria-hidden="true" /> : undefined
            }
          />
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={handleConfigureOpenChange}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Configure Audit View</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-1 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
            <AuditOptionChecklist
              title="Hidden Actions"
              description="Checked actions are excluded by the backend before pagination."
              options={actionOptions.map((action) => ({
                value: action,
                label: getAuditActionLabel(action),
              }))}
              selected={draftViewConfig.excludedActions}
              onToggle={(value) =>
                setDraftViewConfig((draft) => ({
                  ...draft,
                  excludedActions: toggleValue(draft.excludedActions, value),
                }))
              }
              viewportClassName={SCOPE_PICKER_VIEWPORT}
            />
            <AuditOptionChecklist
              title="Hidden Resources"
              description="Checked resources are excluded by the backend before pagination."
              options={resourceOptions.map((resourceType) => ({
                value: resourceType,
                label: formatAuditToken(resourceType),
              }))}
              selected={draftViewConfig.excludedResourceTypes}
              onToggle={(value) =>
                setDraftViewConfig((draft) => ({
                  ...draft,
                  excludedResourceTypes: toggleValue(draft.excludedResourceTypes, value),
                }))
              }
              viewportClassName={SCOPE_PICKER_VIEWPORT}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetViewConfig}>
              Reset
            </Button>
            <Button variant="outline" onClick={() => handleConfigureOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={saveViewConfig}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={handleExportOpenChange}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Download Audit Log</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-1">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">From</label>
                <Input
                  type="datetime-local"
                  value={exportFrom}
                  onChange={(event) => setExportFrom(event.target.value)}
                  className="audit-date-input [&::-webkit-calendar-picker-indicator]:hidden"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">To</label>
                <Input
                  type="datetime-local"
                  value={exportTo}
                  onChange={(event) => setExportTo(event.target.value)}
                  className="audit-date-input [&::-webkit-calendar-picker-indicator]:hidden"
                />
              </div>
              <p className="text-xs text-muted-foreground md:col-span-2">
                Starts at the last 24 hours. Leave To empty to export up to now. One file holds up
                to 50,000 entries.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <AuditOptionChecklist
                title="Actions"
                description="Leave empty to export all visible actions."
                options={actionOptions.map((action) => ({
                  value: action,
                  label: getAuditActionLabel(action),
                }))}
                selected={exportActions}
                onToggle={(value) => setExportActions((values) => toggleValue(values, value))}
                emptyMessage="No actions available."
                viewportClassName={SCOPE_PICKER_VIEWPORT}
              />
              <AuditOptionChecklist
                title="Resources"
                description="Leave empty to export all visible resources."
                options={resourceOptions.map((resourceType) => ({
                  value: resourceType,
                  label: formatAuditToken(resourceType),
                }))}
                selected={exportResourceTypes}
                onToggle={(value) => setExportResourceTypes((values) => toggleValue(values, value))}
                emptyMessage="No resources available."
                viewportClassName={SCOPE_PICKER_VIEWPORT}
              />
              <AuditOptionChecklist
                title="Users"
                description="Leave empty to export all users."
                options={knownUsers.map((user) => ({ value: user.id, label: user.label }))}
                selected={exportUserIds}
                onToggle={(value) => setExportUserIds((values) => toggleValue(values, value))}
                emptyMessage="Load audit entries to populate users."
                viewportClassName={SCOPE_PICKER_VIEWPORT}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeExportDialog} disabled={exporting}>
              Cancel
            </Button>
            <Button onClick={() => void runExport()} pending={exporting}>
              Download {exportFormat.toUpperCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={entryDetailsOpen} onOpenChange={(open) => !open && closeEntryDetails()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Audit Entry Details</DialogTitle>
          </DialogHeader>
          {selectedEntry ? (
            <div className="min-w-0 space-y-4 pr-1">
              <div className="grid gap-3 text-sm sm:grid-cols-6">
                <ValueTile className="sm:col-span-2" label="Action">
                  <span title={selectedEntry.action}>
                    {getAuditActionLabel(selectedEntry.action)}
                  </span>
                </ValueTile>
                <ValueTile className="sm:col-span-2" label="Time">
                  {formatDateTime(selectedEntry.createdAt)}
                </ValueTile>
                <ValueTile className="sm:col-span-2" label="Resource Type">
                  {selectedEntry.resourceType}
                </ValueTile>
                {selectedEntry.resourceName ? (
                  <ValueTile className="sm:col-span-6" label="Resource" wrap>
                    {getAuditResourceDisplay(selectedEntry).label}
                  </ValueTile>
                ) : null}
                {getAuditDescription(selectedEntry) ? (
                  <ValueTile className="sm:col-span-6" label="Description" wrap>
                    {getAuditDescription(selectedEntry)}
                  </ValueTile>
                ) : null}
                <ValueTile className="sm:col-span-3" label="Resource ID">
                  {selectedEntry.resourceId}
                </ValueTile>
                <ValueTile className="sm:col-span-3" label="User ID">
                  {selectedEntry.userId}
                </ValueTile>
                <ValueTile className="sm:col-span-3" label="User">
                  {selectedEntry.userName || selectedEntry.userEmail || "System"}
                </ValueTile>
                <ValueTile className="sm:col-span-3" label="IP Address">
                  {selectedEntry.ipAddress}
                </ValueTile>
                {selectedEntry.userAgent && (
                  <ValueTile className="sm:col-span-6" label="User Agent" wrap>
                    {selectedEntry.userAgent}
                  </ValueTile>
                )}
              </div>
              <div className="border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-medium">Details</h3>
                </div>
                <pre className="overflow-x-auto p-4 text-xs whitespace-pre-wrap">
                  {JSON.stringify(selectedEntry.details ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );

  return embedded ? content : <PageTransition>{content}</PageTransition>;
}

function AuditOptionChecklist({
  title,
  description,
  options,
  selected,
  onToggle,
  emptyMessage = "No options available.",
  viewportClassName,
}: {
  title: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
  emptyMessage?: string;
  viewportClassName?: string;
}) {
  return (
    <PanelShell
      title={title}
      description={description}
      className="min-h-0"
      headerClassName="px-3 py-2"
      bodyClassName={viewportClassName}
    >
      <div>
        {options.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => onToggle(option.value)}
                className="form-checkbox"
              />
              <span className="min-w-0 truncate" title={option.label}>
                {option.label}
              </span>
            </label>
          ))
        )}
      </div>
    </PanelShell>
  );
}
