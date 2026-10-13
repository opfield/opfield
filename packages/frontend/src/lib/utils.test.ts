import { describe, expect, it } from "vitest";
import { formatFileDescriptorLimit } from "./utils";

describe("formatFileDescriptorLimit", () => {
  it("shows RLIM_INFINITY and any limit from 2^62 up as Unlimited", () => {
    expect(formatFileDescriptorLimit(2 ** 63 - 1)).toBe("Unlimited");
    expect(formatFileDescriptorLimit(2 ** 64 - 1)).toBe("Unlimited");
    expect(formatFileDescriptorLimit(2 ** 62)).toBe("Unlimited");
    expect(formatFileDescriptorLimit(Number.POSITIVE_INFINITY)).toBe("Unlimited");
  });

  it("shows a real limit as a number", () => {
    expect(formatFileDescriptorLimit(1_048_576)).toBe((1_048_576).toLocaleString());
    expect(formatFileDescriptorLimit(0)).toBe("0");
  });
});
