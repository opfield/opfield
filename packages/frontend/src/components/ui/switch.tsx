import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-pressed={checked}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer appearance-none items-center justify-start border border-input p-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // `disabled:` also covers a switch inside a disabled fieldset.
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/20"
      )}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span
        className={cn(
          "absolute top-px inline-block h-4 w-4 bg-background transition-[left]",
          checked ? "left-[17px]" : "left-px"
        )}
      />
    </button>
  );
}
