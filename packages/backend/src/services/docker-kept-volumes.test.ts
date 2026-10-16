import { describe, expect, it } from 'vitest';
import { referencedAnonymousVolumeNames } from './docker-kept-volumes.js';

const ADOPTED = 'a'.repeat(64);
const NAMED_IN_CONFIG = 'b'.repeat(64);

describe('referencedAnonymousVolumeNames', () => {
  it('finds Docker-generated volume names in a config, never image digests or longer hex runs', () => {
    const config = JSON.stringify({
      image: `registry.example/app@sha256:${'c'.repeat(64)}`,
      imageId: `sha256:${'d'.repeat(64)}`,
      mounts: [`${NAMED_IN_CONFIG}:/data`, { source: ADOPTED.toUpperCase(), target: '/cache' }],
      token: 'e'.repeat(80),
    });
    expect(referencedAnonymousVolumeNames(config).sort()).toEqual([ADOPTED, NAMED_IN_CONFIG]);
    expect(referencedAnonymousVolumeNames(`volumes:\n  data:\n    external: true\n    name: ${ADOPTED}\n`)).toEqual([
      ADOPTED,
    ]);
    expect(referencedAnonymousVolumeNames(null)).toEqual([]);
  });
});
