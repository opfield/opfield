import { describe, expect, it } from 'vitest';
import { cloudAuditResourceName, cloudAuditSummary } from './cloud-link-audit-format.js';

describe('cloud link audit entries in plain words', () => {
  it('names the Opfield account, never the agent id', () => {
    expect(cloudAuditResourceName('owner@example.com')).toBe('Opfield account · owner@example.com');
    expect(cloudAuditResourceName(null)).toBe('Opfield account');
  });

  it('describes reads, their repeats and failures', () => {
    expect(cloudAuditSummary('cloud.request', { type: 'state', ok: true })).toBe('Read state');
    expect(cloudAuditSummary('cloud.request', { type: 'logs', service: 'app', tail: 200, ok: true })).toBe(
      'Read logs · app · last 200 lines'
    );
    expect(
      cloudAuditSummary('cloud.request', {
        type: 'logs',
        service: 'app',
        ok: true,
        summary: { count: 14, windowStartedAt: '2026-10-12T10:00:00Z', lastAt: '2026-10-12T10:09:30Z' },
      })
    ).toBe('Read logs · app · 14 reads in 10 min');
    expect(
      cloudAuditSummary('cloud.request', { type: 'node-token', ok: false, errorCode: 'REMOTE_MANAGEMENT_OFF' })
    ).toBe('Issue node token · failed: REMOTE_MANAGEMENT_OFF');
    expect(cloudAuditSummary('cloud.request', { type: 'update', version: 'v2.12.0', ok: true })).toBe(
      'Start update · v2.12.0'
    );
  });

  it('describes the other cloud actions', () => {
    expect(
      cloudAuditSummary('cloud.connect', { success: true, accountEmail: 'owner@example.com', source: 'connect-code' })
    ).toBe('Connected to owner@example.com with a connect code');
    expect(cloudAuditSummary('cloud.connect', { success: false, errorCode: 'CLOUD_MANAGED' })).toBe(
      'Connect failed: CLOUD_MANAGED'
    );
    expect(cloudAuditSummary('cloud.connect_code', { outcome: 'requested' })).toBe('Connect code requested');
    expect(cloudAuditSummary('cloud.connect_code', { outcome: 'refused', errorCode: 'CLOUD_MANAGED' })).toBe(
      'Connect code refused: CLOUD_MANAGED'
    );
    expect(cloudAuditSummary('cloud.disconnect', { success: true, wasConnected: true, confirmedByAccount: true })).toBe(
      'Disconnected'
    );
    expect(cloudAuditSummary('cloud.disconnect', { success: false, errorCode: 'CLOUD_MANAGED' })).toBe(
      'Disconnect refused: CLOUD_MANAGED'
    );
    expect(cloudAuditSummary('cloud.disconnected_by_account', {})).toBe('Disconnected by the account');
    expect(cloudAuditSummary('cloud.remote_management', { enabled: true })).toBe('Remote management allowed');
    expect(cloudAuditSummary('cloud.enroll_file', { outcome: 'settled', removed: true })).toBe(
      'Enrolment file applied and removed'
    );
    expect(cloudAuditSummary('cloud.managed_sso', { step: 'owner' })).toBe('Owner made administrator');
    expect(cloudAuditSummary('cloud.managed_sso', { step: 'skipped', reason: 'admin exists' })).toBe(
      'Sign-in setup skipped: admin exists'
    );
    expect(
      cloudAuditSummary('cloud.sso_revoke', {
        reason: 'removed_from_team',
        blocked: 2,
        alreadyBlocked: 1,
        unknown: 3,
        users: [{ email: 'ada@example.com' }],
      })
    ).toBe(
      'Access removed by the Opfield account: 2 users blocked · 1 already blocked · 3 not found · removed from the team'
    );
    expect(cloudAuditSummary('license.activate', {})).toBeNull();
  });
});
