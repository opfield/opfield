import { describe, expect, it } from 'vitest';
import { DockerSourceBindingConfigSchema } from './docker-build.schemas.js';

const base = {
  connectorId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  branch: 'main',
};

describe('build paths', () => {
  it('stores ./, leading and trailing slashes as the clean repository-relative path the builder accepts', () => {
    for (const [input, expected] of [
      ['./app', 'app'],
      ['/app', 'app'],
      ['app/', 'app'],
      ['./', '.'],
      ['/', '.'],
      ['./app//Dockerfile', 'app/Dockerfile'],
    ]) {
      const parsed = DockerSourceBindingConfigSchema.parse({ ...base, contextPath: input, dockerfilePath: input });
      expect([parsed.contextPath, parsed.dockerfilePath]).toEqual([expected, expected]);
    }
  });

  it('still rejects paths that leave the repository', () => {
    for (const contextPath of ['../app', 'app/../../etc', '/../app']) {
      expect(DockerSourceBindingConfigSchema.safeParse({ ...base, contextPath }).success).toBe(false);
    }
  });
});
