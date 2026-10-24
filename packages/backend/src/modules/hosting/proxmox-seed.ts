import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@/middleware/error-handler.js';
import type { HostingCreateRequest } from './hosting-provider.types.js';

const execute = promisify(execFile);
export async function assertProxmoxSeedRuntime() {
  try {
    await execute('xorriso', ['-version'], { timeout: 5000, maxBuffer: 16 * 1024 });
  } catch {
    throw new AppError(
      500,
      'HOSTING_SEED_BUILD_FAILED',
      'Install xorriso on the Opfield host before provisioning Proxmox VMs'
    );
  }
}
/**
 * Runs what the guest agent executes. On SELinux images (Fedora) the agent is confined (virt_qemu_ga_t): a plain
 * shell it starts may not install packages, write /etc or manage services. This file carries the type the agent may
 * run unconfined through (virt_qemu_ga_unconfined_exec_t, with virt_qemu_ga_run_unconfined on), as root runs it on
 * Debian and Ubuntu. Elsewhere it is a plain bash.
 */
export const GUEST_RUN_PATH = '/usr/local/libexec/opfield-guest-run';
const GUEST_RUN_POLICY_PATH = '/usr/local/libexec/opfield-guest-run.cil';
const GUEST_RUN_POLICY = `(filecon "${GUEST_RUN_PATH}" file (system_u object_r virt_qemu_ga_unconfined_exec_t ((s0) (s0))))\n`;
/**
 * Lets the confined guest agent of an SELinux image read the installation result and host identity (non-security
 * files) and run installers and daemon restarts unconfined through GUEST_RUN_PATH. The VM's hypervisor already has
 * this reach on Debian and Ubuntu, where the agent is not confined at all. Nothing changes on hosts without SELinux.
 */
export const SELINUX_GUEST_AGENT_COMMAND = [
  'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then',
  'setsebool -P virt_qemu_ga_read_nonsecurity_files=1 virt_qemu_ga_run_unconfined=1 || echo "Could not let the guest agent read files and run unconfined" >&2;',
  `{ semodule -i ${GUEST_RUN_POLICY_PATH} && restorecon ${GUEST_RUN_PATH}; } || chcon -t virt_qemu_ga_unconfined_exec_t ${GUEST_RUN_PATH} || echo "Could not label ${GUEST_RUN_PATH}" >&2;`,
  'fi',
].join(' ');
export function proxmoxSeedFiles(input: HostingCreateRequest, mac: string) {
  if (!/^gw-[a-f0-9-]{36}$/.test(input.marker) || !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac))
    throw new AppError(400, 'HOSTING_SEED_INVALID', 'Invalid bootstrap identity');
  const profile = input.proxmox!;
  const ip = input.ipConfig
    ?.split(',')
    .find((part) => part.startsWith('ip='))
    ?.slice(3);
  const gateway = input.ipConfig
    ?.split(',')
    .find((part) => part.startsWith('gw='))
    ?.slice(3);
  return {
    'meta-data': JSON.stringify({ 'instance-id': input.marker, 'local-hostname': input.name }),
    'network-config': JSON.stringify({
      version: 2,
      ethernets: {
        gateway0: {
          match: { macaddress: mac.toLowerCase() },
          dhcp4: !ip || ip === 'dhcp',
          ...(ip && ip !== 'dhcp' ? { addresses: [ip], routes: [{ to: '0.0.0.0/0', via: gateway }] } : {}),
          ...(profile.mtu ? { mtu: profile.mtu } : {}),
          ...(profile.dnsServers?.length
            ? {
                nameservers: {
                  addresses: profile.dnsServers,
                  ...(profile.searchDomain ? { search: [profile.searchDomain] } : {}),
                },
              }
            : {}),
        },
      },
    }),
    'user-data': `#cloud-config\n${JSON.stringify({
      ssh_pwauth: false,
      disable_root: true,
      package_update: true,
      packages: ['bash', 'curl', 'ca-certificates', 'qemu-guest-agent', 'jq', 'openssl', 'coreutils', 'util-linux'],
      write_files: [
        {
          path: GUEST_RUN_PATH,
          permissions: '0700',
          owner: 'root:root',
          content: '#!/bin/bash\nexec /bin/bash "$@"\n',
        },
        { path: GUEST_RUN_POLICY_PATH, permissions: '0600', owner: 'root:root', content: GUEST_RUN_POLICY },
        {
          path: '/var/lib/opfield-hosting-bootstrap.sh',
          permissions: '0700',
          owner: 'root:root',
          content: input.userData,
        },
      ],
      runcmd: [
        // SELinux images (Fedora) confine the guest agent: it may not read most files or run commands unconfined.
        // Proxmox then could not read the install result or host identity, nor run installs and daemon restarts the
        // way it does on Debian and Ubuntu, where the agent is unconfined. Grant the agent that same reach.
        ['sh', '-c', SELINUX_GUEST_AGENT_COMMAND],
        [
          'sh',
          '-c',
          'if command -v systemctl >/dev/null; then systemctl start qemu-guest-agent; elif command -v rc-service >/dev/null; then rc-update add qemu-guest-agent default && rc-service qemu-guest-agent start; fi',
        ],
        [
          'bash',
          '-c',
          'trap "rm -f /var/lib/opfield-hosting-bootstrap.sh" EXIT; bash /var/lib/opfield-hosting-bootstrap.sh',
        ],
      ],
    })}\n`,
  };
}

/** A bounded NoCloud ISO, generated without shell interpolation; never log file contents. */
export async function buildProxmoxSeed(input: HostingCreateRequest, mac: string): Promise<Buffer> {
  const files = proxmoxSeedFiles(input, mac);
  const directory = await mkdtemp(join(tmpdir(), 'opfield-seed-'));
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content, { mode: 0o600 });
    await execute(
      'xorriso',
      [
        '-as',
        'mkisofs',
        '-quiet',
        '-volid',
        'cidata',
        '-joliet',
        '-rock',
        '-output',
        join(directory, 'seed.iso'),
        ...Object.keys(files).map((name) => join(directory, name)),
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024 }
    );
    const iso = await readFile(join(directory, 'seed.iso'));
    if (iso.length > 2 * 1024 * 1024) throw new Error('seed too large');
    return iso;
  } catch {
    throw new AppError(
      500,
      'HOSTING_SEED_BUILD_FAILED',
      'Could not prepare cloud-init media. Check that xorriso is installed on the Opfield host.'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
