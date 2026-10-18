import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from './node-registry.service.js';

const NODE = '22222222-2222-4222-8222-222222222222';

function registry() {
  const nodes = new NodeRegistryService({} as never, { offlineDebounceMs: 0 });
  const evaluator = { observeStatefulEvent: vi.fn(async () => undefined) };
  nodes.setEvaluator(evaluator as never);
  const observed = () =>
    (evaluator.observeStatefulEvent.mock.calls as unknown[][]).map(([category, state, resource, , patterns]) => ({
      category,
      state,
      id: (resource as { id: string }).id,
      patterns,
    }));
  return { nodes, observed };
}

/**
 * Stand 2.12.6-rc.1, O-4: a Container Stopped rule never fired. Docker reports a stopped container as "exited", so the
 * health reports observed only the Container Exited rules and the Stopped rules kept the one sample of the stop action.
 */
describe('container states from the Docker health report', () => {
  it('observes a container Docker reports as exited as stopped and as exited', () => {
    const { nodes, observed } = registry();

    nodes.observeDockerContainerState(NODE, 'c1', 'web', 'exited');

    expect(observed()).toEqual([
      { category: 'container', state: 'stopped', id: 'web', patterns: ['stopped'] },
      { category: 'container', state: 'exited', id: 'web', patterns: ['exited'] },
    ]);
  });

  it('clears both when the container runs again', () => {
    const { nodes, observed } = registry();

    nodes.observeDockerContainerState(NODE, 'c1', 'web', 'running');

    expect(observed()).toEqual([
      { category: 'container', state: 'started', id: 'web', patterns: ['stopped', 'exited'] },
    ]);
  });
});
