import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from '../core/inference-retry-after.js';
import type { InferenceProviderDefinition } from './inference-provider.types.js';
import { inferenceProviderVendorName } from './inference-provider-vendor.js';
import { createProviderStreamState, parseProviderEvent } from './inference-provider-wire.js';

const responses = { id: 'opfield-core', wireProtocol: 'openai-responses' } as InferenceProviderDefinition;
const anthropic = { id: 'anthropic', wireProtocol: 'anthropic-messages' } as InferenceProviderDefinition;

describe('upstream failure events', () => {
  it('keep the failure code and drop the upstream text', () => {
    const failed = parseProviderEvent(
      responses,
      {
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'upstream_server_error', message: 'Provider error 500: {...}' } },
      },
      createProviderStreamState('claude-sonnet-5.5')
    );
    expect(failed).toEqual([
      { type: 'error', code: 'upstream_server_error', message: 'Upstream inference request failed' },
    ]);

    const overloaded = parseProviderEvent(
      anthropic,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      createProviderStreamState('claude-sonnet-5.5')
    );
    expect(overloaded).toEqual([
      { type: 'error', code: 'overloaded_error', message: 'Upstream inference request failed' },
    ]);

    const odd = parseProviderEvent(
      responses,
      { type: 'response.failed', response: { error: { code: 'see https://example.test' } } },
      createProviderStreamState('m')
    );
    expect(odd).toMatchObject([{ code: 'upstream_error' }]);
  });

  it('read Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('7')).toBe(7_000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('name the provider company', () => {
    expect(inferenceProviderVendorName('anthropic')).toBe('Anthropic');
    expect(inferenceProviderVendorName('openai')).toBe('OpenAI');
    expect(inferenceProviderVendorName('xai')).toBe('xAI');
    expect(inferenceProviderVendorName('openrouter')).toBe('OpenRouter');
    expect(inferenceProviderVendorName('openai-compatible')).toBeUndefined();
    expect(inferenceProviderVendorName('unknown')).toBeUndefined();
  });
});
