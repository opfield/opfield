import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectCodeCountdown, formatCountdown } from "./ConnectCodeCountdown";

describe("connect code countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the time left as m:ss", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(9_000)).toBe("0:09");
    expect(formatCountdown(-5)).toBe("0:00");
  });

  it("counts down every second and reports the expiry once", () => {
    const onExpired = vi.fn();
    render(<ConnectCodeCountdown expiresAt="2026-10-12T10:00:03Z" onExpired={onExpired} />);
    expect(screen.getByRole("timer")).toHaveTextContent("0:03");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("0:02");
    expect(onExpired).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
});
