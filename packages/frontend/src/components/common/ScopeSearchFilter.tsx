import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ScopeSelectionFilter = "all" | "selected" | "unselected";

const FILTER_LABELS: Record<ScopeSelectionFilter, string> = {
  all: "All items",
  selected: "Selected only",
  unselected: "Unselected only",
};

export function ScopeSearchFilter({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  placeholder = "Search permissions...",
  className,
  disabled = false,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  /** Without `filter` and `onFilterChange` the search stands alone, with no filter button. */
  filter?: ScopeSelectionFilter;
  onFilterChange?: (filter: ScopeSelectionFilter) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 border-b border-border", className)}>
      <Input
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-9 min-w-0 flex-1 rounded-none border-0 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      />
      {filter && onFilterChange && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "border-l border-border text-muted-foreground hover:text-foreground",
                // Filled only while a filter is on, so a narrowed list is visible at a glance.
                filter === "all" ? "hover:bg-accent" : "bg-muted text-foreground hover:bg-muted"
              )}
              aria-label={`Filter scopes: ${FILTER_LABELS[filter]}`}
              title={`Filter scopes: ${FILTER_LABELS[filter]}`}
              disabled={disabled}
            >
              <Filter className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => onFilterChange(value as ScopeSelectionFilter)}
            >
              <DropdownMenuRadioItem value="all">All items</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="selected">Selected only</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unselected">Unselected only</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
