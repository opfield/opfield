const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * The lease watchdog version a docker daemon reports in HealthReport.lease_watchdog_version, as the stored report keeps
 * it: `{ leaseWatchdogVersion }` for a version, nothing when the daemon does not report one (daemons before it, or a
 * node without a watchdog). The node page shows it next to the daemon version: the watchdog updates on its own schedule.
 */
export function leaseWatchdogVersion(report: unknown): { leaseWatchdogVersion?: string } {
  const value = (report as { leaseWatchdogVersion?: unknown } | null | undefined)?.leaseWatchdogVersion;
  if (typeof value !== 'string') return {};
  const version = value.trim();
  return VERSION_PATTERN.test(version) ? { leaseWatchdogVersion: version } : {};
}
