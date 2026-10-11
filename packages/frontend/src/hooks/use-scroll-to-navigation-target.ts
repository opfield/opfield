import { useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { InitialPageReadyContext } from "@/components/common/PageTransition";

export interface ScrollNavigationState {
  scrollTarget?: string;
}

export interface ScrollNavigationOptions {
  block?: ScrollLogicalPosition;
  behavior?: ScrollBehavior;
  delayMs?: number;
  highlightDurationMs?: number;
}

const DEFAULT_NAVIGATION_SCROLL_DELAY_MS = 120;

function consumeScrollTargetState(state: ScrollNavigationState | null) {
  if (!state || !("scrollTarget" in state)) return;
  delete state.scrollTarget;

  const browserState = window.history.state as Record<string, unknown> | null;
  if (!browserState) return;
  if ("usr" in browserState) {
    window.history.replaceState({ ...browserState, usr: state }, "");
  }
}

function hasVisibleBorder(style: CSSStyleDeclaration) {
  const color = style.borderTopColor;
  return (
    style.borderTopStyle !== "none" &&
    Number.parseFloat(style.borderTopWidth) > 0 &&
    color !== "transparent" &&
    color !== "rgba(0, 0, 0, 0)" &&
    color !== ""
  );
}

function normalizedCssColor(value: string) {
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.match(/^#([\da-f]{6})$/);
  if (!hex) return trimmed;
  const numeric = Number.parseInt(hex[1], 16);
  return `rgb(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255})`;
}

function setRippleColor(target: HTMLElement) {
  const borderedElement = [target, ...target.querySelectorAll<HTMLElement>("*")].find((element) =>
    hasVisibleBorder(window.getComputedStyle(element))
  );
  if (borderedElement) {
    const borderColor = window.getComputedStyle(borderedElement).borderTopColor;
    const defaultBorderColor = normalizedCssColor(
      window.getComputedStyle(document.documentElement).getPropertyValue("--color-border")
    );
    target.style.setProperty(
      "--navigation-target-ripple-color",
      normalizedCssColor(borderColor) === defaultBorderColor
        ? "var(--color-foreground)"
        : borderColor
    );
  } else {
    target.style.setProperty("--navigation-target-ripple-color", "var(--color-foreground)");
  }
}

function scrollableAncestor(target: HTMLElement) {
  let current = target.parentElement;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

function scrollToTarget(
  target: HTMLElement,
  behavior: ScrollBehavior,
  block: ScrollLogicalPosition
) {
  const container = scrollableAncestor(target);
  if (!container) {
    target.scrollIntoView({ behavior, block });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
  let top = relativeTop;
  if (block === "center") {
    top = relativeTop - (container.clientHeight - targetRect.height) / 2;
  } else if (block === "end") {
    top = relativeTop - container.clientHeight + targetRect.height;
  } else if (block === "nearest") {
    const visibleTop = container.scrollTop;
    const visibleBottom = visibleTop + container.clientHeight;
    const targetBottom = relativeTop + targetRect.height;
    if (relativeTop >= visibleTop && targetBottom <= visibleBottom) return;
    top = relativeTop < visibleTop ? relativeTop : targetBottom - container.clientHeight;
  }
  container.scrollTo({
    top: Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight)),
    behavior,
  });
}

export function useScrollToNavigationTarget(
  targetId: string,
  ready = true,
  options: ScrollNavigationOptions = {}
): boolean {
  const initialPageReady = useContext(InitialPageReadyContext);
  const location = useLocation();
  const handledLocationKey = useRef<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const scrollTarget = (location.state as ScrollNavigationState | null)?.scrollTarget;
  const block = options.block ?? "start";
  const behavior = options.behavior ?? "smooth";
  const delayMs = options.delayMs ?? DEFAULT_NAVIGATION_SCROLL_DELAY_MS;
  const highlightDurationMs = options.highlightDurationMs ?? 0;

  useEffect(() => {
    if (
      !ready ||
      !initialPageReady ||
      scrollTarget !== targetId ||
      handledLocationKey.current === location.key
    )
      return;

    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;
    const scheduleScroll = () => {
      if (handledLocationKey.current === location.key) return true;
      const target = document.getElementById(targetId);
      if (!target) return false;

      const performScroll = () => {
        const currentTarget = document.getElementById(targetId);
        if (!currentTarget || handledLocationKey.current === location.key) return;
        scrollToTarget(currentTarget, behavior, block);
        handledLocationKey.current = location.key;
        consumeScrollTargetState(location.state as ScrollNavigationState | null);
        observer?.disconnect();
        if (highlightDurationMs > 0) {
          setRippleColor(currentTarget);
          setHighlightedKey(location.key);
        }
      };
      if (delayMs <= 0) performScroll();
      else timeoutId = window.setTimeout(performScroll, delayMs);
      return true;
    };

    if (!scheduleScroll()) {
      observer = new MutationObserver(() => scheduleScroll());
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleScroll();
    }

    return () => {
      observer?.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [
    behavior,
    block,
    delayMs,
    highlightDurationMs,
    initialPageReady,
    location.key,
    location.state,
    ready,
    scrollTarget,
    targetId,
  ]);

  useEffect(() => {
    if (highlightedKey !== location.key || highlightDurationMs <= 0) return;
    const timeoutId = window.setTimeout(() => {
      setHighlightedKey((current) => (current === location.key ? null : current));
      document.getElementById(targetId)?.style.removeProperty("--navigation-target-ripple-color");
    }, highlightDurationMs);
    return () => window.clearTimeout(timeoutId);
  }, [highlightDurationMs, highlightedKey, location.key, targetId]);

  return highlightedKey === location.key;
}
