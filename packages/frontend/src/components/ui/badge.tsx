import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Children } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex max-w-full min-w-0 shrink items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap py-0 text-2xs font-semibold uppercase tracking-wider leading-none [&>*]:max-w-full [&>*]:min-w-0 [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-muted text-muted-foreground",
        destructive: "bg-destructive/15 text-destructive",
        outline: "border border-border text-muted-foreground",
        success: "bg-success/15 text-success-text",
        warning: "bg-warning/15 text-warning-foreground",
        "warning-solid": "bg-warning text-on-warning",
        info: "bg-info/15 text-info-text",
      },
      // AI: Use `inline` ONLY when the badge shares a row with regular text. Never use it for standalone badges.
      size: {
        default: "h-6 px-2",
        inline: "h-5 px-1",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof badgeVariants> {}

function renderBadgeChildren(children: React.ReactNode) {
  const output: React.ReactNode[] = [];
  let text = "";

  const flushText = () => {
    if (!text) return;
    output.push(
      <span key={`text-${output.length}`} className="block min-w-0 max-w-full truncate">
        {text}
      </span>
    );
    text = "";
  };

  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      return;
    }
    flushText();
    output.push(child);
  });
  flushText();

  return output;
}

function Badge({ className, variant, size, children, ...props }: BadgeProps) {
  const Component = size === "inline" ? "span" : "div";
  return (
    <Component className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {renderBadgeChildren(children)}
    </Component>
  );
}

export { Badge, badgeVariants };
