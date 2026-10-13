import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(process.cwd(), '../../scripts/release-tag.sh');

function classify(tag: string) {
  const result = spawnSync('bash', [script, tag], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=', 2) as [string, string])
    ),
    stderr: result.stderr,
  };
}

describe('release tag classifier', () => {
  it.each([
    ['v2.10.0', 'opfield', '', 'v2.10.0', 'false'],
    ['v2.10.0-rc.1', 'opfield', '', 'v2.10.0-rc.1', 'true'],
    ['v2.10.0-nginx', 'component', 'nginx', 'v2.10.0', 'false'],
    ['v2.10.0-rc.2-nginx', 'component', 'nginx', 'v2.10.0-rc.2', 'true'],
    ['v2.10.0-rc.3-relay', 'component', 'relay', 'v2.10.0-rc.3', 'true'],
  ])('classifies %s', (tag, kind, component, version, prerelease) => {
    const result = classify(tag);
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual({ kind, component, version, prerelease });
  });

  it.each([
    'v2.10.0-beta.1',
    'v2.10.0-nginx-rc.1',
    'v2.10.0-rc.1-database-connector',
    'v2.10.0-rc.1-secure-link-connector',
    '2.10.0-rc.1',
    'v2.10-rc.1',
  ])('rejects unsupported tag %s', (tag) => {
    const result = classify(tag);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not a supported Opfield release tag');
  });
});
