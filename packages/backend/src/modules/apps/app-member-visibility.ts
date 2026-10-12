import type { AppMember } from './app-members.service.js';

/**
 * How a caller sees an app: `full` with apps:view on the app or on one of its environments, `members` when the app is
 * visible only because the caller can view some of its members (their own grants, folder grants on an environment
 * folder or the app root included). In `members` mode the caller sees only the environments holding such members and,
 * inside them, only those members; everything shown is computed from them alone.
 */
export type AppAccess = 'full' | 'members';

export interface AppVisibility {
  access: AppAccess;
  /** Visible environments, in the app's order: apps:view environments plus environments seen through members. */
  environmentIds: string[];
  /** The visible environments seen only through members (a subset of environmentIds). */
  memberEnvironmentIds: string[];
}

/** Identity keys of visible members, matching incidentItemKeys. */
export function memberVisibilityKeys(members: readonly AppMember[]): Set<string> {
  const keys = new Set<string>();
  for (const member of members) {
    switch (member.type) {
      case 'container':
        keys.add(`container:${member.nodeId ?? ''}:${member.id}`);
        break;
      case 'database':
        keys.add(`database:${member.id}`);
        if (member.managedId) keys.add(`managed-database:${member.managedId}`);
        break;
      case 'storage':
        keys.add(`storage:${member.id}`);
        if (member.managedId) keys.add(`managed-storage:${member.managedId}`);
        break;
      default:
        keys.add(`${member.type}:${member.id}`);
    }
  }
  return keys;
}

/** Keys of the visible members of each environment seen only through members (incident item filter). */
export function memberKeysByEnvironment(
  members: readonly AppMember[],
  memberEnvironmentIds: readonly string[]
): Map<string, Set<string>> {
  return new Map(
    memberEnvironmentIds.map((id) => [
      id,
      memberVisibilityKeys(members.filter((member) => member.environmentId === id)),
    ])
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The members an incident item concerns, as memberVisibilityKeys keys. Links, bindings and Secure Links name no member
 * of their own: none (a members-only viewer does not see them).
 */
export function incidentItemKeys(item: { itemKind: string; ref: unknown }): string[] {
  const ref = (item.ref ?? {}) as Record<string, unknown>;
  const keys: Array<string | null> = [];
  switch (item.itemKind) {
    case 'route_overlay':
    case 'route_withdraw':
      keys.push(text(ref.routeId) && `route:${ref.routeId}`);
      break;
    case 'container_stop':
      keys.push(text(ref.name) && `container:${text(ref.nodeId) ?? ''}:${ref.name}`);
      break;
    case 'container_network': {
      keys.push(text(ref.name) && `container:${text(ref.nodeId) ?? ''}:${ref.name}`);
      const owner = (ref.owner ?? {}) as Record<string, unknown>;
      const ownerId = text(owner.id);
      if (ownerId && owner.type === 'deployment') keys.push(`deployment:${ownerId}`);
      if (ownerId && owner.type === 'compose') keys.push(`compose:${ownerId}`);
      if (ownerId && owner.type === 'container') keys.push(`container:${text(ref.nodeId) ?? ''}:${ownerId}`);
      break;
    }
    case 'deployment_stop':
      keys.push(text(ref.deploymentId) && `deployment:${ref.deploymentId}`);
      break;
    case 'compose_stop':
      keys.push(text(ref.projectId) && `compose:${ref.projectId}`);
      break;
    case 'database_pause':
      keys.push(text(ref.connectionId) && `database:${ref.connectionId}`);
      keys.push(text(ref.databaseId) && `managed-database:${ref.databaseId}`);
      break;
    case 'database_publication':
      keys.push(text(ref.databaseId) && `managed-database:${ref.databaseId}`);
      break;
    case 'storage_pause':
      keys.push(text(ref.connectionId) && `storage:${ref.connectionId}`);
      keys.push(text(ref.storageId) && `managed-storage:${ref.storageId}`);
      break;
    case 'storage_publication':
      keys.push(text(ref.storageId) && `managed-storage:${ref.storageId}`);
      break;
  }
  return keys.filter((key): key is string => !!key);
}

/**
 * An incident as a members-only viewer sees it: only the items about members it can view (counts follow the items),
 * and no incident-level error (it can be about anything the incident touched).
 */
interface FilterableIncident {
  items: Array<{ itemKind: string; ref: unknown }>;
  lastError: unknown;
}

export function incidentForMembers<T extends FilterableIncident>(incident: T, visibleKeys: ReadonlySet<string>): T {
  return {
    ...incident,
    lastError: null,
    items: incident.items.filter((item) => incidentItemKeys(item).some((key) => visibleKeys.has(key))),
  };
}
