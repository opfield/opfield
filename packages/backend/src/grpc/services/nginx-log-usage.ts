import type { NodeNginxLogUsage } from '@/db/schema/nodes.js';

function count(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * The nginx logs an nginx daemon reports in HealthReport.nginx_logs (nginx_log_budget_v1), as the stored report keeps
 * them: `{ nginxLogs }`, or nothing for a daemon that does not report them (older daemons, other node types).
 * Housekeeping "Nginx Logs" sums them across nginx nodes.
 */
export function nginxLogUsageHealth(report: unknown): { nginxLogs?: NodeNginxLogUsage } {
  const usage = (report as { nginxLogs?: unknown } | null | undefined)?.nginxLogs;
  if (!usage || typeof usage !== 'object') return {};
  const value = usage as Record<string, unknown>;
  return {
    nginxLogs: {
      bytes: count(value.bytes),
      files: count(value.files),
      oldestUnix: count(value.oldestUnix),
      budgetBytes: count(value.budgetBytes),
      maxFileBytes: count(value.maxFileBytes),
      retentionDays: count(value.retentionDays),
    },
  };
}
