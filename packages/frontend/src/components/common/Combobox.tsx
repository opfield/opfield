import { ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { SelectItemCheck, selectItemClassName } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: string;
  group?: string;
  disabled?: boolean;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onValueChange: (value: string) => void;
  freeText?: boolean;
  showAllOptionsOnFocus?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  contentClassName?: string;
  /** Id of the input, so a form label can point at it. */
  id?: string;
  ariaLabel?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
  /** Receives the typed search text, for options loaded from the server as the user types. */
  onQueryChange?: (query: string) => void;
}

type MultiComboboxProps = Omit<ComboboxProps, "value" | "onValueChange" | "freeText"> & {
  multiple: true;
  value: string[];
  onValueChange: (value: string[]) => void;
  freeText?: false;
  selectionLabel?: (values: string[]) => string;
};

export function Combobox(props: (ComboboxProps & { multiple?: false }) | MultiComboboxProps) {
  const {
    options,
    freeText = false,
    showAllOptionsOnFocus = false,
    placeholder = "Select...",
    searchPlaceholder = "Search...",
    emptyMessage,
    disabled,
    className,
    inputClassName,
    contentClassName,
    id,
    ariaLabel,
    renderOption,
    onQueryChange,
  } = props;
  const value = props.multiple ? "" : props.value;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAllOptions, setShowAllOptions] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );
  const filteredOptions = useMemo(() => {
    if (showAllOptions) return options;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      [option.label, option.keywords, option.value]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
  }, [options, query, showAllOptions]);

  const activeIndex = filteredOptions.length
    ? Math.max(
        0,
        filteredOptions.findIndex((option) => option.value === activeValue)
      )
    : -1;
  const contentOpen = open && !disabled;

  // Refreshes may replace every option object. Preserve selection by value and
  // only scroll the dropdown itself when the user navigates, never its dialog.
  useLayoutEffect(() => {
    if (!contentOpen || activeValue === null) return;
    const content = contentRef.current;
    const option = activeOptionRef.current;
    if (!content || !option) return;
    const viewport = content.getBoundingClientRect();
    const item = option.getBoundingClientRect();
    if (item.top < viewport.top) content.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom) content.scrollTop += item.bottom - viewport.bottom;
  }, [activeValue, contentOpen]);

  const close = () => {
    setOpen(false);
  };

  const finishClose = () => {
    setQuery("");
    onQueryChange?.("");
    setActiveValue(null);
    setShowAllOptions(false);
  };

  const selectOption = (option: ComboboxOption) => {
    if (option.disabled) return;
    if (props.multiple) {
      props.onValueChange(
        props.value.includes(option.value)
          ? props.value.filter((value) => value !== option.value)
          : [...props.value, option.value]
      );
      return;
    }
    props.onValueChange(option.value);
    close();
  };
  const displayValue = props.multiple
    ? (props.selectionLabel?.(props.value) ??
      (props.value.length > 1
        ? `${props.value.length} selected`
        : (options.find((option) => option.value === props.value[0])?.label ?? "")))
    : freeText
      ? value
      : (selected?.label ?? "");

  return (
    <Popover
      open={contentOpen}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setOpen(true);
        else close();
      }}
    >
      <div
        ref={rootRef}
        className={cn("relative w-full", className)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <PopoverAnchor asChild>
          <Input
            id={id}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={contentOpen}
            value={open ? query : displayValue}
            title={open ? undefined : displayValue}
            onFocus={() => {
              setActiveValue(null);
              setQuery(freeText ? value : "");
              setShowAllOptions(showAllOptionsOnFocus);
              setOpen(true);
            }}
            onClick={() => {
              if (open || disabled) return;
              setActiveValue(null);
              setQuery(freeText ? value : "");
              setShowAllOptions(showAllOptionsOnFocus);
              setOpen(true);
            }}
            onChange={(event) => {
              const nextValue = event.target.value;
              setActiveValue(null);
              setQuery(nextValue);
              onQueryChange?.(nextValue);
              setShowAllOptions(false);
              setOpen(true);
              if (!props.multiple && freeText) props.onValueChange(nextValue);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                close();
                event.currentTarget.blur();
                return;
              }
              if (!open || filteredOptions.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveValue(filteredOptions[(activeIndex + 1) % filteredOptions.length]!.value);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveValue(
                  filteredOptions[activeIndex <= 0 ? filteredOptions.length - 1 : activeIndex - 1]!
                    .value
                );
              } else if (event.key === "Enter" && activeIndex >= 0) {
                event.preventDefault();
                selectOption(filteredOptions[activeIndex]!);
              }
            }}
            placeholder={open ? searchPlaceholder : placeholder}
            className={cn("min-w-0 truncate pr-10", inputClassName)}
            disabled={disabled}
          />
        </PopoverAnchor>
        <ChevronDown className="pointer-events-none absolute right-3 top-[18px] h-4 w-4 -translate-y-1/2 opacity-50" />
        <PopoverContent
          ref={contentRef}
          align="start"
          sideOffset={4}
          collisionPadding={16}
          onExitComplete={finishClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
              event.preventDefault();
            }
          }}
          style={{ pointerEvents: "auto" }}
          className={cn(
            "dropdown-content z-50 max-h-[min(16rem,var(--radix-popover-content-available-height))] w-max min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] overflow-y-auto overscroll-contain p-1",
            contentClassName
          )}
        >
          {filteredOptions.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {/* A typed search that matches nothing says so, like every list's search. A server
                  search (onQueryChange) keeps its caller's message, which may be a hint. */}
              {query.trim() && !showAllOptions && !(onQueryChange && emptyMessage)
                ? `Nothing matches “${query.trim()}”.`
                : (emptyMessage ?? "Nothing to pick.")}
            </div>
          ) : (
            filteredOptions.map((option, index) => (
              <Fragment key={option.value}>
                {option.group && option.group !== filteredOptions[index - 1]?.group ? (
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {option.group}
                  </div>
                ) : null}
                <button
                  type="button"
                  ref={index === activeIndex ? activeOptionRef : undefined}
                  aria-disabled={option.disabled}
                  aria-pressed={props.multiple ? props.value.includes(option.value) : undefined}
                  className={cn(
                    selectItemClassName,
                    "gap-2 whitespace-nowrap text-left hover:bg-accent hover:text-accent-foreground aria-disabled:opacity-50",
                    index === activeIndex && "bg-accent text-accent-foreground"
                  )}
                  onMouseEnter={() => setActiveValue(option.value)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectOption(option);
                  }}
                >
                  {renderOption?.(option) ?? option.label}
                  {props.multiple && props.value.includes(option.value) ? (
                    <SelectItemCheck />
                  ) : null}
                </button>
              </Fragment>
            ))
          )}
        </PopoverContent>
      </div>
    </Popover>
  );
}
