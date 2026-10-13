import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';
import {
  inferenceOAuthSessions,
  inferenceProviderConnections,
  inferenceProviderCredentials,
  inferenceProviderSettings,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import type { InferenceCoreBridgeService } from '../core/inference-core-bridge.service.js';
import {
  CORE_ACCOUNT_METADATA_KEY,
  CORE_MANAGED_METADATA_KEY,
  coreOAuthTarget,
} from '../core/inference-core-provider-map.js';
import type { InferenceCredentialVault } from '../inference-credential-vault.js';
import { discoverAntigravityProject } from './inference-antigravity.js';
import { pollCodexDevice } from './inference-codex-device.oauth.js';
import { exchangeGithubCopilotCredential } from './inference-github-copilot.oauth.js';
import type { InferenceProviderRegistry } from './inference-provider.registry.js';
import { nextRoutingOrder } from './inference-provider.service.helpers.js';
import type {
  InferenceCredentialPayload,
  InferenceOAuthRedirectConfig,
  InferenceProviderDefinition,
} from './inference-provider.types.js';

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

interface PendingOAuthPayload {
  verifier?: string;
  deviceCode?: string;
  deviceId?: string;
  deviceAuthId?: string;
  userCode?: string;
  state: string;
  /** Core-backed session marker: the login flow runs inside the managed core. */
  coreManaged?: boolean;
  /** ChatGPT pool login flow id issued by the core (codex-auth). */
  coreFlowId?: string;
}

interface OAuthTokenResult extends InferenceCredentialPayload {
  idToken?: string;
}

interface PendingDevicePoll {
  pending: true;
  pollIntervalSeconds?: number;
}

@injectable()
export class InferenceOAuthService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly vault: InferenceCredentialVault,
    private readonly registry: InferenceProviderRegistry,
    private readonly fetcher: Fetcher = fetch,
    private readonly coreBridge?: InferenceCoreBridgeService
  ) {}

  private async coreReady(): Promise<boolean> {
    return this.coreBridge ? this.coreBridge.coreReady() : false;
  }

  async start(
    userId: string,
    input: { providerId: string; connectionName: string; acceptTerms: boolean; termsVersion?: string }
  ) {
    let provider: InferenceProviderDefinition;
    try {
      provider = this.registry.requireConnectable(input.providerId);
    } catch {
      throw new AppError(400, 'INFERENCE_PROVIDER_NOT_CONNECTABLE', 'Provider is not available for new connections');
    }
    if (!provider.oauth || !provider.authTypes.includes('oauth')) {
      throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider does not support OAuth');
    }
    if (provider.subscription && (!input.acceptTerms || input.termsVersion !== provider.termsVersion)) {
      throw new AppError(
        400,
        'INFERENCE_TERMS_REQUIRED',
        'The current subscription connector terms must be acknowledged'
      );
    }

    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    if (!(await this.coreReady())) {
      throw new AppError(409, 'INFERENCE_CORE_NOT_READY', 'Install the inference core before connecting providers');
    }
    return this.startCoreSession(userId, provider, input, state, expiresAt);
  }

  async status(userId: string, sessionId: string) {
    const session = await this.ownedSession(userId, sessionId);
    if (session.status === 'pending' && session.expiresAt.getTime() <= Date.now()) {
      const [expired] = await this.db
        .update(inferenceOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(inferenceOAuthSessions.id, session.id), eq(inferenceOAuthSessions.status, 'pending')))
        .returning();
      return serializeOAuthSession(expired ?? session);
    }
    if (session.status === 'pending') {
      const core = this.coreSessionPayload(session);
      if (core) return this.pollCoreSession(session, core);
    }
    if (session.status === 'pending' && session.flow === 'device' && (await this.claimDevicePoll(session))) {
      return this.complete(userId, sessionId);
    }
    return serializeOAuthSession(session);
  }

  async cancel(userId: string, sessionId: string) {
    const session = await this.ownedSession(userId, sessionId);
    if (session.status !== 'pending') return serializeOAuthSession(session);
    const core = this.coreSessionPayload(session);
    if (core) {
      // Best-effort: the local session is cancelled regardless of core state.
      try {
        const target = coreOAuthTarget(session.providerId);
        const client = await this.coreBridge!.requireClient();
        if (target?.kind === 'codex-pool') await client.coreCodexLoginCancel(core.coreFlowId);
        else if (target) await client.coreOauthLoginCancel(target.oauthProvider);
      } catch {
        /* core cancel is best-effort */
      }
    }
    const [cancelled] = await this.db
      .update(inferenceOAuthSessions)
      .set({ status: 'cancelled', errorCode: 'oauth_cancelled', errorMessage: null, updatedAt: new Date() })
      .where(and(eq(inferenceOAuthSessions.id, session.id), eq(inferenceOAuthSessions.status, 'pending')))
      .returning();
    return serializeOAuthSession(cancelled ?? session);
  }

  async complete(userId: string, sessionId: string, callbackInput?: string) {
    const session = await this.ownedSession(userId, sessionId);
    if (session.status !== 'pending') return serializeOAuthSession(session);
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.db
        .update(inferenceOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(inferenceOAuthSessions.id, session.id));
      throw new AppError(410, 'INFERENCE_OAUTH_EXPIRED', 'OAuth session expired');
    }

    const core = this.coreSessionPayload(session);
    if (core) return this.completeCoreSession(session, core, callbackInput);

    const provider = this.registry.require(session.providerId);
    if (!provider.oauth) throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider OAuth is unavailable');
    const pending = this.vault.open<PendingOAuthPayload>({
      encryptedPayload: session.encryptedPayload,
      encryptedDek: session.encryptedDek,
      keyVersion: 1,
    });

    let credential: OAuthTokenResult | null;
    try {
      if (provider.oauth.flow === 'redirect') {
        credential = await this.exchangeRedirect(provider.id, provider.oauth, pending, callbackInput);
      } else if (provider.oauth.flow === 'codex_device') {
        if (!pending.deviceAuthId || !pending.userCode) {
          throw new AppError(400, 'INFERENCE_OAUTH_STATE_INVALID', 'OpenAI device session is invalid');
        }
        const response = await pollCodexDevice(
          provider.oauth,
          { deviceAuthId: pending.deviceAuthId, userCode: pending.userCode },
          this.fetcher
        );
        credential = response ? tokenCredential(provider.id, response) : null;
      } else {
        const polled = await this.pollDevice(provider.id, provider.oauth, pending, session.pollIntervalSeconds ?? 5);
        if ('pending' in polled) {
          if (polled.pollIntervalSeconds && polled.pollIntervalSeconds !== session.pollIntervalSeconds) {
            const [updated] = await this.db
              .update(inferenceOAuthSessions)
              .set({ pollIntervalSeconds: polled.pollIntervalSeconds, updatedAt: new Date() })
              .where(eq(inferenceOAuthSessions.id, session.id))
              .returning();
            return serializeOAuthSession(updated ?? session);
          }
          return serializeOAuthSession(session);
        }
        credential = { ...polled, ...(provider.id === 'kimi' ? { deviceId: pending.deviceId } : {}) };
      }
    } catch (error) {
      await this.db
        .update(inferenceOAuthSessions)
        .set({
          status: 'error',
          errorCode: 'oauth_exchange_failed',
          errorMessage: error instanceof Error ? error.message : 'OAuth exchange failed',
          updatedAt: new Date(),
        })
        .where(eq(inferenceOAuthSessions.id, session.id));
      throw error;
    }
    if (!credential) return serializeOAuthSession(session);

    const connectionId = await this.persistConnection(userId, provider.id, session.connectionName, credential);
    await this.db
      .update(inferenceOAuthSessions)
      .set({ status: 'complete', connectionId, updatedAt: new Date() })
      .where(eq(inferenceOAuthSessions.id, session.id));
    return { ...serializeOAuthSession(session), status: 'complete' as const, connectionId };
  }

  async refresh(providerId: string, current: InferenceCredentialPayload): Promise<InferenceCredentialPayload> {
    const refreshToken = current.refreshToken;
    if (!refreshToken)
      throw new AppError(401, 'INFERENCE_OAUTH_REFRESH_REJECTED', 'OAuth refresh token is unavailable');
    if (providerId === 'github-copilot') return exchangeGithubCopilotCredential(refreshToken, this.fetcher);
    const provider = this.registry.require(providerId);
    if (!provider.oauth) throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider OAuth is unavailable');
    let response: JsonObject;
    try {
      response = await this.tokenRequest(
        provider.oauth.tokenUrl,
        provider.oauth.flow === 'redirect' ? provider.oauth.tokenEncoding : 'form',
        {
          grant_type: 'refresh_token',
          client_id: provider.oauth.clientId,
          refresh_token: refreshToken,
          ...(provider.oauth.flow === 'redirect' && provider.oauth.clientSecret
            ? { client_secret: provider.oauth.clientSecret }
            : {}),
        },
        providerId === 'kimi' ? kimiHeaders(current.deviceId ?? randomUUID().replace(/-/g, '')) : undefined
      );
    } catch (error) {
      const upstreamStatus = error instanceof AppError ? asObject(error.details)?.upstreamStatus : undefined;
      if (upstreamStatus === 400 || upstreamStatus === 401 || upstreamStatus === 403) {
        throw new AppError(401, 'INFERENCE_OAUTH_REFRESH_REJECTED', 'Provider rejected the OAuth refresh token');
      }
      throw error;
    }
    const credential = tokenCredential(providerId, response, refreshToken);
    const refreshed = { ...credential, ...(current.deviceId ? { deviceId: current.deviceId } : {}) };
    return providerId === 'google-antigravity'
      ? { ...refreshed, projectId: await discoverAntigravityProject(refreshed.accessToken!, this.fetcher) }
      : refreshed;
  }

  private async exchangeRedirect(
    providerId: string,
    oauth: InferenceOAuthRedirectConfig,
    pending: PendingOAuthPayload,
    callbackInput?: string
  ): Promise<OAuthTokenResult> {
    const parsed = parseCallback(callbackInput);
    if (!parsed.code || !parsed.state || hashState(parsed.state) !== hashState(pending.state)) {
      throw new AppError(400, 'INFERENCE_OAUTH_STATE_INVALID', 'OAuth callback code or state is invalid');
    }
    const response = await this.tokenRequest(oauth.tokenUrl, oauth.tokenEncoding, {
      grant_type: 'authorization_code',
      client_id: oauth.clientId,
      code: parsed.code,
      state: parsed.state,
      redirect_uri: oauth.redirectUri,
      code_verifier: pending.verifier ?? '',
      ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
    });
    const credential = tokenCredential(providerId, response);
    return providerId === 'google-antigravity'
      ? { ...credential, projectId: await discoverAntigravityProject(credential.accessToken!, this.fetcher) }
      : credential;
  }

  private async pollDevice(
    providerId: string,
    oauth: Extract<NonNullable<ReturnType<InferenceProviderRegistry['get']>>['oauth'], { flow: 'device' }>,
    pending: PendingOAuthPayload,
    currentIntervalSeconds: number
  ): Promise<OAuthTokenResult | PendingDevicePoll> {
    const response = await this.fetcher(oauth.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...kimiHeaders(pending.deviceId ?? ''),
        ...oauth.deviceHeaders,
      },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        device_code: pending.deviceCode ?? '',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = asObject(await response.json().catch(() => null));
    const error = stringValue(body?.error);
    if (error === 'authorization_pending') return { pending: true };
    if (error === 'slow_down') {
      const advertised = numberValue(body?.interval);
      return { pending: true, pollIntervalSeconds: Math.max(currentIntervalSeconds + 5, advertised ?? 0) };
    }
    if (!response.ok) {
      throw new AppError(502, 'INFERENCE_OAUTH_EXCHANGE_FAILED', `Provider token exchange failed (${response.status})`);
    }
    const credential = tokenCredential(providerId, body ?? {});
    if (oauth.credentialExchange === 'github-copilot') {
      return exchangeGithubCopilotCredential(credential.accessToken!, this.fetcher);
    }
    return credential;
  }

  private async tokenRequest(
    url: string,
    encoding: 'json' | 'form',
    values: Record<string, string>,
    headers: Record<string, string> = {}
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
            ...headers,
          },
          body: encoding === 'json' ? JSON.stringify(values) : new URLSearchParams(values),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return asObject(await response.json()) ?? {};
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new AppError(
          502,
          'INFERENCE_OAUTH_EXCHANGE_FAILED',
          `Provider token exchange failed (${response.status})`,
          { upstreamStatus: response.status }
        );
        if (!retryable || attempt === 2) throw lastError;
      } catch (error) {
        lastError = error;
        if (error instanceof AppError || attempt === 2) throw error;
      }
    }
    throw lastError;
  }

  private async persistConnection(
    userId: string,
    providerId: string,
    name: string,
    credential: InferenceCredentialPayload
  ): Promise<string> {
    const provider = this.registry.require(providerId);
    const sealed = this.vault.seal(credential);
    const accountExternalId = credential.accountId ?? credential.email?.toLowerCase();
    return this.db.transaction(async (tx) => {
      const existing = accountExternalId
        ? await tx.query.inferenceProviderConnections.findFirst({
            where: and(
              eq(inferenceProviderConnections.providerId, providerId),
              eq(inferenceProviderConnections.accountExternalId, accountExternalId),
              isNull(inferenceProviderConnections.deletedAt)
            ),
          })
        : null;
      if (existing) {
        await tx
          .update(inferenceProviderConnections)
          .set({
            name,
            accountLabel: credential.email,
            baseUrl: provider.baseUrl,
            enabled: true,
            status: 'pending',
            healthReason: null,
            updatedAt: new Date(),
          })
          .where(eq(inferenceProviderConnections.id, existing.id));
        await tx
          .insert(inferenceProviderCredentials)
          .values({
            connectionId: existing.id,
            credentialKind: 'oauth',
            encryptedPayload: sealed.encryptedPayload,
            encryptedDek: sealed.encryptedDek,
            keyVersion: sealed.keyVersion,
            secretLast4: credential.accessToken?.slice(-4),
            expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : undefined,
            refreshedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [inferenceProviderCredentials.connectionId, inferenceProviderCredentials.credentialKind],
            set: {
              encryptedPayload: sealed.encryptedPayload,
              encryptedDek: sealed.encryptedDek,
              keyVersion: sealed.keyVersion,
              secretLast4: credential.accessToken?.slice(-4),
              expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : undefined,
              refreshedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        return existing.id;
      }
      const [lastConnection] = await tx
        .select({ routingOrder: inferenceProviderConnections.routingOrder })
        .from(inferenceProviderConnections)
        .where(isNull(inferenceProviderConnections.deletedAt))
        .orderBy(desc(inferenceProviderConnections.routingOrder))
        .limit(1);
      const [connection] = await tx
        .insert(inferenceProviderConnections)
        .values({
          providerId,
          name,
          authType: 'oauth',
          baseUrl: provider.baseUrl,
          routingOrder: nextRoutingOrder(lastConnection?.routingOrder),
          accountExternalId,
          accountLabel: credential.email,
          createdBy: userId,
        })
        .returning();
      await tx.insert(inferenceProviderCredentials).values({
        connectionId: connection.id,
        credentialKind: 'oauth',
        encryptedPayload: sealed.encryptedPayload,
        encryptedDek: sealed.encryptedDek,
        keyVersion: sealed.keyVersion,
        secretLast4: credential.accessToken?.slice(-4),
        expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : undefined,
      });
      return connection.id;
    });
  }

  // ------------------------------------------------------ core-backed logins
  // Core-backed OAuth: the login flow runs inside the managed core and the
  // credential never crosses into Opfield storage. The Opfield session row
  // still owns browser-facing lifecycle (ownership, expiry, UI polling).

  private async recordProviderTerms(tx: DrizzleTransaction, provider: InferenceProviderDefinition, userId: string) {
    await tx
      .insert(inferenceProviderSettings)
      .values({
        providerId: provider.id,
        ...(provider.subscription
          ? {
              termsAcceptedVersion: provider.termsVersion,
              termsAcceptedAt: new Date(),
              termsAcceptedBy: userId,
            }
          : {}),
      })
      .onConflictDoUpdate({
        target: inferenceProviderSettings.providerId,
        set: provider.subscription
          ? {
              termsAcceptedVersion: provider.termsVersion,
              termsAcceptedAt: new Date(),
              termsAcceptedBy: userId,
              updatedAt: new Date(),
            }
          : { updatedAt: new Date() },
      });
  }

  /** Sealed payload of a core-backed session, or null for legacy sessions. */
  private coreSessionPayload(session: typeof inferenceOAuthSessions.$inferSelect): { coreFlowId?: string } | null {
    const payload = this.vault.open<PendingOAuthPayload>({
      encryptedPayload: session.encryptedPayload,
      encryptedDek: session.encryptedDek,
      keyVersion: 1,
    });
    if (payload.coreManaged !== true) return null;
    return { ...(payload.coreFlowId ? { coreFlowId: payload.coreFlowId } : {}) };
  }

  private async startCoreSession(
    userId: string,
    provider: InferenceProviderDefinition,
    input: { providerId: string; connectionName: string; acceptTerms: boolean; termsVersion?: string },
    state: string,
    expiresAt: Date
  ) {
    const target = coreOAuthTarget(provider.id);
    if (!target) throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider does not support OAuth');
    const client = await this.coreBridge!.requireClient();
    let authorizationUrl: string;
    let completionMode: string;
    let userCode: string | undefined;
    let coreFlowId: string | undefined;
    if (target.kind === 'codex-pool') {
      const started = await client.coreCodexLoginStart({ flow: 'device' }).catch((error: unknown) => {
        throw asCoreOAuthError(error);
      });
      if (!started.url) {
        throw new AppError(502, 'INFERENCE_OAUTH_START_FAILED', 'Core did not return an authorization URL');
      }
      coreFlowId = started.flowId;
      authorizationUrl = started.url;
      userCode = started.deviceCode ?? undefined;
      if (!userCode) {
        throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'Core device response is incomplete');
      }
      completionMode = 'device_poll';
    } else {
      // A provider that already holds accounts must add, not replace, on reconnect.
      const existing = await client.listCoreOauthAccounts(target.oauthProvider).catch(() => null);
      const started = await client
        .coreOauthLoginStart(target.oauthProvider, { addAccount: (existing?.accounts.length ?? 0) > 0 })
        .catch((error: unknown) => {
          throw asCoreOAuthError(error);
        });
      if (!started.url) {
        throw new AppError(502, 'INFERENCE_OAUTH_START_FAILED', 'Core did not return an authorization URL');
      }
      authorizationUrl = started.url;
      if (provider.oauth!.flow === 'device') {
        userCode = typeof started.deviceCode === 'string' && started.deviceCode ? started.deviceCode : undefined;
        if (!userCode) {
          throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'Core device response is incomplete');
        }
        completionMode = 'device_poll';
      } else {
        completionMode = 'paste_callback';
      }
    }
    const sealed = this.vault.seal({
      state,
      coreManaged: true,
      ...(coreFlowId ? { coreFlowId } : {}),
    } satisfies PendingOAuthPayload);
    const [session] = await this.db.transaction(async (tx) => {
      await this.recordProviderTerms(tx, provider, userId);
      return tx
        .insert(inferenceOAuthSessions)
        .values({
          providerId: provider.id,
          userId,
          connectionName: input.connectionName.trim(),
          flow: completionMode === 'device_poll' ? 'device' : 'redirect',
          stateHash: hashState(state),
          encryptedPayload: sealed.encryptedPayload,
          encryptedDek: sealed.encryptedDek,
          authorizationUrl,
          completionMode,
          userCode,
          expiresAt,
        })
        .returning();
    });
    return serializeOAuthSession(session);
  }

  private async completeCoreSession(
    session: typeof inferenceOAuthSessions.$inferSelect,
    core: { coreFlowId?: string },
    callbackInput?: string
  ) {
    const input = callbackInput?.trim();
    if (input) {
      const target = coreOAuthTarget(session.providerId);
      if (!target) throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider does not support OAuth');
      const client = await this.coreBridge!.requireClient();
      try {
        if (target.kind === 'codex-pool') {
          if (!core.coreFlowId) {
            throw new AppError(400, 'INFERENCE_OAUTH_STATE_INVALID', 'Core login flow reference is missing');
          }
          await client.coreCodexLoginCode(core.coreFlowId, input);
        } else {
          await client.coreOauthLoginCode(target.oauthProvider, input);
        }
      } catch (error) {
        const mapped = asCoreOAuthError(error);
        await this.db
          .update(inferenceOAuthSessions)
          .set({
            status: 'error',
            errorCode: 'oauth_exchange_failed',
            errorMessage: mapped.message.slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(inferenceOAuthSessions.id, session.id));
        throw mapped;
      }
    }
    return this.pollCoreSession(session, core);
  }

  private async pollCoreSession(session: typeof inferenceOAuthSessions.$inferSelect, core: { coreFlowId?: string }) {
    const provider = this.registry.require(session.providerId);
    const target = coreOAuthTarget(provider.id);
    if (!target) throw new AppError(400, 'INFERENCE_OAUTH_UNSUPPORTED', 'Provider does not support OAuth');
    const client = await this.coreBridge!.requireClient();
    if (target.kind === 'codex-pool') {
      if (!core.coreFlowId) {
        return this.failCoreSession(session, 'oauth_state_invalid', 'Core login flow reference is missing');
      }
      const status = await client.coreCodexLoginStatus(core.coreFlowId).catch((error: unknown) => {
        throw asCoreOAuthError(error);
      });
      if (!status || status.status === 'expired') {
        const [expired] = await this.db
          .update(inferenceOAuthSessions)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(and(eq(inferenceOAuthSessions.id, session.id), eq(inferenceOAuthSessions.status, 'pending')))
          .returning();
        return serializeOAuthSession(expired ?? session);
      }
      if (status.status === 'error') {
        const existingAccountId = codexPoolAccountId(status.error);
        if (existingAccountId) {
          const accounts = await client.listCoreCodexAccounts().catch(() => null);
          const existingAccount = accounts
            ?.filter((account): account is Record<string, unknown> => Boolean(account) && typeof account === 'object')
            .find((account) => account.id === existingAccountId);
          return this.finalizeCoreSession(session, provider, {
            accountId: existingAccountId,
            ...(typeof existingAccount?.email === 'string' ? { email: existingAccount.email } : {}),
          });
        }
        return this.failCoreSession(session, 'oauth_exchange_failed', status.error ?? 'Core login failed');
      }
      if (status.status === 'done' && status.accountId) {
        return this.finalizeCoreSession(session, provider, { accountId: status.accountId, email: status.email });
      }
      return serializeOAuthSession(session);
    }
    const raw = await client.coreOauthLoginStatus(target.oauthProvider).catch((error: unknown) => {
      throw asCoreOAuthError(error);
    });
    const status = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const errorMessage = typeof status?.error === 'string' ? status.error : undefined;
    if (status?.done === true && errorMessage) {
      return this.failCoreSession(session, 'oauth_exchange_failed', errorMessage);
    }
    if (status?.done === true && status.loggedIn === true) {
      return this.finalizeCoreSession(session, provider, {
        accountId: typeof status.activeAccountId === 'string' ? status.activeAccountId : undefined,
        email: typeof status.email === 'string' ? status.email : undefined,
      });
    }
    return serializeOAuthSession(session);
  }

  private async finalizeCoreSession(
    session: typeof inferenceOAuthSessions.$inferSelect,
    provider: InferenceProviderDefinition,
    identity: { accountId?: string; email?: string }
  ) {
    if (!identity.accountId && !identity.email) {
      return this.failCoreSession(session, 'oauth_identity_missing', 'Core did not report the account identity');
    }
    const connectionId = await this.persistCoreConnection(session.userId, provider, session.connectionName, identity);
    await this.db
      .update(inferenceOAuthSessions)
      .set({ status: 'complete', connectionId, updatedAt: new Date() })
      .where(eq(inferenceOAuthSessions.id, session.id));
    return { ...serializeOAuthSession(session), status: 'complete' as const, connectionId };
  }

  private async failCoreSession(session: typeof inferenceOAuthSessions.$inferSelect, code: string, message: string) {
    const [updated] = await this.db
      .update(inferenceOAuthSessions)
      .set({ status: 'error', errorCode: code, errorMessage: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(inferenceOAuthSessions.id, session.id))
      .returning();
    return serializeOAuthSession(updated ?? session);
  }

  /**
   * Persist the browser-facing connection row for a core-held account. No
   * credential row is written — the secret stays inside the core; a legacy
   * row reconnecting through the core loses its Opfield credential here.
   */
  private async persistCoreConnection(
    userId: string,
    provider: InferenceProviderDefinition,
    name: string,
    identity: { accountId?: string; email?: string }
  ): Promise<string> {
    const accountExternalId = identity.accountId ?? identity.email!.toLowerCase();
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.inferenceProviderConnections.findFirst({
        where: and(
          eq(inferenceProviderConnections.providerId, provider.id),
          eq(inferenceProviderConnections.accountExternalId, accountExternalId),
          isNull(inferenceProviderConnections.deletedAt)
        ),
      });
      if (existing) {
        await tx
          .update(inferenceProviderConnections)
          .set({
            name,
            accountLabel: identity.email ?? existing.accountLabel,
            baseUrl: provider.baseUrl,
            enabled: true,
            status: 'pending',
            healthReason: null,
            metadata: {
              ...existing.metadata,
              [CORE_MANAGED_METADATA_KEY]: true,
              ...(identity.accountId ? { [CORE_ACCOUNT_METADATA_KEY]: identity.accountId } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(inferenceProviderConnections.id, existing.id));
        await tx.delete(inferenceProviderCredentials).where(eq(inferenceProviderCredentials.connectionId, existing.id));
        return existing.id;
      }
      const [lastConnection] = await tx
        .select({ routingOrder: inferenceProviderConnections.routingOrder })
        .from(inferenceProviderConnections)
        .where(isNull(inferenceProviderConnections.deletedAt))
        .orderBy(desc(inferenceProviderConnections.routingOrder))
        .limit(1);
      const [connection] = await tx
        .insert(inferenceProviderConnections)
        .values({
          providerId: provider.id,
          name,
          authType: 'oauth',
          baseUrl: provider.baseUrl,
          routingOrder: nextRoutingOrder(lastConnection?.routingOrder),
          accountExternalId,
          accountLabel: identity.email,
          metadata: {
            [CORE_MANAGED_METADATA_KEY]: true,
            ...(identity.accountId ? { [CORE_ACCOUNT_METADATA_KEY]: identity.accountId } : {}),
          },
          createdBy: userId,
        })
        .returning();
      return connection.id;
    });
  }

  private async ownedSession(userId: string, sessionId: string) {
    const session = await this.db.query.inferenceOAuthSessions.findFirst({
      where: and(eq(inferenceOAuthSessions.id, sessionId), eq(inferenceOAuthSessions.userId, userId)),
    });
    if (!session) throw new AppError(404, 'INFERENCE_OAUTH_NOT_FOUND', 'OAuth session not found');
    return session;
  }

  private async claimDevicePoll(session: typeof inferenceOAuthSessions.$inferSelect): Promise<boolean> {
    const intervalMs = Math.max(1, session.pollIntervalSeconds ?? 5) * 1000;
    const [claimed] = await this.db
      .update(inferenceOAuthSessions)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(inferenceOAuthSessions.id, session.id),
          eq(inferenceOAuthSessions.status, 'pending'),
          lte(inferenceOAuthSessions.updatedAt, new Date(Date.now() - intervalMs))
        )
      )
      .returning({ id: inferenceOAuthSessions.id });
    return Boolean(claimed);
  }
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function codexPoolAccountId(error?: string): string | null {
  const match = error?.match(/account is already in the pool\s*\(([^)]+)\)/i);
  return match?.[1]?.trim() || null;
}

/** Core management rejections surface their message; transport failures stay generic. */
function asCoreOAuthError(error: unknown): Error {
  if (error instanceof AppError) return error;
  if (error instanceof InferenceCoreClientError) {
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
    return new AppError(status, 'INFERENCE_OAUTH_CORE_FAILED', error.message.slice(0, 500));
  }
  return new AppError(502, 'INFERENCE_OAUTH_CORE_FAILED', 'Core OAuth operation failed');
}

function parseCallback(input?: string): { code?: string; state?: string } {
  if (!input) return {};
  try {
    const url = new URL(input);
    return { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined };
  } catch {
    const [code, state] = input.split('#', 2);
    return { code: code || undefined, state: state || undefined };
  }
}

function tokenCredentialFromResponse(body: JsonObject, refreshFallback?: string): OAuthTokenResult {
  const accessToken = stringValue(body.access_token);
  if (!accessToken)
    throw new AppError(502, 'INFERENCE_OAUTH_INVALID_RESPONSE', 'Provider token response has no access token');
  const refreshToken = stringValue(body.refresh_token) ?? refreshFallback;
  const expiresIn = numberValue(body.expires_in) ?? 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 5 * 60_000,
    tokenType: stringValue(body.token_type),
    idToken: stringValue(body.id_token),
  };
}

function tokenCredential(providerId: string, body: JsonObject, refreshFallback?: string): InferenceCredentialPayload {
  const credential = tokenCredentialFromResponse(body, refreshFallback);
  return { ...credential, ...tokenIdentity(providerId, credential) };
}

function tokenIdentity(providerId: string, credential: OAuthTokenResult) {
  const tokens = [credential.idToken, credential.accessToken, credential.refreshToken].filter(
    (token): token is string => typeof token === 'string'
  );
  const payloads = tokens.map(decodeJwt).filter((payload): payload is JsonObject => payload !== null);
  if (providerId === 'openai') {
    const accountId = payloads
      .map((payload) => {
        const namespace = asObject(payload['https://api.openai.com/auth']);
        return stringValue(payload.chatgpt_account_id) ?? stringValue(namespace?.chatgpt_account_id);
      })
      .find(Boolean);
    const email = payloads.map((payload) => stringValue(payload.email)?.toLowerCase()).find(Boolean);
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
  }
  if (providerId === 'kimi') {
    const accountId =
      payloads.map((payload) => stringValue(payload.user_id)).find(Boolean) ??
      payloads.map((payload) => stringValue(payload.sub)).find(Boolean);
    const email = payloads.map((payload) => stringValue(payload.email)?.toLowerCase()).find(Boolean);
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
  }
  const accountId = payloads.map((payload) => stringValue(payload.user_id) ?? stringValue(payload.sub)).find(Boolean);
  const email = payloads.map((payload) => stringValue(payload.email)?.toLowerCase()).find(Boolean);
  return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
}

function decodeJwt(token: string): JsonObject | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return asObject(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function serializeOAuthSession(session: typeof inferenceOAuthSessions.$inferSelect) {
  return {
    id: session.id,
    providerId: session.providerId,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    completionMode: session.completionMode,
    userCode: session.userCode,
    pollIntervalSeconds: session.pollIntervalSeconds,
    connectionId: session.connectionId,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function kimiHeaders(deviceId: string): Record<string, string> {
  return {
    'User-Agent': 'KimiCLI/0.14.0',
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': '0.14.0',
    'X-Msh-Device-Name': os.hostname(),
    'X-Msh-Device-Model': `${os.platform()} ${os.release()} ${os.arch()}`,
    'X-Msh-Os-Version': os.version(),
    'X-Msh-Device-Id': deviceId,
  };
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

export const __testOnly = { hashState, parseCallback, tokenIdentity };
