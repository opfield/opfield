import * as React from "react";
import { cn } from "@/lib/utils";

function decimalPlaces(value: number) {
  const [, fraction = ""] = String(value).split(".");
  return fraction.length;
}

function snapValue(value: number, min: number, max: number, step: number) {
  if (![value, min, max, step].every(Number.isFinite) || step <= 0 || max < min) return min;
  const steps = Math.round((value - min) / step);
  const precision = Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step));
  return Number(Math.max(min, Math.min(max, min + steps * step)).toFixed(precision));
}

export const Slider = React.forwardRef<
  HTMLDivElement,
  {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    ariaLabel: string;
    className?: string;
    onValueChange: (value: number) => void;
  }
>(
  (
    { value, min = 0, max = 100, step = 1, disabled = false, ariaLabel, className, onValueChange },
    forwardedRef
  ) => {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const draggingRef = React.useRef<number | null>(null);
    const clampedValue = snapValue(value, min, max, step);
    const percentage = max === min ? 0 : ((clampedValue - min) / (max - min)) * 100;

    React.useImperativeHandle(forwardedRef, () => rootRef.current as HTMLDivElement);

    const updateFromClientX = (clientX: number) => {
      const root = rootRef.current;
      if (!root || disabled || !Number.isFinite(clientX)) return;
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onValueChange(snapValue(min + ratio * (max - min), min, max, step));
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      draggingRef.current = event.pointerId;
      updateFromClientX(event.clientX);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current !== event.pointerId) return;
      updateFromClientX(event.clientX);
    };

    const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current !== event.pointerId) return;
      draggingRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const nextValue = {
        ArrowLeft: clampedValue - step,
        ArrowDown: clampedValue - step,
        ArrowRight: clampedValue + step,
        ArrowUp: clampedValue + step,
        PageDown: clampedValue - step * 10,
        PageUp: clampedValue + step * 10,
        Home: min,
        End: max,
      }[event.key];
      if (nextValue === undefined) return;
      event.preventDefault();
      onValueChange(snapValue(nextValue, min, max, step));
    };

    return (
      <div
        ref={rootRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clampedValue}
        aria-disabled={disabled || undefined}
        className={cn(
          "group relative flex h-9 w-full touch-none select-none items-center outline-none",
          disabled && "cursor-not-allowed opacity-50",
          !disabled && "cursor-pointer",
          className
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onKeyDown={handleKeyDown}
      >
        <div data-slider-track="" className="relative h-1.5 w-full overflow-hidden bg-muted">
          <div
            data-slider-range=""
            className="absolute inset-y-0 left-0 bg-primary"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div
          data-slider-thumb=""
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 border border-primary bg-background shadow-sm group-focus-visible:ring-1 group-focus-visible:ring-ring"
          style={{ left: `${percentage}%` }}
        />
      </div>
    );
  }
);
Slider.displayName = "Slider";
