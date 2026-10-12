import { type ComponentProps, type ReactNode, useState } from "react";
import { ScopeList } from "@/components/common/ScopeList";
import {
  ScopeSearchFilter,
  type ScopeSelectionFilter,
} from "@/components/common/ScopeSearchFilter";
import { DIALOG_LIST_CLASS } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** The list of a scope picker inside a dialog: the dialog gives it its height. */
export const SCOPE_PICKER_VIEWPORT = `${DIALOG_LIST_CLASS} overscroll-contain`;

type ScopeListProps = ComponentProps<typeof ScopeList>;

export interface ScopePickerProps extends Omit<ScopeListProps, "search" | "selectionFilter"> {
  /** The left side of the header row: a section title or a field label. */
  header?: ReactNode;
  /**
   * Enables the place link in each section header: receives the restrictions with the section's
   * selected scopes limited to the folders, apps and environments picked there.
   */
  onResourcesChange?: (resources: Record<string, string[]>) => void;
  searchPlaceholder?: string;
  /** The count line under the list. */
  footer: ReactNode;
  /** Rendered between the list and the footer. */
  children?: ReactNode;
  className?: string;
}

/**
 * The scope picker of every screen that grants scopes (OAuth consent, API tokens, groups,
 * users, OAuth applications): a header, search and selection filter, the scope list with each
 * section saying where its scopes reach (and letting one row differ), and a count.
 */
export function ScopePicker({
  header,
  onResourcesChange,
  searchPlaceholder = "Search scopes...",
  footer,
  children,
  className,
  ...listProps
}: ScopePickerProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ScopeSelectionFilter>("all");

  return (
    <div className={cn("space-y-2", className)}>
      {header && <div className="min-w-0">{header}</div>}
      <div className="flex min-h-0 flex-col border border-border">
        <ScopeSearchFilter
          search={search}
          onSearchChange={setSearch}
          filter={filter}
          onFilterChange={setFilter}
          placeholder={searchPlaceholder}
        />
        <ScopeList
          {...listProps}
          search={search}
          selectionFilter={filter}
          onResourcesChange={onResourcesChange}
          placeLimits
        />
        {children}
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">{footer}</p>
        </div>
      </div>
    </div>
  );
}
