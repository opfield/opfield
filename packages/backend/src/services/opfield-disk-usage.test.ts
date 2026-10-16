import { describe, expect, it } from 'vitest';
import { parseContainerLogSizes, parseRedisInfo } from './opfield-disk-usage.js';

describe('Opfield disk usage', () => {
  it('reads Redis INFO fields', () => {
    expect(parseRedisInfo('# Memory\r\nused_memory:1024\r\naof_current_size:2048\r\n')).toMatchObject({
      used_memory: '1024',
      aof_current_size: '2048',
    });
  });

  it('sums the apparent sizes of the json logs and their rotated files per container (O-8)', () => {
    const id = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const sizes = parseContainerLogSizes(
      [
        `1844802 /containers/${id}/${id}-json.log`,
        `52428800 /containers/${id}/${id}-json.log.1`,
        `3915961 /containers/${other}/${other}-json.log`,
      ].join('\n')
    );
    expect(sizes.get(id)).toBe(1844802 + 52428800);
    expect(sizes.get(other)).toBe(3915961);
  });
});
