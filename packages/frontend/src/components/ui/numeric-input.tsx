import * as React from "react";
import { cn } from "@/lib/utils";

interface NumericInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: number;
  onChange: (value: number, raw: string) => void;
  min?: number;
  max?: number;
}

/**
 * A numeric input that allows empty state (for editing) without
 * resetting to a default value. Reports both the parsed number
 * and the raw string so the parent can track validity.
 *
 * Shows a single red border when the value is empty or out of range.
 */
const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  ({ className, value, onChange, min, max, ...props }, ref) => {
    const [raw, setRaw] = React.useState(String(value));
    const lastPropValueRef = React.useRef(value);

    // Sync only when the prop value actually changes from outside. This keeps
    // the user's temporary empty/raw editing state intact.
    React.useEffect(() => {
      if (lastPropValueRef.current === value) return;
      lastPropValueRef.current = value;
      setRaw(String(value));
    }, [value]);

    const parsed = parseInt(raw, 10);
    const isInvalid =
      raw.trim() === "" ||
      Number.isNaN(parsed) ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newRaw = e.target.value;
      setRaw(newRaw);
      const num = parseInt(newRaw, 10);
      if (!Number.isNaN(num)) {
        lastPropValueRef.current = num;
      }
      onChange(Number.isNaN(num) ? value : num, newRaw);
    };

    return (
      <input
        ref={ref}
        type="number"
        value={raw}
        onChange={handleChange}
        min={min}
        max={max}
        aria-invalid={isInvalid || undefined}
        className={cn(
          "flex h-9 w-full border bg-background px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50",
          isInvalid
            ? "border-destructive focus-visible:border-destructive focus-visible:ring-0"
            : "border-input focus-visible:ring-ring",
          className
        )}
        {...props}
      />
    );
  }
);
NumericInput.displayName = "NumericInput";

export { NumericInput };
