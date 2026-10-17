import { describe, expect, it } from 'vitest';
import { REPLACED_IMAGE_GRACE_MS, UNUSED_IMAGE_MIN_AGE_MS } from './docker-image-cleanup.service.js';
import { buildImagePrunePreview } from './docker-image-prune-preview.js';
import { LEGACY_REGISTRY_NAMESPACE } from '@/lib/legacy-compat.js';

describe('the image prune dry run (X-O-16)', () => {
  it('lists what a prune removes now and what still waits, with reasons and byte totals', () => {
    const preview = buildImagePrunePreview('node-1', [{ id: 'sha-dangling', size: 10 }], {
      candidates: [
        { id: 'sha-old-build', repository: `${LEGACY_REGISTRY_NAMESPACE}/builds/s1`, size: 100, minUnusedMs: REPLACED_IMAGE_GRACE_MS },
        // Also dangling: counted once.
        { id: 'sha-dangling', repository: null, size: 10, minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS },
      ],
      waiting: [
        {
          id: 'sha-removed-container',
          repository: 'nginx',
          size: 1000,
          minUnusedMs: UNUSED_IMAGE_MIN_AGE_MS,
          removableAt: '2026-10-18T02:00:00.000Z',
        },
      ],
    });
    expect(preview.removable.map((image) => [image.id, image.reason])).toEqual([
      ['sha-dangling', 'dangling'],
      ['sha-old-build', 'beyond_cleanup_setting'],
    ]);
    expect(preview.removableBytes).toBe(110);
    expect(preview.waiting).toEqual([
      {
        id: 'sha-removed-container',
        repository: 'nginx',
        size: 1000,
        reason: 'unused',
        removableAt: '2026-10-18T02:00:00.000Z',
      },
    ]);
    expect(preview.waitingBytes).toBe(1000);
  });
});
