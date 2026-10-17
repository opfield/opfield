/**
 * The dashboard with its attention notices showing: the license in its grace
 * period, the relay recovering and managed TLS certificates that do not renew.
 */
import { http } from "msw";
import type { DashboardManagedCertificate, DashboardRelaySnapshot, UIBootstrapShell } from "@/types";
import { wrapped } from "../../handlers";
import { databases, storages } from "../catalog";
import { dashboardBootstrap } from "../dashboard";
import { uiBootstrap } from "../shell";
import { ago, ahead } from "../time";

const recoveringRelay: DashboardRelaySnapshot = {
  state: "recovering",
  impact: "database_connections",
  attempt: 2,
  maxAttempts: 3,
  lastHealthyAt: ago(4, "m"),
  reason: "health_probe_failed",
  lastProbeAt: ago(15, "s"),
  attemptHistory: [
    { attempt: 1, startedAt: ago(3, "m"), action: "restart", result: "failed" },
    { attempt: 2, startedAt: ago(40, "s"), action: "compose_up", result: "running" },
  ],
  relayBuildVersion: "2.11.0",
  protocolMajor: 3,
  expectedService: "relay",
  expectedImage: "registry.example.com/opfield/relay:2.11.0",
  canRetry: false,
};

const managedCertificates: DashboardManagedCertificate[] = [
  {
    kind: "database",
    id: databases[2].id,
    slug: databases[2].slug,
    name: databases[2].name,
    reason: "renewal_failed",
    daysRemaining: 6,
    notAfter: ahead(6, "d"),
  },
  {
    kind: "storage",
    id: storages[1].id,
    slug: storages[1].slug,
    name: storages[1].name,
    reason: "waiting_for_daemon",
    daysRemaining: 11,
    notAfter: ahead(11, "d"),
  },
];

const graceLicense: UIBootstrapShell["license"] = {
  ...uiBootstrap.license,
  status: "expired_grace",
  expiresAt: ago(2, "d"),
  graceUntil: ahead(12, "d"),
};

export const dashboardNoticeHandlers = [
  http.get("*/api/ui/bootstrap", () => wrapped({ ...uiBootstrap, license: graceLicense })),
  http.post("*/api/monitoring/dashboard/bootstrap", async ({ request }) =>
    wrapped({
      ...dashboardBootstrap(
        ((await request.json().catch(() => null)) ?? {}) as Parameters<typeof dashboardBootstrap>[0]
      ),
      relay: recoveringRelay,
      managedCertificates,
    })
  ),
];
