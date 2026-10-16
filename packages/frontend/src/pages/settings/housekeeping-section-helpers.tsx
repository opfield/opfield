import { Check, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SettingsHelpTitle } from "@/components/common/SettingsControlRow";
import { Switch } from "@/components/ui/switch";
import type { HousekeepingCategoryResult, HousekeepingConfig, HousekeepingStats } from "@/types";

const HOUSEKEEPING_HELP: Record<string, string> = {
  "Nginx Logs":
    "Each nginx node bounds its route logs and its default access and error logs every 5 minutes, whether this is on or not: a log over its size cap keeps its newest lines and is cut, all of them together stay within 5% of the disk (at most 2 GiB), and the logs of deleted routes are removed. Turned on, rotated logs older than the retention period are deleted too; turned off, they are kept until the size limit needs the space.",
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
    "Deletes sandbox files that are no longer referenced by an AI conversation or retained artifact record.",
  "Internal Registry":
    "Keeps 2 builds per container in Opfield's internal Docker registry (the running one and one for rollback), deletes older builds and garbage-collects their image layers. Builds are also removed as soon as a newer build finishes.",
  "Orphaned Volumes":
    "Removes anonymous Docker volumes that are no longer attached to a container and have exceeded the configured age.",
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
  "Expired Tokens":
    "Removes API and inference tokens the given number of days after they expired (0 removes them at once). Until then they are listed as Expired and refused like revoked ones. The audit log keeps their history and records each removal.",
};

/** "214 files", plus the nginx nodes whose daemon is too old to report and bound its logs. */
export function nginxLogStatDetail(stats: HousekeepingStats["nginxLogs"]): string {
  const files = `${stats.fileCount.toLocaleString()} files`;
  const missing = (stats.nodeCount ?? 0) - (stats.reportingNodeCount ?? 0);
  if (missing <= 0) return files;
  return `${files}, ${missing} ${missing === 1 ? "node needs" : "nodes need"} a daemon update`;
}

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
                max={365}
                value={localDays}
                disabled={!enabled || disabled}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10);
                  setLocalDays(Number.isNaN(next) ? minRetentionDays : next);
                }}
                onBlur={() => {
                  const v = Math.max(minRetentionDays, Math.min(365, localDays));
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
