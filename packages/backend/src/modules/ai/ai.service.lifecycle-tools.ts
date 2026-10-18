import { z } from 'zod';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import type { CommercialEditionRuntime } from '@/edition/runtime.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import { IdParamSchema } from '@/lib/openapi.js';
import { hasScope, hasScopeBase } from '@/lib/permissions.js';
import { RELEASE_VERSION_PATTERN } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { AlertService } from '@/modules/audit/alert.service.js';
import { AuditExportSchema } from '@/modules/audit/audit.docs.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { publicUrlFallbackOpfield, relayReenrollmentInstallation } from '@/modules/nodes/node-installer.js';
import { dispatchNodeDaemonUpdate } from '@/services/daemon-node-update.js';
import { DaemonUpdateService } from '@/services/daemon-update.service.js';
import { DaemonUpdateRollout } from '@/services/daemon-update-rollout.service.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { RelayPolicyService } from '@/services/relay-policy.service.js';
import { RelayPoolService } from '@/services/relay-pool.service.js';
import { RelaySupervisorService } from '@/services/relay-supervisor.service.js';
import { UpdateService } from '@/services/update.service.js';
import type { User } from '@/types.js';
import { manageDockerContainerConfigTool } from './ai.docker-config-tools.js';
import { getInternalDocumentation } from './ai.docs.js';
import { manageLoggingTool } from './ai.logging-tools.js';
import { AIServiceAdministrationTools } from './ai.service.administration-tools.js';
import { logger, type ToolRuntimeContext, UNHANDLED_TOOL } from './ai.service.runtime-helpers.js';
import { agentPage, agentPageLimit, dashboardStatsOptionsForScopes } from './ai.service-helpers.js';
import { manageStatusPageTool } from './ai.status-page-tools.js';
import { executeWebSearch } from './ai.web-search.js';

export class AIServiceLifecycleTools extends AIServiceAdministrationTools {
  protected async executeLifecycleTool(
    user: User,
    toolName: string,
    args: Record<string, unknown>,
    runtimeContext: ToolRuntimeContext
  ): Promise<unknown> {
    const a = args as any;
    switch (toolName) {
      case 'manage_system_updates': {
        const operation = String(a.operation ?? '');
        const updateService = container.resolve(UpdateService);
        switch (operation) {
          case 'get_opfield_status':
            return updateService.getCachedStatus();
          case 'check_opfield': {
            const status = await updateService.checkForUpdates();
            // Like POST /system/check-update: a manual check must not end the screens of a running update.
            const updateRunning = await updateService.isAnyUpdateRunning();
            container
              .resolve(EventBusService)
              .publish(
                'system.update.changed',
                updateRunning ? { statusChanged: true } : { updating: false, component: 'opfield', statusChanged: true }
              );
            return status;
          }
          case 'get_opfield_release_notes': {
            const version = String(a.version ?? '');
            if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('version must be a semantic version');
            return { version, notes: await updateService.getReleaseNotes(version) };
          }
          case 'list_opfield_release_notes': {
            // GET /system/release-notes: every release between the running and the available version.
            const status = await updateService.getCachedStatus();
            if (!status.latestVersion || !status.updateAvailable) return [];
            try {
              return await updateService.getReleaseNotesSince(status.currentVersion, status.latestVersion);
            } catch {
              return status.releaseNotes ? [{ version: status.latestVersion, notes: status.releaseNotes }] : [];
            }
          }
          // The update operations mirror the /system update routes step for step.
          case 'perform_opfield_update': {
            const version = releaseVersionArg(a.version);
            if (updateService.isOpfieldUpdateInProgress()) {
              throw new AppError(409, 'UPDATE_IN_PROGRESS', 'An Opfield update is already in progress');
            }
            // A running Relay Pool update refuses the Opfield update.
            await updateService.assertOpfieldUpdateAllowed();
            const status = await updateService.getCachedStatus();
            if (!status.updateAvailable) throw new Error('No Opfield update is available');
            if (version !== status.latestVersion) throw new Error('Requested version does not match available update');
            const artifact = await updateService.prepareOpfieldUpdate(version);
            // A new attempt supersedes the report of a previous rolled-back one.
            await updateService.acknowledgeOpfieldUpdateFailure();
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', { updating: true, component: 'opfield', targetVersion: version });
            setTimeout(() => {
              updateService.performUpdate(version, artifact, user.id).catch((error) => {
                // A concurrent request lost the race; the accepted update keeps running.
                if (error instanceof AppError && error.code === 'UPDATE_IN_PROGRESS') return;
                eventBus.publish('system.update.changed', {
                  updating: false,
                  component: 'opfield',
                  targetVersion: version,
                  ...(error instanceof AppError ? { error: error.message } : {}),
                });
                logger.error('Opfield update failed from AI tool', {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                });
              });
            }, 500);
            return { status: 'updating', targetVersion: version };
          }
          case 'proceed_opfield_update': {
            if (!updateService.proceedWithoutWaiting()) {
              throw new AppError(409, 'UPDATE_NOT_WAITING', 'No Opfield update is waiting for running operations');
            }
            logger.warn('Opfield update proceeds without waiting for running operations', { userId: user.id });
            return { status: 'updating' };
          }
          case 'acknowledge_opfield_update_failure':
            return { acknowledged: await updateService.acknowledgeOpfieldUpdateFailure() };
          case 'perform_relay_update': {
            const version = releaseVersionArg(a.version);
            if (updateService.isOpfieldUpdateInProgress()) {
              throw new AppError(
                409,
                'OPFIELD_UPDATE_IN_PROGRESS',
                'Opfield is updating. Update the Relay Pool after the Opfield update has finished.'
              );
            }
            const status = await updateService.getCachedStatus();
            if (!status.relay.updateAvailable || !status.relay.latestVersion) {
              throw new AppError(400, 'NO_UPDATE', 'No relay update available');
            }
            if (version !== status.relay.latestVersion) {
              throw new AppError(400, 'VERSION_MISMATCH', 'Requested version does not match available relay update');
            }
            const artifact = await updateService.prepareRelayUpdate(version);
            updateService.startRelayUpdate(version);
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', { updating: true, component: 'relay', targetVersion: version });
            setTimeout(() => {
              updateService
                .performRelayUpdate(version, artifact, user.id)
                .then(() => updateService.completeRelayUpdate())
                .then(() => updateService.checkForUpdates())
                .then(() => {
                  eventBus.publish('system.update.changed', {
                    updating: false,
                    component: 'relay',
                    targetVersion: version,
                  });
                })
                .catch((error) => {
                  updateService.failRelayUpdate(error);
                  eventBus.publish('system.update.changed', {
                    updating: false,
                    component: 'relay',
                    targetVersion: version,
                  });
                  logger.error('Relay update failed from AI tool', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                  });
                });
            }, 500);
            return { status: 'updating', targetVersion: version };
          }
          case 'abandon_relay_update': {
            const data = await updateService.abandonRelayUpdate(user.id);
            const eventBus = container.resolve(EventBusService);
            eventBus.publish('system.update.changed', {
              updating: false,
              component: 'relay',
              targetVersion: data.targetVersion,
              statusChanged: true,
            });
            eventBus.publish('system.relay.health.changed', { poolId: 'system', action: 'update_abandoned' });
            return data;
          }
          case 'list_daemon_updates':
            return container.resolve(DaemonUpdateService).getCachedStatus();
          case 'check_daemon_updates':
            return container.resolve(DaemonUpdateService).checkForUpdates();
          case 'update_daemon': {
            const nodeId = String(a.nodeId ?? '');
            if (!nodeId) throw new Error('nodeId is required');
            // Same as POST /system/daemon-updates/:nodeId: `now` skips (or ends) the wait for the node's long tasks and lease peers.
            return dispatchNodeDaemonUpdate(
              nodeId,
              {
                db: container.resolve<DrizzleClient>(TOKENS.DrizzleClient),
                daemonUpdateService: container.resolve(DaemonUpdateService),
                dispatch: container.resolve(NodeDispatchService),
                rollout: container.resolve(DaemonUpdateRollout),
              },
              { now: a.now === true }
            );
          }
          default:
            throw new Error('Unsupported system update operation');
        }
      }
      case 'manage_relay_pool':
        return this.executeRelayPoolTool(user, a);
      case 'manage_system_alerts': {
        // Same broad admin:alerts scope as the /alerts routes.
        this.ensureToolScope(user, 'admin:alerts');
        const alertService = container.resolve(AlertService);
        if (a.operation === 'list') return alertService.getAlerts();
        if (a.operation === 'dismiss') {
          const { id } = IdParamSchema.parse({ id: a.alertId });
          await alertService.dismissAlert(id);
          return { success: true, message: 'Alert dismissed' };
        }
        throw new Error(`Unsupported system alert operation: ${String(a.operation)}`);
      }
      case 'get_audit_log':
        return this.executeAuditLogTool(a);
      case 'get_dashboard_stats': {
        const stats = await this.monitoringService.getDashboardStats({
          ...dashboardStatsOptionsForScopes(user.scopes),
          // Same gate as GET /monitoring/dashboard?showSystem=true.
          showSystem: a.showSystem === true && hasScope(user.scopes, 'admin:details:certificates'),
        });
        // Filter stats by user's read scopes — don't leak data they can't access
        const filtered: Record<string, unknown> = {};
        if (hasScopeBase(user.scopes, 'proxy:view')) filtered.proxyHosts = stats.proxyHosts;
        if (hasScopeBase(user.scopes, 'ssl:cert:view')) filtered.sslCertificates = stats.sslCertificates;
        if (hasScopeBase(user.scopes, 'pki:cert:view')) filtered.pkiCertificates = stats.pkiCertificates;
        if (hasScope(user.scopes, 'pki:ca:view')) filtered.cas = stats.cas;
        if (hasScopeBase(user.scopes, 'nodes:details')) filtered.nodes = stats.nodes;
        if (Object.keys(filtered).length === 0) {
          return {
            message:
              'You do not have permission to view any dashboard statistics. Contact an administrator to get read access to resources.',
          };
        }
        return filtered;
      }

      case 'set_resource_pin':
        return {
          clientAction: {
            type: 'set_resource_pin',
            resourceType: a.resourceType,
            resourceId: a.resourceId,
            target: a.target,
            pinned: a.pinned,
            nodeId: a.nodeId,
            nodeSlug: a.nodeSlug,
            name: a.name,
            scopeResourceId: a.scopeResourceId,
          },
        };

      case 'open_node_enrollment':
        return {
          clientAction: {
            type: 'open_node_enrollment',
          },
        };

      case 'open_connector_setup':
        return {
          clientAction: {
            type: 'open_connector_setup',
            connector: a.connector,
            baseUrl: a.baseUrl,
            repositoryUrl: a.repositoryUrl,
            host: a.host,
          },
        };

      case 'manage_docker_container_config':
        return manageDockerContainerConfigTool({ dockerService: this.dockerService }, user, args);

      case 'manage_logging':
        return manageLoggingTool(user, args);
      case 'manage_status_page':
        return manageStatusPageTool(user, args);

      // ── Ask Question (handled client-side, backend just passes through) ──
      case 'ask_question':
        return { _askQuestion: true, question: a.question, options: a.options, allowFreeText: a.allowFreeText };

      case 'enter_plan_mode':
      case 'submit_plan':
      case 'submit_plan_review':
      case 'start_plan_execution':
      case 'update_plan_step':
      case 'pause_plan_execution':
      case 'resume_plan_execution':
      case 'finalize_plan_execution':
      case 'submit_plan_verification': {
        const planning = container.isRegistered(TOKENS.CommercialEdition)
          ? container.resolve<CommercialEditionRuntime>(TOKENS.CommercialEdition).planning
          : undefined;
        if (!planning) return commercialModuleUnavailable();
        return planning.executeTool(this.planService, user, toolName, args, runtimeContext.conversationId);
      }

      // ── Documentation ──
      case 'internal_documentation':
        return getInternalDocumentation(a.topic, user.scopes);
      case 'read_opfield_documentation':
        return getInternalDocumentation(a.topic, [...user.scopes, 'mcp:use']);

      // ── Web Search ──
      case 'web_search':
        return executeWebSearch(this.settingsService, a.query, a.maxResults || 5);

      default:
        return UNHANDLED_TOOL;
    }
  }

  /** Mirrors GET /audit, GET /audit/users and the licensed POST /audit/export. */
  private async executeAuditLogTool(a: Record<string, any>): Promise<unknown> {
    const view = String(a.view ?? 'entries');
    if (view === 'users') return this.auditService.getAuditUsers();
    const filters = {
      actions: [...stringList(a.actions), ...stringList(a.action)],
      resourceTypes: [...stringList(a.resourceTypes), ...stringList(a.resourceType)],
      userIds: stringList(a.userIds),
      excludedActions: stringList(a.excludedActions),
      excludedResourceTypes: stringList(a.excludedResourceTypes),
      from: auditDateArg(a.from),
      to: auditDateArg(a.to),
    };
    if (view === 'export') {
      // LICENSE ENFORCEMENT: the audit export operation requires the audit-export feature, like the route.
      await container.resolve(LicensePolicyService).requireFeature('audit-export');
      const input = AuditExportSchema.parse({
        actions: filters.actions,
        resourceTypes: filters.resourceTypes,
        userIds: filters.userIds,
        excludedActions: filters.excludedActions,
        excludedResourceTypes: filters.excludedResourceTypes,
        from: a.from,
        to: a.to,
      });
      return this.auditService.getAuditExport({ ...input, from: filters.from, to: filters.to });
    }
    if (view !== 'entries') throw new Error(`Unsupported audit log view: ${view}`);
    return this.auditService.getAuditLog({
      ...filters,
      page: agentPage(a.page),
      limit: Math.min(agentPageLimit(a.limit), 100),
    });
  }

  /** Mirrors the /system/relay routes: reads need settings:opfield:view, every mutation admin:system. */
  private async executeRelayPoolTool(user: User, a: Record<string, any>): Promise<unknown> {
    const operation = String(a.operation ?? '');
    if (operation === 'get') {
      this.ensureToolScope(user, 'settings:opfield:view');
      const local = container.resolve(RelaySupervisorService).getSnapshot(true);
      const pool = container.isRegistered(RelayPoolService)
        ? await container.resolve(RelayPoolService).getSnapshot()
        : null;
      return pool ? { ...local, ...pool, local } : local;
    }
    if (operation === 'local_policy_trust_status') {
      this.ensureToolScope(user, 'settings:opfield:view');
      // Registered only when Opfield runs a local relay.
      const status = container.isRegistered(RelayPolicyService)
        ? container.resolve(RelayPolicyService).getLocalPolicyTrustStatus()
        : null;
      return { localPolicyTrust: status };
    }
    this.ensureToolScope(user, 'admin:system');
    switch (operation) {
      case 'retry_recovery':
        return container.resolve(RelaySupervisorService).retryRecovery(user.id);
      case 'rebalance':
        return container.resolve(RelayPoolService).stageRebalance(user.id);
      case 'drain_instance':
      case 'resume_instance':
      case 'force_disconnect_instance': {
        const instanceId = z.string().uuid().parse(a.instanceId);
        const relayPool = container.resolve(RelayPoolService);
        if (operation === 'resume_instance') {
          await relayPool.drainInstance(instanceId, user.id, false);
        } else {
          // The drain and force-disconnect routes require an explicit { confirm: true } body.
          z.object({ confirm: z.literal(true) }).parse({ confirm: a.confirm });
          if (operation === 'drain_instance') await relayPool.drainInstance(instanceId, user.id, true);
          else await relayPool.forceDisconnectInstance(instanceId, user.id);
        }
        return relayPool.getSnapshot();
      }
      case 'set_witness_hosting': {
        // PATCH /system/relay/instances/{id} { witnessHostingAllowed }: the relay row with its witnesses.
        const instanceId = z.string().uuid().parse(a.instanceId);
        const allowed = z.boolean().parse(a.allowed);
        const relayPool = container.resolve(RelayPoolService);
        await relayPool.setWitnessHosting(instanceId, allowed, user.id);
        const instance = (await relayPool.getSnapshot()).instances.find((candidate) => candidate.id === instanceId);
        if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
        return instance;
      }
      case 'set_service_port': {
        // POST /system/relay/instances/{id}/service-port { servicePort }: starts the change; portChange follows it.
        const instanceId = z.string().uuid().parse(a.instanceId);
        const servicePort = z.number().int().min(1).max(65535).parse(a.servicePort);
        const relayPool = container.resolve(RelayPoolService);
        await relayPool.changeInstanceServicePort(instanceId, servicePort, user.id);
        return relayPool.getSnapshot();
      }
      case 'renew_certificate': {
        // POST /system/relay/instances/{id}/renew-certificate: renew the relay's certificates now.
        const instanceId = z.string().uuid().parse(a.instanceId);
        const relayPool = container.resolve(RelayPoolService);
        await relayPool.renewInstanceCertificate(instanceId, user.id);
        return relayPool.getSnapshot();
      }
      case 'reenroll_instance': {
        // POST /system/relay/instances/{id}/reenroll: confirmed, single-use token plus enrollment targets.
        const instanceId = z.string().uuid().parse(a.instanceId);
        z.object({ confirm: z.literal(true) }).parse({ confirm: a.confirm });
        const issued = await container.resolve(RelayPoolService).issueRelayReenrollment(instanceId, user.id);
        const opfieldCertSha256 = await this.nodesService.getOpfieldEnrollmentCertificateFingerprint();
        const opfieldEnrollmentTargets = await this.nodesService.getOpfieldEnrollmentTargets();
        return {
          ...issued,
          opfieldCertSha256,
          opfieldEnrollmentTargets,
          ...(await relayReenrollmentInstallation(
            issued,
            opfieldCertSha256,
            opfieldEnrollmentTargets,
            await publicUrlFallbackOpfield()
          )),
        };
      }
      default:
        throw new Error(`Unsupported Relay Pool operation: ${operation}`);
    }
  }
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Same lenient parsing as the audit routes: an unparseable date is ignored. */
function auditDateArg(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function releaseVersionArg(value: unknown): string {
  const version = String(value ?? '');
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new AppError(400, 'INVALID_VERSION', 'Invalid version format');
  return version;
}
