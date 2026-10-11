import type * as React from "react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./SectionHeader";

interface PanelShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  header?: React.ReactNode;
  children?: React.ReactNode;
  dirty?: boolean;
  headerBorder?: boolean;
  headerClassName?: string;
  headerContentClassName?: string;
  headerActionsClassName?: string;
  bodyClassName?: string;
  bodyProps?: React.HTMLAttributes<HTMLDivElement>;
  wrapHeader?: boolean;
}

export function PanelShell({
  title,
  icon,
  description,
  actions,
  header,
  children,
  dirty,
  headerBorder,
  className,
  headerClassName,
  headerContentClassName,
  headerActionsClassName,
  bodyClassName,
  bodyProps,
  wrapHeader,
  style,
  ...props
}: PanelShellProps) {
  const hasBody = children !== undefined && children !== null;
  const resolvedHeaderBorder = headerBorder ?? hasBody;

  return (
    <div
      className={cn("border border-border bg-card overflow-hidden", className)}
      style={{ ...(dirty ? { borderColor: "var(--color-warning)" } : null), ...style }}
      {...props}
    >
      {header ??
        (title !== undefined ? (
          <SectionHeader
            title={title}
            icon={icon}
            description={description}
            actions={actions}
            withBorder={resolvedHeaderBorder}
            wrap={wrapHeader}
            className={headerClassName}
            contentClassName={headerContentClassName}
            actionsClassName={headerActionsClassName}
          />
        ) : null)}
      {hasBody ? (
        <div {...bodyProps} className={cn(bodyClassName, bodyProps?.className)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
