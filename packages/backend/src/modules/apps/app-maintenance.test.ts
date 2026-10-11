import { describe, expect, it } from 'vitest';
import { effectiveMaintenance } from '@/modules/proxy/effective-maintenance.js';
import { overlayMode, routeTakesMaintenance } from './app-maintenance.service.js';

const proxy = { type: 'proxy', rawConfigEnabled: false, isSystem: false };

describe('app maintenance overlay', () => {
  it.each([
    // app override, env switch, route kind -> overlay
    [false, false, proxy, 'off'],
    [false, true, proxy, 'maintenance'],
    [true, false, proxy, 'maintenance'],
    [true, true, proxy, 'maintenance'],
    [true, true, { ...proxy, type: 'redirect' }, 'off'],
    [true, true, { ...proxy, type: '404' }, 'off'],
    [true, true, { ...proxy, rawConfigEnabled: true }, 'off'],
    [true, true, { ...proxy, isSystem: true }, 'off'],
  ] as const)('override %s, env %s, %o -> %s', (override, envOn, route, mode) => {
    expect(overlayMode(route, { maintenanceOverride: override }, { maintenanceEnabled: envOn })).toBe(mode);
  });

  it('leaves routes outside apps off', () => {
    expect(overlayMode(proxy, null, null)).toBe('off');
  });

  it('applies maintenance only to managed proxy routes without raw config', () => {
    expect(routeTakesMaintenance(proxy)).toBe(true);
    expect(routeTakesMaintenance({ ...proxy, type: 'raw' })).toBe(false);
  });

  it('shows the maintenance page for the own switch or the overlay, and restores the own switch when the overlay ends', () => {
    expect(effectiveMaintenance({ maintenanceEnabled: false, appMaintenanceMode: 'off' })).toBe(false);
    expect(effectiveMaintenance({ maintenanceEnabled: true, appMaintenanceMode: 'off' })).toBe(true);
    expect(effectiveMaintenance({ maintenanceEnabled: false, appMaintenanceMode: 'maintenance' })).toBe(true);
    expect(effectiveMaintenance({ maintenanceEnabled: false, appMaintenanceMode: 'lockdown' })).toBe(true);
    expect(effectiveMaintenance({ maintenanceEnabled: false })).toBe(false);
  });
});
