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
    throw new AppError(500, 'HOSTING_SEED_BUILD_FAILED', 'Install xorriso on the Opfield host before provisioning Proxmox VMs');
  }
}
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
          path: '/var/lib/gateway-hosting-bootstrap.sh',
          permissions: '0700',
          owner: 'root:root',
          content: input.userData,
        },
      ],
      runcmd: [
        [
          'sh',
          '-c',
          'if command -v systemctl >/dev/null; then systemctl start qemu-guest-agent; elif command -v rc-service >/dev/null; then rc-update add qemu-guest-agent default && rc-service qemu-guest-agent start; fi',
        ],
        [
          'bash',
          '-c',
          'trap "rm -f /var/lib/gateway-hosting-bootstrap.sh" EXIT; bash /var/lib/gateway-hosting-bootstrap.sh',
        ],
      ],
    })}\n`,
  };
}

/** A bounded NoCloud ISO, generated without shell interpolation; never log file contents. */
export async function buildProxmoxSeed(input: HostingCreateRequest, mac: string): Promise<Buffer> {
  const files = proxmoxSeedFiles(input, mac);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-seed-'));
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
