import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
} from "@/components/common/ResourceListLayout";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VirtualLogList } from "@/components/ui/virtual-log-list";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  component: string;
  fields?: Record<string, string>;
}

function formatMessage(entry: LogEntry): string {
  let msg = entry.message;
  if (entry.fields && Object.keys(entry.fields).length > 0) {
    const parts = Object.entries(entry.fields).map(([k, v]) => `${k}=${v}`);
    msg += ` ${parts.join(" ")}`;
  }
  return msg;
}

const LEVEL_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  debug: "secondary",
  info: "default",
  warn: "warning",
  error: "destructive",
};

const LOG_COLUMNS: ResourceListColumn<LogEntry>[] = [
  { id: "time", label: "Time", width: "180px" },
  { id: "level", label: "Level", width: "80px" },
  { id: "component", label: "Component", width: "120px" },
  { id: "message", label: "Message" },
];

interface NodeLogsTabProps {
  nodeId: string;
  nodeStatus: string;
}

export function NodeLogsTab({ nodeId, nodeStatus }: NodeLogsTabProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const esRef = useRef<EventSource | null>(null);
  // The stream sends its buffered history right after "connected"; the tab reveals with it.
  const [historyPending, setHistoryPending] = useState(nodeStatus === "online");
  useContentLoading(nodeStatus === "online" && historyPending);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const connect = useCallback(() => {
    if (nodeStatus !== "online") return;
    if (esRef.current) esRef.current.close();

    const params = new URLSearchParams();
    if (levelFilter !== "all") params.set("level", levelFilter);
    if (debouncedSearch) params.set("search", debouncedSearch);

    const query = params.toString();
    const es = new EventSource(`/api/nodes/${nodeId}/logs${query ? `?${query}` : ""}`, {
      withCredentials: true,
    });
    esRef.current = es;

    let historyRemaining = 0;
    es.addEventListener("connected", (e) => {
      setLogs([]);
      try {
        historyRemaining = Number(JSON.parse(e.data)?.historyCount) || 0;
      } catch {
        historyRemaining = 0;
      }
      if (historyRemaining === 0) setHistoryPending(false);
    });
    es.addEventListener("log", (e) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 300 ? next.slice(-300) : next;
        });
      } catch {}
      if (historyRemaining > 0) {
        historyRemaining -= 1;
        if (historyRemaining === 0) setHistoryPending(false);
      }
    });
    es.onerror = () => {
      setHistoryPending(false);
      if (es.readyState === EventSource.CLOSED) {
        es.close();
      }
    };

    return () => es.close();
  }, [nodeId, nodeStatus, levelFilter, debouncedSearch]);

  useEffect(() => {
    const cleanup = connect();
    return () => {
      cleanup?.();
      esRef.current?.close();
    };
  }, [connect]);

  if (nodeStatus !== "online") {
    return (
      <div className="flex flex-col items-center gap-2 py-16 border border-border bg-card">
        <p className="text-muted-foreground">Node is offline — daemon logs unavailable</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      {/* Filters */}
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <Input
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-40">
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ResourceListFrame
        minWidth={860}
        className="min-h-0 flex-1"
        innerClassName="flex h-full flex-col"
      >
        <ResourceListHeaderTable columns={LOG_COLUMNS} />
        <VirtualLogList
          lines={logs}
          keyFn={(_, i) => i}
          estimateLineHeight={44}
          renderLine={(line) => {
            const entry = line as LogEntry;
            return (
              <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: "180px 80px 120px 1fr" }}
              >
                <div className="p-3 text-sm text-muted-foreground whitespace-nowrap">
                  {entry.timestamp}
                </div>
                <div className="p-3 text-sm">
                  <Badge variant={LEVEL_VARIANT[entry.level] ?? "secondary"} className="uppercase">
                    {entry.level}
                  </Badge>
                </div>
                <div className="p-3 text-sm text-muted-foreground">
                  {entry.component || "daemon"}
                </div>
                <div className="p-3 text-sm">{formatMessage(entry)}</div>
              </div>
            );
          }}
          className="min-h-0 flex-1 overflow-y-auto"
          emptyState={
            <div className="text-center py-16 text-sm text-muted-foreground">
              {search || levelFilter !== "all"
                ? "Waiting for matching logs..."
                : "No daemon logs yet"}
            </div>
          }
        />
      </ResourceListFrame>
    </div>
  );
}
