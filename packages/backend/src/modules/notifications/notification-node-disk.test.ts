import { describe, expect, it } from 'vitest';
import { decodeHealthDiskMounts } from '@/grpc/services/health-report.js';
import { NODE_DATA_DISKS_TARGET } from './notification-catalog.js';
import { extractMetricFromHealthReport, isNodeDataDisk } from './notification-metrics.js';
import { defaultResolveMessage } from './notification-resolve-messages.js';
import { buildNotificationTemplateContext, renderTemplate } from './notification-templates.js';

const mount = (mountPoint: string, usagePercent: number, extra: Record<string, unknown> = {}) => ({
  mountPoint,
  filesystem: 'ext4',
  device: '/dev/sda1',
  totalBytes: 100,
  usedBytes: usagePercent,
  freeBytes: 100 - usagePercent,
  usagePercent,
  ...extra,
});

const diskValues = (healthData: unknown, target: string | null) =>
  extractMetricFromHealthReport('node', 'disk', healthData, target)?.values ?? null;

describe('node disk rules', () => {
  it('watches every data disk with the data-disks target, never Opfield disk images', () => {
    const healthData = {
      diskMounts: [
        mount('/', 40, { role: 'root' }),
        mount('/var/lib/docker', 91, { role: 'docker_root', device: '/dev/sdb1' }),
        mount('/var/lib/docker-daemon', 50, { role: 'opfield_state', device: '/dev/sdc1' }),
        mount('/mnt/data', 70, { role: 'data', device: '/dev/sdd1' }),
        mount('/var/lib/docker-daemon/databases/pg/mnt', 99, { role: 'managed_image', device: '/dev/loop3' }),
        // A disk image on a device a role names as managed_image, though it is not a loop device.
        mount('/var/lib/docker-daemon/volume-images/mounts/v', 99, { role: 'managed_image', device: '/dev/dm-1' }),
      ],
    };
    expect(diskValues(healthData, NODE_DATA_DISKS_TARGET)).toEqual([
      { resourceId: '/', value: 40 },
      { resourceId: '/var/lib/docker', value: 91 },
      { resourceId: '/var/lib/docker-daemon', value: 50 },
      { resourceId: '/mnt/data', value: 70 },
    ]);
  });

  it('skips loop devices of daemons that send no role', () => {
    const healthData = {
      diskMounts: [
        mount('/', 40),
        mount('/var/lib/docker', 88, { device: '/dev/nvme1n1' }),
        mount('/var/lib/docker-daemon/databases/kv/mnt', 97, { device: '/dev/loop0' }),
      ],
    };
    expect(diskValues(healthData, NODE_DATA_DISKS_TARGET)).toEqual([
      { resourceId: '/', value: 40 },
      { resourceId: '/var/lib/docker', value: 88 },
    ]);
  });

  it('keeps the exact target of a rule that names a mount, and every mount without a target', () => {
    const healthData = {
      diskMounts: [
        mount('/', 40, { role: 'root' }),
        mount('/data', 70, { role: 'data' }),
        mount('/img', 99, { role: 'managed_image', device: '/dev/loop1' }),
      ],
    };
    expect(diskValues(healthData, '/')).toEqual([{ resourceId: '/', value: 40 }]);
    expect(diskValues(healthData, '/img')).toEqual([{ resourceId: '/img', value: 99 }]);
    expect(diskValues(healthData, '/missing')).toBeNull();
    expect(diskValues(healthData, null)?.map((value) => value.resourceId)).toEqual(['/', '/data', '/img']);
  });

  it('falls back to the free space of / for a report without mounts', () => {
    const healthData = { diskMounts: [], diskFreeBytes: 25, diskTotalBytes: 100 };
    expect(diskValues(healthData, NODE_DATA_DISKS_TARGET)).toEqual([{ resourceId: '/', value: 75 }]);
    expect(diskValues(healthData, '/')).toEqual([{ resourceId: '/', value: 75 }]);
    expect(diskValues(healthData, '/data')).toBeNull();
    // An older protected relay sends neither mounts nor a total: nothing to evaluate.
    expect(diskValues({ diskMounts: [], diskFreeBytes: 25 }, NODE_DATA_DISKS_TARGET)).toBeNull();
  });

  it('watches the root mount a protected node reports', () => {
    const decoded = decodeHealthDiskMounts([
      {
        mountPoint: '/',
        filesystem: '',
        device: '',
        totalBytes: 200,
        usedBytes: 180,
        freeBytes: 20,
        usagePercent: 90,
        role: 'root',
      },
    ]);
    expect(diskValues({ diskMounts: decoded.diskMounts }, NODE_DATA_DISKS_TARGET)).toEqual([
      { resourceId: '/', value: 90 },
    ]);
  });

  it('never counts the managed storage root marker as a disk', () => {
    expect(
      isNodeDataDisk({ mountPoint: '/var/lib/docker-daemon/databases', filesystem: 'gateway-managed-storage-root' })
    ).toBe(false);
    expect(isNodeDataDisk(null)).toBe(false);
  });
});

describe('health report disk mounts', () => {
  it('keeps the role of each mount and the promised share of the managed storage root', () => {
    const decoded = decodeHealthDiskMounts([
      {
        mountPoint: '/',
        filesystem: 'ext4',
        device: '/dev/sda1',
        totalBytes: '100',
        usedBytes: '40',
        freeBytes: '60',
        usagePercent: 40,
        role: 'root',
      },
      {
        mountPoint: '/old',
        filesystem: 'xfs',
        device: '/dev/sdb1',
        totalBytes: '10',
        usedBytes: '1',
        freeBytes: '9',
        usagePercent: 10,
      },
      {
        mountPoint: '/var/lib/docker-daemon/databases',
        filesystem: 'gateway-managed-storage-root',
        totalBytes: '100',
        usedBytes: '104',
        freeBytes: '0',
        usagePercent: 104,
      },
    ]);
    expect(decoded.diskMounts).toEqual([
      {
        mountPoint: '/',
        filesystem: 'ext4',
        device: '/dev/sda1',
        totalBytes: 100,
        usedBytes: 40,
        freeBytes: 60,
        usagePercent: 40,
        role: 'root',
      },
      {
        mountPoint: '/old',
        filesystem: 'xfs',
        device: '/dev/sdb1',
        totalBytes: 10,
        usedBytes: 1,
        freeBytes: 9,
        usagePercent: 10,
      },
    ]);
    expect(decoded.managedStorageCapacity).toEqual({
      storageRoot: '/var/lib/docker-daemon/databases',
      availableBytes: 0,
      promisedPercent: 104,
    });
    expect(
      extractMetricFromHealthReport('node', 'managed_disk_promised_pct', {
        managedStorageCapacity: decoded.managedStorageCapacity,
      })
    ).toEqual({ values: [{ resourceId: '/var/lib/docker-daemon/databases', value: 104 }] });
    // A node without managed storage has nothing to evaluate.
    expect(extractMetricFromHealthReport('node', 'managed_disk_promised_pct', { diskMounts: [] })).toBeNull();
  });
});

describe('node disk messages', () => {
  it('name the disk in the firing and the resolve message', () => {
    const template =
      'Disk {{details.mount}} of node {{node.name}} is {{round metric.value 1}}% full. Free space before workloads fail.';
    const context = buildNotificationTemplateContext({
      alert: { id: 'rule', name: 'Node disk almost full', status: 'firing', severity: 'warning' },
      resource: { type: 'node', id: 'n1', key: 'n1:/var/lib/docker', name: 'worker-1' },
      metric: { name: 'disk', value: 91.26 },
      node: { id: 'n1', name: 'worker-1' },
      details: { mount: '/var/lib/docker' },
    });
    expect(renderTemplate(template, context)).toBe(
      'Disk /var/lib/docker of node worker-1 is 91.3% full. Free space before workloads fail.'
    );
    expect(
      defaultResolveMessage(
        { name: 'Node disk almost full', type: 'threshold', category: 'node', metric: 'disk' },
        'worker-1',
        {
          metric: { value: 60 },
          details: { mount: '/var/lib/docker' },
        }
      )
    ).toBe('Disk Usage of /var/lib/docker on worker-1 is back to normal at 60%.');
  });
});
