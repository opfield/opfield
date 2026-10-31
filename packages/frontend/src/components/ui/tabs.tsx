import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { PageTransition } from "@/components/common/PageTransition";
import { cn } from "@/lib/utils";

/**
 * A page's tab bar with `fill`: it takes the rest of the page column. It is held to that height
 * only while the open panel is a `fill` panel (one that scrolls inside); any other panel grows with
 * its content, the page scrolls, and the page's own bottom padding stays under the content.
 * Panels never add bottom padding of their own.
 */
const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & { fill?: boolean }
>(({ className, fill = false, ...props }, ref) => (
  <TabsPrimitive.Root
    ref={ref}
    className={
      fill
        ? cn("flex flex-1 flex-col has-[>[data-fill][data-state=active]]:min-h-0", className)
        : className
    }
    {...props}
  />
));
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-0 border border-border w-fit max-w-full overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap px-4 py-2 text-sm font-medium focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
      "bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent",
      "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/** `fill`: the panel takes the rest of a `fill` tab bar's height and its content scrolls inside. */
const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> & { fill?: boolean }
>(({ className, children, fill = false, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    data-fill={fill ? "" : undefined}
    className={cn(
      "mt-4 focus-visible:outline-none",
      fill && "flex min-h-0 flex-1 flex-col",
      className
    )}
    {...props}
  >
    <PageTransition className="flex min-h-0 flex-1 flex-col" offsetY={0}>
      {children}
    </PageTransition>
  </TabsPrimitive.Content>
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
