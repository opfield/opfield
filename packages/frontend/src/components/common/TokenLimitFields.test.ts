import { describe, expect, it } from "vitest";
import {
  addressSummary,
  currentTokenExpiry,
  expiryError,
  expiryRequestValue,
  sameExpiry,
} from "./TokenLimitFields";

describe("token limit fields", () => {
  it("sends a preset as the moment it stands for at save time, Never as null", () => {
    const before = Date.now();
    const at = Date.parse(expiryRequestValue({ choice: "1h", custom: "" }) ?? "");
    expect(at - before).toBeGreaterThanOrEqual(3_600_000 - 1000);
    expect(at - before).toBeLessThanOrEqual(3_600_000 + 1000);
    expect(expiryRequestValue({ choice: "never", custom: "" })).toBeNull();
  });

  it("asks a custom date to lie at least 15 minutes ahead", () => {
    expect(expiryError({ choice: "custom", custom: "" })).toBe("Pick a date and time.");
    const soon = new Date(Date.now() + 5 * 60_000);
    const local = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    expect(expiryError({ choice: "custom", custom: local(soon) })).toMatch(/15 minutes/);
    expect(
      expiryError({ choice: "custom", custom: local(new Date(Date.now() + 86_400_000)) })
    ).toBeNull();
    expect(expiryError({ choice: "15m", custom: "" })).toBeNull();
  });

  it("opens an existing token at its expiry, unchanged until edited", () => {
    const current = currentTokenExpiry("2027-01-02T03:04:00.000Z");
    expect(current.choice).toBe("custom");
    expect(sameExpiry(current, { ...current })).toBe(true);
    expect(currentTokenExpiry(null).choice).toBe("never");
  });

  it("summarises the allowed addresses", () => {
    expect(addressSummary([])).toBe("Any address");
    expect(addressSummary(["10.0.0.0/8"])).toBe("1 allowed address");
    expect(addressSummary(["10.0.0.0/8", "203.0.113.10"])).toBe("2 allowed addresses");
  });
});
