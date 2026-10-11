import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function hasRenderableSelectChildren(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return true;
    if (child.type !== React.Fragment) return true;
    return hasRenderableSelectChildren(child.props.children);
  });
}

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between border border-input bg-background px-3 py-2 text-left text-sm shadow-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 [&>span]:flex-1 [&>span]:text-left",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    overlayScrollControls?: boolean;
  }
>(({ className, children, position = "popper", overlayScrollControls = true, ...props }, ref) => {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = React.useState(false);
  const [canScrollDown, setCanScrollDown] = React.useState(false);

  const updateScrollControls = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const edgeTolerance = 1.5;
    setCanScrollUp(viewport.scrollTop > edgeTolerance);
    setCanScrollDown(viewport.scrollTop < maxScrollTop - edgeTolerance);
  }, []);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(updateScrollControls);
    viewport.addEventListener("scroll", updateScrollControls, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScrollControls);
    observer?.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", updateScrollControls);
      observer?.disconnect();
    };
  }, [updateScrollControls]);

  const content = hasRenderableSelectChildren(children) ? (
    children
  ) : (
    <SelectItem value="__empty__" disabled>
      No options available
    </SelectItem>
  );

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          "dropdown-content relative z-50 max-h-96 min-w-[8rem] overflow-hidden border border-border bg-popover text-popover-foreground shadow-md",
          position === "popper" &&
            "min-w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton
          className={cn(
            overlayScrollControls
              ? "absolute inset-x-0 top-0 z-10 h-10 items-start bg-gradient-to-b from-popover via-popover to-transparent pt-1"
              : undefined,
            overlayScrollControls && !canScrollUp && "pointer-events-none opacity-0"
          )}
        />
        <SelectPrimitive.Viewport
          ref={viewportRef}
          onScroll={updateScrollControls}
          className={cn(
            "p-1",
            position === "popper" && "h-[var(--radix-select-trigger-height)] w-full"
          )}
        >
          {content}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton
          className={cn(
            overlayScrollControls
              ? "absolute inset-x-0 bottom-0 z-10 h-10 items-end bg-gradient-to-t from-popover via-popover to-transparent pb-1"
              : undefined,
            overlayScrollControls && !canScrollDown && "pointer-events-none opacity-0"
          )}
        />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

export const selectItemClassName =
  "relative flex w-full cursor-default select-none items-center py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export function SelectItemCheck({ children }: { children?: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center"
    >
      {children ?? <Check className="h-4 w-4" />}
    </span>
  );
}

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    description?: React.ReactNode;
  }
>(({ className, children, description, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn(selectItemClassName, className)} {...props}>
    <SelectItemCheck>
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectItemCheck>
    <div className="min-w-0 flex-1">
      <SelectPrimitive.ItemText className="block truncate">{children}</SelectPrimitive.ItemText>
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
    </div>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export const __selectTestOnly = { hasRenderableSelectChildren };

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
