import { Archive, Play, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { RelativeTime } from "@/components/common/RelativeTime";
import { useContentLoading } from "@/components/common/reveal-gate";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useScrollToNavigationTarget } from "@/hooks/use-scroll-to-navigation-target";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import type { HousekeepingConfig, HousekeepingRunResult, HousekeepingStats } from "@/types";

interface HousekeepingSectionProps {
  canRun: boolean;
  canConfigure: boolean;
}

import { HousekeepingCard, normalizeHousekeepingConfig } from "./housekeeping-section-helpers";

export function HousekeepingSection({ canRun, canConfigure }: HousekeepingSectionProps) {
  const cachedConfig = api.getCached<HousekeepingConfig>("housekeeping:config");
  const cachedStats = api.getCached<HousekeepingStats>("housekeeping:stats");
  const [hkConfig, setHkConfig] = useState<HousekeepingConfig>(() =>
    cachedConfig
      ? normalizeHousekeepingConfig(cachedConfig)
      : {
          enabled: true,
          cronExpression: "0 2 * * *",
          nginxLogs: { enabled: true, retentionDays: 30 },
          auditLog: { enabled: true, retentionDays: 90 },
          dismissedAlerts: { enabled: true, retentionDays: 30 },
          deliveryLog: { enabled: true, retentionDays: 7 },
          structuredLogs: {
            enabled: true,
            maxRows: 100_000,
            maxSizeBytes: 10 * 1024 ** 3,
          },
          clickHouseInternals: { enabled: true, maxSizeBytes: 512 * 1024 ** 2 },
          orphanedAIArtifacts: { enabled: true },
          internalRegistry: { enabled: true, retentionSuccessfulArtifacts: 1 },
          orphanedVolumes: { enabled: true, retentionDays: 30 },
          dockerPrune: { enabled: true },
          orphanedCerts: { enabled: true },
          acmeCleanup: { enabled: true },
          operationHistory: { enabled: true, retentionDays: 90 },
          oauthCleanup: { enabled: true },
        }
  );
  const [hkSavedConfig, setHkSavedConfig] = useState<HousekeepingConfig | null>(() =>
    cachedConfig ? normalizeHousekeepingConfig(cachedConfig) : null
  );
  const [hkStats, setHkStats] = useState<HousekeepingStats | null>(cachedStats ?? null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    cachedConfig !== undefined && cachedStats !== undefined
  );
  const [hkRunning, setHkRunning] = useState(false);
  const [hkSaving, setHkSaving] = useState(false);
  const [hkHistoryOpen, setHkHistoryOpen] = useState(false);
  const [hkHistory, setHkHistory] = useState<HousekeepingRunResult[]>([]);
  const [hkHistoryLoading, setHkHistoryLoading] = useState(false);

  const loadHousekeeping = useCallback(async () => {
    try {
      await Promise.allSettled([
        api.getHousekeepingConfig().then((c) => {
          const config = normalizeHousekeepingConfig(c);
          api.setCache("housekeeping:config", config);
          setHkConfig(config);
          setHkSavedConfig(config);
        }),
        api.getHousekeepingStats().then((s) => {
          api.setCache("housekeeping:stats", s);
          setHkStats(s);
          setHkRunning(s.isRunning);
        }),
      ]);
    } finally {
      setInitialLoadComplete(true);
    }
  }, []);

  useEffect(() => {
    loadHousekeeping();
  }, [loadHousekeeping]);

  const navigationHighlighted = useScrollToNavigationTarget("housekeeping", initialLoadComplete, {
    block: "center",
    highlightDurationMs: 2200,
  });

  const hkHasChanges = hkSavedConfig
    ? JSON.stringify(hkConfig) !== JSON.stringify(hkSavedConfig)
    : false;

  const saveHkConfig = async () => {
    if (!canConfigure) return;
    setHkSaving(true);
    try {
      const updated = normalizeHousekeepingConfig(await api.updateHousekeepingConfig(hkConfig));
      api.setCache("housekeeping:config", updated);
      setHkConfig(updated);
      setHkSavedConfig(updated);
      toast.success("Housekeeping settings updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update config");
      loadHousekeeping();
    } finally {
      setHkSaving(false);
    }
  };

  const handleRunHousekeeping = async () => {
    if (!canRun) return;
    setHkRunning(true);
    try {
      const result = await api.runHousekeeping();
      if (result.overallSuccess) {
        toast.success(`Housekeeping completed in ${(result.totalDurationMs / 1000).toFixed(1)}s`);
      } else {
        toast.warning("Housekeeping completed with some errors");
      }
      api.invalidateCache("req:/api/housekeeping/stats");
      const freshStats = await api.getHousekeepingStats();
      api.setCache("housekeeping:stats", freshStats);
      setHkStats(freshStats);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Housekeeping failed");
    } finally {
      setHkRunning(false);
    }
  };

  const masterControlsDisabled = hkRunning || hkSaving || !canConfigure;
  const controlsDisabled = masterControlsDisabled || !hkConfig.enabled;
  const structuredLogsValid =
    !hkConfig.structuredLogs.enabled ||
    (Number.isInteger(hkConfig.structuredLogs.maxRows) &&
      hkConfig.structuredLogs.maxRows >= 1_000 &&
      Number.isInteger(hkConfig.structuredLogs.maxSizeBytes) &&
      hkConfig.structuredLogs.maxSizeBytes >= 1024 ** 2);
  const clickHouseInternalsValid =
    !hkConfig.clickHouseInternals.enabled ||
    (Number.isInteger(hkConfig.clickHouseInternals.maxSizeBytes) &&
      hkConfig.clickHouseInternals.maxSizeBytes >= 1024 ** 2);
  const internalRegistryRetentionValid =
    Number.isInteger(hkConfig.internalRegistry.retentionSuccessfulArtifacts) &&
    hkConfig.internalRegistry.retentionSuccessfulArtifacts >= 1 &&
    hkConfig.internalRegistry.retentionSuccessfulArtifacts <= 100;
  const historyColumns: SimpleTableColumn<HousekeepingRunResult>[] = [
    {
      id: "time",
      header: "Time",
      className: "w-[28%]",
      cellClassName: "text-muted-foreground whitespace-nowrap",
      render: (run) => <RelativeTime value={run.startedAt} />,
    },
    {
      id: "trigger",
      header: "Trigger",
      className: "w-[24%]",
      render: (run) => <Badge variant="secondary">{run.trigger}</Badge>,
    },
    {
      id: "duration",
      header: "Duration",
      className: "w-24",
      cellClassName: "text-muted-foreground whitespace-nowrap",
      render: (run) => `${(run.totalDurationMs / 1000).toFixed(1)}s`,
    },
    {
      id: "cleaned",
      header: "Cleaned",
      className: "w-28",
      cellClassName: "text-muted-foreground whitespace-nowrap",
      render: (run) =>
        `${run.categories.reduce((sum, category) => sum + category.itemsCleaned, 0)} items`,
    },
    {
      id: "status",
      header: "Status",
      align: "right",
      className: "w-20",
      render: (run) =>
        run.overallSuccess ? (
          <Badge variant="success">OK</Badge>
        ) : (
          <Badge variant="destructive">Errors</Badge>
        ),
    },
  ];

  const handleViewHistory = async () => {
    setHkHistoryLoading(true);
    try {
      const history = await api.getHousekeepingHistory();
      setHkHistory(history);
      setHkHistoryOpen(true);
    } catch {
      toast.error("Failed to load history");
    } finally {
      setHkHistoryLoading(false);
    }
  };

  useContentLoading(!initialLoadComplete);
  if (!initialLoadComplete) return null;

  return (
    <>
      <PanelShell
        icon={<Archive className="h-4 w-4" />}
        id="housekeeping"
        className={cn(navigationHighlighted && "navigation-target-ripple")}
        title="Housekeeping"
        description="Automated cleanup of logs, old data, and unused resources"
        actions={
          <Button
            onClick={saveHkConfig}
            pending={hkSaving}
            disabled={
              !hkHasChanges ||
              masterControlsDisabled ||
              !structuredLogsValid ||
              !clickHouseInternalsValid ||
              !internalRegistryRetentionValid
            }
          >
            <Save className="h-4 w-4" />
            Save
          </Button>
        }
        dirty={hkHasChanges}
      >
        <div className="border-b border-border">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enable scheduled automatic cleanup
              </p>
            </div>
            <Switch
              checked={hkConfig.enabled}
              onChange={(enabled) => setHkConfig((current) => ({ ...current, enabled }))}
              disabled={masterControlsDisabled}
            />
          </div>
        </div>
        <div>
          <div
            className={`p-4 space-y-3 transition-opacity duration-200 ${!hkConfig.enabled ? "opacity-50" : ""}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <p className="text-sm font-medium">
                  <SettingsHelpTitle
                    label="Schedule"
                    help="A cron expression defines when automatic cleanup runs. For example, 0 3 * * * runs every day at 03:00 in the Gateway host timezone."
                  />
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Cron expression for automatic cleanup runs
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  className="w-full sm:w-48"
                  value={hkConfig.cronExpression}
                  onChange={(e) => setHkConfig({ ...hkConfig, cronExpression: e.target.value })}
                  disabled={!hkConfig.enabled || controlsDisabled}
                />
                <Button
                  onClick={handleRunHousekeeping}
                  pending={hkRunning}
                  disabled={!hkConfig.enabled || !canRun || hkHasChanges}
                  title={
                    hkHasChanges ? "Save housekeeping settings before running cleanup" : undefined
                  }
                >
                  <Play className="h-4 w-4" />
                  Run Now
                </Button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            <HousekeepingCard
              label="Nginx Logs"
              description="Rotate, compress, and delete old logs"
              stat={hkStats ? formatBytes(hkStats.nginxLogs.totalSizeBytes) : "..."}
              statDetail={hkStats ? `${hkStats.nginxLogs.fileCount} files` : undefined}
              enabled={hkConfig.nginxLogs.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  nginxLogs: { ...current.nginxLogs, enabled: v },
                }))
              }
              retentionDays={hkConfig.nginxLogs.retentionDays}
              onRetentionChange={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  nginxLogs: { ...current.nginxLogs, retentionDays: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find((c) => c.category === "Nginx Logs")}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Structured Logs"
              description="Limit stored logs by rows and size"
              stat={hkStats ? formatBytes(hkStats.structuredLogs.totalSizeBytes) : "..."}
              statDetail={
                hkStats ? `${hkStats.structuredLogs.totalRows.toLocaleString()} rows` : "rows"
              }
              enabled={hkConfig.structuredLogs.enabled}
              onToggle={(enabled) =>
                setHkConfig((current) => ({
                  ...current,
                  structuredLogs: { ...current.structuredLogs, enabled },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (category) => category.category === "Structured Logs"
              )}
              disabled={controlsDisabled}
              inlineControls={
                <>
                  <span>&middot;</span>
                  <span>keep</span>
                  <input
                    type="number"
                    aria-label="Maximum structured log rows"
                    min={1000}
                    className="w-[4.25rem] border border-input bg-background px-1 text-center text-xs text-foreground tabular-nums outline-none focus:border-primary disabled:opacity-50"
                    value={hkConfig.structuredLogs.maxRows || ""}
                    disabled={!hkConfig.structuredLogs.enabled || controlsDisabled}
                    onChange={(event) =>
                      setHkConfig((current) => ({
                        ...current,
                        structuredLogs: {
                          ...current.structuredLogs,
                          maxRows: Number(event.target.value),
                        },
                      }))
                    }
                  />
                  <span>rows and</span>
                  <input
                    type="number"
                    aria-label="Maximum structured log size in GiB"
                    min={0.001}
                    step={0.25}
                    className="w-8 border border-input bg-background px-1 text-center text-xs text-foreground tabular-nums outline-none focus:border-primary disabled:opacity-50"
                    value={
                      hkConfig.structuredLogs.maxSizeBytes > 0
                        ? Number((hkConfig.structuredLogs.maxSizeBytes / 1024 ** 3).toFixed(3))
                        : ""
                    }
                    disabled={!hkConfig.structuredLogs.enabled || controlsDisabled}
                    onChange={(event) =>
                      setHkConfig((current) => ({
                        ...current,
                        structuredLogs: {
                          ...current.structuredLogs,
                          maxSizeBytes: Math.round(Number(event.target.value) * 1024 ** 3),
                        },
                      }))
                    }
                  />
                  <span>GiB</span>
                </>
              }
            />
            <HousekeepingCard
              label="ClickHouse Internals"
              description="Trim supported ClickHouse system logs at the configured size limit"
              stat={hkStats ? formatBytes(hkStats.clickHouseInternals.totalSizeBytes) : "..."}
              statDetail={
                hkStats?.clickHouseInternals.capBytes
                  ? `of ${formatBytes(hkStats.clickHouseInternals.capBytes)}`
                  : undefined
              }
              enabled={hkConfig.clickHouseInternals.enabled}
              onToggle={(enabled) =>
                setHkConfig((current) => ({
                  ...current,
                  clickHouseInternals: {
                    ...current.clickHouseInternals,
                    enabled,
                  },
                }))
              }
              disabled={controlsDisabled}
              inlineControls={
                <>
                  <span>&middot;</span>
                  <span>keep under</span>
                  <input
                    type="number"
                    aria-label="Maximum ClickHouse internal log size in MiB"
                    min={1}
                    step={64}
                    className="w-12 border border-input bg-background px-1 text-center text-xs text-foreground tabular-nums outline-none focus:border-primary disabled:opacity-50"
                    value={
                      hkConfig.clickHouseInternals.maxSizeBytes > 0
                        ? Math.round(hkConfig.clickHouseInternals.maxSizeBytes / 1024 ** 2)
                        : ""
                    }
                    disabled={!hkConfig.clickHouseInternals.enabled || controlsDisabled}
                    onChange={(event) =>
                      setHkConfig((current) => ({
                        ...current,
                        clickHouseInternals: {
                          ...current.clickHouseInternals,
                          maxSizeBytes: Math.round(Number(event.target.value) * 1024 ** 2),
                        },
                      }))
                    }
                  />
                  <span>MiB</span>
                </>
              }
            />
            <HousekeepingCard
              label="Audit Log"
              description="Delete old audit trail entries"
              stat={hkStats ? hkStats.auditLog.totalRows.toLocaleString() : "..."}
              statDetail="rows"
              enabled={hkConfig.auditLog.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  auditLog: { ...current.auditLog, enabled: v },
                }))
              }
              retentionDays={hkConfig.auditLog.retentionDays}
              onRetentionChange={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  auditLog: { ...current.auditLog, retentionDays: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find((c) => c.category === "Audit Log")}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Dismissed Alerts"
              description="Remove dismissed alerts"
              stat={hkStats ? String(hkStats.dismissedAlerts.count) : "..."}
              statDetail="entries"
              enabled={hkConfig.dismissedAlerts.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  dismissedAlerts: { ...current.dismissedAlerts, enabled: v },
                }))
              }
              retentionDays={hkConfig.dismissedAlerts.retentionDays}
              onRetentionChange={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  dismissedAlerts: {
                    ...current.dismissedAlerts,
                    retentionDays: v,
                  },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "Dismissed Alerts"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Delivery Log"
              description="Delete old notification delivery attempts"
              stat={hkStats ? hkStats.deliveryLog.total.toLocaleString() : "..."}
              statDetail={hkStats ? `entries · ${hkStats.deliveryLog.failed} failed` : "entries"}
              enabled={hkConfig.deliveryLog.enabled}
              onToggle={(enabled) =>
                setHkConfig((current) => ({
                  ...current,
                  deliveryLog: { ...current.deliveryLog, enabled },
                }))
              }
              retentionDays={hkConfig.deliveryLog.retentionDays}
              onRetentionChange={(retentionDays) =>
                setHkConfig((current) => ({
                  ...current,
                  deliveryLog: { ...current.deliveryLog, retentionDays },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (category) => category.category === "Delivery Log"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Orphaned AI Artifacts"
              description="Delete AI files no longer attached to a chat"
              stat={hkStats ? formatBytes(hkStats.orphanedAIArtifacts.totalSizeBytes) : "..."}
              statDetail={hkStats ? `${hkStats.orphanedAIArtifacts.count} files` : "files"}
              enabled={hkConfig.orphanedAIArtifacts.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  orphanedAIArtifacts: { enabled: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "Orphaned AI Artifacts"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Internal Registry"
              description="Garbage-collect unreferenced build artifacts"
              stat={hkStats ? formatBytes(hkStats.internalRegistry.totalSizeBytes) : "..."}
              statDetail="used"
              enabled
              onToggle={() => {}}
              disabled
              lastResult={hkStats?.lastRun?.categories.find(
                (category) => category.category === "Internal Registry"
              )}
              inlineControls={
                <>
                  <span>&middot;</span>
                  <span>keep latest artifact per source</span>
                </>
              }
            />
            <HousekeepingCard
              label="Orphaned Volumes"
              description="Remove old anonymous Docker volumes not used by containers"
              stat={hkStats ? String(hkStats.orphanedVolumes.count) : "..."}
              statDetail={
                hkStats
                  ? `volumes (${formatBytes(hkStats.orphanedVolumes.reclaimableBytes)})`
                  : "volumes"
              }
              enabled={hkConfig.orphanedVolumes.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  orphanedVolumes: { ...current.orphanedVolumes, enabled: v },
                }))
              }
              retentionDays={hkConfig.orphanedVolumes.retentionDays}
              onRetentionChange={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  orphanedVolumes: {
                    ...current.orphanedVolumes,
                    retentionDays: v,
                  },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "Orphaned Volumes"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Operation History"
              description="Delete finished Docker tasks, builds, compose, availability and hosting operations (the latest 10 per resource are kept)"
              stat={
                hkStats?.operationHistory ? hkStats.operationHistory.count.toLocaleString() : "..."
              }
              statDetail="eligible rows"
              enabled={hkConfig.operationHistory.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  operationHistory: { ...current.operationHistory, enabled: v },
                }))
              }
              retentionDays={hkConfig.operationHistory.retentionDays}
              onRetentionChange={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  operationHistory: { ...current.operationHistory, retentionDays: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "Operation History"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Expired OAuth Grants"
              description="Purge expired OAuth codes and tokens, and client registrations that never completed sign-in"
              stat={hkStats?.oauthCleanup ? hkStats.oauthCleanup.count.toLocaleString() : "..."}
              statDetail="eligible rows"
              enabled={hkConfig.oauthCleanup.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  oauthCleanup: { enabled: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "Expired OAuth Grants"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Retired System PKI Keys"
              description="Destroy private keys 30 days after system certificate retirement"
              stat={hkStats ? String(hkStats.orphanedCerts.count) : "..."}
              statDetail={
                hkStats
                  ? `${hkStats.orphanedCerts.supersededCount} superseded, ${hkStats.orphanedCerts.unknownCount} unknown`
                  : "eligible"
              }
              enabled={hkConfig.orphanedCerts.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  orphanedCerts: { enabled: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find((c) => c.category === "Orphaned Certs")}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="ACME Challenges"
              description="Clean up validation tokens"
              stat={hkStats ? String(hkStats.acmeChallenges.fileCount) : "..."}
              statDetail={
                hkStats ? `files (${formatBytes(hkStats.acmeChallenges.totalSizeBytes)})` : "files"
              }
              enabled={hkConfig.acmeCleanup.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  acmeCleanup: { enabled: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find(
                (c) => c.category === "ACME Challenges"
              )}
              disabled={controlsDisabled}
            />
            <HousekeepingCard
              label="Docker Images"
              description="Prune old Gateway images"
              stat={hkStats ? String(hkStats.dockerImages.oldImageCount) : "..."}
              statDetail={
                hkStats ? `old (${formatBytes(hkStats.dockerImages.reclaimableBytes)})` : "old"
              }
              enabled={hkConfig.dockerPrune.enabled}
              onToggle={(v) =>
                setHkConfig((current) => ({
                  ...current,
                  dockerPrune: { enabled: v },
                }))
              }
              lastResult={hkStats?.lastRun?.categories.find((c) => c.category === "Docker Images")}
              disabled={controlsDisabled}
            />
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {hkStats?.lastRun ? (
                <span>
                  Last run <RelativeTime value={hkStats.lastRun.startedAt} />
                  {" — "}
                  {hkStats.lastRun.overallSuccess
                    ? "completed successfully"
                    : "completed with errors"}
                  {` in ${(hkStats.lastRun.totalDurationMs / 1000).toFixed(1)}s`}
                </span>
              ) : (
                <span>No runs yet</span>
              )}
            </div>
            <Button
              variant="quiet"
              size="inline"
              className="text-sm font-normal"
              onClick={() => void handleViewHistory()}
              pending={hkHistoryLoading}
            >
              View history
            </Button>
          </div>
        </div>
      </PanelShell>

      {/* Housekeeping History Dialog */}
      <Dialog open={hkHistoryOpen} onOpenChange={setHkHistoryOpen}>
        <DialogContent className="max-w-full overflow-x-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Run History</DialogTitle>
          </DialogHeader>
          <div className="min-w-0 border border-border">
            <SimpleTable
              columns={historyColumns}
              rows={hkHistory}
              getRowKey={(run, index) => `${run.startedAt}-${index}`}
              emptyMessage="No runs yet"
              tableClassName="table-fixed"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
