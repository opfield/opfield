import { type ReactNode, useId } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface SwitchCardProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** The accessible name, when it should differ from the label. */
  ariaLabel?: string;
}

/**
 * A bordered on/off option, the switch counterpart of `CheckboxCard`: the switch
 * and its label on the first line, the description below across the full width.
 * Use it for a setting that stays on or off; use `CheckboxCard` for an option
 * that is included or not. A disabled `fieldset` around it disables it too.
 */
export function SwitchCard({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
  ariaLabel,
}: SwitchCardProps) {
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
        <Switch
          checked={checked}
          onChange={onCheckedChange}
          disabled={disabled}
          ariaLabel={ariaLabel}
          ariaLabelledBy={ariaLabel ? undefined : labelId}
          ariaDescribedBy={description ? descriptionId : undefined}
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
