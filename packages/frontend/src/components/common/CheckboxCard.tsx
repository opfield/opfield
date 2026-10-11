import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

interface CheckboxCardProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A bordered checkbox option: the box and its label on the first line, the description
 * below across the full width. Use it for an option that is included or not; use
 * `SwitchCard` for a setting that stays on or off. A disabled `fieldset` around it
 * disables it too.
 */
export function CheckboxCard({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: CheckboxCardProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <label
      className={cn(
        "block cursor-pointer space-y-1.5 border border-border p-3 transition-colors hover:bg-accent/50",
        "has-[:disabled]:cursor-default has-[:disabled]:hover:bg-transparent",
        className
      )}
    >
      <span className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
      </span>
      {description ? (
        <span id={descriptionId} className="block text-xs text-muted-foreground">
          {description}
        </span>
      ) : null}
    </label>
  );
}
