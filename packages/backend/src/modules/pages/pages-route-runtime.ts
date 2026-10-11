import { appsHostRuntime } from '@/modules/apps/apps-host-runtime.js';
import { pageDeployRouteRuntime } from './page-deploy-route-runtime.js';
import { pageManagementRouteRuntime } from './page-management-route-runtime.js';
import { pageProjectRouteRuntime } from './page-project-route-runtime.js';
import { pageProfileRouteRuntime } from './profile/page-profile-route-runtime.js';
export const pagesRouteRuntime = {
  /** Apps: node allowlist guard, `app` field and list filters (see apps-host-runtime.ts). */
  apps: appsHostRuntime,
  pageProjectRouteRuntime,
  pageManagementRouteRuntime,
  pageDeployRouteRuntime,
  pageProfileRouteRuntime,
};
