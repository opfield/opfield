import { and, asc, eq, inArray } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { appEnvironmentVariables } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import { APP_ENV_MANAGE_SCOPE, assertAppScope } from './app-access.js';
import type { AppEnvLayerService } from './app-env-layer.js';
import { appForMember } from './app-membership.js';
import type { AppActor, AppsService } from './apps.service.js';

export const APP_VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const APP_VARIABLE_MAX_KEYS = 200;
export const APP_VARIABLE_MAX_VALUE_BYTES = 32 * 1024;

export interface AppVariablesView {
  variables: Array<{ key: string; value: string }>;
  secrets: Array<{ key: string; updatedAt: Date }>;
  pendingWorkloads: Awaited<ReturnType<AppEnvLayerService['pendingWorkloads']>>;
}

function assertKey(key: string) {
  if (key.length > 255 || !APP_VARIABLE_KEY_RE.test(key)) {
    throw new AppError(400, 'APP_VARIABLE_KEY_INVALID', `"${key}" is not a valid variable name`);
  }
}

function assertValue(key: string, value: string) {
  if (Buffer.byteLength(value, 'utf8') > APP_VARIABLE_MAX_VALUE_BYTES) {
    throw new AppError(400, 'APP_VARIABLE_VALUE_TOO_LARGE', `The value of ${key} is larger than 32 KiB`);
  }
}

/**
 * Environment variables (returned to managers) and secrets (write-only: keys and update times) of an environment,
 * both encrypted at rest. A key is either a variable or a secret. Changes reach workloads on their next create,
 * recreate, deploy or Compose apply; the response lists the workloads that still run older values.
 */
export class AppVariablesService {
  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly crypto: CryptoService,
    private readonly apps: AppsService,
    private readonly layer: AppEnvLayerService
  ) {}

  async get(actor: AppActor, appId: string, environmentId: string): Promise<AppVariablesView> {
    const { env } = await this.authorize(actor, appId, environmentId);
    return this.view(env.id);
  }

  async setVariables(
    actor: AppActor,
    appId: string,
    environmentId: string,
    variables: Array<{ key: string; value: string }>
  ): Promise<AppVariablesView> {
    const { app, env } = await this.authorize(actor, appId, environmentId);
    const keys = new Set<string>();
    for (const { key, value } of variables) {
      assertKey(key);
      assertValue(key, value);
      if (keys.has(key)) throw new AppError(400, 'APP_VARIABLE_DUPLICATE', `${key} is listed twice`);
      keys.add(key);
    }
    const before = await this.rows(env.id);
    const secretKeys = new Set(before.filter((row) => row.secret).map((row) => row.key));
    const clash = [...keys].find((key) => secretKeys.has(key));
    if (clash) throw new AppError(409, 'APP_VARIABLE_IS_SECRET', `${clash} is already a secret in this environment`);
    if (keys.size + secretKeys.size > APP_VARIABLE_MAX_KEYS) {
      throw new AppError(400, 'APP_VARIABLE_LIMIT', `An environment holds at most ${APP_VARIABLE_MAX_KEYS} keys`);
    }
    const previous = new Map(
      before.filter((row) => !row.secret).map((row) => [row.key, this.decrypt(row.encryptedValue)])
    );
    const changed = variables.filter(({ key, value }) => previous.get(key) !== value).map(({ key }) => key);
    const removed = [...previous.keys()].filter((key) => !keys.has(key));
    if (changed.length > 0 || removed.length > 0) {
      await this.db.transaction(async (tx) => {
        if (removed.length > 0) {
          await tx
            .delete(appEnvironmentVariables)
            .where(
              and(
                eq(appEnvironmentVariables.environmentId, env.id),
                eq(appEnvironmentVariables.secret, false),
                inArray(appEnvironmentVariables.key, removed)
              )
            );
        }
        for (const { key, value } of variables.filter(({ key }) => changed.includes(key))) {
          const encryptedValue = this.encrypt(value);
          await tx
            .insert(appEnvironmentVariables)
            .values({
              environmentId: env.id,
              key,
              encryptedValue,
              secret: false,
              updatedById: actor.userId,
            })
            .onConflictDoUpdate({
              target: [appEnvironmentVariables.environmentId, appEnvironmentVariables.key],
              set: { encryptedValue, updatedById: actor.userId, updatedAt: new Date() },
            });
        }
      });
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.environment.variables.update',
        resourceType: 'app_environment',
        resourceId: env.id,
        details: { appId: app.id, appName: app.name, environment: env.name, changed, removed },
      });
      this.apps.publish(app.id, 'variables_changed');
    }
    return this.view(env.id);
  }

  async patchSecrets(
    actor: AppActor,
    appId: string,
    environmentId: string,
    input: { set?: Record<string, string>; delete?: string[] }
  ): Promise<AppVariablesView> {
    const { app, env } = await this.authorize(actor, appId, environmentId);
    const set = Object.entries(input.set ?? {});
    const deleted = [...new Set(input.delete ?? [])];
    for (const [key, value] of set) {
      assertKey(key);
      assertValue(key, value);
    }
    for (const key of deleted) assertKey(key);
    const both = set.map(([key]) => key).find((key) => deleted.includes(key));
    if (both) throw new AppError(400, 'APP_VARIABLE_DUPLICATE', `${both} is both set and deleted`);
    const before = await this.rows(env.id);
    const variableKeys = new Set(before.filter((row) => !row.secret).map((row) => row.key));
    const clash = set.map(([key]) => key).find((key) => variableKeys.has(key));
    if (clash) throw new AppError(409, 'APP_SECRET_IS_VARIABLE', `${clash} is already a variable in this environment`);
    const secretKeys = new Set(before.filter((row) => row.secret).map((row) => row.key));
    for (const key of deleted) secretKeys.delete(key);
    for (const [key] of set) secretKeys.add(key);
    if (secretKeys.size + variableKeys.size > APP_VARIABLE_MAX_KEYS) {
      throw new AppError(400, 'APP_VARIABLE_LIMIT', `An environment holds at most ${APP_VARIABLE_MAX_KEYS} keys`);
    }
    if (set.length > 0 || deleted.length > 0) {
      await this.db.transaction(async (tx) => {
        if (deleted.length > 0) {
          await tx
            .delete(appEnvironmentVariables)
            .where(
              and(
                eq(appEnvironmentVariables.environmentId, env.id),
                eq(appEnvironmentVariables.secret, true),
                inArray(appEnvironmentVariables.key, deleted)
              )
            );
        }
        for (const [key, value] of set) {
          const encryptedValue = this.encrypt(value);
          await tx
            .insert(appEnvironmentVariables)
            .values({
              environmentId: env.id,
              key,
              encryptedValue,
              secret: true,
              updatedById: actor.userId,
            })
            .onConflictDoUpdate({
              target: [appEnvironmentVariables.environmentId, appEnvironmentVariables.key],
              set: { encryptedValue, updatedById: actor.userId, updatedAt: new Date() },
            });
        }
      });
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.environment.secrets.update',
        resourceType: 'app_environment',
        resourceId: env.id,
        details: {
          appId: app.id,
          appName: app.name,
          environment: env.name,
          set: set.map(([key]) => key),
          deleted,
        },
      });
      this.apps.publish(app.id, 'variables_changed');
    }
    return this.view(env.id);
  }

  /**
   * A Docker task of a container of this environment (the recreate "Save and recreate" started), so a manager follows
   * it to its end without docker:tasks: { id, status (pending, running, succeeded, failed), progress, error,
   * completedAt }. 404 for a task of anything else.
   */
  async workloadTask(actor: AppActor, appId: string, environmentId: string, taskId: string) {
    const { env } = await this.authorize(actor, appId, environmentId);
    const notFound = () => new AppError(404, 'APP_WORKLOAD_TASK_NOT_FOUND', 'No such task of this environment');
    if (!container.isRegistered(DockerTaskService)) throw notFound();
    const task = await container
      .resolve(DockerTaskService)
      .get(taskId)
      .catch(() => null);
    if (!task?.containerName) throw notFound();
    const ref = await appForMember({ type: 'container', id: task.containerName, nodeId: task.nodeId });
    if (ref?.environmentId !== env.id) throw notFound();
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress ?? null,
      error: task.error ?? null,
      completedAt: task.completedAt ?? null,
    };
  }

  private async authorize(actor: AppActor, appId: string, environmentId: string) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appId);
    const env = await this.apps.getEnvironment(app.id, environmentId);
    assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
    return { app, env };
  }

  private rows(environmentId: string) {
    return this.db
      .select()
      .from(appEnvironmentVariables)
      .where(eq(appEnvironmentVariables.environmentId, environmentId))
      .orderBy(asc(appEnvironmentVariables.key));
  }

  private async view(environmentId: string): Promise<AppVariablesView> {
    const rows = await this.rows(environmentId);
    const layer = await this.layer.resolveLayer(environmentId);
    return {
      variables: rows
        .filter((row) => !row.secret)
        .map((row) => ({ key: row.key, value: this.decrypt(row.encryptedValue) })),
      secrets: rows.filter((row) => row.secret).map((row) => ({ key: row.key, updatedAt: row.updatedAt })),
      pendingWorkloads: await this.layer.pendingWorkloads(environmentId, layer.digest),
    };
  }

  private encrypt(value: string): string {
    return JSON.stringify(this.crypto.encryptString(value));
  }

  private decrypt(encryptedValue: string): string {
    return this.crypto.decryptString(JSON.parse(encryptedValue) as { encryptedKey: string; encryptedDek: string });
  }
}
