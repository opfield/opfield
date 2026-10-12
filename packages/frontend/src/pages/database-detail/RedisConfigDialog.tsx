import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import {
  type DatabaseConnection,
  DEFAULT_MANAGED_REDIS_CONFIG,
  type ManagedRedisConfig,
  type ManagedRedisEvictionPolicy,
} from "@/types";

type NumericRedisField = {
  [Key in keyof ManagedRedisConfig]: ManagedRedisConfig[Key] extends number ? Key : never;
}[keyof ManagedRedisConfig];

type RedisConfigDraft = Omit<ManagedRedisConfig, NumericRedisField> &
  Record<NumericRedisField, string>;

const EVICTION_POLICIES: Array<{
  value: ManagedRedisEvictionPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "noeviction",
    label: "No eviction",
    description: "Reject writes when the memory limit is reached.",
  },
  {
    value: "allkeys-lru",
    label: "All keys — LRU",
    description: "Evict the least recently used key from the full dataset.",
  },
  {
    value: "allkeys-lfu",
    label: "All keys — LFU",
    description: "Evict the least frequently used key from the full dataset.",
  },
  {
    value: "allkeys-random",
    label: "All keys — random",
    description: "Evict a random key from the full dataset.",
  },
  {
    value: "volatile-lru",
    label: "Expiring keys — LRU",
    description: "Evict the least recently used key that has a TTL.",
  },
  {
    value: "volatile-lfu",
    label: "Expiring keys — LFU",
    description: "Evict the least frequently used key that has a TTL.",
  },
  {
    value: "volatile-random",
    label: "Expiring keys — random",
    description: "Evict a random key that has a TTL.",
  },
  {
    value: "volatile-ttl",
    label: "Expiring keys — shortest TTL",
    description: "Evict the key closest to expiry.",
  },
];

const NUMBER_LIMITS: Record<NumericRedisField, [number, number]> = {
  maxmemoryPercent: [10, 95],
  rdbSaveSeconds: [1, 31_536_000],
  rdbSaveChanges: [1, 1_000_000_000],
  autoAofRewritePercentage: [0, 10_000],
  autoAofRewriteMinSizeMb: [1, 1_048_576],
  maxclients: [1, 1_000_000],
  timeoutSeconds: [0, 31_536_000],
  tcpKeepaliveSeconds: [0, 31_536_000],
  slowlogThresholdMicroseconds: [-1, 2_147_483_647],
  slowlogMaxLen: [0, 1_000_000],
};

function toDraft(config: ManagedRedisConfig): RedisConfigDraft {
  return {
    ...config,
    maxmemoryPercent: String(config.maxmemoryPercent),
    rdbSaveSeconds: String(config.rdbSaveSeconds),
    rdbSaveChanges: String(config.rdbSaveChanges),
    autoAofRewritePercentage: String(config.autoAofRewritePercentage),
    autoAofRewriteMinSizeMb: String(config.autoAofRewriteMinSizeMb),
    maxclients: String(config.maxclients),
    timeoutSeconds: String(config.timeoutSeconds),
    tcpKeepaliveSeconds: String(config.tcpKeepaliveSeconds),
    slowlogThresholdMicroseconds: String(config.slowlogThresholdMicroseconds),
    slowlogMaxLen: String(config.slowlogMaxLen),
  };
}

function normalizeDraft(draft: RedisConfigDraft): ManagedRedisConfig | null {
  const numeric = {} as Record<NumericRedisField, number>;
  for (const [field, limits] of Object.entries(NUMBER_LIMITS) as Array<
    [NumericRedisField, [number, number]]
  >) {
    const raw = draft[field].trim();
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value) || value < limits[0] || value > limits[1])
      return null;
    numeric[field] = value;
  }
  return { ...draft, ...numeric };
}

function NumberInput({
  draft,
  field,
  setDraft,
  label,
}: {
  draft: RedisConfigDraft;
  field: NumericRedisField;
  setDraft: Dispatch<SetStateAction<RedisConfigDraft>>;
  label: string;
}) {
  const [min, max] = NUMBER_LIMITS[field];
  const value = draft[field];
  const parsed = Number(value);
  const invalid = value.trim() === "" || !Number.isInteger(parsed) || parsed < min || parsed > max;
  return (
    <Input
      aria-label={label}
      aria-invalid={invalid}
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
    />
  );
}

export function RedisConfigDialog({
  database,
  open,
  onOpenChange,
  onSaved,
}: {
  database: DatabaseConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const managed = database.managed!;
  const savedConfig = managed.redisConfig ?? DEFAULT_MANAGED_REDIS_CONFIG;
  const [draft, setDraft] = useState<RedisConfigDraft>(() => toDraft(savedConfig));
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) setDraft(toDraft(savedConfig));
  }, [open, savedConfig]);

  const normalized = useMemo(() => normalizeDraft(draft), [draft]);
  const changed = normalized !== null && JSON.stringify(normalized) !== JSON.stringify(savedConfig);

  const save = async () => {
    if (!normalized || !changed || saving || confirming) return;
    setConfirming(true);
    const confirmed = await confirm({
      title: "Save & Recreate",
      description:
        "Applying the key-value store configuration recreates the database container and temporarily takes it offline. It usually takes about 10 seconds; managed storage is retained. Continue?",
      confirmLabel: "Recreate",
      variant: "default",
    });
    setConfirming(false);
    if (!confirmed) return;

    setSaving(true);
    try {
      await api.updateManagedDatabase(managed.id, { redisConfig: normalized });
      toast.success("Key-value store configuration updated — container recreated");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toastApiError(error, "Failed to update key-value store configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure key-value store</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pr-1">
          <PanelShell
            title="Memory"
            description="Control the dataset budget and eviction behavior."
          >
            <SettingsControlRow
              title="Dataset memory limit"
              description="Percentage of the container memory limit available to data. The remainder is reserved for server overhead."
            >
              <div className="flex w-full items-center gap-2">
                <NumberInput
                  draft={draft}
                  field="maxmemoryPercent"
                  setDraft={setDraft}
                  label="Dataset memory limit percentage"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title="Eviction policy"
              description="Choose what the key-value store does when the dataset reaches its memory limit."
            >
              <Select
                value={draft.maxmemoryPolicy}
                onValueChange={(value: ManagedRedisEvictionPolicy) =>
                  setDraft((current) => ({ ...current, maxmemoryPolicy: value }))
                }
              >
                <SelectTrigger aria-label="Eviction policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  align="end"
                  className="w-[var(--radix-select-trigger-width)]"
                  overlayScrollControls
                >
                  {EVICTION_POLICIES.map((policy) => (
                    <SelectItem
                      key={policy.value}
                      value={policy.value}
                      description={policy.description}
                    >
                      {policy.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsControlRow>
          </PanelShell>

          <PanelShell
            title="Persistence"
            description="Configure append-only durability, snapshots, and AOF compaction."
          >
            <SettingsControlRow
              title="Append-only file"
              description="Persist every write to an append-only log."
            >
              <Switch
                checked={draft.appendOnly}
                onChange={(appendOnly) => setDraft((current) => ({ ...current, appendOnly }))}
                ariaLabel="Append-only file"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="AOF fsync"
              description="Every second is the recommended balance of durability and throughput."
            >
              <Select
                value={draft.appendFsync}
                onValueChange={(appendFsync: ManagedRedisConfig["appendFsync"]) =>
                  setDraft((current) => ({ ...current, appendFsync }))
                }
                disabled={!draft.appendOnly}
              >
                <SelectTrigger aria-label="AOF fsync">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" className="w-[var(--radix-select-trigger-width)]">
                  <SelectItem
                    value="everysec"
                    description="Sync once per second; recommended durability and throughput balance."
                  >
                    Every second
                  </SelectItem>
                  <SelectItem
                    value="always"
                    description="Sync every write; strongest durability with lower throughput."
                  >
                    Every write
                  </SelectItem>
                  <SelectItem
                    value="no"
                    description="Let the operating system flush writes; fastest with less crash protection."
                  >
                    Operating system
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsControlRow>
            <SettingsControlRow
              title="AOF rewrite"
              description="Compact the append-only log after it grows by the threshold and reaches the minimum size."
              controlsClassName="sm:min-w-[24rem]"
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Growth (%)">
                  <NumberInput
                    draft={draft}
                    field="autoAofRewritePercentage"
                    setDraft={setDraft}
                    label="AOF rewrite growth percentage"
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Minimum size (MB)">
                  <NumberInput
                    draft={draft}
                    field="autoAofRewriteMinSizeMb"
                    setDraft={setDraft}
                    label="AOF rewrite minimum size"
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title="RDB snapshots"
              description="Periodically save a point-in-time dataset snapshot."
            >
              <Switch
                checked={draft.rdbSnapshotsEnabled}
                onChange={(rdbSnapshotsEnabled) =>
                  setDraft((current) => ({ ...current, rdbSnapshotsEnabled }))
                }
                ariaLabel="RDB snapshots"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Snapshot trigger"
              description="Create a snapshot after both the interval and minimum number of changes are reached."
              controlsClassName="sm:min-w-[24rem]"
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Interval (seconds)">
                  <NumberInput
                    draft={draft}
                    field="rdbSaveSeconds"
                    setDraft={setDraft}
                    label="Snapshot interval"
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Minimum changes">
                  <NumberInput
                    draft={draft}
                    field="rdbSaveChanges"
                    setDraft={setDraft}
                    label="Snapshot minimum changes"
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
          </PanelShell>

          <PanelShell
            title="Connections"
            description="Tune client capacity and inactive connection handling."
          >
            <SettingsControlRow
              title="Maximum clients"
              description="Maximum simultaneous client connections."
            >
              <NumberInput
                draft={draft}
                field="maxclients"
                setDraft={setDraft}
                label="Maximum clients"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="Idle timeout"
              description="Close inactive clients after this many seconds. Use 0 to disable."
            >
              <NumberInput
                draft={draft}
                field="timeoutSeconds"
                setDraft={setDraft}
                label="Idle timeout"
              />
            </SettingsControlRow>
            <SettingsControlRow
              title="TCP keepalive"
              description="Interval in seconds for keepalive probes. Use 0 to disable."
            >
              <NumberInput
                draft={draft}
                field="tcpKeepaliveSeconds"
                setDraft={setDraft}
                label="TCP keepalive"
              />
            </SettingsControlRow>
          </PanelShell>

          <PanelShell
            title="Diagnostics"
            description="Control slow-command logging and memory defragmentation."
          >
            <SettingsControlRow
              title="Slow log"
              description="Log commands slower than the threshold in microseconds. Use -1 to disable."
              controlsClassName="sm:min-w-[24rem]"
            >
              <div className="grid w-full grid-cols-2 gap-3">
                <SettingsInlineControl label="Threshold (µs)">
                  <NumberInput
                    draft={draft}
                    field="slowlogThresholdMicroseconds"
                    setDraft={setDraft}
                    label="Slow log threshold"
                  />
                </SettingsInlineControl>
                <SettingsInlineControl label="Maximum entries">
                  <NumberInput
                    draft={draft}
                    field="slowlogMaxLen"
                    setDraft={setDraft}
                    label="Slow log maximum entries"
                  />
                </SettingsInlineControl>
              </div>
            </SettingsControlRow>
            <SettingsControlRow
              title="Active defragmentation"
              description="Reclaim fragmented allocator memory in the background."
            >
              <Switch
                checked={draft.activeDefrag}
                onChange={(activeDefrag) => setDraft((current) => ({ ...current, activeDefrag }))}
                ariaLabel="Active defragmentation"
              />
            </SettingsControlRow>
          </PanelShell>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            pending={saving}
            disabled={!normalized || !changed || confirming}
          >
            {saving ? "Recreating database..." : "Save & Recreate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
