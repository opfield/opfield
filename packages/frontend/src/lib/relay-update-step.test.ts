import { describe, expect, it } from "vitest";
import type { DashboardRelayInstance } from "@/types";
import { activeRelayUpdateStep, relayStatusBadge } from "./relay-update-step";

const RESTART_ERROR =
  "rpc error: code = Unavailable desc = connection error: dial tcp 127.0.0.1:9443: connect: connection refused";

function relay(overrides: Partial<DashboardRelayInstance>): DashboardRelayInstance {
  return {
    id: "relay-nl",
    kind: "remote",
    nodeId: "node-nl",
    faultDomainId: "nl",
    displayName: "NL Relay",
    advertisedAddresses: ["203.0.113.10"],
    servicePort: 9443,
    state: "ready",
    buildVersion: "v2.12.1",
    protocolMajor: 1,
    appliedPolicyRevision: 1,
    policyExpiresAt: null,
    lastSeenAt: null,
    activeAssignments: 0,
    ...overrides,
  } as DashboardRelayInstance;
}

describe("relayStatusBadge", () => {
  it("shows the update step, not offline and the restart error, while the rollout updates the relay", () => {
    const restarting = relay({
      state: "offline",
      updateStep: { state: "updating", error: null },
      health: { lastError: RESTART_ERROR },
    });
    expect(relayStatusBadge(restarting, true)).toMatchObject({
      label: "updating · updating",
      variant: "warning",
      showLastError: false,
    });
    for (const step of ["draining", "verifying", "rolling_back"]) {
      expect(
        relayStatusBadge(relay({ state: "error", updateStep: { state: step, error: null } }), true)
          .label
      ).toBe(`updating · ${step}`);
    }
  });

  it("shows an offline relay as offline, with its error, when no rollout is active", () => {
    const offline = relay({
      state: "offline",
      updateStep: { state: "updating", error: null },
      health: { lastError: RESTART_ERROR },
    });
    expect(relayStatusBadge(offline, false)).toMatchObject({
      label: "offline",
      variant: "destructive",
      showLastError: true,
    });
  });

  it("shows the real state once the relay's own step finished or failed", () => {
    for (const step of ["pending", "ready", "completed", "failed", "rolled_back", "skipped"]) {
      const instance = relay({
        state: "offline",
        updateStep: { state: step, error: null },
        health: { lastError: RESTART_ERROR },
      });
      expect(activeRelayUpdateStep(instance, true)).toBeNull();
      expect(relayStatusBadge(instance, true)).toMatchObject({
        label: "offline",
        showLastError: true,
      });
    }
  });

  // Stand 2.12.6-rc.2, O-10: a planned port move showed the relay as offline.
  it("shows a running port change instead of offline, and a failed one as the real state", () => {
    const change = {
      servicePort: 9543,
      previousServicePort: 9443,
      error: null,
      at: "2026-10-18T18:47:50Z",
    };
    const restarting = relay({
      state: "offline",
      health: { lastError: RESTART_ERROR },
      portChange: { ...change, state: "moving" },
    });
    expect(relayStatusBadge(restarting, false)).toEqual({
      label: "changing port · restarting",
      variant: "warning",
      unreachable: false,
      showLastError: false,
    });
    expect(
      relayStatusBadge(
        relay({ state: "draining", portChange: { ...change, state: "draining" } }),
        false
      ).label
    ).toBe("changing port · draining");
    expect(
      relayStatusBadge(
        relay({
          state: "ready",
          portChange: { ...change, state: "failed", error: "bind: address already in use" },
        }),
        false
      ).label
    ).toBe("ready");
  });
});
