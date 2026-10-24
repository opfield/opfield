import { describe, expect, it } from 'vitest';
import { HostingSettingsSchema } from './hosting.schemas.js';
import { DEFAULT_PROXMOX_CPU_TYPE, PROXMOX_CPU_TYPES } from './hosting-provider.types.js';

const profile = { nodes: ['pve'], storage: 'local-lvm', bridge: 'vmbr0' };

describe('Proxmox VM CPU type', () => {
  it('accepts the usual Proxmox CPU types and keeps it unset by default', () => {
    for (const cpuType of PROXMOX_CPU_TYPES) {
      expect(HostingSettingsSchema.parse({ proxmox: { ...profile, cpuType } }).proxmox?.cpuType).toBe(cpuType);
    }
    expect(HostingSettingsSchema.parse({ proxmox: profile }).proxmox?.cpuType).toBeUndefined();
    expect(DEFAULT_PROXMOX_CPU_TYPE).toBe('host');
  });

  it('refuses a CPU type Proxmox would not know', () => {
    expect(() => HostingSettingsSchema.parse({ proxmox: { ...profile, cpuType: 'pentium' } })).toThrow();
  });
});
