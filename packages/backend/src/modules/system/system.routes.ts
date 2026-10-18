import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { getEnv } from '@/config/env.js';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { hasScope } from '@/lib/permissions.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { assertNotImpersonating, authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { readStatusPageUpstream } from '@/modules/cloud-link/cloud-link-status-page-upstream.js';
import { entitlementsIncludeFeature } from '@/modules/license/license-features.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { LoggingFeatureService } from '@/modules/logging/logging-feature.service.js';
import {
  browserHostOpfield,
  managedConsoleHostOpfield,
  relayReenrollmentInstallation,
} from '@/modules/nodes/node-installer.js';
import { NodesService } from '@/modules/nodes/nodes.service.js';
import { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import { dispatchNodeDaemonUpdate } from '@/services/daemon-node-update.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { DaemonUpdateRollout } from '@/services/daemon-update-rollout.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { AppEnv } from '@/types.js';
import {
  abandonRelayUpdateRoute,
  acknowledgeSystemUpdateFailureRoute,
  checkDaemonUpdatesRoute,
  checkSystemUpdateRoute,
  DaemonUpdateRequestSchema,
  daemonUpdatesRoute,
  performRelayUpdateRoute,
  performSystemUpdateRoute,
  proceedSystemUpdateRoute,
  releaseNotesForVersionRoute,
  releaseNotesRoute,
  systemConfigRoute,
  systemVersionRoute,
  updateDaemonRoute,
} from './system.docs.js';

const logger = createChildLogger('SystemRoutes');

export const systemRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

systemRoutes.use('*', authMiddleware);

function requireUpdateScope(c: any) {
  if (!hasScope(c.get('effectiveScopes') || [], 'admin:update')) {
    return c.json({ message: 'Missing required scope: admin:update' }, 403);
  }
  return null;
}

// GET /version — current version + cached update status (any authenticated user)
systemRoutes.openapi(systemVersionRoute, async (c) => {
  const updateService = container.resolve(UpdateService);
  const status = await updateService.getCachedStatus();
  return c.json({ data: status });
});

systemRoutes.openapi(systemConfigRoute, async (c) => {
  const service = container.resolve(GeneralSettingsService);
  const loggingFeature = container.resolve(LoggingFeatureService);
  const [config, license] = await Promise.all([
    service.getConfig(),
    container.resolve(LicensePolicyService).getSummary(),
  ]);
  const canViewOpfieldSettings = hasScope(c.get('effectiveScopes') || [], 'settings:opfield:view');
  return c.json({
    data: {
      fileUploadMaxBytes: config.fileUploadMaxBytes,
      fileOpenMaxBytes: config.fileOpenMaxBytes,
      grpcPublicTarget: canViewOpfieldSettings ? config.grpcPublicTarget : null,
      grpcLocalIp: canViewOpfieldSettings ? config.grpcLocalIp : null,
      relayAutoRecovery: canViewOpfieldSettings ? config.relayAutoRecovery : false,
      ...(canViewOpfieldSettings ? { relay: config.relay } : {}),
      features: {
        ...config.features,
        // The switches default to on; a plan without the feature reports them off.
        pkiEnabled:
          config.features.pkiEnabled && entitlementsIncludeFeature(license.entitlements.features, 'internal-pki'),
        siemEnabled:
          config.features.siemEnabled && entitlementsIncludeFeature(license.entitlements.features, 'siem-export'),
        loggingEnabled: loggingFeature.isEnabled(),
      },
    },
  });
});

// The status page upstream as it is in use, for the read-only field of a managed cloud installation.
systemRoutes.get('/status-page-upstream', requireScope('status-page:view'), async (c) => {
  return c.json({ data: await readStatusPageUpstream(getEnv().OPFIELD_CONSOLE_DOMAIN) });
});

systemRoutes.post('/relay/recovery', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const data = await container.resolve(RelaySupervisorService).retryRecovery(user.id);
  return c.json({ data });
});

systemRoutes.get('/relay', requireScope('settings:opfield:view'), async (c) => {
  const local = container.resolve(RelaySupervisorService).getSnapshot(true);
  const pool = container.isRegistered(RelayPoolService)
    ? await container.resolve(RelayPoolService).getSnapshot()
    : null;
  const data = pool ? { ...local, ...pool, local } : local;
  return c.json({ data });
});

systemRoutes.post('/relay/rebalance', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const data = await container.resolve(RelayPoolService).stageRebalance(user.id);
  return c.json({ data }, data.some(({ state }) => state === 'staging') ? 202 : 200);
});

systemRoutes.post('/relay/instances/:instanceId/drain', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  const body = z.object({ confirm: z.literal(true) }).parse(await c.req.json());
  void body;
  await container.resolve(RelayPoolService).drainInstance(instanceId, user.id, true);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

systemRoutes.post('/relay/instances/:instanceId/resume', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  await container.resolve(RelayPoolService).drainInstance(instanceId, user.id, false);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

systemRoutes.post('/relay/instances/:instanceId/force-disconnect', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  const body = z.object({ confirm: z.literal(true) }).parse(await c.req.json());
  void body;
  await container.resolve(RelayPoolService).forceDisconnectInstance(instanceId, user.id);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

// Relay settings an admin changes: whether availability witnesses (database/storage sets) may run on this relay.
systemRoutes.patch('/relay/instances/:instanceId', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  const body = z
    .object({ witnessHostingAllowed: z.boolean() })
    .strict()
    .parse(await c.req.json());
  const pool = container.resolve(RelayPoolService);
  await pool.setWitnessHosting(instanceId, body.witnessHostingAllowed, user.id);
  const snapshot = await pool.getSnapshot();
  const instance = snapshot.instances.find((candidate) => candidate.id === instanceId);
  if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
  return c.json({ data: instance });
});

// Moves a remote relay to another TCP port in the background: its streams leave, its supervisor restarts it on the
// port, it returns to the pool. 202 once it began; the relay's portChange follows it (a failure stays there).
systemRoutes.post('/relay/instances/:instanceId/service-port', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  const body = z
    .object({ servicePort: z.number().int().min(1).max(65535) })
    .strict()
    .parse(await c.req.json());
  const pool = container.resolve(RelayPoolService);
  await pool.changeInstanceServicePort(instanceId, body.servicePort, user.id);
  return c.json({ data: await pool.getSnapshot() }, 202);
});

// Re-enrollment token for an enrolled remote relay; the relay installer run with it repairs the relay.
systemRoutes.post('/relay/instances/:instanceId/reenroll', requireScope('admin:system'), async (c) => {
  // The single-use enrollment token outlives the impersonation session.
  assertNotImpersonating(c, 'Relay re-enrollment tokens cannot be issued while impersonating');
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  z.object({ confirm: z.literal(true) }).parse(await c.req.json());
  const issued = await container.resolve(RelayPoolService).issueRelayReenrollment(instanceId, user.id);
  const nodesService = container.resolve(NodesService);
  const opfieldCertSha256 = await nodesService.getOpfieldEnrollmentCertificateFingerprint();
  const opfieldEnrollmentTargets = await nodesService.getOpfieldEnrollmentTargets();
  return c.json({
    data: {
      ...issued,
      opfieldCertSha256,
      opfieldEnrollmentTargets,
      ...(await relayReenrollmentInstallation(
        issued,
        opfieldCertSha256,
        opfieldEnrollmentTargets,
        (await managedConsoleHostOpfield()) ??
          browserHostOpfield(c.req.header('x-forwarded-host') ?? c.req.header('host'))
      )),
    },
  });
});

// Renews a remote relay's server certificate now instead of waiting for the hourly check.
systemRoutes.post('/relay/instances/:instanceId/renew-certificate', requireScope('admin:system'), async (c) => {
  const user = c.get('user')!;
  const instanceId = z.string().uuid().parse(c.req.param('instanceId'));
  await container.resolve(RelayPoolService).renewInstanceCertificate(instanceId, user.id);
  return c.json({ data: await container.resolve(RelayPoolService).getSnapshot() });
});

// POST /check-update — manual check against GitLab (admin only)
systemRoutes.openapi(checkSystemUpdateRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const updateService = container.resolve(UpdateService);
  const status = await updateService.checkForUpdates();
  // A manual check must not end the update screens of an update that is still running.
  const updateRunning = await updateService.isAnyUpdateRunning();
  container
    .resolve(EventBusService)
    .publish(
      'system.update.changed',
      updateRunning ? { statusChanged: true } : { updating: false, component: 'opfield', statusChanged: true }
    );
  return c.json({ data: status });
});

// POST /update — trigger self-update (admin only)
systemRoutes.openapi(performSystemUpdateRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const body = await c.req.json();
  const { version } = z
    .object({
      version: z.string().regex(RELEASE_VERSION_PATTERN, 'Invalid version format'),
    })
    .parse(body);

  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);
  if (updateService.isOpfieldUpdateInProgress()) {
    return c.json({ code: 'UPDATE_IN_PROGRESS', message: 'An Opfield update is already in progress' }, 409);
  }
  // A running Relay Pool update refuses the Opfield update with a 409.
  await updateService.assertOpfieldUpdateAllowed();

  // Verify update is actually available and version matches
  const status = await updateService.getCachedStatus();
  if (!status.updateAvailable) {
    return c.json({ code: 'NO_UPDATE', message: 'No update available' }, 400);
  }
  if (version !== status.latestVersion) {
    return c.json({ code: 'VERSION_MISMATCH', message: 'Requested version does not match available update' }, 400);
  }
  const artifact = await updateService.prepareOpfieldUpdate(version);
  const userId = c.get('user')?.id ?? null;
  // A new attempt supersedes the report of a previous rolled-back one.
  await updateService.acknowledgeOpfieldUpdateFailure();

  // Respond immediately, then trigger the update asynchronously.
  // The container will be replaced — the response must be sent first.
  eventBus.publish('system.update.changed', {
    updating: true,
    component: 'opfield',
    targetVersion: version,
  });
  setTimeout(() => {
    updateService.performUpdate(version, artifact, userId).catch((err) => {
      // A concurrent request lost the race; the accepted update keeps running.
      if (err instanceof AppError && err.code === 'UPDATE_IN_PROGRESS') return;
      eventBus.publish('system.update.changed', {
        updating: false,
        component: 'opfield',
        targetVersion: version,
        // Only curated messages; raw migration output stays in the server log.
        ...(err instanceof AppError ? { error: err.message } : {}),
      });
      logger.error('Update failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }, 500);

  return c.json({ data: { status: 'updating', targetVersion: version } });
});

// POST /update/proceed — stop waiting for running orchestration operations (admin only)
systemRoutes.openapi(proceedSystemUpdateRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const updateService = container.resolve(UpdateService);
  if (!updateService.proceedWithoutWaiting()) {
    return c.json({ code: 'UPDATE_NOT_WAITING', message: 'No Opfield update is waiting for running operations' }, 409);
  }
  logger.warn('Opfield update proceeds without waiting for running operations', { userId: c.get('user')?.id });
  return c.json({ data: { status: 'updating' } });
});

// POST /update/acknowledge — stop reporting an Opfield update that was rolled back (admin only)
systemRoutes.openapi(acknowledgeSystemUpdateFailureRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const acknowledged = await container.resolve(UpdateService).acknowledgeOpfieldUpdateFailure();
  return c.json({ data: { acknowledged } });
});

systemRoutes.openapi(performRelayUpdateRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const { version } = z
    .object({ version: z.string().regex(RELEASE_VERSION_PATTERN, 'Invalid version format') })
    .parse(await c.req.json());
  const updateService = container.resolve(UpdateService);
  const eventBus = container.resolve(EventBusService);
  if (updateService.isOpfieldUpdateInProgress()) {
    return c.json(
      {
        code: 'OPFIELD_UPDATE_IN_PROGRESS',
        message: 'Opfield is updating. Update the Relay Pool after the Opfield update has finished.',
      },
      409
    );
  }
  const status = await updateService.getCachedStatus();
  if (!status.relay.updateAvailable || !status.relay.latestVersion) {
    return c.json({ code: 'NO_UPDATE', message: 'No relay update available' }, 400);
  }
  if (version !== status.relay.latestVersion) {
    return c.json(
      { code: 'VERSION_MISMATCH', message: 'Requested version does not match available relay update' },
      400
    );
  }
  const artifact = await updateService.prepareRelayUpdate(version);
  const userId = c.get('user')!.id;
  updateService.startRelayUpdate(version);
  eventBus.publish('system.update.changed', { updating: true, component: 'relay', targetVersion: version });
  setTimeout(() => {
    updateService
      .performRelayUpdate(version, artifact, userId)
      .then(() => updateService.completeRelayUpdate())
      .then(() => updateService.checkForUpdates())
      .then(() => {
        eventBus.publish('system.update.changed', { updating: false, component: 'relay', targetVersion: version });
      })
      .catch((err) => {
        updateService.failRelayUpdate(err);
        eventBus.publish('system.update.changed', { updating: false, component: 'relay', targetVersion: version });
        logger.error('Relay update failed', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
  }, 500);
  return c.json({ data: { status: 'updating', targetVersion: version } });
});

// POST /relay-update/abandon — fail a stuck or paused Relay Pool update (admin only)
systemRoutes.openapi(abandonRelayUpdateRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const data = await container.resolve(UpdateService).abandonRelayUpdate(c.get('user')!.id);
  const eventBus = container.resolve(EventBusService);
  eventBus.publish('system.update.changed', {
    updating: false,
    component: 'relay',
    targetVersion: data.targetVersion,
    statusChanged: true,
  });
  eventBus.publish('system.relay.health.changed', { poolId: 'system', action: 'update_abandoned' });
  return c.json({ data });
});

// GET /release-notes/:version — fetch release notes for a specific version
systemRoutes.openapi({ ...releaseNotesForVersionRoute, middleware: requireScope('admin:update') }, async (c) => {
  const version = c.req.param('version')!;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    return c.json({ code: 'INVALID_VERSION', message: 'Invalid version format' }, 400);
  }
  const updateService = container.resolve(UpdateService);
  try {
    const notes = await updateService.getReleaseNotes(version);
    return c.json({ data: { version, notes } });
  } catch {
    return c.json({ code: 'FETCH_FAILED', message: `Failed to fetch release notes for ${version}` }, 502);
  }
});

// GET /release-notes — fetch release notes for all versions between current and latest
systemRoutes.openapi({ ...releaseNotesRoute, middleware: requireScope('admin:update') }, async (c) => {
  const updateService = container.resolve(UpdateService);
  const status = await updateService.getCachedStatus();
  if (!status.latestVersion || !status.updateAvailable) {
    return c.json({ data: [] });
  }
  try {
    const notes = await updateService.getReleaseNotesSince(status.currentVersion, status.latestVersion);
    return c.json({ data: notes });
  } catch {
    // Fallback to cached latest release notes
    return c.json({ data: status.releaseNotes ? [{ version: status.latestVersion, notes: status.releaseNotes }] : [] });
  }
});

// ── Daemon Updates ──────────────────────────────────────────────────

// GET /daemon-updates — list update status for all daemon types
systemRoutes.openapi({ ...daemonUpdatesRoute, middleware: requireScope('admin:update') }, async (c) => {
  const service = container.resolve(DaemonUpdateService);
  const data = await service.getCachedStatus();
  return c.json({ data });
});

// POST /daemon-updates/check — force re-check daemon updates
systemRoutes.openapi(checkDaemonUpdatesRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const service = container.resolve(DaemonUpdateService);
  const data = await service.checkForUpdates();
  return c.json({ data });
});

// POST /daemon-updates/:nodeId — trigger update for a specific node
systemRoutes.openapi(updateDaemonRoute, async (c) => {
  const forbidden = requireUpdateScope(c);
  if (forbidden) return forbidden;
  const { NodeDispatchService } = await import('@/services/node-dispatch.service.js');
  const { TOKENS } = await import('@/container.js');
  const { now } = DaemonUpdateRequestSchema.parse((await c.req.json().catch(() => null)) ?? {});
  const data = await dispatchNodeDaemonUpdate(
    c.req.param('nodeId')!,
    {
      db: container.resolve(TOKENS.DrizzleClient),
      daemonUpdateService: container.resolve(DaemonUpdateService),
      dispatch: container.resolve(NodeDispatchService),
      rollout: container.resolve(DaemonUpdateRollout),
    },
    { now: now === true }
  );
  return c.json({ data });
});
