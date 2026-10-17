import { describe, expect, it } from 'vitest';
import { LEGACY_INSTALL_DIR_NAME } from '@/lib/legacy-compat.js';
import { redactText } from './diagnostics-logs.js';

describe('redactText', () => {
  it('masks the secret formats Opfield and its stack containers write to their logs', () => {
    const cases: Array<[string, string]> = [
      ['redis://:RedisPassw0rd@redis:6379/0', 'RedisPassw0rd'],
      [
        `connect postgres://${LEGACY_INSTALL_DIR_NAME}:S3cr3tPass@postgres:5432/${LEGACY_INSTALL_DIR_NAME}`,
        'S3cr3tPass',
      ],
      ['POSTGRES_PASSWORD=S3cr3tPass', 'S3cr3tPass'],
      ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
      ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdef'],
      ['PKI_MASTER_KEY=00112233445566778899aabbccddeeff', '00112233445566778899'],
      ['GET /api/ws?access_token=gwo_ABCDEFGHIJKLMNOPQRSTUVWXYZ&x=1', 'ABCDEFGHIJKLMNOP'],
      ['GET /callback?code=1&token=abcdef123456', 'abcdef123456'],
      ['token gw_0123456789abcdef0123456789abcdef rejected', '0123456789abcdef'],
      [
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY----- loaded',
        'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      ],
      ['key: -----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5', 'MHcCAQEEIIrYSSNQFaA2Hwf1'],
      [
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        'dozjgNryP4J3jVmNHl0w5N',
      ],
      ["ALTER ROLE app PASSWORD 'S3cr3tPass'", 'S3cr3tPass'],
      ['password: S3cr3tPass', 'S3cr3tPass'],
      ['{"password":"S3cr3tPass"} in a message', 'S3cr3tPass'],
      ['x-api-key: sk-live-abcdefghijklmnop', 'sk-live-abcdefghijklmnop'],
      ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ];
    for (const [line, secret] of cases) {
      const redacted = redactText(line);
      expect(redacted, line).not.toContain(secret);
      expect(redacted, line).toContain('REDACTED');
    }
  });

  it('keeps ordinary log lines readable', () => {
    for (const line of [
      `FATAL: password authentication failed for user "${LEGACY_INSTALL_DIR_NAME}"`,
      'listening on http://0.0.0.0:3000',
      'checkpoint complete: wrote 12 buffers (0.1%)',
    ]) {
      expect(redactText(line)).toBe(line);
    }
  });
});
