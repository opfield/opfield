import { AnimatePresence, motion } from "framer-motion";
import { Filter, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SearchFilterBarProps {
  /** Placeholder for the search input */
  placeholder?: string;
  /** Current search value */
  search: string;
  /** Called on every keystroke */
  onSearchChange: (value: string) => void;
  /** Called when user presses Enter (optional — for server-side search) */
  onSearchSubmit?: () => void;
  /** Whether any filters are active (controls Clear button visibility) */
  hasActiveFilters: boolean;
  /** Called when Clear is clicked */
  onReset: () => void;
  /** Filter dropdowns rendered inside the collapsible panel */
  filters?: ReactNode;
  /** Render filters beside search instead of behind the Filters button */
  inlineFilters?: boolean;
  initialFiltersOpen?: boolean;
  /** Optional styling for embedding the bar into an existing panel */
  className?: string;
  /** Optional styling for the search input */
  inputClassName?: string;
}

export function SearchFilterBar({
  placeholder = "Search...",
  search,
  onSearchChange,
  onSearchSubmit,
  hasActiveFilters: _hasActiveFilters,
  onReset: _onReset,
  filters,
  inlineFilters = false,
  initialFiltersOpen = false,
  className,
  inputClassName,
}: SearchFilterBarProps) {
  const [showFilters, setShowFilters] = useState(initialFiltersOpen);
  useEffect(() => {
    if (initialFiltersOpen) setShowFilters(true);
  }, [initialFiltersOpen]);

  return (
    <div className={cn("space-y-0", className)}>
      <div className={cn("flex gap-2", inlineFilters && "flex-wrap")}>
        <div className={cn("relative flex-1", inlineFilters && "min-w-[14rem]")}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={placeholder}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchSubmit ? (e) => e.key === "Enter" && onSearchSubmit() : undefined}
            className={cn("pl-9", inputClassName)}
          />
        </div>
        {filters && inlineFilters && filters}
        {filters && !inlineFilters && (
          <Button
            variant="outline"
            aria-expanded={showFilters}
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="h-4 w-4" />
            Filters
          </Button>
        )}
      </div>

      {filters && !inlineFilters && (
        <AnimatePresence>
          {showFilters && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-3 border border-border bg-card p-3 mt-2">
                {filters}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  );
}
