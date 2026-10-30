import { describe, expect, it } from 'vitest';
import { InferenceCoreRuntimeService } from './inference-core-runtime.service.js';

describe('inference core image pull progress', () => {
  it('writes one progress update at a time and ends on the latest one', async () => {
    const writes: Array<Record<string, unknown> | null | undefined> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const operations = {
      updatePhase: async (_id: string, _phase: string, progress?: Record<string, unknown> | null) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        writes.push(progress);
      },
    };
    const docker = {
      imageExists: async () => false,
      pullImageRefStreaming: async (_ref: string, onProgress: (progress: Record<string, number>) => void) => {
        for (let layer = 1; layer <= 2000; layer += 1) onProgress({ layersCompleted: layer, layersTotal: 2000 });
      },
    };
    const service = new InferenceCoreRuntimeService(
      {} as never,
      docker as never,
      {} as never,
      {} as never,
      operations as never,
      {} as never
    );
    await (service as unknown as { pullImage: (id: string, artifact: unknown) => Promise<void> }).pullImage('op', {
      imageRef: 'core:1',
    });
    expect(maxInFlight).toBe(1);
    expect(writes.length).toBeLessThan(5);
    expect(writes.at(-1)).toMatchObject({ layersCompleted: 2000 });
  });
});
