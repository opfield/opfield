import { and, eq, ne, or } from 'drizzle-orm';
import { proxyHosts } from '@/db/schema/index.js';

/** App maintenance overlay of a route, computed by the apps module; never written by route edits. */
export type AppMaintenanceMode = 'off' | 'maintenance' | 'lockdown';

/**
 * A route shows the maintenance page while its own switch is on or its app (environment switch, app override)
 * puts it in maintenance. Turning the overlay off leaves the route's own switch exactly as it was.
 */
export function effectiveMaintenance(host: {
  maintenanceEnabled: boolean;
  appMaintenanceMode?: string | null;
}): boolean {
  return host.maintenanceEnabled || (host.appMaintenanceMode ?? 'off') !== 'off';
}

/** SQL: routes in effective maintenance (own switch or app overlay). */
export const IN_EFFECTIVE_MAINTENANCE = or(
  eq(proxyHosts.maintenanceEnabled, true),
  ne(proxyHosts.appMaintenanceMode, 'off')
);

/** SQL: routes outside any maintenance (health checks probe only these). */
export const NOT_IN_EFFECTIVE_MAINTENANCE = and(
  eq(proxyHosts.maintenanceEnabled, false),
  eq(proxyHosts.appMaintenanceMode, 'off')
);
