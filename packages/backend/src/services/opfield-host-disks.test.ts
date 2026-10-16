import { describe, expect, it, vi } from 'vitest';
import { mergeDisk, type OpfieldHostDisk, OpfieldHostDiskReader, parseDfOutput } from './opfield-host-disks.js';

const GB = 1024 ** 3;

describe('Opfield host disks', () => {
  it('parses df -kP output in argument order', () => {
    const output = [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      'overlay 41152736 30000000 11152736 73% /',
      '/dev/sdb1 104857600 1048576 103809024 1% /var/lib/postgresql/data',
    ].join('\n');
    expect(parseDfOutput(output)).toEqual([
      { filesystem: 'overlay', totalKb: 41152736, availKb: 11152736 },
      { filesystem: '/dev/sdb1', totalKb: 104857600, availKb: 103809024 },
    ]);
  });

  it('merges readings of one filesystem and keeps others apart', () => {
    const disks: OpfieldHostDisk[] = [];
    mergeDisk(disks, { holds: ['root'], filesystem: 'overlay', totalBytes: 40 * GB, freeBytes: 10 * GB });
    mergeDisk(disks, { holds: ['postgres'], filesystem: '/dev/sda1', totalBytes: 40 * GB, freeBytes: 10 * GB });
    mergeDisk(disks, { holds: ['registry'], filesystem: '/dev/sdb1', totalBytes: 100 * GB, freeBytes: 95 * GB });
    expect(disks).toHaveLength(2);
    expect(disks[0]).toMatchObject({ holds: ['root', 'postgres'], usedPercent: 75 });
    expect(disks[1]).toMatchObject({ holds: ['registry'], usedPercent: 5 });
  });

  it('measures every running stack container with df, Docker data root included', async () => {
    const docker = {
      inspectSelf: vi.fn(async () => ({ Config: { Labels: { 'com.docker.compose.project': 'opfield' } } })),
      listContainersByLabel: vi.fn(async () => [
        {
          Id: 'pg',
          Names: ['/opfield-postgres-1'],
          State: 'running',
          Labels: { 'com.docker.compose.service': 'postgres' },
        },
        { Id: 'old', Names: ['/opfield-old-1'], State: 'exited', Labels: {} },
      ]),
      inspectContainerDetails: vi.fn(async () => ({
        Mounts: [
          { Type: 'volume', Destination: '/var/lib/postgresql/data' },
          { Type: 'bind', Destination: '/var/run/docker.sock' },
        ],
      })),
      execInContainer: vi.fn(async () => ({
        exitCode: 0,
        output:
          'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 900 100 90% /\n/dev/sdb 4000 1000 3000 25% /var/lib/postgresql/data\n',
      })),
    };
    const reader = new OpfieldHostDiskReader(docker as never, '/nonexistent-opfield-data');

    const disks = await reader.read();

    expect(docker.execInContainer).toHaveBeenCalledTimes(1);
    expect(docker.execInContainer).toHaveBeenCalledWith('pg', ['df', '-kP', '/', '/var/lib/postgresql/data']);
    expect(disks.map((disk) => disk.usedPercent)).toEqual([90, 25]);
    expect(reader.fullest()?.usedPercent).toBe(90);
  });
});
