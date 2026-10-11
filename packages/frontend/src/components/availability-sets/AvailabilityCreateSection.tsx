import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckboxCard } from "@/components/common/CheckboxCard";
import { Notice } from "@/components/common/Notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type {
  AvailabilityDurability,
  AvailabilityEnableInput,
  AvailabilityPreflightInput,
  AvailabilityPreflightResult,
  AvailabilityWitnessPick,
  Node,
} from "@/types";
import { AVAILABILITY_CAPABILITY, DURABILITY_LABELS } from "./availability-labels";
import { DurabilityNotice } from "./DurabilityNotice";
import { PolicyLeaseNotice } from "./PolicyLeaseNotice";
import { WitnessPicker, type WitnessPickerValue, witnessChoiceOf } from "./WitnessPicker";

const PREFLIGHT_DEBOUNCE_MS = 400;

/** Engines whose copies replicate only one way (the durability choice is hidden). */
export type AvailabilityEngine = "postgres" | "redis" | "clickhouse" | "seaweedfs";

export function fixedDurabilityOf(engine: AvailabilityEngine): AvailabilityDurability | null {
  if (engine === "seaweedfs") return "synchronous";
  if (engine === "redis") return "asynchronous";
  return null;
}

export interface AvailabilityDraft {
  /** Servers besides the resource's own node. */
  memberNodeIds: string[];
  witness: WitnessPickerValue;
  /** null: the default for these servers (near → synchronous, far → asynchronous). */
  durability: AvailabilityDurability | null;
}

export const EMPTY_AVAILABILITY_DRAFT: AvailabilityDraft = {
  memberNodeIds: [],
  witness: "auto",
  durability: null,
};

export function availabilityInputOf(
  originNodeId: string,
  draft: AvailabilityDraft,
  engine: AvailabilityEngine
): AvailabilityEnableInput {
  const witness = witnessChoiceOf(draft.witness);
  const fixed = fixedDurabilityOf(engine);
  const durability = fixed ?? draft.durability;
  return {
    nodeIds: [originNodeId, ...draft.memberNodeIds.filter((id) => id !== originNodeId)],
    ...(witness ? { witness } : {}),
    // Storage replicates synchronously only and its routes take no durability.
    ...(durability && engine !== "seaweedfs" ? { durability } : {}),
  };
}

export interface AvailabilityPreflightState {
  result: AvailabilityPreflightResult | null;
  pending: boolean;
}

/** Warnings the section shows in their own notices instead of the generic list. */
function isSpecialWarning(warning: string): boolean {
  return (
    warning.startsWith("Without a witness") ||
    warning.startsWith("Failover works without Gateway") ||
    warning.startsWith("The members are far apart")
  );
}

/**
 * Servers, witness and durability of a database or storage on several servers, with a live
 * preflight: the round trip and the durability it suggests, what a failover can lose, and what
 * blocks the set. Used by the create forms (step "Availability") and "Make available…".
 */
export function AvailabilityCreateSection({
  engine,
  originNodeId,
  nodes,
  value,
  onChange,
  runPreflight,
  onPreflight,
  restartNoun,
  disabled,
}: {
  engine: AvailabilityEngine;
  /** The resource's own node (the first member, the primary to start with). */
  originNodeId: string;
  /** Storage nodes that may hold a member. */
  nodes: Node[];
  value: AvailabilityDraft;
  onChange: (value: AvailabilityDraft) => void;
  /** Memoize it: a new function runs the preflight again (the create form passes type and version). */
  runPreflight: (input: AvailabilityPreflightInput) => Promise<AvailabilityPreflightResult>;
  onPreflight?: (state: AvailabilityPreflightState) => void;
  /** Converting an existing resource: what restarts once ("database"). */
  restartNoun?: string;
  disabled?: boolean;
}) {
  const [relayCandidates, setRelayCandidates] = useState<AvailabilityWitnessPick[]>([]);
  const [nodeCandidates, setNodeCandidates] = useState<AvailabilityWitnessPick[]>([]);
  const [result, setResult] = useState<AvailabilityPreflightResult | null>(null);
  const [pending, setPending] = useState(false);
  const onPreflightRef = useRef(onPreflight);
  onPreflightRef.current = onPreflight;

  const fixed = fixedDurabilityOf(engine);
  const memberIds = useMemo(
    () => [originNodeId, ...value.memberNodeIds.filter((id) => id !== originNodeId)],
    [originNodeId, value.memberNodeIds]
  );
  const input = useMemo(
    () => availabilityInputOf(originNodeId, value, engine),
    [engine, originNodeId, value]
  );
  const inputKey = JSON.stringify(input);

  // Explicit witness choices: allowed relays (admins see them) and online docker nodes.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getRelayStatus().catch(() => null),
      api.listNodes({ type: "docker", limit: 100 }).catch(() => null),
    ]).then(([relays, dockerNodes]) => {
      if (cancelled) return;
      setRelayCandidates(
        (relays?.instances ?? [])
          .filter((relay) => relay.witnessHosting === "allowed" && relay.state === "ready")
          .map((relay) => ({ kind: "relay" as const, id: relay.id, name: relay.displayName }))
      );
      setNodeCandidates(
        (dockerNodes?.data ?? [])
          .filter((node) => node.status === "online")
          .map((node) => ({
            kind: "node" as const,
            id: node.id,
            name: node.displayName || node.hostname,
          }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const request = JSON.parse(inputKey) as AvailabilityPreflightInput;
    if (request.nodeIds.length < 2) {
      setResult(null);
      setPending(false);
      onPreflightRef.current?.({ result: null, pending: false });
      return;
    }
    let cancelled = false;
    setPending(true);
    onPreflightRef.current?.({ result: null, pending: true });
    const timer = window.setTimeout(() => {
      runPreflight(request)
        .then((next) => {
          if (cancelled) return;
          setResult(next);
          onPreflightRef.current?.({ result: next, pending: false });
        })
        .catch((error) => {
          if (cancelled) return;
          setResult(null);
          onPreflightRef.current?.({ result: null, pending: false });
          if (!handleLicenseApiError(error, AVAILABILITY_CAPABILITY)) {
            toast.error(error instanceof Error ? error.message : "Availability check failed");
          }
        })
        .finally(() => {
          if (!cancelled) setPending(false);
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inputKey, runPreflight]);

  const witnessCandidates = useMemo(() => {
    const listed = result?.candidates ?? [...relayCandidates, ...nodeCandidates];
    return listed.filter((candidate) => !memberIds.includes(candidate.id));
  }, [memberIds, nodeCandidates, relayCandidates, result?.candidates]);

  const nameOf = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node) return node.displayName || node.hostname;
    const witness = [...(result?.witnesses ?? []), ...relayCandidates, ...nodeCandidates].find(
      (candidate) => candidate.id === id
    );
    return witness?.name ?? id.slice(0, 8);
  };

  const durability = fixed ?? value.durability ?? result?.defaultDurability ?? "synchronous";
  const warnings = (result?.warnings ?? []).filter((warning) => !isSpecialWarning(warning));

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Servers</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {nodes.map((node) => {
            const origin = node.id === originNodeId;
            const checked = origin || value.memberNodeIds.includes(node.id);
            return (
              <CheckboxCard
                key={node.id}
                checked={checked}
                disabled={disabled || origin}
                label={node.displayName || node.hostname}
                description={origin ? "Primary to start with" : checked ? "Copy" : undefined}
                onCheckedChange={(next) =>
                  onChange({
                    ...value,
                    memberNodeIds: next
                      ? [...value.memberNodeIds, node.id]
                      : value.memberNodeIds.filter((id) => id !== node.id),
                  })
                }
              />
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {memberIds.length < 2
            ? "Pick at least one more server for the copy. Each server must run on its own host."
            : `${memberIds.length} servers: one primary and ${memberIds.length - 1} ${memberIds.length === 2 ? "copy" : "copies"}. Each server must run on its own host.`}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="availability-witness">
          Witness
        </label>
        <WitnessPicker
          id="availability-witness"
          value={value.witness}
          onChange={(witness) => onChange({ ...value, witness })}
          candidates={witnessCandidates}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          {result && result.voters.length > 0
            ? `Voters: ${result.voters.map(nameOf).join(", ")}. A witness votes on the primary and holds no data.`
            : "A witness votes on the primary and holds no data."}
        </p>
      </div>

      {fixed ? null : (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="availability-durability">
            Durability
          </label>
          <Select
            value={durability}
            onValueChange={(next) =>
              onChange({ ...value, durability: next as AvailabilityDurability })
            }
            disabled={disabled}
          >
            <SelectTrigger id="availability-durability">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="synchronous" description="A commit returns after the copy has it.">
                {DURABILITY_LABELS.synchronous}
                {result?.defaultDurability === "synchronous" ? " (default)" : ""}
              </SelectItem>
              <SelectItem value="asynchronous" description="A commit returns at once.">
                {DURABILITY_LABELS.asynchronous}
                {result?.defaultDurability === "asynchronous" ? " (default)" : ""}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {memberIds.length >= 2 && pending && !result ? (
        <p className="text-xs text-muted-foreground">Checking these servers…</p>
      ) : null}

      {result ? (
        <div className="space-y-3">
          <DurabilityNotice
            durability={durability}
            rttP50Ms={result.rttP50Ms}
            lossWindowText={result.lossWindowText}
            defaultDurability={fixed ? undefined : result.defaultDurability}
            unit={engine === "seaweedfs" ? "write" : "commit"}
          />
          {result.blockers.length > 0 ? (
            <Notice tone="destructive" title="These servers cannot be used yet">
              <ul className="space-y-0.5">
                {result.blockers.map((blocker) => (
                  <li key={`${blocker.code}:${blocker.message}`}>{blocker.message}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {result.mode === "manual" ? (
            <Notice tone="info" title="Manual failover">
              {result.missingForAutomatic ??
                "Automatic failover needs a third host for a witness: an allowed relay or a docker node on another host."}{" "}
              Until then, make the copy primary by hand when the primary is lost.
            </Notice>
          ) : null}
          <PolicyLeaseNotice hours={result.policyLeaseHours} />
          {restartNoun && result.restartNeeded ? (
            <Notice tone="warning" title={`The ${restartNoun} restarts once`}>
              Clients reconnect after the restart while the copy is set up.
            </Notice>
          ) : null}
          {warnings.length > 0 ? (
            <Notice tone="warning" title="Check before you continue">
              <ul className="space-y-0.5">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
