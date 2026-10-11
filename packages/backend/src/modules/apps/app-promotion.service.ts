import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AppPromotion,
  type AppPromotionItemRecord,
  appPromotions,
  dockerArtifactPins,
  dockerBuildArtifacts,
  dockerBuilds,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentSlots,
  dockerDeployments,
  pageDeployments,
  pageTags,
  users,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import { DockerComposeService } from '@/modules/docker/compose/compose.service.js';
import { DockerManagementService } from '@/modules/docker/docker.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerInternalRegistryService } from '@/modules/docker/docker-registry-internal.service.js';
import { DockerSnapshotService } from '@/modules/docker/docker-snapshot.service.js';
import { DockerTaskService } from '@/modules/docker/docker-task.service.js';
import { PageDeploymentService } from '@/modules/pages/deployments/page-deployment.service.js';
import { NodeDispatchService } from '@/services/node-dispatch.service.js';
import { RelayRegistryService } from '@/services/relay-registry.service.js';
import { APP_PROMOTE_SCOPE, assertAppScope, visibleEnvironmentIds } from './app-access.js';
import type { AppMemberFreeze } from './app-member-freeze.js';
import type { AppMembersReader } from './app-members.service.js';
import { type PromotableType, type PromotionPair, pairMembers, type UnpairedMember } from './app-promotion-pairing.js';
import type { AppActor, AppEnvironmentRow, AppsService } from './apps.service.js';

const logger = createChildLogger('AppPromotion');

/** The internal registry address every node pulls Git artifacts from. */
const INTERNAL_REGISTRY = '127.0.0.1:5443/';
const DIGEST_RE = /sha256:[0-9a-f]{64}/;
/**
 * Longest a container item waits for its recreate to finish: beyond the recreate's own watch (the long Docker
 * operation limit of 10 minutes plus 30 seconds for a pull and recreate the node runs as a task).
 */
const CONTAINER_ROLLOUT_TIMEOUT_MS = 12 * 60_000;

/**
 * Why a container item did not roll out, from the recreate task it waited for (null: the target runs the new
 * container). A task still pending or running after the wait counts as a failure, never as success.
 */
export function containerRolloutError(
  task: { status: string; error?: string | null; progress?: string | null } | null,
  targetName: string,
  timeoutMs: number
): AppError | null {
  if (!task) return new AppError(502, 'PROMOTION_RECREATE_UNKNOWN', `The recreate task of ${targetName} is gone`);
  if (task.status === 'succeeded' || task.status === 'completed') return null;
  if (task.status === 'pending' || task.status === 'running') {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    return new AppError(
      504,
      'PROMOTION_RECREATE_TIMEOUT',
      `${targetName} was not recreated within ${minutes} min${task.progress ? ` (${task.progress})` : ''}`
    );
  }
  return new AppError(
    502,
    'PROMOTION_RECREATE_FAILED',
    `Recreating ${targetName} failed: ${task.error || `the task ended ${task.status}`}`
  );
}

/** What runs in a container: the pullable reference, its digest and what the dialog shows. */
export interface RunningImage {
  /** Reference to run elsewhere: `repo[:tag]@sha256:…`, an internal artifact, or the local image id. */
  image: string;
  digest: string | null;
  repository: string | null;
  tag: string | null;
  internal: boolean;
  /** No registry digest: the image exists only on its node. */
  localOnly: boolean;
  imageId: string | null;
  nodeId: string;
  build: { commitSha: string; buildId: string } | null;
}

export interface PromotionPreviewItem {
  pairKey: string;
  type: PromotableType;
  sourceId: string;
  sourceName: string;
  sourceNodeId: string | null;
  targetId: string;
  targetName: string;
  targetNodeId: string | null;
  /** What the target runs now (display), and what it will run. */
  from: string | null;
  to: string;
  fromDigest: string | null;
  toDigest: string | null;
  same: boolean;
  promotable: boolean;
  reason: string | null;
  rollout: string;
  build: { commitSha: string; buildId: string } | null;
  compose?: {
    fromRevision: number | null;
    toRevision: number | null;
    services: Array<{ name: string; from: string | null; to: string | null; changed: boolean }>;
    changes: Array<{ path: string; from: string | null; to: string | null }>;
  };
  pages?: { fromSequence: number | null; toSequence: number | null; artifactSha256: string | null };
}

export interface PromotionPreview {
  appId: string;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  items: PromotionPreviewItem[];
  unchanged: string[];
  unpaired: Array<UnpairedMember & { message: string }>;
  previewDigest: string;
}

function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  const hex = digest.replace(/^sha256:/, '');
  return `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/** `repo:tag · sha256:abcd…wxyz` for the dialog. */
export function displayImage(image: RunningImage | null): string | null {
  if (!image) return null;
  const name = image.internal
    ? (image.repository ?? image.image)
    : image.repository
      ? `${image.repository}${image.tag ? `:${image.tag}` : ''}`
      : image.image;
  return image.digest
    ? `${name} · ${shortDigest(image.digest)}`
    : `${name} · ${image.imageId?.slice(0, 19) ?? 'local'}`;
}

/** Split `registry/repo:tag@sha256:…` into repository, tag and digest. */
export function parseImageReference(reference: string): {
  repository: string;
  tag: string | null;
  digest: string | null;
} {
  const [withoutDigest, digestPart] = reference.split('@');
  const digest = digestPart && DIGEST_RE.test(digestPart) ? digestPart : null;
  const slash = withoutDigest!.lastIndexOf('/');
  const colon = withoutDigest!.lastIndexOf(':');
  if (colon > slash) {
    return { repository: withoutDigest!.slice(0, colon), tag: withoutDigest!.slice(colon + 1), digest };
  }
  return { repository: withoutDigest!, tag: null, digest };
}

/** The repository part of a repo digest entry that matches the running reference (`repo@sha256:…`). */
export function pickRepoDigest(repoDigests: readonly string[], repository: string | null): string | null {
  if (repoDigests.length === 0) return null;
  const normalize = (value: string) => value.replace(/^docker\.io\/(library\/)?/, '');
  const match = repository
    ? repoDigests.find((entry) => normalize(entry.split('@')[0]!) === normalize(repository))
    : undefined;
  return match ?? repoDigests[0]!;
}

/** Path-level differences of two parsed documents (`services.web.environment.LOG_LEVEL`), at most `limit`. */
export function diffDocuments(
  before: unknown,
  after: unknown,
  path: string[] = [],
  out: Array<{ path: string; from: string | null; to: string | null }> = [],
  limit = 50
) {
  if (out.length >= limit) return out;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (isObject(before) && isObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      diffDocuments(before[key], after[key], [...path, key], out, limit);
    }
    return out;
  }
  const render = (value: unknown) =>
    value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
  if (JSON.stringify(before) !== JSON.stringify(after))
    out.push({ path: path.join('.'), from: render(before), to: render(after) });
  return out;
}

function containerName(row: Record<string, any>): string {
  const raw = row.name ?? row.Name ?? (Array.isArray(row.names) ? row.names[0] : undefined) ?? row.Names?.[0] ?? '';
  return String(raw).replace(/^\/+/, '');
}

function containerLabels(row: Record<string, any>): Record<string, string> {
  return (row.labels ?? row.Labels ?? {}) as Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Promote: run in the target environment exactly what runs in the source. Containers and deployments get the source's
 * image by digest (Git artifacts by their internal registry digest, never rebuilt), Compose projects a new revision
 * of the source YAML with every service image pinned to the digest it runs (the target keeps its own variables and
 * secret keys), Pages projects the source's active artifact. Members pair automatically by name. Databases and
 * storage are never promoted. Scope: apps:promote on the target environment (and view on the source).
 */
export class AppPromotionService {
  private readonly running = new Set<string>();
  /** How long and how often a container item reads its recreate task (tests shorten it). */
  rolloutWait = { timeoutMs: CONTAINER_ROLLOUT_TIMEOUT_MS, pollMs: 2000 };

  constructor(
    private readonly db: DrizzleClient,
    private readonly apps: AppsService,
    private readonly members: AppMembersReader,
    private readonly freeze: AppMemberFreeze,
    private readonly auditService: AuditService
  ) {}

  private resolve<T>(token: abstract new (...args: never[]) => T): T | null {
    return container.isRegistered(token as never) ? (container.resolve(token as never) as T) : null;
  }

  private async scope(actor: AppActor, appIdOrSlug: string, sourceEnvironmentId: string, targetEnvironmentId: string) {
    const { app, envs } = await this.apps.resolveVisible(actor.scopes, appIdOrSlug);
    const visible = new Set(
      visibleEnvironmentIds(
        actor.scopes,
        app.id,
        envs.map((env) => env.id)
      )
    );
    const source = envs.find((env) => env.id === sourceEnvironmentId);
    const target = envs.find((env) => env.id === targetEnvironmentId);
    if (!source || !visible.has(source.id) || !target || !visible.has(target.id)) {
      throw new AppError(404, 'APP_ENVIRONMENT_NOT_FOUND', 'Environment not found');
    }
    if (source.id === target.id) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose two different environments');
    }
    assertAppScope(actor.scopes, APP_PROMOTE_SCOPE, app.id, target.id);
    return { app, source, target };
  }

  // ── What runs ─────────────────────────────────────────────────────

  /** What a container runs, asked live from its node. */
  async runningImage(nodeId: string, name: string): Promise<RunningImage | null> {
    const docker = this.resolve(DockerManagementService);
    if (!docker) return null;
    let inspected: Record<string, any> | null;
    try {
      inspected = (await docker.inspectContainer(nodeId, name)) as Record<string, any> | null;
    } catch {
      return null;
    }
    if (!inspected) return null;
    const configured = String(inspected.Config?.Image ?? inspected.config?.image ?? '');
    const imageId = typeof inspected.Image === 'string' ? inspected.Image : null;
    const parsed = parseImageReference(configured);
    let repository: string | null = parsed.repository || null;
    let digest = parsed.digest;
    if (!digest && imageId) {
      const images = ((await docker.listAllImages(nodeId).catch(() => [])) ?? []) as Array<Record<string, any>>;
      const image = images.find((entry) => (entry.id ?? entry.Id) === imageId);
      const repoDigests = (image?.repoDigests ?? image?.RepoDigests ?? []) as string[];
      const picked = pickRepoDigest(Array.isArray(repoDigests) ? repoDigests : [], repository);
      if (picked) {
        const [repo, pickedDigest] = picked.split('@');
        repository = repo ?? repository;
        digest = pickedDigest && DIGEST_RE.test(pickedDigest) ? pickedDigest : null;
      }
    }
    const internal = configured.startsWith(INTERNAL_REGISTRY);
    const localOnly = !digest;
    const image = digest
      ? `${repository}${parsed.tag && !internal ? `:${parsed.tag}` : ''}@${digest}`
      : (imageId ?? configured);
    let build: RunningImage['build'] = null;
    if (internal && digest && repository) {
      const [row] = await this.db
        .select({ buildId: dockerBuilds.id, commitSha: dockerBuilds.commitSha })
        .from(dockerBuildArtifacts)
        .innerJoin(dockerBuilds, eq(dockerBuilds.id, dockerBuildArtifacts.buildId))
        .where(
          and(
            eq(dockerBuildArtifacts.registryRepository, repository.slice(INTERNAL_REGISTRY.length)),
            eq(dockerBuildArtifacts.digest, digest)
          )
        )
        .limit(1);
      if (row) build = { buildId: row.buildId, commitSha: row.commitSha };
    }
    return { image, digest, repository, tag: parsed.tag, internal, localOnly, imageId, nodeId, build };
  }

  private async deploymentImage(deploymentId: string): Promise<{ image: RunningImage | null; nodeId: string } | null> {
    const [deployment] = await this.db
      .select({ id: dockerDeployments.id, nodeId: dockerDeployments.nodeId, activeSlot: dockerDeployments.activeSlot })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, deploymentId))
      .limit(1);
    if (!deployment) return null;
    const [slot] = await this.db
      .select({ containerName: dockerDeploymentSlots.containerName })
      .from(dockerDeploymentSlots)
      .where(
        and(
          eq(dockerDeploymentSlots.deploymentId, deployment.id),
          eq(dockerDeploymentSlots.slot, deployment.activeSlot)
        )
      )
      .limit(1);
    return {
      nodeId: deployment.nodeId,
      image: slot ? await this.runningImage(deployment.nodeId, slot.containerName) : null,
    };
  }

  private async composeState(projectId: string) {
    const [project] = await this.db
      .select({
        id: dockerComposeProjects.id,
        nodeId: dockerComposeProjects.nodeId,
        name: dockerComposeProjects.name,
        activeRevisionId: dockerComposeProjects.activeRevisionId,
      })
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, projectId))
      .limit(1);
    if (!project) return null;
    const revision = project.activeRevisionId
      ? (
          await this.db
            .select({
              id: dockerComposeRevisions.id,
              revisionNumber: dockerComposeRevisions.revisionNumber,
              sourceYaml: dockerComposeRevisions.sourceYaml,
            })
            .from(dockerComposeRevisions)
            .where(eq(dockerComposeRevisions.id, project.activeRevisionId))
            .limit(1)
        )[0]
      : undefined;
    const services = new Map<string, RunningImage | null>();
    const snapshots = this.resolve(DockerSnapshotService);
    const rows = snapshots
      ? (((await snapshots.getList<Record<string, any>[]>(project.nodeId, 'containers').catch(() => null))?.data ??
          []) as Record<string, any>[])
      : [];
    for (const row of rows) {
      const labels = containerLabels(row);
      if (labels['com.docker.compose.project'] !== project.name) continue;
      const service = labels['com.docker.compose.service'];
      if (!service || services.has(service)) continue;
      services.set(service, await this.runningImage(project.nodeId, containerName(row)));
    }
    return { project, revision: revision ?? null, services };
  }

  private async pagesActive(projectId: string) {
    const [row] = await this.db
      .select({
        deploymentId: pageDeployments.id,
        sequence: pageDeployments.sequence,
        artifactSha256: pageDeployments.artifactSha256,
      })
      .from(pageTags)
      .innerJoin(pageDeployments, eq(pageDeployments.id, pageTags.deploymentId))
      .where(and(eq(pageTags.projectId, projectId), eq(pageTags.name, 'latest')))
      .limit(1);
    return row ?? null;
  }

  /** The source YAML with every service image pinned to the digest it runs (build sections dropped). */
  pinComposeYaml(sourceYaml: string, services: ReadonlyMap<string, RunningImage | null>): string {
    const document = parseYaml(sourceYaml) as Record<string, any>;
    for (const [name, service] of Object.entries((document?.services ?? {}) as Record<string, any>)) {
      const running = services.get(name);
      if (!running?.digest || !service || typeof service !== 'object') continue;
      service.image = running.image;
      delete service.build;
    }
    return stringifyYaml(document);
  }

  // ── Preview ──────────────────────────────────────────────────────

  async preview(
    actor: AppActor,
    appIdOrSlug: string,
    sourceEnvironmentId: string,
    targetEnvironmentId: string
  ): Promise<PromotionPreview> {
    const { app, source, target } = await this.scope(actor, appIdOrSlug, sourceEnvironmentId, targetEnvironmentId);
    return this.buildPreview(app.id, source, target);
  }

  private async buildPreview(appId: string, source: AppEnvironmentRow, target: AppEnvironmentRow) {
    const [sourceMembers, targetMembers] = await Promise.all([
      this.members.listMembers([source.id]),
      this.members.listMembers([target.id]),
    ]);
    const { pairs, unpaired } = pairMembers(sourceMembers, targetMembers, source, target);
    const items: PromotionPreviewItem[] = [];
    for (const pair of pairs) {
      try {
        items.push(await this.previewPair(pair));
      } catch (error) {
        logger.warn('Promotion preview of a pair failed', { pairKey: pair.pairKey, error: errorMessage(error) });
        items.push(this.unpromotable(pair, null, null, `Could not read what runs: ${errorMessage(error)}`));
      }
    }
    const previewDigest = createHash('sha256')
      .update(
        JSON.stringify(
          [...items]
            .sort((a, b) => a.pairKey.localeCompare(b.pairKey))
            .map((item) => [item.pairKey, item.fromDigest, item.toDigest, item.promotable, item.same])
        )
      )
      .digest('hex');
    return {
      appId,
      sourceEnvironmentId: source.id,
      targetEnvironmentId: target.id,
      items,
      unchanged: items.filter((item) => item.same).map((item) => item.targetName),
      unpaired: unpaired.map((entry) => ({
        ...entry,
        message:
          entry.reason === 'not_in_target'
            ? `not in ${target.name}`
            : entry.reason === 'type_differs'
              ? `${target.name} has it as another type`
              : `more than one match in ${target.name}`,
      })),
      previewDigest,
    };
  }

  private unpromotable(
    pair: PromotionPair,
    from: string | null,
    fromDigest: string | null,
    reason: string
  ): PromotionPreviewItem {
    return {
      pairKey: pair.pairKey,
      type: pair.type,
      sourceId: pair.source.id,
      sourceName: pair.source.name,
      sourceNodeId: pair.source.nodeId ?? null,
      targetId: pair.target.id,
      targetName: pair.target.name,
      targetNodeId: pair.target.nodeId ?? null,
      from,
      to: from ?? '',
      fromDigest,
      toDigest: null,
      same: false,
      promotable: false,
      reason,
      rollout: '',
      build: null,
    };
  }

  private async previewPair(pair: PromotionPair): Promise<PromotionPreviewItem> {
    const base = {
      pairKey: pair.pairKey,
      type: pair.type,
      sourceId: pair.source.id,
      sourceName: pair.source.name,
      sourceNodeId: pair.source.nodeId ?? null,
      targetId: pair.target.id,
      targetName: pair.target.name,
      targetNodeId: pair.target.nodeId ?? null,
    };
    if (pair.type === 'container' || pair.type === 'deployment') {
      const sourceImage =
        pair.type === 'container'
          ? await this.runningImage(pair.source.nodeId!, pair.source.id)
          : ((await this.deploymentImage(pair.source.id))?.image ?? null);
      const targetImage =
        pair.type === 'container'
          ? await this.runningImage(pair.target.nodeId!, pair.target.id)
          : ((await this.deploymentImage(pair.target.id))?.image ?? null);
      if (!sourceImage)
        return this.unpromotable(
          pair,
          displayImage(targetImage),
          targetImage?.digest ?? null,
          `${pair.source.name} does not run`
        );
      const same =
        !!targetImage &&
        ((!!sourceImage.digest && sourceImage.digest === targetImage.digest) ||
          (!!sourceImage.imageId &&
            sourceImage.imageId === targetImage.imageId &&
            sourceImage.nodeId === targetImage.nodeId));
      const rollout =
        pair.type === 'deployment'
          ? 'Blue-green switch'
          : sourceImage.localOnly && sourceImage.nodeId !== pair.target.nodeId
            ? 'Recreated (image copied to the internal registry first)'
            : 'Recreated';
      return {
        ...base,
        from: displayImage(targetImage),
        to: displayImage(sourceImage)!,
        fromDigest: targetImage?.digest ?? targetImage?.imageId ?? null,
        toDigest: sourceImage.digest ?? sourceImage.imageId,
        same,
        promotable: !same,
        reason: same ? 'Same' : null,
        rollout,
        build: sourceImage.build,
      };
    }
    if (pair.type === 'compose') {
      const [sourceState, targetState] = await Promise.all([
        this.composeState(pair.source.id),
        this.composeState(pair.target.id),
      ]);
      if (!sourceState?.revision)
        return this.unpromotable(pair, null, null, `${pair.source.name} has no active revision`);
      const pinned = this.pinComposeYaml(sourceState.revision.sourceYaml, sourceState.services);
      const services = [...new Set([...sourceState.services.keys(), ...(targetState?.services.keys() ?? [])])]
        .sort()
        .map((name) => {
          const to = sourceState.services.get(name) ?? null;
          const from = targetState?.services.get(name) ?? null;
          return {
            name,
            from: displayImage(from),
            to: displayImage(to),
            changed: (to?.digest ?? to?.imageId ?? null) !== (from?.digest ?? from?.imageId ?? null),
          };
        });
      const pinnedTarget = targetState?.revision
        ? this.pinComposeYaml(targetState.revision.sourceYaml, targetState.services)
        : null;
      const changes = pinnedTarget
        ? diffDocuments(parseYaml(pinnedTarget), parseYaml(pinned)).filter(
            (change) => !/^services\.[^.]+\.image$/.test(change.path)
          )
        : [];
      const toDigest = createHash('sha256').update(pinned).digest('hex');
      const fromDigest = pinnedTarget ? createHash('sha256').update(pinnedTarget).digest('hex') : null;
      const same = fromDigest === toDigest;
      return {
        ...base,
        from: targetState?.revision ? `revision #${targetState.revision.revisionNumber}` : null,
        to: `revision #${sourceState.revision.revisionNumber}`,
        fromDigest,
        toDigest,
        same,
        promotable: !same,
        reason: same ? 'Same' : null,
        rollout: 'Compose apply',
        build: null,
        compose: {
          fromRevision: targetState?.revision?.revisionNumber ?? null,
          toRevision: sourceState.revision.revisionNumber,
          services,
          changes,
        },
      };
    }
    const [sourceActive, targetActive] = await Promise.all([
      this.pagesActive(pair.source.id),
      this.pagesActive(pair.target.id),
    ]);
    if (!sourceActive?.artifactSha256) {
      return this.unpromotable(pair, null, null, `${pair.source.name} has no active deployment`);
    }
    const same = sourceActive.artifactSha256 === targetActive?.artifactSha256;
    return {
      ...base,
      from: targetActive ? `deployment #${targetActive.sequence}` : null,
      to: `deployment #${sourceActive.sequence} · ${shortDigest(`sha256:${sourceActive.artifactSha256}`)}`,
      fromDigest: targetActive?.artifactSha256 ?? null,
      toDigest: sourceActive.artifactSha256,
      same,
      promotable: !same,
      reason: same ? 'Same' : null,
      rollout: 'Activate',
      build: null,
      pages: {
        fromSequence: targetActive?.sequence ?? null,
        toSequence: sourceActive.sequence,
        artifactSha256: sourceActive.artifactSha256,
      },
    };
  }

  // ── Execute ──────────────────────────────────────────────────────

  async execute(
    actor: AppActor,
    appIdOrSlug: string,
    input: { sourceEnvironmentId: string; targetEnvironmentId: string; items: string[]; previewDigest: string }
  ) {
    const { app, source, target } = await this.scope(
      actor,
      appIdOrSlug,
      input.sourceEnvironmentId,
      input.targetEnvironmentId
    );
    await this.freeze.assertNotFrozen({ kind: 'environment', id: target.id });
    const preview = await this.buildPreview(app.id, source, target);
    if (preview.previewDigest !== input.previewDigest) {
      throw new AppError(
        409,
        'PROMOTION_PREVIEW_STALE',
        'What runs changed since the preview; review the promotion again'
      );
    }
    const wanted = new Set(input.items);
    const selected = preview.items.filter((item) => wanted.has(item.pairKey));
    if (selected.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Select at least one item to promote');
    const records: AppPromotionItemRecord[] = selected.map((item) => ({
      pairKey: item.pairKey,
      type: item.type,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      sourceNodeId: item.sourceNodeId,
      targetId: item.targetId,
      targetName: item.targetName,
      targetNodeId: item.targetNodeId,
      from: item.from,
      to: item.to,
      status: item.promotable ? 'pending' : 'skipped',
      detail: item.promotable ? null : (item.reason ?? 'Not promotable'),
      error: null,
      startedAt: null,
      finishedAt: null,
    }));
    const [promotion] = await this.db
      .insert(appPromotions)
      .values({
        appId: app.id,
        sourceEnvironmentId: source.id,
        targetEnvironmentId: target.id,
        previewDigest: preview.previewDigest,
        items: records,
        startedById: actor.userId,
      })
      .returning();
    this.apps.publish(app.id, 'promotion_started');
    void this.run(promotion!.id, actor, { appName: app.name, sourceName: source.name, targetName: target.name });
    return this.view(promotion!);
  }

  private async run(
    promotionId: string,
    actor: AppActor,
    names: { appName: string; sourceName: string; targetName: string }
  ): Promise<void> {
    if (this.running.has(promotionId)) return;
    this.running.add(promotionId);
    try {
      const [row] = await this.db.select().from(appPromotions).where(eq(appPromotions.id, promotionId)).limit(1);
      if (!row) return;
      const items = [...row.items];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.status !== 'pending') continue;
        items[index] = { ...item, status: 'running', startedAt: new Date().toISOString() };
        await this.saveItems(promotionId, items);
        try {
          const detail = await this.promoteItem(item, actor, async (progress) => {
            items[index] = { ...items[index]!, detail: progress };
            await this.saveItems(promotionId, items);
            this.apps.publish(row.appId, 'promotion_progress');
          });
          items[index] = { ...items[index]!, status: 'succeeded', detail, finishedAt: new Date().toISOString() };
        } catch (error) {
          items[index] = {
            ...items[index]!,
            status: 'failed',
            error: errorMessage(error),
            finishedAt: new Date().toISOString(),
          };
        }
        await this.saveItems(promotionId, items);
        this.apps.publish(row.appId, 'promotion_progress');
      }
      const done = items.filter((item) => item.status !== 'skipped');
      const failed = done.filter((item) => item.status === 'failed').length;
      const status = failed === 0 ? 'succeeded' : failed === done.length ? 'failed' : 'partial';
      await this.db
        .update(appPromotions)
        .set({ status, items, finishedAt: new Date() })
        .where(eq(appPromotions.id, promotionId));
      await this.auditService.log({
        userId: actor.userId,
        action: 'app.environment.promote',
        resourceType: 'app_environment',
        resourceId: row.targetEnvironmentId,
        details: {
          appId: row.appId,
          appName: names.appName,
          sourceEnvironmentId: row.sourceEnvironmentId,
          sourceEnvironmentName: names.sourceName,
          environmentName: names.targetName,
          promotionId,
          status,
          items: items.map((item) => ({
            type: item.type,
            name: item.targetName,
            from: item.from,
            to: item.to,
            status: item.status,
            error: item.error,
          })),
        },
      });
      this.apps.publish(row.appId, 'promotion_finished');
    } catch (error) {
      logger.warn('Promotion run failed', { promotionId, error: errorMessage(error) });
      await this.db
        .update(appPromotions)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(eq(appPromotions.id, promotionId))
        .catch(() => undefined);
    } finally {
      this.running.delete(promotionId);
    }
  }

  private async saveItems(promotionId: string, items: AppPromotionItemRecord[]) {
    await this.db.update(appPromotions).set({ items }).where(eq(appPromotions.id, promotionId));
  }

  /**
   * Runs one item; returns what happened for the summary. Re-reads what runs now (no stale image is deployed). An item
   * returns only once its rollout finished; `progress` shows what it waits for meanwhile.
   */
  private async promoteItem(
    item: AppPromotionItemRecord,
    actor: AppActor,
    progress: (detail: string) => Promise<void> = async () => undefined
  ): Promise<string> {
    switch (item.type) {
      case 'container': {
        if (!item.sourceNodeId)
          throw new AppError(409, 'PROMOTION_SOURCE_NOT_RUNNING', `${item.sourceName} does not run`);
        const image = await this.runningImage(item.sourceNodeId, item.sourceId);
        if (!image) throw new AppError(409, 'PROMOTION_SOURCE_NOT_RUNNING', `${item.sourceName} does not run`);
        const targetNodeId = item.targetNodeId!;
        await this.freeze.assertNotFrozen({ kind: 'container', nodeId: targetNodeId, name: item.targetId });
        const ownerKey = `container:${targetNodeId}:${item.targetId}`;
        const ref = await this.pullableImage(
          image,
          targetNodeId,
          ownerKey,
          'container',
          `${targetNodeId}:${item.targetId}`,
          actor
        );
        const recreate = await this.resolve(DockerManagementService)!.recreateWithConfig(
          targetNodeId,
          item.targetId,
          { image: ref.image },
          actor.userId,
          {
            actorScopes: [...actor.scopes],
            skipImagePull: ref.local,
            // A highly available container rolls out through its availability policy: wait for that rollout.
            waitForAvailability: true,
          }
        );
        await this.waitForRecreate(recreate, item.targetName, progress);
        if (ref.pin) await this.pinArtifact(ref.pin, ownerKey, actor.userId);
        return `Recreated with ${displayImage(image)}${image.build ? ` (commit ${image.build.commitSha.slice(0, 7)}, not rebuilt)` : ''}`;
      }
      case 'deployment': {
        const source = await this.deploymentImage(item.sourceId);
        if (!source?.image) throw new AppError(409, 'PROMOTION_SOURCE_NOT_RUNNING', `${item.sourceName} does not run`);
        const [target] = await this.db
          .select({ nodeId: dockerDeployments.nodeId })
          .from(dockerDeployments)
          .where(eq(dockerDeployments.id, item.targetId))
          .limit(1);
        if (!target) throw new AppError(404, 'DEPLOYMENT_NOT_FOUND', `${item.targetName} is gone`);
        await this.freeze.assertNotFrozen({ kind: 'deployment', id: item.targetId });
        const ownerKey = `deployment:${item.targetId}`;
        const ref = await this.pullableImage(source.image, target.nodeId, ownerKey, 'deployment', item.targetId, actor);
        await this.resolve(DockerDeploymentService)!.deploy(
          target.nodeId,
          item.targetId,
          { image: ref.image } as never,
          actor.userId,
          'app_promotion',
          [...actor.scopes]
        );
        if (ref.pin) await this.pinArtifact(ref.pin, ownerKey, actor.userId);
        return `Blue-green switch to ${displayImage(source.image)}`;
      }
      case 'compose': {
        const sourceState = await this.composeState(item.sourceId);
        const targetState = await this.composeState(item.targetId);
        if (!sourceState?.revision)
          throw new AppError(409, 'PROMOTION_SOURCE_NOT_RUNNING', `${item.sourceName} has no active revision`);
        if (!targetState) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', `${item.targetName} is gone`);
        await this.freeze.assertNotFrozen({ kind: 'compose', id: item.targetId });
        // Internal artifacts are pulled by the target node: bind each repository first.
        const registry = this.resolve(RelayRegistryService);
        for (const image of sourceState.services.values()) {
          if (image?.internal && image.repository && registry) {
            await registry.ensureBinding({
              nodeId: targetState.project.nodeId,
              role: 'runtime',
              repository: image.repository.slice(INTERNAL_REGISTRY.length),
              actions: ['pull'],
              contextKind: 'compose_project',
              contextId: targetState.project.id,
            });
          }
        }
        const result = await this.resolve(DockerComposeService)!.applyPromotedRevision(
          targetState.project.nodeId,
          targetState.project.id,
          {
            sourceYaml: this.pinComposeYaml(sourceState.revision.sourceYaml, sourceState.services),
            promotedFromRevisionId: sourceState.revision.id,
          },
          actor.userId
        );
        if (result.operationId) {
          const operation = await this.resolve(DockerComposeService)!.waitForOperation(result.operationId, 10 * 60_000);
          if (operation?.status && operation.status !== 'succeeded') {
            throw new AppError(
              502,
              'PROMOTION_COMPOSE_APPLY_FAILED',
              `Revision #${result.revisionNumber} was created; applying it ended ${operation.status}${operation.error ? `: ${operation.error}` : ''}`
            );
          }
        }
        const changed = [...sourceState.services.entries()]
          .filter(([name, image]) => (image?.digest ?? null) !== (targetState.services.get(name)?.digest ?? null))
          .map(([name]) => name);
        return `Redeployed at revision #${result.revisionNumber}${changed.length ? ` · ${changed.join(', ')} updated` : ''}`;
      }
      case 'pages': {
        const active = await this.pagesActive(item.sourceId);
        if (!active)
          throw new AppError(409, 'PROMOTION_SOURCE_NOT_RUNNING', `${item.sourceName} has no active deployment`);
        await this.freeze.assertNotFrozen({ kind: 'pages', id: item.targetId });
        const result = await this.resolve(PageDeploymentService)!.promoteDeployment(
          active.deploymentId,
          item.targetId,
          actor.userId
        );
        return `Artifact ${shortDigest(`sha256:${active.artifactSha256}`)} from #${active.sequence} is active (deployment #${result.sequence}${result.previousSequence ? `, was #${result.previousSequence}` : ''})`;
      }
    }
  }

  /**
   * Waits for the recreate task the node runs (it may pull first and recreate minutes after the request returned):
   * the item succeeds only once the target runs the new container, and fails with the task's error otherwise. A
   * rollout through the availability policy was already awaited and returns no task.
   */
  private async waitForRecreate(
    result: unknown,
    targetName: string,
    progress: (detail: string) => Promise<void>
  ): Promise<void> {
    const taskId = result && typeof result === 'object' ? (result as { taskId?: unknown }).taskId : undefined;
    if (typeof taskId !== 'string' || !taskId) return;
    const tasks = this.resolve(DockerTaskService);
    if (!tasks) return;
    await progress(`Waiting for ${targetName} to be recreated`).catch(() => undefined);
    const { timeoutMs, pollMs } = this.rolloutWait;
    const error = containerRolloutError(await tasks.waitForEnd(taskId, timeoutMs, pollMs), targetName, timeoutMs);
    if (error) throw error;
  }

  /**
   * A reference the target node can run: a registry digest as is; an internal artifact after binding the target node
   * to its repository (pinned for the target afterwards); an image only on the source node: its id when the target
   * runs on the same node, else copied to the internal registry first.
   */
  private async pullableImage(
    image: RunningImage,
    targetNodeId: string,
    ownerKey: string,
    contextKind: 'container' | 'deployment',
    contextId: string,
    actor: AppActor
  ): Promise<{ image: string; local: boolean; pin: { repository: string; digest: string } | null }> {
    const registry = this.resolve(RelayRegistryService);
    const bind = async (repository: string) =>
      registry?.ensureBinding({
        nodeId: targetNodeId,
        role: 'runtime',
        repository,
        actions: ['pull'],
        contextKind,
        contextId,
      });
    if (image.internal && image.digest && image.repository) {
      const repository = image.repository.slice(INTERNAL_REGISTRY.length);
      await bind(repository);
      return { image: image.image, local: false, pin: { repository, digest: image.digest } };
    }
    if (!image.localOnly) return { image: image.image, local: false, pin: null };
    if (image.nodeId === targetNodeId && image.imageId) return { image: image.imageId, local: true, pin: null };
    const snapshot = await this.snapshotLocalImage(image.nodeId, image.imageId ?? image.image, ownerKey, actor.userId);
    await bind(snapshot.repository);
    return { image: snapshot.image, local: false, pin: { repository: snapshot.repository, digest: snapshot.digest } };
  }

  /**
   * The target now runs this internal artifact: it becomes the owner's active pin (its previous one the rollback pin),
   * so registry retention keeps what each environment runs. A promoted Git artifact is not rebuilt for its new owner.
   */
  private async pinArtifact(pin: { repository: string; digest: string }, ownerKey: string, userId: string | null) {
    const [artifact] = await this.db
      .select({ id: dockerBuildArtifacts.id })
      .from(dockerBuildArtifacts)
      .where(
        and(eq(dockerBuildArtifacts.registryRepository, pin.repository), eq(dockerBuildArtifacts.digest, pin.digest))
      )
      .orderBy(desc(dockerBuildArtifacts.createdAt))
      .limit(1);
    if (!artifact) return;
    await this.db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ artifactId: dockerArtifactPins.artifactId })
        .from(dockerArtifactPins)
        .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'active')))
        .orderBy(desc(dockerArtifactPins.createdAt))
        .limit(1);
      if (previous?.artifactId === artifact.id) return;
      await tx
        .delete(dockerArtifactPins)
        .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'rollback')));
      await tx
        .delete(dockerArtifactPins)
        .where(and(eq(dockerArtifactPins.ownerKey, ownerKey), eq(dockerArtifactPins.kind, 'active')));
      if (previous) {
        await tx.insert(dockerArtifactPins).values({
          artifactId: previous.artifactId,
          kind: 'rollback',
          ownerKey,
          reason: 'Ran before an app promotion',
          createdById: userId,
        });
      }
      await tx.insert(dockerArtifactPins).values({
        artifactId: artifact.id,
        kind: 'active',
        ownerKey,
        reason: 'Promoted from another app environment',
        createdById: userId,
      });
    });
  }

  /**
   * An image that exists only on its node goes to the internal registry first (the Availability mirror path), as an
   * artifact owned by the promotion target, so another node can pull it by digest.
   */
  private async snapshotLocalImage(
    nodeId: string,
    image: string,
    ownerKey: string,
    userId: string | null
  ): Promise<{ image: string; repository: string; digest: string }> {
    const dispatch = this.resolve(NodeDispatchService);
    const registry = this.resolve(RelayRegistryService);
    if (!dispatch || !registry) {
      throw new AppError(409, 'PROMOTION_IMAGE_LOCAL', 'The image exists only on its node and cannot be copied here');
    }
    await this.resolve(DockerInternalRegistryService)?.assertBuildAdmission();
    const owner = createHash('sha256').update(ownerKey).digest('hex').slice(0, 16);
    const repository = `gateway/promotion/${owner}/${Date.now()}`;
    await registry.ensureBinding({
      nodeId,
      role: 'mirror',
      repository,
      actions: ['pull', 'push'],
      contextKind: ownerKey.startsWith('deployment:') ? 'deployment' : 'container',
      contextId: ownerKey,
    });
    const result = await dispatch.sendDockerImageCommand(
      nodeId,
      'mirror',
      { imageRef: image, targetImageRef: `${INTERNAL_REGISTRY}${repository}:image` },
      15 * 60_000
    );
    if (!result.success) {
      throw new AppError(
        502,
        'PROMOTION_IMAGE_COPY_FAILED',
        result.error || 'The image could not be copied to the internal registry'
      );
    }
    let detail: { repository?: unknown; digest?: unknown; platform?: unknown; sizeBytes?: unknown } = {};
    try {
      detail = JSON.parse(result.detail ?? '{}');
    } catch {
      detail = {};
    }
    if (typeof detail.digest !== 'string' || !DIGEST_RE.test(detail.digest)) {
      throw new AppError(
        502,
        'PROMOTION_IMAGE_COPY_FAILED',
        'The Docker daemon returned no digest for the copied image'
      );
    }
    const copiedRepository = typeof detail.repository === 'string' ? detail.repository : repository;
    await this.db.insert(dockerBuildArtifacts).values({
      ownerKind: 'promotion',
      ownerKey,
      sourceImageReference: image,
      registryRepository: copiedRepository,
      digest: detail.digest,
      platform: typeof detail.platform === 'string' ? detail.platform : 'linux/amd64',
      sizeBytes: Number.isSafeInteger(detail.sizeBytes) ? Number(detail.sizeBytes) : 0,
      status: 'ready',
      policyDecision: 'approved',
      policyReason: `Copied for an app promotion by ${userId ?? 'Gateway'}`,
      verifiedAt: new Date(),
    });
    return {
      image: `${INTERNAL_REGISTRY}${copiedRepository}@${detail.digest}`,
      repository: copiedRepository,
      digest: detail.digest,
    };
  }

  // ── Reads ────────────────────────────────────────────────────────

  async get(scopes: readonly string[], appIdOrSlug: string, promotionId: string) {
    const { app, envs } = await this.apps.resolveVisible(scopes, appIdOrSlug);
    const [row] = await this.db
      .select()
      .from(appPromotions)
      .where(and(eq(appPromotions.id, promotionId), eq(appPromotions.appId, app.id)))
      .limit(1);
    const visible = new Set(
      visibleEnvironmentIds(
        scopes,
        app.id,
        envs.map((env) => env.id)
      )
    );
    if (!row || !visible.has(row.targetEnvironmentId)) {
      throw new AppError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
    }
    return this.view(row);
  }

  /** Recent promotions of the app (into or out of the environments the caller can view), newest first. */
  async list(scopes: readonly string[], appIdOrSlug: string, environmentId?: string) {
    const { app, envs } = await this.apps.resolveVisible(scopes, appIdOrSlug);
    const visible = new Set(
      visibleEnvironmentIds(
        scopes,
        app.id,
        envs.map((env) => env.id)
      )
    );
    const rows = await this.db
      .select()
      .from(appPromotions)
      .where(
        environmentId
          ? and(eq(appPromotions.appId, app.id), eq(appPromotions.targetEnvironmentId, environmentId))
          : eq(appPromotions.appId, app.id)
      )
      .orderBy(desc(appPromotions.startedAt))
      .limit(20);
    return Promise.all(rows.filter((row) => visible.has(row.targetEnvironmentId)).map((row) => this.view(row)));
  }

  private async view(row: AppPromotion) {
    const [starter] = row.startedById
      ? await this.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, row.startedById))
          .limit(1)
      : [];
    return {
      id: row.id,
      appId: row.appId,
      sourceEnvironmentId: row.sourceEnvironmentId,
      targetEnvironmentId: row.targetEnvironmentId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      startedBy: starter ? { id: starter.id, name: starter.name } : null,
      items: row.items,
    };
  }
}
