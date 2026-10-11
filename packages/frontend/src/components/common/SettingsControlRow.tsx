import { CircleHelp } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SettingsControlRow({
  title,
  description,
  help,
  children,
  className,
  controlsClassName = "",
  onClick,
}: {
  title: ReactNode;
  description?: ReactNode;
  help?: string;
  children: ReactNode;
  className?: string;
  controlsClassName?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(12rem,1fr)_auto] sm:items-center",
        onClick &&
          "cursor-pointer transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        className
      )}
      onClick={onClick}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (!onClick || event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onClick();
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {help && typeof title === "string" ? (
            <SettingsHelpTitle label={title} help={help} />
          ) : (
            title
          )}
        </div>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div
        className={cn(
          "flex w-full shrink-0 items-center justify-end sm:w-auto sm:min-w-[14rem] sm:max-w-[24rem]",
          controlsClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SettingsInlineControl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block w-full min-w-0 space-y-1.5">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function SettingsHelpTitle({ label, help }: { label: string; help?: string }) {
  if (!help) return label;
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* size-exception: help glyph inline in a setting title */}
            <button
              type="button"
              aria-label={`About ${label}`}
              className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={(event) => event.stopPropagation()}
            >
              <CircleHelp className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="start"
            className="max-w-xs whitespace-normal py-2 leading-relaxed"
          >
            {help}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}
