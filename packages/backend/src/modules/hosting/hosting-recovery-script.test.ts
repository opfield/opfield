// The schema barrel first, in its production order: the per-table modules import each other circularly.
import '@/db/schema/index.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostingRecoveryScript } from './hosting-management.service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the script with a stub systemctl that knows `units` and logs every restart. */
function run(roles: string[], units: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'opfield-recovery-'));
  dirs.push(dir);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  writeFileSync(
    join(dir, 'systemctl'),
    `#!/bin/bash\ncase "$1" in\n  cat) for u in ${units.join(' ')}; do [ "$u" = "$2" ] && exit 0; done; exit 1 ;;\n  restart) echo "$2" >> ${log} ;;\nesac\n`
  );
  chmodSync(join(dir, 'systemctl'), 0o755);
  const script = join(dir, 'recover.sh');
  writeFileSync(script, hostingRecoveryScript(roles));
  execFileSync('bash', [script], { env: { PATH: `${dir}:/usr/bin:/bin` } });
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

describe('hosting recovery script', () => {
  it('restarts the Opfield relay unit on a relay that has it', () => {
    expect(run(['relay'], ['opfield-relay-supervisor'])).toEqual(['opfield-relay-supervisor']);
  });

  it('restarts the pre-2.12.1 relay unit while its unit file still exists', () => {
    expect(run(['relay'], ['gateway-relay-supervisor', 'opfield-relay-supervisor'])).toEqual([
      'gateway-relay-supervisor',
    ]);
  });

  it('restarts daemon units by their own names', () => {
    expect(run(['nginx', 'docker'], ['nginx-daemon', 'docker-daemon'])).toEqual(['nginx-daemon', 'docker-daemon']);
  });
});
