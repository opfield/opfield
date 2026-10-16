import { describe, expect, it } from 'vitest';
import { parseContainerLogSizes, parseRedisInfo } from './opfield-disk-usage.js';

describe('Opfield disk usage', () => {
  it('reads Redis INFO fields', () => {
    expect(parseRedisInfo('# Memory\r\nused_memory:1024\r\naof_current_size:2048\r\n')).toMatchObject({
      used_memory: '1024',
      aof_current_size: '2048',
    });
  });

  it('sums the json logs and their rotated files per container', () => {
    const id = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const sizes = parseContainerLogSizes(
      [
        `10\t/containers/${id}/${id}-json.log`,
        `5\t/containers/${id}/${id}-json.log.1`,
        `1\t/containers/${other}/${other}-json.log`,
      ].join('\n')
    );
    expect(sizes.get(id)).toBe(15 * 1024);
    expect(sizes.get(other)).toBe(1024);
  });
});
