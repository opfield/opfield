import { act } from "@testing-library/react";

const ANIMATED = [
  { className: "dialog-content", open: "dialog-content-show", closed: "dialog-content-hide" },
  { className: "dialog-overlay", open: "dialog-overlay-show", closed: "dialog-overlay-hide" },
];

/**
 * jsdom has no CSS animations, so Radix unmounts a closing dialog at once and a test cannot tell a
 * dialog that closes with its exit animation from one that is unmounted. This gives the dialog
 * overlay and panel the animation names css/animations.css gives them: a closing dialog then stays
 * in the document with data-state="closed" until `finishDialogAnimations()`, as in a browser.
 */
export function stubDialogAnimations(): () => void {
  // Radix matches the ended animation by CSS.escape(name); jsdom has no CSS namespace.
  if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { ...(globalThis.CSS ?? {}), escape: (value: string) => value },
    });
  }
  const original = window.getComputedStyle;
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = original.call(window, element, pseudo);
    const animated = ANIMATED.find((entry) => element.classList?.contains(entry.className));
    if (!animated) return style;
    return new Proxy(style, {
      get(target, key) {
        if (key === "animationName") {
          return element.getAttribute("data-state") === "closed" ? animated.closed : animated.open;
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;
  return () => {
    window.getComputedStyle = original;
  };
}

/** Ends the exit animation of every closing dialog, as the browser does after 200 ms. */
export function finishDialogAnimations() {
  for (const entry of ANIMATED) {
    for (const element of document.querySelectorAll(`.${entry.className}[data-state="closed"]`)) {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: entry.closed });
      act(() => {
        element.dispatchEvent(event);
      });
    }
  }
}
