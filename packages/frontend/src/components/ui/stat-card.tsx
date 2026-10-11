import { ProgressBar } from "@/components/ui/progress-bar";
import { Sparkline } from "@/components/ui/sparkline";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
  history?: number[];
  color?: string;
  subtitle?: string;
  subtitleClassName?: string;
  /** A small secondary line under the subtitle, such as a raw path. */
  footnote?: string;
  progress?: { percent: number; color?: string };
  sparklineMax?: number;
  /** Override text color for label and value (e.g. for warning state) */
  valueColor?: string;
  /** Additional classes for the primary value only. */
  valueClassName?: string;
  appearance?: "default" | "dashboard";
  className?: string;
  style?: React.CSSProperties;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  history = [],
  color = "var(--color-primary)",
  subtitle,
  subtitleClassName,
  footnote,
  progress,
  sparklineMax,
  valueColor,
  valueClassName,
  appearance = "default",
  className,
  style,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card flex flex-col overflow-hidden",
        className
      )}
      style={style}
    >
      <div className="flex-1 space-y-2 p-4">
        <div className="flex items-center justify-between">
          <p
            className={cn(
              appearance === "dashboard" ? "text-sm" : "text-xs",
              "text-muted-foreground"
            )}
            style={valueColor ? { color: valueColor } : undefined}
          >
            {label}
          </p>
          <Icon
            className={cn(
              appearance === "dashboard" ? "h-4 w-4" : "h-3.5 w-3.5",
              "text-muted-foreground"
            )}
          />
        </div>
        <p
          className={cn(
            appearance === "dashboard" ? "text-2xl" : "text-xl",
            "font-display font-semibold",
            valueClassName
          )}
          style={valueColor ? { color: valueColor } : undefined}
        >
          {value}
        </p>
        {progress && (
          <ProgressBar value={progress.percent} indicatorColor={progress.color ?? color} />
        )}
        {subtitle && (
          <p
            className={cn(
              appearance === "dashboard" ? "text-xs" : "text-2xs",
              "text-muted-foreground",
              subtitleClassName
            )}
          >
            {subtitle}
          </p>
        )}
        {footnote && (
          <p className="truncate text-2xs text-muted-foreground" title={footnote}>
            {footnote}
          </p>
        )}
      </div>
      {history.length >= 1 && (
        <Sparkline
          data={history}
          width={200}
          height={32}
          color={color}
          fillOpacity={0.1}
          className="w-full"
          maxValue={sparklineMax}
        />
      )}
    </div>
  );
}
