const SHARE_IMAGE_META = /(<meta\s+(?:property="og:image"|name="twitter:image")\s+content=")(\/[^"]*)(")/g;

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Link previews (Open Graph, Twitter cards) need an absolute image URL, while the built index.html only knows the
 * path. Prefixes og:image and twitter:image with the console's public origin.
 */
export function absolutizeShareImageUrls(html: string, publicUrl: string): string {
  let origin: string;
  try {
    origin = new URL(publicUrl).origin;
  } catch {
    return html;
  }
  if (origin === 'null') return html;
  return html.replace(
    SHARE_IMAGE_META,
    (_match, start: string, path: string, end: string) => `${start}${escapeHtmlAttribute(origin)}${path}${end}`
  );
}
