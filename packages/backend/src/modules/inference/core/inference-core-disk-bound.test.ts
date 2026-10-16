import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trimFileScript } from './inference-core-disk-bound.js';

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `{"n":${index},"model":"m","tokens":12}\n`).join('');
}

describe('trimFileScript', () => {
  for (const mode of ['replace', 'in-place'] as const) {
    it(`keeps the newest whole lines once the file is over its cap (${mode})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'core-trim-'));
      const file = join(dir, "usage it's.jsonl");
      writeFileSync(file, lines(1000));
      const before = statSync(file).size;

      const output = execFileSync('/bin/sh', ['-c', trimFileScript(file, 2000, 1000, mode)]).toString();
      const kept = readFileSync(file, 'utf8');
      expect(output).toBe(`trimmed ${before} ${kept.length}\n`);
      expect(kept.length).toBeLessThanOrEqual(1000);
      expect(kept.startsWith('{"n":')).toBe(true);
      expect(kept.endsWith('"tokens":12}\n')).toBe(true);
      expect(kept.trimEnd().split('\n').at(-1)).toBe('{"n":999,"model":"m","tokens":12}');
    });
  }

  it('leaves a file within its cap and a missing file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-trim-'));
    const file = join(dir, 'usage.jsonl');
    writeFileSync(file, lines(10));
    expect(execFileSync('/bin/sh', ['-c', trimFileScript(file, 100_000, 1000, 'replace')]).toString()).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(lines(10));
    expect(execFileSync('/bin/sh', ['-c', trimFileScript(join(dir, 'missing'), 1, 1, 'in-place')]).toString()).toBe('');
  });
});
