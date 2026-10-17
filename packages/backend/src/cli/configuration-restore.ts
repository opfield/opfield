import 'reflect-metadata';

import { readFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DOCKER_COMPOSE_CLI_IMAGE_REF } from '@/config/docker-compose-cli-image.js';
import {
  inspectExportFile,
  restoreErrorMessage,
  restoreExport,
  verifyExport,
} from '@/modules/configuration-transfer/configuration-restore.js';
import { currentSchemaMigration } from '@/modules/configuration-transfer/transfer-layout.js';
import { DockerService } from '@/services/docker.service.js';

/**
 * Restores an Opfield configuration export. Runs in a one-off container of the same Opfield image
 * with the Docker socket and the install directory mounted:
 *
 *   inspect <file>                       the plaintext header (version), as one JSON line
 *   verify  <file> --passphrase-file F   decrypts and checks the whole file
 *   restore <file> --passphrase-file F --host-dir /host --host-path /opt/opfield --project opfield
 *           [--public-url URL] [--grpc-target HOST:PORT] [--grpc-local-ip IP] [--start]
 *           [--replace-existing] [--status-file F] [--remove-passphrase-file] [--wizard]
 *
 * The last stdout line is a JSON result. Exit codes: 0 done, 2 wrong passphrase, 3 damaged or
 * incomplete file, 4 another Opfield version, 5 the installation is already set up, 1 anything else.
 */

const EXIT_CODES: Record<string, number> = {
  WRONG_PASSPHRASE: 2,
  DAMAGED: 3,
  TRUNCATED: 3,
  NOT_AN_EXPORT: 3,
  UNSUPPORTED_FORMAT: 3,
  INVALID_CONTENT: 3,
  INVALID_EXPORT: 3,
  VERSION_MISMATCH: 4,
  INSTALLATION_CONFIGURED: 5,
};

function readPassphrase(path: string | undefined, remove: boolean): string {
  if (!path) throw new Error('--passphrase-file is required');
  const passphrase = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (remove) rmSync(path, { force: true });
  return passphrase;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'passphrase-file': { type: 'string' },
      'remove-passphrase-file': { type: 'boolean', default: false },
      'host-dir': { type: 'string', default: '/host' },
      'host-path': { type: 'string' },
      project: { type: 'string' },
      'public-url': { type: 'string' },
      'grpc-target': { type: 'string' },
      'grpc-local-ip': { type: 'string' },
      start: { type: 'boolean', default: false },
      'replace-existing': { type: 'boolean', default: false },
      wizard: { type: 'boolean', default: false },
      'status-file': { type: 'string' },
      'owner-link-claim-hash': { type: 'string' },
    },
  });
  const [command, file] = positionals;
  if (!command || !file) {
    process.stderr.write('Usage: configuration-restore.js inspect|verify|restore <file> [options]\n');
    return 1;
  }
  const current = {
    opfieldVersion: process.env.APP_VERSION || 'dev',
    schemaMigration: currentSchemaMigration(),
  };
  const log = (line: string) => process.stderr.write(`${line}\n`);

  if (command === 'inspect') {
    const header = await inspectExportFile(file);
    process.stdout.write(
      `${JSON.stringify({ ok: true, opfieldVersion: header.opfieldVersion, schemaMigration: header.schemaMigration, createdAt: header.createdAt, current })}\n`
    );
    return 0;
  }

  const passphrase = readPassphrase(values['passphrase-file'], values['remove-passphrase-file'] ?? false);
  if (command === 'verify') {
    const { summary } = await verifyExport(file, passphrase, current);
    process.stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
    return 0;
  }
  if (command !== 'restore') throw new Error(`Unknown command ${command}`);

  const project = values.project;
  const hostPath = values['host-path'];
  if (!project || !hostPath) throw new Error('restore needs --project and --host-path');
  const docker = new DockerService('/var/run/docker.sock', '');
  const self = await docker.inspectSelf();
  const details = await docker.inspectContainerDetails(self.Id);
  if (!details) throw new Error('The restore container cannot inspect itself');
  const summary = await restoreExport(docker, {
    archivePath: file,
    passphrase,
    hostDir: values['host-dir'] ?? '/host',
    hostPath,
    project,
    helperImage: details.Image,
    composeCliImage: DOCKER_COMPOSE_CLI_IMAGE_REF,
    address: {
      publicUrl: values['public-url'] || undefined,
      grpcPublicTarget: values['grpc-target'] || undefined,
      ...(values['grpc-local-ip'] !== undefined ? { grpcLocalIp: values['grpc-local-ip'] } : {}),
    },
    start: values.start ?? false,
    replaceConfigured: values['replace-existing'] ?? false,
    archiveInOpfieldData: values.wizard ?? false,
    statusFile: values['status-file'],
    ...(values['owner-link-claim-hash'] && /^[a-f0-9]{64}$/.test(values['owner-link-claim-hash'])
      ? { ownerLinkClaimHash: values['owner-link-claim-hash'] }
      : {}),
    current,
    log,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, summary })}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const { code, message } = restoreErrorMessage(error);
    process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.stderr.write(`${message}\n`);
    process.exit(EXIT_CODES[code] ?? 1);
  }
);
