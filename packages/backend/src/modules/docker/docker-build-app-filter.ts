import { container } from '@/container.js';
import {
  type AppListFilter,
  type AppMemberKey,
  AppMembershipService,
  hasAppListFilter,
  memberKey,
} from '@/modules/apps/app-membership.js';

type BuildTarget =
  | { kind: 'container'; nodeId: string; containerName: string }
  | { kind: 'deployment'; deploymentId: string }
  | { kind: 'compose_project'; composeProjectId: string }
  | { kind: 'pages_project'; pageProjectId: string };

/** The app member a build targets: its container, deployment, Compose project or Pages project. */
function buildTargetMember(target: BuildTarget): AppMemberKey {
  switch (target.kind) {
    case 'container':
      return { type: 'container', id: target.containerName, nodeId: target.nodeId };
    case 'deployment':
      return { type: 'deployment', id: target.deploymentId };
    case 'compose_project':
      return { type: 'compose', id: target.composeProjectId };
    case 'pages_project':
      return { type: 'pages', id: target.pageProjectId };
  }
}

/**
 * Builds kept by an app list filter, like every other foldered list: `excludeAppMembers` leaves out builds of app
 * members (the global Docker page), `appId` keeps those of one app. Access is checked separately.
 */
export async function filterBuildsByApp<T extends { target: BuildTarget }>(
  builds: readonly T[],
  filter: AppListFilter
): Promise<T[]> {
  if (!hasAppListFilter(filter) || builds.length === 0) return [...builds];
  if (!container.isRegistered(AppMembershipService)) return filter.appId ? [] : [...builds];
  const keys = builds.map((build) => buildTargetMember(build.target));
  const refs = await container.resolve(AppMembershipService).refsForMembers(keys);
  return builds.filter((_build, index) => {
    const app = refs.get(memberKey(keys[index]!)) ?? null;
    return filter.appId ? app?.id === filter.appId : !app;
  });
}
