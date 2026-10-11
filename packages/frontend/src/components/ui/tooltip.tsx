import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "tooltip-content z-50 hidden overflow-visible border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-[0_1px_2px_color-mix(in_srgb,var(--color-scrim)_4%,transparent)] md:block dark:shadow-sm",
        className
      )}
      {...props}
    >
      {props.children}
      <TooltipPrimitive.Arrow
        className="fill-border stroke-border"
        width={12}
        height={6}
        strokeWidth={1}
      />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
