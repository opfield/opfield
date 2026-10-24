export type NavigationAttentionSeverity = 'warning' | 'critical' | null;

export function healthNavigationAttention(
  rows: Array<{ enabled?: boolean; healthStatus?: unknown }>
): NavigationAttentionSeverity {
  const enabledRows = rows.filter((row) => row.enabled !== false);
  if (enabledRows.some((row) => row.healthStatus === 'offline')) return 'critical';
  if (enabledRows.some((row) => row.healthStatus === 'degraded')) return 'warning';
  return null;
}

export function nodeNavigationAttention(offlineCount: number, hasPendingUpdates: boolean): NavigationAttentionSeverity {
  if (offlineCount > 0) return 'critical';
  if (hasPendingUpdates) return 'warning';
  return null;
}

/** Apps list health: a failing app is red, a degraded one yellow (unknown and healthy add nothing). */
export function appNavigationAttention(health: readonly unknown[]): NavigationAttentionSeverity {
  if (health.includes('failing')) return 'critical';
  if (health.includes('degraded')) return 'warning';
  return null;
}

/** Active status page incidents: a critical one is red, any other active one is yellow. */
export function statusPageNavigationAttention(
  incidents: Array<{ status?: unknown; severity?: unknown }>
): NavigationAttentionSeverity {
  const active = incidents.filter((incident) => incident.status === 'active');
  if (active.some((incident) => incident.severity === 'critical')) return 'critical';
  if (active.length > 0) return 'warning';
  return null;
}
