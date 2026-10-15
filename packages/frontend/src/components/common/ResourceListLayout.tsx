import type * as React from "react";
import { forwardRef } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ResourceListColumn<TItem = unknown> {
  id: string;
  label?: React.ReactNode;
  width?: React.CSSProperties["width"];
  align?: "left" | "center" | "right";
  className?: string;
  cellClassName?: string;
  cellContentClassName?: string;
  renderCell?: (item: TItem) => React.ReactNode;
}

const REM_PX = 16;

/**
 * The narrowest a list gets before it scrolls sideways: the fixed column widths (rem or px) plus
 * `flexibleRem` for each column without a width (the name), which takes the rest of the row.
 */
export function resourceListMinWidth<TItem>(
  columns: ResourceListColumn<TItem>[],
  flexibleRem = 12
): string {
  let rem = 0;
  for (const column of columns) {
    const width = column.width;
    if (width === undefined) rem += flexibleRem;
    else if (typeof width === "number") rem += width / REM_PX;
    else if (width.endsWith("rem")) rem += Number.parseFloat(width);
    else if (width.endsWith("px")) rem += Number.parseFloat(width) / REM_PX;
  }
  return `${Math.ceil(rem * 4) / 4}rem`;
}

interface ResourceListFrameProps {
  children: React.ReactNode;
  minWidth?: React.CSSProperties["minWidth"];
  className?: string;
  innerClassName?: string;
}

export function ResourceListFrame({
  children,
  minWidth = 900,
  className,
  innerClassName,
}: ResourceListFrameProps) {
  return (
    <div className={cn("overflow-x-auto border border-border bg-card", className)}>
      {/* The frame draws the bottom edge: the list's last row has no border of its own. */}
      <div
        className={cn("w-full [&>*:last-child_tbody>tr:last-child]:border-b-0", innerClassName)}
        style={{ minWidth }}
      >
        {children}
      </div>
    </div>
  );
}

export function ResourceListColGroup<TItem = unknown>({
  columns,
}: {
  columns: ResourceListColumn<TItem>[];
}) {
  return (
    <colgroup>
      {columns.map((column) => (
        <col key={column.id} style={column.width ? { width: column.width } : undefined} />
      ))}
    </colgroup>
  );
}

export function ResourceListHeaderTable<TItem = unknown>({
  columns,
}: {
  columns: ResourceListColumn<TItem>[];
}) {
  return (
    <table className="w-full" style={{ tableLayout: "fixed" }}>
      <ResourceListColGroup columns={columns} />
      <thead className="border-b border-border bg-header">
        <tr className="text-left">
          {columns.map((column) => (
            <th
              key={column.id}
              className={cn(
                // A fixed-layout column clips what does not fit instead of drawing it over its neighbour.
                "overflow-hidden text-ellipsis p-3 text-xs font-medium uppercase tracking-wider text-muted-foreground",
                column.align === "right" && "text-right",
                column.align === "center" && "text-center",
                column.className
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
    </table>
  );
}

interface ResourceListTableProps<TItem = unknown> {
  columns: ResourceListColumn<TItem>[];
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function ResourceListTable<TItem = unknown>({
  columns,
  children,
  className,
  bodyClassName,
}: ResourceListTableProps<TItem>) {
  return (
    <table className={cn("w-full", className)} style={{ tableLayout: "fixed" }}>
      <ResourceListColGroup columns={columns} />
      <tbody className={cn("[&_td]:align-middle", bodyClassName)}>{children}</tbody>
    </table>
  );
}

interface ResourceListRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  isOverlay?: boolean;
  interactive?: boolean;
}

export const ResourceListRow = forwardRef<HTMLTableRowElement, ResourceListRowProps>(
  ({ className, isOverlay, interactive, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "transition-colors border-b border-border select-none",
        isOverlay
          ? "bg-card shadow-lg border border-border"
          : interactive
            ? "cursor-pointer hover:bg-accent"
            : "cursor-default opacity-80",
        className
      )}
      {...props}
    />
  )
);
ResourceListRow.displayName = "ResourceListRow";

interface ResourceListCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  align?: "left" | "center" | "right";
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  depth?: number;
}

export function ResourceListCell({
  align = "left",
  children,
  className,
  contentClassName,
  contentStyle,
  depth,
  ...props
}: ResourceListCellProps) {
  const mergedContentStyle =
    depth === undefined ? contentStyle : { ...contentStyle, paddingLeft: `${depth * 24 + 12}px` };

  return (
    <td className={cn("p-0 align-middle", align === "right" && "text-right", className)} {...props}>
      <div
        className={cn(
          // overflow-hidden: content wider than its fixed-width column is clipped at the cell, never drawn over the next one.
          "flex min-h-[52px] min-w-0 items-center overflow-hidden px-3 py-3",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
          contentClassName
        )}
        style={mergedContentStyle}
      >
        {children}
      </div>
    </td>
  );
}

interface ResourceListSectionHeaderProps {
  label: React.ReactNode;
  count?: React.ReactNode;
  hasRows?: boolean;
  className?: string;
}

export function ResourceListSectionHeader({
  label,
  count,
  hasRows = true,
  className,
}: ResourceListSectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-2",
        hasRows && "border-b border-border",
        className
      )}
    >
      <span className="text-sm font-medium">{label}</span>
      {count !== undefined && (
        <Badge variant="secondary" size="inline">
          {count}
        </Badge>
      )}
    </div>
  );
}
