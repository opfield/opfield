import { container } from '@/container.js';
import { ProxyMaintenanceAccessService } from '@/modules/proxy/proxy-maintenance-access.service.js';
import { APP_ENV_MANAGE_SCOPE, assertAppScope, assertAppWideScope } from './app-access.js';
import type { AppActor, AppsService } from './apps.service.js';

/** Issues app and environment Maintenance Access Codes after the app permission checks (REST and MCP). */
export class AppMaintenanceAccessService {
  constructor(private readonly apps: AppsService) {}

  async issue(actor: AppActor, appId: string, environmentId: string | null) {
    const { app } = await this.apps.resolveVisible(actor.scopes, appId);
    if (environmentId) {
      const env = await this.apps.getEnvironment(app.id, environmentId);
      assertAppScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id, env.id);
    } else {
      assertAppWideScope(actor.scopes, APP_ENV_MANAGE_SCOPE, app.id);
    }
    return container
      .resolve(ProxyMaintenanceAccessService)
      .issueForApp({ appId: app.id, environmentId, userId: actor.userId });
  }
}
