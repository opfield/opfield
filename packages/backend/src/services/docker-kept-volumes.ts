import { eq, isNotNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPolicies,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentSlots,
  dockerDeployments,
  dockerManagedVolumes,
  dockerSourceBindings,
} from '@/db/schema/index.js';

/**
 * Volumes with a Docker-generated name that removal must keep on a node even when no container uses them: the ones
 * the user manages in Opfield (created or adopted, a database row the daemon cannot see) and every one an Opfield
 * config names (a deployment's or slot's desired config, an Availability policy, a source's container config, the
 * active Compose revision). The daemon removes a removed container's anonymous volumes (slot replace, Availability
 * placement removal, Compose down); Opfield sends it this set first (docker_kept_volumes_v1), and housekeeping skips
 * the same set.
 */

/** A 64-hex token not part of a longer hex run and not an image digest (`sha256:<hex>`, `@<hex>`). */
const VOLUME_NAME_TOKEN = /(?<![0-9a-f:@])[0-9a-f]{64}(?![0-9a-f])/gi;

/** The Docker-generated volume names a config text mentions, lower-cased. */
export function referencedAnonymousVolumeNames(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(VOLUME_NAME_TOKEN)].map((match) => match[0].toLowerCase()))];
}

/** Docker-generated names every Opfield config mentions, on any node (an Availability policy spans nodes). */
export async function configReferencedVolumeNames(db: DrizzleClient): Promise<Set<string>> {
  const [deployments, slots, policies, bindings, revisions] = await Promise.all([
    db.select({ config: dockerDeployments.desiredConfig }).from(dockerDeployments),
    db
      .select({ config: dockerDeploymentSlots.desiredConfig })
      .from(dockerDeploymentSlots)
      .where(isNotNull(dockerDeploymentSlots.desiredConfig)),
    db.select({ config: dockerAvailabilityPolicies.portableSpec }).from(dockerAvailabilityPolicies),
    db
      .select({ config: dockerSourceBindings.initialConfig })
      .from(dockerSourceBindings)
      .where(isNotNull(dockerSourceBindings.initialConfig)),
    db
      .select({ yaml: dockerComposeRevisions.sourceYaml })
      .from(dockerComposeProjects)
      .innerJoin(dockerComposeRevisions, eq(dockerComposeRevisions.id, dockerComposeProjects.activeRevisionId)),
  ]);
  const names = new Set<string>();
  const add = (text: string | null | undefined) => {
    for (const name of referencedAnonymousVolumeNames(text)) names.add(name);
  };
  for (const row of [...deployments, ...slots, ...policies, ...bindings]) {
    if (row.config) add(JSON.stringify(row.config));
  }
  for (const row of revisions) add(row.yaml);
  return names;
}

/** Every volume name removal must keep on the node: managed by the user there, or named by an Opfield config. */
export async function opfieldKeptVolumeNames(db: DrizzleClient, nodeId: string): Promise<Set<string>> {
  const [managed, referenced] = await Promise.all([
    db
      .select({ name: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(eq(dockerManagedVolumes.nodeId, nodeId)),
    configReferencedVolumeNames(db),
  ]);
  for (const row of managed) referenced.add(row.name);
  return referenced;
}
