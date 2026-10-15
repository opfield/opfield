import { describe, expect, it } from 'vitest';
import { inspectStoppedOnRequest } from './docker-stop-intent.js';

const exited = (ExitCode: number, OOMKilled = false) => ({ State: { Status: 'exited', ExitCode, OOMKilled } });

describe('stop intent from a container inspect', () => {
  it('counts a stop (0, SIGINT, SIGTERM, SIGKILL without OOM) and a created container as stopped on request', () => {
    for (const code of [0, 130, 143, 137]) expect(inspectStoppedOnRequest(exited(code))).toBe(true);
    expect(inspectStoppedOnRequest({ State: { Status: 'created' } })).toBe(true);
  });

  it('counts a crash, an OOM kill, a dead or running container as not stopped on request', () => {
    expect(inspectStoppedOnRequest(exited(1))).toBe(false);
    expect(inspectStoppedOnRequest(exited(137, true))).toBe(false);
    expect(inspectStoppedOnRequest({ State: { Status: 'dead', ExitCode: 0 } })).toBe(false);
    expect(inspectStoppedOnRequest({ State: { Status: 'running' } })).toBe(false);
    expect(inspectStoppedOnRequest(null)).toBe(false);
  });
});
