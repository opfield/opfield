import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useHostingOperationOutcome } from "./use-hosting-operation-outcome";

const operation = { id: "op-1", action: "resize" as const, errorMessage: null };

describe("useHostingOperationOutcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the error of a started operation once, when it ends failed", () => {
    const { result } = renderHook(() => useHostingOperationOutcome());
    result.current.watch({ ...operation, phase: "pending" });
    result.current.observe([{ ...operation, phase: "provisioning" }]);
    expect(toast.error).not.toHaveBeenCalled();
    const failed = { ...operation, phase: "failed" as const, errorMessage: "Shut down the VM" };
    result.current.observe([failed]);
    result.current.observe([failed]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Shut down the VM");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("stays silent about operations it was not asked to watch", () => {
    const { result } = renderHook(() => useHostingOperationOutcome());
    result.current.observe([{ ...operation, phase: "failed", errorMessage: "old" }]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
