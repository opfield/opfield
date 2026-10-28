import type { DockerDeploymentCreateInput } from './docker-deployment.schemas.js';
export type DeploymentRouteShape = Pick<
  DockerDeploymentCreateInput['routes'][number],
  'hostPort' | 'containerPort' | 'isPrimary'
>;
type DeploymentWithWebhook = {
  webhook?: { token?: string | null; [key: string]: unknown } | null;
};
export function redactDeploymentWebhookToken<T extends DeploymentWithWebhook>(deployment: T, canReveal: boolean): T {
  if (!deployment.webhook) return deployment;
  // The stored hash never leaves the server.
  const { tokenHash: _tokenHash, ...webhook } = deployment.webhook;
  return {
    ...deployment,
    // A webhook whose token is not stored in the clear has none to hide: the UI shows the issue-once placeholder.
    webhook: canReveal || webhook.token == null ? webhook : { ...webhook, token: '[REDACTED]' },
  };
}
