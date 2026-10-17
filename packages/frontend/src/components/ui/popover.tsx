import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { DialogLayerContext } from "@/components/ui/dialog";
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

/** Calls `onExit` when it unmounts: with the popover content, once its close animation is over. */
function ExitNotifier({ onExit }: { onExit: () => void }) {
  const onExitRef = React.useRef(onExit);
  onExitRef.current = onExit;
  React.useEffect(() => () => onExitRef.current(), []);
  return null;
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    /**
     * Runs once the content is gone (after the close animation, or at once without one). Reset a
     * search or other view state here, never in `onOpenChange(false)`: the closing list would
     * jump back to its unfiltered state while it fades out.
     */
    onExitComplete?: () => void;
  }
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      onEscapeKeyDown,
      onExitComplete,
      children,
      ...props
    },
    ref
  ) => {
    const { open, onOpenChange } = React.useContext(PopoverStateContext);
    const dialogLayer = React.useContext(DialogLayerContext);
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
      <PopoverPrimitive.Portal container={dialogLayer ?? undefined}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          onEscapeKeyDown={onEscapeKeyDown}
          className={cn(
            // Fades like dropdown menus and selects (css/animations.css).
            "dropdown-content pointer-events-auto z-50 min-w-32 border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        >
          {onExitComplete && <ExitNotifier onExit={onExitComplete} />}
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  }
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
