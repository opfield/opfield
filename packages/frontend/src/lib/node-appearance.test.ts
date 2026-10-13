import { describe, expect, it } from "vitest";
import { nginxProcessState } from "./node-appearance";

describe("nginxProcessState", () => {
  it("shows a stopped nginx of an online Ingress node on its Overview (R-3)", () => {
    expect(
      nginxProcessState({
        type: "nginx",
        status: "online",
        liveHealthReport: { nginxRunning: false },
      })
    ).toBe("stopped");
    expect(
      nginxProcessState({
        type: "nginx",
        status: "online",
        liveHealthReport: null,
        lastHealthReport: { nginxRunning: true },
      })
    ).toBe("running");
  });

  it("says nothing without a report, for an offline node or another node type", () => {
    expect(nginxProcessState({ type: "nginx", status: "online" })).toBeNull();
    expect(
      nginxProcessState({
        type: "nginx",
        status: "offline",
        lastHealthReport: { nginxRunning: false },
      })
    ).toBeNull();
    expect(
      nginxProcessState({
        type: "docker",
        status: "online",
        liveHealthReport: { nginxRunning: false },
      })
    ).toBeNull();
  });
});
