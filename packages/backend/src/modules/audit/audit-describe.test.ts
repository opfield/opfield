import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { describeAuditEntry } from './audit-describe.js';

describe('audit descriptions', () => {
  it('describes changes, counts, switches and failures in a short line', () => {
    expect(describeAuditEntry('user.rename', { oldName: 'Ann', newName: 'Anna' })).toBe('Ann → Anna');
    expect(describeAuditEntry('user.auth_method_change', { previousAuthMethod: 'oidc', authMethod: 'password' })).toBe(
      'oidc → password'
    );
    expect(describeAuditEntry('docker.image.prune', { deleted: 3, reclaimedBytes: 50 * 1024 * 1024 })).toBe(
      '3 deleted · 50 MB reclaimed'
    );
    expect(describeAuditEntry('ssl.auto_renew_enable', { enabled: true })).toBe('on');
    expect(
      describeAuditEntry('system.update.failed', { version: 'v2.12.1', success: false, error: 'pull failed' })
    ).toBe('v2.12.1 · failed: pull failed');
    expect(describeAuditEntry('cloud.request', { type: 'state', ok: true })).toBe('Read state');
  });

  it('leaves out ids, secrets and long values, and says nothing when there is nothing to say', () => {
    expect(describeAuditEntry('node.update', { from: '11111111-1111-4111-8111-111111111111', to: 'x' })).toBeNull();
    expect(describeAuditEntry('node.update', { oldName: 'a', newName: 'b'.repeat(200) })).toBeNull();
    expect(describeAuditEntry('app.start', {})).toBeNull();
    expect(describeAuditEntry('app.start', null)).toBeNull();
  });
});

describe('one System user', () => {
  it("shows Opfield's own user as System in the audit user list", async () => {
    const { AuditService } = await import('./audit.service.js');
    const rows = [
      { userId: '00000000-0000-0000-0000-000000000000', userName: 'Opfield System', userEmail: 'system@gateway.local' },
      { userId: 'u1', userName: 'Ann', userEmail: 'ann@example.com' },
    ];
    const chain = { from: () => chain, leftJoin: () => chain, orderBy: async () => rows };
    const service = new AuditService({ selectDistinct: () => chain } as never);
    expect(await service.getAuditUsers()).toEqual([
      { userId: '00000000-0000-0000-0000-000000000000', userName: 'System', userEmail: null },
      rows[1],
    ]);
  });
});
