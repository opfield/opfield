import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WitnessHostingToggle } from "@/components/relays/WitnessHostingToggle";
import { useAuthStore } from "@/stores/auth";
import type {
  AvailabilityMember,
  AvailabilityPreflightResult,
  AvailabilityView,
  DashboardRelayInstance,
  Node,
  User,
} from "@/types";
import { AvailabilityCreateSection, EMPTY_AVAILABILITY_DRAFT } from "./AvailabilityCreateSection";
import { AvailabilityPanel } from "./AvailabilityPanel";
import { MakePrimaryDialog } from "./MakePrimaryDialog";

const api = vi.hoisted(() => ({
  getAvailability: vi.fn(),
  listAvailabilityEvents: vi.fn(),
  getRelayStatus: vi.fn(),
  listNodes: vi.fn(),
  makeAvailabilityPrimary: vi.fn(),
  updateAuthProvisioningSettings: vi.fn(),
  setRelayWitnessHosting: vi.fn(),
}));

const nodes = vi.hoisted(
  () =>
    [
      { id: "node-a", displayName: "db-1", hostname: "db-1", status: "online", isConnected: true },
      { id: "node-b", displayName: "db-2", hostname: "db-2", status: "online", isConnected: true },
    ] as Node[]
);

vi.mock("@/services/api", () => ({ api }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/lib/managed-database-nodes", () => ({
  listManagedDatabaseCandidateNodes: async () => nodes,
  isManagedStorageCandidateNode: () => true,
}));

function member(overrides: Partial<AvailabilityMember>): AvailabilityMember {
  return {
    id: "member-a",
    nodeId: "node-a",
    nodeName: "db-1",
    priority: 50,
    role: "primary",
    eligible: true,
    eligibilityReason: null,
    lagBytes: null,
    lagSeconds: null,
    syncState: "none",
    status: "ready",
    desiredState: "member",
    publishedPort: 5432,
    lastError: null,
    lastReportedAt: "2026-10-11T10:00:00Z",
    reporting: true,
    ...overrides,
  };
}

function view(overrides: Partial<AvailabilityView> = {}): AvailabilityView {
  return {
    setId: "set-1",
    mode: "automatic",
    state: "healthy",
    stateReason: null,
    durability: "synchronous",
    durabilitySource: "auto",
    lossWindowText: "Synchronous: an automatic failover loses no acknowledged commit.",
    maxLagBytes: 1048576,
    syncDegradeAfterSeconds: 10,
    priorityMode: false,
    failbackDelaySeconds: 300,
    rttP50Ms: 2.4,
    rttMeasuredAt: "2026-10-11T10:00:00Z",
    primaryMemberId: "member-a",
    primarySince: "2026-10-11T09:00:00Z",
    primaryGeneration: 0,
    members: [
      member({}),
      member({
        id: "member-b",
        nodeId: "node-b",
        nodeName: "db-2",
        role: "copy",
        lagBytes: 0,
        lagSeconds: 0,
        syncState: "sync",
      }),
    ],
    voters: ["node-a", "node-b", "relay-1"],
    witnesses: [
      {
        id: "witness-1",
        purpose: "lease",
        hostKind: "relay",
        relayInstanceId: "relay-1",
        nodeId: null,
        role: "active",
        status: "ready",
      },
    ],
    missingForAutomatic: null,
    canLose: 1,
    lease: null,
    policyLeaseHours: 168,
    operation: null,
    connection: null,
    ...overrides,
  };
}

function preflight(
  overrides: Partial<AvailabilityPreflightResult> = {}
): AvailabilityPreflightResult {
  return {
    mode: "automatic",
    voters: ["node-a", "node-b", "relay-1"],
    witnesses: [{ kind: "relay", id: "relay-1", name: "edge-ams-1" }],
    rttP50Ms: 3,
    defaultDurability: "synchronous",
    durability: "synchronous",
    lossWindowText: "Synchronous: an automatic failover loses no acknowledged commit.",
    restartNeeded: false,
    policyLeaseHours: 168,
    missingForAutomatic: null,
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function signIn(scopes: string[]) {
  useAuthStore.setState({ user: { id: "user-1", scopes } as User, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getRelayStatus.mockResolvedValue(null);
  api.listNodes.mockResolvedValue({ data: [] });
  api.listAvailabilityEvents.mockResolvedValue([]);
  signIn(["databases:edit", "settings:gateway:edit"]);
});

function renderSection(result: AvailabilityPreflightResult) {
  const runPreflight = vi.fn().mockResolvedValue(result);
  render(
    <AvailabilityCreateSection
      engine="postgres"
      originNodeId="node-a"
      nodes={nodes}
      value={{ ...EMPTY_AVAILABILITY_DRAFT, memberNodeIds: ["node-b"] }}
      onChange={() => undefined}
      runPreflight={runPreflight}
    />
  );
  return runPreflight;
}

describe("create form availability section", () => {
  it("shows the voters, the near round trip and the loss window of an automatic pair", async () => {
    const runPreflight = renderSection(preflight());
    expect(await screen.findByText("Near servers · 3.0 ms round trip")).toBeInTheDocument();
    expect(runPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ nodeIds: ["node-a", "node-b"] })
    );
    expect(screen.getByText(/Voters: db-1, db-2, edge-ams-1/)).toBeInTheDocument();
    expect(screen.getByText(/loses no acknowledged commit/)).toBeInTheDocument();
    expect(screen.queryByText("Manual failover")).not.toBeInTheDocument();
  });

  it("explains manual failover when no witness host exists", async () => {
    renderSection(
      preflight({
        mode: "manual",
        voters: [],
        witnesses: [],
        missingForAutomatic:
          "Automatic failover needs a third host for a witness: an allowed relay or a docker node on another host.",
      })
    );
    expect(await screen.findByText("Manual failover")).toBeInTheDocument();
    expect(screen.getByText(/needs a third host for a witness/)).toBeInTheDocument();
  });

  it("lists blockers", async () => {
    renderSection(
      preflight({
        blockers: [{ code: "SAME_HOST", message: "Nodes db-1 and db-2 run on the same host" }],
      })
    );
    expect(await screen.findByText("These servers cannot be used yet")).toBeInTheDocument();
    expect(screen.getByText("Nodes db-1 and db-2 run on the same host")).toBeInTheDocument();
  });

  it("offers to set the relay policy lease to 7 days when it is shorter", async () => {
    api.updateAuthProvisioningSettings.mockResolvedValue({});
    renderSection(preflight({ policyLeaseHours: 72 }));
    expect(await screen.findByText("Failover works without Opfield for 72 h")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Set to 7 days/ }));
    expect(api.updateAuthProvisioningSettings).toHaveBeenCalledWith({
      generalSettings: { relayPolicyLeaseHours: 168 },
    });
  });
});

describe("availability panel", () => {
  const owner = { kind: "database", id: "db-1" } as const;

  it("offers Make available… on a single server, in the header and the empty state", async () => {
    api.getAvailability.mockResolvedValue(null);
    render(
      <AvailabilityPanel
        owner={owner}
        engine="postgres"
        resourceName="orders-db"
        originNodeId="node-a"
        canManage
      />
    );
    expect(await screen.findByText("This database runs on one server.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Make available…/ })).toHaveLength(2);
  });

  it("shows a healthy pair with its servers and what it can lose", async () => {
    api.getAvailability.mockResolvedValue(view());
    render(
      <AvailabilityPanel
        owner={owner}
        engine="postgres"
        resourceName="orders-db"
        originNodeId="node-a"
        canManage
      />
    );
    expect(await screen.findByText("2 servers · automatic failover")).toBeInTheDocument();
    expect(screen.getByText("1 server")).toBeInTheDocument();
    expect(screen.getAllByText("db-2").length).toBeGreaterThan(0);
    expect(screen.getByText("Can take over")).toBeInTheDocument();
  });

  it("says when a degraded set has no automatic failover", async () => {
    api.getAvailability.mockResolvedValue(
      view({
        state: "no_failover",
        canLose: 0,
        stateReason: { message: "The copy is 40 MB behind" },
      })
    );
    render(
      <AvailabilityPanel
        owner={owner}
        engine="postgres"
        resourceName="orders-db"
        originNodeId="node-a"
        canManage
      />
    );
    expect(await screen.findByText("No automatic failover right now")).toBeInTheDocument();
    expect(screen.getByText("The copy is 40 MB behind")).toBeInTheDocument();
  });

  it("shows what a manual pair is missing", async () => {
    api.getAvailability.mockResolvedValue(
      view({
        mode: "manual",
        canLose: null,
        witnesses: [],
        missingForAutomatic:
          "Automatic failover needs a third host for a witness: an allowed relay or a docker node on another host.",
      })
    );
    render(
      <AvailabilityPanel
        owner={owner}
        engine="postgres"
        resourceName="orders-db"
        originNodeId="node-a"
        canManage
      />
    );
    expect(await screen.findByText("Manual failover")).toBeInTheDocument();
    expect(screen.getByText(/needs a third host for a witness/)).toBeInTheDocument();
  });
});

describe("make this copy primary", () => {
  it("asks to type the name before a promotion that may lose writes", async () => {
    api.makeAvailabilityPrimary.mockResolvedValue({});
    const lost = view({
      members: [
        member({ reporting: false, lastReportedAt: "2026-10-11T09:59:00Z" }),
        member({
          id: "member-b",
          nodeId: "node-b",
          nodeName: "db-2",
          role: "copy",
          eligible: false,
          eligibilityReason: "lagging",
          lagBytes: 3 * 1024 * 1024,
        }),
      ],
    });
    const onDone = vi.fn();
    render(
      <MakePrimaryDialog
        owner={{ kind: "database", id: "db-1" }}
        view={lost}
        member={lost.members[1]!}
        resourceName="orders-db"
        onClose={() => undefined}
        onDone={onDone}
      />
    );
    expect(await screen.findByText("Writes may be lost")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Promote and accept loss" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type orders-db to confirm"), "orders-db");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() =>
      expect(api.makeAvailabilityPrimary).toHaveBeenCalledWith(
        { kind: "database", id: "db-1" },
        "member-b",
        true
      )
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("switches a healthy pair without asking for the name", async () => {
    api.makeAvailabilityPrimary.mockResolvedValue({});
    const healthy = view();
    render(
      <MakePrimaryDialog
        owner={{ kind: "database", id: "db-1" }}
        view={healthy}
        member={healthy.members[1]!}
        resourceName="orders-db"
        onClose={() => undefined}
        onDone={() => undefined}
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Make primary" }));
    await waitFor(() =>
      expect(api.makeAvailabilityPrimary).toHaveBeenCalledWith(
        { kind: "database", id: "db-1" },
        "member-b",
        false
      )
    );
  });
});

describe("relay witness hosting", () => {
  it("tells the owner of a protected relay how to opt in", () => {
    const relay = {
      id: "relay-1",
      displayName: "partner-relay",
      witnessHosting: "protected_needs_opt_in",
      witnessHostingAllowed: true,
    } as DashboardRelayInstance;
    render(<WitnessHostingToggle instance={relay} canEdit onChanged={() => undefined} />);
    expect(screen.getByText("Protected relay: needs local opt-in")).toBeInTheDocument();
    expect(
      screen.getByText("relay-supervisor protected on --allow-database-witness")
    ).toBeInTheDocument();
  });
});
