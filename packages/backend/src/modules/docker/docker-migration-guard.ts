import { eq, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerMigrationArtifacts, dockerMigrations } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

const GUARDED_STATUSES = new Set(['pending', 'running', 'waiting', 'cancelling', 'cleanup_pending', 'needs_attention']);

export class DockerMigrationGuard {
  constructor(private db: DrizzleClient) {}

  async assertContainerAllowed(nodeId: string, identity: string): Promise<void> {
    const rows = await this.nodeMigrations(nodeId);
    const blocked = rows.some((row) => {
      if (row.resourceType === 'container' && row.resourceName === identity) return true;
      if (row.deploymentId && identity === `deployment:${row.deploymentId}`) return true;
      const target = (row.plan as { target?: Record<string, string> } | null)?.target;
      return Object.values(target ?? {}).includes(identity);
    });
    if (blocked) this.block(identity);
  }

  async assertContainerNameAvailable(nodeId: string, name: string): Promise<void> {
    if ((await this.nodeMigrations(nodeId)).some((row) => row.resourceName === name)) this.block(name);
  }

  async assertDeploymentAllowed(nodeId: string, deploymentId: string): Promise<void> {
    if ((await this.nodeMigrations(nodeId)).some((row) => row.deploymentId === deploymentId)) {
      this.block(deploymentId);
    }
  }

  async assertVolumeAllowed(nodeId: string, name: string): Promise<void> {
    const migrations = await this.nodeMigrations(nodeId);
    if (migrations.length === 0) return;
    const artifacts = await this.db
      .select({ migrationId: dockerMigrationArtifacts.migrationId })
      .from(dockerMigrationArtifacts)
      .where(eq(dockerMigrationArtifacts.sourceIdentity, name));
    const migrationIds = new Set(migrations.map((row) => row.id));
    if (artifacts.some((artifact) => migrationIds.has(artifact.migrationId))) this.block(name);
  }

  private async nodeMigrations(nodeId: string) {
    const rows = await this.db
      .select()
      .from(dockerMigrations)
      .where(or(eq(dockerMigrations.sourceNodeId, nodeId), eq(dockerMigrations.targetNodeId, nodeId)));
    // Only a migration that still runs locks its resources. The copy a completed migration kept on the source node is
    // an ordinary stopped container again: its owner can start it as a fallback, rename or remove it.
    return rows.filter((row) => GUARDED_STATUSES.has(row.status));
  }

  private block(identity: string): never {
    throw new AppError(409, 'DOCKER_RESOURCE_MIGRATING', `Docker resource "${identity}" is locked by a migration`);
  }
}
