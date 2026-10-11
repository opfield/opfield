import { Info, Loader2, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { ReferenceTable } from "@/components/common/ReferenceTable";
import { useContentLoading } from "@/components/common/reveal-gate";
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
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type {
  LoggingEnvironment,
  LoggingMetadata,
  LoggingSearchRequest,
  LoggingSearchResult,
} from "@/types";
import { LoggingEventDetailsDialog } from "./LoggingEventDetailsDialog";
import {
  applyLoggingQuerySuggestion,
  applyLoggingStructuredBackspace,
  getLoggingQuerySuggestions,
  parseLoggingQuery,
} from "./logging-query-parser";
import { loggingSeverityBadgeVariant } from "./logging-severity";

export function LoggingExplorer({
  environment,
  storageAvailable,
  refreshKey = 0,
}: {
  environment: LoggingEnvironment;
  storageAvailable: boolean;
  refreshKey?: number;
}) {
  const [queryText, setQueryText] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [rootSuggestionsSuppressed, setRootSuggestionsSuppressed] = useState(false);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [rows, setRows] = useState<LoggingSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<LoggingSearchResult | null>(null);
  const [metadata, setMetadata] = useState<LoggingMetadata | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // The first search holds the Logs tab; later searches show their progress in the table.
  const [firstSearchDone, setFirstSearchDone] = useState(false);
  useContentLoading(storageAvailable && !firstSearchDone);
  const inputRef = useRef<HTMLInputElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const parsedQuery = useMemo(
    () => parseLoggingQuery(queryText, environment.fieldSchema),
    [environment.fieldSchema, queryText]
  );
  const suggestions = useMemo(
    () =>
      rootSuggestionsSuppressed && queryText.trim() === ""
        ? []
        : getLoggingQuerySuggestions({
            input: queryText,
            cursor: cursorPosition,
            metadata,
            fieldDefinitions: environment.fieldSchema,
          }),
    [cursorPosition, environment.fieldSchema, metadata, queryText, rootSuggestionsSuppressed]
  );
  const showSuggestions = suggestionsOpen && suggestions.length > 0;

  useEffect(() => {
    void refreshKey;
    let cancelled = false;
    void api
      .getLoggingMetadata(environment.id)
      .then((result) => {
        if (!cancelled) setMetadata(result);
      })
      .catch(() => {
        if (!cancelled) setMetadata(null);
      });
    return () => {
      cancelled = true;
    };
  }, [environment.id, refreshKey]);

  const buildQuery = useCallback(
    (cursor?: string | null): LoggingSearchRequest => ({
      ...parsedQuery.request,
      limit: 100,
      cursor,
    }),
    [parsedQuery.request]
  );

  const load = useCallback(
    async (cursor?: string | null) => {
      void refreshKey;
      if (!storageAvailable) {
        if (!cursor) setSearchPending(false);
        return;
      }
      if (parsedQuery.errors.length > 0 || parsedQuery.incomplete) {
        if (!cursor) {
          setRows([]);
          setNextCursor(null);
          setSearchPending(false);
          setFirstSearchDone(true);
        }
        return;
      }
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api.searchLogs(environment.id, buildQuery(cursor));
        setRows((current) => (cursor ? [...current, ...result.data] : result.data));
        setNextCursor(result.nextCursor);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to search logs");
      } finally {
        if (cursor) setLoadingMore(false);
        else {
          setLoading(false);
          setSearchPending(false);
          setFirstSearchDone(true);
        }
      }
    },
    [
      buildQuery,
      environment.id,
      parsedQuery.errors.length,
      parsedQuery.incomplete,
      refreshKey,
      storageAvailable,
    ]
  );

  // Typing waits for a pause; the first search of the tab starts at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: firstSearchDone only picks the delay and must not restart a pending search.
  useEffect(() => {
    if (!storageAvailable || parsedQuery.errors.length > 0 || parsedQuery.incomplete) {
      setSearchPending(false);
      setFirstSearchDone(true);
      return;
    }
    setSearchPending(true);
    const timer = window.setTimeout(
      () => {
        void load();
      },
      firstSearchDone ? 300 : 0
    );
    return () => window.clearTimeout(timer);
  }, [load, parsedQuery.errors.length, parsedQuery.incomplete, storageAvailable]);

  useEffect(() => {
    if (parsedQuery.errors.length > 0 || parsedQuery.incomplete) {
      setRows([]);
      setNextCursor(null);
      setSearchPending(false);
    }
  }, [parsedQuery.errors.length, parsedQuery.incomplete]);

  const searchInProgress = searchPending || loading;
  const showSearchLoader =
    searchInProgress && parsedQuery.errors.length === 0 && !parsedQuery.incomplete;

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const root = tableScrollRef.current;
    if (!sentinel || !root || !nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loading && !loadingMore) {
          void load(nextCursor);
        }
      },
      { root, rootMargin: "320px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [load, loading, loadingMore, nextCursor]);

  const applySuggestion = (replacement: string, incomplete = false, noSpace = false) => {
    const next = applyLoggingQuerySuggestion(queryText, cursorPosition, replacement, { noSpace });
    setQueryText(next.value);
    setCursorPosition(next.cursor);
    setSuggestionsOpen(incomplete);
    setHighlightedSuggestion(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const applyHighlightedSuggestion = () => {
    const suggestion = suggestions[highlightedSuggestion] ?? suggestions[0];
    if (!suggestion) return false;
    applySuggestion(suggestion.replacement, suggestion.incomplete, suggestion.noSpace);
    return true;
  };

  const applyStructuredBackspace = () => {
    const next = applyLoggingStructuredBackspace(queryText, cursorPosition);
    if (!next) return false;
    setQueryText(next.value);
    setCursorPosition(next.cursor);
    setSuggestionsOpen(true);
    setHighlightedSuggestion(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
    return true;
  };

  const columns: DataTableColumn<LoggingSearchResult>[] = [
    {
      key: "timestamp",
      header: "Timestamp",
      width: "190px",
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.timestamp).toLocaleString()}
        </span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      width: "96px",
      render: (row) => (
        <Badge variant={loggingSeverityBadgeVariant(row.severity)}>{row.severity}</Badge>
      ),
    },
    {
      key: "service",
      header: "Service",
      width: "150px",
      truncate: true,
      render: (row) => row.service || "-",
    },
    {
      key: "source",
      header: "Source",
      width: "150px",
      truncate: true,
      render: (row) => row.source || "-",
    },
    {
      key: "message",
      header: "Message",
      width: "minmax(360px,1fr)",
      truncate: true,
      render: (row) => row.message,
    },
  ];

  if (!storageAvailable) {
    return (
      <EmptyState message="ClickHouse is configured but unavailable. Metadata management remains available." />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[20rem] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search logs"
              value={queryText}
              onBlur={() =>
                window.setTimeout(() => {
                  setSuggestionsOpen(false);
                  setRootSuggestionsSuppressed(false);
                }, 120)
              }
              onChange={(event) => {
                const nextValue = event.target.value;
                const wasCleared = queryText.trim() !== "" && nextValue.trim() === "";
                setQueryText(event.target.value);
                setCursorPosition(event.target.selectionStart ?? event.target.value.length);
                setRootSuggestionsSuppressed(wasCleared);
                setSuggestionsOpen(true);
                setHighlightedSuggestion(0);
              }}
              onFocus={(event) => {
                setCursorPosition(event.currentTarget.selectionStart ?? queryText.length);
                setSuggestionsOpen(true);
                setHighlightedSuggestion(0);
              }}
              onClick={(event) => {
                setCursorPosition(event.currentTarget.selectionStart ?? queryText.length);
                setSuggestionsOpen(true);
                setHighlightedSuggestion(0);
              }}
              onKeyUp={(event) => {
                setCursorPosition(event.currentTarget.selectionStart ?? queryText.length);
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
                  setHighlightedSuggestion(0);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && showSuggestions) {
                  event.preventDefault();
                  setHighlightedSuggestion((current) => (current + 1) % suggestions.length);
                } else if (event.key === "ArrowUp" && showSuggestions) {
                  event.preventDefault();
                  setHighlightedSuggestion(
                    (current) => (current - 1 + suggestions.length) % suggestions.length
                  );
                } else if (event.key === "Enter") {
                  if (showSuggestions && applyHighlightedSuggestion()) {
                    event.preventDefault();
                    return;
                  }
                  setSuggestionsOpen(false);
                  void load();
                } else if (event.key === "Escape") {
                  setSuggestionsOpen(false);
                } else if (event.key === "Tab" && showSuggestions) {
                  event.preventDefault();
                  applyHighlightedSuggestion();
                } else if (
                  event.key === "Backspace" &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
                  applyStructuredBackspace()
                ) {
                  event.preventDefault();
                }
              }}
              className="pl-9 pr-9"
            />
            {queryText && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Clear search"
                className="absolute right-0 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setQueryText("");
                  setRows([]);
                  setRootSuggestionsSuppressed(true);
                  setSuggestionsOpen(false);
                  inputRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            {showSuggestions && (
              <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 overflow-hidden border border-border bg-popover shadow-md">
                {suggestions.map((suggestion, index) => (
                  // Suggestion rows are list options; the input keeps focus and keyboard control.
                  <button
                    key={`${suggestion.replacement}:${suggestion.detail ?? ""}`}
                    type="button"
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted ${
                      index === highlightedSuggestion ? "bg-muted" : ""
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applySuggestion(
                        suggestion.replacement,
                        suggestion.incomplete,
                        suggestion.noSpace
                      );
                    }}
                    onMouseEnter={() => setHighlightedSuggestion(index)}
                  >
                    <span className="min-w-0 truncate">{suggestion.label}</span>
                    {suggestion.detail && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {suggestion.detail}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              variant="outline"
              size="icon"
              aria-label="Query syntax cheatsheet"
              onClick={() => setCheatsheetOpen(true)}
            >
              <Info className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {parsedQuery.chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {parsedQuery.chips.map((chip) => (
              <Badge
                key={chip.key}
                variant={
                  chip.tone === "danger"
                    ? "destructive"
                    : chip.tone === "muted"
                      ? "outline"
                      : "secondary"
                }
                className="normal-case"
              >
                {chip.label}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        keyFn={(row) => row.eventId}
        onRowClick={setSelected}
        emptyContent={
          showSearchLoader ? (
            <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Searching logs...</span>
            </div>
          ) : undefined
        }
        emptyMessage={
          parsedQuery.errors.length > 0
            ? "Fix the query syntax to search logs."
            : parsedQuery.incomplete
              ? "Complete the query to search logs."
              : searchInProgress
                ? "Searching logs..."
                : "No logs found."
        }
        horizontalScroll
        scrollRef={tableScrollRef}
        footer={
          nextCursor ? (
            <div ref={loadMoreRef} className="p-3 text-center text-xs text-muted-foreground">
              {loadingMore ? "Loading older logs..." : "Scroll to load older logs"}
            </div>
          ) : rows.length > 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">End of log history</div>
          ) : null
        }
      />
      <LoggingEventDetailsDialog
        event={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
      <LoggingQueryCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
    </div>
  );
}

const QUERY_CHEATSHEET = [
  { syntax: "text", description: "Message contains text" },
  { syntax: '"payment failed"', description: "Message contains exact phrase" },
  { syntax: "~payment", description: "Message starts with text" },
  { syntax: "payment~", description: "Message ends with text" },
  { syntax: "+region=eu", description: "Label equals value" },
  { syntax: "+region=(eu|us)", description: "Label value OR group" },
  { syntax: "*statusCode>=500", description: "Field comparison" },
  { syntax: "!warn", description: "Severity" },
  { syntax: "!(warn|error)", description: "Severity OR group" },
  { syntax: "^billing-api", description: "Service" },
  { syntax: ">worker-1", description: "Source" },
  { syntax: "$trace #span %request", description: "Trace, span, request IDs" },
  { syntax: "@15m", description: "Last 15 minutes" },
  { syntax: "@30m..15m", description: "From 30m ago through 15m ago" },
  { syntax: "-term", description: "Exclude a term or filter" },
  { syntax: "(a|b)", description: "Group OR conditions" },
];

function LoggingQueryCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log Query Cheatsheet</DialogTitle>
          <DialogDescription>Compact search syntax for filtering log events.</DialogDescription>
        </DialogHeader>
        <ReferenceTable
          termLabel="Syntax"
          rows={QUERY_CHEATSHEET.map((item) => ({
            term: item.syntax,
            description: item.description,
          }))}
        />
      </DialogContent>
    </Dialog>
  );
}
