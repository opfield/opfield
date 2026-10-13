import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Loader2, X } from "lucide-react";
import * as React from "react";
import {
  InitialPageLoadContext,
  InitialPageReadyContext,
  useRevealGate,
} from "@/components/common/reveal-gate";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "dialog-overlay fixed inset-0 z-50 bg-scrim/50 overflow-hidden flex items-end sm:items-start justify-center sm:overflow-y-auto sm:py-12",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-dialog-header=""
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

// Footer buttons always sit together on the right, secondary first and the
// primary action last; a footer never spreads them to both edges.
const DIALOG_FOOTER_JUSTIFY_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*justify-(?:start|center|between|around|evenly|stretch|normal)(?=\s|$)/g;

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0",
      className?.replace(DIALOG_FOOTER_JUSTIFY_CLASS_RE, " ")
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DIALOG_OUTER_OVERFLOW_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*overflow(?:-[xy])?-(?:auto|scroll|hidden|visible|clip)(?=\s|$)/g;
const DIALOG_NESTED_VERTICAL_SCROLL_CLASS_RE =
  /(?:^|\s)(?:[^\s:]+:)*overflow-y-(?:auto|scroll)(?=\s|$)/;

function stripOuterOverflowClasses(className?: string) {
  return className?.replace(DIALOG_OUTER_OVERFLOW_CLASS_RE, " ").replace(/\s+/g, " ").trim();
}

function isDialogSlot(child: React.ReactNode, displayName: string) {
  if (!React.isValidElement(child)) return false;
  const type = child.type as { displayName?: string };
  return type.displayName === displayName;
}

export function assertNoNestedDialogVerticalScroll(children: React.ReactNode[]) {
  for (const child of children) {
    if (!React.isValidElement<{ className?: unknown }>(child)) continue;
    const className = child.props.className;
    if (typeof className === "string" && DIALOG_NESTED_VERTICAL_SCROLL_CLASS_RE.test(className)) {
      throw new Error(
        "DialogContent owns vertical scrolling. Remove overflow-y-auto/scroll from its body child."
      );
    }
  }
}

/**
 * Marks a long list inside a dialog (scopes, containers, raw text). The dialog sizes it to the room
 * left in the window between the header, the fields and the footer, so the list scrolls on its own
 * and the dialog body never does. A long list stays at least DIALOG_LIST_MIN_HEIGHT_PX tall; only in
 * a window too low even for that does the whole dialog scroll as well.
 */
export const DIALOG_LIST_CLASS = "dialog-list";
const DIALOG_LIST_MIN_HEIGHT_PX = 256;
/** Lists stacked one under another (a scope list and a webhook list) share the room: each keeps less. */
const DIALOG_STACKED_LIST_MIN_HEIGHT_PX = 128;

function fitDialogLists(panel: HTMLElement) {
  const lists = [...panel.querySelectorAll<HTMLElement>(`.${DIALOG_LIST_CLASS}`)];
  if (lists.length === 0) return;
  const body = panel.querySelector<HTMLElement>(":scope > [data-dialog-body]");
  const overlay = panel.parentElement;
  // Phones: the sheet scrolls its body. From sm the overlay scrolls the whole dialog.
  const bodyScrolls = body ? getComputedStyle(body).overflowY !== "visible" : false;
  const scroller = bodyScrolls ? body : overlay;
  if (!scroller) return;
  const scrollTops = lists.map((list) => list.scrollTop);
  const scrollerTop = scroller.scrollTop;
  // An AnimatedHeight wrapper lags behind its content while it animates: count the height its
  // content already has, not the height the wrapper has reached so far.
  const pendingGrowth = () => {
    let growth = 0;
    for (const wrapper of panel.querySelectorAll<HTMLElement>("[data-animated-height]")) {
      const content = wrapper.firstElementChild as HTMLElement | null;
      if (!content) continue;
      const style = getComputedStyle(wrapper);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      growth += content.offsetHeight + padding - wrapper.offsetHeight;
    }
    return growth;
  };
  const overflowOf = () => {
    if (bodyScrolls && body) return body.scrollHeight - body.clientHeight + pendingGrowth();
    if (!overlay) return 0;
    const style = getComputedStyle(overlay);
    const room =
      overlay.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return panel.offsetHeight + pendingGrowth() - room;
  };
  const release = () => {
    for (const list of lists) {
      list.style.maxHeight = "none";
      list.style.overflowY = "visible";
      list.removeAttribute("data-dialog-list-scrolls");
    }
  };
  release();
  let overflow = overflowOf();
  if (overflow > 0) {
    // Lists side by side (one row of a grid) shrink together to one height.
    const rows = new Map<number, HTMLElement[]>();
    for (const list of lists) {
      const top = Math.round(list.getBoundingClientRect().top);
      rows.set(top, [...(rows.get(top) ?? []), list]);
    }
    const byHeight = [...rows.values()]
      .map((row) => ({ row, height: Math.max(...row.map((list) => list.offsetHeight)) }))
      .sort((a, b) => b.height - a.height);
    const minHeight =
      byHeight.length > 1 ? DIALOG_STACKED_LIST_MIN_HEIGHT_PX : DIALOG_LIST_MIN_HEIGHT_PX;
    for (const { row, height } of byHeight) {
      const shrink = Math.min(overflow, height - minHeight);
      if (shrink <= 0) continue;
      const target = height - shrink;
      for (const list of row) {
        if (list.offsetHeight <= target) continue;
        list.style.maxHeight = `${target}px`;
        list.style.overflowY = "auto";
        list.setAttribute("data-dialog-list-scrolls", "");
      }
      overflow -= shrink;
      if (overflow <= 0) break;
    }
  }
  lists.forEach((list, index) => {
    list.scrollTop = scrollTops[index];
  });
  scroller.scrollTop = scrollerTop;
}

/**
 * The open dialog's panel. Popovers inside a dialog render into it, so the modal dialog lets them
 * take clicks and keyboard focus (a popover portalled to the body sits outside its focus trap).
 */
export const DialogLayerContext = React.createContext<HTMLElement | null>(null);

// A dialog whose content is loading stays hidden, overlay included, and opens
// complete once its data is in. Meanwhile the button that opened it shows a
// spinner; without such a button the screen dims with a spinner after a moment.
const DIALOG_WAIT_INDICATOR_DELAY_MS = 250;
const DIALOG_WAIT_INDICATOR_MIN_MS = 300;
const DIALOG_MAX_WAIT_MS = 10_000;
const DIALOG_OPENER_ATTRIBUTE = "data-dialog-opening";
const OPENER_CLICK_WINDOW_MS = 1000;

let lastPointerTarget: { element: HTMLElement; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("button, a, [role='button']")
          : null;
      lastPointerTarget = target ? { element: target, at: Date.now() } : null;
    },
    true
  );
}

/**
 * Only a `Button` takes the spinner (in place of its leading icon). Table rows, cards and text
 * links have no room for it: a pseudo-element on a row becomes an extra cell and shifts every
 * column, so for them the screen dims with a spinner instead.
 */
const takesOpenerSpinner = (element: HTMLElement) => element.matches("[data-button]");

/** The Button that opened this dialog: the one just clicked, or the one focused (keyboard). */
function findDialogOpener(panel: HTMLElement | null): HTMLElement | null {
  const clicked = lastPointerTarget;
  if (clicked && Date.now() - clicked.at < OPENER_CLICK_WINDOW_MS && clicked.element.isConnected) {
    if (!panel?.contains(clicked.element)) {
      return takesOpenerSpinner(clicked.element) ? clicked.element : null;
    }
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !panel?.contains(active)) {
    if (active.matches("button, a, [role='button']") && takesOpenerSpinner(active)) return active;
  }
  return null;
}

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  hideCloseButton?: boolean;
  unstyled?: boolean;
  clipOverflow?: boolean;
  /**
   * For a dialog given a fixed height (an editor or preview): the body takes the height left under
   * the header, so a child with `flex-1` or `height: 100%` fills it.
   */
  fillHeight?: boolean;
};

// Rendered inside the portal, which mounts it only while the dialog is open,
// so each opening waits for its own data.
const DialogContentPanel = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideCloseButton, unstyled, clipOverflow, ...rest }, ref) => {
  const { fillHeight, ...props } = rest;
  const [bodyScrolled, setBodyScrolled] = React.useState(false);
  // With an opener its spinner shows from the click, so there is no screen
  // indicator to delay or hold; the dialog opens as soon as the data is in.
  const [opener, setOpener] = React.useState<HTMLElement | null | undefined>(undefined);
  const gate = useRevealGate({
    loaderDelayMs: opener ? DIALOG_MAX_WAIT_MS * 2 : DIALOG_WAIT_INDICATOR_DELAY_MS,
    loaderMinMs: DIALOG_WAIT_INDICATOR_MIN_MS,
    maxWaitMs: DIALOG_MAX_WAIT_MS,
    isolated: true,
  });
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [panelElement, setPanelElement] = React.useState<HTMLDivElement | null>(null);
  const setPanelRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      panelRef.current = element;
      setPanelElement(element);
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref]
  );
  React.useLayoutEffect(() => {
    setOpener(findDialogOpener(panelRef.current));
  }, []);
  const waiting = !gate.revealed;
  React.useLayoutEffect(() => {
    if (!waiting || !opener) return;
    opener.setAttribute(DIALOG_OPENER_ATTRIBUTE, "");
    opener.setAttribute("aria-busy", "true");
    return () => {
      opener.removeAttribute(DIALOG_OPENER_ATTRIBUTE);
      opener.removeAttribute("aria-busy");
    };
  }, [waiting, opener]);
  // The overlay dims only once the dialog shows, or, without an opener to spin,
  // when the wait indicator appears.
  const overlayHeld = waiting && (Boolean(opener) || gate.phase === "pending");
  React.useLayoutEffect(() => {
    const overlay = panelRef.current?.parentElement;
    if (!overlay) return;
    overlay.style.animationPlayState = overlayHeld ? "paused" : "";
  }, [overlayHeld]);
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          fitDialogLists(panel);
        });
      }
    };
    fitDialogLists(panel);
    window.addEventListener("resize", schedule);
    // Rows added, filtered or expanded change the room the list needs.
    const observer = new MutationObserver(schedule);
    observer.observe(panel, { childList: true, subtree: true, characterData: true });
    // Animated steps change the panel's size without changing the DOM; a refit that changes
    // nothing leaves the size as it is, so this settles after one round.
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(panel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, []);
  const showScreenIndicator = waiting && opener === null && gate.phase === "loading";
  const contentClassName = stripOuterOverflowClasses(className);
  const childArray = React.Children.toArray(children);
  const headerChildren: React.ReactNode[] = [];
  const footerChildren: React.ReactNode[] = [];
  const bodyChildren: React.ReactNode[] = [];

  for (const child of childArray) {
    if (isDialogSlot(child, "DialogHeader")) {
      headerChildren.push(child);
    } else if (isDialogSlot(child, "DialogFooter")) {
      footerChildren.push(child);
    } else {
      bodyChildren.push(child);
    }
  }

  const hasHeader = headerChildren.length > 0;
  const hasFooter = footerChildren.length > 0;

  assertNoNestedDialogVerticalScroll(bodyChildren);

  if (unstyled) {
    return (
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "dialog-content relative z-50 grid w-full gap-4 border bg-background p-6 shadow-lg outline-none",
          "max-h-[85dvh] max-w-none overflow-y-auto",
          "sm:mx-auto sm:my-auto sm:max-h-none sm:overflow-visible sm:max-w-lg",
          className
        )}
        {...props}
      >
        <InitialPageLoadContext.Provider value={null}>{children}</InitialPageLoadContext.Provider>
        {!hideCloseButton && (
          <DialogPrimitive.Close className="absolute right-4 top-4 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    );
  }

  return (
    <>
      {showScreenIndicator ? (
        <div
          role="status"
          aria-label="Loading"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
        >
          <Loader2 className="h-6 w-6 animate-spin text-on-scrim/80" />
        </div>
      ) : null}
      <DialogPrimitive.Content
        ref={setPanelRef}
        className={cn(
          "dialog-content relative z-50 flex w-full max-w-none flex-col border bg-background p-0 shadow-lg outline-none",
          "max-h-[85dvh]",
          "sm:mx-auto sm:my-auto sm:max-w-lg",
          "sm:max-h-none",
          contentClassName,
          clipOverflow && "sm:overflow-clip",
          "max-sm:flex max-sm:max-h-[85dvh] max-sm:flex-col max-sm:gap-0 max-sm:overflow-hidden max-sm:p-0"
        )}
        {...props}
        // While the content loads the open animation holds its first, transparent
        // frame; the panel stays focusable, so autofocus works as usual.
        style={waiting ? { ...props.style, animationPlayState: "paused" } : props.style}
        data-reveal-phase={gate.phase}
      >
        <DialogLayerContext.Provider value={panelElement}>
          <InitialPageLoadContext.Provider value={gate.register}>
            <InitialPageReadyContext.Provider value={gate.revealed}>
              {hasHeader ? (
                <div
                  data-dialog-header-slot=""
                  className={cn(
                    "flex shrink-0 items-start justify-between gap-4 px-4 pb-4 pt-4 transition-shadow duration-200 ease-out sm:px-6 sm:pt-6",
                    bodyScrolled ? "max-sm:shadow-[inset_0_-1px_0_var(--color-border)]" : ""
                  )}
                >
                  <div className="min-w-0 flex-1">{headerChildren}</div>
                  {!hideCloseButton && (
                    <DialogPrimitive.Close className="shrink-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                      <X className="h-4 w-4" />
                      <span className="sr-only">Close</span>
                    </DialogPrimitive.Close>
                  )}
                </div>
              ) : null}
              {bodyChildren.length > 0 ? (
                <div
                  data-dialog-body=""
                  className={cn(
                    "relative min-h-0 min-w-0 px-4 max-sm:flex-1 max-sm:overflow-y-auto max-sm:overscroll-contain sm:px-6",
                    fillHeight && "flex flex-1 flex-col",
                    // One column the body's width: no child can widen the dialog.
                    bodyChildren.length > 1 && "grid grid-cols-1 gap-4",
                    hasHeader ? "pt-0" : "pt-4 sm:pt-6",
                    hasFooter ? "pb-0" : "pb-4 sm:pb-6"
                  )}
                  onScroll={(event) => setBodyScrolled(event.currentTarget.scrollTop > 0)}
                >
                  {bodyChildren}
                </div>
              ) : null}
              {hasFooter ? (
                <div className="shrink-0 px-4 pb-4 pt-4 sm:px-6 sm:pb-6">{footerChildren}</div>
              ) : null}
              {!hideCloseButton && !hasHeader && (
                <DialogPrimitive.Close className="absolute right-4 top-4 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              )}
            </InitialPageReadyContext.Provider>
          </InitialPageLoadContext.Provider>
        </DialogLayerContext.Provider>
      </DialogPrimitive.Content>
    </>
  );
});
DialogContentPanel.displayName = "DialogContentPanel";

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>((props, ref) => (
  <DialogPortal>
    <DialogOverlay>
      <DialogContentPanel ref={ref} {...props} />
    </DialogOverlay>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/** The longest dialog close animation (css/animations.css: 250ms on mobile, 200ms from sm). */
const DIALOG_CLOSE_ANIMATION_MS = 250;

/**
 * `open`, held true until the close animation has played. Data a dialog loads while open (and
 * clears or reloads by `open`) keys on this instead, so the content stays as it was while the
 * dialog closes and is dropped only once it is gone.
 */
function useDialogPresence(open: boolean): boolean {
  const [present, setPresent] = React.useState(open);
  React.useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = setTimeout(() => setPresent(false), DIALOG_CLOSE_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return open || present;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-dialog-title=""
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-dialog-description=""
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  useDialogPresence,
};
