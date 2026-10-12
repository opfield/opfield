import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { assertStatusPageUpstreamUnchanged } from '@/modules/cloud-link/cloud-link-status-page-upstream.js';
import {
  CreateStatusPageIncidentSchema,
  CreateStatusPageIncidentUpdateSchema,
  CreateStatusPageServiceSchema,
  IncidentListQuerySchema,
  ReorderStatusPageServicesSchema,
  StatusPageSettingsSchema,
  UpdateStatusPageIncidentSchema,
  UpdateStatusPageServiceSchema,
} from '@/modules/status-page/status-page.schemas.js';
import type { User } from '@/types.js';

export async function manageStatusPageTool(user: User, args: Record<string, unknown>) {
  const { StatusPageService } = await import('@/modules/status-page/status-page.service.js');
  const service = container.resolve(StatusPageService);
  const resource = String(args.resource);
  const operation = String(args.operation);
  const payload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;

  if (resource === 'settings') {
    if (operation === 'get') {
      ensureToolScope(user, 'status-page:view');
      return service.getConfig();
    }
    if (operation === 'update') {
      ensureToolScope(user, 'status-page:manage');
      // The route passes the caller scopes: a custom upstream change requires proxy:raw:write.
      const input = StatusPageSettingsSchema.parse(payload);
      // As PUT /status-page/settings: a managed installation keeps its upstream.
      await assertStatusPageUpstreamUnchanged(input);
      return service.updateSettings(input, user.id, user.scopes);
    }
  }
  if (resource === 'proxy_templates' && operation === 'list') {
    ensureToolScope(user, 'status-page:view');
    return service.listProxyTemplates();
  }
  if (resource === 'sources' && operation === 'list') {
    // Same as GET /status-page/sources: exposable resources the caller can view.
    ensureToolScope(user, 'status-page:manage');
    return service.listSources(user.scopes);
  }
  if (resource === 'services') {
    if (operation === 'list') {
      ensureToolScope(user, 'status-page:view');
      return service.listServices(user.scopes);
    }
    if (operation === 'create') {
      ensureToolScope(user, 'status-page:manage');
      // The route passes the caller scopes: a service can only expose a source the caller can view.
      return service.createService(CreateStatusPageServiceSchema.parse(payload), user.id, user.scopes);
    }
    if (operation === 'update') {
      ensureToolScope(user, 'status-page:manage');
      return service.updateService(
        String(args.serviceId),
        UpdateStatusPageServiceSchema.parse(payload),
        user.id,
        user.scopes
      );
    }
    if (operation === 'reorder') {
      ensureToolScope(user, 'status-page:manage');
      return service.reorderServices(ReorderStatusPageServicesSchema.parse(payload).serviceIds, user.id);
    }
    if (operation === 'delete') {
      ensureToolScope(user, 'status-page:manage');
      await service.deleteService(String(args.serviceId), user.id);
      return { success: true };
    }
  }
  if (resource === 'incidents') {
    if (operation === 'list') {
      ensureToolScope(user, 'status-page:view');
      return service.listIncidents(IncidentListQuerySchema.parse(args));
    }
    if (operation === 'create') {
      ensureToolScope(user, 'status-page:incidents:create');
      return service.createManualIncident(CreateStatusPageIncidentSchema.parse(payload), user.id);
    }
    if (operation === 'update') {
      ensureToolScope(user, 'status-page:incidents:update');
      return service.updateIncident(String(args.incidentId), UpdateStatusPageIncidentSchema.parse(payload), user.id);
    }
    if (operation === 'delete') {
      ensureToolScope(user, 'status-page:incidents:delete');
      await service.deleteIncident(String(args.incidentId), user.id);
      return { success: true };
    }
    if (operation === 'resolve') {
      ensureToolScope(user, 'status-page:incidents:resolve');
      return service.resolveIncident(String(args.incidentId), user.id);
    }
    if (operation === 'promote') {
      ensureToolScope(user, 'status-page:incidents:create');
      return service.promoteIncident(String(args.incidentId), user.id);
    }
  }
  if (resource === 'incident_updates' && operation === 'create_update') {
    ensureToolScope(user, 'status-page:incidents:update');
    return service.createIncidentUpdate(
      String(args.incidentId),
      CreateStatusPageIncidentUpdateSchema.parse(payload),
      user.id
    );
  }
  if (resource === 'preview' || operation === 'preview') {
    ensureToolScope(user, 'status-page:view');
    return service.getPreviewDto();
  }
  throw new Error(`Unsupported status page operation: ${resource}.${operation}`);
}

function ensureToolScope(user: User, scope: string) {
  if (!hasScope(user.scopes, scope)) {
    throw new Error(`PERMISSION_DENIED: Missing required scope ${scope}`);
  }
}
