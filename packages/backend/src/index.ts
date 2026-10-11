import 'reflect-metadata';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ManagedStorageTunnelProxy } from '@/modules/storage/managed-storage-tunnel-proxy.js';
// Must be first — set up environment and reflection metadata
import 'dotenv/config';

import { serve } from '@hono/node-server';

// Import services to ensure decorators are processed
import '@/services/cache.service.js';
import '@/services/session.service.js';
import '@/modules/auth/auth.service.js';

import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { createApp } from '@/app.js';
import { container, initializeContainer } from '@/bootstrap.js';
import { getEnv } from '@/config/env.js';
import { TOKENS } from '@/container.js';
import { acceptedOperations } from '@/edition/accepted-operations.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { RelayControlClient } from '@/grpc/relay-control.client.js';
import { startGrpcServer, stopGrpcServer } from '@/grpc/server.js';
import { closeApplicationLogger, logger } from '@/lib/logger.js';
import { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import { AISandboxRunnerService } from '@/modules/ai/ai.sandbox-runner.service.js';
import { AIRunService } from '@/modules/ai/ai-run.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { AuthEmailQueueService } from '@/modules/auth/auth-email-queue.service.js';
import { CloudLinkAgent } from '@/modules/cloud-link/cloud-link-agent.js';
import { CloudLinkEnrollFile } from '@/modules/cloud-link/cloud-link-enroll-file.js';
import { ManagedDatabaseTunnelProxy } from '@/modules/databases/managed-database-tunnel-proxy.js';
import { PostgresProbe } from '@/modules/diagnostics/postgres-probe.js';
import { AvailabilityLeaseService } from '@/modules/docker/availability/lease/availability-lease.service.js';
import { DockerMigrationService } from '@/modules/docker/docker-migration.service.js';
import { DockerSnapshotReconciler } from '@/modules/docker/docker-snapshot-reconciler.service.js';
import { InferenceReservationReconciler } from '@/modules/inference/accounting/inference-reservation-reconciler.js';
import { inferenceCoreInternalRoutes } from '@/modules/inference/core/inference-core-internal.routes.js';
import { INFERENCE_CORE_INTERNAL_PORT } from '@/modules/inference/core/inference-core-runtime.service.js';
import { InferenceProviderService } from '@/modules/inference/providers/inference-provider.service.js';
import { LoggingClickHouseService } from '@/modules/logging/logging-clickhouse.service.js';
import { LoggingMetadataService } from '@/modules/logging/logging-metadata.service.js';
import { NotificationEvaluatorService } from '@/modules/notifications/notification-evaluator.service.js';
import { CAService } from '@/modules/pki/ca.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';
import { AvailabilityMembersService } from '@/services/availability-members.service.js';
import { closeDataStoresAfterWrites } from '@/services/background-writes.js';
import type { RedisClient } from '@/services/cache.service.js';
import { CryptoService } from '@/services/crypto.service.js';
import { GatewayLifecycleService } from '@/services/gateway-lifecycle.service.js';
import { GrpcIdentityService } from '@/services/grpc-identity.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { NodeRegistryService } from '@/services/node-registry.service.js';
import { waitForOrchestrationIdle } from '@/services/orchestration-activity.js';
import { ReadModelCoordinator } from '@/services/read-model-coordinator.service.js';
import { RelayIdentityProvisionerService } from '@/services/relay-identity-provisioner.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayStartupFinalizerService } from '@/services/relay-startup-finalizer.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { RelayWitnessService } from '@/services/relay-witness.service.js';
import { SchedulerService } from '@/services/scheduler.service.js';
import { ShutdownCoordinator, waitForShutdownTasks } from '@/services/shutdown-coordinator.service.js';
import { markShuttingDown } from '@/services/shutdown-state.js';
import { SystemCAService } from '@/services/system-ca.service.js';
import { WebIdentityService } from '@/services/web-identity.service.js';
import { WebTransportSettingsService } from '@/services/web-transport-settings.service.js';
import { drainWebSocketsForRestart, terminateRemainingWebSockets } from '@/services/websocket-shutdown.js';

/**
 * Apply pending migrations on one dedicated connection. A session advisory lock keeps two starting instances from
 * applying the same migrations, and PostgreSQL 14+ aborts the migration transaction soon after this process dies
 * instead of finishing the running statement while it holds its locks.
 */
async function runMigrations(databaseUrl: string) {
  logger.info('Running database migrations...');
  const client = new pg.Client({ connectionString: databaseUrl });
  // A lost connection fails the running migration step, which reports it; unhandled, the event would end the process.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<{ version: number }>(
      "select current_setting('server_version_num')::int as version"
    );
    if (rows[0].version >= 140000) await client.query("set client_connection_check_interval = '5s'");
    await client.query("select pg_advisory_lock(hashtext('gateway-migrations'))");
    await migrate(drizzle(client), { migrationsFolder: resolve('src/db/migrations') });
  } finally {
    await client.end();
  }
  logger.info('Database migrations completed');
}

/** Shutdown work that only waits for running orchestration, which durable recovery resumes after a restart. */
const RESUMABLE_SHUTDOWN_WORK = new Set(['orchestration', 'commercial_drain']);
/** How long the commercial module may still close once running orchestration was left to recovery. */
const ABANDONED_WORK_CLOSE_MS = 1_000;
/** Shutdown work that takes longer than this is named in the log with its duration. */
const SLOW_SHUTDOWN_WORK_MS = 2_000;
/** A client that does not answer the close frame by then is cut. */
const WEBSOCKET_CLOSE_WAIT_MS = 2_000;

type GatewayWebSocketServer = ReturnType<typeof createApp>['wss'];

function closeWebSocketServer(wss: GatewayWebSocketServer): Promise<void> {
  return new Promise((resolvePromise) => {
    wss.close(() => resolvePromise());
  });
}

function closeHttpServer(server: ReturnType<typeof serve>, deadline: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const connectionServer = server as typeof server & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    server.close(finish);
    connectionServer.closeIdleConnections?.();
    if (settled) return;
    timer = setTimeout(
      () => {
        connectionServer.closeAllConnections?.();
        finish();
      },
      Math.max(0, deadline - Date.now())
    );
    timer.unref?.();
  });
}

function startInferenceCoreInternalServer(): Promise<ReturnType<typeof serve>> {
  return new Promise((resolvePromise, reject) => {
    const server = serve(
      {
        fetch: inferenceCoreInternalRoutes.fetch,
        port: INFERENCE_CORE_INTERNAL_PORT,
        hostname: '0.0.0.0',
      },
      () => {
        server.off('error', reject);
        resolvePromise(server);
      }
    );
    server.once('error', reject);
  });
}

async function main() {
  try {
    const env = getEnv();

    logger.info('Starting Gateway API...', {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
    });

    // Run database migrations before anything else
    await runMigrations(env.DATABASE_URL);

    // Initialize dependency injection container
    await initializeContainer();
    const commercialEdition = container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition);

    const statusPageService = container.resolve(StatusPageService);
    await statusPageService.primePublicHost();
    // The local relay's state and an outage the previous process saw, before the API or a node reads them: started
    // during an outage, Gateway reports and handles it from its first answer, not after the relay startup.
    await container.resolve(RelaySupervisorService).restore();

    // Create the Hono app
    const { app, injectWebSocket, wss } = createApp();

    // Start exactly one web protocol on the public port. Native HTTPS uses a
    // dedicated leaf issued by the existing Gateway system CA.
    const webTransport = await container.resolve(WebTransportSettingsService).getConfig();
    const server = webTransport.tlsEnabled
      ? await (async () => {
          const identity = await container.resolve(WebIdentityService).resolve();
          return serve({
            fetch: app.fetch,
            port: env.PORT,
            hostname: env.BIND_HOST,
            createServer: createHttpsServer,
            serverOptions: {
              cert: await readFile(identity.certPath),
              key: await readFile(identity.keyPath),
            },
          });
        })()
      : serve({
          fetch: app.fetch,
          port: env.PORT,
          hostname: env.BIND_HOST,
        });
    // Lets identity renewal switch the HTTPS listener to a renewed certificate without a restart.
    if (webTransport.tlsEnabled) container.resolve(WebIdentityService).attachServer(server);

    // Inject WebSocket support into the HTTP server
    injectWebSocket(server);

    // Internal core → Gateway callback listener (admission/settlement). Bound
    // inside the container only; the port is never published to the host, so
    // just the installer-managed Compose network can reach it.
    const coreInternalServer = await startInferenceCoreInternalServer();
    logger.info(`Inference core internal listener on 0.0.0.0:${INFERENCE_CORE_INTERNAL_PORT}`);
    const lifecycle = container.resolve(GatewayLifecycleService);
    server.prependListener('request', (request, response) =>
      lifecycle.trackHttpRequest(request, response, statusPageService.isCachedStatusHost(request.headers.host))
    );

    const webScheme = webTransport.tlsEnabled ? 'https' : 'http';
    logger.info(`Server running at ${webScheme}://${env.BIND_HOST}:${env.PORT}`);
    logger.info(`API Documentation at ${webScheme}://localhost:${env.PORT}/docs`);

    // Start gRPC server for daemon communication
    const registry = container.resolve(NodeRegistryService);
    const dispatch = container.resolve(NodeDispatchService);
    const auditService = container.resolve(AuditService);
    // Audit rows the previous process kept locally because postgres stopped before its drain (host shutdown, M-7).
    void auditService.replaySpooledRows().catch((error) => logger.warn('Replaying kept audit rows failed', { error }));
    const caService = container.resolve(CAService);
    const cryptoService = container.resolve(CryptoService);
    const db = container.resolve(TOKENS.DrizzleClient) as any;
    const systemCA = container.resolve(SystemCAService);
    const grpcIdentity = await container.resolve(GrpcIdentityService).resolve();
    const relayIdentity = env.GATEWAY_RELAY_REQUIRED
      ? await container.resolve(RelayIdentityProvisionerService).ensure()
      : null;
    const relayPolicy = env.GATEWAY_RELAY_REQUIRED ? container.resolve(RelayPolicyService) : undefined;

    await startGrpcServer(
      env.GRPC_PORT,
      relayIdentity?.internalServerCertPath ?? grpcIdentity.certPath,
      relayIdentity?.internalServerKeyPath ?? grpcIdentity.keyPath,
      {
        registry,
        dispatch,
        auditService,
        db,
        caService,
        cryptoService,
        systemCA,
        relayPeerFingerprint: relayIdentity?.relayClientFingerprint,
        relayPolicy,
        availabilityLease: container.resolve(AvailabilityLeaseService),
        relayWitness: container.resolve(RelayWitnessService),
        availabilityMembers: container.resolve(AvailabilityMembersService),
      }
    );
    registry.startAcceptingConnections();
    const relayFinalization = await container.resolve(RelayStartupFinalizerService).finalize();
    if (relayFinalization.status === 'degraded') {
      logger.error('Gateway relay startup finalization did not reach readiness', relayFinalization);
    } else if (relayFinalization.status === 'active') {
      logger.info('Gateway relay startup finalization completed', relayFinalization);
    }
    await container.resolve(RelaySupervisorService).start();

    // Start background jobs
    const sandboxRunner = container.resolve(AISandboxRunnerService);
    try {
      await sandboxRunner.health();
    } catch (err) {
      logger.warn('Sandbox runner is unavailable at startup', { err });
    }

    const scheduler = container.resolve(SchedulerService);
    scheduler.start();
    container.resolve(CloudLinkAgent).start();
    container.resolve(CloudLinkEnrollFile).start();
    await commercialEdition.start();

    let userDrainPromises: Promise<unknown>[] = [];
    // Running orchestration the stop left to durable recovery: the commercial module is not waited for.
    let resumableWorkAbandoned = false;
    let loggingClosePromise: Promise<void> | null = null;
    let forceUserPromise: Promise<void> | null = null;
    const pendingShutdownWork = new Set<string>();
    // Names unsettled shutdown work, so a drain that times out says what it waited for, and work that held the
    // stop for long, so a slow stop says what it waited for even when it finished in time.
    const shutdownWork = <T>(name: string, task: Promise<T>): Promise<T> => {
      pendingShutdownWork.add(name);
      const startedAt = Date.now();
      const settle = () => {
        pendingShutdownWork.delete(name);
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_SHUTDOWN_WORK_MS) logger.info('Slow shutdown work settled', { name, durationMs });
      };
      task.then(settle, settle);
      return task;
    };
    const settleShutdownTask = async (name: string, task: Promise<unknown>): Promise<void> => {
      try {
        await shutdownWork(name, task);
      } catch (error) {
        logger.warn('Shutdown task failed', { name, error });
      }
    };
    const shutdown = new ShutdownCoordinator({
      lifecycle,
      getSettings: () => container.resolve(GeneralSettingsService).getCachedShutdownSettings(),
      hooks: {
        freezeStatusPage: () => shutdownWork('status_page_freeze', statusPageService.freezePublicSnapshot()),
        quiesce: async () => {
          userDrainPromises = [
            shutdownWork('commercial_quiesce', commercialEdition.quiesce()),
            shutdownWork(
              'ai_sandbox_policy_reconciliation',
              container.resolve(AISandboxService).stopPolicyReconciliation()
            ),
            shutdownWork('scheduler', scheduler.stop()),
            shutdownWork('cloud_link', container.resolve(CloudLinkAgent).stop()),
            shutdownWork('cloud_link_enroll_file', container.resolve(CloudLinkEnrollFile).stop()),
            // B-14: holder changes still waiting for their takeover time are audited with the best time known.
            shutdownWork(
              'availability_lease_takeover_audit',
              container.resolve(AvailabilityLeaseService).flushTakeoverAudits()
            ),
            shutdownWork('relay_supervisor', container.resolve(RelaySupervisorService).stop()),
            shutdownWork('notification_evaluator', container.resolve(NotificationEvaluatorService).stop()),
            shutdownWork('inference_providers', container.resolve(InferenceProviderService).stop()),
            shutdownWork('inference_reservations', container.resolve(InferenceReservationReconciler).stop()),
            shutdownWork('docker_snapshots', container.resolve(DockerSnapshotReconciler).stop()),
            shutdownWork('docker_migrations', container.resolve(DockerMigrationService).stop()),
            shutdownWork('read_models', container.resolve(ReadModelCoordinator).stop()),
          ];
        },
        drainUserWork: async (deadline) => {
          await Promise.allSettled([
            ...userDrainPromises,
            shutdownWork('commercial_drain', commercialEdition.drain(deadline)),
            shutdownWork('ai_runs', container.resolve(AIRunService).waitForIdle(deadline)),
          ]);
        },
        drainOrchestration: async (deadline) => {
          const result = await shutdownWork(
            'orchestration',
            waitForOrchestrationIdle(commercialEdition, { scope: 'running', deadline })
          );
          return result.operations.reduce((total, operation) => total + operation.count, 0);
        },
        pendingWork: () => [...pendingShutdownWork],
        resumableWorkOnly: async () => {
          // Everything else settled; what is left is the wait for running orchestration and the requests on it.
          if ([...pendingShutdownWork].some((name) => !RESUMABLE_SHUTDOWN_WORK.has(name))) return false;
          const activity = await commercialEdition.activeOrchestrationOperations();
          const running = (activity ?? []).reduce((total, operation) => total + Math.max(0, operation.running), 0);
          return running > 0 && lifecycle.getActiveCount('user') <= running;
        },
        abandonResumableWork: () => {
          resumableWorkAbandoned = true;
          acceptedOperations.abandonRunning();
        },
        forceCloseUserWork: async () => {
          forceUserPromise ??= shutdownWork(
            'force_close_user_work',
            Promise.all([commercialEdition.forceClose(), container.resolve(AIRunService).stopAllForShutdown()]).then(
              () => undefined
            )
          );
          await forceUserPromise;
        },
        closeLogging: async () => {
          loggingClosePromise ??= (async () => {
            await settleShutdownTask('logging_metadata', container.resolve(LoggingMetadataService).close());
            logger.info('Logging metadata queue close completed');
            await settleShutdownTask('clickhouse', container.resolve(LoggingClickHouseService).close());
            logger.info('ClickHouse close completed');
          })();
          await loggingClosePromise;
        },
        closeHttp: async (deadline) => {
          // Keep established sessions alive through the expensive drain phases.
          // Signal restart only at the final transport shutdown boundary.
          await drainWebSocketsForRestart(wss.clients, Math.min(deadline, Date.now() + WEBSOCKET_CLOSE_WAIT_MS));
          terminateRemainingWebSockets(wss.clients);
          await closeWebSocketServer(wss);
          await closeHttpServer(server, deadline);
          if (coreInternalServer) await closeHttpServer(coreInternalServer, deadline);
          logger.info('HTTP server closed');
        },
        finalize: async (deadline) => {
          container.resolve(ObjectStorageMonitoringService).destroy();
          container.resolve(ObjectStorageService).shutdown();
          const storageTunnelShutdown = container.resolve(ManagedStorageTunnelProxy).shutdown();
          const databaseTunnelShutdown = container.resolve(ManagedDatabaseTunnelProxy).shutdown();
          const independentFinalizers = [
            settleShutdownTask('managed_storage_tunnel', storageTunnelShutdown),
            settleShutdownTask('managed_database_tunnel', databaseTunnelShutdown),
            settleShutdownTask('auth_email_queue', container.resolve(AuthEmailQueueService).close()),
            settleShutdownTask(
              'relay_control_client',
              Promise.resolve().then(() => {
                if (env.GATEWAY_RELAY_REQUIRED) container.resolve(RelayControlClient).close();
              })
            ),
            settleShutdownTask(
              'relay_tunnel_worker',
              // After the tunnel proxies let go of their endpoints: the worker's connections and streams end with it.
              Promise.allSettled([storageTunnelShutdown, databaseTunnelShutdown]).then(() =>
                env.GATEWAY_RELAY_REQUIRED ? container.resolve(RelayPolicyService).closeGatewayTunnels() : undefined
              )
            ),
          ];
          const drainsSettled = await waitForShutdownTasks(
            [
              ...userDrainPromises,
              ...(forceUserPromise ? [forceUserPromise] : []),
              ...(loggingClosePromise ? [loggingClosePromise] : []),
            ],
            deadline
          );
          if (!drainsSettled) {
            throw new Error(
              `Active shutdown work did not release its dependencies before the hard deadline: ${[...pendingShutdownWork].join(', ')}`
            );
          }

          await Promise.all([
            ...independentFinalizers,
            settleShutdownTask(
              'commercial_module',
              // Abandoned orchestration would hold the close until the hard deadline: it ends with the process.
              commercialEdition.close(
                resumableWorkAbandoned ? Math.min(deadline, Date.now() + ABANDONED_WORK_CLOSE_MS) : deadline
              )
            ),
            settleShutdownTask('grpc', stopGrpcServer(Math.min(3000, Math.max(0, deadline - Date.now())))),
            settleShutdownTask(
              'sandbox_runner',
              sandboxRunner.stop(Math.min(5_000, Math.max(0, deadline - Date.now() - 250)))
            ),
          ]);
          // Node streams closed by the gRPC stop and the modules that just closed still write their
          // last rows (node.disconnected audit, relay instance state): the stores close after them.
          await closeDataStoresAfterWrites({
            deadline,
            onUnsettled: (pendingWrites) =>
              logger.warn('Background writes still running when the data stores close', { pendingWrites }),
            closeRedis: async () => {
              const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
              await settleShutdownTask('redis', redis.quit());
              logger.info('Redis close completed');
            },
            closeDatabase: async () => {
              const database = container.resolve(TOKENS.DrizzleClient) as any;
              await settleShutdownTask(
                'postgres',
                Promise.all([database.$client?.end?.(), container.resolve(PostgresProbe).close()])
              );
              logger.info('Database pool close completed');
            },
          });
        },
        closeApplicationLogger: (deadline) => closeApplicationLogger(Math.max(0, deadline - Date.now())),
      },
      exit: (code) => process.exit(code),
    });

    const requestShutdown = (signal: NodeJS.Signals) => {
      // From here on, losing postgres or redis is an expected shutdown condition (N-19).
      markShuttingDown();
      void shutdown.request(signal);
    };
    process.on('SIGTERM', requestShutdown);
    process.on('SIGINT', requestShutdown);
  } catch (error) {
    logger.error('Failed to start server', {
      error,
      message: (error as Error)?.message,
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  }
}

main();
