import { describe, expect, it, vi } from "vitest";
import type { AppOverviewContainers, AppOverviewEnvironment } from "@/types";
import { healthyCard, restartsCard } from "./OverviewTab";

vi.mock("@/services/api", () => ({ api: {} }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));

const containers = (extra: Partial<AppOverviewContainers>): AppOverviewContainers => ({
  total: 2,
  healthy: 2,
  checkedHealthy: 0,
  noHealthCheck: 2,
  cpuPercent: 0,
  cpuHistory: [],
  memoryBytes: 0,
  memoryLimitBytes: null,
  memoryHistory: [],
  restarts: null,
  restartsSince: null,
  restartsHistory: [],
  healthyHistory: [],
  unhealthy: [],
  ...extra,
});

const view = (extra: Partial<AppOverviewContainers>) => ({
  env: { name: "production" },
  data: { containers: containers(extra) } as AppOverviewEnvironment,
});

describe("app overview restarts card", () => {
  it("shows no data until a reading exists", () => {
    expect(restartsCard([containers({})])).toEqual({
      count: null,
      value: "—",
      subtitle: "No data yet",
    });
  });

  it("shows 0 since the first sample while the hour is not covered", () => {
    const since = new Date(2026, 9, 12, 9, 5).toISOString();
    expect(restartsCard([containers({ restarts: 0, restartsSince: since })])).toEqual({
      count: 0,
      value: "0",
      subtitle: "since 09:05",
    });
  });

  it("says last hour once an environment's samples cover it", () => {
    const since = new Date(2026, 9, 12, 9, 5).toISOString();
    expect(
      restartsCard([
        containers({ restarts: 1, restartsSince: since }),
        containers({ restarts: 2, restartsSince: null }),
      ])
    ).toMatchObject({ value: "3", subtitle: "last hour" });
  });
});

describe("app overview healthy card", () => {
  it("shows no health checks when no container has one", () => {
    expect(healthyCard([view({})])).toEqual({ value: "—", subtitle: "No health checks" });
  });

  it("counts containers with a health check and the rest apart", () => {
    expect(
      healthyCard([view({ total: 2, healthy: 2, checkedHealthy: 1, noHealthCheck: 1 })])
    ).toMatchObject({ value: "1/1", subtitle: "1 without a health check" });
  });

  it("names unhealthy containers first", () => {
    expect(
      healthyCard([
        view({
          total: 2,
          healthy: 1,
          checkedHealthy: 1,
          noHealthCheck: 0,
          unhealthy: ["shop-api"],
        }),
      ])
    ).toMatchObject({ value: "1/2", subtitle: "shop-api in production is not healthy" });
  });

  it("says every container is healthy when all have a passing check", () => {
    expect(
      healthyCard([view({ total: 2, healthy: 2, checkedHealthy: 2, noHealthCheck: 0 })])
    ).toMatchObject({ value: "2/2", subtitle: "Every container is healthy" });
  });
});
