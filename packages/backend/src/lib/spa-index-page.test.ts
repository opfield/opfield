import { describe, expect, it } from 'vitest';
import { absolutizeShareImageUrls } from './spa-index-page.js';

const html = [
  '<meta property="og:image" content="/og-image.png?v=abc123" />',
  '<meta property="og:image:width" content="512" />',
  '<meta name="twitter:image" content="/og-image.png?v=abc123" />',
  '<link rel="icon" href="/favicon.svg?v=1" />',
].join('\n');

describe('absolutizeShareImageUrls', () => {
  it('prefixes the share image tags with the public origin and leaves other tags alone', () => {
    const result = absolutizeShareImageUrls(html, 'https://console.example.com/some/path');
    expect(result).toContain(
      '<meta property="og:image" content="https://console.example.com/og-image.png?v=abc123" />'
    );
    expect(result).toContain(
      '<meta name="twitter:image" content="https://console.example.com/og-image.png?v=abc123" />'
    );
    expect(result).toContain('<meta property="og:image:width" content="512" />');
    expect(result).toContain('<link rel="icon" href="/favicon.svg?v=1" />');
  });

  it('keeps the html unchanged for an unusable public URL', () => {
    expect(absolutizeShareImageUrls(html, 'not a url')).toBe(html);
  });
});
