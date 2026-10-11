import type { ReactNode } from "react";
import { VirtualLogList } from "@/components/ui/virtual-log-list";
import { cn } from "@/lib/utils";

interface DockerLogViewportProps<T> {
  lines: T[];
  keyFn: (line: T, index: number) => string | number;
  renderContent: (line: T, index: number) => ReactNode;
  emptyState: ReactNode;
  className?: string;
  bordered?: boolean;
  prependVersion?: number;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  initialScrollToEnd?: boolean;
}

export function DockerLogViewport<T>({
  lines,
  keyFn,
  renderContent,
  emptyState,
  className,
  bordered = false,
  prependVersion,
  onLoadMore,
  hasMore,
  loadingMore,
  initialScrollToEnd,
}: DockerLogViewportProps<T>) {
  return (
    <VirtualLogList
      lines={lines}
      keyFn={keyFn}
      prependVersion={prependVersion}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
      loadingMore={loadingMore}
      initialScrollToEnd={initialScrollToEnd}
      renderLine={(line, index) => (
        <div className="whitespace-pre-wrap break-all px-4 font-mono text-xs leading-5 text-foreground/80">
          {renderContent(line, index)}
        </div>
      )}
      emptyState={emptyState}
      className={cn(
        "min-h-0 overflow-auto bg-card py-4",
        bordered && "border border-border",
        className
      )}
    />
  );
}
