import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_SEARCH_DELAY_MS, useLiveSearch } from "./use-live-search";

describe("useLiveSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies the typed search after a pause, once, without Enter", () => {
    const apply = vi.fn();
    const { rerender } = renderHook(({ input }) => useLiveSearch(input, "", apply), {
      initialProps: { input: "sh" },
    });
    rerender({ input: "shop" });
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS - 1);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("shop");
  });

  it("does nothing while the list already shows the typed search", () => {
    const apply = vi.fn();
    renderHook(() => useLiveSearch("shop", "shop", apply));
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS * 2);
    expect(apply).not.toHaveBeenCalled();
  });
});
