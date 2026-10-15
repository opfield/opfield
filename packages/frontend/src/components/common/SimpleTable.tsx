import type * as React from "react";
import { Fragment } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { useContentLoading } from "@/components/common/reveal-gate";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { cn } from "@/lib/utils";

export interface SimpleTableColumn<TRow> {
  id: string;
  header: React.ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
  cellClassName?: string;
  render: (row: TRow) => React.ReactNode;
}

export interface SimpleTableRowRenderProps<TRow> {
  row: TRow;
  index: number;
  interactive: boolean;
  className: string;
  onClick?: () => void;
  children: React.ReactNode;
}

interface SimpleTableProps<TRow> {
  columns: SimpleTableColumn<TRow>[];
  rows: TRow[];
  getRowKey: (row: TRow, index: number) => React.Key;
  loading?: boolean;
  /** Retained for existing callers; skeleton rows replace the old text-only state. */
  loadingMessage?: React.ReactNode;
  loadingRows?: number;
  emptyMessage?: string;
  onRowClick?: (row: TRow, index: number) => void;
  isRowClickable?: (row: TRow, index: number) => boolean;
  rowClassName?: string | ((row: TRow, index: number) => string | undefined);
  className?: string;
  tableClassName?: string;
  headerRowClassName?: string;
  bodyClassName?: string;
  rowRenderer?: (props: SimpleTableRowRenderProps<TRow>) => React.ReactNode;
}

function alignClass(align: SimpleTableColumn<unknown>["align"]) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function SimpleTable<TRow>({
  columns,
  rows,
  getRowKey,
  loading,
  loadingMessage = "Loading table",
  emptyMessage = "No items",
  onRowClick,
  isRowClickable,
  rowClassName,
  className,
  tableClassName,
  headerRowClassName,
  bodyClassName,
  rowRenderer,
}: SimpleTableProps<TRow>) {
  const initialLoading = useInitialLoading(Boolean(loading));
  const showLoading = initialLoading && rows.length === 0;
  useContentLoading(showLoading);

  if (showLoading) return null;

  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} embedded />;
  }

  return (
    <div className={cn("min-w-0 max-w-full overflow-x-auto", className)}>
      <table className={cn("w-full text-sm", tableClassName)}>
        <thead>
          <tr
            className={cn(
              "border-b border-border bg-header text-xs uppercase tracking-wider text-muted-foreground",
              headerRowClassName
            )}
          >
            {columns.map((column) => (
              <th
                key={column.id}
                className={cn(
                  "overflow-hidden text-ellipsis px-4 py-3 font-medium",
                  alignClass(column.align),
                  column.className
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          className={bodyClassName}
          aria-busy={loading || undefined}
          aria-label={loading && typeof loadingMessage === "string" ? loadingMessage : undefined}
        >
          {rows.map((row, index) => {
            const interactive = Boolean(onRowClick && (isRowClickable?.(row, index) ?? true));
            const resolvedRowClassName =
              typeof rowClassName === "function" ? rowClassName(row, index) : rowClassName;

            const className = cn(
              "border-b border-border last:border-b-0",
              interactive && "cursor-pointer transition-colors hover:bg-accent",
              resolvedRowClassName
            );
            const onClick = interactive ? () => onRowClick?.(row, index) : undefined;
            const children = columns.map((column) => (
              <td
                key={column.id}
                className={cn(
                  // In a fixed-layout table a narrow column clips its content instead of overlapping the next.
                  "overflow-hidden px-4 py-3 align-middle",
                  alignClass(column.align),
                  column.cellClassName
                )}
              >
                {column.render(row)}
              </td>
            ));

            return (
              <Fragment key={getRowKey(row, index)}>
                {rowRenderer ? (
                  rowRenderer({ row, index, interactive, className, onClick, children })
                ) : (
                  <tr className={className} onClick={onClick}>
                    {children}
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
