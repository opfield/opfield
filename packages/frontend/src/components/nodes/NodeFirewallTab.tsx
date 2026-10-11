import { Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { accessContextKey, useAuthStore } from "@/stores/auth";
import {
  HOSTING_PROVIDER_LABELS,
  type HostingFirewallConfig,
  type HostingFirewallDirection,
  type HostingFirewallRule,
  type HostingFirewallView,
} from "@/types/hosting";

export interface NodeFirewallTabProps {
  nodeId: string;
  connectorId: string;
  resourceId: string;
  provider: "digitalocean" | "cloudblast" | "proxmox";
  mutationLocked?: boolean;
}

import { NodeFirewallRuleDialog, type NodeFirewallRuleDialogState } from "./NodeFirewallRuleDialog";
import { NodeFirewallRulesPanel } from "./NodeFirewallRulesPanel";

function cloneConfig(config: HostingFirewallConfig): HostingFirewallConfig {
  return {
    ...config,
    rules: config.rules.map((rule) => ({ ...rule, addresses: [...rule.addresses] })),
  };
}

function configsEqual(left: HostingFirewallConfig, right: HostingFirewallConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const STATUS_PRESENTATION = {
  loading: { label: "Loading", variant: "secondary" },
  pending: { label: "Pending", variant: "warning" },
  applying: { label: "Applying", variant: "warning" },
  ready: { label: "Ready", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
} as const;

export function NodeFirewallTab({
  nodeId,
  connectorId,
  resourceId,
  provider,
  mutationLocked = false,
}: NodeFirewallTabProps) {
  const authKey = useAuthStore(accessContextKey);
  const [view, setView] = useState<HostingFirewallView | null>(null);
  const [draft, setDraftState] = useState<HostingFirewallConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ruleDialog, setRuleDialog] = useState<NodeFirewallRuleDialogState | null>(null);
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const viewRef = useRef<HostingFirewallView | null>(null);
  const draftRef = useRef<HostingFirewallConfig | null>(null);
  const draftBaseRevisionRef = useRef<number | null>(null);
  const draftBaseFingerprintRef = useRef<string | null>(null);
  const notificationRef = useRef("");
  const rulesLockedRef = useRef(true);
  useContentLoading(!view && loading);

  const applySnapshot = useCallback((next: HostingFirewallView) => {
    const previous = viewRef.current;
    if (previous && next.revision < previous.revision) {
      if (next.status === "loading") setLoadError("Waiting for the current firewall snapshot.");
      return;
    }
    const previousDraft = draftRef.current;
    const dirty = Boolean(
      previous && previousDraft && !configsEqual(previousDraft, previous.config)
    );
    const resourceChanged = previous?.resourceId !== next.resourceId;

    viewRef.current = next;
    setView(next);
    setLoadError(null);

    if (!previousDraft || resourceChanged || !dirty) {
      const nextDraft = cloneConfig(next.config);
      draftRef.current = nextDraft;
      draftBaseRevisionRef.current = next.revision;
      draftBaseFingerprintRef.current = next.observation?.fingerprint ?? null;
      setDraftState(nextDraft);
      return;
    }
  }, []);

  const isCurrentRequest = useCallback((generation: number, requestAuthKey: string) => {
    return (
      generationRef.current === generation &&
      accessContextKey(useAuthStore.getState()) === requestAuthKey
    );
  }, []);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    const requestAuthKey = authKey;
    setLoading(true);
    void api
      .getNodeFirewall(nodeId)
      .then((next) => {
        if (!isCurrentRequest(generation, requestAuthKey)) return;
        if (next.resourceId !== resourceId) {
          setLoadError(
            "The hosted resource changed. Reopen this node before editing its firewall."
          );
          return;
        }
        applySnapshot(next);
      })
      .catch((error) => {
        if (!isCurrentRequest(generation, requestAuthKey)) return;
        setLoadError(error instanceof Error ? error.message : "Could not load firewall settings.");
      })
      .finally(() => {
        if (isCurrentRequest(generation, requestAuthKey)) setLoading(false);
      });
  }, [applySnapshot, authKey, isCurrentRequest, nodeId, resourceId]);

  useEffect(() => {
    lifecycleRef.current += 1;
    generationRef.current += 1;
    viewRef.current = null;
    draftRef.current = null;
    draftBaseRevisionRef.current = null;
    setView(null);
    setDraftState(null);
    setLoadError(null);
    setSaveError(null);
    setSaving(false);
    setRuleDialog(null);
    notificationRef.current = "";
    void load();
    return () => {
      lifecycleRef.current += 1;
      generationRef.current += 1;
    };
  }, [load]);

  useRealtime(
    "integration.connector.changed",
    (payload) => {
      const event = payload as { id?: string; connectorId?: string };
      if ((event.id ?? event.connectorId) !== connectorId) return;
      load();
    },
    { onReconnect: load }
  );

  const hasLocalChanges = Boolean(draft && view && !configsEqual(draft, view.config));
  const stale = Boolean(
    hasLocalChanges &&
      view &&
      draftBaseRevisionRef.current !== null &&
      (draftBaseRevisionRef.current !== view.revision ||
        draftBaseFingerprintRef.current !== view.observation?.fingerprint)
  );
  const blockers =
    (draft?.enabled
      ? view?.observation?.blockers
      : (view?.observation?.disableBlockers ?? view?.observation?.blockers)) ?? [];
  const editingLocked = Boolean(
    mutationLocked ||
      saving ||
      !!loadError ||
      view?.status === "loading" ||
      !view?.canEdit ||
      view?.status === "pending" ||
      view?.status === "applying" ||
      view?.observation?.applying
  );
  const saveDisabled = Boolean(
    !draft ||
      !view ||
      (!hasLocalChanges && view.status !== "failed") ||
      editingLocked ||
      stale ||
      blockers.length > 0 ||
      !view.observation?.fingerprint
  );
  const rulesLocked =
    editingLocked || stale || !view?.observation?.fingerprint || !!view.observation.blockers.length;
  rulesLockedRef.current = rulesLocked;
  const toggleLocked =
    editingLocked ||
    stale ||
    !view?.observation?.fingerprint ||
    (draft?.enabled
      ? (view.observation.disableBlockers ?? view.observation.blockers).length > 0
      : view.observation.blockers.length > 0);
  const displayedStatus = view?.status ?? (loading ? "loading" : "failed");
  const providerNotice = blockers.length
    ? `Applying is blocked: ${blockers.join(" ")}`
    : view?.observation?.blockers.length
      ? `Enabling constraints: ${view.observation.blockers.join(" ")}`
      : null;
  const providerLabel = HOSTING_PROVIDER_LABELS[provider];
  const notification =
    loadError ||
    saveError ||
    view?.error ||
    providerNotice ||
    (stale
      ? `Remote revision ${view?.revision} changed while you were editing. Discard this draft and reload before saving.`
      : "");
  useEffect(() => {
    if (notification && notification !== notificationRef.current) {
      toast.error(notification, { id: `firewall:${nodeId}` });
    }
    notificationRef.current = notification;
  }, [notification, nodeId]);

  const updateDraft = useCallback(
    (update: (current: HostingFirewallConfig) => HostingFirewallConfig) => {
      const current = draftRef.current;
      if (!current || editingLocked) return;
      const next = update(current);
      draftRef.current = next;
      setDraftState(next);
      setSaveError(null);
    },
    [editingLocked]
  );

  const openAddRule = (direction: HostingFirewallDirection) => {
    if (!rulesLockedRef.current) setRuleDialog({ direction, rule: null });
  };
  const openEditRule = (rule: HostingFirewallRule) => {
    if (!rulesLockedRef.current) setRuleDialog({ direction: rule.direction, rule });
  };
  const saveRule = (rule: HostingFirewallRule) => {
    if (rulesLockedRef.current) return;
    updateDraft((current) => ({
      ...current,
      rules: current.rules.some((r) => r.id === rule.id)
        ? current.rules.map((r) => (r.id === rule.id ? rule : r))
        : [...current.rules, rule],
    }));
    setRuleDialog(null);
  };

  const deleteRule = async (rule: HostingFirewallRule) => {
    if (rulesLockedRef.current) return;
    const lifecycle = lifecycleRef.current;
    if (
      !(await confirm({
        title: "Remove Firewall Rule",
        description: `Remove the ${rule.direction === "in" ? "inbound" : "outbound"} ${rule.action} rule from this unsaved draft? The provider is unchanged until you save the firewall configuration.`,
        confirmLabel: "Remove rule",
        variant: "destructive",
      }))
    )
      return;
    if (rulesLockedRef.current || lifecycle !== lifecycleRef.current) return;
    updateDraft((current) => ({
      ...current,
      rules: current.rules.filter((candidate) => candidate.id !== rule.id),
    }));
  };

  const saveFirewall = async () => {
    if (saveDisabled || !draft || !view || !view.observation?.fingerprint) return;
    setSaveError(null);
    const lifecycle = lifecycleRef.current;
    const requestAuthKey = authKey;
    const currentMutation = () =>
      lifecycleRef.current === lifecycle &&
      accessContextKey(useAuthStore.getState()) === requestAuthKey;
    setSaving(true);
    try {
      if (draft.enabled) {
        const approved = await confirm({
          title: "Confirm Firewall Change",
          description:
            "These rules may block new connections, including the node’s connection to Opfield. An existing connection staying open does not prove that new connections will work.",
          confirmLabel: "Apply firewall changes",
          variant: "default",
        });
        if (!approved) return;
      }

      if (!currentMutation()) return;
      if (
        !viewRef.current?.canEdit ||
        (draft.enabled
          ? viewRef.current.observation?.blockers
          : (viewRef.current.observation?.disableBlockers ?? viewRef.current.observation?.blockers)
        )?.length ||
        viewRef.current.revision !== view.revision ||
        viewRef.current.observation?.fingerprint !== view.observation.fingerprint
      ) {
        setSaveError("Firewall changed while awaiting confirmation. Review the current state.");
        return;
      }
      const expectedRevision = view.revision;
      const expectedFingerprint = view.observation.fingerprint;
      generationRef.current += 1; // Invalidate reads started before this mutation.
      const next = await api.updateNodeFirewall(nodeId, {
        config: cloneConfig(draft),
        expectedRevision,
        expectedFingerprint,
        acknowledgeConnectivityRisk: draft.enabled,
      });
      if (!currentMutation()) return;
      if (next.resourceId !== resourceId) {
        setSaveError("The hosted resource changed. Reopen this node before saving its firewall.");
        return;
      }
      // Realtime may already have delivered Ready (or a later revision) while PUT was in flight.
      // Only advance the accepted revision here; GET owns the current state within a revision.
      if (!viewRef.current || viewRef.current.revision < next.revision) applySnapshot(next);
      toast.success("Firewall changes submitted");
      load(); // Also invalidates any pre-acceptance GET still in flight.
    } catch (error) {
      if (!currentMutation()) return;
      setSaveError(error instanceof Error ? error.message : "Could not save firewall settings.");
    } finally {
      if (currentMutation()) setSaving(false);
    }
  };

  const discardAndReload = () => {
    if (!view) return;
    const nextDraft = cloneConfig(view.config);
    draftRef.current = nextDraft;
    draftBaseRevisionRef.current = view.revision;
    draftBaseFingerprintRef.current = view.observation?.fingerprint ?? null;
    setDraftState(nextDraft);
    setSaveError(null);
  };

  return (
    <div className="space-y-4">
      <PanelShell
        title={
          <>
            Firewall{" "}
            <Badge variant={STATUS_PRESENTATION[displayedStatus].variant} size="inline">
              {STATUS_PRESENTATION[displayedStatus].label}
            </Badge>
          </>
        }
        icon={<ShieldCheck className="h-4 w-4" />}
        description={`${providerLabel} VM firewall. Deny rules take priority over Allow, regardless of their order.`}
        dirty={hasLocalChanges}
        wrapHeader
        actions={
          <>
            {stale && (
              <Button variant="outline" onClick={discardAndReload}>
                Discard draft and reload
              </Button>
            )}
            <Button
              type="button"
              aria-label="Save firewall"
              pending={saving}
              disabled={saveDisabled}
              onClick={() => void saveFirewall()}
            >
              <Save />
              Save
            </Button>
          </>
        }
      >
        {!view && !loading && !loadError ? (
          <EmptyState message="No firewall snapshot is available for this VM yet." embedded />
        ) : null}
        {view && draft ? (
          <>
            <SettingsControlRow
              title="Firewall enabled"
              description="Disabled until you enable it. Rules are kept when the firewall is disabled."
            >
              <Switch
                checked={draft.enabled}
                onChange={(enabled) => updateDraft((current) => ({ ...current, enabled }))}
                disabled={toggleLocked}
                ariaLabel="Enable firewall"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Default inbound policy"
              description="Traffic without a matching TCP, UDP, or ICMP inbound rule uses this policy."
            >
              <Select
                value={draft.inboundPolicy}
                onValueChange={(inboundPolicy) =>
                  updateDraft((current) => ({
                    ...current,
                    inboundPolicy: inboundPolicy as HostingFirewallConfig["inboundPolicy"],
                  }))
                }
                disabled={rulesLocked}
              >
                <SelectTrigger aria-label="Default inbound policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="Default outbound policy"
              description="Traffic without a matching TCP, UDP, or ICMP outbound rule uses this policy."
            >
              <Select
                value={draft.outboundPolicy}
                onValueChange={(outboundPolicy) =>
                  updateDraft((current) => ({
                    ...current,
                    outboundPolicy: outboundPolicy as HostingFirewallConfig["outboundPolicy"],
                  }))
                }
                disabled={rulesLocked}
              >
                <SelectTrigger aria-label="Default outbound policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </>
        ) : null}
      </PanelShell>

      {view && draft
        ? (["in", "out"] as const).map((direction) => (
            <NodeFirewallRulesPanel
              key={direction}
              direction={direction}
              rules={draft.rules.filter((r) => r.direction === direction)}
              editingLocked={rulesLocked}
              onAdd={openAddRule}
              onEdit={openEditRule}
              onDelete={(rule) => void deleteRule(rule)}
            />
          ))
        : null}
      <NodeFirewallRuleDialog
        dialog={ruleDialog}
        disabled={rulesLocked}
        onClose={() => setRuleDialog(null)}
        onSave={saveRule}
      />
    </div>
  );
}
