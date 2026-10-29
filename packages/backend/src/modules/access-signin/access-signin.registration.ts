import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { createChildLogger } from '@/lib/logger.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { CacheService } from '@/services/cache.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import { decideAccess } from './access-decision.js';
import { AccessIdentityProviderService } from './access-identity-providers.service.js';
import { configureAccessPolicySync, scheduleAccessPolicySync, syncAccessPolicyNow } from './access-policy-sync.js';
import { AccessServiceTokenService } from './access-service-tokens.service.js';
import { AccessSessionService, DrizzleAccessSessionStore } from './access-sessions.service.js';
import { DrizzleAccessSignInDirectory } from './access-signin-directory.js';
import { AccessSignInExternalService } from './access-signin-external.service.js';
import { AccessSignInFlowService } from './access-signin-flow.service.js';
import { AccessSignInSettingsService } from './access-signin-settings.service.js';
import { AccessSigningKeyService } from './access-signing-key.service.js';
import { DrizzleAccessSigningKeyStore } from './access-signing-key-store.js';

const logger = createChildLogger('AccessSignIn');

export interface AccessSignInRegistration {
  db: DrizzleClient;
  cryptoService: CryptoService;
  cacheService: CacheService;
  auditService: AuditService;
  eventBus: EventBusService;
  proxyService: ProxyService;
  nodeRegistry: NodeRegistryService;
  nodeDispatch: NodeDispatchService;
  publicUrl: () => Promise<string | null>;
}

/** Builds the access sign-in services, registers them and wires the policy sync to the nginx nodes. */
export function registerAccessSignIn(deps: AccessSignInRegistration): void {
  const { db } = deps;
  const settings = new AccessSignInSettingsService(db, deps.publicUrl, deps.auditService);
  settings.setSystemHostRuntime(deps.proxyService);
  const keys = new AccessSigningKeyService(new DrizzleAccessSigningKeyStore(db), deps.cryptoService);
  const sessionStore = new DrizzleAccessSessionStore(db);
  const sessions = new AccessSessionService(db, sessionStore, deps.auditService);
  const tokens = new AccessServiceTokenService(db, deps.auditService);
  const providers = new AccessIdentityProviderService(
    db,
    deps.cryptoService,
    () => settings.signInOrigin(),
    deps.auditService
  );
  const directory = new DrizzleAccessSignInDirectory(db);
  const flow = new AccessSignInFlowService({ directory, sessions: sessionStore, keys, settings, decide: decideAccess });
  const external = new AccessSignInExternalService(
    flow,
    providers,
    directory,
    deps.cacheService,
    () => settings.signInOrigin(),
    async () => {
      const publicUrl = await deps.publicUrl();
      if (!publicUrl) throw new Error('Opfield has no public URL yet');
      return new URL(publicUrl).origin;
    }
  );

  container.registerInstance(AccessSignInSettingsService, settings);
  container.registerInstance(AccessSigningKeyService, keys);
  container.registerInstance(AccessSessionService, sessions);
  container.registerInstance(AccessServiceTokenService, tokens);
  container.registerInstance(AccessIdentityProviderService, providers);
  container.registerInstance(AccessSignInFlowService, flow);
  container.registerInstance(AccessSignInExternalService, external);

  configureAccessPolicySync({ db, keys, settings, registry: deps.nodeRegistry, dispatch: deps.nodeDispatch });

  // An Opfield account that is blocked, deleted, or changed its email or permission groups loses its visitor sessions
  // at once: their tokens carry the old identity. The next sign-in through the console carries the current one.
  deps.eventBus.subscribe('user.changed', (payload) => {
    const userId = (payload as { id?: unknown } | null)?.id;
    if (typeof userId !== 'string') return;
    void sessions
      .revokeChangedOpfieldSessions(userId, directory)
      .then((count) => {
        if (count > 0) scheduleAccessPolicySync();
      })
      .catch((error) => logger.warn('Could not end the access sessions of a changed account', { userId, error }));
  });
}

/**
 * The periodic access sign-in job: rotates the signing key when due, deletes long-ended sessions and pushes the
 * policy when its content changed since every node last got it (a node that missed a change gets it here).
 */
export async function runAccessSignInMaintenance(): Promise<void> {
  if (!container.isRegistered(AccessSigningKeyService)) return;
  await container.resolve(AccessSigningKeyService).rotateIfDue();
  await container.resolve(AccessSessionService).cleanup();
  await syncAccessPolicyNow({ onlyIfChanged: true });
}
