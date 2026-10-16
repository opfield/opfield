import { Check, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Switch } from "@/components/ui/switch";
import { cn, formatBytes } from "@/lib/utils";
import type { HousekeepingCategoryResult, HousekeepingConfig, OpfieldDiskUsage } from "@/types";

const HOUSEKEEPING_HELP: Record<string, string> = {
  "Nginx Logs":
    "Rotates active Nginx log files, compresses older files, and deletes files beyond the configured retention period.",
  "Structured Logs":
    "Removes old structured Opfield logs from ClickHouse when configured row or storage limits are exceeded.",
  "ClickHouse Internals":
    "Trims supported ClickHouse system-log tables. It does not remove Opfield structured logs, which use the separate policy above.",
  "Audit Log":
    "Deletes Opfield audit-trail records older than the configured retention period. Removed audit events cannot be restored from Opfield.",
  "Dismissed Alerts":
    "Removes alerts that were already dismissed and have exceeded their retention period. Active alerts are not affected.",
  "Delivery Log":
    "Deletes old notification delivery attempts, including successful and failed webhook or email delivery records.",
  "Orphaned AI Artifacts":
    "Deletes AI files no longer attached to a conversation, or whose conversation or user was deleted, after an hour. Tool and sandbox outputs together are kept within 10 GiB, oldest first; files users attached are never capped.",
  "Internal Registry":
    "Keeps 2 builds per container in Opfield's internal Docker registry (the running one and one for rollback), deletes older builds and garbage-collects their image layers. Builds are also removed as soon as a newer build finishes.",
  "Orphaned Volumes":
    "Removes anonymous Docker volumes Opfield created (seen attached to a container Opfield created) once they were unused for the given days. Unused volumes Opfield did not create, or cannot tell, are never removed automatically: they are counted here so you can remove them yourself.",
  "Retired System PKI Keys":
    "Permanently destroys private keys after their managed system certificates have been retired for 30 days.",
  "ACME Challenges":
    "Removes expired certificate-validation tokens and temporary challenge files left after ACME issuance attempts.",
  "Docker Images":
    "Prunes old Opfield images and, on every Docker node, dangling images and Git-source build images beyond each container's Image Cleanup setting (by default the build it runs and one to roll back to). Images used by containers are never removed.",
  "Operation History":
    "Deletes finished Docker container tasks after a day, and finished builds (with their logs), compose, availability and hosting operations and source webhook deliveries after the retention period, in batches. Each resource keeps its 10 latest runs (a Compose build batch counts once) and its latest operation of each kind, and anything still referenced (a build artifact, a hosted node's origin, a snapshot) is kept.",
  "Expired OAuth Grants":
    "Purges expired OAuth authorization codes, access and refresh tokens. Refresh tokens are kept until they expire. A registered OAuth client is removed only if it never completed an authorization and is older than 30 days; a client that was ever granted keeps its registration.",
  "Build Logs":
    "Deletes the logs of finished builds older than the given days, then the oldest while all build logs together are larger than the size. The newest 3 finished builds of each source keep their log; build records stay with Operation History.",
  "Inference Usage":
    "Deletes settled inference requests with their attempts and usage records older than the given days (35 at least: limits and usage reports read the last 30 days or the current month). Each user's lifetime total keeps what was removed. Also removes old provider quota readings and price versions nothing uses.",
  "Opfield Host Files":
    "Removes what interrupted work left on the Opfield host: temporary files, MCP archive transfer spools, configuration export snapshots and dumps. Also runs a minute after Opfield starts.",
  "Expired Tokens":
    "Removes API and inference tokens the given number of days after they expired (0 removes them at once). Until then they are listed as Expired and refused like revoked ones. The audit log keeps their history and records each removal.",
};

export function normalizeHousekeepingConfig(config: HousekeepingConfig): HousekeepingConfig {
  return {
    ...config,
    internalRegistry: {
      enabled: true,
      retentionSuccessfulArtifacts: 2,
    },
    clickHouseInternals: {
      enabled: config.clickHouseInternals?.enabled ?? false,
      maxSizeBytes: config.clickHouseInternals?.maxSizeBytes ?? 512 * 1024 ** 2,
    },
    operationHistory: config.operationHistory ?? { enabled: true, retentionDays: 90 },
    oauthCleanup: config.oauthCleanup ?? { enabled: true },
    expiredTokens: config.expiredTokens ?? { enabled: true, retentionDays: 7 },
    inferenceUsage: config.inferenceUsage ?? { enabled: true, retentionDays: 90 },
    buildLogs: config.buildLogs ?? {
      enabled: true,
      retentionDays: 30,
      maxSizeBytes: 2 * 1024 ** 3,
    },
    hostFiles: config.hostFiles ?? { enabled: true },
  };
}

export function HousekeepingCard({
  label,
  description,
  stat,
  statDetail,
  enabled,
  onToggle,
  retentionDays,
  onRetentionChange,
  minRetentionDays = 1,
  maxRetentionDays = 365,
  lastResult,
  disabled,
  disabledReason,
  inlineControls,
}: {
  label: string;
  description: string;
  stat: string;
  statDetail?: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  retentionDays?: number;
  onRetentionChange?: (v: number) => void;
  /** The shortest retention the category accepts (0: remove at once). */
  minRetentionDays?: number;
  maxRetentionDays?: number;
  lastResult?: HousekeepingCategoryResult;
  disabled?: boolean;
  disabledReason?: string;
  inlineControls?: ReactNode;
}) {
  const [localDays, setLocalDays] = useState(retentionDays ?? 30);

  useEffect(() => {
    if (retentionDays !== undefined) setLocalDays(retentionDays);
  }, [retentionDays]);

  return (
    <div className="border-t border-r border-border p-4 last:border-r-0 [&:nth-child(2n)]:border-r-0 sm:[&:nth-child(2n)]:border-r lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(3n)]:border-r-0 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">
            <SettingsHelpTitle label={label} help={HOUSEKEEPING_HELP[label]} />
          </p>
          {lastResult &&
            (lastResult.success ? (
              <Check className="h-3 w-3 text-success-text shrink-0" />
            ) : (
              <X className="h-3 w-3 text-destructive shrink-0" />
            ))}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
          <span>
            {stat}
            {statDetail ? ` ${statDetail}` : ""}
          </span>
          {disabledReason && (
            <>
              <span>&middot;</span>
              <span>{disabledReason}</span>
            </>
          )}
          {retentionDays !== undefined && onRetentionChange && (
            <>
              <span>&middot;</span>
              <span>keep</span>
              <input
                type="number"
                className="w-10 border border-input bg-background px-1 text-center text-xs text-foreground tabular-nums outline-none focus:border-primary disabled:opacity-50"
                min={minRetentionDays}
                max={maxRetentionDays}
                value={localDays}
                disabled={!enabled || disabled}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10);
                  setLocalDays(Number.isNaN(next) ? minRetentionDays : next);
                }}
                onBlur={() => {
                  const v = Math.max(minRetentionDays, Math.min(maxRetentionDays, localDays));
                  setLocalDays(v);
                  if (v !== retentionDays) onRetentionChange(v);
                }}
              />
              <span>days</span>
            </>
          )}
          {inlineControls}
        </div>
      </div>
      <Switch
        checked={enabled}
        onChange={onToggle}
        disabled={disabled}
        ariaLabel={`${label} cleanup`}
      />
    </div>
  );
}

/** Disk usage of Opfield's own data on the Opfield host, at the top of Housekeeping. */
export function HousekeepingDiskUsage({ usage }: { usage: OpfieldDiskUsage }) {
  const tables = usage.postgres?.largestTables.slice(0, 5) ?? [];
  const logs = usage.containerLogs?.largest.slice(0, 3) ?? [];
  return (
    <div className="border-b border-border">
      <div className="px-4 pt-3">
        <p className="text-sm font-medium">
          <SettingsHelpTitle
            label="Disk usage"
            help="What Opfield's own data takes on the Opfield host: every disk holding it (the Docker data root with images, container logs and volumes, and stack volumes on their own disk), the Postgres database and its largest tables, Redis, and container logs. Disks are measured every 10 minutes. Container logs rotate by their Docker log settings; they are shown here only."
          />
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">Disks</p>
          {usage.disks.length === 0 && <p>Not measured yet</p>}
          {usage.disks.map((disk) => (
            <div key={`${disk.filesystem}-${disk.totalBytes}`} className="min-w-0">
              <p className={cn("tabular-nums", disk.usedPercent >= 85 && "text-destructive")}>
                {disk.usedPercent}% used · {formatBytes(disk.freeBytes)} free of{" "}
                {formatBytes(disk.totalBytes)}
              </p>
              <p className="truncate" title={disk.holds.join(", ")}>
                {disk.holds.join(", ")}
              </p>
            </div>
          ))}
        </div>
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">
            Database{usage.postgres ? ` · ${formatBytes(usage.postgres.databaseBytes)}` : ""}
          </p>
          {!usage.postgres && <p>Unavailable</p>}
          {tables.map((table) => (
            <p key={table.name} className="flex justify-between gap-2">
              <span className="truncate">{table.name}</span>
              <span className="tabular-nums">{formatBytes(table.bytes)}</span>
            </p>
          ))}
        </div>
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">Redis</p>
          {usage.redis ? (
            <>
              <p className="tabular-nums">{formatBytes(usage.redis.memoryBytes)} in memory</p>
              {usage.redis.aofBytes !== null && (
                <p className="tabular-nums">{formatBytes(usage.redis.aofBytes)} append-only file</p>
              )}
            </>
          ) : (
            <p>Unavailable</p>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-foreground">
            Container logs
            {usage.containerLogs ? ` · ${formatBytes(usage.containerLogs.totalBytes)}` : ""}
          </p>
          {!usage.containerLogs && <p>Not measured yet</p>}
          {logs.map((log) => (
            <p key={log.name} className="flex justify-between gap-2">
              <span className="truncate">{log.name}</span>
              <span className="tabular-nums">{formatBytes(log.bytes)}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
