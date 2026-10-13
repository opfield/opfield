import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPolicies,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerContainerFolderAssignments,
  proxyHosts,
} from '@/db/schema/index.js';
import { transactionWithScopeCleanup } from '@/lib/resource-scope-cleanup.js';
import { labelString } from '../docker-managed-labels.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_CONTAINER_NUMBER_LABEL = 'com.docker.compose.container-number';
const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';
const COMPOSE_NETWORK_LABEL = 'com.docker.compose.network';
const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

type DockerResource = Record<string, unknown>;
type ComposeResourceKind = 'container' | 'volume' | 'network';

export interface ComposeProjectObservation {
  name: string;
  observedFingerprint: string;
  opfieldManaged?: boolean;
}

export interface ComposeDiscoveryChange {
  action: 'discovered' | 'observed' | 'missing' | 'removed';
  projectId: string;
  projectName: string;
}

type ExistingComposeProject = {
  id: string;
  name: string;
  managementState: 'external' | 'managed';
  desiredState?: string;
  observedFingerprint?: string | null;
  status?: string;
  availability?: string;
  preserveWhenMissing?: boolean;
};

function labelsFor(resource: DockerResource): Record<string, string> {
  const labels = resource.labels ?? resource.Labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function labelValue(labels: Record<string, string>, key: string): string | null {
  const value = labels[key]?.trim();
  return value ? value : null;
}

function resourceName(resource: DockerResource): string {
  return String(resource.name ?? resource.Name ?? resource.id ?? resource.Id ?? '').replace(/^\/+/, '');
}

function projectNameFor(resource: DockerResource): string | null {
  return labelValue(labelsFor(resource), COMPOSE_PROJECT_LABEL);
}

export function isComposeOwnedContainer(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return projectNameFor(resource) !== null || labelString(labels, 'compose.sidecar') === 'true';
}

export function isComposeOwnedVolume(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return labelValue(labels, COMPOSE_PROJECT_LABEL) !== null && labelValue(labels, COMPOSE_VOLUME_LABEL) !== null;
}

export function isComposeOwnedNetwork(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return labelValue(labels, COMPOSE_PROJECT_LABEL) !== null && labelValue(labels, COMPOSE_NETWORK_LABEL) !== null;
}

function fingerprintEntry(kind: ComposeResourceKind, resource: DockerResource): [string, string] | null {
  const labels = labelsFor(resource);
  const project = labelValue(labels, COMPOSE_PROJECT_LABEL);
  if (!project) return null;

  const ownershipLabel =
    kind === 'container'
      ? labelValue(labels, COMPOSE_SERVICE_LABEL)
      : kind === 'volume'
        ? labelValue(labels, COMPOSE_VOLUME_LABEL)
        : labelValue(labels, COMPOSE_NETWORK_LABEL);
  if (kind !== 'container' && !ownershipLabel) return null;

  const identity = [
    kind,
    resourceName(resource),
    ownershipLabel ?? '',
    labelValue(labels, COMPOSE_CONTAINER_NUMBER_LABEL) ?? '',
  ].join(':');
  return [project, identity];
}

export function observeComposeProjects(input: {
  containers?: DockerResource[];
  volumes?: DockerResource[];
  networks?: DockerResource[];
}): ComposeProjectObservation[] {
  const entries = new Map<string, { values: string[]; opfieldManaged: boolean }>();
  const resources: Array<[ComposeResourceKind, DockerResource[] | undefined]> = [
    ['container', input.containers],
    ['volume', input.volumes],
    ['network', input.networks],
  ];

  for (const [kind, rows] of resources) {
    for (const resource of rows ?? []) {
      const entry = fingerprintEntry(kind, resource);
      if (!entry) continue;
      const [project, identity] = entry;
      const labels = labelsFor(resource);
      const projectEntries = entries.get(project) ?? { values: [], opfieldManaged: false };
      projectEntries.values.push(identity);
      projectEntries.opfieldManaged ||= labelString(labels, 'compose.managed') === 'true';
      entries.set(project, projectEntries);
    }
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      name,
      observedFingerprint: createHash('sha256')
        .update([...new Set(entry.values)].sort().join('\n'))
        .digest('hex'),
      ...(entry.opfieldManaged ? { opfieldManaged: true } : {}),
    }));
}

/** What a Compose revision says about a service's lifetime (a subset of the normalized model). */
export interface ComposeServiceLifetime {
  restart?: string;
  dependsOn?: Record<string, { condition?: string }>;
}

/** A container's exit code from its inventory status ("Exited (0) 2 minutes ago"); null while it did not exit. */
function containerExitCode(container: DockerResource): number | null {
  const match = /^exited\s*\((-?\d+)\)/i.exec(String(container.status ?? container.Status ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * N-25: the run state of a Compose project that should run, from its containers (sidecars and one-off `run`
 * containers aside). A service is up while one of its containers runs. A service that is not meant to stay up and
 * finished cleanly is complete, not down: every container exited with code 0 and it restarts never or only on failure
 * (and no route serves it), or another service waits for it to complete successfully (an init or migration job).
 * Any other service that does not run is down: a non-zero exit, an exit of a service that restarts always or unless
 * stopped, a routed service that exited, a container that never started, or a declared service without a container.
 * All services down -> stopped; some -> degraded (partially running); none -> running. Null without any container.
 */
export function composeProjectRunState(input: {
  projectName: string;
  containers: DockerResource[];
  /** The active revision's services; without it, the services the containers belong to. */
  services?: Record<string, ComposeServiceLifetime>;
  /** Services a route (proxy host) serves: meant to stay up whatever their restart policy says. */
  routedServices?: ReadonlySet<string>;
}): 'running' | 'degraded' | 'stopped' | null {
  const byService = new Map<string, DockerResource[]>();
  for (const container of input.containers) {
    const labels = labelsFor(container);
    if (labelValue(labels, COMPOSE_PROJECT_LABEL) !== input.projectName) continue;
    const service = labelValue(labels, COMPOSE_SERVICE_LABEL);
    if (!service || labelString(labels, 'compose.sidecar') === 'true') continue;
    if (String(labels[COMPOSE_ONEOFF_LABEL] ?? '').toLowerCase() === 'true') continue;
    byService.set(service, [...(byService.get(service) ?? []), container]);
  }
  if (byService.size === 0) return null;
  const declared = input.services ?? {};
  const serviceNames = new Set([...Object.keys(declared), ...byService.keys()]);
  const awaitedCompletion = new Set(
    Object.values(declared).flatMap((service) =>
      Object.entries(service.dependsOn ?? {})
        .filter(([, dependency]) => dependency.condition === 'service_completed_successfully')
        .map(([name]) => name)
    )
  );
  let up = 0;
  let down = 0;
  for (const name of serviceNames) {
    const rows = byService.get(name) ?? [];
    if (rows.some((row) => String(row.state ?? row.State ?? '').toLowerCase() === 'running')) {
      up += 1;
      continue;
    }
    const restart = String(declared[name]?.restart ?? 'no').toLowerCase();
    const cleanExit = rows.length > 0 && rows.every((row) => containerExitCode(row) === 0);
    const finishes =
      awaitedCompletion.has(name) ||
      ((restart === 'no' || restart.startsWith('on-failure')) && !input.routedServices?.has(name));
    if (cleanExit && finishes) continue;
    down += 1;
  }
  if (down === 0) return 'running';
  return up === 0 ? 'stopped' : 'degraded';
}

export function filterDiscoverableComposeProjects(
  observed: ComposeProjectObservation[],
  existing: ExistingComposeProject[]
): ComposeProjectObservation[] {
  const localManagedNames = new Set(
    existing.filter((project) => project.managementState === 'managed').map((project) => project.name)
  );
  return observed
    .filter((project) => !project.opfieldManaged || localManagedNames.has(project.name))
    .map(({ opfieldManaged: _opfieldManaged, ...project }) => project);
}

export function planExternalComposeProjectReconciliation(
  existing: ExistingComposeProject[],
  observed: ComposeProjectObservation[]
) {
  const observedByName = new Map(observed.map((project) => [project.name, project]));
  const existingByName = new Map(existing.map((project) => [project.name, project]));

  return {
    create: observed.filter((project) => !existingByName.has(project.name)),
    observed: observed.map((project) => ({ project, existing: existingByName.get(project.name) })),
    missingExternal: existing.filter(
      (project) =>
        project.managementState === 'external' && !observedByName.has(project.name) && project.preserveWhenMissing
    ),
    removeMissingExternal: existing.filter(
      (project) =>
        project.managementState === 'external' && !observedByName.has(project.name) && !project.preserveWhenMissing
    ),
  };
}

export async function reconcileExternalComposeProjects(
  db: DrizzleClient,
  nodeId: string,
  input: Parameters<typeof observeComposeProjects>[0],
  observedAt = new Date(),
  onChange?: (change: ComposeDiscoveryChange) => void
): Promise<ComposeProjectObservation[]> {
  const observedProjects = observeComposeProjects(input);
  const existingRows = await db
    .select({
      id: dockerComposeProjects.id,
      name: dockerComposeProjects.name,
      managementState: dockerComposeProjects.managementState,
      desiredState: dockerComposeProjects.desiredState,
      observedFingerprint: dockerComposeProjects.observedFingerprint,
      status: dockerComposeProjects.status,
      availability: dockerComposeProjects.availability,
      folderId: dockerContainerFolderAssignments.folderId,
      folderSortOrder: dockerContainerFolderAssignments.sortOrder,
      hasRevisions: sql<boolean>`exists(
        select 1 from ${dockerComposeRevisions}
        where ${dockerComposeRevisions.projectId} = ${dockerComposeProjects.id}
      )`,
    })
    .from(dockerComposeProjects)
    .leftJoin(
      dockerContainerFolderAssignments,
      and(
        eq(dockerContainerFolderAssignments.nodeId, dockerComposeProjects.nodeId),
        eq(dockerContainerFolderAssignments.resourceType, 'compose'),
        sql`${dockerContainerFolderAssignments.resourceKey} = ${dockerComposeProjects.id}::text`
      )
    )
    .where(eq(dockerComposeProjects.nodeId, nodeId));
  const existing = existingRows.map((project) => ({
    id: project.id,
    name: project.name,
    managementState: project.managementState,
    desiredState: project.desiredState,
    observedFingerprint: project.observedFingerprint,
    status: project.status,
    availability: project.availability,
    preserveWhenMissing: project.hasRevisions || project.folderId !== null || (project.folderSortOrder ?? 0) !== 0,
  }));
  const observed = filterDiscoverableComposeProjects(observedProjects, existing);
  const plan = planExternalComposeProjectReconciliation(existing, observed);

  if (plan.create.length > 0) {
    await db
      .insert(dockerComposeProjects)
      .values(
        plan.create.map((project) => ({
          nodeId,
          name: project.name,
          managementState: 'external' as const,
          desiredState: 'running' as const,
          status: 'discovered' as const,
          availability: 'available' as const,
          observedFingerprint: project.observedFingerprint,
          lastSeenAt: observedAt,
        }))
      )
      .onConflictDoNothing({ target: [dockerComposeProjects.nodeId, dockerComposeProjects.name] });
  }

  for (const { project, existing: current } of plan.observed) {
    const values = {
      observedFingerprint: project.observedFingerprint,
      lastSeenAt: observedAt,
      availability: 'available' as const,
      updatedAt: observedAt,
      ...(current?.managementState === 'external' ? { status: 'discovered' as const } : {}),
    };
    await db
      .update(dockerComposeProjects)
      .set(values)
      .where(and(eq(dockerComposeProjects.nodeId, nodeId), eq(dockerComposeProjects.name, project.name)));
    if (
      current &&
      (current.observedFingerprint !== project.observedFingerprint ||
        current.availability !== 'available' ||
        (current.managementState === 'external' && current.status !== 'discovered'))
    ) {
      onChange?.({ action: 'observed', projectId: current.id, projectName: project.name });
    }
  }

  await reconcileManagedComposeRunStatus(db, nodeId, plan.observed, input.containers, observedAt, onChange);

  if (plan.missingExternal.length > 0) {
    await db
      .update(dockerComposeProjects)
      .set({ status: 'missing', availability: 'unavailable', updatedAt: observedAt })
      .where(
        inArray(
          dockerComposeProjects.id,
          plan.missingExternal.map((project) => project.id)
        )
      );
    for (const project of plan.missingExternal) {
      if (project.status === 'missing' && project.availability === 'unavailable') continue;
      onChange?.({ action: 'missing', projectId: project.id, projectName: project.name });
    }
  }

  if (plan.removeMissingExternal.length > 0) {
    const removedIds = plan.removeMissingExternal.map((project) => project.id);
    await transactionWithScopeCleanup(db, async (tx) => {
      await tx
        .delete(dockerContainerFolderAssignments)
        .where(
          and(
            eq(dockerContainerFolderAssignments.nodeId, nodeId),
            eq(dockerContainerFolderAssignments.resourceType, 'compose'),
            inArray(dockerContainerFolderAssignments.resourceKey, removedIds)
          )
        );
      await tx.delete(dockerComposeProjects).where(inArray(dockerComposeProjects.id, removedIds));
    });
    for (const project of plan.removeMissingExternal) {
      onChange?.({ action: 'removed', projectId: project.id, projectName: project.name });
    }
  }

  if (observed.length > 0) {
    const projects = await db
      .select({ id: dockerComposeProjects.id, name: dockerComposeProjects.name })
      .from(dockerComposeProjects)
      .where(
        and(
          eq(dockerComposeProjects.nodeId, nodeId),
          inArray(
            dockerComposeProjects.name,
            observed.map((project) => project.name)
          )
        )
      );
    for (const project of projects) {
      await db
        .insert(dockerContainerFolderAssignments)
        .values({
          nodeId,
          resourceType: 'compose',
          resourceKey: project.id,
          containerName: null,
          folderId: null,
          sortOrder: 0,
        })
        .onConflictDoNothing();
      if (plan.create.some((created) => created.name === project.name)) {
        onChange?.({ action: 'discovered', projectId: project.id, projectName: project.name });
      }
    }
  }

  return observed;
}

/** Project statuses the container observation may move between; any other one belongs to an operation. */
const OBSERVED_RUN_STATUSES = ['running', 'degraded', 'stopped'] as const;

/**
 * N-25: a managed project that should run follows what its containers do. A service stopped outside Gateway left the
 * project "running" (and the status page operational) although the route answered 502. Projects with a Compose
 * operation in flight (it sets the status itself) and projects Availability runs (their copies move between nodes)
 * are left alone.
 */
async function reconcileManagedComposeRunStatus(
  db: DrizzleClient,
  nodeId: string,
  observed: Array<{ project: ComposeProjectObservation; existing?: ExistingComposeProject }>,
  containers: DockerResource[] | undefined,
  observedAt: Date,
  onChange?: (change: ComposeDiscoveryChange) => void
): Promise<void> {
  const managed = observed.flatMap(({ existing }) =>
    existing &&
    existing.managementState === 'managed' &&
    existing.desiredState === 'running' &&
    (OBSERVED_RUN_STATUSES as readonly string[]).includes(existing.status ?? '')
      ? [existing]
      : []
  );
  if (managed.length === 0) return;
  const ids = managed.map((project) => project.id);
  const [operations, policies, revisions, routes] = await Promise.all([
    db
      .select({ projectId: dockerComposeOperations.projectId })
      .from(dockerComposeOperations)
      .where(
        and(
          inArray(dockerComposeOperations.projectId, ids),
          inArray(dockerComposeOperations.status, ['pending', 'running', 'cancelling', 'reconciling'])
        )
      ),
    db
      .select({ projectId: dockerAvailabilityPolicies.composeProjectId })
      .from(dockerAvailabilityPolicies)
      .where(
        and(inArray(dockerAvailabilityPolicies.composeProjectId, ids), ne(dockerAvailabilityPolicies.mode, 'single'))
      ),
    db
      .select({ projectId: dockerComposeRevisions.projectId, model: dockerComposeRevisions.normalizedModel })
      .from(dockerComposeRevisions)
      .innerJoin(dockerComposeProjects, eq(dockerComposeProjects.activeRevisionId, dockerComposeRevisions.id))
      .where(inArray(dockerComposeRevisions.projectId, ids)),
    db
      .select({ projectId: proxyHosts.dockerComposeProjectId, service: proxyHosts.dockerComposeServiceName })
      .from(proxyHosts)
      .where(inArray(proxyHosts.dockerComposeProjectId, ids)),
  ]);
  const skip = new Set([...operations, ...policies].map(({ projectId }) => projectId));
  const modelByProject = new Map(revisions.map(({ projectId, model }) => [projectId, model]));
  const routedByProject = new Map<string, Set<string>>();
  for (const { projectId, service } of routes) {
    if (!projectId || !service) continue;
    routedByProject.set(projectId, (routedByProject.get(projectId) ?? new Set<string>()).add(service));
  }
  for (const project of managed) {
    if (skip.has(project.id)) continue;
    const next = composeProjectRunState({
      projectName: project.name,
      containers: containers ?? [],
      services: modelByProject.get(project.id)?.services,
      routedServices: routedByProject.get(project.id),
    });
    if (!next || next === project.status) continue;
    const [updated] = await db
      .update(dockerComposeProjects)
      .set({ status: next, updatedAt: observedAt })
      .where(
        and(
          eq(dockerComposeProjects.id, project.id),
          eq(dockerComposeProjects.nodeId, nodeId),
          eq(dockerComposeProjects.desiredState, 'running'),
          inArray(dockerComposeProjects.status, [...OBSERVED_RUN_STATUSES])
        )
      )
      .returning({ id: dockerComposeProjects.id });
    if (updated) onChange?.({ action: 'observed', projectId: project.id, projectName: project.name });
  }
}
