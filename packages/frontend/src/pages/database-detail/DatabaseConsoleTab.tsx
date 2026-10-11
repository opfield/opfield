import { History, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RelativeTime } from "@/components/common/RelativeTime";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { DatabaseConnection, SqlExecutionResult } from "@/types";
import { stringifyCell } from "./shared";

type RedisConsoleResult = {
  results: Array<{ command: string; result: unknown; truncated?: boolean }>;
  truncated?: boolean;
  commandLimit?: number;
};

type ConsoleHistoryEntry = {
  query: string;
  executedAt: string;
};

const CONSOLE_SPLIT_STORAGE_KEY = "gateway-database-console-split-percent";
const CONSOLE_HISTORY_LIMIT = 100;

function readStoredSplitPercent() {
  if (typeof window === "undefined") return 50;
  const stored = Number.parseFloat(localStorage.getItem(CONSOLE_SPLIT_STORAGE_KEY) ?? "");
  return Number.isFinite(stored) ? Math.max(20, Math.min(80, stored)) : 50;
}

function defaultConsoleInput(databaseType: DatabaseConnection["type"]) {
  return databaseType === "redis" ? "PING" : "select 1";
}

function consoleInputStorageKey(databaseId: string) {
  return `gateway-database-console-input:${databaseId}`;
}

function consoleHistoryStorageKey(databaseId: string) {
  return `gateway-database-console-history:${databaseId}`;
}

function readStoredConsoleInput(databaseId: string, databaseType: DatabaseConnection["type"]) {
  if (typeof window === "undefined") return defaultConsoleInput(databaseType);
  return (
    localStorage.getItem(consoleInputStorageKey(databaseId)) ?? defaultConsoleInput(databaseType)
  );
}

function readStoredConsoleHistory(databaseId: string): ConsoleHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(consoleHistoryStorageKey(databaseId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is ConsoleHistoryEntry =>
          entry &&
          typeof entry === "object" &&
          typeof entry.query === "string" &&
          typeof entry.executedAt === "string"
      )
      .slice(0, CONSOLE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeStoredConsoleHistory(databaseId: string, history: ConsoleHistoryEntry[]) {
  localStorage.setItem(
    consoleHistoryStorageKey(databaseId),
    JSON.stringify(history.slice(0, CONSOLE_HISTORY_LIMIT))
  );
}

function formatDuration(durationMs: number | undefined) {
  if (durationMs == null) return "n/a";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatTable(fields: string[], rows: Record<string, unknown>[]) {
  if (fields.length === 0) return "";
  if (rows.length === 0) {
    return `${fields.join(" | ")}\n${fields.map(() => "---").join(" | ")}`;
  }

  const renderedRows = rows.map((row) => fields.map((field) => stringifyCell(row[field])));
  const widths = fields.map((field, index) =>
    Math.min(120, Math.max(field.length, ...renderedRows.map((row) => row[index]?.length ?? 0)))
  );
  const renderCell = (value: string, index: number) => {
    const normalized = value.replace(/\s+/g, " ");
    const width = widths[index] ?? 0;
    const clipped =
      normalized.length > width ? `${normalized.slice(0, Math.max(0, width - 3))}...` : normalized;
    return clipped.padEnd(width);
  };

  const header = fields.map(renderCell).join(" | ");
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = renderedRows.map((row) => row.map(renderCell).join(" | ")).join("\n");
  return `${header}\n${divider}\n${body}`;
}

function formatSqlOutput(result: SqlExecutionResult) {
  const lines: string[] = [];
  const cappedMessages: string[] = [];
  if (result.truncated) {
    cappedMessages.push(
      `result sets capped${result.resultLimit ? ` at ${result.resultLimit}` : ""}`
    );
  }

  for (const [index, entry] of result.results.entries()) {
    const hasRows = entry.fields.length > 0;
    const rowLabel = hasRows ? "Rows" : "Rows affected";
    lines.push(
      `Statement ${index + 1}`,
      `Command: ${entry.command}`,
      `${rowLabel}: ${entry.rowCount}`,
      `Time: ${formatDuration(entry.durationMs)}`
    );
    if (entry.queryId) lines.push(`Query ID: ${entry.queryId}`);
    if (entry.columns.length > 0) {
      lines.push(
        `Columns: ${entry.columns.map((column) => `${column.name} ${column.type}`).join(", ")}`
      );
    }
    if (entry.statistics && Object.keys(entry.statistics).length > 0) {
      lines.push(
        `Statistics: ${Object.entries(entry.statistics)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`
      );
    }
    if (entry.truncated) {
      cappedMessages.push(
        `statement ${index + 1} rows capped at ${entry.maxRows ?? entry.rows.length}`
      );
      lines.push(`Showing first ${entry.maxRows ?? entry.rows.length} rows.`);
    }
    if (hasRows) {
      lines.push("", formatTable(entry.fields, entry.rows));
    } else {
      lines.push("", "Command completed.");
    }
    lines.push("");
  }

  if (cappedMessages.length > 0) {
    lines.push("Output capped:", ...cappedMessages.map((message) => `- ${message}`));
  }

  return lines.join("\n").trimEnd();
}

function formatRedisOutput(result: RedisConsoleResult) {
  const lines: string[] = [];
  const cappedMessages: string[] = [];
  if (result.truncated) {
    cappedMessages.push(
      `commands capped${result.commandLimit ? ` at ${result.commandLimit}` : ""}`
    );
  }
  for (const [index, entry] of result.results.entries()) {
    if (entry.truncated) {
      cappedMessages.push(`command ${index + 1} result capped`);
    }
    lines.push(
      `Command ${index + 1}`,
      `Command: ${entry.command}${entry.truncated ? " (result truncated)" : ""}`,
      "",
      JSON.stringify(entry.result, null, 2),
      ""
    );
  }
  if (cappedMessages.length > 0) {
    lines.push("Output capped:", ...cappedMessages.map((message) => `- ${message}`));
  }
  return lines.join("\n").trimEnd();
}

export function DatabaseConsoleTab({ database }: { database: DatabaseConnection }) {
  const [input, setInput] = useState(() => readStoredConsoleInput(database.id, database.type));
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [splitPercent, setSplitPercent] = useState(readStoredSplitPercent);
  const [isResizing, setIsResizing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConsoleHistoryEntry[]>(() =>
    readStoredConsoleHistory(database.id)
  );
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const latestSplitPercentRef = useRef(splitPercent);
  const queryAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setInput(readStoredConsoleInput(database.id, database.type));
    setHistory(readStoredConsoleHistory(database.id));
  }, [database.id, database.type]);

  useEffect(() => () => queryAbortControllerRef.current?.abort(), []);

  const updateInput = useCallback(
    (value: string) => {
      setInput(value);
      localStorage.setItem(consoleInputStorageKey(database.id), value);
    },
    [database.id]
  );

  const recordHistory = useCallback(
    (query: string) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) return;
      setHistory((current) => {
        const next = [
          { query: normalizedQuery, executedAt: new Date().toISOString() },
          ...current.filter((entry) => entry.query !== normalizedQuery),
        ].slice(0, CONSOLE_HISTORY_LIMIT);
        writeStoredConsoleHistory(database.id, next);
        return next;
      });
    },
    [database.id]
  );

  const execute = async () => {
    const abortController = database.type === "redis" ? null : new AbortController();
    queryAbortControllerRef.current = abortController;
    setRunning(true);
    setResult(null);
    recordHistory(input);
    try {
      const data =
        database.type === "redis"
          ? await api.executeRedisCommand(database.id, input)
          : await api.executeSql(database.id, input, abortController?.signal);
      setResult(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Query failed";
      setResult({ error: message });
    } finally {
      if (queryAbortControllerRef.current === abortController) {
        queryAbortControllerRef.current = null;
      }
      setRunning(false);
    }
  };

  const output = useMemo(() => {
    if (running) return "Running...";
    if (!result) return "Run a command to see output here.";
    if (typeof result === "object" && "error" in result) {
      return `Error: ${(result as { error?: string }).error ?? "Query failed"}`;
    }
    if (
      database.type !== "redis" &&
      typeof result === "object" &&
      "results" in result &&
      Array.isArray((result as { results: unknown[] }).results)
    ) {
      return formatSqlOutput(result as SqlExecutionResult);
    }
    if (
      database.type === "redis" &&
      typeof result === "object" &&
      "results" in result &&
      Array.isArray((result as { results: unknown[] }).results)
    ) {
      return formatRedisOutput(result as RedisConsoleResult);
    }
    return JSON.stringify(result, null, 2);
  }, [database.type, result, running]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    setIsResizing(true);
    const updateSplit = (clientX: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const minPaneWidth = Math.min(280, rect.width / 3);
      const minPercent = (minPaneWidth / rect.width) * 100;
      const nextPercent = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(minPercent, Math.min(100 - minPercent, nextPercent));
      latestSplitPercentRef.current = clamped;
      setSplitPercent(clamped);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => updateSplit(moveEvent.clientX);
    const cleanupResize = () => {
      setIsResizing(false);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", cleanupResize);
      document.removeEventListener("pointercancel", cleanupResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(CONSOLE_SPLIT_STORAGE_KEY, String(latestSplitPercentRef.current));
    };

    updateSplit(event.clientX);
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", cleanupResize);
    document.addEventListener("pointercancel", cleanupResize);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between gap-4 px-4 py-3 bg-card border-b border-border shrink-0">
        <div>
          <h3 className="text-sm font-semibold">
            {database.type === "redis" ? "Command Console" : "SQL Console"}
          </h3>
          <p className="text-xs text-muted-foreground">
            Run one or more {database.type === "redis" ? "commands" : "SQL statements"}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {history.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setHistoryOpen(true)}
              aria-label="Open query history"
            >
              <History className="h-4 w-4" />
            </Button>
          )}
          <Button
            onClick={() => {
              if (running && queryAbortControllerRef.current) {
                queryAbortControllerRef.current.abort();
              } else {
                void execute();
              }
            }}
            pending={running && database.type === "redis"}
          >
            {running && database.type !== "redis" ? <Square /> : <Play />}
            {running && database.type !== "redis" ? "Cancel" : "Run"}
          </Button>
        </div>
      </div>

      <div ref={splitContainerRef} className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex min-w-0 flex-col" style={{ flex: `0 0 ${splitPercent}%` }}>
          <div className="h-9 flex items-center border-b border-border px-3 text-xs font-medium text-muted-foreground shrink-0">
            Console
          </div>
          <CodeEditor
            value={input}
            onChange={updateInput}
            language={database.type === "redis" ? "plain" : "sql"}
            minHeight="0px"
            showGutterBorder={false}
            className="border-0 flex-1 min-h-0"
          />
        </div>

        <div
          className={cn(
            "group relative z-10 -mx-[7.5px] w-4 shrink-0 cursor-col-resize bg-transparent",
            isResizing && "cursor-col-resize"
          )}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize console output panels"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(splitPercent)}
          onPointerDown={startResize}
        >
          <div
            className={cn(
              "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/70",
              isResizing && "bg-primary/70"
            )}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="h-9 flex items-center border-b border-border px-3 text-xs font-medium text-muted-foreground shrink-0">
            Output
          </div>
          <CodeEditor
            value={output}
            onChange={() => {}}
            readOnly
            language="plain"
            lineWrapping={false}
            showLineNumbers={false}
            minHeight="0px"
            className="border-0 flex-1 min-h-0"
          />
        </div>
      </div>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Query History</DialogTitle>
          </DialogHeader>
          <div className="overflow-x-auto rounded-md border border-border">
            {history.length > 0 ? (
              history.map((entry) => (
                <button
                  key={`${entry.executedAt}:${entry.query}`}
                  type="button"
                  className="block w-full border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted"
                  onClick={() => {
                    updateInput(entry.query);
                    setHistoryOpen(false);
                  }}
                >
                  <RelativeTime
                    value={entry.executedAt}
                    className="mb-1 block text-xs text-muted-foreground"
                  />
                  <pre className="line-clamp-3 whitespace-pre-wrap font-mono text-sm">
                    {entry.query}
                  </pre>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No query history yet.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
