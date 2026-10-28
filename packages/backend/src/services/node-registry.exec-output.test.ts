import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NodeRegistryService } from './node-registry.service.js';

const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const EXEC = '44444444-4444-4444-8444-444444444444';

function registry() {
  return new NodeRegistryService({} as never, { offlineDebounceMs: 0 });
}

describe('exec output routing', () => {
  it('delivers exec output only from the node that owns the session', () => {
    const nodes = registry();
    const handler = vi.fn();
    nodes.registerExecHandler(EXEC, handler, OWNER);

    nodes.handleExecOutput(OTHER, EXEC, { execId: EXEC, data: 'injected' });
    expect(handler).not.toHaveBeenCalled();

    nodes.handleExecOutput(OWNER, EXEC, { execId: EXEC, data: 'real' });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ execId: EXEC, data: 'real' });
  });

  it('drops output for a session nobody listens to', () => {
    expect(() => registry().handleExecOutput(OWNER, EXEC, {})).not.toThrow();
  });

  it('keeps several handlers of one session and removes them one by one', () => {
    const nodes = registry();
    const first = vi.fn();
    const second = vi.fn();
    nodes.registerExecHandler(EXEC, first, OWNER);
    nodes.registerExecHandler(EXEC, second, OWNER);
    expect(nodes.getExecHandlerCount(EXEC)).toBe(2);

    nodes.removeExecHandler(EXEC, first);
    nodes.handleExecOutput(OWNER, EXEC, 'x');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    nodes.removeExecHandler(EXEC, second);
    expect(nodes.getExecHandlerCount(EXEC)).toBe(0);
  });

  it('refuses to register a session id that another node already owns', () => {
    const nodes = registry();
    nodes.registerExecHandler(EXEC, vi.fn(), OWNER);
    expect(() => nodes.registerExecHandler(EXEC, vi.fn(), OTHER)).toThrow(/another node/);
  });
});
