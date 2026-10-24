import { randomUUID } from 'node:crypto';
import type { FleetRole, MatrixContext } from './context.js';
import { data, errorCode, ok, type Response, rows, sleep } from './http.js';
import {
  concrete,
  type Operation,
  type Schema,
  Spec,
  type SynthContext,
  scalarFields,
  schemaTypes,
  synthesize,
  wrongType,
} from './openapi.js';
import { sseProbe } from './probe.js';
import { excerpt, redact } from './report.js';

/** Never mutated by the crawl: identity, global system actions, license/cloud, credentials. */
const MUTATION_DENY = [
  '/auth',
  '/api/admin',
  '/api/system',
  '/api/tokens',
  '/api/ai',
  '/api/mcp',
  '/api/oauth',
  '/api/setup',
  '/api/housekeeping',
  '/api/webhooks',
  '/api/public',
  '/pki',
  '/api/docker/registries/internal',
  '/api/audit/export',
  '/api/settings',
  '/api/monitoring/dashboard/bootstrap',
];
/** Families whose create starts long-running workloads; the runtime phase drives them with real fixtures. */
const CRUD_RUNTIME_OWNED: Record<string, string> = {
  '/api/databases/managed': 'managed databases are driven by the runtime phase',
  '/api/managed-storage': 'managed S3 is driven by the runtime phase',
  '/api/docker/availability': 'availability needs two docker nodes',
  '/api/docker/migrations': 'migrations need two docker nodes',
  '/api/storage/copy-jobs': 'copy jobs need two storage connections',
  '/api/docker/nodes/{nodeId}/compose-projects': 'Compose is driven by the runtime phase',
  '/api/docker/nodes/{nodeId}/deployments': 'deployments are driven by the runtime phase',
  '/api/docker/container-links': 'container links are driven by the runtime phase',
};
const STREAMING = /(\/stream$|\/logs\/[^/]+\/stream|\/export$|\/download$|\/archive$|\/monitoring\/stream)/;
const DONE_STATUSES = new Set([404, 410]);

type Resolved = { path: string } | { unresolved: string };

function denied(path: string) {
  return MUTATION_DENY.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function roleForPath(path: string): FleetRole {
  if (/\/docker\/|\/apps\//.test(path)) return 'docker';
  if (/databases|managed-storage|object-storage|storage/.test(path)) return 'storage';
  if (/proxy|nginx|domains|ssl|pages/.test(path)) return 'nginx';
  if (/relay/.test(path)) return 'relay';
  if (/build/.test(path)) return 'builder';
  if (/monitoring/.test(path)) return 'monitoring';
  return 'docker';
}

function idOf(value: any, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 2) return undefined;
  if (typeof value.id === 'string' || typeof value.id === 'number') return String(value.id);
  for (const key of [
    'data',
    'item',
    'project',
    'resource',
    'host',
    'node',
    'connector',
    'certificate',
    'ca',
    'app',
    'page',
  ]) {
    const nested = idOf(value[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function looksLikeUuidParam(name: string) {
  return name === 'id' || /Id$/.test(name);
}

export class Crawler {
  private readonly listCache = new Map<string, any[] | null>();
  private portCounter = 18_100;

  constructor(
    private readonly ctx: MatrixContext,
    readonly spec: Spec
  ) {}

  static async load(ctx: MatrixContext) {
    for (const path of ['/api/openapi.json', '/openapi.json']) {
      const response = await ctx.client.get(path, { timeoutMs: 120_000 });
      if (ok(response) && (response.body as any)?.paths) return new Crawler(ctx, new Spec(response.body));
    }
    throw new Error('OpenAPI document is not reachable at /api/openapi.json or /openapi.json');
  }

  synthContext(unique = Math.random().toString(36).slice(2, 7)): SynthContext {
    return {
      prefix: this.ctx.config.prefix,
      unique,
      nextPort: () => (this.portCounter += 1),
      resolveId: (field) => {
        if (/nodeid$/i.test(field)) {
          const role: FleetRole = /docker|target|source/i.test(field)
            ? 'docker'
            : /executor/i.test(field)
              ? 'storage'
              : 'nginx';
          return this.ctx.node(role)?.nodeId ?? this.ctx.node('docker')?.nodeId;
        }
        return undefined;
      },
    };
  }

  private async list(path: string) {
    if (this.listCache.has(path)) return this.listCache.get(path) ?? null;
    const response = await this.ctx.client.get(path, { query: { limit: 100 } });
    const value = ok(response) ? rows(response) : null;
    this.listCache.set(path, value);
    return value;
  }

  /**
   * Fills path params: node ids from the fleet; other ids from the first row of the parent collection, preferring
   * rows this run created. `mutating` refuses parents that are not fleet nodes or run-created rows.
   */
  async resolvePath(op: Operation, mutating: boolean): Promise<Resolved> {
    const segments = op.path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const match = /^\{(.+)\}$/.exec(segments[index]!);
      if (!match) continue;
      const param = match[1]!;
      const parent = segments.slice(0, index).join('/');
      const isNodeParam = /nodeid$/i.test(param) || (param === 'id' && /\/api\/(nodes|hosting\/nodes)$/.test(parent));
      if (isNodeParam) {
        const node = this.ctx.node(roleForPath(op.path)) ?? this.ctx.node('docker');
        if (!node) return { unresolved: `no fleet node for {${param}}` };
        segments[index] = node.nodeId;
        continue;
      }
      const list = await this.list(parent);
      if (!list) return { unresolved: `parent collection ${parent} is not listable for {${param}}` };
      const prefix = this.ctx.config.prefix;
      const fleetIds = new Set([...this.ctx.fleet.values()].map((node) => node.nodeId));
      const owned = list.filter(
        (row) =>
          JSON.stringify([row?.name, row?.hostname, row?.slug, row?.displayName, row?.projectName]).includes(prefix) ||
          fleetIds.has(row?.nodeId)
      );
      const pool = mutating ? owned : owned.length ? owned : list;
      const row = pool[0];
      if (!row) return { unresolved: `no ${mutating ? 'run-owned ' : ''}row in ${parent} for {${param}}` };
      const value = /name|slug|tag|version|category|provider|key/i.test(param)
        ? (row[param] ?? row.name ?? row.slug ?? row.tag ?? row.id)
        : (row[param] ?? row.id);
      if (value === undefined || value === null)
        return { unresolved: `row in ${parent} carries no value for {${param}}` };
      segments[index] = encodeURIComponent(String(value));
    }
    return { path: segments.join('/') };
  }

  queryFor(op: Operation) {
    const query: Record<string, string> = {};
    for (const param of op.queryParams.filter((item) => item.required)) {
      const value = synthesize(this.spec, param.schema, this.synthContext(), param.name);
      if (value !== undefined) query[param.name] = String(value);
    }
    return query;
  }

  /** Every GET must answer without a 5xx; item GETs also get malformed and unknown id probes. */
  async crawlGets() {
    const gets = this.spec.operations.filter((op) => op.method === 'GET');
    await pool(gets, 6, async (op) => {
      if (op.eventStream) {
        await this.probeEventStream(op);
        return;
      }
      if (op.streaming || STREAMING.test(op.path)) {
        this.ctx.report.cover(op.key, 'skipped', undefined, 'streaming or binary download endpoint');
        return;
      }
      // Credential reveals only ever read rows this run created.
      const secret = /reveal|credential|secret|export-key/.test(op.path);
      const resolved = await this.resolvePath(op, secret);
      if ('unresolved' in resolved) {
        this.ctx.report.cover(op.key, 'skipped', undefined, resolved.unresolved);
        return;
      }
      const response = await this.ctx.client.get(resolved.path, {
        template: op.path,
        query: this.queryFor(op),
        secretResponse: secret,
      });
      this.classifyGet(op, response);
      await this.probeIds(op);
    });
  }

  /** Every documented event stream answers with `X-Accel-Buffering: no` and sends its first event promptly. */
  private async probeEventStream(op: Operation) {
    const resolved = await this.resolvePath(op, false);
    if ('unresolved' in resolved) {
      this.ctx.report.cover(op.key, 'skipped', undefined, resolved.unresolved);
      return;
    }
    const query = new URLSearchParams(this.queryFor(op)).toString();
    const result = await sseProbe(`${this.ctx.config.url}${resolved.path}${query ? `?${query}` : ''}`, {
      headers: { Authorization: `Bearer ${this.ctx.config.token}` },
    });
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      this.ctx.report.cover(op.key, 'skipped', 'event-stream', `HTTP ${result.status}`);
      return;
    }
    const problems = [
      result.status >= 500 || result.status === 0
        ? `HTTP ${result.status}${result.error ? ` (${result.error})` : ''}`
        : '',
      result.status === 200 && result.accelBuffering !== 'no' ? `X-Accel-Buffering is "${result.accelBuffering}"` : '',
      result.status === 200 && result.firstEventMs === undefined ? `no first event (${result.error ?? 'ended'})` : '',
    ].filter(Boolean);
    this.ctx.report.cover(
      op.key,
      problems.length ? 'failed' : 'exercised',
      'event-stream',
      problems.join('; ') || undefined
    );
    if (problems.length)
      this.ctx.report.add({
        severity: 'medium',
        invariant: 'event-stream-unbuffered',
        title: `${op.key}: ${problems.join('; ')}`,
        dedupeKey: `event-stream|${op.key}`,
        request: { method: 'GET', path: op.path },
      });
  }

  private classifyGet(op: Operation, response: Response) {
    if (response.status === 503 && /(DISABLED|NOT_CONFIGURED)$/.test(errorCode(response) ?? ''))
      this.ctx.report.cover(
        op.key,
        'skipped',
        'get-non-5xx',
        `feature off on this installation (${errorCode(response)})`
      );
    else if (response.status >= 500 || response.status === 0)
      this.ctx.report.cover(op.key, 'failed', 'get-non-5xx', `HTTP ${response.status}`);
    else if (response.status === 401 || response.status === 403)
      this.ctx.report.cover(
        op.key,
        'skipped',
        'get-non-5xx',
        `HTTP ${response.status} ${errorCode(response) ?? ''} for an API token`.trim()
      );
    else this.ctx.report.cover(op.key, 'exercised', 'get-non-5xx');
  }

  private async probeIds(op: Operation) {
    const last = op.pathParams.at(-1);
    if (!last || !op.path.endsWith(`{${last}}`) || !looksLikeUuidParam(last)) return;
    const base = op.path.replace(/\/\{[^}]+\}$/, '');
    if (base.includes('{')) return;
    const malformed = await this.ctx.client.get(`${base}/not-a-uuid`, { template: op.path });
    if (ok(malformed))
      this.ctx.report.add({
        severity: 'low',
        invariant: 'malformed-id-4xx',
        title: `GET ${op.path} with a malformed id returns ${malformed.status}`,
        request: { method: 'GET', path: `${base}/not-a-uuid` },
        response: { status: malformed.status, excerpt: excerpt(malformed.body, malformed.text) },
      });
    const unknown = await this.ctx.client.get(`${base}/${randomUUID()}`, { template: op.path });
    if (ok(unknown))
      this.ctx.report.add({
        severity: 'medium',
        invariant: 'unknown-id-404',
        title: `GET ${op.path} with an unknown id returns ${unknown.status} instead of 404`,
        request: { method: 'GET', path: `${base}/<random uuid>` },
        response: { status: unknown.status, excerpt: excerpt(unknown.body, unknown.text) },
      });
    this.ctx.report.cover(op.key, 'exercised', 'id-probes');
  }

  families() {
    const out: Array<{
      create: Operation;
      item: Operation;
      get?: Operation;
      update?: Operation;
      remove?: Operation;
      list?: Operation;
    }> = [];
    for (const create of this.spec.operations.filter(
      (op) => op.method === 'POST' && op.body?.contentType.includes('json')
    )) {
      const itemOps = this.spec.operations.filter((op) => {
        if (!op.path.startsWith(`${create.path}/{`)) return false;
        return /^\/\{[^}/]+\}$/.test(op.path.slice(create.path.length));
      });
      if (!itemOps.length) continue;
      const item = itemOps[0]!;
      const sameItem = (method: string) => itemOps.find((op) => op.method === method);
      const remove = sameItem('DELETE');
      if (!remove) continue;
      out.push({
        create,
        item,
        get: sameItem('GET'),
        update: sameItem('PATCH') ?? sameItem('PUT'),
        remove,
        list: this.spec.find('GET', create.path),
      });
    }
    return out;
  }

  /** Create → read back → listed → update → delete → 404 → unlisted, per CRUD family, with schema-generated bodies. */
  async crudFamilies() {
    const families = this.families();
    this.ctx.report.note(`crawl: ${families.length} CRUD families in the OpenAPI document`);
    await pool(families, 4, async (family) => {
      const label = `CRUD ${family.create.path}`;
      if (denied(family.create.path)) {
        this.ctx.report.cover(family.create.key, 'skipped', undefined, 'protected namespace (identity/system/license)');
        return;
      }
      const owned = CRUD_RUNTIME_OWNED[family.create.path];
      if (owned) {
        this.ctx.report.cover(family.create.key, 'skipped', undefined, owned);
        return;
      }
      const resolved = await this.resolvePath(family.create, true);
      if ('unresolved' in resolved) {
        this.ctx.report.cover(family.create.key, 'skipped', undefined, resolved.unresolved);
        return;
      }
      await this.runFamily(family, resolved.path, label);
    });
  }

  private async runFamily(family: ReturnType<Crawler['families']>[number], collectionPath: string, label: string) {
    const { report, client } = this.ctx;
    let body = synthesize(this.spec, family.create.body!.schema, this.synthContext()) as Record<string, unknown>;
    let created = await client.post(collectionPath, body, { template: family.create.path, allow5xx: true });
    if (created.status === 400 && errorCode(created) === 'VALIDATION_ERROR') {
      // Record the mismatch, then repair the body from the validator's own messages once to keep the lifecycle going.
      this.classifyRefusal(family.create, created, body, 'create');
      const repaired = this.repair(family.create, body, (created.body as any)?.details);
      if (repaired) {
        body = repaired;
        created = await client.post(collectionPath, body, { template: family.create.path, allow5xx: true });
      }
    }
    if (!ok(created)) {
      this.classifyRefusal(family.create, created, body, 'create');
      return;
    }
    report.cover(family.create.key, 'exercised', 'create');
    const createdRow = data<any>(created);
    let id = idOf(createdRow);
    if (!id && /name/i.test(family.item.pathParams.at(-1) ?? ''))
      id = String(createdRow?.name ?? (body as any)?.name ?? '') || undefined;
    if (!id && family.list) {
      const name = (body as any)?.name;
      const list = await client.get(collectionPath, { template: family.list.path, query: { limit: 100 } });
      id = idOf(rows(list).find((row) => name && row.name === name));
    }
    if (!id) {
      report.add({
        severity: 'low',
        invariant: 'create-returns-id',
        title: `${label}: create answered ${created.status} without an id`,
        request: { method: 'POST', path: family.create.path, body: excerpt(body, '', 300) },
        response: { status: created.status, excerpt: excerpt(created.body, created.text) },
      });
      return;
    }
    const itemPath = `${collectionPath}/${encodeURIComponent(id)}`;
    let deleted = false;
    this.ctx.onCleanup(`crawl ${itemPath}`, async () => {
      if (!deleted) await client.delete(itemPath, { template: family.remove!.path });
    });

    if (family.get) {
      const read = await client.get(itemPath, { template: family.get.path });
      report.cover(family.get.key, ok(read) ? 'exercised' : 'failed', 'read-back');
      if (!ok(read))
        report.add({
          severity: 'medium',
          invariant: 'crud-readback',
          title: `${label}: GET of the created row answers ${read.status}`,
          request: { method: 'GET', path: family.get.path },
          response: { status: read.status, excerpt: excerpt(read.body, read.text) },
        });
      else {
        const row = data<any>(read);
        const subject =
          row && typeof row === 'object'
            ? row.id === id
              ? row
              : (Object.values(row).find((value: any) => value?.id === id) ?? row)
            : row;
        const mismatched = scalarFields(body).filter(
          ([key, value]) =>
            subject && key in subject && subject[key] !== value && String(subject[key]).trim() !== String(value).trim()
        );
        if (mismatched.length)
          report.add({
            severity: 'medium',
            invariant: 'crud-readback',
            title: `${label}: read-back differs from the written value for ${mismatched.map(([key]) => key).join(', ')}`,
            request: { method: 'POST', path: family.create.path, body: excerpt(body, '', 300) },
            response: {
              status: read.status,
              excerpt: excerpt(Object.fromEntries(mismatched.map(([key]) => [key, subject[key]])), ''),
            },
          });
      }
    }
    // The same body again: a second row or a conflict, never a 5xx (a unique-name retry inside a transaction, …).
    const duplicate = await client.post(collectionPath, body, { template: family.create.path, allow5xx: true });
    if (duplicate.status >= 500 || duplicate.status === 0)
      report.add({
        severity: 'high',
        invariant: 'duplicate-create',
        title: `${label}: creating the same row twice answers ${duplicate.status}${errorCode(duplicate) ? ` ${errorCode(duplicate)}` : ''} instead of a new row or 409`,
        dedupeKey: `duplicate-create|${family.create.key}`,
        request: { method: 'POST', path: family.create.path, body: excerpt(body, '', 300) },
        response: { status: duplicate.status, excerpt: excerpt(duplicate.body, duplicate.text) },
      });
    else if (ok(duplicate)) {
      const duplicateId =
        idOf(data(duplicate)) ?? (/name/i.test(family.item.pathParams.at(-1) ?? '') ? undefined : undefined);
      if (duplicateId && duplicateId !== id) {
        const duplicatePath = `${collectionPath}/${encodeURIComponent(duplicateId)}`;
        const removedDuplicate = await this.deleteItem(family, duplicatePath, `${label} (duplicate)`);
        if (!ok(removedDuplicate) && removedDuplicate.status !== 404)
          this.ctx.onCleanup(`crawl duplicate ${duplicatePath}`, async () => {
            await this.deleteItem(family, duplicatePath, `${label} (duplicate)`);
          });
      }
    }
    report.cover(`${family.create.key}`, 'exercised', 'duplicate-create');

    if (family.list) {
      const listed = await this.listContains(collectionPath, family.list.path, id, (body as any)?.name);
      report.cover(family.list.key, 'exercised', 'list-contains');
      if (!listed)
        report.add({
          severity: 'medium',
          invariant: 'list-contains-created',
          title: `${label}: the created row is not in the collection list`,
          request: { method: 'GET', path: family.list.path },
        });
    }
    if (family.update) await this.updateOne(family, itemPath, body, label);

    const removed = await this.deleteItem(family, itemPath, label);
    report.cover(family.remove!.key, ok(removed) ? 'exercised' : 'failed', 'delete');
    if (!ok(removed)) {
      report.add({
        severity: 'medium',
        invariant: 'crud-delete',
        title: `${label}: DELETE of a row the run just created answers ${removed.status} (${errorCode(removed) ?? ''})`,
        request: { method: 'DELETE', path: family.remove!.path },
        response: { status: removed.status, excerpt: excerpt(removed.body, removed.text) },
      });
      return;
    }
    deleted = true;
    if (family.get) {
      let gone = false;
      for (let attempt = 0; attempt < 15 && !gone; attempt += 1) {
        const after = await client.get(itemPath, { template: family.get.path });
        gone = DONE_STATUSES.has(after.status);
        if (!gone) await sleep(this.ctx.config.pollMs);
      }
      if (!gone)
        report.add({
          severity: 'medium',
          invariant: 'deleted-is-404',
          title: `${label}: GET after a successful DELETE still answers non-404 after ${Math.round((15 * this.ctx.config.pollMs) / 1000)}s`,
          request: { method: 'GET', path: family.get.path },
        });
    }
    if (family.list && (await this.listContains(collectionPath, family.list.path, id, undefined, true)))
      report.add({
        severity: 'medium',
        invariant: 'list-drops-deleted',
        title: `${label}: the deleted row is still in the collection list`,
        request: { method: 'GET', path: family.list.path },
      });
  }

  /** DELETE an item; on a business precondition (resolve/stop/… first) run the item's own actions and retry once. */
  private async deleteItem(family: ReturnType<Crawler['families']>[number], itemPath: string, label: string) {
    const { client, report } = this.ctx;
    let removed = await client.delete(itemPath, { template: family.remove!.path });
    if (!ok(removed) && removed.status >= 400 && removed.status < 500 && removed.status !== 404) {
      const actions = this.spec.operations.filter(
        (op) =>
          op.method === 'POST' &&
          op.path.startsWith(`${family.item.path}/`) &&
          /\/(resolve|stop|disable|cancel|revoke|close|archive)$/.test(op.path)
      );
      for (const action of actions) {
        const actionBody = action.body ? synthesize(this.spec, action.body.schema, this.synthContext()) : undefined;
        await client.post(`${itemPath}${action.path.slice(family.item.path.length)}`, actionBody, {
          template: action.path,
        });
      }
      if (actions.length) {
        report.note(
          `${label}: DELETE answered ${removed.status} ${errorCode(removed) ?? ''}; ran ${actions.map((op) => op.path.split('/').pop()).join(', ')} first`
        );
        removed = await client.delete(itemPath, { template: family.remove!.path });
      }
    }
    return removed;
  }

  private async listContains(path: string, template: string, id: string, name?: string, ignoreSoftDeleted = false) {
    const first = await this.ctx.client.get(path, { template, query: { limit: 100 } });
    const listed = rows(first);
    const row = listed.find((item) => String(item?.id) === id || item?.name === id);
    if (row) return !(ignoreSoftDeleted && isSoftDeleted(row));
    if (!listed.length && JSON.stringify(data(first) ?? '').includes(id)) return true;
    if (!name) return false;
    const search = await this.ctx.client.get(path, { template, query: { search: name, limit: 100 } });
    return JSON.stringify(data(search) ?? '').includes(id);
  }

  /** Applies the validator's messages to a generated body: adds fields it calls required, fixes absolute paths. */
  private repair(op: Operation, body: Record<string, unknown>, details: unknown): Record<string, unknown> | undefined {
    if (!Array.isArray(details) || !details.length) return undefined;
    const schema = concrete(this.spec, op.body!.schema);
    const next: Record<string, any> = structuredClone(body);
    let changed = false;
    for (const detail of details as Array<{ path?: string; message?: string }>) {
      const message = String(detail.message ?? '');
      const named = [...message.matchAll(/\b([a-z][A-Za-z0-9]+)\b(?=[^.]*\b(?:is |are )?required)/g)].map((m) => m[1]!);
      const listed =
        /requires?\s+(.+)$/i
          .exec(message)?.[1]
          ?.split(/,\s*|\s+and\s+/)
          .map((item) => item.replace(/^and\s+/, '').trim()) ?? [];
      const fields = [
        ...new Set([
          ...String(detail.path ?? '')
            .split('.')
            .filter(Boolean)
            .slice(0, 1),
          ...named,
          ...listed,
        ]),
      ].filter((field) => /^[A-Za-z][A-Za-z0-9]*$/.test(field));
      for (const field of fields) {
        const propertySchema = schema.properties?.[field];
        if (/absolute/i.test(message)) {
          next[field] = `/tmp/${this.ctx.config.prefix}${Math.random().toString(36).slice(2, 7)}`;
          changed = true;
        } else if (propertySchema && (next[field] === undefined || /required/i.test(message))) {
          const value = synthesize(
            this.spec,
            { ...propertySchema, required: concrete(this.spec, propertySchema).required },
            this.synthContext(),
            field,
            1
          );
          if (value !== undefined && JSON.stringify(value) !== JSON.stringify(next[field])) {
            next[field] = value;
            changed = true;
          }
        }
      }
    }
    return changed ? next : undefined;
  }

  private async updateOne(
    family: ReturnType<Crawler['families']>[number],
    itemPath: string,
    body: Record<string, unknown>,
    label: string
  ) {
    const update = family.update!;
    const schema = update.body ? concrete(this.spec, update.body.schema) : undefined;
    const properties: Record<string, Schema> = schema?.properties ?? {};
    const field = ['description', 'displayName', 'name', 'title'].find(
      (key) => key in properties && schemaTypes(this.spec, properties[key]!).includes('string')
    );
    if (!field) {
      this.ctx.report.cover(update.key, 'skipped', undefined, 'no updatable string field in the update schema');
      return;
    }
    const value =
      field === 'description'
        ? `updated by ${this.ctx.config.prefix}matrix`
        : `${String(body[field] ?? this.ctx.name('row')).slice(0, 50)}-u`;
    const payload =
      update.method === 'PUT'
        ? { ...(synthesize(this.spec, update.body!.schema, this.synthContext()) as object), ...body, [field]: value }
        : { [field]: value };
    // A PUT body keeps only fields its schema declares.
    if (update.method === 'PUT')
      for (const key of Object.keys(payload)) if (!(key in properties)) delete (payload as any)[key];
    const response =
      update.method === 'PUT'
        ? await this.ctx.client.put(itemPath, payload, { template: update.path })
        : await this.ctx.client.patch(itemPath, payload, { template: update.path });
    if (!ok(response)) {
      this.classifyRefusal(update, response, payload, 'update');
      return;
    }
    this.ctx.report.cover(update.key, 'exercised', 'update');
    if (!family.get) return;
    const read = await this.ctx.client.get(itemPath, { template: family.get.path });
    const row = data<any>(read);
    if (ok(read) && row && typeof row === 'object' && field in row && row[field] !== value)
      this.ctx.report.add({
        severity: 'medium',
        invariant: 'update-persists',
        title: `${label}: ${update.method} of ${field} answered ${response.status} but the read-back still shows the old value`,
        request: { method: update.method, path: update.path, body: excerpt(payload, '', 300) },
        response: { status: read.status, excerpt: excerpt({ [field]: row[field] }, '') },
      });
  }

  /** A 4xx on a schema-generated body is a validator mismatch unless the error names a missing fixture. */
  private classifyRefusal(op: Operation, response: Response, body: unknown, stage: string) {
    const code = errorCode(response) ?? '';
    if (
      response.status === 500 ||
      response.status === 0 ||
      (response.status >= 500 && (!code || code === 'INTERNAL_ERROR'))
    ) {
      this.ctx.report.cover(op.key, 'failed', stage, `HTTP ${response.status}`);
      this.ctx.report.add({
        severity: 'high',
        invariant: 'no-5xx',
        title: `${op.method} ${op.path} returned ${response.status}${code ? ` ${code}` : ''} on a schema-generated ${stage} body`,
        dedupeKey: `no-5xx|${op.method}|${op.path}|${response.status}`,
        request: { method: op.method, path: op.path, body: excerpt(body, '', 400) },
        response: { status: response.status, excerpt: excerpt(response.body, response.text) },
      });
      return;
    }
    if (response.status >= 500) {
      // 502/503/504 with a code: an upstream the generated body points at (example.test) is unreachable, or a feature is off.
      this.ctx.report.cover(op.key, 'skipped', stage, `needs a fixture: HTTP ${response.status} ${code}`.trim());
      return;
    }
    if (response.status === 400 && code === 'VALIDATION_ERROR') {
      this.ctx.report.cover(op.key, 'failed', stage, 'VALIDATION_ERROR on a schema-generated body');
      const details = (response.body as any)?.details;
      this.ctx.report.add({
        severity: 'low',
        invariant: 'schema-validator-match',
        title: `${op.key}: a ${stage} body generated exactly from the OpenAPI schema is rejected by the validator`,
        dedupeKey: `schema-validator-match|${op.key}`,
        request: { method: op.method, path: op.path, body: excerpt(body, '', 500) },
        response: { status: response.status, excerpt: excerpt(details ?? response.body, response.text) },
      });
      return;
    }
    this.ctx.report.cover(op.key, 'skipped', stage, `needs a fixture: HTTP ${response.status} ${code}`.trim());
  }

  /** Wrong types, missing required fields and broken JSON must answer 4xx with an error code, never 5xx/2xx. */
  async negativeFuzz() {
    const targets = this.spec.operations.filter(
      (op) => ['POST', 'PUT', 'PATCH'].includes(op.method) && op.body?.contentType.includes('json') && !denied(op.path)
    );
    await pool(targets, 8, async (op) => {
      const schema = concrete(this.spec, op.body!.schema);
      const properties: Record<string, Schema> = schema.properties ?? {};
      if (!Object.keys(properties).length) return;
      const path = this.fuzzPath(op);
      const probes: Array<{ name: string; body: unknown; raw?: string }> = [];
      if ((schema.required ?? []).length) probes.push({ name: 'missing-required', body: {} });
      probes.push({
        name: 'wrong-types',
        body: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, wrongType(this.spec, value)])),
      });
      probes.push({ name: 'broken-json', body: undefined, raw: '{"mx": ' });
      for (const probe of probes) {
        const response = await this.ctx.client.call(op.method, path, {
          template: op.path,
          ...(probe.raw ? { body: probe.raw, headers: { 'Content-Type': 'application/json' } } : { json: probe.body }),
        });
        if (response.status >= 400 && response.status < 500) {
          if (!errorCode(response) && !(response.body as any)?.error && !(response.body as any)?.message)
            this.ctx.report.add({
              severity: 'low',
              invariant: 'error-has-code',
              title: `${op.key}: ${probe.name} answers ${response.status} without an error code`,
              dedupeKey: `error-has-code|${op.key}`,
              request: { method: op.method, path: op.path, body: probe.raw ?? excerpt(probe.body, '', 300) },
              response: { status: response.status, excerpt: excerpt(response.body, response.text, 200) },
            });
          continue;
        }
        if (ok(response)) {
          this.ctx.report.add({
            severity: 'medium',
            invariant: 'validation-rejects-invalid',
            title: `${op.key}: ${probe.name} body is accepted with ${response.status}`,
            dedupeKey: `validation-rejects-invalid|${op.key}|${probe.name}`,
            request: { method: op.method, path: op.path, body: probe.raw ?? excerpt(redact(probe.body), '', 300) },
            response: { status: response.status, excerpt: excerpt(response.body, response.text) },
          });
          const createdId = idOf(data(response));
          if (createdId && op.method === 'POST')
            await this.ctx.client.delete(`${path}/${createdId}`, { allow5xx: true });
        }
      }
      this.ctx.report.cover(op.key, 'exercised', 'negative-fuzz');
    });
  }

  /** Collection creates on fleet nodes use the real node; everything else gets unknown ids so a lax validator cannot touch real rows. */
  private fuzzPath(op: Operation) {
    const isCreate =
      op.method === 'POST' && !op.path.endsWith('}') && op.pathParams.every((param) => /nodeid$/i.test(param));
    return op.path.replace(/\{([^}]+)\}/g, (_match, param: string) => {
      if (isCreate && /nodeid$/i.test(param)) {
        const node = this.ctx.node(roleForPath(op.path)) ?? this.ctx.node('docker');
        if (node) return node.nodeId;
      }
      return /name|slug|tag|key|version|category|provider|action|slot/i.test(param)
        ? `${this.ctx.config.prefix}nonexistent`
        : randomUUID();
    });
  }

  /** GET collections whose only parameter is the node, e.g. a docker node's containers. */
  nodeScopedLists() {
    return this.spec.operations
      .filter(
        (op) =>
          op.method === 'GET' &&
          op.pathParams.length === 1 &&
          op.pathParams[0] === 'nodeId' &&
          op.path.endsWith('s') &&
          !op.streaming
      )
      .map((op) => op.path);
  }

  /** Lists that may hold rows named with the run prefix, for leftover checks. */
  leftoverLists() {
    return this.spec.operations
      .filter(
        (op) =>
          op.method === 'GET' && !op.path.includes('{') && !op.streaming && !STREAMING.test(op.path) && !denied(op.path)
      )
      .map((op) => op.path);
  }
}

export async function findLeftovers(ctx: MatrixContext, crawler: Crawler, label: string, allowFleet: boolean) {
  const prefix = ctx.config.prefix;
  const fleetName = new RegExp(`^${prefix}(nginx|docker|storage|builder|monitoring|relay)(-r|-existing)?$`);
  const found: string[] = [];
  // Top-level lists, plus node-scoped lists (containers, volumes, Compose, deployments…) of every ready fleet node.
  const paths = [
    ...crawler.leftoverLists(),
    ...crawler
      .nodeScopedLists()
      .flatMap((template) =>
        [...ctx.fleet.values()].filter((node) => node.ready).map((node) => template.replace('{nodeId}', node.nodeId))
      ),
  ];
  await pool(paths, 6, async (path) => {
    const response = await ctx.client.get(path, { query: { limit: 100 } });
    if (!ok(response)) return;
    for (const row of rows(response)) {
      if (isSoftDeleted(row)) continue;
      const names = [
        row?.name,
        row?.Name,
        row?.hostname,
        row?.slug,
        row?.displayName,
        row?.projectName,
        row?.commonName,
        row?.title,
        ...(row?.domainNames ?? []),
        ...(row?.Names ?? []),
        ...(row?.names ?? []),
      ]
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).replace(/^\//, ''));
      const hit = names.find((value) => value.startsWith(prefix) || value.includes(`.${prefix}`));
      if (!hit) continue;
      if (allowFleet && names.some((value) => fleetName.test(value))) continue;
      found.push(`${path}: ${hit}`);
    }
  });
  if (found.length)
    ctx.report.add({
      severity: 'medium',
      invariant: 'no-leftovers',
      title: `${label}: ${found.length} run-prefixed rows still listed after cleanup`,
      dedupeKey: `no-leftovers|${label}`,
      detail: found.slice(0, 40).join('; '),
    });
  return found;
}

function isSoftDeleted(row: any) {
  return Boolean(
    row?.revokedAt || row?.deletedAt || ['revoked', 'deleted', 'deleting'].includes(String(row?.status ?? ''))
  );
}

export async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await run(item);
      } catch (error) {
        console.error('  crawl worker error:', error instanceof Error ? error.message : error);
      }
    }
  });
  await Promise.all(workers);
}
