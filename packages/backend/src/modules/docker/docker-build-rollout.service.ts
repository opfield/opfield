import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { PageBuildRolloutService } from '@/modules/pages/deployments/page-build-rollout.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerComposeService } from './compose/compose.service.js';
import type { DockerManagementService } from './docker.service.js';
import type { DockerDeploymentService } from './docker-deployment.service.js';
export class DockerBuildRolloutService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _docker: DockerManagementService,
    _deployments: DockerDeploymentService,
    _registry: RelayRegistryService,
    _compose?: DockerComposeService,
    _auth?: Pick<AuthService, 'getUserById'> | undefined
  ) {}
  setPagesRollout(_service: PageBuildRolloutService): void {}
  async rollout(
    _buildId: string,
    _leaseOwner: string,
    _operationId: string
  ): Promise<'deployed' | 'superseded' | 'pending'> {
    return commercialModuleUnavailable();
  }
  async recoverInterruptedComposeRollouts(_now?: Date): Promise<
    | {
        succeeded: number;
        failed: number;
      }
    | {
        succeeded: number;
        failed: number;
      }
  > {
    return { succeeded: 0, failed: 0 };
  }
}
