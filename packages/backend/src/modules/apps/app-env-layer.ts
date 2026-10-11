import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import { appEnvironmentLayerState, appEnvironmentVariables } from '@/db/schema/index.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { APP_FAMILY_TABLES, type AppFamily } from './app-families.js';
import type { AppMembersReader } from './app-members.service.js';

/** Kinds of workloads that receive an environment layer, and how their state rows are keyed. */
export type LayerOwnerKind = 'container' | 'deployment' | 'compose';

export interface EnvironmentLayer {
  environmentId: string | null;
  vars: Record<string, string>;
  secrets: Record<string, string>;
  /** Every layer key (variables and secrets). */
  keys: string[];
  /** sha256 over the sorted keys and values; the digest of an empty layer for a workload outside apps. */
  digest: string;
}

export interface LayerAppliedState {
  environmentId: string | null;
  appliedKeys: string[];
  appliedDigest: string;
}

export interface PendingWorkload {
  kind: LayerOwnerKind;
  /** Container: its name; deployment and Compose project: their id. */
  id: string;
  nodeId: string;
  name: string;
}

export function layerDigest(vars: Record<string, string>, secrets: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [kind, values] of [
    ['v', vars],
    ['s', secrets],
  ] as const) {
    for (const key of Object.keys(values).sort()) hash.update(`${kind}\u0000${key}\u0000${values[key]}\u0000`);
  }
  return hash.digest('hex');
}

export const EMPTY_LAYER_DIGEST = layerDigest({}, {});

export function emptyLayer(): EnvironmentLayer {
  return { environmentId: null, vars: {}, secrets: {}, keys: [], digest: EMPTY_LAYER_DIGEST };
}

/** Owner key of a workload's layer state: container `<nodeId>:<name>`, deployment and Compose by id. */
export function layerOwnerKey(kind: LayerOwnerKind, id: string, nodeId?: string | null): string {
  return kind === 'container' ? `${nodeId ?? ''}:${id}` : id;
}

/**
 * The environment layer: environment variables and secrets every workload of an app environment receives on its
 * next create, recreate, deploy or Compose apply. Precedence, lowest first: image ENV < environment variables <
 * environment secrets < the workload's own environment < the workload's own secrets. Layer keys are never stored as
 * the workload's own environment; `app_environment_layer_state` records what each workload last received so keys
 * that left the layer are removed and outdated workloads can be listed.
 */
export class AppEnvLayerService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly crypto: CryptoService,
    private readonly members: AppMembersReader
  ) {}

  async resolveLayer(
    environmentId: string | null | undefined,
    db: DrizzleExecutor = this.db
  ): Promise<EnvironmentLayer> {
    if (!environmentId) return emptyLayer();
    const rows = await db
      .select({
        key: appEnvironmentVariables.key,
        encryptedValue: appEnvironmentVariables.encryptedValue,
        secret: appEnvironmentVariables.secret,
      })
      .from(appEnvironmentVariables)
      .where(eq(appEnvironmentVariables.environmentId, environmentId));
    const vars: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const row of rows) {
      const value = this.decrypt(row.encryptedValue);
      if (row.secret) secrets[row.key] = value;
      else vars[row.key] = value;
    }
    return {
      environmentId,
      vars,
      secrets,
      keys: [...Object.keys(vars), ...Object.keys(secrets)].sort(),
      digest: layerDigest(vars, secrets),
    };
  }

  /** The layer for a workload placed in `folderId` of a family (empty outside app environments). */
  async resolveLayerForPlacement(
    family: AppFamily,
    folderId: string | null | undefined,
    db: DrizzleExecutor = this.db
  ): Promise<EnvironmentLayer> {
    return this.resolveLayer(await this.environmentOfFolder(family, folderId, db), db);
  }

  async environmentOfFolder(
    family: AppFamily,
    folderId: string | null | undefined,
    db: DrizzleExecutor = this.db
  ): Promise<string | null> {
    if (!folderId) return null;
    const { table, dockerResourceType } = APP_FAMILY_TABLES[family];
    const [row] = (await (db as any)
      .select({ environmentId: table.appEnvironmentId })
      .from(table)
      .where(
        and(
          eq(table.id, folderId),
          isNotNull(table.appEnvironmentId),
          dockerResourceType ? eq(table.resourceType, dockerResourceType) : undefined
        )
      )
      .limit(1)) as Array<{ environmentId: string }>;
    return row?.environmentId ?? null;
  }

  async appliedState(
    kind: LayerOwnerKind,
    ownerKey: string,
    db: DrizzleExecutor = this.db
  ): Promise<LayerAppliedState | null> {
    const [row] = await db
      .select({
        environmentId: appEnvironmentLayerState.environmentId,
        appliedKeys: appEnvironmentLayerState.appliedKeys,
        appliedDigest: appEnvironmentLayerState.appliedDigest,
      })
      .from(appEnvironmentLayerState)
      .where(and(eq(appEnvironmentLayerState.ownerKind, kind), eq(appEnvironmentLayerState.ownerKey, ownerKey)))
      .limit(1);
    return row ?? null;
  }

  /** What a workload received from its layer (an empty layer outside apps clears the record). */
  async recordApplied(
    kind: LayerOwnerKind,
    ownerKey: string,
    layer: Pick<EnvironmentLayer, 'environmentId' | 'keys' | 'digest'>,
    db: DrizzleExecutor = this.db
  ): Promise<void> {
    if (!layer.environmentId && layer.keys.length === 0) {
      await db
        .delete(appEnvironmentLayerState)
        .where(and(eq(appEnvironmentLayerState.ownerKind, kind), eq(appEnvironmentLayerState.ownerKey, ownerKey)));
      return;
    }
    await db
      .insert(appEnvironmentLayerState)
      .values({
        ownerKind: kind,
        ownerKey,
        environmentId: layer.environmentId,
        appliedKeys: [...layer.keys],
        appliedDigest: layer.digest,
        appliedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [appEnvironmentLayerState.ownerKind, appEnvironmentLayerState.ownerKey],
        set: {
          environmentId: layer.environmentId,
          appliedKeys: [...layer.keys],
          appliedDigest: layer.digest,
          appliedAt: new Date(),
        },
      });
  }

  /** A renamed container keeps what it received. */
  async renameOwner(kind: LayerOwnerKind, fromKey: string, toKey: string): Promise<void> {
    if (fromKey === toKey) return;
    await this.db
      .delete(appEnvironmentLayerState)
      .where(and(eq(appEnvironmentLayerState.ownerKind, kind), eq(appEnvironmentLayerState.ownerKey, toKey)));
    await this.db
      .update(appEnvironmentLayerState)
      .set({ ownerKey: toKey })
      .where(and(eq(appEnvironmentLayerState.ownerKind, kind), eq(appEnvironmentLayerState.ownerKey, fromKey)));
  }

  async forgetOwner(kind: LayerOwnerKind, ownerKey: string): Promise<void> {
    await this.db
      .delete(appEnvironmentLayerState)
      .where(and(eq(appEnvironmentLayerState.ownerKind, kind), eq(appEnvironmentLayerState.ownerKey, ownerKey)));
  }

  /** Workloads of the environment that have not received its current values yet. */
  async pendingWorkloads(environmentId: string, digest?: string): Promise<PendingWorkload[]> {
    const current = digest ?? (await this.resolveLayer(environmentId)).digest;
    const workloads = (await this.members.listMembers([environmentId])).filter(
      (member) => member.type === 'container' || member.type === 'deployment' || member.type === 'compose'
    );
    if (workloads.length === 0) return [];
    const keyed = workloads.map((member) => ({
      member,
      kind: member.type as LayerOwnerKind,
      ownerKey: layerOwnerKey(member.type as LayerOwnerKind, member.id, member.nodeId),
    }));
    const states = await this.db
      .select({
        ownerKind: appEnvironmentLayerState.ownerKind,
        ownerKey: appEnvironmentLayerState.ownerKey,
        appliedDigest: appEnvironmentLayerState.appliedDigest,
        environmentId: appEnvironmentLayerState.environmentId,
      })
      .from(appEnvironmentLayerState)
      .where(
        inArray(
          appEnvironmentLayerState.ownerKey,
          keyed.map((item) => item.ownerKey)
        )
      );
    const byKey = new Map(states.map((row) => [`${row.ownerKind}\u0000${row.ownerKey}`, row]));
    return keyed
      .filter(({ kind, ownerKey }) => {
        const state = byKey.get(`${kind}\u0000${ownerKey}`);
        const applied = state && state.environmentId === environmentId ? state.appliedDigest : EMPTY_LAYER_DIGEST;
        return applied !== current;
      })
      .map(({ member, kind }) => ({
        kind,
        id: member.id,
        nodeId: member.nodeId ?? member.nodeIds[0] ?? '',
        name: member.name,
      }));
  }

  private decrypt(encryptedValue: string): string {
    return this.crypto.decryptString(JSON.parse(encryptedValue) as { encryptedKey: string; encryptedDek: string });
  }
}

/**
 * Merge order of a container or deployment environment, lowest first: environment variables, environment secrets,
 * then the workload's own env (later arguments win), with `removals` the layer keys a previous apply set that are no
 * longer in the layer and are not the workload's own.
 */
export function mergeLayerEnv(
  layer: Pick<EnvironmentLayer, 'vars' | 'secrets' | 'keys'>,
  ownEnv: Record<string, string>,
  previous: Pick<LayerAppliedState, 'appliedKeys'> | null
): { env: Record<string, string>; removals: string[] } {
  const env = { ...layer.vars, ...layer.secrets, ...ownEnv };
  const removals = (previous?.appliedKeys ?? []).filter((key) => !layer.keys.includes(key) && !(key in ownEnv));
  return { env, removals };
}
