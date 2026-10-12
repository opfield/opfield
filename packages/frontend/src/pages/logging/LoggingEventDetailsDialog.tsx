import { ValueTile } from "@/components/common/ValueTile";
import { Badge } from "@/components/ui/badge";
import {
  DIALOG_LIST_CLASS,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import type { LoggingSearchResult } from "@/types";
import { loggingSeverityBadgeVariant } from "./logging-severity";

export function LoggingEventDetailsDialog({
  event,
  onOpenChange,
}: {
  event: LoggingSearchResult | null;
  onOpenChange: (open: boolean) => void;
}) {
  const displayedEvent = useRetainedDialogValue(event, event !== null);

  return (
    <Dialog open={!!event} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Log Event</DialogTitle>
        </DialogHeader>
        {displayedEvent && (
          <div className="min-w-0 space-y-4 pr-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={loggingSeverityBadgeVariant(displayedEvent.severity)} size="inline">
                {displayedEvent.severity}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {new Date(displayedEvent.timestamp).toLocaleString()}
              </span>
              {displayedEvent.service && (
                <Badge variant="secondary" size="inline">
                  {displayedEvent.service}
                </Badge>
              )}
              {displayedEvent.source && (
                <Badge variant="secondary" size="inline">
                  {displayedEvent.source}
                </Badge>
              )}
            </div>
            <pre
              className={`${DIALOG_LIST_CLASS} max-w-full rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-words`}
            >
              {displayedEvent.message}
            </pre>
            <div className="grid gap-3 text-sm md:grid-cols-3">
              <ValueTile label="Trace ID">{displayedEvent.traceId}</ValueTile>
              <ValueTile label="Span ID">{displayedEvent.spanId}</ValueTile>
              <ValueTile label="Request ID">{displayedEvent.requestId}</ValueTile>
            </div>
            <JsonBlock title="Labels" value={displayedEvent.labels} />
            <JsonBlock title="Fields" value={displayedEvent.fields} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function JsonBlock({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <pre className="max-h-56 max-w-full overflow-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
