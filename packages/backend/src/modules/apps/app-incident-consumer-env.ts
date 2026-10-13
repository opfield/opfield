import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  appIncidentItems,
  containerLinks,
  dockerSecrets,
  managedDatabaseBindings,
  managedStorageBindings,
} from '@/db/schema/index.js';

/** The container a binding or link puts variables into, with their names. Recorded with the item when it applies. */
export interface IncidentConsumerEnv {
  nodeId: string;
  name: string;
  env: string[];
}

/** Item kinds whose resource puts variables into a consumer container. */
export const CONSUMER_ITEM_KINDS = ['database_binding', 'storage_binding', 'container_link'] as const;
export type ConsumerItemKind = (typeof CONSUMER_ITEM_KINDS)[number];

/** The variable names of a binding's or link's `environment` (role → variable name). */
export function envNames(environment: unknown): string[] {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return [];
  const names = Object.values(environment as Record<string, unknown>).filter(
    (name): name is string => typeof name === 'string' && name.trim() !== ''
  );
  return [...new Set(names)].sort();
}

/** The consumer recorded in an item's prior state, or null (another item kind, a target that is no container). */
export function consumerEnvOf(priorState: unknown): IncidentConsumerEnv | null {
  const consumer = (priorState as { consumer?: unknown } | null)?.consumer as Partial<IncidentConsumerEnv> | undefined;
  if (!consumer || typeof consumer.nodeId !== 'string' || typeof consumer.name !== 'string') return null;
  const env = Array.isArray(consumer.env)
    ? consumer.env.filter((name): name is string => typeof name === 'string' && name !== '')
    : [];
  return env.length > 0 ? { nodeId: consumer.nodeId, name: consumer.name, env } : null;
}

/** Variable names of `Config.Env` entries (`KEY=value`). */
export function envKeys(env: unknown): Set<string> {
  if (!Array.isArray(env)) return new Set();
  return new Set(
    env.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.split('=', 1)[0]!)
  );
}

/**
 * The variables bindings and links put into the containers of an isolated environment. While the kill switch holds a
 * container off its networks, removing one of its bindings strips only the binding's saved credentials: the binding
 * reaches a container through its network, and the container is not on it. Each binding item records its consumer
 * container and variable names, so the release removes what a removed binding left on the container, as the
 * binding's removal does otherwise (a later binding with the same names is not refused then).
 */
export class AppIncidentConsumerEnv {
  constructor(private readonly db: DrizzleClient) {}

  /** `{ consumer }` for the prior state of a binding or link item whose consumer is a container, `{}` otherwise. */
  async record(kind: ConsumerItemKind, id: string): Promise<{ consumer?: IncidentConsumerEnv }> {
    const consumer = await this.consumerOf(kind, id);
    return consumer ? { consumer } : {};
  }

  private async consumerOf(kind: ConsumerItemKind, id: string): Promise<IncidentConsumerEnv | null> {
    if (kind === 'container_link') {
      const [link] = await this.db
        .select({
          nodeId: containerLinks.sourceNodeId,
          type: containerLinks.sourceType,
          name: containerLinks.sourceResourceId,
          environment: containerLinks.environment,
        })
        .from(containerLinks)
        .where(eq(containerLinks.id, id))
        .limit(1);
      return link?.type === 'container' ? consumerFrom(link) : null;
    }
    if (kind === 'database_binding') {
      const [binding] = await this.db
        .select({
          nodeId: managedDatabaseBindings.targetNodeId,
          type: managedDatabaseBindings.targetType,
          name: managedDatabaseBindings.targetResourceId,
          environment: managedDatabaseBindings.environment,
        })
        .from(managedDatabaseBindings)
        .where(eq(managedDatabaseBindings.id, id))
        .limit(1);
      return binding?.type === 'container' ? consumerFrom(binding) : null;
    }
    const [binding] = await this.db
      .select({
        nodeId: managedStorageBindings.targetNodeId,
        type: managedStorageBindings.targetType,
        name: managedStorageBindings.targetResourceId,
        environment: managedStorageBindings.environment,
      })
      .from(managedStorageBindings)
      .where(eq(managedStorageBindings.id, id))
      .limit(1);
    return binding?.type === 'container' ? consumerFrom(binding) : null;
  }

  /**
   * The variables still to remove from one container of an incident: those recorded by the incident's binding and
   * link items whose binding or link is gone now, except names a current binding or link of the container claims and
   * names stored as the container's secrets (Opfield puts those back on every recreate; they are the user's to remove).
   */
  async leftByGoneBindings(incidentId: string, nodeId: string, name: string): Promise<string[]> {
    const items = await this.db
      .select({
        itemKind: appIncidentItems.itemKind,
        ref: appIncidentItems.ref,
        priorState: appIncidentItems.priorState,
      })
      .from(appIncidentItems)
      .where(
        and(eq(appIncidentItems.incidentId, incidentId), inArray(appIncidentItems.itemKind, [...CONSUMER_ITEM_KINDS]))
      );
    const candidates = new Set<string>();
    for (const item of items) {
      const recorded = consumerEnvOf(item.priorState);
      if (!recorded || recorded.nodeId !== nodeId || recorded.name !== name) continue;
      const ref = item.ref as { linkId?: unknown; bindingId?: unknown };
      const id = String((item.itemKind === 'container_link' ? ref.linkId : ref.bindingId) ?? '');
      if (!(await this.gone(item.itemKind as ConsumerItemKind, id))) continue;
      for (const variable of recorded.env) candidates.add(variable);
    }
    if (candidates.size === 0) return [];
    for (const variable of await this.claimed(nodeId, name)) candidates.delete(variable);
    for (const variable of await this.secretKeys(nodeId, name)) candidates.delete(variable);
    return [...candidates].sort();
  }

  /** Whether a binding or link no longer exists (or is being deleted). */
  private async gone(kind: ConsumerItemKind, id: string): Promise<boolean> {
    if (!id) return false;
    if (kind === 'container_link') {
      const [link] = await this.db
        .select({ desiredState: containerLinks.desiredState })
        .from(containerLinks)
        .where(eq(containerLinks.id, id))
        .limit(1);
      return !link || link.desiredState === 'deleted';
    }
    if (kind === 'database_binding') {
      const [binding] = await this.db
        .select({ desiredState: managedDatabaseBindings.desiredState })
        .from(managedDatabaseBindings)
        .where(eq(managedDatabaseBindings.id, id))
        .limit(1);
      return !binding || binding.desiredState === 'deleted';
    }
    const [binding] = await this.db
      .select({ id: managedStorageBindings.id })
      .from(managedStorageBindings)
      .where(eq(managedStorageBindings.id, id))
      .limit(1);
    return !binding;
  }

  /** Variable names the container's current bindings and links put into it. */
  private async claimed(nodeId: string, name: string): Promise<Set<string>> {
    const [databases, storages, links] = await Promise.all([
      this.db
        .select({ environment: managedDatabaseBindings.environment })
        .from(managedDatabaseBindings)
        .where(
          and(
            eq(managedDatabaseBindings.targetNodeId, nodeId),
            eq(managedDatabaseBindings.targetType, 'container'),
            eq(managedDatabaseBindings.targetResourceId, name),
            ne(managedDatabaseBindings.desiredState, 'deleted')
          )
        ),
      this.db
        .select({ environment: managedStorageBindings.environment })
        .from(managedStorageBindings)
        .where(
          and(
            eq(managedStorageBindings.targetNodeId, nodeId),
            eq(managedStorageBindings.targetType, 'container'),
            eq(managedStorageBindings.targetResourceId, name)
          )
        ),
      this.db
        .select({ environment: containerLinks.environment })
        .from(containerLinks)
        .where(
          and(
            eq(containerLinks.sourceNodeId, nodeId),
            eq(containerLinks.sourceType, 'container'),
            eq(containerLinks.sourceResourceId, name),
            ne(containerLinks.desiredState, 'deleted')
          )
        ),
    ]);
    return new Set([...databases, ...storages, ...links].flatMap((row) => envNames(row.environment)));
  }

  private async secretKeys(nodeId: string, name: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ key: dockerSecrets.key })
      .from(dockerSecrets)
      .where(and(eq(dockerSecrets.nodeId, nodeId), eq(dockerSecrets.containerName, name)));
    return new Set(rows.map((row) => row.key));
  }
}

function consumerFrom(row: { nodeId: string; name: string; environment: unknown }): IncidentConsumerEnv | null {
  const env = envNames(row.environment);
  return env.length > 0 ? { nodeId: row.nodeId, name: row.name, env } : null;
}
