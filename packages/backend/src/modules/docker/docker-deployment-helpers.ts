import type { DockerDeploymentCreateInput } from './docker-deployment.schemas.js';
import { presentWebhook } from './docker-webhook-token.js';
export type DeploymentRouteShape = Pick<
  DockerDeploymentCreateInput['routes'][number],
  'hostPort' | 'containerPort' | 'isPrimary'
>;
type DeploymentWithWebhook = {
  webhook?: {
    token?: string | null;
    tokenHash?: string | null;
    tokenEncrypted?: string | null;
    [key: string]: unknown;
  } | null;
};
export function redactDeploymentWebhookToken<T extends DeploymentWithWebhook>(deployment: T, canReveal: boolean): T {
  if (!deployment.webhook) return deployment;
  // The stored hash and ciphertext never leave the server; the token is shown to webhook managers only.
  const webhook = presentWebhook(deployment.webhook, { reveal: canReveal });
  return {
    ...deployment,
    webhook: canReveal || webhook.tokenLost ? webhook : { ...webhook, token: '[REDACTED]' },
  };
}
