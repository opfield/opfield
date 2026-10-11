import { cn } from "@/lib/utils";

interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
  indicatorColor?: string;
  indicatorClassName?: string;
}

export function ProgressBar({
  value,
  indicatorColor,
  indicatorClassName,
  className,
  ...props
}: ProgressBarProps) {
  const clampedValue = Math.max(0, Math.min(value, 100));

  return (
    <div className={cn("h-1.5 w-full overflow-hidden bg-border", className)} {...props}>
      <div
        className={cn("h-full bg-primary transition-all", indicatorClassName)}
        style={{
          width: `${clampedValue}%`,
          backgroundColor: indicatorColor,
        }}
      />
    </div>
  );
}
