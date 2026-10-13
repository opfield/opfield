import { HostingProviderError } from '../hosting-http.js';
import type { HostingProviderOperation, HostingResourceSnapshot } from '../hosting-provider.types.js';
import type { HostingSnapshotAction, HostingSnapshotAdapter, HostingVmSnapshot } from '../hosting-snapshot.types.js';
import {
  CLOUDBLAST_CURRENCY,
  type CloudBlastApi,
  id,
  mutationResponse,
  number,
  optionalString,
  record,
  UUID,
  uuid,
} from './cloudblast-api.js';
import { snapshotStorageCost, vmSnapshot } from './vm-snapshots.js';

const GIB = 1024 ** 3;
const NAME_LIMIT = 40;
type Backup = { uuid: string; name: string; createdAt: string | null; sizeGb: number | null; state: BackupState };
type BackupState = 'running' | 'succeeded' | 'failed';

function backupId(snapshot: HostingVmSnapshot): string {
  if (!UUID.test(snapshot.id)) throw new HostingProviderError(400, false, 'Invalid CloudBlast backup ID');
  return snapshot.id.toLowerCase();
}
function parseBackup(value: unknown): Backup {
  const object = record(value);
  const size = number(object.size);
  const completed = optionalString(object.completed_at) !== null;
  return {
    uuid: uuid(object.uuid),
    name: optionalString(object.name) ?? uuid(object.uuid),
    createdAt: optionalString(object.created_at),
    sizeGb: size === null || size < 0 ? null : size / GIB,
    state: !completed ? 'running' : object.is_successful === true ? 'succeeded' : 'failed',
  };
}

/** CloudBlast backups are Opfield VM snapshots: full-disk, per server, restorable in place. */
export class CloudBlastBackupsAdapter implements HostingSnapshotAdapter {
  constructor(private readonly api: CloudBlastApi) {}

  private backups(resource: HostingResourceSnapshot): Promise<Backup[]> {
    return this.api.pages(`${this.api.server(resource.remoteId)}/backups`, parseBackup);
  }

  /** Per-plan backup storage price; unknown pricing is a dash, never free storage. */
  private async storageRate(resource: HostingResourceSnapshot): Promise<HostingVmSnapshot['storageRate']> {
    if (!resource.sizeId) return null;
    try {
      const plans = await this.api.pages('/plans', (value) => record(value));
      const plan = plans.find((candidate) => id(candidate.id) === resource.sizeId);
      const rate = plan ? number(plan.backup_price) : null;
      return rate === null || rate < 0
        ? null
        : { amount: String(rate), currency: CLOUDBLAST_CURRENCY, unit: 'GB-month', source: 'provider-api' };
    } catch {
      return null;
    }
  }

  async list(resource: HostingResourceSnapshot): Promise<HostingVmSnapshot[]> {
    const backups = await this.backups(resource);
    const storageRate = backups.length ? await this.storageRate(resource) : null;
    return backups.map((backup) => {
      const snapshot = vmSnapshot({
        id: backup.uuid,
        name: backup.name,
        createdAt: backup.createdAt,
        sizeGb: backup.sizeGb,
        ready: backup.state === 'succeeded',
      });
      const cost = storageRate ? snapshotStorageCost(snapshot.sizeGb, storageRate.amount) : null;
      return {
        ...snapshot,
        storageRate,
        monthlyCost:
          cost === null
            ? null
            : { amount: cost, currency: CLOUDBLAST_CURRENCY, estimated: true, tax: 'unspecified' as const },
      };
    });
  }

  async operation(
    operationId: string,
    resource: HostingResourceSnapshot,
    action: HostingSnapshotAction
  ): Promise<HostingProviderOperation> {
    const [kind, target] = operationId.split(':');
    const result = { id: operationId, resourceId: resource.remoteId };
    if (action === 'snapshot_create' && kind === 'backup' && target) {
      const backup = (await this.backups(resource)).find((candidate) => candidate.uuid === target);
      if (!backup) return { ...result, status: 'failed', error: 'CloudBlast no longer lists this backup' };
      return backup.state === 'failed'
        ? { ...result, status: 'failed', error: 'CloudBlast reported that the backup failed' }
        : { ...result, status: backup.state };
    }
    if (action === 'snapshot_restore' && kind === 'restore' && target) {
      const server = record(await this.api.data(this.api.server(resource.remoteId)));
      if (uuid(server.uuid) !== resource.remoteId.toLowerCase())
        throw new HostingProviderError(502, true, 'CloudBlast restore task belongs to a different server');
      const status = optionalString(server.status);
      return {
        ...result,
        status: status === null ? 'succeeded' : status === 'restoring_backup' ? 'running' : 'unknown',
      };
    }
    throw new HostingProviderError(502, true, 'CloudBlast backup task identity did not match the requested action');
  }

  async create(resource: HostingResourceSnapshot, name: string): Promise<HostingProviderOperation> {
    if (name.length > NAME_LIMIT)
      throw new HostingProviderError(400, false, `CloudBlast backup names are limited to ${NAME_LIMIT} characters`);
    // Snapshot mode keeps the server online; the service still expects application-level consistency.
    const payload = await this.api.request(`${this.api.server(resource.remoteId)}/backups`, {
      method: 'POST',
      body: { name, mode: 'snapshot' },
    });
    return mutationResponse(() => ({
      id: `backup:${parseBackup(record(payload).data).uuid}`,
      resourceId: resource.remoteId,
      status: 'running' as const,
    }));
  }

  async remove(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot): Promise<HostingProviderOperation> {
    await this.api.request(`${this.api.server(resource.remoteId)}/backups/${backupId(snapshot)}`, { method: 'DELETE' });
    return { id: null, resourceId: resource.remoteId, status: 'succeeded' };
  }

  async restore(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot): Promise<HostingProviderOperation> {
    const backup = backupId(snapshot);
    await this.api.request(`${this.api.server(resource.remoteId)}/backups/${backup}/restore`, { method: 'POST' });
    return { id: `restore:${backup}`, resourceId: resource.remoteId, status: 'running' };
  }
}
