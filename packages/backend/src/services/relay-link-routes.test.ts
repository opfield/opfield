import { describe, expect, it } from 'vitest';
import { routeTransportRestartRequired, secureLinkEgressEqual } from './relay-link-routes.js';
import { LEGACY_DATABASE_LINK_NETWORK_PREFIX } from '@/lib/legacy-compat.js';

const listener = {
  networkName: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}a`,
  listenAddress: '172.30.0.1',
  listenPort: 5432,
  allowedSources: [] as string[],
};
const egress: {
  networkName: string;
  alias: string;
  listenPort: number;
  maxSessions: number;
  consumersUseAlias?: boolean;
} = { networkName: `${LEGACY_DATABASE_LINK_NETWORK_PREFIX}a`, alias: 'db-a', listenPort: 5432, maxSessions: 0 };
const transport = (managedDatabaseListener: typeof listener | null, secureLinkEgress: typeof egress | null) => ({
  managedDatabaseListener,
  secureLinkEgress,
});

describe('link route transport changes (D8, D9)', () => {
  it('keeps the route and its tunnels while one entry point serves through a migration and its revert', () => {
    // Database migration: egress added next to the listener, then the listener goes.
    expect(routeTransportRestartRequired(transport(listener, null), transport(listener, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, egress), transport(null, egress))).toBe(false);
    // Revert: the listener comes back next to the egress, then the egress goes.
    expect(routeTransportRestartRequired(transport(null, egress), transport(listener, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, egress), transport(listener, null))).toBe(false);
    // A storage route its sidecar serves gains or loses the connector egress.
    expect(routeTransportRestartRequired(transport(null, null), transport(null, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(null, egress), transport(null, null))).toBe(false);
  });

  it('writes consumersUseAlias without moving the generation, so live tunnels stay (S1)', () => {
    const aliased = { ...egress, consumersUseAlias: true };
    // The migration turns it on next to the listener once the egress listens; the revert turns it off.
    expect(routeTransportRestartRequired(transport(listener, egress), transport(listener, aliased))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, aliased), transport(listener, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(null, aliased), transport(listener, egress))).toBe(false);
    // The route is still written: the flag is part of the stored egress.
    expect(secureLinkEgressEqual(egress, aliased)).toBe(false);
    expect(secureLinkEgressEqual(egress, { ...egress, consumersUseAlias: false })).toBe(true);
  });

  it('writes a new session limit without moving the generation: the connector applies it in place (F1)', () => {
    // A database link route of an earlier release capped its connector listener at 16.
    const capped = { ...egress, maxSessions: 16 };
    expect(routeTransportRestartRequired(transport(null, capped), transport(null, egress))).toBe(false);
    expect(routeTransportRestartRequired(transport(listener, capped), transport(listener, egress))).toBe(false);
    expect(secureLinkEgressEqual(capped, egress)).toBe(false);
  });

  it('restarts the route when a serving entry point changes or the only listener comes or goes', () => {
    expect(
      routeTransportRestartRequired(
        transport(listener, null),
        transport({ ...listener, listenAddress: '172.30.0.9' }, null)
      )
    ).toBe(true);
    expect(routeTransportRestartRequired(transport(null, egress), transport(null, { ...egress, alias: 'db-b' }))).toBe(
      true
    );
    expect(routeTransportRestartRequired(transport(listener, null), transport(null, null))).toBe(true);
    expect(routeTransportRestartRequired(transport(null, null), transport(listener, null))).toBe(true);
    // Only the admitted workloads changed: the listener is updated in place.
    expect(
      routeTransportRestartRequired(
        transport(listener, null),
        transport({ ...listener, allowedSources: ['container:x'] }, null)
      )
    ).toBe(false);
  });
});
