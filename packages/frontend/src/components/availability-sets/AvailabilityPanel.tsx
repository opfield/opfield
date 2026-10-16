import { Loader2, MoreHorizontal, Plus, ServerCog, ShieldCheck, Users } from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/common/ConfirmDialog";
import { CopyValueField } from "@/components/common/CopyValueField";
import { DetailRow } from "@/components/common/DetailRow";
import { EmptyState } from "@/components/common/EmptyState";
import { Notice } from "@/components/common/Notice";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { movePriorityNode } from "@/components/docker/availability/availability-priority";
import { LicensePlanBadge } from "@/components/license/LicensePlanBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRealtime } from "@/hooks/use-realtime";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
import {
  isManagedStorageCandidateNode,
  listManagedDatabaseCandidateNodes,
} from "@/lib/managed-database-nodes";
import { formatDateTime } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  usePlanIncludes,
} from "@/stores/license-paywall";
import type {
  AvailabilityEvent,
  AvailabilityFailure,
  AvailabilityMember,
  AvailabilityOwner,
  AvailabilityView,
  Node,
} from "@/types";
import { AddMemberDialog } from "./AddMemberDialog";
import type { AvailabilityEngine } from "./AvailabilityCreateSection";
import { AvailabilityEvents } from "./AvailabilityEvents";
import { AvailabilitySettingsDialog } from "./AvailabilitySettingsDialog";
import {
  AVAILABILITY_CAPABILITY,
  AVAILABILITY_FEATURE,
  activeMembers,
  canLoseText,
  DURABILITY_LABELS,
  formatRtt,
  memberName,
  operationLabel,
  ownerNoun,
  primaryOf,
  SET_STATE_LABELS,
  setStateVariant,
  setSummary,
} from "./availability-labels";
import { ConvertDialog } from "./ConvertDialog";
import { DisableAvailabilityDialog } from "./DisableAvailabilityDialog";
import { MakePrimaryDialog } from "./MakePrimaryDialog";
import { MembersTable } from "./MembersTable";
import { PolicyLeaseNotice } from "./PolicyLeaseNotice";

const POLL_MS = 10_000;
const LICENSE_CODES = new Set([
  "LICENSE_ENTITLEMENT_REQUIRED",
  "LICENSE_QUOTA_EXCEEDED",
  "COMMERCIAL_MODULE_UNAVAILABLE",
]);

interface WitnessNames {
  relays: Map<string, string>;
  nodes: Map<string, string>;
}

function stateNotice(view: AvailabilityView) {
  const reason = view.stateReason?.message ?? view.lease?.reason ?? null;
  if (view.stateReason?.code === "paused") {
    return (
      <Notice tone="info" title="Paused">
        Every server is stopped. The primary keeps its role, so nothing fails over; starting again
        starts the primary first, then the copies.
      </Notice>
    );
  }
  if (view.state === "degraded") {
    return (
      <Notice tone="warning" title="Degraded">
        {reason ?? "A copy is not keeping up. Writes continue on the primary."}
      </Notice>
    );
  }
  if (view.state === "no_failover") {
    return (
      <Notice tone="warning" title="No automatic failover right now">
        {reason ?? "No copy can take over without losing writes until it catches up."}
      </Notice>
    );
  }
  if (view.state === "failing_over") {
    return (
      <Notice tone="info" icon={Loader2} title="A copy is taking over">
        {reason ?? "Clients reconnect to the new primary once it serves."}
      </Notice>
    );
  }
  if (view.state === "error") {
    return (
      <Notice tone="destructive" title="Availability needs attention">
        {reason ?? "The last operation failed. Check the events below."}
      </Notice>
    );
  }
  return null;
}

/**
 * Availability of a managed database or managed storage: one server with "Make available…",
 * or the set with its servers, witnesses, durability, events and actions (make a copy primary,
 * add or remove a server, rebuild a copy, settings, turn off).
 */
export function AvailabilityPanel({
  owner,
  engine,
  resourceName,
  originNodeId,
  canManage,
  onChanged,
}: {
  owner: AvailabilityOwner;
  engine: AvailabilityEngine;
  resourceName: string;
  /** The resource's current node (the primary of a set, the only server otherwise). */
  originNodeId: string;
  canManage: boolean;
  /** The set changed (the primary may have moved): the page reloads the resource. */
  onChanged?: () => void;
}) {
  const [view, setView] = useState<AvailabilityView | null | undefined>(undefined);
  const [failure, setFailure] = useState<AvailabilityFailure | null>(null);
  const [events, setEvents] = useState<AvailabilityEvent[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [witnessNames, setWitnessNames] = useState<WitnessNames>({
    relays: new Map(),
    nodes: new Map(),
  });
  const [convertOpen, setConvertOpen] = useState(false);
  // Turning availability on, adding servers and changing settings need the plan feature; an
  // existing set keeps its remaining actions (primary switch, rebuild, remove, turn off).
  const planIncludesAvailability = usePlanIncludes(AVAILABILITY_FEATURE);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [promote, setPromote] = useState<AvailabilityMember | null>(null);
  const ownerKind = owner.kind;
  const ownerId = owner.id;
  const stableOwner = useMemo<AvailabilityOwner>(
    () => ({ kind: ownerKind, id: ownerId }) as AvailabilityOwner,
    [ownerKind, ownerId]
  );
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const primaryRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { view: next, failure: lastFailure } = await api.getAvailabilityState(stableOwner);
      setView(next);
      setFailure(next ? null : lastFailure);
      if (next) {
        setEvents(await api.listAvailabilityEvents(stableOwner, { limit: 20 }).catch(() => []));
        if (primaryRef.current !== null && primaryRef.current !== next.primaryMemberId) {
          onChangedRef.current?.();
        }
        primaryRef.current = next.primaryMemberId;
      } else {
        setEvents([]);
      }
    } catch (error) {
      setView(null);
      if (!(error instanceof ApiRequestError && error.code && LICENSE_CODES.has(error.code))) {
        toastApiError(error, "Failed to load availability");
      }
    }
  }, [stableOwner]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useRealtime("availability.set.changed", (payload) => {
    const event = payload as { ownerId?: unknown } | null;
    if (!event || event.ownerId === undefined || event.ownerId === ownerId) void load();
  });

  // Storage nodes for new servers, and names of relay and docker witnesses.
  useEffect(() => {
    let cancelled = false;
    void listManagedDatabaseCandidateNodes()
      .then((list) => {
        if (cancelled) return;
        setNodes(
          list.filter(
            (node) =>
              node.status === "online" &&
              node.isConnected &&
              (ownerKind === "database" || isManagedStorageCandidateNode(node))
          )
        );
      })
      .catch(() => undefined);
    void Promise.all([
      api.getRelayStatus().catch(() => null),
      api.listNodes({ type: "docker", limit: 100 }).catch(() => null),
    ]).then(([relays, dockerNodes]) => {
      if (cancelled) return;
      setWitnessNames({
        relays: new Map((relays?.instances ?? []).map((relay) => [relay.id, relay.displayName])),
        nodes: new Map(
          (dockerNodes?.data ?? []).map((node) => [node.id, node.displayName || node.hostname])
        ),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ownerKind]);

  const refresh = useCallback(() => {
    void load();
    onChangedRef.current?.();
  }, [load]);

  // The dialogs stay mounted across the switch between one server and an availability set (a
  // convert or a disable that just finished), so the one that did it closes with its animation.
  const shownView = useRetainedDialogValue(view ?? null, Boolean(view));
  useContentLoading(view === undefined);
  if (view === undefined) return null;

  const openConvert = () => {
    if (!requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)) return;
    setConvertOpen(true);
  };

  const title = (badges: ReactNode) => (
    <span className="inline-flex flex-wrap items-center gap-2" aria-label="Availability">
      <span>Availability</span>
      {badges}
      <LicensePlanBadge feature={AVAILABILITY_FEATURE} />
    </span>
  );

  const canConvert = canManage && planIncludesAvailability;
  // One keyed set of dialogs in the same root element for both states, so React keeps it mounted.
  const dialogs = (
    <Fragment key="availability-dialogs">
      {canConvert ? (
        <ConvertDialog
          open={convertOpen}
          onOpenChange={setConvertOpen}
          owner={stableOwner}
          engine={engine}
          originNodeId={originNodeId}
          nodes={nodes}
          onDone={refresh}
        />
      ) : null}
      {canManage && shownView ? (
        <>
          <MakePrimaryDialog
            owner={stableOwner}
            view={shownView}
            member={promote}
            resourceName={resourceName}
            onClose={() => setPromote(null)}
            onDone={refresh}
          />
          <AddMemberDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            owner={stableOwner}
            view={shownView}
            nodes={nodes}
            onDone={refresh}
          />
          <AvailabilitySettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            owner={stableOwner}
            engine={engine}
            view={shownView}
            onDone={refresh}
          />
          <DisableAvailabilityDialog
            open={disableOpen}
            onOpenChange={setDisableOpen}
            owner={stableOwner}
            view={shownView}
            resourceName={resourceName}
            onDone={refresh}
          />
        </>
      ) : null}
    </Fragment>
  );

  if (view === null) {
    return (
      <div className="space-y-4">
        <PanelShell
          title={title(null)}
          icon={<ShieldCheck className="h-4 w-4" />}
          description={
            planIncludesAvailability
              ? "Runs on one server. Add servers to keep a copy and fail over."
              : "Runs on one server."
          }
          actions={
            canConvert ? (
              <Button onClick={openConvert}>
                <Plus />
                Make available…
              </Button>
            ) : null
          }
        >
          {failure ? (
            <Notice
              tone="warning"
              title={
                failure.operation === "create"
                  ? "Could not be set up on several servers"
                  : "Availability could not be turned on"
              }
            >
              <span className="break-words">
                {failure.reason}. It was kept on this server with availability off (
                {formatDateTime(failure.at)}). Fix the cause, then make it available again.
              </span>
            </Notice>
          ) : null}
          <EmptyState
            embedded
            message={`This ${ownerNoun(owner)} runs on one server.`}
            actionLabel={canConvert ? "Make available…" : undefined}
            onAction={canConvert ? openConvert : undefined}
          />
        </PanelShell>
        {dialogs}
      </div>
    );
  }

  const primary = primaryOf(view);
  const busy = view.operation !== null || view.state === "converting" || view.state === "closing";
  // A disable that waits for a member to hold the primary role: turning off again with a server to keep replaces it.
  const waitingForPrimary =
    view.operation?.kind === "disable" &&
    view.operation.step === "choose" &&
    !!view.lease &&
    !view.lease.holderNodeId;
  const members = activeMembers(view);
  const witnessName = (witness: AvailabilityView["witnesses"][number]) =>
    (witness.relayInstanceId && witnessNames.relays.get(witness.relayInstanceId)) ||
    (witness.nodeId && witnessNames.nodes.get(witness.nodeId)) ||
    `${witness.hostKind === "relay" ? "Relay" : "Node"} ${(witness.relayInstanceId ?? witness.nodeId ?? witness.id).slice(0, 8)}`;
  const leaseWitnesses = view.witnesses.filter((witness) => witness.purpose === "lease");
  const keeperWitnesses = view.witnesses.filter((witness) => witness.purpose === "keeper");

  const rebuild = (member: AvailabilityMember) =>
    void confirmAction(
      {
        title: `Rebuild Copy on ${memberName(member)}?`,
        description:
          "Its data is copied again from the primary. It cannot take over until the copy is done.",
        confirmLabel: "Rebuild copy",
        variant: "default",
      },
      async () => {
        try {
          await api.rebuildAvailabilityMember(stableOwner, member.id);
          toast.success("Rebuilding the copy");
          refresh();
        } catch (error) {
          if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
            toastApiError(error, "Failed to rebuild the copy");
          }
          throw error;
        }
      }
    );

  const remove = (member: AvailabilityMember) =>
    void confirmAction(
      {
        title: `Remove ${memberName(member)}?`,
        description:
          members.length <= 2
            ? "A set keeps at least two servers. Turn availability off instead."
            : "The copy on this server is removed with its data. Witnesses are picked again.",
        confirmLabel: "Remove server",
      },
      async () => {
        try {
          await api.removeAvailabilityMember(stableOwner, member.id);
          toast.success("Removing the server");
          refresh();
        } catch (error) {
          if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
            toastApiError(error, "Failed to remove the server");
          }
          throw error;
        }
      }
    );

  // The failover order is saved at once (no form): every server once, the preferred one first.
  const canReorder = canManage && planIncludesAvailability && !view.changesBlocked;
  const move = async (member: AvailabilityMember, delta: -1 | 1) => {
    const order = members.map((candidate) => candidate.id);
    const next = movePriorityNode(order, order.indexOf(member.id), delta);
    if (next === order) return;
    try {
      await api.reorderAvailabilityMembers(stableOwner, next);
      toast.success("Failover order saved");
      refresh();
    } catch (error) {
      if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
        toastApiError(error, "Failed to change the failover order");
      }
    }
  };

  const openAdd = () => {
    if (!requireLicenseFeature(AVAILABILITY_FEATURE, AVAILABILITY_CAPABILITY)) return;
    setAddOpen(true);
  };

  const hosts = view.connection?.hosts ?? [];

  return (
    <div className="space-y-4">
      {view.operation ? (
        <Notice tone="info" icon={Loader2} title={`${operationLabel(view.operation.kind)}…`}>
          {view.operation.lastError ? (
            view.operation.lastError
          ) : (
            <>
              Started <RelativeTime value={view.operation.startedAt} />. The other actions wait
              until it finishes.
            </>
          )}
        </Notice>
      ) : null}
      {stateNotice(view)}
      {view.changesBlocked ? (
        <Notice tone="warning" title="Changes need a license">
          {view.changesBlocked}
        </Notice>
      ) : null}
      {view.mode === "manual" ? (
        <Notice tone="info" title="Manual failover">
          {view.missingForAutomatic ??
            "Automatic failover needs a third host for a witness: an allowed relay or a docker node on another host."}{" "}
          When the primary is lost, make the copy primary from the servers below.
        </Notice>
      ) : null}
      <PolicyLeaseNotice hours={view.policyLeaseHours} />

      <PanelShell
        title={title(
          <Badge size="inline" variant={setStateVariant(view.state)}>
            {SET_STATE_LABELS[view.state] ?? view.state}
          </Badge>
        )}
        icon={<ShieldCheck className="h-4 w-4" />}
        description={setSummary(view)}
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              {planIncludesAvailability && (
                <Button
                  variant="outline"
                  disabled={busy || !!view.changesBlocked}
                  title={view.changesBlocked ?? undefined}
                  onClick={openAdd}
                >
                  <Plus />
                  Add server
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="More availability actions"
                    title="More"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {planIncludesAvailability && (
                    <DropdownMenuItem
                      disabled={busy || !!view.changesBlocked}
                      onClick={() => setSettingsOpen(true)}
                    >
                      <ServerCog />
                      Settings
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive"
                    disabled={
                      view.state === "closing" && view.operation !== null && !waitingForPrimary
                    }
                    onClick={() => setDisableOpen(true)}
                  >
                    <ShieldCheck />
                    Turn off availability
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
        bodyClassName="-mb-px grid grid-cols-1 xl:grid-cols-2 [&>*]:border-b [&>*]:border-border xl:[&>*:nth-child(even)]:border-l"
      >
        <DetailRow
          label="Primary"
          value={
            primary ? (
              <span className="inline-flex items-center gap-2">
                {memberName(primary)}
                {view.primarySince ? (
                  <span className="text-xs text-muted-foreground">
                    since <RelativeTime value={view.primarySince} />
                  </span>
                ) : null}
              </span>
            ) : (
              "None"
            )
          }
        />
        <DetailRow label="Failover" value={view.mode === "automatic" ? "Automatic" : "Manual"} />
        <DetailRow label="Durability" value={DURABILITY_LABELS[view.durability]} />
        <DetailRow label="Can lose" value={canLoseText(view)} />
        <DetailRow label="Round trip" value={formatRtt(view.rttP50Ms)} />
        <DetailRow
          label="Witnesses"
          value={
            leaseWitnesses.length === 0
              ? "None"
              : leaseWitnesses
                  .map((witness) =>
                    witness.status === "unreachable"
                      ? `${witnessName(witness)} (unreachable)`
                      : witnessName(witness)
                  )
                  .join(", ")
          }
        />
      </PanelShell>
      {view.lossWindowText ? (
        <p className="text-xs text-muted-foreground">{view.lossWindowText}</p>
      ) : null}

      <PanelShell
        title="Servers"
        icon={<Users className="h-4 w-4" />}
        description={
          view.priorityMode
            ? "The primary takes writes; ready copies take over in this order, and the primary moves back to the first server."
            : "The primary takes writes; ready copies take over in this order."
        }
      >
        <MembersTable
          view={view}
          canManage={canManage}
          busy={busy}
          actions={{
            onMakePrimary: setPromote,
            onRebuild: rebuild,
            onRemove: remove,
            onMove: canReorder ? (member, delta) => void move(member, delta) : undefined,
          }}
        />
      </PanelShell>

      {keeperWitnesses.length > 0 ? (
        <PanelShell
          title="Keeper witnesses"
          description="ClickHouse Keeper voters outside the servers; they hold no data."
          bodyClassName="divide-y divide-border"
        >
          {keeperWitnesses.map((witness) => (
            <DetailRow
              key={witness.id}
              label={witness.role === "standby" ? "Standby" : "Active"}
              value={
                <span className="inline-flex items-center gap-2">
                  {witnessName(witness)}
                  <Badge
                    size="inline"
                    variant={
                      witness.status === "ready"
                        ? "success"
                        : witness.status === "error"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {witness.status === "waiting_quorum" ? "waiting for quorum" : witness.status}
                  </Badge>
                </span>
              }
            />
          ))}
        </PanelShell>
      ) : null}

      {hosts.length > 0 ? (
        <PanelShell
          title="Direct connection"
          description={
            view.connection?.multiHostUri
              ? "Clients try each server and keep the one that takes writes."
              : "A copy refuses connections: use a link, or a client that tries each."
          }
          bodyClassName="space-y-3 p-4"
        >
          {view.connection?.multiHostUri ? (
            <CopyValueField label="Connection string" value={view.connection.multiHostUri} />
          ) : null}
          {hosts.map((host) => {
            const member = view.members.find((candidate) => candidate.id === host.memberId);
            return (
              <CopyValueField
                key={host.memberId}
                label={member ? memberName(member) : host.memberId.slice(0, 8)}
                value={`${host.host.includes(":") ? `[${host.host}]` : host.host}:${host.port}`}
              />
            );
          })}
        </PanelShell>
      ) : null}

      <AvailabilityEvents events={events} />

      {dialogs}
    </div>
  );
}
