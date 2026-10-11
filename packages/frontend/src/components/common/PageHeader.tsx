import type * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Before the title, such as a back button or a resource icon. */
  leading?: React.ReactNode;
  /** After the title, such as status badges. */
  badges?: React.ReactNode;
  /** Right-aligned page actions, usually `ResponsiveHeaderActions`. */
  actions?: React.ReactNode;
  className?: string;
}

/** The title row at the top of every page. */
export function PageHeader({
  title,
  description,
  leading,
  badges,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {leading}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-display text-2xl font-bold">{title}</h1>
            {badges}
          </div>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {actions}
    </div>
  );
}
