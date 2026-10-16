import { describe, expect, it } from 'vitest';
import { manualSourceNotAllowedError } from './inference-model.validation.js';

/** Stand rc.2 INF-O-3: the refusal of a typed model id names discoveredModelId and the discovered ids. */
describe('manual model id refusal', () => {
  const discovered = [
    { id: '11111111-1111-4111-8111-111111111111', remoteModelId: 'vendor/model-a', available: true },
    { id: '22222222-2222-4222-8222-222222222222', remoteModelId: 'vendor/model-b', available: true },
    { id: '33333333-3333-4333-8333-333333333333', remoteModelId: 'vendor/retired', available: false },
  ];

  it('points a discovered id typed as upstreamModelId to its discoveredModelId', () => {
    const error = manualSourceNotAllowedError({ upstreamModelId: 'vendor/model-b', discoveryUsable: true, discovered });
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('INFERENCE_MANUAL_SOURCE_NOT_ALLOWED');
    expect(error.message).toBe(
      'The connection discovered "vendor/model-b": send discoveredModelId "22222222-2222-4222-8222-222222222222" instead of upstreamModelId.'
    );
    expect(error.details).toEqual({
      discoveredModels: [
        { discoveredModelId: discovered[0]!.id, upstreamModelId: 'vendor/model-a' },
        { discoveredModelId: discovered[1]!.id, upstreamModelId: 'vendor/model-b' },
      ],
    });
  });

  it('lists the available discovered models for an unknown typed id', () => {
    const error = manualSourceNotAllowedError({ upstreamModelId: 'vendor/other', discoveryUsable: true, discovered });
    expect(error.message).toContain('discoveredModelId');
    expect(error.message).toContain(`vendor/model-a (${discovered[0]!.id})`);
    expect(error.message).not.toContain('vendor/retired');
  });

  it('asks for a sync when discovery found nothing yet', () => {
    const error = manualSourceNotAllowedError({ upstreamModelId: 'x', discoveryUsable: true, discovered: [] });
    expect(error.message).toContain('sync the connection');
  });

  it('names the manual metadata a connection without discovery needs', () => {
    const error = manualSourceNotAllowedError({ upstreamModelId: 'x', discoveryUsable: false, discovered: [] });
    expect(error.message).toContain('manualMetadata with contextWindow, maxInputTokens and autoCompactTokenLimit');
  });
});
