import { cloudAuditSummary } from '@/modules/cloud-link/cloud-link-audit-format.js';

/**
 * One short plain line for an audit entry, from what its details carry: a change from one value to another, a count,
 * an on/off switch, a target or a failure. Null when the details carry nothing worth a line (the label says it all).
 * Names are left to the Resource column; ids, secrets and long values never show.
 */
type Details = Record<string, unknown> | null | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE = 60;
/** Pairs of keys that hold a value before and after the change. */
const CHANGE_PAIRS: Array<[string, string]> = [
  ['oldName', 'newName'],
  ['previousName', 'name'],
  ['from', 'to'],
  ['oldValue', 'newValue'],
  ['previousAuthMethod', 'authMethod'],
  ['previousGroupName', 'groupName'],
  ['oldGroupName', 'newGroupName'],
  ['previousChannel', 'channel'],
  ['previousVersion', 'version'],
  ['fromVersion', 'toVersion'],
  ['currentVersion', 'targetVersion'],
  ['oldDomain', 'newDomain'],
  ['oldPath', 'newPath'],
  ['sourcePath', 'destinationPath'],
  ['previous', 'enabled'],
];
/** Keys whose number is a count worth showing, with the noun it counts. */
const COUNTS: Array<[string, string, string]> = [
  ['count', 'item', 'items'],
  ['deleted', 'deleted', 'deleted'],
  ['deletedCount', 'deleted', 'deleted'],
  ['removed', 'removed', 'removed'],
  ['removedCount', 'removed', 'removed'],
  ['moved', 'moved', 'moved'],
  ['pruned', 'pruned', 'pruned'],
  ['reclaimedBytes', 'byte reclaimed', 'bytes reclaimed'],
  ['nodeCount', 'node', 'nodes'],
  ['memberCount', 'member', 'members'],
  ['variableCount', 'variable', 'variables'],
];
/** Keys that name what was acted on when the row's resource does not (a target, a version, a kind). */
const TARGETS = [
  'version',
  'targetVersion',
  'image',
  'imageRef',
  'tag',
  'environment',
  'kind',
  'method',
  'provider',
  'scope',
];

function short(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || UUID.test(text) || text.length > MAX_VALUE || /\n/.test(text)) return null;
  return text;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function describeAuditEntry(action: string, details: Details): string | null {
  const cloud = cloudAuditSummary(action, details);
  if (cloud) return cloud;
  if (!details || typeof details !== 'object') return null;
  const parts: string[] = [];

  for (const [before, after] of CHANGE_PAIRS) {
    if (!(before in details) || !(after in details)) continue;
    const from = short(details[before]);
    const to = short(details[after]);
    if (from !== null && to !== null && from !== to) {
      parts.push(`${from} → ${to}`);
      break;
    }
  }
  if (parts.length === 0 && typeof details.enabled === 'boolean') parts.push(details.enabled ? 'on' : 'off');

  for (const [key, one, many] of COUNTS) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      parts.push(
        key === 'reclaimedBytes' ? `${Math.round(value / 1024 / 1024)} MB reclaimed` : plural(value, one, many)
      );
    }
  }
  for (const key of ['ids', 'items', 'nodeIds', 'containerIds', 'conversationIds'] as const) {
    const value = details[key];
    if (Array.isArray(value) && value.length > 1) parts.push(plural(value.length, 'item', 'items'));
  }

  if (parts.length === 0) {
    for (const key of TARGETS) {
      const value = short(details[key]);
      if (value) {
        parts.push(value);
        break;
      }
    }
  }

  const failed = details.success === false || details.ok === false;
  const reason = short(details.errorCode) ?? short(details.error) ?? short(details.reason);
  if (failed) parts.push(reason ? `failed: ${reason}` : 'failed');

  return parts.length > 0 ? parts.join(' · ') : null;
}
