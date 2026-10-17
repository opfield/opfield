// The installers name the version the node runs (the installed command's) in their upgrade message, not the version of
// a binary another run user left behind (rc.22: "Upgrading from rc.20 to rc.21" with rc.21 installed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptsDir = path.dirname(new URL(import.meta.url).pathname);
const linux = process.platform === 'linux';

function installDaemonBinary(source) {
  const match = /^install_daemon_binary\(\) \{\n[\s\S]*?^\}$/m.exec(source);
  assert.ok(match, 'install_daemon_binary is defined');
  return match[0];
}

test('the upgrade message names the installed version, not a left-behind copy', { skip: !linux }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'opfield-versions-'));
  try {
    const target = path.join(dir, 'daemon');
    await writeFile(target, '#!/bin/sh\n', { mode: 0o755 });
    for (const [script, daemon] of [
      ['setup-docker-node.sh', 'docker-daemon'],
      ['setup-monitoring-node.sh', 'monitoring-daemon'],
      ['setup-node.sh', 'nginx-daemon'],
    ]) {
      const source = readFileSync(path.join(scriptsDir, script), 'utf8');
      const run = (installed) =>
        spawnSync(
          'bash',
          [
            '-c',
            [
              "IFS=$'\\n\\t'",
              installDaemonBinary(source),
              'log() { echo "LOG $*"; }; ok() { echo "OK $*"; }; warn() { echo "WARN $*"; }',
              'die() { echo "DIE $*"; exit 1; }; prune_older_backups() { :; }; download_with_progress() { return 1; }',
              // The copy at the target was left by a run as another user.
              'daemon_binary_version() { echo v2.11.1-rc.20; }',
              `EXISTING_VERSION='${installed}' RESOLVED_DAEMON_VERSION=v2.11.1-rc.21 ARCH=amd64 DOWNLOAD_URL=x LOG_FILE=/dev/null`,
              `install_daemon_binary '${target}'`,
            ].join('\n'),
          ],
          { encoding: 'utf8' }
        ).stdout;
      assert.match(run('v2.11.1-rc.21'), new RegExp(`Installing ${daemon} v2\\.11\\.1-rc\\.21 at `), script);
      assert.doesNotMatch(run('v2.11.1-rc.21'), /Upgrading/, script);
      assert.match(run('v2.11.1-rc.19'), new RegExp(`Upgrading ${daemon} from v2\\.11\\.1-rc\\.19 to v2\\.11\\.1-rc\\.21`), script);
      // Without an installed command the copy's own version is all there is.
      assert.match(run(''), new RegExp(`Upgrading ${daemon} from v2\\.11\\.1-rc\\.20 to`), script);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
