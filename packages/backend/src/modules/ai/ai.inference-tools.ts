import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { InferenceUsageService } from '@/modules/inference/accounting/inference-usage.service.js';
import { coreUpdateInputSchema, coreVersionInputSchema } from '@/modules/inference/core/inference-core.routes.js';
import { InferenceCoreRuntimeService } from '@/modules/inference/core/inference-core-runtime.service.js';
import {
  CompleteInferenceOAuthSchema,
  CreateInferenceProviderConnectionSchema,
  CreateInferenceTokenSchema,
  InferenceActivityQuerySchema,
  InferenceLimitPolicyInputSchema,
  InferenceModelConfigurationSchema,
  ReorderInferenceModelsSchema,
  StartInferenceOAuthSchema,
  UpdateInferenceProviderConnectionSchema,
  UpdateInferenceProviderRoutingSchema,
  UpdateInferenceTokenSchema,
} from '@/modules/inference/inference.schemas.js';
import { InferenceTokenService } from '@/modules/inference/inference-token.service.js';
import { InferenceModelService } from '@/modules/inference/models/inference-model.service.js';
import { InferenceModelConfigurationService } from '@/modules/inference/models/inference-model-configuration.service.js';
import {
  assertConnectionNotCloudManaged,
  assertModelNotCloudManaged,
  inferenceCloudDb,
  isRoutingOrderOnly,
} from '@/modules/inference/providers/inference-cloud.js';
import { InferenceOAuthService } from '@/modules/inference/providers/inference-oauth.service.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';

export const INFERENCE_TOOL_NAMES = new Set([
  'manage_inference_provider',
  'manage_inference_model',
  'manage_inference_limits',
  'manage_inference_token',
  'manage_inference_usage',
]);

const CORE_OPERATIONS = new Set(['core_status', 'core_check_updates', 'core_install', 'core_update', 'core_repair']);

export async function executeInferenceTool(
  user: User,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // The core lifecycle routes stay reachable while inference is disabled, so the core can be installed first.
  const coreOperation = toolName === 'manage_inference_provider' && CORE_OPERATIONS.has(String(args.operation));
  if (!coreOperation) await requireInferenceEnabled();
  // Every inference management route requires feat:ai:use on the account (requireAccountScope).
  await requireAccountAiUse(user);
  if (coreOperation) return manageCore(user, args);
  if (toolName === 'manage_inference_provider') return manageProvider(user, args);
  if (toolName === 'manage_inference_model') return manageModel(user, args);
  if (toolName === 'manage_inference_limits') return manageLimits(user, args);
  if (toolName === 'manage_inference_token') return manageToken(user, args);
  if (toolName === 'manage_inference_usage') return manageUsage(user, args);
  throw new Error(`Unsupported inference tool: ${toolName}`);
}

async function manageCore(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceCoreRuntimeService);
  if (operation === 'core_status') {
    requireScope(user, 'inference:providers:view');
    return service.getStatus();
  }
  requireScope(user, 'inference:providers:manage');
  if (operation === 'core_install') {
    return { operation: await service.install(coreVersionInputSchema.parse({ version: args.coreVersion }).version) };
  }
  if (operation === 'core_update') {
    return { operation: await service.update(coreUpdateInputSchema.parse({ version: args.coreVersion }).version) };
  }
  if (operation === 'core_repair') return { operation: await service.repair() };
  // Same response shape as POST /inference/core/check-updates.
  const latest = await service.checkForUpdates();
  return {
    latest: latest
      ? {
          version: latest.version,
          digest: latest.digest,
          sizeBytes: latest.sizeBytes,
          releaseNotesUrl: latest.releaseNotesUrl,
        }
      : null,
  };
}

async function manageUsage(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceUsageService);
  if (operation === 'self' || operation === 'self_overview') {
    requireScope(user, 'feat:ai:use');
    return operation === 'self' ? service.self(user) : service.selfOverview(user);
  }
  requireScope(user, 'inference:usage:view');
  if (operation === 'system') return service.adminOverview();
  if (operation === 'users') return service.users();
  if (operation === 'activity_filters') return service.activityFilters();
  if (operation === 'activity') {
    return service.activity(
      InferenceActivityQuerySchema.parse({
        page: args.page,
        limit: args.limit,
        search: args.search,
        status: args.status,
        userId: args.userId,
        model: args.model,
      })
    );
  }
  throw new Error(`Unsupported inference usage operation: ${operation}`);
}

async function manageProvider(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceProviderService);
  if (operation === 'list_templates') {
    requireScope(user, 'inference:providers:view');
    return service.listCatalog();
  }
  if (operation === 'list_connections') {
    requireScope(user, 'inference:providers:view');
    return service.listConnections();
  }
  requireScope(user, 'inference:providers:manage');
  if (operation === 'connect_api_key') {
    return service.createKeyConnection(
      user.id,
      CreateInferenceProviderConnectionSchema.parse({
        providerId: args.providerId,
        name: args.name,
        authType: args.authType,
        apiKey: args.apiKey,
        baseUrl: args.baseUrl,
        allowPrivateNetwork: args.allowPrivateNetwork,
      })
    );
  }
  if (operation === 'start_authorization') {
    return container.resolve(InferenceOAuthService).start(
      user.id,
      StartInferenceOAuthSchema.parse({
        providerId: args.providerId,
        connectionName: args.connectionName,
        acceptTerms: args.acceptTerms,
        termsVersion: args.termsVersion,
      })
    );
  }
  if (operation === 'authorization_status') {
    const session = await container
      .resolve(InferenceOAuthService)
      .status(user.id, requiredString(args.sessionId, 'sessionId'));
    if (session.status === 'complete' && session.connectionId) {
      await service.syncConnection(session.connectionId, true);
    }
    return session;
  }
  if (operation === 'complete_authorization') {
    const input = CompleteInferenceOAuthSchema.parse({ callback: args.callback });
    const session = await container
      .resolve(InferenceOAuthService)
      .complete(user.id, requiredString(args.sessionId, 'sessionId'), input.callback);
    if (session.status === 'complete' && session.connectionId) {
      await service.syncConnection(session.connectionId, true);
    }
    return session;
  }
  if (operation === 'cancel_authorization') {
    return container.resolve(InferenceOAuthService).cancel(user.id, requiredString(args.sessionId, 'sessionId'));
  }
  if (operation === 'sync') {
    return service.syncConnection(requiredString(args.connectionId, 'connectionId'), true);
  }
  if (operation === 'update') {
    const apiMonthlyLimitMicrodollars =
      args.apiMonthlyLimitUsd === undefined
        ? undefined
        : args.apiMonthlyLimitUsd === null
          ? null
          : usdToMicrodollars(args.apiMonthlyLimitUsd);
    const input = UpdateInferenceProviderConnectionSchema.parse({
      enabled: args.enabled,
      name: args.name,
      routingOrder: args.routingOrder,
      minimumRemainingPercent: args.minimumRemainingPercent,
      apiMonthlyLimitMicrodollars,
    });
    const connectionId = requiredString(args.connectionId, 'connectionId');
    // The Opfield Cloud connection is the account's: only its place in the order changes here.
    if (!isRoutingOrderOnly(input)) await assertConnectionNotCloudManaged(inferenceCloudDb(), connectionId);
    return service.updateConnection(user.id, connectionId, input);
  }
  if (operation === 'set_routing') {
    const input = UpdateInferenceProviderRoutingSchema.parse({ routingStrategy: args.routingStrategy });
    return service.setRoutingStrategy(user.id, requiredString(args.providerId, 'providerId'), input.routingStrategy);
  }
  if (operation === 'disconnect') {
    const connectionId = requiredString(args.connectionId, 'connectionId');
    await assertConnectionNotCloudManaged(inferenceCloudDb(), connectionId);
    await service.disconnect(user.id, connectionId);
    return { success: true };
  }
  throw new Error(`Unsupported inference provider operation: ${operation}`);
}

async function manageModel(user: User, args: Record<string, unknown>) {
  requireScope(user, 'inference:models:manage');
  const operation = requiredString(args.operation, 'operation');
  if (operation === 'list') return container.resolve(InferenceModelService).listAdmin();
  if (operation === 'suggestions') {
    return container.resolve(InferenceModelService).suggestions(requiredString(args.modelId, 'modelId'));
  }
  if (operation === 'save') {
    const configuration = InferenceModelConfigurationSchema.parse(args.configuration);
    const modelId = optionalString(args.modelId);
    await assertModelNotCloudManaged(inferenceCloudDb(), modelId);
    return container.resolve(InferenceModelConfigurationService).save(user.id, modelId, configuration);
  }
  if (operation === 'reorder') {
    const input = ReorderInferenceModelsSchema.parse({ items: args.items });
    await container.resolve(InferenceModelService).reorder(user.id, input.items);
    return { success: true };
  }
  if (operation === 'delete') {
    const modelId = requiredString(args.modelId, 'modelId');
    await assertModelNotCloudManaged(inferenceCloudDb(), modelId);
    await container.resolve(InferenceModelService).remove(user.id, modelId);
    return { success: true };
  }
  throw new Error(`Unsupported inference model operation: ${operation}`);
}

async function manageLimits(user: User, args: Record<string, unknown>) {
  requireScope(user, 'inference:limits:manage');
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceUsageService);
  if (operation === 'list_policies') return service.listPolicies();
  if (operation === 'list_users') return service.limitUsers();
  if (operation === 'set_default') {
    return service.setDefault(user.id, InferenceLimitPolicyInputSchema.parse(args.policy));
  }
  if (operation === 'set_user') {
    return service.setUser(
      user.id,
      requiredString(args.userId, 'userId'),
      InferenceLimitPolicyInputSchema.parse(args.policy)
    );
  }
  if (operation === 'remove_user') {
    await service.removeUser(user.id, requiredString(args.userId, 'userId'));
    return { success: true };
  }
  if (operation === 'reset_user') {
    return service.resetUserLimits(user.id, requiredString(args.userId, 'userId'));
  }
  throw new Error(`Unsupported inference limits operation: ${operation}`);
}

async function manageToken(user: User, args: Record<string, unknown>) {
  const operation = requiredString(args.operation, 'operation');
  const service = container.resolve(InferenceTokenService);
  if (operation === 'list') {
    requireScope(user, 'feat:ai:use');
    return service.listTokens(user.id);
  }
  if (operation === 'create') {
    requireScope(user, 'feat:ai:use');
    return service.createToken(
      user.id,
      CreateInferenceTokenSchema.parse({ name: args.name, expiresAt: args.expiresAt, allowedIps: args.allowedIps })
    );
  }
  if (operation === 'update') {
    requireScope(user, 'feat:ai:use');
    return service.updateToken(
      user.id,
      requiredString(args.tokenId, 'tokenId'),
      UpdateInferenceTokenSchema.parse({ name: args.name, expiresAt: args.expiresAt, allowedIps: args.allowedIps })
    );
  }
  if (operation === 'revoke') {
    requireScope(user, 'feat:ai:use');
    await service.revokeToken(user.id, requiredString(args.tokenId, 'tokenId'));
    return { success: true };
  }
  throw new Error(`Unsupported inference token operation: ${operation}`);
}

async function requireInferenceEnabled(): Promise<void> {
  if (!(await container.resolve(GeneralSettingsService).isFeatureEnabled('inferenceEnabled'))) {
    throw new Error(
      'Inference is disabled for this Opfield installation. An administrator can enable generalSettings.features.inferenceEnabled.'
    );
  }
}

/**
 * Mirrors requireAccountScope('feat:ai:use'): feat:ai:use is delegable, but a
 * remote MCP token does not have to carry this account baseline itself, so the
 * owner's live account scopes decide when the token-bounded scopes lack it.
 */
async function requireAccountAiUse(user: User): Promise<void> {
  if (hasScope(user.scopes, 'feat:ai:use')) return;
  const account = container.isRegistered(AuthService)
    ? await container.resolve(AuthService).getUserById(user.id)
    : null;
  if (!account || account.isBlocked || !hasScope(account.scopes, 'feat:ai:use')) {
    throw new Error('PERMISSION_DENIED: feat:ai:use is required');
  }
}

function requireScope(user: User, scope: string): void {
  if (!hasScope(user.scopes, scope)) throw new Error(`PERMISSION_DENIED: ${scope} is required`);
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usdToMicrodollars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('apiMonthlyLimitUsd must be a non-negative number or null');
  }
  const result = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error('apiMonthlyLimitUsd is too large');
  return result;
}
