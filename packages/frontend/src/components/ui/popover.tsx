import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Popovers ship their own copy of Radix's layer stack, so a dialog around one does not see it as a
 * layer above itself and would close on the Escape meant for the popover. An open popover takes
 * Escape first (window capture runs before the layers' document listeners) and closes only itself.
 */
const PopoverStateContext = React.createContext<{
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}>({});

function Popover({
  open,
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  const state = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
  return (
    <PopoverStateContext.Provider value={state}>
      <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />
    </PopoverStateContext.Provider>
  );
}

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, onEscapeKeyDown, ...props }, ref) => {
  const { open, onOpenChange } = React.useContext(PopoverStateContext);
  const onEscapeRef = React.useRef(onEscapeKeyDown);
  onEscapeRef.current = onEscapeKeyDown;
  React.useEffect(() => {
    if (!open || !onOpenChange) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onEscapeRef.current?.(event);
      if (event.defaultPrevented) return;
      event.stopPropagation();
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [open, onOpenChange]);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        onEscapeKeyDown={onEscapeKeyDown}
        className={cn(
          // Fades like dropdown menus and selects (css/animations.css).
          "dropdown-content z-50 min-w-32 border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
