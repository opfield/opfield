import { AppError } from '@/middleware/error-handler.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';
import {
  containerRecreateRequiredScopes,
  deploymentDeployRequiredScopes,
} from '@/modules/docker/docker-container-scope-requirements.js';
import type { AppMember } from './app-members.service.js';

interface PromotionImageItem {
  type: string;
  targetId: string;
  targetName: string;
  targetNodeId: string | null;
  promotable: boolean;
}

/**
 * Promoting a container or deployment runs another image with the target's own env and secrets, so it needs what a
 * container recreate or a deployment deploy with a new image needs on the target (see
 * docker-container-scope-requirements.ts), on top of apps:promote. A Compose project gets a new revision whose services
 * run the source's images, so it needs docker:compose:manage on the project (what applying a revision needs).
 * `scopes` are the caller's effective scopes. Pages members run no container and are not checked here.
 */
export function assertPromotionImageScopes(
  scopes: readonly string[],
  items: readonly PromotionImageItem[],
  targetMembers: readonly AppMember[]
): void {
  const granted = [...scopes];
  for (const item of items) {
    if (!item.promotable) continue;
    if (item.type !== 'container' && item.type !== 'deployment' && item.type !== 'compose') continue;
    const member = targetMembers.find(
      (entry) =>
        entry.type === item.type &&
        entry.id === item.targetId &&
        (item.type !== 'container' || (entry.nodeId ?? null) === item.targetNodeId)
    );
    const nodeId = member?.nodeId ?? item.targetNodeId ?? '';
    const resourceId = item.type === 'container' ? (member?.scopeResourceId ?? '') : item.targetId;
    const required =
      item.type === 'container'
        ? containerRecreateRequiredScopes({ image: true })
        : item.type === 'compose'
          ? ['docker:compose:manage']
          : deploymentDeployRequiredScopes({ image: true });
    const missing = required.filter((scope) => !hasDockerResourceScope(granted, scope, nodeId, resourceId));
    if (missing.length > 0) {
      throw new AppError(
        403,
        'FORBIDDEN',
        `Promoting ${item.targetName} runs other images with its environment and secrets`,
        { missingScopes: missing, scopeMatch: 'all' }
      );
    }
  }
}
