import 'reflect-metadata';
// The schema barrel first: loading the services alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';
import { AI_TOOLS } from './ai.tools.js';
import { AI_TOOL_ANY_SCOPE_REQUIREMENTS, isExecutorAuthorizedDockerScope } from './ai-tool-scope-policy.js';

/**
 * The call gate lets an ANY-scope tool (and every Docker tool) through on any qualified grant, because the
 * executor checks the exact resource. This calls every operation of those tools with a grant on a DIFFERENT
 * resource and expects the executor to refuse. Collaborating services are doubles, so an executor passes only by
 * refusing itself; where the refusal lives in the collaborating service or in the commercial runtime, the tables
 * below say so and the test checks the executor hands the caller (its user or scopes) to it. A new ANY-scope tool
 * or operation that is not refused and not in a table fails here until someone classifies it.
 */

const TARGET = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const NODE = '55555555-5555-4555-8555-555555555555';

/** Tools whose executor forwards to the commercial runtime (container.resolve(TOKENS.CommercialEdition)). */
const COMMERCIAL_EXECUTOR = [
  'list_databases',
  'list_storage_connections',
  'manage_database_backups',
  'manage_database_connection',
  'manage_managed_storage',
  'manage_postgres_data',
  'manage_redis_data',
  'manage_storage_connection',
  'manage_storage_objects',
];

/** Scopes beyond the policy table that the executors of some tools need, so the control run can get past them. */
const CONTROL_EXTRA_SCOPES: Record<string, string[]> = {
  duplicate_docker_container: ['docker:containers:environment', 'docker:containers:secrets', 'docker:containers:view'],
  manage_inference_provider: ['feat:ai:use'],
  move_routes_to_folder: ['proxy:edit'],
  update_docker_container_image: [
    'docker:containers:edit',
    'docker:containers:environment',
    'docker:containers:secrets',
    'docker:containers:view',
  ],
};

/** Executors that follow issuer links until there are none: on a double that answers every question, never. */
const PKI_CHAIN_TOOLS = ['delete_ca', 'list_cas', 'manage_ca', 'manage_certificate'];

/** Slug lookups answer a resource the caller may not view exactly like a missing slug (404). */
const SLUG_LOOKUPS = ['manage_pages:project_get_by_slug', 'manage_route:get_by_slug'];

/**
 * The executor passes the acting user (or its scopes) to a service of this repository that authorizes; the REST
 * routes call the same service. A bare tool name covers every operation. Allowed means the caller was handed over;
 * an operation may also end in a refusal or in input validation.
 */
const SERVICE_ENFORCED = [
  'create_docker_container',
  'find_git_scope_target',
  'get_app',
  'get_app_activity',
  'get_app_overview',
  'list_apps',
  'manage_app',
  'manage_app_environment',
  'manage_app_incident',
  'manage_app_members',
  'manage_app_variables',
  'manage_docker_availability',
  'manage_docker_container:gpu_usage',
  'manage_docker_migration',
  'manage_docker_source:repositories',
  'manage_docker_volume:create',
  'manage_domain:list_nginx_nodes',
  'manage_hosting',
  'manage_resource_folder:move_folder',
  'promote_app_environment',
  'pull_docker_image',
  'get_opfield_runtime:ai_status',
];

/**
 * Reads that name no resource of the caller's grant: lists the executor bounds by ids or scopes it derives from the
 * caller, catalogs, and answers every signed-in user by design. A grant on another resource shows that resource
 * only. Nothing is mutated.
 */
const FILTERED_READS = [
  'get_dashboard_stats',
  'get_delivery_stats',
  'get_my_access',
  'get_opfield_runtime:config',
  'get_opfield_runtime:version',
  'find_resource',
  'list_alert_rules',
  'list_alerts',
  'list_cas',
  'list_docker_builds',
  'list_docker_containers',
  'list_docker_deployments',
  'list_docker_images',
  'list_docker_networks',
  'list_docker_volumes',
  'list_integration_connectors',
  'list_nodes',
  'list_resource_folders',
  'list_routes',
  'list_webhook_deliveries',
  'list_webhooks',
  // The installation's identity providers and service tokens (no secrets): an access-list editor picks them in rules.
  'manage_access_sign_in:identity_providers.get',
  'manage_access_sign_in:identity_providers.list',
  'manage_access_sign_in:service_tokens.get',
  'manage_access_sign_in:service_tokens.list',
  'manage_docker_compose:list',
  'manage_docker_source:admission',
  'manage_docker_source:connectors',
  'manage_docker_volume:managed_options',
  'manage_ingress_group:list',
  'manage_logging:environment.list',
  'manage_logging:health.get',
  'manage_logging:schema.list',
  'manage_managed_database:catalog',
  'manage_managed_database:list',
  'manage_notifications:alert_categories',
  'manage_notifications:alert_resources',
  'manage_notifications:delivery_get',
  'manage_notifications:webhook_presets',
  'manage_pages:project_list',
  'manage_pages:project_placement_options',
  'manage_proxy_template:list',
  'read_opfield_documentation',
  'refresh_docker_snapshot',
];

/**
 * A resource or session the caller has no grant on is reported as missing, like an unknown one: the answer is a 404
 * (or the permission refusal).
 */
const NOT_FOUND_AS_REFUSAL = [
  'download_docker_archive:chunk',
  'download_docker_archive:close',
  'download_docker_archive:status',
  'manage_ingress_group:get',
  'upload_docker_container_archive:abort',
  'upload_docker_container_archive:chunk',
  'upload_docker_container_archive:finalize',
  'upload_docker_container_archive:status',
];

/**
 * Creation, preview and validation paths: the destination (folder, node, connector input) is authorized, not an
 * existing resource, and input validation runs first, so the generic arguments of this test end in a 400 before any
 * check. The service tests of the destination checks cover them.
 */
const NEEDS_FULL_INPUT = [
  'create_route',
  'manage_ca:revoke',
  'manage_certificate:issue_from_csr',
  'manage_container_link:create',
  'manage_docker_availability:disable',
  'manage_docker_availability:enable',
  'manage_docker_availability:get_by_resource',
  'manage_docker_availability:preflight',
  'manage_docker_availability:update',
  'manage_docker_compose:create',
  'manage_docker_compose:validate',
  'manage_docker_container:archive_plan_import',
  'manage_docker_deployment:create',
  'manage_docker_source:create',
  'manage_domain:preview',
  'manage_logging:environment.create',
  'manage_logging:schema.create',
  'manage_managed_database:create',
  'manage_notifications:webhook_preview',
  'manage_proxy_template:create',
  'manage_proxy_template:preview',
  'manage_proxy_template:test',
  'manage_resource_folder:reorder_folders',
  'manage_resource_folder:reorder_resources',
  'manage_route:missing_domains',
  'manage_route:validate_config',
  'manage_ssl_certificate:upload',
  'upload_docker_container_archive:begin',
];

// Whether the node exists and is a Docker node is not what is tested here.
vi.mock('./ai.node-target-guidance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ai.node-target-guidance.js')>()),
  assertDockerToolNode: async () => undefined,
}));

const recorded: unknown[][] = [];

/**
 * A service double that answers every call with another double, which is also awaitable: authorization that waits
 * for a lookup (or builds a query) still runs against something.
 */
function deepMock(awaitable = false): any {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'then') return awaitable ? (resolve: (value: unknown) => void) => resolve(deepMock()) : undefined;
      if (prop === Symbol.toPrimitive) return () => 'mock';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'toString') return () => 'mock';
      if (prop === 'length') return 0;
      return deepMock();
    },
    apply: (_target, _this, args) => {
      recorded.push(args);
      return deepMock(true);
    },
    construct: () => deepMock(),
    has: () => true,
  };
  // biome-ignore lint/complexity/useArrowFunction: the target must be constructible for the construct trap
  return new Proxy(function () {}, handler);
}

/** The Docker service double: a container is whatever the call names, and belongs to some resource that is not OTHER. */
function dockerDouble(): any {
  const base = deepMock();
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'inspectContainer'
          ? async (_nodeId: string, id: string) => ({
              Id: id,
              Name: `/${id}`,
              scopeResourceId: 'resource-of-target',
              Config: { Labels: {} },
            })
          : base[prop],
    }
  );
}

function isPermissionDenial(error: unknown): boolean {
  if (error instanceof AppError) return error.statusCode === 403;
  const message = error instanceof Error ? error.message : String(error);
  return /PERMISSION_DENIED|Missing required scope|FORBIDDEN/i.test(message);
}

function isInvalidInput(error: unknown): boolean {
  if (error instanceof AppError) return error.statusCode === 400;
  return (error as { name?: string } | null)?.name === 'ZodError';
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown) {
  let cursor = target;
  for (const key of path.slice(0, -1)) cursor = (cursor[key] ??= {}) as Record<string, unknown>;
  cursor[path.at(-1)!] = value;
}

function sampleValue(name: string, schema: Record<string, any> | undefined): unknown {
  if (/Ids$/.test(name)) return [TARGET];
  if (name === 'nodeId') return NODE;
  if (/(^id$|Id$)/.test(name)) return TARGET;
  if (name === 'slug') return 'target-slug';
  if (name === 'name' || /Name$/.test(name)) return 'target-name';
  if (schema?.enum?.length) return schema.enum[0];
  if (schema?.type === 'number' || schema?.type === 'integer') return 1;
  if (schema?.type === 'boolean') return false;
  if (schema?.type === 'array') return [];
  if (schema?.type === 'object') return {};
  return 'x';
}

interface ToolCase {
  key: string;
  tool: string;
  operation: string | null;
  args: Record<string, unknown>;
  providers: string[];
  requirements: readonly string[];
}

/** Every ANY-scope tool plus the Docker tools whose resources only the executor can map to a grant. */
function toolCases(): ToolCase[] {
  const names = new Set<string>(Object.keys(AI_TOOL_ANY_SCOPE_REQUIREMENTS));
  for (const def of AI_TOOLS) if (isExecutorAuthorizedDockerScope(def.requiredScope)) names.add(def.name);
  const cases: ToolCase[] = [];
  for (const def of AI_TOOLS.filter((tool) => names.has(tool.name))) {
    const properties = ((def.parameters as any)?.properties ?? {}) as Record<string, Record<string, any>>;
    const required = new Set<string>(((def.parameters as any)?.required ?? []) as string[]);
    const base: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(properties)) {
      // A container named by both id and name would not match itself: pass the id when the tool takes one.
      const namesAnId = /Name$/.test(name) && properties[name.replace(/Name$/, 'Id')];
      if (namesAnId) continue;
      if (/(^id$|Ids?$|^slug$|^name$|Name$|^nodeId$)/.test(name) || required.has(name) || schema.enum?.length) {
        base[name] = sampleValue(name, schema);
      }
    }
    const providers: string[] = properties.provider?.enum ?? [];
    const discriminator = def.operationDiscriminator;
    for (const operation of discriminator ? Object.keys(discriminator.operations) : [null]) {
      const args: Record<string, unknown> = JSON.parse(JSON.stringify(base));
      if (discriminator && operation) {
        // A compound key ("environment.list") carries the values of the discriminator arguments in order.
        const parts = operation.split('.');
        discriminator.arguments.forEach((argument, index) => {
          setPath(args, argument.split('.'), parts[index] ?? parts[0]);
        });
      }
      cases.push({
        key: operation ? `${def.name}:${operation}` : def.name,
        tool: def.name,
        operation,
        args,
        providers,
        requirements: AI_TOOL_ANY_SCOPE_REQUIREMENTS[def.name] ?? [def.requiredScope],
      });
    }
  }
  return cases;
}

const CASES = toolCases();

function userWith(scopes: string[]): User {
  return { id: 'user-1', email: 'user@example.com', scopes, isBlocked: false } as unknown as User;
}

const onOtherResource = (requirements: readonly string[]) =>
  requirements.flatMap((scope) => [`${scope}:${OTHER}`, `${scope}:${NODE}/${OTHER}`]);

type Outcome = { kind: 'allowed' } | { kind: 'refused'; error: unknown };

describe('ANY-scope AI tools refuse a grant on a different resource', () => {
  const delegated = new Set<string>();
  let service: any;
  let current = '';

  /** Calls the executor; an operation a provider does not offer is retried with the next provider. */
  async function run(testCase: ToolCase, user: User): Promise<{ outcome: Outcome; callerPassed: boolean }> {
    current = testCase.tool;
    const providers = testCase.providers.length ? testCase.providers : [undefined];
    let outcome: Outcome = { kind: 'allowed' };
    let callerPassed = false;
    for (const provider of providers) {
      recorded.length = 0;
      const args = provider ? { ...testCase.args, provider } : testCase.args;
      try {
        await service.executeToolInternal(user, testCase.tool, args, { source: 'mcp' });
        outcome = { kind: 'allowed' };
      } catch (error) {
        outcome = { kind: 'refused', error };
      }
      callerPassed = recorded.some((call) =>
        call.some((arg) => arg === user || arg === user.scopes || (arg as any)?.scopes === user.scopes)
      );
      const unavailable =
        outcome.kind === 'refused' &&
        /is not available for \w+ connectors/.test(String((outcome.error as Error)?.message));
      if (!unavailable) break;
    }
    return { outcome, callerPassed };
  }

  beforeEach(() => {
    delegated.clear();
    const mock = deepMock();
    vi.spyOn(container, 'resolve').mockImplementation(((token: unknown) => {
      if (token === TOKENS.CommercialEdition) delegated.add(current);
      return mock;
    }) as never);
    vi.spyOn(container, 'isRegistered').mockReturnValue(true);
    const dependencies = Array.from({ length: 31 }, () => deepMock());
    dependencies[15] = dockerDouble(); // dockerService
    service = new (AIService as any)(...dependencies);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('covers every tool of the policy table', () => {
    const covered = new Set(CASES.map((testCase) => testCase.tool));
    const missing = Object.keys(AI_TOOL_ANY_SCOPE_REQUIREMENTS).filter((name) => !covered.has(name));
    // A tool of the table that is not in the tool list has no executor in this repository.
    expect(missing).toEqual([]);
    expect(CASES.length).toBeGreaterThan(250);
  });

  it.each(CASES.map((testCase) => [testCase.key, testCase] as const))('%s', async (key, testCase) => {
    const user = userWith(onOtherResource(testCase.requirements));
    const { outcome, callerPassed } = await run(testCase, user);
    const exempt = (list: string[]) => list.includes(key) || list.includes(testCase.tool);

    if (delegated.has(testCase.tool) && callerPassed) {
      expect(COMMERCIAL_EXECUTOR, `${key} delegates to the commercial runtime`).toContain(testCase.tool);
      return;
    }

    if (SLUG_LOOKUPS.includes(key)) {
      expect(outcome.kind === 'refused' && (outcome.error as AppError).statusCode).toBe(404);
      return;
    }
    if (exempt(SERVICE_ENFORCED)) {
      if (outcome.kind === 'refused') {
        expect(isPermissionDenial(outcome.error) || isInvalidInput(outcome.error)).toBe(true);
      } else {
        expect(callerPassed, `${key} must hand the caller to the service that authorizes`).toBe(true);
      }
      return;
    }
    if (exempt(FILTERED_READS)) return;
    if (exempt(NOT_FOUND_AS_REFUSAL)) {
      expect(
        outcome.kind === 'refused' &&
          (isPermissionDenial(outcome.error) || (outcome.error as AppError).statusCode === 404),
        `${key} must refuse or answer not found`
      ).toBe(true);
      return;
    }
    if (NEEDS_FULL_INPUT.includes(key)) {
      expect(
        outcome.kind === 'refused' && (isInvalidInput(outcome.error) || isPermissionDenial(outcome.error)),
        `${key} must refuse or fail input validation`
      ).toBe(true);
      return;
    }

    expect(
      outcome.kind === 'refused' && isPermissionDenial(outcome.error),
      `${key} was not refused for a grant on another resource (${
        outcome.kind === 'allowed' ? 'it ran' : String((outcome.error as Error)?.message).slice(0, 120)
      }). Fix the executor, or classify the operation in the tables of this test with the reason.`
    ).toBe(true);
  });

  it('reaches the executors: with unqualified grants every tool runs at least one operation', async () => {
    const byTool = new Map<string, ToolCase[]>();
    for (const testCase of CASES) byTool.set(testCase.tool, [...(byTool.get(testCase.tool) ?? []), testCase]);
    const neverRan: string[] = [];
    for (const [tool, cases] of byTool) {
      // The commercial runtime is not part of this repository; its operations run no executor code here. The PKI
      // executors walk certificate chains, which never end on a double that answers every question.
      if (COMMERCIAL_EXECUTOR.includes(tool) || PKI_CHAIN_TOOLS.includes(tool)) continue;
      const user = userWith([...cases[0]!.requirements, ...(CONTROL_EXTRA_SCOPES[tool] ?? [])]);
      let ran = false;
      for (const testCase of cases) {
        const { outcome } = await run(testCase, user);
        if (outcome.kind === 'allowed' || !isPermissionDenial(outcome.error)) {
          ran = true;
          break;
        }
      }
      if (!ran) neverRan.push(tool);
    }
    // A tool the harness cannot get past the permission check proves nothing about its refusals above.
    expect(neverRan).toEqual([]);
  });
});
