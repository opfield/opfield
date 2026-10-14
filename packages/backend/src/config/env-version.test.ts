import { describe, expect, it } from 'vitest';
import { applyVersionFallback } from './env.js';

describe('APP_VERSION fallback', () => {
  it('takes the installed version when APP_VERSION came out empty', () => {
    expect(applyVersionFallback({ APP_VERSION: '', OPFIELD_VERSION: 'v2.12.2' }).APP_VERSION).toBe('v2.12.2');
    expect(applyVersionFallback({ GATEWAY_VERSION: 'v2.12.0' }).APP_VERSION).toBe('v2.12.0');
  });

  it('keeps a set APP_VERSION and leaves it unset without an installed version', () => {
    expect(applyVersionFallback({ APP_VERSION: 'v2.12.2', OPFIELD_VERSION: 'v2.12.1' }).APP_VERSION).toBe('v2.12.2');
    expect(applyVersionFallback({ APP_VERSION: '' }).APP_VERSION).toBe('');
  });
});
