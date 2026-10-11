import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Tint of the chosen segment, as the Badge tints; neutral by default. */
  tone?: "success" | "destructive";
}

const NEXT_KEYS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Mutually exclusive options side by side (a radio group). The chosen segment
 * takes a light tint, never a solid fill. Arrow keys move the choice, and only
 * the chosen segment is in the tab order.
 *
 * `flush` drops the outer border and fills the parent's height, so the control
 * sits in a cell of a bordered row and shares that row's borders.
 */
export function SegmentedChoice<T extends string>({
  value,
  options,
  onChange,
  size = "default",
  flush = false,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: T;
  options: SegmentedChoiceOption<T>[];
  onChange: (value: T) => void;
  size?: "sm" | "default";
  flush?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const choose = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = NEXT_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    const nextIndex = (index + step + options.length) % options.length;
    onChange(options[nextIndex].value);
    const segments = event.currentTarget.parentElement?.children;
    (segments?.[nextIndex] as HTMLElement | undefined)?.focus();
  };

  // With no option chosen yet, the first one takes the tab stop.
  const tabStop = Math.max(
    options.findIndex((option) => option.value === value),
    0
  );

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex shrink-0",
        flush ? "self-stretch" : "w-fit border border-border",
        disabled && "opacity-50",
        className
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => choose(event, index)}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed",
              size === "sm" ? "px-2.5 text-xs" : "px-3 text-sm",
              flush ? "self-stretch" : size === "sm" ? "h-7" : "h-9",
              index > 0 && "border-l border-border",
              !checked && "text-muted-foreground hover:text-foreground",
              checked && option.tone === "success" && "bg-success/15 text-success-text",
              checked && option.tone === "destructive" && "bg-destructive/15 text-destructive",
              checked && !option.tone && "bg-accent text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
