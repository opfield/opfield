import { describe, expect, it } from 'vitest';
import { nginxLogUsageHealth } from './nginx-log-usage.js';

describe('nginxLogUsageHealth', () => {
  it('keeps the usage an nginx daemon reports, with 64-bit fields as numbers', () => {
    expect(
      nginxLogUsageHealth({
        nginxLogs: {
          bytes: '5368709120',
          files: 674,
          oldestUnix: '1755388800',
          budgetBytes: '107374182',
          maxFileBytes: '26843545',
          retentionDays: 30,
        },
      })
    ).toEqual({
      nginxLogs: {
        bytes: 5368709120,
        files: 674,
        oldestUnix: 1755388800,
        budgetBytes: 107374182,
        maxFileBytes: 26843545,
        retentionDays: 30,
      },
    });
  });

  it('stores nothing for daemons that do not report it', () => {
    expect(nginxLogUsageHealth({})).toEqual({});
    expect(nginxLogUsageHealth({ nginxLogs: null })).toEqual({});
    expect(nginxLogUsageHealth(undefined)).toEqual({});
  });
});
