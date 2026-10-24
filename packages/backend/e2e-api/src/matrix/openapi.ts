import { randomUUID } from 'node:crypto';

export type Schema = Record<string, any>;

export type Operation = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  key: string;
  pathParams: string[];
  queryParams: Array<{ name: string; required: boolean; schema: Schema }>;
  body?: { contentType: string; schema: Schema; required: boolean };
  tags: string[];
  /** Declares an event-stream or binary (non-JSON) success response. */
  streaming: boolean;
  /** Declares a text/event-stream success response. */
  eventStream: boolean;
};

export class Spec {
  readonly operations: Operation[] = [];

  constructor(readonly document: any) {
    for (const [path, item] of Object.entries<any>(document.paths ?? {})) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const op = item?.[method];
        if (!op) continue;
        const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((param: any) => this.resolve(param));
        const content = this.resolve(op.requestBody ?? {})?.content ?? {};
        const contentType = Object.keys(content)[0];
        this.operations.push({
          method: method.toUpperCase() as Operation['method'],
          path,
          key: `${method.toUpperCase()} ${path}`,
          pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!),
          queryParams: params
            .filter((param: any) => param?.in === 'query')
            .map((param: any) => ({
              name: param.name,
              required: Boolean(param.required),
              schema: this.resolve(param.schema ?? {}),
            })),
          body: contentType
            ? {
                contentType,
                schema: this.resolve(content[contentType]?.schema ?? {}),
                required: Boolean(op.requestBody?.required),
              }
            : undefined,
          tags: op.tags ?? [],
          eventStream: Object.values<any>(op.responses ?? {}).some((response) =>
            Object.keys(this.resolve(response)?.content ?? {}).some((type) => /event-stream/.test(type))
          ),
          streaming: Object.values<any>(op.responses ?? {}).some((response) =>
            Object.keys(this.resolve(response)?.content ?? {}).some((type) =>
              /event-stream|octet-stream|x-ndjson/.test(type)
            )
          ),
        });
      }
    }
  }

  find(method: string, path: string) {
    return this.operations.find((operation) => operation.method === method && operation.path === path);
  }

  resolve(schema: any, seen = 0): any {
    let current = schema;
    while (current && typeof current === 'object' && typeof current.$ref === 'string' && seen < 20) {
      const parts = current.$ref.replace(/^#\//, '').split('/');
      current = parts.reduce(
        (node: any, part: string) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')],
        this.document
      );
      seen += 1;
    }
    return current ?? {};
  }
}

/** The schema's non-null types, flattening OpenAPI 3.1 `type: [..]`, `nullable` and anyOf/oneOf branches. */
export function schemaTypes(spec: Spec, raw: Schema): string[] {
  const schema = spec.resolve(raw);
  if (Array.isArray(schema.type)) return schema.type.filter((type: string) => type !== 'null');
  if (typeof schema.type === 'string') return [schema.type];
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) return [...new Set(branches.flatMap((branch: Schema) => schemaTypes(spec, branch)))];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  if (schema.enum) return [typeof schema.enum[0]];
  return [];
}

/** First non-null branch of a union, merged allOf, so the generator has one concrete shape to fill. */
export function concrete(spec: Spec, raw: Schema): Schema {
  const schema = spec.resolve(raw);
  if (Array.isArray(schema.allOf)) {
    const merged: Schema = {};
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const part of schema.allOf as Schema[]) {
      const resolved = concrete(spec, part);
      Object.assign(merged, resolved);
      Object.assign(properties, resolved.properties ?? {});
      required.push(...(resolved.required ?? []));
    }
    return { ...merged, properties, required };
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    const nonNull = branches
      .map((branch: Schema) => spec.resolve(branch))
      .filter((branch: Schema) => branch.type !== 'null');
    // Prefer an object branch with properties (the documented shape) over a bare scalar alternative.
    return concrete(spec, nonNull.find((branch: Schema) => branch.properties) ?? nonNull[0] ?? {});
  }
  return schema;
}

export type SynthContext = {
  prefix: string;
  /** Unique token per generated body so parallel creates never collide on a unique name. */
  unique: string;
  /** Resolves id-like fields (nodeId, dockerNodeId, caId, …) from the fleet or created fixtures. */
  resolveId: (field: string, schema: Schema) => string | undefined;
  nextPort: () => number;
};

const NAME_FIELDS =
  /^(name|hostname|displayName|projectName|title|slug|alias|commonName|bucket|label|key|username|ownerUsername|databaseName|deploymentName|containerName|tag)$/;

function satisfies(pattern: string | undefined, value: string) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true;
  }
}

function stringFor(field: string, schema: Schema, ctx: SynthContext): string {
  const format = schema.format as string | undefined;
  const lower = field.toLowerCase();
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : 60;
  const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const fitLength = (value: string) => (value.length > max ? value.slice(0, max) : value.padEnd(min, 'x'));
  if (format === 'uuid' || /(^|[a-z])Id$/.test(field) || field === 'id') {
    return ctx.resolveId(field, schema) ?? randomUUID();
  }
  if (format === 'date-time') return new Date(Date.now() + 86_400_000).toISOString();
  if (format === 'date') return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (format === 'email' || lower.includes('email')) return `${ctx.prefix}${ctx.unique}@example.test`;
  if (format === 'uri' || format === 'url' || lower.endsWith('url') || lower === 'endpoint')
    return `https://${ctx.prefix}${ctx.unique}.example.test/mx`;
  if (format === 'ipv4' || format === 'ip' || lower === 'ip' || lower.endsWith('ipaddress')) return '192.0.2.10';
  if (format === 'ipv6') return '2001:db8::10';
  if (lower.includes('cidr')) return '192.0.2.0/24';
  if (lower === 'image') return 'nginx:alpine';
  if (lower === 'timezone') return 'UTC';
  if (lower === 'schedule' || lower === 'cron') return '0 3 * * *';
  if (lower === 'version') return '1';
  if (lower.includes('domain') || lower === 'host' || lower === 'fqdn' || lower === 'servername')
    return fitLength(`${ctx.prefix}${ctx.unique}.example.test`);
  if (lower === 'color' || lower.endsWith('color')) return '#3366ff';
  if (lower === 'content' || lower === 'yaml' || lower === 'template' || lower === 'body')
    return `# ${ctx.prefix}${ctx.unique}`;
  const candidates =
    NAME_FIELDS.test(field) || /name$/i.test(field)
      ? [
          `${ctx.prefix}${ctx.unique}`,
          `${ctx.prefix}${ctx.unique}`.replace(/-/g, '_'),
          `mx${ctx.unique}`.replace(/[^a-z0-9]/g, ''),
        ]
      : [`${ctx.prefix}${ctx.unique}`, 'mx matrix', 'mx', 'a', '1'];
  for (const candidate of candidates) {
    const value = fitLength(candidate);
    if (satisfies(schema.pattern, value)) return value;
  }
  return fitLength(candidates[0]!);
}

function numberFor(field: string, schema: Schema, integer: boolean, ctx: SynthContext) {
  if (/port$/i.test(field)) {
    const port = ctx.nextPort();
    if ((schema.minimum ?? 0) <= port && port <= (schema.maximum ?? 65535)) return port;
  }
  let value =
    typeof schema.default === 'number' ? schema.default : typeof schema.minimum === 'number' ? schema.minimum : 1;
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
    value = schema.exclusiveMinimum + 1;
  if (typeof schema.maximum === 'number' && value > schema.maximum) value = schema.maximum;
  if (value === 0 && schema.minimum === undefined && /(count|size|gb|mb|cores|days|years|seconds|limit)/i.test(field))
    value = 1;
  return integer ? Math.ceil(value) : value;
}

/**
 * A minimal valid value for `schema`: required properties only (plus name-like ones so created rows carry the
 * run prefix), enum[0], declared defaults and formats.
 */
export function synthesize(spec: Spec, raw: Schema, ctx: SynthContext, field = '', depth = 0): unknown {
  const schema = concrete(spec, raw);
  if (depth > 6) return undefined;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length)
    return schema.enum.find((value: unknown) => value !== null) ?? schema.enum[0];
  const types = schemaTypes(spec, schema);
  const type = types.includes('object') ? 'object' : types[0];
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const required = new Set<string>(schema.required ?? []);
      for (const [key, value] of Object.entries<Schema>(schema.properties ?? {})) {
        const include =
          required.has(key) || (depth === 0 && NAME_FIELDS.test(key) && schemaTypes(spec, value).includes('string'));
        if (!include) continue;
        const generated = synthesize(spec, value, ctx, key, depth + 1);
        if (generated !== undefined) out[key] = generated;
      }
      return out;
    }
    case 'array': {
      const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const isDomainList = /domain|hostnames|sans/i.test(field);
      const count = Math.max(minItems, isDomainList ? 1 : 0);
      return Array.from({ length: count }, (_, index) =>
        synthesize(
          spec,
          schema.items ?? {},
          { ...ctx, unique: `${ctx.unique}${index || ''}` },
          field.replace(/s$/, ''),
          depth + 1
        )
      );
    }
    case 'string':
      return typeof schema.default === 'string' ? schema.default : stringFor(field, schema, ctx);
    case 'integer':
      return numberFor(field, schema, true, ctx);
    case 'number':
      return numberFor(field, schema, false, ctx);
    case 'boolean':
      return typeof schema.default === 'boolean' ? schema.default : false;
    default:
      return undefined;
  }
}

/** A value of the wrong JSON type for `schema`, for negative validation probes. */
export function wrongType(spec: Spec, raw: Schema): unknown {
  const types = schemaTypes(spec, raw);
  if (types.includes('string')) return 12345;
  if (types.includes('integer') || types.includes('number')) return 'not-a-number';
  if (types.includes('boolean')) return 'yes';
  if (types.includes('array')) return { not: 'an array' };
  if (types.includes('object')) return 'not-an-object';
  return [[[]]];
}

/** Scalar fields of a written body that a read-back should echo. */
export function scalarFields(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.entries(body as Record<string, unknown>).filter(
    ([key, value]) =>
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      !/(password|secret|token|key)$/i.test(key)
  );
}
