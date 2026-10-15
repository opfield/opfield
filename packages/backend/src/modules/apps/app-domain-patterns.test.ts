import { describe, expect, it } from 'vitest';
import {
  domainMatchesPattern,
  effectiveDomainPatterns,
  invalidDomainPatterns,
  isDomainAllowed,
} from './app-domain-patterns.js';
import { DomainPatternsSchema } from './apps.schemas.js';

describe('app domain allowlist patterns', () => {
  it('matches an exact name, and a wildcard at any depth but not its own apex', () => {
    expect(domainMatchesPattern('API.example.com.', 'api.example.com')).toBe(true);
    expect(domainMatchesPattern('www.example.com', 'api.example.com')).toBe(false);
    expect(domainMatchesPattern('a.example.com', '*.example.com')).toBe(true);
    expect(domainMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
    expect(domainMatchesPattern('*.b.example.com', '*.example.com')).toBe(true);
    expect(domainMatchesPattern('example.com', '*.example.com')).toBe(false);
    expect(domainMatchesPattern('badexample.com', '*.example.com')).toBe(false);
  });

  it('allows every name with no patterns and joins the app and environment lists', () => {
    expect(isDomainAllowed('anything.test', [])).toBe(true);
    const joined = effectiveDomainPatterns(['*.example.com'], ['other.test', '*.example.com']);
    expect(joined).toEqual(['*.example.com', 'other.test']);
    expect(isDomainAllowed('other.test', joined)).toBe(true);
    expect(isDomainAllowed('third.test', joined)).toBe(false);
  });

  it('normalizes patterns on save and refuses what is not a name or *.domain', () => {
    expect(DomainPatternsSchema.parse([' API.Example.com. ', '*.example.com', 'api.example.com', ''])).toEqual([
      'api.example.com',
      '*.example.com',
    ]);
    expect(invalidDomainPatterns(['*.com', 'a.*.example.com', 'no spaces.test', 'ok.test', '*'])).toEqual([
      '*.com',
      'a.*.example.com',
      'no spaces.test',
      '*',
    ]);
    expect(DomainPatternsSchema.safeParse(['*.com']).success).toBe(false);
  });
});
