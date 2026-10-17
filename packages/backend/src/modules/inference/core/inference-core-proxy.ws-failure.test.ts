import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { errorCode } from '../accounting/inference-accounting.helpers.js';
import { InferenceProtocolError } from '../protocol/inference-protocol.error.js';
import { recordedTurnError } from './inference-core-proxy.ws.js';

// Stand rc.3 O-A: a core that refused the Responses WebSocket upgrade (426) was stored in Activity as
// `upstream_error`, while the client got `inference_core_unavailable` and no provider was contacted.
describe('Responses WebSocket turn failure in Activity', () => {
  it('records a core transport failure as inference_core_unavailable', () => {
    const recorded = recordedTurnError(new Error('Inference core rejected the WebSocket upgrade with status 426'));
    expect(errorCode(recorded)).toBe('inference_core_unavailable');
  });

  it("keeps a provider's or Opfield's own error code", () => {
    const denial = new InferenceProtocolError(429, 'api_budget_exhausted', 'Inference budget exhausted');
    expect(recordedTurnError(denial)).toBe(denial);
    expect(recordedTurnError(undefined)).toBeUndefined();
  });
});
