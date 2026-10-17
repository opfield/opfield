import { describe, expect, it } from 'vitest';
import { resolveDockerRuntimeImage } from './scenario-helpers.js';
import { scenarios } from './scenarios.js';
import type { TestContext } from './test-harness.js';

const scenarioContract = [
  ['health endpoint reports dependency status', false],
  ['OpenAPI is reachable and legacy nginx management routes are absent', false],
  ['API token is rejected from browser-session-only surfaces', false],
  ['all no-parameter OpenAPI GET routes are API-accessible or explicitly session-only', false],
  ['core resource list APIs are reachable', false],
  ['resource detail APIs work for existing visible rows', false],
  ['Docker node read APIs work for existing docker nodes', false],
  ['connected PostgreSQL databases allow safe read-only query checks', false],
  ['metadata mutations create, update, and clean up core records', true],
  ['proxy metadata mutations cover folders and nginx templates', true],
  ['proxy host runtime mutation covers create, detail, update, toggle, and delete when nginx node exists', true],
  ['PKI metadata mutations cover CA and certificate templates', true],
  ['status page mutations cover services and incident lifecycle', true],
  ['notification mutations cover webhook and alert rule lifecycle', true],
  ['logging mutations cover schema, environment, token, and ingest when available', true],
  ['Docker node safe mutations cover folders, volumes, and networks', true],
  ['Docker container runtime mutations cover disposable container lifecycle', true],
  ['Docker Compose runtime mutations cover validation, revisions, ownership, and lifecycle', true],
] as const;

function contextWithFlags(flags: Partial<TestContext['config']>): TestContext {
  return {
    cleanup: [],
    client: {} as TestContext['client'],
    db: {} as TestContext['db'],
    config: {
      apiUrl: 'http://localhost:3000',
      databaseUrl: 'postgres://dev:dev@localhost:5432/opfield',
      allowMutations: false,
      allowRuntimeMutations: false,
      allowUnhealthy: false,
      keepToken: false,
      profile: 'full',
      ...flags,
    },
  };
}

describe('API e2e scenarios contract', () => {
  it('keeps scenario names, order, and gating stable', () => {
    expect(scenarios.map((scenario) => [scenario.name, Boolean(scenario.skip)])).toEqual(scenarioContract);
  });

  it('gates mutation scenarios by the configured mutation flags', () => {
    const mutationOnly = scenarios.find(
      (scenario) => scenario.name === 'metadata mutations create, update, and clean up core records'
    );
    const runtimeMutation = scenarios.find(
      (scenario) => scenario.name === 'Docker container runtime mutations cover disposable container lifecycle'
    );

    expect(mutationOnly?.skip?.(contextWithFlags({ allowMutations: false }))).toBe('set OPFIELD_E2E_ALLOW_MUTATIONS=1');
    expect(mutationOnly?.skip?.(contextWithFlags({ allowMutations: true }))).toBe(false);
    expect(runtimeMutation?.skip?.(contextWithFlags({ allowRuntimeMutations: false }))).toBe(
      'set OPFIELD_E2E_ALLOW_RUNTIME_MUTATIONS=1'
    );
    expect(runtimeMutation?.skip?.(contextWithFlags({ allowRuntimeMutations: true }))).toBe(false);
  });

  it('prefers a general-purpose runtime image over Opfield connector images', async () => {
    const ctx = contextWithFlags({});
    ctx.client = {
      get: async () => ({
        status: 200,
        headers: new Headers(),
        text: '',
        body: {
          data: [
            { repoTags: ['localhost:5000/opfield/secure-link-connector:e2e'] },
            { repoTags: ['nginx:1.29-alpine'] },
          ],
        },
      }),
    } as TestContext['client'];

    await expect(resolveDockerRuntimeImage(ctx, 'node-1')).resolves.toBe('nginx:1.29-alpine');
  });
});
