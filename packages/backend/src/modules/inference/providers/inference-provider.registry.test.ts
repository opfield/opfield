import { describe, expect, it } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { InferenceProviderRegistry } from './inference-provider.registry.js';

describe('an inference provider the registry does not know', () => {
  const registry = new InferenceProviderRegistry();

  it('answers 404 when a request names it', () => {
    expect(() => registry.requireRequested('no-such-provider')).toThrowError(
      expect.objectContaining({ statusCode: 404, code: 'INFERENCE_PROVIDER_NOT_FOUND' })
    );
  });

  it('is a fault, not a 404, when a stored connection names it', () => {
    let thrown: unknown;
    try {
      registry.require('no-such-provider');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AppError);
  });

  it('returns a known provider either way', () => {
    const known = registry.list()[0]!.id;
    expect(registry.requireRequested(known).id).toBe(known);
    expect(registry.require(known).id).toBe(known);
  });
});
